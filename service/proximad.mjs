#!/usr/bin/env node
/*
 * proximad — the Proxima service.
 *
 * It owns a Proxima Data Home: SQLite for structured facts, `files/` for content,
 * `backups/` for the exact bytes of anything it imported, and an instance marker.
 * Cockpits and agents are both clients of the same HTTP API, and neither of them
 * touches the database: the command layer is the only way in, which is what makes
 * the audit trail worth having.
 *
 *   node proximad.mjs [--home <dir>] [--port 4181] [--host 127.0.0.1]
 *                     [--allow-origin <origin>]...  [--quiet]
 *
 * Endpoints
 *   GET  /                      the cockpit (same origin as the API)
 *   GET  /v1/health             instance, schema version, head sequence
 *   GET  /v1/snapshot           { schemaVersion, headSeq, board }
 *   POST /v1/commands           one command, the vocabulary DATA-PLANE.md lists
 *   GET  /v1/events?after=N     server-sent events, resumable with Last-Event-ID
 *   POST /v1/session            mint the cockpit's session cookie (see TRUST below)
 *   GET  /v1/preferences/:client        how a cockpit looks
 *   PUT  /v1/preferences/:client
 *   POST /v1/import/inspect     what a legacy store would bring, and what conflicts
 *   POST /v1/import             archive the bytes, then import them
 *   GET  /v1/imports            what has been imported, and from where
 *
 * TRUST. The socket binds to loopback, and that is the boundary: anything that can
 * reach it is running as this user on this machine. Two doors through it:
 *
 *   - A bearer token in <home>/token, created 0600, for agents and curl. It never
 *     goes near a browser.
 *   - A session cookie, HttpOnly, minted by POST /v1/session against a one-time
 *     nonce injected into the cockpit's HTML as it is served. The cockpit's own
 *     JavaScript never holds a token at all, so a browser compromise cannot leak
 *     one, and a page on another origin cannot mint a session without the nonce.
 *
 * Dependency-free on purpose: node:sqlite, node:http and node:crypto are all this
 * needs, so the service can be started by anyone with the runtime and nothing else.
 */

import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const COCKPIT_DIR = resolve(HERE, '..', 'public');
const SCHEMA_PATH = join(HERE, 'schema.sql');

const SCHEMA_VERSION = 1;
const EVENT_RETENTION = null; // keep everything; it is tiny, and compaction can land later

// ── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { home: process.env.PROXIMA_HOME || null, port: 4181, host: '127.0.0.1', origins: [], quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') args.home = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--allow-origin') args.origins.push(argv[++i]);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('Unknown argument: ' + a);
  }
  if (!args.home) {
    // Deliberately NOT inside the source tree, not inside Papers, and not inside a
    // browser profile: the whole point of this slice is that the data outlives all
    // three. Override with --home or PROXIMA_HOME.
    args.home = resolve(process.env.USERPROFILE || process.env.HOME || '.', 'Proxima Data Home');
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*/, ''));
  process.exit(0);
}

const log = (...parts) => { if (!args.quiet) console.log('[proximad]', ...parts); };

// ── The data home ───────────────────────────────────────────────────────────

const HOME = resolve(args.home);
const FILES_DIR = join(HOME, 'files');
const BACKUPS_DIR = join(HOME, 'backups');
const AGENTS_DIR = join(HOME, 'agents');
const DB_PATH = join(HOME, 'proxima.db');
const TOKEN_PATH = join(HOME, 'token');
const INSTANCE_PATH = join(HOME, 'instance.json');

for (const dir of [HOME, FILES_DIR, BACKUPS_DIR, AGENTS_DIR]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const instance = (() => {
  if (existsSync(INSTANCE_PATH)) {
    try { return JSON.parse(readFileSync(INSTANCE_PATH, 'utf8')); } catch { /* rewritten below */ }
  }
  const fresh = {
    instanceId: 'inst_' + randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    dataHome: HOME,
  };
  writeFileSync(INSTANCE_PATH, JSON.stringify(fresh, null, 2));
  return fresh;
})();

/**
 * Credentials, one per actor.
 *
 *   <home>/token              the OPERATOR: human:minh, for the human at a terminal
 *   <home>/agents/<name>.token  one per agent, actor `agent:<name>`
 *
 * Separate files rather than one shared root token, because the whole safety net in
 * a frictionless system is knowing WHO did a thing: a single token makes every event
 * read `human:minh` and attribution becomes fiction. A token is read from disk (never
 * taken from a command line, where the process table would show it), written 0600
 * where the platform honours it, and hashed into the `credentials` table so a leaked
 * file can be rotated without losing the record of what it was.
 *
 * Every token an agent holds is deliberately the SAME authority as the operator's:
 * the creator chose frictionless, so there is no per-operation policy here. What
 * makes that safe is #1 attribution and #3 undo, not permissions.
 */
function tokenFileFor(actor) {
  if (actor === 'human:minh') return TOKEN_PATH;
  const name = String(actor).replace(/^agent:/, '');
  return join(AGENTS_DIR, name + '.token');
}

function readTokenFile(path) {
  try {
    const token = readFileSync(path, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function writeTokenFile(path, token) {
  writeFileSync(path, token + '\n', { mode: 0o600 });
  try { statSync(path); } catch { /* nothing to do */ }
}

const rootToken = (() => {
  const existing = readTokenFile(TOKEN_PATH);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  writeTokenFile(TOKEN_PATH, token);
  log('created the operator token at', TOKEN_PATH, '(mode 0600)');
  return token;
})();

/** token -> { actor, label }. Rescanned when a token is not recognised, so adding
 *  an agent does not need the daemon restarted, and cached otherwise. */
let credentialCache = new Map();
function loadCredentials() {
  const map = new Map();
  map.set(rootToken, { actor: 'human:minh', label: 'operator' });
  let names = [];
  try { names = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.token')); } catch { names = []; }
  for (const file of names) {
    const token = readTokenFile(join(AGENTS_DIR, file));
    if (token) map.set(token, { actor: 'agent:' + file.replace(/\.token$/, ''), label: file.replace(/\.token$/, '') });
  }
  credentialCache = map;
  return map;
}
loadCredentials();

function actorForToken(token) {
  if (!token) return null;
  let found = credentialCache.get(token);
  if (!found) found = loadCredentials().get(token);   // a token added since we last looked
  if (!found) return null;
  // A token file that is gone is a revoked agent, even if this process still
  // remembers it. Revocation by deleting the file must not need a restart to bite,
  // which is the difference between a revoked credential and a hoped-for one.
  if (found.actor !== 'human:minh' && !existsSync(tokenFileFor(found.actor))) {
    credentialCache.delete(token);
    found = loadCredentials().get(token) || null;
  }
  return found;
}

// ── The database ────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

const meta = {
  get(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  },
};
meta.set('schemaVersion', SCHEMA_VERSION);
meta.set('instanceId', instance.instanceId);

// ── Forward migrations ──────────────────────────────────────────────────────
// The schema is CREATE TABLE IF NOT EXISTS, so a database that predates a column
// keeps working only if the column is added. Attribution arrived after slice 2 and
// this is where it is caught up; every step is idempotent.

function ensureColumn(table, column, definition) {
  const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
  if (columns.includes(column)) return false;
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  return true;
}

const ATTRIBUTION_COLUMNS = [
  ['tasks', 'created_by', 'TEXT'],
  ['tasks', 'last_actor', 'TEXT'],
  ['tasks', 'last_at', 'TEXT'],
  ['tasks', 'last_type', 'TEXT'],
  ['tasks', 'last_seq', 'INTEGER'],
  ['projects', 'created_by', 'TEXT'],
  ['projects', 'last_actor', 'TEXT'],
  ['projects', 'last_at', 'TEXT'],
  ['projects', 'last_type', 'TEXT'],
  ['projects', 'last_seq', 'INTEGER'],
];
const addedColumns = ATTRIBUTION_COLUMNS.filter(([table, column, definition]) => ensureColumn(table, column, definition));
// Also when rows predate the columns: a database that gained them before this
// backfill existed is in exactly the same position as one that has just gained them.
const needsBackfill = addedColumns.length > 0
  || Number(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE last_seq IS NULL').get().n) > 0
  || Number(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE last_seq IS NULL').get().n) > 0;
if (needsBackfill) {
  if (addedColumns.length) log('migrated: added', addedColumns.map(([t, c]) => t + '.' + c).join(', '));
  // And backfilled from the log, because the events were always there: a board that
  // gained an attribution column on Tuesday must not read as though nothing happened
  // before Tuesday.
  db.exec(`UPDATE tasks SET
             created_by = (SELECT actor FROM events e WHERE e.entity_kind = 'task' AND e.entity_id = tasks.id AND e.type = 'task.create' ORDER BY seq LIMIT 1),
             last_actor = (SELECT actor FROM events e WHERE e.entity_kind = 'task' AND e.entity_id = tasks.id ORDER BY seq DESC LIMIT 1),
             last_at    = (SELECT at    FROM events e WHERE e.entity_kind = 'task' AND e.entity_id = tasks.id ORDER BY seq DESC LIMIT 1),
             last_type  = (SELECT type  FROM events e WHERE e.entity_kind = 'task' AND e.entity_id = tasks.id ORDER BY seq DESC LIMIT 1),
             last_seq   = (SELECT seq   FROM events e WHERE e.entity_kind = 'task' AND e.entity_id = tasks.id ORDER BY seq DESC LIMIT 1)`);
  db.exec(`UPDATE projects SET
             created_by = (SELECT actor FROM events e WHERE e.entity_kind = 'project' AND e.entity_id = projects.id AND e.type = 'project.create' ORDER BY seq LIMIT 1),
             last_actor = (SELECT actor FROM events e WHERE e.entity_kind = 'project' AND e.entity_id = projects.id ORDER BY seq DESC LIMIT 1),
             last_at    = (SELECT at    FROM events e WHERE e.entity_kind = 'project' AND e.entity_id = projects.id ORDER BY seq DESC LIMIT 1),
             last_type  = (SELECT type  FROM events e WHERE e.entity_kind = 'project' AND e.entity_id = projects.id ORDER BY seq DESC LIMIT 1),
             last_seq   = (SELECT seq   FROM events e WHERE e.entity_kind = 'project' AND e.entity_id = projects.id ORDER BY seq DESC LIMIT 1)`);
  log('migrated: attribution backfilled from the event log');
}

const headSeq = () => Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get().s);
const oldestSeq = () => Number(db.prepare('SELECT COALESCE(MIN(seq), 0) AS s FROM events').get().s);

// ── Effects ─────────────────────────────────────────────────────────────────
// What an event DID, record by record.
//
// An event used to name one entity and hope: a `task.move` renumbered every sibling
// in the destination column and said nothing about them, and a `project.delete`
// orphaned a dozen tasks silently. Compensation then had to infer those effects by
// re-deriving them, and the inference was wrong in exactly the places that matter —
// an undo could drag a task back into a project the human had since moved it out of.
//
// So an event now carries the list. Each effect is one record and one of three
// things that can happen to it:
//
//   create   before null, after the whole record   — take it back by deleting it
//   delete   before the whole record, after null   — take it back by restoring it
//   update   before/after are the CHANGED FIELDS   — take it back by putting them back
//
// Conflict checking, compensation and attribution all read this list instead of
// guessing from the event type, which is what makes "an agent moved a task" and "an
// agent deleted a project" answerable in the same code.

function makeEffect(kind, id, op, before, after) {
  return { kind, id, op, before: before === undefined ? null : before, after: after === undefined ? null : after };
}

/** The fields an effect is about, or null when the whole record is at stake. */
function effectFields(effect) {
  if (!effect || effect.op !== 'update') return null;
  const keys = new Set([...Object.keys(effect.before || {}), ...Object.keys(effect.after || {})]);
  keys.delete('beforeTaskId');
  return [...keys];
}

/**
 * Rebuild an effect list for an event that predates the column, from what the event
 * already recorded. Not a guess about history — the same reading the undo used before
 * effects existed, written down once so the two cannot drift.
 */
function effectsFromLegacy(row) {
  const parse = (v) => { try { return v === null || v === undefined ? null : JSON.parse(v); } catch { return null; } };
  const before = parse(row.before_json);
  const after = parse(row.after_json);
  if (row.entity_kind === 'board' && row.type === 'task.layout') {
    const ids = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
    return ids.map((taskId) => makeEffect('task', taskId, 'update',
      { ganttRow: (before || {})[taskId] ?? null }, { ganttRow: (after || {})[taskId] ?? null }));
  }
  if (row.entity_kind === 'board') return [];
  const op = row.type.endsWith('.create') ? 'create' : row.type.endsWith('.delete') ? 'delete' : 'update';
  const effects = [makeEffect(row.entity_kind, row.entity_id, op, before, after)];
  if (op === 'delete' && row.entity_kind === 'project') {
    const extra = parse(row.extra_json) || {};
    (extra.orphanedTaskIds || []).forEach((id) => {
      effects.push(makeEffect('task', id, 'update', { project: row.entity_id }, { project: null }));
    });
  }
  return effects;
}

const addedEffectsColumn = ensureColumn('events', 'effects_json', 'TEXT');
if (addedEffectsColumn || Number(db.prepare('SELECT COUNT(*) AS n FROM events WHERE effects_json IS NULL').get().n) > 0) {
  const rows = db.prepare('SELECT * FROM events WHERE effects_json IS NULL ORDER BY seq').all();
  const write = db.prepare('UPDATE events SET effects_json = ? WHERE seq = ?');
  rows.forEach((row) => write.run(JSON.stringify(effectsFromLegacy(row)), row.seq));
  log('migrated: effects written for', rows.length, 'event(s) that predated the column');
}

function recordActor(actor) {
  const kind = String(actor).includes(':') ? String(actor).split(':')[0] : 'unknown';
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO actors (id, kind, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
    .run(actor, kind, String(actor).split(':').slice(1).join(':'), now, now);
}

function recordCredential(id, actor, kind, token, note) {
  db.prepare(`INSERT INTO credentials (id, actor, kind, secret_hash, created_at, note) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET secret_hash = excluded.secret_hash, actor = excluded.actor, note = excluded.note`)
    .run(id, actor, kind, createHash('sha256').update(token).digest('hex'), new Date().toISOString(), note);
}

recordCredential('cred_operator', 'human:minh', 'bearer', rootToken,
  'The token in <home>/token. Never handed to a browser.');
// Slice 2 called the operator's credential `cred_root` and filed it under the actor
// `service:root`. One actor, one row: the stale one goes.
db.prepare("DELETE FROM credentials WHERE id = 'cred_root'").run();
// And every agent token on disk, so the table is the record of what exists even if a
// file is deleted by hand.
for (const [token, who] of credentialCache) {
  if (who.actor === 'human:minh') continue;
  recordCredential('cred_' + who.label, who.actor, 'bearer', token,
    'The token in <home>/agents/' + who.label + '.token, created by POST /v1/agents.');
}

// ── Shapes ──────────────────────────────────────────────────────────────────
// Rows in, records out: the cockpit's shapes, with unknown fields restored from
// extra_json. `null` project_id becomes the empty string the cockpit uses for
// "uncategorised", and a missing deadline becomes ''.

const extraOf = (json) => {
  try {
    const parsed = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
};
const jsonOf = (value) => JSON.stringify(value === undefined ? null : value);

function rowToTask(row) {
  return {
    ...extraOf(row.extra_json),
    id: row.id,
    name: row.name,
    note: row.note,
    project: row.project_id === null ? '' : row.project_id,
    status: row.status,
    weight: row.weight,
    start: row.start_day,
    deadline: row.deadline_day === null ? '' : row.deadline_day,
    ganttRow: row.gantt_row === null ? null : row.gantt_row,
    order: row.order_index,
    createdAt: row.created_at,
    rev: row.rev,
  };
}

function rowToProject(row) {
  return {
    ...extraOf(row.extra_json),
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    rev: row.rev,
  };
}

function rowToRun(row) {
  if (!row) return null;
  const members = db.prepare('SELECT * FROM run_members WHERE run_id = ? ORDER BY position').all(row.id)
    .map((m) => ({ id: m.task_id, name: m.name, weight: m.weight, duration: m.duration, startsAt: m.starts_at, endsAt: m.ends_at }));
  return {
    ...extraOf(row.extra_json),
    lockedAt: row.locked_at,
    target: row.target,
    members: members,
    total: row.total,
    rev: row.rev,
  };
}

const readTask = (id) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? rowToTask(row) : null;
};
const readProject = (id) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? rowToProject(row) : null;
};
const readRun = () => rowToRun(db.prepare('SELECT * FROM runs WHERE id = 1').get());

// ── Restoring what an event kept ────────────────────────────────────────────
// A delete event holds the whole record, which is what makes "deletes are
// recoverable" true rather than aspirational. These put a record back exactly as it
// was — same id, same createdAt, same unknown fields — with a revision ahead of the
// one it had, so nothing is holding a stale `ifRev` that would now match by accident.

function insertTaskRecord(record, rev) {
  const known = new Set(TYPED_TASK_FIELDS);
  const extra = {};
  Object.keys(record).forEach((k) => { if (!known.has(k)) extra[k] = record[k]; });
  db.prepare(`INSERT INTO tasks (id, name, note, project_id, status, weight, start_day, deadline_day, gantt_row, order_index, created_at, rev, extra_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.id, record.name || 'Untitled task', record.note || '', record.project || null,
      STATUSES.includes(record.status) ? record.status : 'backlog', validWeight(record.weight) ? Number(record.weight) : 1,
      isRealDay(record.start) ? record.start : today(), record.deadline ? record.deadline : null,
      record.ganttRow === undefined ? null : record.ganttRow,
      Number.isFinite(Number(record.order)) ? Math.round(Number(record.order)) : 0,
      record.createdAt || new Date().toISOString(), rev, JSON.stringify(extra));
}

function insertProjectRecord(record, rev) {
  const known = new Set(TYPED_PROJECT_FIELDS);
  const extra = {};
  Object.keys(record).forEach((k) => { if (!known.has(k)) extra[k] = record[k]; });
  db.prepare('INSERT INTO projects (id, name, description, created_at, archived_at, rev, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(record.id, record.name || 'Untitled project', record.description || '',
      record.createdAt || new Date().toISOString(), record.archivedAt || null, rev, JSON.stringify(extra));
}

function insertRunRecord(record) {
  db.prepare('INSERT INTO runs (id, locked_at, target, total, rev, extra_json) VALUES (1, ?, ?, ?, 1, ?)')
    .run(record.lockedAt || new Date().toISOString(), record.target || '', Number(record.total) || 0, JSON.stringify({}));
  const insert = db.prepare('INSERT INTO run_members (run_id, task_id, position, name, weight, duration, starts_at, ends_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)');
  (record.members || []).forEach((m, i) => insert.run(m.id, i, m.name || '', Number(m.weight) || 1, Number(m.duration) || 0, Number(m.startsAt) || 0, Number(m.endsAt) || 0));
}

/**
 * Put fields back on a task the way task.patch does, but from the log, not a client.
 *
 * Status and order are here even though `task.patch` refuses them from a client: a
 * compensation is not a client asking for a move, it is the log putting exact values
 * back. That distinction matters — a "move back" would re-number the whole column,
 * and the siblings' own effects already carry the exact order each of them had. Two
 * mechanisms both claiming to restore the column is how the orders came back wrong:
 * every sibling was put back correctly and then renumbered away from the value it
 * had just been given.
 */
function applyTaskPatch(id, patch) {
  const column = {
    name: 'name', note: 'note', project: 'project_id', weight: 'weight',
    start: 'start_day', deadline: 'deadline_day', ganttRow: 'gantt_row',
    status: 'status', order: 'order_index',
  };
  const extra = {};
  const sets = [];
  const params = [];
  Object.keys(patch).forEach((field) => {
    if (!column[field]) { extra[field] = patch[field]; return; }
    sets.push(column[field] + ' = ?');
    params.push(field === 'project' ? (patch[field] || null) : field === 'deadline' ? (patch[field] || null) : patch[field]);
  });
  // Unknown fields come back too: they are part of the record, and a compensation
  // that restored the known half and dropped the rest would be a partial undo
  // wearing a complete one's clothes.
  if (Object.keys(extra).length) {
    const row = db.prepare('SELECT extra_json FROM tasks WHERE id = ?').get(id);
    if (row) {
      const merged = { ...extraOf(row.extra_json), ...extra };
      Object.keys(merged).forEach((k) => { if (merged[k] === null) delete merged[k]; });
      db.prepare('UPDATE tasks SET extra_json = ? WHERE id = ?').run(JSON.stringify(merged), id);
    }
  }
  if (!sets.length) return;
  // The revision is not bumped here: the dispatcher moves it on for every record an
  // `update` effect names, and two places doing it is how a revision ends up ahead
  // of the thing it is supposed to describe.
  db.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?').run(...params, id);
}

const TYPED_TASK_FIELDS = ['name', 'note', 'project', 'status', 'weight', 'start', 'deadline', 'ganttRow', 'order', 'createdAt', 'rev'];
const TYPED_PROJECT_FIELDS = ['name', 'description', 'createdAt', 'archivedAt', 'rev'];
const STATUSES = ['backlog', 'running', 'finished'];
const DAY_MS = 86400000;

// ── Validation ──────────────────────────────────────────────────────────────
// The refusing half. Read-time rescue is a different job and lives in the import
// path, where old bytes are made usable instead of being turned away.

function isRealDay(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}
const validWeight = (v) => Number.isFinite(Number(v)) && Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100;
const validRow = (v) => v === null || (Number.isFinite(Number(v)) && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10000);
const today = () => new Date().toISOString().slice(0, 10);

const MESSAGES = {
  COMMAND_UNKNOWN: (d) => 'This service has no command called “' + d.type + '”.',
  COMMAND_NOT_IMPLEMENTED: (d) => '“' + d.type + '” is part of the destination but is not served yet.',
  PAYLOAD_INVALID: (d) => 'That ' + d.type + ' command is missing ' + (d.missing || []).join(', ') + '.',
  COMMAND_ID_CONFLICT: () => 'That command id was already used for a different command.',
  ENTITY_NOT_FOUND: (d) => 'There is no ' + d.kind + ' with the id “' + d.id + '”.',
  ENTITY_REV_CONFLICT: (d) => 'Somebody else changed this ' + d.kind + ' first (you expected revision ' + d.expected + ', it is at ' + d.actual + '). Nothing was written.',
  NAME_REQUIRED: () => 'A name is required.',
  DATE_INVALID: (d) => '“' + d.value + '” is not a real date, so ' + d.field + ' was not written.',
  DEADLINE_BEFORE_START: (d) => 'The deadline (' + d.deadline + ') is before the start (' + d.start + '). Nothing was written.',
  WEIGHT_INVALID: (d) => 'A weight has to be a whole number from 1 to 100; “' + d.value + '” is not.',
  STATUS_UNKNOWN: (d) => '“' + d.value + '” is not a column this board has (' + (d.allowed || []).join(', ') + ').',
  PROJECT_NOT_FOUND: (d) => 'There is no project with the id “' + d.projectId + '”.',
  GANTT_ROW_INVALID: (d) => '“' + d.value + '” is not a timeline row.',
  FIELD_NOT_PATCHABLE: (d) => 'task.patch cannot change ' + d.field + ' — use ' + d.use + '.',
  MOVE_ANCHOR_NOT_IN_COLUMN: (d) => 'The task to insert before is not in that column any more.',
  RUN_HAS_NO_MEMBERS: () => 'Nothing to lock — no tasks are in the running column.',
  RUN_TARGET_INVALID: (d) => '“' + d.target + '” is not an instant in the future, so there is no horizon to lock.',
  RUN_ALREADY_LOCKED: () => 'A run is already locked. Unlock it before locking another.',
  WRITE_FAILED: (d) => 'The service could not write that (' + d.reason + '). Nothing was changed.',
  ACTOR_MISMATCH: (d) => 'That command claims to be ' + d.claimed + ', and this credential is ' + d.actual + '. Nothing was changed.',
  FORBIDDEN: (d) => 'That is the operator’s to do: ' + (d.why || 'this credential may not') + '. Nothing was changed.',
  REV_REQUIRED: (d) => 'An agent has to say which revision it read before changing ' + d.kind + ' “' + d.id + '” (send ifRev). Read it again, then act on what you read.',
  RUN_MEMBER_LOCKED: (d) => '“' + (d.name || d.id) + '” is part of the locked plan, so its ' + d.field + ' is frozen until the run is unlocked.',
  RUN_LOCKED: () => 'A run is locked, so its members cannot leave the running column and nothing else can join it. Unlock it first.',
};

function refuse(code, details) {
  const shape = details || {};
  const build = MESSAGES[code];
  return { ok: false, code, details: shape, message: build ? build(shape) : 'That command was refused (' + code + ').' };
}

/** A stable fingerprint, so a reused command id with different content is caught. */
function fingerprint(type, payload) {
  const stable = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  };
  return type + ' ' + stable(payload || {});
}

const newId = (prefix) => prefix + '_' + Date.now().toString(36) + randomBytes(3).toString('hex');

/** Commands that change a record that already exists: an agent must name the revision it read. */
const REVISION_BOUND = new Set([
  'task.patch', 'task.move', 'task.delete',
  'project.archive', 'project.restore', 'project.delete',
]);

// ── Commands ────────────────────────────────────────────────────────────────
// Each handler validates and returns a closure that applies the change. Nothing is
// written until the whole command is known to be acceptable, so a refusal can never
// leave half a change behind — and the apply closure, the command row and the event
// all run inside one transaction.

function checkRev(ctx, kind, id, currentRev) {
  if (ctx.ifRev === undefined || ctx.ifRev === null) return null;
  if (currentRev === null || currentRev === undefined) return refuse('ENTITY_NOT_FOUND', { kind, id });
  if (Number(ctx.ifRev) !== Number(currentRev)) {
    return refuse('ENTITY_REV_CONFLICT', { kind, id, expected: Number(ctx.ifRev), actual: Number(currentRev) });
  }
  return null;
}

/** Move one record's revision on. The dispatcher's job, for every effect it is told about. */
function bumpRev(kind, id) {
  if (kind === 'task') db.prepare('UPDATE tasks SET rev = rev + 1 WHERE id = ?').run(id);
  else if (kind === 'project') db.prepare('UPDATE projects SET rev = rev + 1 WHERE id = ?').run(id);
  else if (kind === 'run') db.prepare('UPDATE runs SET rev = rev + 1 WHERE id = 1').run();
}

const isHumanActor = (actor) => String(actor || '').startsWith('human:');

// ── The locked plan ─────────────────────────────────────────────────────────
// The cockpit has always enforced these by disabling controls. That made the rules
// gestures rather than rules: an agent with a token could change a member's weight,
// walk a member out of the running column, or fill the column with newcomers while
// the horizon was frozen. They live here now, so both clients answer to the same
// service instead of the UI being a policy and the API being a hole in it.

const runMember = (taskId) => {
  const run = readRun();
  if (!run) return null;
  return run.members.find((m) => m.id === taskId) || null;
};

/** Refuse a change that would rewrite a frozen plan. Returns null when it is fine. */
function checkRunInvariants(kind, id, detail) {
  const run = readRun();
  if (!run) return null;
  const member = run.members.find((m) => m.id === id) || null;
  if (kind === 'weight' && member) {
    return refuse('RUN_MEMBER_LOCKED', { id, name: member.name, field: 'weight' });
  }
  if (kind === 'move') {
    const toStatus = detail && detail.toStatus;
    if (member && toStatus !== 'running') {
      return refuse('RUN_MEMBER_LOCKED', { id, name: member.name, field: 'column' });
    }
    if (!member && toStatus === 'running') {
      return refuse('RUN_LOCKED', { id });
    }
  }
  if (kind === 'delete' && member && run.members.length === 1) {
    // Allowed: deleting the last member ends the run, and the command says so in its
    // effects. Refusing would trap a task the reader has decided is not happening.
    return null;
  }
  return null;
}

const COMMANDS = {
  'task.create'(payload, ctx) {
    if (typeof payload.name !== 'string' || !payload.name.trim()) return refuse('PAYLOAD_INVALID', { type: 'task.create', missing: ['name'] });
    if (payload.project && !readProject(payload.project)) return refuse('PROJECT_NOT_FOUND', { projectId: payload.project });
    if (payload.status !== undefined && !STATUSES.includes(payload.status)) return refuse('STATUS_UNKNOWN', { value: payload.status, allowed: STATUSES });
    if (payload.weight !== undefined && !validWeight(payload.weight)) return refuse('WEIGHT_INVALID', { value: payload.weight });
    if (payload.start !== undefined && payload.start !== '' && !isRealDay(payload.start)) return refuse('DATE_INVALID', { field: 'start', value: payload.start });
    if (payload.deadline !== undefined && payload.deadline !== '' && !isRealDay(payload.deadline)) return refuse('DATE_INVALID', { field: 'deadline', value: payload.deadline });
    if (payload.ganttRow !== undefined && payload.ganttRow !== null && !validRow(payload.ganttRow)) return refuse('GANTT_ROW_INVALID', { value: payload.ganttRow });

    const start = payload.start === undefined || payload.start === '' ? today() : payload.start;
    const deadline = payload.deadline === undefined || payload.deadline === '' ? null : payload.deadline;
    if (deadline && deadline < start) return refuse('DEADLINE_BEFORE_START', { start, deadline });

    const known = new Set(['name', 'note', 'project', 'status', 'weight', 'start', 'deadline', 'ganttRow']);
    const extra = {};
    Object.keys(payload).forEach((k) => { if (!known.has(k)) extra[k] = payload[k]; });

    const task = {
      id: newId('tsk'),
      name: String(payload.name).trim().slice(0, 200),
      note: typeof payload.note === 'string' ? payload.note.slice(0, 500) : '',
      project: payload.project || null,
      status: payload.status || 'backlog',
      weight: payload.weight === undefined ? 1 : Number(payload.weight),
      start,
      deadline,
      ganttRow: payload.ganttRow === undefined ? null : payload.ganttRow,
      order: Number(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n),
      createdAt: new Date().toISOString(),
      rev: 1,
      extra,
    };
    return {
      ok: true,
      entity: { kind: 'task', id: task.id },
      created: true,
      value: () => readTask(task.id),
      apply() {
        db.prepare(`INSERT INTO tasks (id, name, note, project_id, status, weight, start_day, deadline_day, gantt_row, order_index, created_at, rev, extra_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(task.id, task.name, task.note, task.project, task.status, task.weight, task.start, task.deadline,
            task.ganttRow, task.order, task.createdAt, task.rev, JSON.stringify(task.extra));
        return {
          value: readTask(task.id), before: null, after: readTask(task.id),
          effects: [makeEffect('task', task.id, 'create', null, readTask(task.id))],
        };
      },
    };
  },

  'task.patch'(payload, ctx) {
    const before = readTask(payload.taskId);
    if (!before) return refuse('ENTITY_NOT_FOUND', { kind: 'task', id: payload.taskId });
    const conflict = checkRev(ctx, 'task', payload.taskId, before.rev);
    if (conflict) return conflict;
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : null;
    if (!patch || Object.keys(patch).length === 0) return refuse('PAYLOAD_INVALID', { type: 'task.patch', missing: ['patch'] });
    if ('status' in patch) return refuse('FIELD_NOT_PATCHABLE', { field: 'status', use: 'task.move' });
    if ('createdAt' in patch) return refuse('FIELD_NOT_PATCHABLE', { field: 'createdAt', use: 'nothing — provenance is immutable' });
    if ('id' in patch) return refuse('FIELD_NOT_PATCHABLE', { field: 'id', use: 'nothing — ids are stable' });
    if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) return refuse('NAME_REQUIRED', {});
    if ('project' in patch && patch.project && !readProject(patch.project)) return refuse('PROJECT_NOT_FOUND', { projectId: patch.project });
    if ('weight' in patch && !validWeight(patch.weight)) return refuse('WEIGHT_INVALID', { value: patch.weight });
    if ('start' in patch && patch.start !== '' && !isRealDay(patch.start)) return refuse('DATE_INVALID', { field: 'start', value: patch.start });
    if ('deadline' in patch && patch.deadline !== '' && !isRealDay(patch.deadline)) return refuse('DATE_INVALID', { field: 'deadline', value: patch.deadline });
    if ('ganttRow' in patch && !validRow(patch.ganttRow)) return refuse('GANTT_ROW_INVALID', { value: patch.ganttRow });
    if ('note' in patch && typeof patch.note !== 'string') return refuse('PAYLOAD_INVALID', { type: 'task.patch', missing: ['note as text'] });

    const next = {};
    if ('name' in patch) next.name = String(patch.name).trim().slice(0, 200);
    if ('note' in patch) next.note = patch.note.slice(0, 500);
    if ('project' in patch) next.project = patch.project || null;
    if ('weight' in patch) next.weight = Number(patch.weight);
    if ('start' in patch) next.start = patch.start === '' ? (before.start || today()) : patch.start;
    if ('deadline' in patch) next.deadline = patch.deadline === '' ? null : patch.deadline;
    if ('ganttRow' in patch) next.ganttRow = patch.ganttRow;

    const startAfter = 'start' in next ? next.start : before.start;
    const deadlineAfter = 'deadline' in next ? next.deadline : (before.deadline || null);
    if (startAfter && deadlineAfter && deadlineAfter < startAfter) {
      return refuse('DEADLINE_BEFORE_START', { start: startAfter, deadline: deadlineAfter });
    }

    // Compared in the shapes the table uses ('no deadline' is NULL in SQLite and
    // '' in the cockpit), so asking for what is already there is not a change.
    const asStored = (record) => ({ ...record, deadline: record.deadline || null, project: record.project || null });
    const stored = asStored(before);
    const changed = Object.keys(next).filter((k) => stored[k] !== next[k]);
    const unknown = Object.keys(patch).filter((k) => !TYPED_TASK_FIELDS.includes(k));
    if (changed.length === 0 && unknown.length === 0) {
      return { ok: true, entity: { kind: 'task', id: before.id }, value: () => before, apply: () => ({ value: before, before: null, after: null, changed: false }) };
    }
    if (changed.includes('weight')) {
      const locked = checkRunInvariants('weight', before.id);
      if (locked) return locked;
    }
    const beforeDiff = {};
    const afterDiff = {};
    changed.forEach((k) => { beforeDiff[k] = stored[k]; afterDiff[k] = next[k]; });
    // Unknown fields are a real edit and are recorded as one: they used to land in
    // extra_json while the event's diff stayed empty, so an agent's change to a field
    // this service does not know about audited as nothing at all and could not be
    // put back. The record is restored wholesale on undo, so the value is enough.
    unknown.forEach((k) => { beforeDiff[k] = stored[k] === undefined ? null : stored[k]; afterDiff[k] = patch[k]; });
    return {
      ok: true,
      entity: { kind: 'task', id: before.id },
      value: () => readTask(before.id),
      apply() {
        if (changed.length) {
          const sets = [];
          const params = [];
          const column = { name: 'name', note: 'note', project: 'project_id', weight: 'weight', start: 'start_day', deadline: 'deadline_day', ganttRow: 'gantt_row' };
          changed.forEach((k) => { sets.push(column[k] + ' = ?'); params.push(next[k]); });
          db.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?').run(...params, before.id);
        }
        if (unknown.length) {
          // Unknown fields are kept, not dropped: the store has always preserved
          // what it was given, and SQLite must not be the thing that loses them.
          const extra = extraOf(db.prepare('SELECT extra_json FROM tasks WHERE id = ?').get(before.id).extra_json);
          unknown.forEach((k) => { extra[k] = patch[k]; });
          db.prepare('UPDATE tasks SET extra_json = ? WHERE id = ?').run(JSON.stringify(extra), before.id);
        }
        return {
          value: readTask(before.id), before: beforeDiff, after: afterDiff,
          effects: [makeEffect('task', before.id, 'update', beforeDiff, afterDiff)],
        };
      },
    };
  },

  'task.move'(payload, ctx) {
    const task = readTask(payload.taskId);
    if (!task) return refuse('ENTITY_NOT_FOUND', { kind: 'task', id: payload.taskId });
    const conflict = checkRev(ctx, 'task', payload.taskId, task.rev);
    if (conflict) return conflict;
    if (!STATUSES.includes(payload.toStatus)) return refuse('STATUS_UNKNOWN', { value: payload.toStatus, allowed: STATUSES });
    const locked = checkRunInvariants('move', task.id, { toStatus: payload.toStatus });
    if (locked) return locked;
    const anchorId = payload.beforeTaskId || null;
    if (anchorId) {
      const anchor = readTask(anchorId);
      if (!anchor) return refuse('ENTITY_NOT_FOUND', { kind: 'task', id: anchorId });
      if (anchor.status !== payload.toStatus) return refuse('MOVE_ANCHOR_NOT_IN_COLUMN', { beforeTaskId: anchorId, toStatus: payload.toStatus });
    }
    const fromStatus = task.status;
    const column = db.prepare('SELECT id FROM tasks WHERE status = ? ORDER BY order_index, rowid').all(payload.toStatus).map((r) => r.id);
    if (fromStatus === payload.toStatus && !anchorId && column[column.length - 1] === task.id) {
      return { ok: true, entity: { kind: 'task', id: task.id }, value: () => task, apply: () => ({ value: task, before: null, after: null, changed: false }) };
    }
    const beforeOrder = task.order;
    // Who else is about to be renumbered. A move rewrites the order of every task
    // between the old slot and the new one, and those are changes: the event names
    // them so undo can put each back and conflict checking can see that a human
    // reordered the same column afterwards.
    const destinationBefore = db.prepare('SELECT id, order_index FROM tasks WHERE status = ? AND id <> ? ORDER BY order_index, rowid')
      .all(payload.toStatus, task.id).map((r) => ({ id: r.id, order: r.order_index }));
    const sourceBefore = fromStatus === payload.toStatus ? [] : db.prepare('SELECT id, order_index FROM tasks WHERE status = ? ORDER BY order_index, rowid')
      .all(fromStatus).map((r) => ({ id: r.id, order: r.order_index }));
    return {
      ok: true,
      entity: { kind: 'task', id: task.id },
      value: () => readTask(task.id),
      apply() {
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(payload.toStatus, task.id);
        const rest = db.prepare('SELECT id FROM tasks WHERE status = ? AND id <> ? ORDER BY order_index, rowid').all(payload.toStatus, task.id).map((r) => r.id);
        const index = anchorId ? rest.indexOf(anchorId) : -1;
        if (index < 0) rest.push(task.id); else rest.splice(index, 0, task.id);
        const renumber = db.prepare('UPDATE tasks SET order_index = ? WHERE id = ?');
        rest.forEach((id, i) => renumber.run(i, id));
        const after = readTask(task.id);
        const effects = [makeEffect('task', task.id, 'update',
          { status: fromStatus, order: beforeOrder },
          { status: after.status, order: after.order, beforeTaskId: anchorId })];
        // The siblings that actually moved. Reading the new order back rather than
        // predicting it means the list is what happened, not what was intended.
        const moved = new Map();
        destinationBefore.forEach((s) => moved.set(s.id, s.order));
        sourceBefore.forEach((s) => { if (!moved.has(s.id)) moved.set(s.id, s.order); });
        moved.forEach((was, id) => {
          const now = db.prepare('SELECT order_index FROM tasks WHERE id = ?').get(id);
          if (now && now.order_index !== was) {
            effects.push(makeEffect('task', id, 'update', { order: was }, { order: now.order_index }));
          }
        });
        return { value: after, before: { status: fromStatus, order: beforeOrder }, after: { status: after.status, order: after.order, beforeTaskId: anchorId }, effects };
      },
    };
  },

  'task.layout'(payload, ctx) {
    const rows = Array.isArray(payload.rows) ? payload.rows : null;
    if (!rows) return refuse('PAYLOAD_INVALID', { type: 'task.layout', missing: ['rows'] });
    const pending = [];
    const skipped = [];
    for (const entry of rows) {
      if (!entry || typeof entry !== 'object') return refuse('PAYLOAD_INVALID', { type: 'task.layout', missing: ['rows[].taskId'] });
      if (!validRow(entry.ganttRow)) return refuse('GANTT_ROW_INVALID', { value: entry.ganttRow });
      const task = readTask(entry.taskId);
      if (!task) { skipped.push(entry.taskId); continue; }
      if (task.ganttRow !== entry.ganttRow) pending.push({ id: task.id, from: task.ganttRow, to: entry.ganttRow });
    }
    if (pending.length === 0) {
      return { ok: true, entity: { kind: 'board', id: 'timeline' }, value: () => ({ placed: 0, skipped }), apply: () => ({ value: { placed: 0, skipped }, before: null, after: null, changed: false }) };
    }
    return {
      ok: true,
      entity: { kind: 'board', id: 'timeline' },
      value: () => ({ placed: pending.length, skipped }),
      apply() {
        const before = {};
        const after = {};
        const stmt = db.prepare('UPDATE tasks SET gantt_row = ? WHERE id = ?');
        pending.forEach((p) => { stmt.run(p.to, p.id); before[p.id] = p.from; after[p.id] = p.to; });
        return {
          value: { placed: pending.length, skipped }, before, after,
          extra: skipped.length ? { skipped } : undefined,
          // One effect PER TASK: the event is named after the board because a layout
          // pass is one gesture, but what it changes is a row on each of these tasks.
          // Naming only `board:timeline` is why this command could be listed as
          // supported and still not be undoable.
          effects: pending.map((p) => makeEffect('task', p.id, 'update', { ganttRow: p.from }, { ganttRow: p.to })),
        };
      },
    };
  },

  'task.delete'(payload, ctx) {
    const task = readTask(payload.taskId);
    if (!task) return refuse('ENTITY_NOT_FOUND', { kind: 'task', id: payload.taskId });
    const conflict = checkRev(ctx, 'task', payload.taskId, task.rev);
    if (conflict) return conflict;
    // A plan whose last member is deleted is over. The cockpit ends it too, but a
    // headless agent has no cockpit, and a locked run with an empty roster is a
    // horizon nobody is working to.
    const run = readRun();
    const endsRun = Boolean(run && run.members.some((m) => m.id === task.id) && run.members.length === 1);
    return {
      ok: true,
      entity: { kind: 'task', id: task.id },
      value: () => ({ id: task.id, endedRun: endsRun }),
      apply() {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        // The run going with it is a change like any other, so the event names it —
        // and undo can put both back rather than leaving a phantom plan behind.
        const effects = [makeEffect('task', task.id, 'delete', task, null)];
        effects[0].createdBy = createdByOf('task', task.id);
        if (endsRun) {
          db.prepare('DELETE FROM runs WHERE id = 1').run();
          effects.push(makeEffect('run', run.lockedAt, 'delete', run, null));
        }
        return {
          value: { id: task.id, endedRun: endsRun },
          before: task, after: null,
          ...(endsRun ? { extra: { endedRun: true } } : {}),
          effects,
        };
      },
    };
  },

  'project.create'(payload, ctx) {
    if (typeof payload.name !== 'string' || !payload.name.trim()) return refuse('NAME_REQUIRED', {});
    const known = new Set(['name', 'description']);
    const extra = {};
    Object.keys(payload).forEach((k) => { if (!known.has(k)) extra[k] = payload[k]; });
    const project = {
      id: newId('prj'),
      name: String(payload.name).trim().slice(0, 120),
      description: typeof payload.description === 'string' ? payload.description.trim().slice(0, 500) : '',
      createdAt: new Date().toISOString(),
      extra,
    };
    return {
      ok: true,
      entity: { kind: 'project', id: project.id },
      created: true,
      value: () => readProject(project.id),
      apply() {
        db.prepare(`INSERT INTO projects (id, name, description, created_at, archived_at, rev, extra_json) VALUES (?, ?, ?, ?, NULL, 1, ?)`)
          .run(project.id, project.name, project.description, project.createdAt, JSON.stringify(project.extra));
        return {
          value: readProject(project.id), before: null, after: readProject(project.id),
          effects: [makeEffect('project', project.id, 'create', null, readProject(project.id))],
        };
      },
    };
  },

  'project.archive'(payload, ctx) {
    const project = readProject(payload.projectId);
    if (!project) return refuse('ENTITY_NOT_FOUND', { kind: 'project', id: payload.projectId });
    const conflict = checkRev(ctx, 'project', payload.projectId, project.rev);
    if (conflict) return conflict;
    if (project.archivedAt) return { ok: true, entity: { kind: 'project', id: project.id }, value: () => project, apply: () => ({ value: project, before: null, after: null, changed: false }) };
    const at = new Date().toISOString();
    return {
      ok: true,
      entity: { kind: 'project', id: project.id },
      value: () => readProject(project.id),
      apply() {
        db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(at, project.id);
        return { value: readProject(project.id), before: { archivedAt: null }, after: { archivedAt: at } };
      },
    };
  },

  'project.restore'(payload, ctx) {
    const project = readProject(payload.projectId);
    if (!project) return refuse('ENTITY_NOT_FOUND', { kind: 'project', id: payload.projectId });
    const conflict = checkRev(ctx, 'project', payload.projectId, project.rev);
    if (conflict) return conflict;
    if (!project.archivedAt) return { ok: true, entity: { kind: 'project', id: project.id }, value: () => project, apply: () => ({ value: project, before: null, after: null, changed: false }) };
    const was = project.archivedAt;
    return {
      ok: true,
      entity: { kind: 'project', id: project.id },
      value: () => readProject(project.id),
      apply() {
        db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(project.id);
        return { value: readProject(project.id), before: { archivedAt: was }, after: { archivedAt: null } };
      },
    };
  },

  'project.delete'(payload, ctx) {
    const project = readProject(payload.projectId);
    if (!project) return refuse('ENTITY_NOT_FOUND', { kind: 'project', id: payload.projectId });
    const conflict = checkRev(ctx, 'project', payload.projectId, project.rev);
    if (conflict) return conflict;
    const orphans = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(project.id).map((r) => r.id);
    return {
      ok: true,
      entity: { kind: 'project', id: project.id },
      value: () => ({ orphaned: orphans.length, orphanedTaskIds: orphans }),
      apply() {
        // The tasks are NOT deleted. Deleting a container must not quietly destroy
        // the work inside it, and the confirmation says how many are affected first.
        const orphan = db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?');
        orphan.run(project.id);
        db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
        return {
          value: { orphaned: orphans.length, orphanedTaskIds: orphans },
          before: project,
          after: null,
          extra: orphans.length ? { orphanedTaskIds: orphans } : undefined,
          // The project went, AND each of its tasks lost its project. Undo has to put
          // both back — and has to refuse if the human has since filed one of those
          // tasks somewhere else on purpose.
          effects: [
            Object.assign(makeEffect('project', project.id, 'delete', project, null), { createdBy: createdByOf('project', project.id) }),
            ...orphans.map((id) => makeEffect('task', id, 'update', { project: project.id }, { project: null })),
          ],
        };
      },
    };
  },

  'run.lock'(payload, ctx) {
    if (readRun()) return refuse('RUN_ALREADY_LOCKED', { lockedAt: db.prepare('SELECT locked_at FROM runs WHERE id = 1').get().locked_at });
    const targetMs = typeof payload.target === 'string' ? new Date(payload.target).getTime() : NaN;
    if (!Number.isFinite(targetMs) || targetMs <= Date.now()) return refuse('RUN_TARGET_INVALID', { target: payload.target });
    const ids = Array.isArray(payload.taskIds) ? payload.taskIds.filter((v) => typeof v === 'string' && v) : [];
    const members = [];
    ids.forEach((id) => { const task = readTask(id); if (task && task.status === 'running') members.push(task); });
    if (members.length === 0) return refuse('RUN_HAS_NO_MEMBERS', {});

    const lockedAt = Date.now();
    const totalMs = targetMs - lockedAt;
    const totalWeight = members.reduce((sum, t) => sum + t.weight, 0) || 1;
    let cursor = lockedAt;
    let total = 0;
    const frozen = members.map((task) => {
      const duration = (task.weight / totalWeight) * totalMs;
      const startsAt = cursor;
      const endsAt = cursor + duration;
      cursor = endsAt;
      total += duration;
      return { id: task.id, name: task.name, weight: task.weight, duration, startsAt, endsAt };
    });
    const lockedIso = new Date(lockedAt).toISOString();
    return {
      ok: true,
      entity: { kind: 'run', id: lockedIso },
      created: true,
      value: () => readRun(),
      apply() {
        db.prepare('INSERT INTO runs (id, locked_at, target, total, rev, extra_json) VALUES (1, ?, ?, ?, 1, ?)')
          .run(lockedIso, payload.target, total, '{}');
        const insert = db.prepare('INSERT INTO run_members (run_id, task_id, position, name, weight, duration, starts_at, ends_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)');
        frozen.forEach((m, i) => insert.run(m.id, i, m.name, m.weight, m.duration, m.startsAt, m.endsAt));
        return {
          value: readRun(),
          before: null,
          // The event carries the whole plan, so a client can apply it without a
          // round trip and the log says exactly what was frozen.
          after: { lockedAt: lockedIso, target: payload.target, memberIds: frozen.map((m) => m.id), total, members: frozen },
          effects: [makeEffect('run', lockedIso, 'create', null, readRun())],
        };
      },
    };
  },

  'run.unlock'(payload, ctx) {
    const run = readRun();
    if (!run) return { ok: true, entity: { kind: 'run', id: 'none' }, value: () => null, apply: () => ({ value: null, before: null, after: null, changed: false }) };
    return {
      ok: true,
      entity: { kind: 'run', id: run.lockedAt },
      value: () => ({ ended: run }),
      apply() {
        db.prepare('DELETE FROM runs WHERE id = 1').run();
        return {
          value: { ended: run }, before: run, after: null,
          effects: [makeEffect('run', run.lockedAt, 'delete', run, null)],
        };
      },
    };
  },

  'proposal.accept'(payload, ctx) { return refuse('COMMAND_NOT_IMPLEMENTED', { type: 'proposal.accept', slice: 'the creator chose frictionless: there is no approval queue to accept into' }); },

  /**
   * Undo what an actor did in a window of time.
   *
   * This is the safety net, not a nicety. An agent writes directly and without asking,
   * so the only things standing between a bad minute and a bad board are attribution
   * (who did it) and this (take it back). It works from the EVENT LOG rather than from
   * diffs computed now, because the log is the only place that remembers what the
   * values were before.
   *
   * It refuses rather than stamps: if a field the agent changed has since been changed
   * by somebody else, that entity is reported as a conflict and left alone. Reverting
   * over a human's edit would destroy work the human can see, which is worse than not
   * reverting at all. Deletes ARE recoverable — the delete event keeps the whole
   * record, so the entity comes back with its id, its createdAt and its unknown fields.
   */
  'history.revert'(payload, ctx) {
    const actor = typeof payload.actor === 'string' && payload.actor ? payload.actor : null;
    if (!actor) return refuse('PAYLOAD_INVALID', { type: 'history.revert', missing: ['actor'] });
    // CONTROL PLANE. Rewriting history on somebody else's behalf is not the same act
    // as writing a task, and it is the one place where an agent could destroy work it
    // never made. An agent may at most take back its own.
    if (actor !== ctx.actor && !isHumanActor(ctx.actor)) {
      return refuse('FORBIDDEN', {
        command: 'history.revert', actor: ctx.actor, target: actor,
        why: 'an agent may only revert its own changes; reverting somebody else’s is the operator’s',
      });
    }
    const until = payload.until ? new Date(payload.until) : new Date();
    const since = payload.since ? new Date(payload.since) : new Date(until.getTime() - 3600 * 1000);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return refuse('DATE_INVALID', { field: 'since/until', value: String(payload.since || payload.until) });
    }
    const dryRun = payload.dryRun === true;
    /**
     * The frozen bound. A dry run answers with the sequence it planned against, and
     * the execution is given it back — so the undo that runs is the undo that was
     * described. Without it, "the last hour" is re-read at execution time and every
     * change in between silently joins a set the reader never saw.
     */
    const throughSeq = payload.throughSeq === undefined || payload.throughSeq === null || payload.throughSeq === ''
      ? null : Number(payload.throughSeq);
    if (throughSeq !== null && !Number.isFinite(throughSeq)) {
      return refuse('PAYLOAD_INVALID', { type: 'history.revert', missing: ['throughSeq as a number'] });
    }

    const clauses = ["actor = ?", 'at >= ?', 'at <= ?', "type NOT IN ('history.revert', 'migration.entity', 'migration.complete')"];
    const params = [actor, since.toISOString(), until.toISOString()];
    if (throughSeq !== null) { clauses.push('seq <= ?'); params.push(throughSeq); }
    const events = db.prepare('SELECT * FROM events WHERE ' + clauses.join(' AND ') + ' ORDER BY seq DESC')
      .all(...params).map(rowToEvent);

    const plan = [];
    const conflicts = [];
    const conflicted = new Set();
    const skipped = [];

    /**
     * What everybody ELSE did, after each of these changes.
     *
     * The conflict test is about order, not about values: a change can be taken back
     * only while nothing else has happened to that field afterwards. It is read from
     * the other events' EFFECTS, not from their headline entity — which is the whole
     * point of effects. An event that renumbered a sibling by moving some other task
     * used to be invisible here; now it is a row in this index.
     *
     * Note the bound: every foreign event after the oldest one being reverted, with no
     * time limit. A human edit five minutes after the window is exactly what must
     * still refuse the undo, so this deliberately reaches past `until`.
     */
    const foreignByRecord = new Map();
    const oldestRelevant = events.length ? Math.min(...events.map((e) => e.seq)) : headSeq() + 1;
    db.prepare('SELECT * FROM events WHERE seq > ? AND actor <> ? ORDER BY seq')
      .all(oldestRelevant, actor)
      .forEach((row) => {
        const other = rowToEvent(row);
        (other.effects || []).forEach((effect) => {
          if (!effect || !effect.kind || !effect.id) return;
          const key = effect.kind + ':' + effect.id;
          if (!foreignByRecord.has(key)) foreignByRecord.set(key, []);
          foreignByRecord.get(key).push({ seq: other.seq, actor: other.actor, type: other.type, fields: effectFields(effect) });
        });
      });

    const foreignAfter = (kind, id, seq, fields) => {
      const list = foreignByRecord.get(kind + ':' + id);
      if (!list) return null;
      for (const entry of list) {
        if (entry.seq <= seq) continue;
        // `fields === null` means the whole record is at stake (it is about to be
        // deleted or was restored); then any touch at all refuses.
        if (!fields) return { ...entry, overlap: null };
        if (!entry.fields) return { ...entry, overlap: null };
        const overlap = entry.fields.filter((k) => fields.includes(k));
        if (overlap.length) return { ...entry, overlap };
      }
      return null;
    };

    /** Report a refusal once per record, however many of its changes hit it. */
    const conflict = (event, key, why, fields) => {
      if (conflicted.has(key)) {
        skipped.push({ seq: event.seq, entity: key, why: 'an earlier change to this record is already refused' });
        return;
      }
      conflicted.add(key);
      const current = key.startsWith('task:') ? readTask(key.slice(5)) : key.startsWith('project:') ? readProject(key.slice(5)) : null;
      conflicts.push({ seq: event.seq, entity: key, name: current ? current.name : null, fields, why });
    };

    /**
     * What each record will hold once the plan so far is applied.
     *
     * Compensations run newest-first, so an older change to a field is checked against
     * the value the newer compensation is ABOUT to put back — not against the rows as
     * they stand now. Two agent edits to the same field in a row are the normal case,
     * not an edge case. And the lifecycle branches read it too: an agent that created
     * a task and then deleted it must plan restore-then-delete, or the undo leaves
     * behind a task that existed neither before nor after.
     */
    const liveRecord = (kind, id) => {
      if (kind === 'task') return readTask(id);
      if (kind === 'project') return readProject(id);
      // A run is identified by WHEN it was locked, not by a row id: there is only
      // ever one, so "the run I locked" and "whatever run exists now" are different
      // questions and only the first one is the one an undo may act on.
      if (kind === 'run') { const run = readRun(); return run && run.lockedAt === id ? run : null; }
      return null;
    };
    const planned = new Map();                    // 'kind:id' -> record | null (gone)
    const stateOf = (kind, id) => (planned.has(kind + ':' + id) ? planned.get(kind + ':' + id) : liveRecord(kind, id));
    const planState = (kind, id, values) => {
      if (values === null) { planned.set(kind + ':' + id, null); return; }
      const known = planned.has(kind + ':' + id) ? planned.get(kind + ':' + id) : liveRecord(kind, id);
      planned.set(kind + ':' + id, { ...(known || {}), ...values });
    };

    /** Put one compensating effect on the plan, and move the shadow state with it. */
    const schedule = (event, effect, undo) => {
      plan.push({ seq: event.seq, type: event.type, effect, undo });
      if (effect.op === 'delete') planState(effect.kind, effect.id, null);
      else if (effect.op === 'create') planState(effect.kind, effect.id, effect.after);
      else planState(effect.kind, effect.id, effect.after);
    };

    const deleteRecord = (kind, id) => {
      if (kind === 'task') db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      else if (kind === 'project') { db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(id); db.prepare('DELETE FROM projects WHERE id = ?').run(id); }
      else if (kind === 'run') db.prepare('DELETE FROM runs WHERE id = 1').run();
    };
    const restoreRecord = (kind, effect) => {
      const record = effect.before;
      if (kind === 'task') insertTaskRecord(record, (Number(record.rev) || 1) + 1);
      else if (kind === 'project') insertProjectRecord(record, (Number(record.rev) || 1) + 1);
      else if (kind === 'run') insertRunRecord(record);
    };
    const putFieldsBack = (kind, id, fields) => {
      if (kind === 'task') { applyTaskPatch(id, fields); return; }
      if (kind === 'project') {
        const sets = [];
        const args = [];
        if ('archivedAt' in fields) { sets.push('archived_at = ?'); args.push(fields.archivedAt || null); }
        if ('name' in fields) { sets.push('name = ?'); args.push(fields.name); }
        if ('description' in fields) { sets.push('description = ?'); args.push(fields.description || ''); }
        if (sets.length) db.prepare('UPDATE projects SET ' + sets.join(', ') + ' WHERE id = ?').run(...args, id);
      }
    };

    for (const event of events) {
      // The effects in the order the command made them: the headline record first,
      // then what it did to everything else. A project delete is [project, its
      // tasks], and undoing it has to restore the project before the tasks that
      // point at it.
      for (const effect of (event.effects || [])) {
        const key = effect.kind + ':' + effect.id;
        const state = stateOf(effect.kind, effect.id);

        if (effect.op === 'create') {
          // Taking back a creation means removing the record.
          if (!state) { skipped.push({ seq: event.seq, entity: key, why: 'already gone' }); continue; }
          const foreign = foreignAfter(effect.kind, effect.id, event.seq, null);
          if (foreign) {
            conflict(event, key, 'changed by ' + foreign.actor + ' (' + foreign.type + ', seq ' + foreign.seq + ') after the agent created it', foreign.overlap);
            continue;
          }
          // A project takes its tasks' project field with it (the foreign key nulls
          // it). Those are changes, so they are planned as effects — conflict-checked
          // one by one, because a task the human has since filed there on purpose must
          // not be quietly unfiled by an undo.
          const collateral = effect.kind === 'project'
            ? db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(effect.id).map((r) => r.id)
            : [];
          let blocked = null;
          for (const taskId of collateral) {
            const touched = foreignAfter('task', taskId, event.seq, ['project']);
            if (touched) { blocked = { taskId, touched }; break; }
          }
          if (blocked) {
            conflict(event, 'task:' + blocked.taskId,
              'changed by ' + blocked.touched.actor + ' (' + blocked.touched.type + ', seq ' + blocked.touched.seq + ') after the agent filed it under ' + effect.id,
              blocked.touched.overlap);
            continue;
          }
          schedule(event, makeEffect(effect.kind, effect.id, 'delete', state, null),
            () => deleteRecord(effect.kind, effect.id));
          collateral.forEach((taskId) => {
            const fields = { project: '' };
            schedule(event, makeEffect('task', taskId, 'update', { project: effect.id }, fields),
              () => putFieldsBack('task', taskId, { project: '' }));
          });
          continue;
        }

        if (effect.op === 'delete') {
          // Taking back a delete means putting the record back.
          //
          // For a run, "gone" and "no row" are different questions: there is only ever
          // one row in `runs`, so a plan that restores the run the agent unlocked has
          // to check that NO run is locked — otherwise it collides with whatever the
          // human locked since, and the whole undo fails on a UNIQUE constraint.
          const busy = effect.kind === 'run' ? Boolean(readRun()) : Boolean(state);
          if (busy) { skipped.push({ seq: event.seq, entity: key, why: 'something with that id exists again' }); continue; }
          if (!effect.before) { skipped.push({ seq: event.seq, entity: key, why: 'the event did not keep the record' }); continue; }
          // Symmetrical with the branch above, and it is the one that stops an undo
          // undoing itself: if somebody else has touched this record since it was
          // deleted — the usual case being an earlier revert that took the record away
          // again — then putting it back would resurrect state that a later decision
          // removed. Restoring is a change like any other and answers to the same test.
          const foreign = foreignAfter(effect.kind, effect.id, event.seq, null);
          if (foreign) {
            conflict(event, key, 'changed by ' + foreign.actor + ' (' + foreign.type + ', seq ' + foreign.seq + ') after it was deleted', foreign.overlap);
            continue;
          }
          const restored = makeEffect(effect.kind, effect.id, 'create', null, effect.before);
          restored.restored = true;                       // put back, not created by the undoer
          if (effect.createdBy) restored.createdBy = effect.createdBy;
          schedule(event, restored, () => restoreRecord(effect.kind, effect));
          continue;
        }

        // An update: put the named fields back.
        if (!state) { skipped.push({ seq: event.seq, entity: key, why: 'the record is gone' }); continue; }
        const fields = effectFields(effect) || [];
        if (!fields.length) { skipped.push({ seq: event.seq, entity: key, why: 'nothing to put back' }); continue; }
        const foreign = foreignAfter(effect.kind, effect.id, event.seq, fields);
        if (foreign) {
          conflict(event, key, 'changed by ' + foreign.actor + ' (' + foreign.type + ', seq ' + foreign.seq + ') after this change', foreign.overlap || fields);
          continue;
        }
        // Belt and braces: even with nobody else in the log, the field must still hold
        // what the agent set it to. A mismatch means the log and the rows disagree,
        // which is worth refusing over rather than stamping through.
        const clash = fields.filter((f) => state[f] !== effect.after[f] && String(state[f] ?? '') !== String(effect.after[f] ?? ''));
        if (clash.length) { conflict(event, key, 'the stored value is not the one the agent set', clash); continue; }
        const back = {};
        fields.forEach((f) => { back[f] = effect.before ? effect.before[f] : null; });
        schedule(event, makeEffect(effect.kind, effect.id, 'update', effect.after, back),
          () => putFieldsBack(effect.kind, effect.id, back));
      }
    }

    const report = {
      actor, since: since.toISOString(), until: until.toISOString(),
      throughSeq: throughSeq !== null ? throughSeq : headSeq(),
      frozen: throughSeq !== null,
      considered: events.length,
      willRevert: plan.map((p) => ({ seq: p.seq, type: p.type, entity: p.effect.kind + ':' + p.effect.id, op: p.effect.op, fields: effectFields(p.effect) })),
      conflicts, skipped,
    };
    if (dryRun) {
      return { ok: true, entity: { kind: 'board', id: 'history' }, dryRun: true, value: report, apply: () => ({ value: report, before: null, after: null, changed: false }) };
    }
    if (plan.length === 0) {
      return { ok: true, entity: { kind: 'board', id: 'history' }, value: () => report, apply: () => ({ value: report, before: null, after: null, changed: false }) };
    }
    return {
      ok: true,
      entity: { kind: 'board', id: 'history' },
      value: () => report,
      apply() {
        const reverted = [];
        plan.forEach((item) => {
          item.undo();
          reverted.push({ seq: item.seq, type: item.type, entity: item.effect.kind + ':' + item.effect.id, op: item.effect.op });
        });
        report.reverted = reverted;
        return {
          value: report,
          // The revert is itself an event, so the log says who undid what and when —
          // and every record it put back is named as an effect, so it is attributed
          // and can be reverted in turn.
          before: { events: plan.map((p) => p.seq) },
          after: { reverted },
          extra: { actor, since: report.since, until: report.until, throughSeq: report.throughSeq, conflicts: conflicts.length },
          effects: plan.map((p) => p.effect),
        };
      },
    };
  },
};

/**
 * One command, one transaction. The state change, the command row and the event
 * are written together or not at all: there is no window in which a change exists
 * without a record of who made it.
 */
function runCommand(envelope, who) {
  const env = envelope && typeof envelope === 'object' ? envelope : {};
  const type = String(env.type || '');
  const handler = COMMANDS[type];
  if (!handler) return { ...refuse('COMMAND_UNKNOWN', { type }), commandId: env.commandId || null };
  const payload = env.payload && typeof env.payload === 'object' ? env.payload : {};
  const commandId = typeof env.commandId === 'string' && env.commandId ? env.commandId : newId('cmd');

  // WHO YOU ARE COMES FROM THE CREDENTIAL, NOT FROM THE ENVELOPE.
  //
  // A request body is a claim; a token is evidence. When the two disagree the command
  // is refused rather than quietly recorded under either name: an event log whose
  // actor can be set by whoever is calling proves nothing, and in a frictionless
  // system that log is the entire safety net.
  if (env.actor && env.actor !== who.actor) {
    return { ...refuse('ACTOR_MISMATCH', { claimed: env.actor, actual: who.actor }), commandId };
  }
  const actor = who.actor;
  // A cockpit names its own window (`cockpit#window`); an agent is named by the
  // credential it holds.
  const client = who.kind === 'session' ? (env.client || who.client) : who.client;
  const print = fingerprint(type, payload);

  const seen = db.prepare('SELECT * FROM commands WHERE command_id = ?').get(commandId);
  if (seen) {
    if (seen.fingerprint !== print) return { ...refuse('COMMAND_ID_CONFLICT', { commandId, first: seen.type, now: type }), commandId };
    // Idempotent across restarts, which is the whole reason commands are stored.
    return { ok: true, commandId, replayed: true, changed: false, seq: seen.seq, rev: null, value: JSON.parse(seen.result_json) };
  }

  // AN AGENT HAS TO SAY WHICH REVISION IT READ.
  //
  // This is optimistic concurrency, not permission: a person watching the board acts
  // on what is on their screen, and so does an agent — except an agent's screen can be
  // an hour old. Without this, an agent that read a task at revision 12 and acted after
  // a human had taken it to 13 overwrote the human's edit with a change computed from a
  // world that no longer existed. With it, the stale agent is refused, re-reads, and
  // acts on what is really there.
  if (String(actor).startsWith('agent:') && REVISION_BOUND.has(type) && (env.ifRev === undefined || env.ifRev === null)) {
    return { ...refuse('REV_REQUIRED', {
      kind: type.startsWith('task') ? 'task' : 'project',
      id: (type.startsWith('task') ? payload.taskId : payload.projectId) || null,
    }), commandId };
  }

  const checked = handler(payload, { actor, client, ifRev: env.ifRev, commandId });
  if (!checked.ok) return { ...checked, commandId };

  db.exec('BEGIN IMMEDIATE');
  try {
    const applied = checked.apply();
    const at = new Date().toISOString();
    const entity = checked.entity || { kind: 'board', id: 'board' };
    let seq = headSeq();
    let rev = null;
    const changed = applied.changed !== false && (applied.before !== null || applied.after !== null);
    if (changed) {
      seq = seq + 1;
      // Every record this command touched, in the order it touched them. A handler
      // that does not describe its own effects gets the single obvious one, so a new
      // command is attributable and revertible by default rather than by memory.
      const effects = Array.isArray(applied.effects) && applied.effects.length
        ? applied.effects
        : [makeEffect(entity.kind, entity.id,
          checked.created ? 'create' : (applied.after === null || applied.after === undefined ? 'delete' : 'update'),
          applied.before === undefined ? null : applied.before,
          applied.after === undefined ? null : applied.after)];
      // A creation IS revision 1 — the first version of the record — so it does not
      // bump. Every record an `update` effect names does, which is what makes an
      // `ifRev` from a client that has seen this event meaningful — including for a
      // sibling renumbered by somebody else's move, which used to change without the
      // revision moving at all.
      effects.forEach((effect) => {
        if (effect.op === 'update') bumpRev(effect.kind, effect.id);
      });
      if (checked.created && !effects.some((e) => e.op === 'create')) {
        bumpRev(entity.kind, entity.id);
      }
      rev = entity.kind === 'task' ? (readTask(entity.id) || {}).rev
        : entity.kind === 'project' ? (readProject(entity.id) || {}).rev
          : entity.kind === 'run' ? ((readRun() || {}).rev ?? null) : null;
      db.prepare(`INSERT INTO events (seq, at, type, command_id, actor, client, entity_kind, entity_id, before_json, after_json, extra_json, effects_json)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(seq, at, type, commandId, actor, client, entity.kind, entity.id,
          applied.before === undefined || applied.before === null ? null : jsonOf(applied.before),
          applied.after === undefined || applied.after === null ? null : jsonOf(applied.after),
          applied.extra ? jsonOf(applied.extra) : null,
          jsonOf(effects));
      // Who did it, on every record it happened to, in the same transaction as the
      // change. A task orphaned by a project delete, or a sibling renumbered by a
      // move, is a record somebody changed — leaving it unattributed is how the board
      // ends up unable to say who moved it.
      effects.forEach((effect) => {
        attributionUpdate(effect.kind, effect.id, actor, at, type, seq, effect.op === 'create' && !effect.restored, effect.createdBy || null);
      });
    }
    // Read the answer AFTER the revision has moved: a handler that returns a live
    // record used to hand back the revision from before its own bump, which is the
    // one number a client is most likely to chain `ifRev` from.
    let value = typeof applied.value === 'function' ? applied.value() : applied.value;
    if (changed && value && typeof value === 'object' && value.id === entity.id) {
      const fresh = entity.kind === 'task' ? readTask(entity.id) : entity.kind === 'project' ? readProject(entity.id) : null;
      if (fresh) value = fresh;
    }
    if (!changed) {
      // A command that changed nothing still answers with the revision the record is
      // at, so a client can chain `ifRev` from it without another read.
      rev = entity.kind === 'task' ? ((readTask(entity.id) || {}).rev ?? null)
        : entity.kind === 'project' ? ((readProject(entity.id) || {}).rev ?? null)
          : entity.kind === 'run' ? ((readRun() || {}).rev ?? null) : null;
    }
    db.prepare(`INSERT INTO commands (command_id, seq, type, fingerprint, actor, client, at, payload_json, result_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(commandId, seq, type, print, actor, client, at, jsonOf(payload), jsonOf(value));
    recordActor(actor);
    db.exec('COMMIT');
    const result = { ok: true, commandId, replayed: false, changed: Boolean(changed), seq, rev, value };
    if (changed) result.event = rowToEvent(db.prepare('SELECT * FROM events WHERE seq = ?').get(seq));
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    return { ...refuse('WRITE_FAILED', { reason: String((error && error.message) || error) }), commandId };
  }
}

function rowToEvent(row) {
  const parse = (v) => { try { return v === null ? null : JSON.parse(v); } catch { return null; } };
  return {
    seq: row.seq,
    at: row.at,
    type: row.type,
    commandId: row.command_id,
    actor: row.actor,
    client: row.client,
    entity: { kind: row.entity_kind, id: row.entity_id },
    before: parse(row.before_json),
    after: parse(row.after_json),
    // Every record this event touched, not just the one it is named after.
    effects: parse(row.effects_json) || [],
    ...(row.extra_json ? { extra: parse(row.extra_json) } : {}),
  };
}

// ── Import: the migration path ──────────────────────────────────────────────
// This is the creator's real data, so nothing here guesses. The exact bytes are
// archived BEFORE anything is written, the import preserves ids, createdAt and
// unknown fields, and it produces a report instead of dropping what it cannot use.

function analyseLegacy(bytes) {
  const report = { ok: false, counts: { projects: 0, tasks: 0, run: false, events: 0 }, conflicts: [], novel: { projects: [], tasks: [] }, same: { projects: [], tasks: [] }, dropped: [] };
  let parsed;
  try { parsed = JSON.parse(bytes); } catch (error) { report.error = 'The stored document is not valid JSON.'; return report; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { report.error = 'The stored document is not an object.'; return report; }
  if (parsed.version !== 1) { report.error = 'The stored document says version ' + parsed.version + ', and this service reads version 1.'; return report; }

  report.projects = Array.isArray(parsed.projects) ? parsed.projects.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id) : [];
  report.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && t.id) : [];
  report.droppedProjects = (Array.isArray(parsed.projects) ? parsed.projects.length : 0) - report.projects.length;
  report.droppedTasks = (Array.isArray(parsed.tasks) ? parsed.tasks.length : 0) - report.tasks.length;
  report.run = parsed.run && typeof parsed.run === 'object' ? parsed.run : null;
  report.views = parsed.views && typeof parsed.views === 'object' ? parsed.views : null;
  report.counts = { projects: report.projects.length, tasks: report.tasks.length, run: Boolean(report.run), events: Array.isArray(parsed.events) ? parsed.events.length : 0 };

  const sameRecord = (a, b) => fingerprint('x', a) === fingerprint('x', b);
  report.projects.forEach((p) => {
    const existing = readProject(p.id);
    if (!existing) report.novel.projects.push(p.id);
    else if (sameRecord(stripRev(existing), stripRev(normaliseLegacyProject(p)))) report.same.projects.push(p.id);
    else report.conflicts.push({ kind: 'project', id: p.id, name: p.name });
  });
  report.tasks.forEach((t) => {
    const existing = readTask(t.id);
    if (!existing) report.novel.tasks.push(t.id);
    else if (sameRecord(stripRev(existing), stripRev(normaliseLegacyTask(t)))) report.same.tasks.push(t.id);
    else report.conflicts.push({ kind: 'task', id: t.id, name: t.name });
  });
  report.ok = true;
  return report;
}

const stripRev = (record) => { const copy = { ...record }; delete copy.rev; return copy; };

/** Rescue on read: an imported record is made usable, never turned away. */
function normaliseLegacyTask(raw) {
  const known = new Set(TYPED_TASK_FIELDS);
  const extra = {};
  Object.keys(raw).forEach((k) => { if (!known.has(k)) extra[k] = raw[k]; });
  const start = isRealDay(raw.start) ? raw.start : today();
  const deadline = isRealDay(raw.deadline) ? raw.deadline : '';
  const ganttRow = raw.ganttRow === undefined || raw.ganttRow === null ? null : (validRow(raw.ganttRow) ? raw.ganttRow : null);
  return {
    ...extra,
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 200) : 'Untitled task',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : '',
    // A reference to a project that is not here reads as uncategorised, which is
    // exactly what the import below will store — the comparison and the import have
    // to agree, or re-importing identical bytes would report a conflict with itself.
    project: raw.project && readProject(raw.project) ? raw.project : '',
    status: STATUSES.includes(raw.status) ? raw.status : 'backlog',
    weight: validWeight(raw.weight) ? Number(raw.weight) : 1,
    start,
    deadline,
    ganttRow,
    order: Number.isFinite(Number(raw.order)) ? Math.round(Number(raw.order)) : 0,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    rev: 1,
  };
}

function normaliseLegacyProject(raw) {
  const known = new Set(TYPED_PROJECT_FIELDS);
  const extra = {};
  Object.keys(raw).forEach((k) => { if (!known.has(k)) extra[k] = raw[k]; });
  return {
    ...extra,
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 120) : 'Untitled project',
    description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : '',
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    archivedAt: typeof raw.archivedAt === 'string' && raw.archivedAt ? raw.archivedAt : null,
    rev: 1,
  };
}

function archiveBytes(origin, bytes, extra) {
  const slug = String(origin).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown-origin';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const name = slug + '-' + stamp + '.json';
  const path = join(BACKUPS_DIR, name);
  writeFileSync(path, bytes);
  writeFileSync(path.replace(/\.json$/, '.meta.json'), JSON.stringify({
    origin, at: new Date().toISOString(), bytes: Buffer.byteLength(bytes, 'utf8'),
    sha256: createHash('sha256').update(bytes).digest('hex'), ...extra,
  }, null, 2));
  return name;
}

function importLegacy({ origin, bytes, client }) {
  const report = analyseLegacy(bytes);
  if (!report.ok) return { ok: false, ...refuse('PAYLOAD_INVALID', { type: 'legacy import', missing: [report.error] }), report };
  // The bytes are archived BEFORE anything is written, under a name that says which
  // origin they came from and when. If the import below fails, the archive is still
  // there — it is the one thing here that is never conditional.
  const archive = archiveBytes(origin, bytes, { counts: report.counts, conflicts: report.conflicts.length });

  db.exec('BEGIN IMMEDIATE');
  try {
    const actor = 'migration:localstorage';
    const at = new Date().toISOString();
    let seq = headSeq();
    const imported = { projects: 0, tasks: 0, run: false };
    const skipped = { projects: 0, tasks: 0 };

    report.projects.forEach((raw) => {
      const p = normaliseLegacyProject(raw);
      if (readProject(p.id)) { skipped.projects++; return; }
      const extra = {};
      Object.keys(p).forEach((k) => { if (!TYPED_PROJECT_FIELDS.includes(k)) extra[k] = p[k]; });
      db.prepare('INSERT INTO projects (id, name, description, created_at, archived_at, rev, extra_json) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .run(p.id, p.name, p.description, p.createdAt, p.archivedAt, JSON.stringify(extra));
      seq++; imported.projects++;
      db.prepare(`INSERT INTO events (seq, at, type, command_id, actor, client, entity_kind, entity_id, before_json, after_json, extra_json)
                  VALUES (?, ?, 'migration.entity', ?, ?, ?, 'project', ?, NULL, ?, ?)`)
        .run(seq, at, 'import:' + archive, actor, client || origin, p.id, jsonOf(readProject(p.id)), jsonOf({ archive, origin }));
    });

    report.tasks.forEach((raw) => {
      const t = normaliseLegacyTask(raw);
      if (readTask(t.id)) { skipped.tasks++; return; }
      const extra = {};
      Object.keys(t).forEach((k) => { if (!TYPED_TASK_FIELDS.includes(k)) extra[k] = t[k]; });
      db.prepare(`INSERT INTO tasks (id, name, note, project_id, status, weight, start_day, deadline_day, gantt_row, order_index, created_at, rev, extra_json)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(t.id, t.name, t.note, t.project || null, t.status, t.weight, t.start,
          t.deadline === '' ? null : t.deadline, t.ganttRow, t.order, t.createdAt, JSON.stringify(extra));
      seq++; imported.tasks++;
      db.prepare(`INSERT INTO events (seq, at, type, command_id, actor, client, entity_kind, entity_id, before_json, after_json, extra_json)
                  VALUES (?, ?, 'migration.entity', ?, ?, ?, 'task', ?, NULL, ?, ?)`)
        .run(seq, at, 'import:' + archive, actor, client || origin, t.id, jsonOf(readTask(t.id)), jsonOf({ archive, origin }));
    });

    // The frozen run is imported as it was frozen: the members come from the
    // snapshot, not from whatever the tasks look like now.
    if (report.run && Array.isArray(report.run.members) && report.run.members.length && !readRun()) {
      const run = report.run;
      db.prepare('INSERT INTO runs (id, locked_at, target, total, rev, extra_json) VALUES (1, ?, ?, ?, 1, ?)')
        .run(run.lockedAt || new Date().toISOString(), run.target || '', Number(run.total) || 0, JSON.stringify({}));
      const insert = db.prepare('INSERT INTO run_members (run_id, task_id, position, name, weight, duration, starts_at, ends_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)');
      run.members.forEach((m, i) => insert.run(m.id, i, m.name || '', Number(m.weight) || 1, Number(m.duration) || 0, Number(m.startsAt) || 0, Number(m.endsAt) || 0));
      seq++; imported.run = true;
      db.prepare(`INSERT INTO events (seq, at, type, command_id, actor, client, entity_kind, entity_id, before_json, after_json, extra_json)
                  VALUES (?, ?, 'migration.entity', ?, ?, ?, 'run', ?, NULL, ?, ?)`)
        .run(seq, at, 'import:' + archive, actor, client || origin, String(run.lockedAt || ''), jsonOf(readRun()), jsonOf({ archive, origin }));
    }

    // Cockpit preferences came along too, under the client that migrated.
    if (report.views) {
      db.prepare(`INSERT INTO preferences (client, key, value_json, updated_at) VALUES (?, 'cockpit', ?, ?)
                  ON CONFLICT(client, key) DO NOTHING`)
        .run(client || origin, JSON.stringify(report.views), at);
    }

    seq++;
    const summary = {
      origin,
      archive,
      imported,
      skipped,
      conflicts: report.conflicts.length,
      dropped: { projects: report.droppedProjects, tasks: report.droppedTasks },
    };
    db.prepare(`INSERT INTO events (seq, at, type, command_id, actor, client, entity_kind, entity_id, before_json, after_json, extra_json)
                VALUES (?, ?, 'migration.complete', ?, ?, ?, 'board', 'import', NULL, ?, ?)`)
      .run(seq, at, 'import:' + archive, actor, client || origin, jsonOf(summary), jsonOf({ archive, origin }));
    recordActor(actor);

    const existingOrigin = db.prepare('SELECT * FROM origins WHERE origin = ?').get(origin);
    db.prepare(`INSERT INTO origins (origin, first_seen, last_seen, imported_at, archive, counts_json, conflicts)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(origin) DO UPDATE SET last_seen = excluded.last_seen, imported_at = excluded.imported_at,
                  archive = excluded.archive, counts_json = excluded.counts_json, conflicts = excluded.conflicts`)
      .run(origin, (existingOrigin && existingOrigin.first_seen) || at, at, at, archive, JSON.stringify(report.counts), report.conflicts.length);

    db.exec('COMMIT');
    return {
      ok: true,
      archive,
      report: {
        origin,
        counts: report.counts,
        imported,
        skipped,
        conflicts: report.conflicts,
        note: report.conflicts.length
          ? 'Records whose id already exists with different contents were NOT imported. Two old stores are never merged by last-write-wins: the archive holds the bytes and a human decides.'
          : undefined,
        dropped: summary.dropped,
        headSeq: headSeq(),
      },
      message: 'Imported ' + imported.tasks + ' tasks and ' + imported.projects + ' projects from ' + origin +
        '; the exact bytes are archived as backups/' + archive + '.',
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    return { ok: false, ...refuse('WRITE_FAILED', { reason: String((error && error.message) || error) }) };
  }
}

/**
 * Who made this, and when. Derived columns maintained inside the command
 * transaction rather than computed by scanning the log on every snapshot — the diff
 * the reader sees must not be a guess, and it must survive a restart.
 */
function createdByOf(kind, id) {
  const table = kind === 'task' ? 'tasks' : kind === 'project' ? 'projects' : null;
  if (!table) return null;
  const row = db.prepare('SELECT created_by FROM ' + table + ' WHERE id = ?').get(id);
  return row ? (row.created_by || null) : null;
}

function attributionUpdate(kind, id, actor, at, type, seq, isCreate, createdBy) {
  const table = kind === 'task' ? 'tasks' : kind === 'project' ? 'projects' : null;
  if (!table) return;
  if (isCreate) {
    db.prepare('UPDATE ' + table + ' SET created_by = ?, last_actor = ?, last_at = ?, last_type = ?, last_seq = ? WHERE id = ?')
      .run(actor, actor, at, type, seq, id);
  } else if (createdBy) {
    // A record put back by an undo keeps the creator it had: the person undoing a
    // delete did not make the thing, and COALESCE means a record that already knows
    // its creator is never rewritten.
    db.prepare('UPDATE ' + table + ' SET created_by = COALESCE(created_by, ?), last_actor = ?, last_at = ?, last_type = ?, last_seq = ? WHERE id = ?')
      .run(createdBy, actor, at, type, seq, id);
  } else {
    db.prepare('UPDATE ' + table + ' SET last_actor = ?, last_at = ?, last_type = ?, last_seq = ? WHERE id = ?')
      .run(actor, at, type, seq, id);
  }
}

function attributionMap() {
  const map = {};
  db.prepare('SELECT id, created_by, last_actor, last_at, last_type, last_seq FROM tasks').all().forEach((row) => {
    map['task:' + row.id] = {
      createdBy: row.created_by || null, lastActor: row.last_actor || null,
      lastAt: row.last_at || null, lastType: row.last_type || null, lastSeq: row.last_seq || null,
    };
  });
  db.prepare('SELECT id, created_by, last_actor, last_at, last_type, last_seq FROM projects').all().forEach((row) => {
    map['project:' + row.id] = {
      createdBy: row.created_by || null, lastActor: row.last_actor || null,
      lastAt: row.last_at || null, lastType: row.last_type || null, lastSeq: row.last_seq || null,
    };
  });
  return map;
}

function snapshot() {
  return {
    schemaVersion: SCHEMA_VERSION,
    headSeq: headSeq(),
    instanceId: instance.instanceId,
    board: {
      projects: db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map(rowToProject),
      tasks: db.prepare('SELECT * FROM tasks ORDER BY order_index, rowid').all().map(rowToTask),
      run: readRun(),
      // Who touched what, kept beside the records rather than inside them: an entity
      // is what the creator wrote, and provenance is a fact ABOUT it.
      attribution: attributionMap(),
    },
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const sessions = new Map();        // token -> expiry ms
const nonces = new Map();          // nonce -> expiry ms
const streams = new Set();         // open SSE responses
const sessionSecret = randomBytes(32);

function mintSession() {
  const expiry = Date.now() + 12 * 60 * 60 * 1000;
  const payload = String(expiry);
  const token = payload + '.' + createHmac('sha256', sessionSecret).update(payload).digest('hex');
  sessions.set(token, expiry);
  return token;
}

function validSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (expiry && expiry > Date.now()) return true;
  sessions.delete(token);
  return false;
}

const isLoopback = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

function cookieOf(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function authorised(req, url) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer) {
    const who = actorForToken(bearer);
    if (who) {
      db.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?')
        .run(new Date().toISOString(), who.actor === 'human:minh' ? 'cred_operator' : 'cred_' + who.label);
      return {
        actor: who.actor,
        kind: 'bearer',
        client: who.actor === 'human:minh' ? 'cli' : 'agent:' + who.label,
      };
    }
  }
  if (validSession(cookieOf(req, 'proxima_session'))) {
    // The cockpit holds no token at all: its identity is the session, and it is
    // always the human at this machine.
    return { actor: 'human:minh', kind: 'session', client: cookieOf(req, 'proxima_client') || 'cockpit' };
  }
  return null;
}

/**
 * The control plane.
 *
 * Data plane — create, edit, move, delete — is open to every credential: the creator
 * chose frictionless, and an agent that had to ask would not be one. The control
 * plane is different in kind: importing bytes records mutations the undo cannot see,
 * minting a credential is how authority is handed out, and reverting somebody else's
 * work is rewriting history that is not yours. Those are the operator's, and saying so
 * is not permission friction — it is the difference between an agent and an owner.
 */
function operatorOnly(req, res, who, what) {
  if (who && isHumanActor(who.actor)) return false;
  send(res, 403, {
    ok: false,
    code: 'FORBIDDEN',
    message: 'That is the operator’s to do: ' + what + '. Nothing was changed.',
    details: { actor: who ? who.actor : null, endpoint: req.url },
  });
  return true;
}

function send(res, status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...(headers || {}),
  });
  res.end(text);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = args.origins.includes(origin);
  if (!allowed) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

function readBody(req) {
  return new Promise((resolve_, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve_(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * One event, on the wire.
 *
 * The frames are deliberately UNNAMED (`data:` with no `event:` line) even though
 * the type is right there in the payload. A named frame is only delivered to
 * listeners registered for that exact name, and a cockpit wants every event — it
 * cannot enumerate a vocabulary that grows. `id:` still carries the sequence, so
 * Last-Event-ID reconnection works, and the type travels inside the JSON where a
 * client (or an agent grepping a log) can read it.
 */
function sseFrame(event) {
  return 'id: ' + event.seq + '\ndata: ' + JSON.stringify(event) + '\n\n';
}

function broadcast(event) {
  const payload = sseFrame(event);
  for (const res of streams) {
    try { res.write(payload); } catch { streams.delete(res); }
  }
}

function serveStatic(req, res, url) {
  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(COCKPIT_DIR, path));
  if (!file.startsWith(COCKPIT_DIR) || !existsSync(file)) return send(res, 404, { ok: false, code: 'NOT_FOUND', message: 'No such file.' });
  if (extname(file) === '.html') {
    // The one-time nonce is how the page earns a session without the cockpit's
    // JavaScript ever holding a token.
    const nonce = randomBytes(16).toString('hex');
    nonces.set(nonce, Date.now() + 60_000);
    const boot = '<script>window.__PROXIMA_BOOT__ = ' + JSON.stringify({
      api: '/v1', nonce, instanceId: instance.instanceId, schemaVersion: SCHEMA_VERSION,
    }) + ';</script>';
    const html = readFileSync(file, 'utf8').replace('</head>', boot + '\n</head>');
    return send(res, 200, html, { 'Content-Type': MIME['.html'] });
  }
  const body = readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ── The cockpit ─────────────────────────────────────────────────────────
    if (!url.pathname.startsWith('/v1/')) {
      if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Only GET.' });
      return serveStatic(req, res, url);
    }

    const who = authorised(req, url);
    const needsAuth = !(url.pathname === '/v1/health' || url.pathname === '/v1/session');
    if (needsAuth && !who) {
      return send(res, 401, { ok: false, code: 'UNAUTHORISED', message: 'A bearer token or a cockpit session is required.' });
    }

    if (url.pathname === '/v1/health') {
      return send(res, 200, {
        ok: true, service: 'proximad', instanceId: instance.instanceId, schemaVersion: SCHEMA_VERSION,
        headSeq: headSeq(), dataHome: HOME, importCount: db.prepare('SELECT COUNT(*) AS n FROM origins').get().n,
      });
    }

    if (url.pathname === '/v1/session' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const remote = req.socket.remoteAddress;
      const origin = req.headers.origin || '';
      const nonceOk = body.nonce && nonces.get(body.nonce) > Date.now();
      const originOk = origin && args.origins.includes(origin) && isLoopback(remote);
      if (!nonceOk && !originOk) {
        return send(res, 403, { ok: false, code: 'SESSION_REFUSED', message: 'No valid nonce, and this origin is not allowed to skip one.' });
      }
      if (nonceOk) nonces.delete(body.nonce);
      const token = mintSession();
      const client = String(body.client || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40) || 'cockpit';
      res.setHeader('Set-Cookie', [
        'proxima_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200',
        'proxima_client=' + client + '; Path=/; SameSite=Strict; Max-Age=43200',
      ]);
      return send(res, 200, { ok: true, client, actor: who ? who.actor : 'human:minh', instanceId: instance.instanceId, schemaVersion: SCHEMA_VERSION });
    }

    if (url.pathname === '/v1/snapshot' && req.method === 'GET') {
      return send(res, 200, snapshot());
    }

    if (url.pathname === '/v1/commands' && req.method === 'POST') {
      const raw = await readBody(req);
      let envelope;
      try { envelope = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'command', missing: ['a JSON body'] }) }); }
      const result = runCommand(envelope, who);
      // One event, broadcast once: a command that changed nothing has no event, and
      // a replay must not re-broadcast a change that already happened.
      if (result.ok && result.event) broadcast(result.event);
      return send(res, result.ok ? 200 : 409, result);
    }

    if (url.pathname === '/v1/events' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0);
      const oldest = oldestSeq();
      if (oldest && after && after < oldest - 1) {
        return send(res, 409, {
          ok: false, code: 'RESYNC_REQUIRED',
          message: 'Events before ' + oldest + ' are no longer held; take a fresh snapshot and subscribe from there.',
          details: { requestedAfter: after, oldestHeld: oldest, headSeq: headSeq() },
        });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const backlog = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(after);
      for (const row of backlog) res.write(sseFrame(rowToEvent(row)));
      res.write(': subscribed at ' + headSeq() + '\n\n');
      streams.add(res);
      const heartbeat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closing */ } }, 20000);
      req.on('close', () => { clearInterval(heartbeat); streams.delete(res); });
      return undefined;
    }

    if (url.pathname === '/v1/agents') {
      if (req.method === 'GET') {
        return send(res, 200, {
          ok: true,
          agents: db.prepare("SELECT id, actor, kind, created_at, last_used_at, note FROM credentials WHERE kind = 'bearer' ORDER BY actor").all()
            .map((c) => ({ actor: c.actor, credential: c.id, createdAt: c.created_at, lastUsedAt: c.last_used_at, note: c.note }))
            .filter((c) => c.actor !== 'human:minh'),
          operator: TOKEN_PATH,
        });
      }
      if (req.method === 'POST') {
        // Only the operator may mint an agent, and only through this door: it is the
        // one place a token is written, so the credentials table and the file on disk
        // cannot drift apart.
        if (operatorOnly(req, res, who, 'create an agent credential')) return undefined;
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'agent', missing: ['a JSON body'] }) }); }
        const name = String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
        if (!name) return send(res, 400, { ...refuse('NAME_REQUIRED', {}) });
        const path = join(AGENTS_DIR, name + '.token');
        const token = existsSync(path) ? readTokenFile(path) : randomBytes(32).toString('hex');
        writeTokenFile(path, token);
        recordCredential('cred_' + name, 'agent:' + name, 'bearer', token,
          'The token in <home>/agents/' + name + '.token, created by POST /v1/agents.');
        recordActor('agent:' + name);
        loadCredentials();
        return send(res, 200, {
          ok: true, actor: 'agent:' + name, tokenFile: path, token: token, existed: existsSync(path),
          message: 'Agent “' + name + '” can now write as agent:' + name + '. Its token is in ' + path + ' — read it from disk, do not pass it on a command line.',
        });
      }
      return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    }

    if (url.pathname === '/v1/agents/revoke' && req.method === 'POST') {
      if (operatorOnly(req, res, who, 'revoke an agent credential')) return undefined;
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'revoke', missing: ['a JSON body'] }) }); }
      const name = String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
      if (!name) return send(res, 400, { ...refuse('NAME_REQUIRED', {}) });
      const actor = 'agent:' + name;
      const path = join(AGENTS_DIR, name + '.token');
      // All three, together, or the revocation is only a story: a file left behind is
      // a working credential, and a row left behind is one that still looks alive.
      const fileRemoved = existsSync(path);
      if (fileRemoved) { try { unlinkSync(path); } catch { /* reported below */ } }
      const removed = db.prepare('DELETE FROM credentials WHERE actor = ?').run(actor).changes;
      for (const [token, entry] of [...credentialCache]) {
        if (entry.actor === actor) credentialCache.delete(token);
      }
      loadCredentials();
      const stillThere = existsSync(path);
      return send(res, stillThere ? 500 : 200, {
        ok: !stillThere,
        actor,
        tokenFile: path,
        fileRemoved: fileRemoved && !stillThere,
        credentialsRemoved: removed,
        message: stillThere
          ? 'The token file could not be removed, so ' + actor + ' can still write. Nothing else was changed.'
          : actor + ' is revoked: token file gone, credentials row gone, cached credential dropped. What it already wrote stays, and stays attributed to it.',
      });
    }

    if (url.pathname === '/v1/log' && req.method === 'GET') {
      // The read side of the log, for a cockpit that wants a diff of what moved while
      // it was not looking. SSE is for staying current; this is for catching up.
      //
      // Two ways to bound it, because they answer different questions: `after` is a
      // watermark ("everything since the last thing I read") and `since` is a time
      // ("what an agent did in the last hour"). The undo control asks the second one,
      // and asking it with a sequence number would mean guessing at a mapping between
      // sequences and clock time that only the log itself knows.
      const after = Number(url.searchParams.get('after') || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const actor = url.searchParams.get('actor');
      const since = url.searchParams.get('since');
      const clauses = ['seq > ?'];
      const params = [after];
      if (since) { clauses.push('at >= ?'); params.push(since); }
      if (actor) { clauses.push('actor = ?'); params.push(actor); }
      const rows = db.prepare('SELECT * FROM events WHERE ' + clauses.join(' AND ') + ' ORDER BY seq LIMIT ?')
        .all(...params, limit);
      return send(res, 200, { ok: true, after, since: since || null, headSeq: headSeq(), events: rows.map(rowToEvent) });
    }

    if (url.pathname === '/v1/imports' && req.method === 'GET') {
      if (operatorOnly(req, res, who, 'read what has been imported')) return undefined;
      return send(res, 200, {
        ok: true,
        backups: readdirSync(BACKUPS_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')),
        origins: db.prepare('SELECT * FROM origins ORDER BY first_seen').all().map((o) => ({
          origin: o.origin, firstSeen: o.first_seen, lastSeen: o.last_seen, importedAt: o.imported_at,
          archive: o.archive, counts: JSON.parse(o.counts_json || '{}'), conflicts: o.conflicts,
        })),
      });
    }

    if (url.pathname === '/v1/import/inspect' && req.method === 'POST') {
      if (operatorOnly(req, res, who, 'inspect a legacy board for import')) return undefined;
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'legacy inspect', missing: ['a JSON body'] }) }); }
      if (typeof body.bytes !== 'string') return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'legacy inspect', missing: ['bytes'] }) });
      const report = analyseLegacy(body.bytes);
      return send(res, report.ok ? 200 : 400, {
        ok: report.ok,
        error: report.error,
        origin: body.origin || 'unknown',
        counts: report.counts,
        alreadyImported: Boolean(db.prepare('SELECT 1 FROM origins WHERE origin = ? AND imported_at IS NOT NULL').get(body.origin || '')),
        serviceEmpty: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n === 0 && db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === 0 && !readRun(),
        novel: { projects: report.novel ? report.novel.projects.length : 0, tasks: report.novel ? report.novel.tasks.length : 0 },
        same: { projects: report.same ? report.same.projects.length : 0, tasks: report.same ? report.same.tasks.length : 0 },
        conflicts: report.conflicts || [],
        dropped: { projects: report.droppedProjects || 0, tasks: report.droppedTasks || 0 },
      });
    }

    if (url.pathname === '/v1/import' && req.method === 'POST') {
      // Import writes rows that carry no actor of their own and are excluded from
      // every undo, which is exactly why it is not an agent's to do: it would be a
      // door into the board that attribution and history.revert both look away from.
      if (operatorOnly(req, res, who, 'import a legacy board')) return undefined;
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'legacy import', missing: ['a JSON body'] }) }); }
      if (typeof body.bytes !== 'string') return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'legacy import', missing: ['bytes'] }) });
      if (!body.origin) return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'legacy import', missing: ['origin'] }) });
      const result = importLegacy({ origin: body.origin, bytes: body.bytes, client: body.client });
      const rows = db.prepare('SELECT * FROM events WHERE type LIKE ? ORDER BY seq').all('migration.%');
      for (const row of rows) broadcast(rowToEvent(row));
      return send(res, result.ok ? 200 : 400, result);
    }

    if (url.pathname.startsWith('/v1/preferences/')) {
      const client = decodeURIComponent(url.pathname.slice('/v1/preferences/'.length));
      if (!client) return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'preferences', missing: ['client'] }) });
      if (req.method === 'GET') {
        const row = db.prepare("SELECT value_json FROM preferences WHERE client = ? AND key = 'cockpit'").get(client);
        return send(res, 200, { ok: true, client, prefs: row ? JSON.parse(row.value_json) : null });
      }
      if (req.method === 'PUT') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ...refuse('PAYLOAD_INVALID', { type: 'preferences', missing: ['a JSON body'] }) }); }
        db.prepare(`INSERT INTO preferences (client, key, value_json, updated_at) VALUES (?, 'cockpit', ?, ?)
                    ON CONFLICT(client, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
          .run(client, JSON.stringify(body.prefs || {}), new Date().toISOString());
        return send(res, 200, { ok: true, client, prefs: body.prefs || {} });
      }
      return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    }

    return send(res, 404, { ok: false, code: 'NOT_FOUND', message: 'No such endpoint.' });
  } catch (error) {
    log('request failed:', String((error && error.stack) || error));
    return send(res, 500, { ok: false, code: 'INTERNAL', message: String((error && error.message) || error) });
  }
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error('[proximad] port ' + args.port + ' is already in use — another proximad, or something else, is listening there.');
    console.error('[proximad] start with --port <n>, or stop the other one. Nothing was changed.');
    process.exit(3);
  }
  console.error('[proximad] server error:', String((error && error.message) || error));
  process.exit(3);
});

server.listen(args.port, args.host, () => {
  const url = 'http://' + (args.host === '0.0.0.0' ? '127.0.0.1' : args.host) + ':' + args.port;
  log('instance', instance.instanceId, '· schema v' + SCHEMA_VERSION);
  log('data home', HOME);
  log('database  ', DB_PATH, '(WAL)');
  log('token     ', TOKEN_PATH, '— bearer for agents; never given to a browser');
  if (args.origins.length) log('allowed origins for session minting:', args.origins.join(', '));
  log('cockpit   ', url + '/');
  log('api       ', url + '/v1/snapshot');
  const shutdown = () => {
    log('shutting down');
    for (const res of streams) { try { res.end(); } catch { /* closing */ } }
    try { db.close(); } catch { /* already closed */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
});
