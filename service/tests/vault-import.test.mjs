/*
 * Regressions for the vault import, driven through the real client against a real
 * proximad on a throwaway data home. No test scaffolding inside the product: the two
 * programs under test are started exactly as a person starts them.
 *
 * The three things pinned down here, all found by a reviewer after the import shipped:
 *
 *   1. CONTAINMENT. The vault root and its configured folders were joined as strings,
 *      so `eventsFolder: "../../outside/events"` was followed, and a file inside the
 *      events folder that was really a link to somewhere else was read and imported.
 *      An import that reads outside the vault it was given has broken the only promise
 *      it makes. Paths are now canonicalized with realpath and measured against the
 *      canonical root; source paths are derived with relative(realRoot, realFile).
 *   2. COLLISIONS. A record whose id was already on the board was counted as "skipped"
 *      without ever being compared — so an import could report success while throwing
 *      away a change the creator had made in the vault. Same content is a no-op;
 *      different content is a refusal, and every collision is found before any write.
 *   3. ARCHIVES. See archive-store.test.mjs; the end-to-end half is here — two imports
 *      of one vault leave two archives.
 *
 * And the two a second review found:
 *
 *   4. THE SETTINGS FILE IS A SOURCE OF SOURCES. `data.json` decides which folders are
 *      read, so a `data.json` that is really a link out of the vault would let the vault
 *      name its own sources from anywhere. It is canonicalized and contained like
 *      everything else, and refused as a CONTAINMENT failure — never mistaken for a
 *      missing or unreadable file, which is the ordinary case with a fallback.
 *   5. TWO SOURCES, ONE ID. `projects/<id>/index.md` fed a Map that took the last write:
 *      two records for one id collapsed into one row and the loser was never mentioned.
 *      A folder and its own record are the expected pairing; a second record that
 *      differs, or a second folder claiming a different path, refuses the import.
 *
 * Run: node --test  (or: node --test "service/tests/*.test.mjs")
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = join(SERVICE, 'proximad.mjs');
const CLIENT = join(SERVICE, 'proxima-client.mjs');

let root;
let home;
let port;
let base;
let daemon;
let daemonLog = '';
let token;

const freePort = () => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const chosen = probe.address().port; probe.close(() => done(chosen)); });
});

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'proxima-vault-tests-'));
  home = join(root, 'data-home');
  mkdirSync(home, { recursive: true });
  port = await freePort();
  base = 'http://127.0.0.1:' + port;
  daemon = spawn(process.execPath, [DAEMON, '--home', home, '--port', String(port), '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', (chunk) => { daemonLog += chunk; });
  daemon.stderr.on('data', (chunk) => { daemonLog += chunk; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(base + '/v1/health');
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('proximad did not come up on ' + base + '\n' + daemonLog);
    await new Promise((r) => setTimeout(r, 100));
  }
  token = readFileSync(join(home, 'token'), 'utf8').trim();
});

after(async () => {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const stopped = new Promise((done) => daemon.once('exit', done));
    daemon.kill();
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  }
  // Windows keeps the directory busy until the child has really let go of the SQLite
  // file, and a leftover temp directory is not a test failure either way.
  try { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) { console.error('note: temp vault root left behind at ' + root + ' (' + error.code + ')'); }
});

// ── The two programs, driven the way a person drives them ───────────────────

/** The client, exactly as documented — never writing actions.json into this repo. */
function client(...args) {
  const result = spawnSync(process.execPath, [CLIENT, ...args, '--url', base, '--home', home, '--no-actions'],
    { encoding: 'utf8' });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

const clientJson = (...args) => {
  const run = client(...args);
  let parsed = null;
  try { parsed = JSON.parse(run.output); } catch { /* refusal text, asserted by the caller */ }
  return { ...run, parsed };
};

const HOOKS = join(SERVICE, 'tests', 'hooks', 'settings-fault-preload.mjs');

/**
 * The client again, watched from inside: see tests/hooks/. `environment` carries the
 * fault to inject and the log to write; the product itself is untouched and is started
 * exactly as it is started above.
 */
function clientWatched(environment, ...args) {
  const result = spawnSync(process.execPath,
    ['--import', pathToFileURL(HOOKS).href, CLIENT, ...args, '--url', base, '--home', home, '--no-actions'],
    { encoding: 'utf8', env: { ...process.env, ...environment } });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

async function snapshot() {
  const res = await fetch(base + '/v1/snapshot', { headers: { authorization: 'Bearer ' + token } });
  return res.json();
}

async function command(type, payload) {
  const res = await fetch(base + '/v1/commands', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ type, payload, commandId: 'cmd_test_' + Math.random().toString(36).slice(2, 10), client: 'test' }),
  });
  return res.json();
}

const archives = () => (existsSync(join(home, 'backups'))
  ? readdirSync(join(home, 'backups')).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))
  : []);

// ── A vault to import ───────────────────────────────────────────────────────

let vaultSeq = 0;

function vault(options = {}) {
  const dir = join(root, 'vault-' + (++vaultSeq));
  const eventsRel = options.eventsRel || '-Hide/Proxima/events';
  const projectsRel = options.projectsRel || '-Hide/Proxima/projects';
  mkdirSync(join(dir, '.obsidian', 'plugins', 'proxima'), { recursive: true });
  writeFileSync(join(dir, '.obsidian', 'plugins', 'proxima', 'data.json'),
    JSON.stringify({ eventsFolder: eventsRel, projectsFolder: projectsRel, migrated: true }));
  const eventsDir = join(dir, ...eventsRel.split('/'));
  const projectsDir = join(dir, ...projectsRel.split('/'));
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  return { dir, eventsDir, projectsDir };
}

const frontmatter = (fields, body = 'A note.') => '---\n'
  + Object.entries(fields).map(([k, v]) => k + ': ' + v).join('\n')
  + '\n---\n\n' + body + '\n';

const eventDoc = (id, fields) => frontmatter({
  id,
  name: 'Tin học ứng dụng',
  project: fields.project || '',
  startDate: fields.start || '2026-06-04T03:00:00.000Z',
  deadline: fields.deadline || '2026-06-04T05:00:00.000Z',
  recurrence: 'weekly',
  createdAt: '2026-06-01T00:00:00.000Z',
  ...(fields.extra || {}),
});

const writeEvent = (v, id, fields = {}) => {
  writeFileSync(join(v.eventsDir, id + '.md'), eventDoc(id, fields));
};

const projectDoc = (id, name, extra = {}) => frontmatter({
  id,
  name,
  description: 'A project.',
  createdAt: '2026-05-30T00:00:00.000Z',
  ...extra,
});

const writeProject = (v, id, fields) => {
  const dir = join(v.projectsDir, id);
  mkdirSync(dir, { recursive: true });
  if (fields) writeFileSync(join(dir, 'index.md'), projectDoc(id, fields.name, { description: fields.description || 'A project.', createdAt: fields.createdAt || '2026-05-30T00:00:00.000Z' }));
  return dir;
};

/**
 * A vault with two projects (one named, one not) and two events (one filed, one not).
 *
 * The tag makes each test's ids its own. Two vaults at different paths are genuinely
 * different sources — a project's folder link is part of what it is — so reusing ids
 * across tests would be testing a collision, not the thing under test.
 */
const standard = (tag = 'a') => {
  const ids = {
    project: 'proj-1780057127027-' + tag,
    unnamed: 'proj-1780057127030-' + tag,
    event: 'event-1780320243719-' + tag,
    loose: 'event-1780320243720-' + tag,
  };
  const v = vault();
  writeProject(v, ids.project, { name: 'Articulate' });
  writeProject(v, ids.unnamed, null);
  writeEvent(v, ids.event, { project: ids.project });
  writeEvent(v, ids.loose, {});
  return { ...v, ids };
};

// ── 1. Containment ──────────────────────────────────────────────────────────

test('a configured folder that climbs out of the vault is refused, and nothing is sent', async () => {
  const before = await snapshot();
  const beforeArchives = archives().length;

  // The vault sits one level down so that `../../outside/events` is a real folder
  // that really exists: this must fail on containment, not on absence.
  const held = join(root, 'escape-holder');
  const vaultDir = join(held, 'vault');
  const settingsDir = join(vaultDir, '.obsidian', 'plugins', 'proxima');
  mkdirSync(settingsDir, { recursive: true });
  const outsideDir = join(root, 'outside');
  mkdirSync(join(outsideDir, 'events'), { recursive: true });
  writeFileSync(join(outsideDir, 'events', 'event-1780320243799-zzzzz.md'),
    eventDoc('event-1780320243799-zzzzz', {}));
  mkdirSync(join(outsideDir, 'projects'), { recursive: true });
  writeFileSync(join(settingsDir, 'data.json'),
    JSON.stringify({ eventsFolder: '../../outside/events', projectsFolder: '../../outside/projects' }));

  const run = client('vault', 'import', vaultDir);

  assert.equal(run.status, 2, 'a truthful refusal exits 2: ' + run.output);
  assert.match(run.output, /outside the vault/);
  assert.match(run.output, /outside[\\/]events/);
  assert.equal(archives().length, beforeArchives, 'nothing may reach the service — not even an archive');
  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq, 'a refused import writes no event');
  assert.equal(after.board.schedule.length, before.board.schedule.length);
  assert.ok(!after.board.schedule.some((e) => e.id === 'event-1780320243799-zzzzz'));
});

test('a reparse point inside the vault that resolves to an external .md is refused', async (t) => {
  const before = await snapshot();
  const beforeArchives = archives().length;

  const external = join(root, 'external-md');
  mkdirSync(external, { recursive: true });
  const externalEvent = join(external, 'event-1780320243798-yyyyy.md');
  writeFileSync(externalEvent, eventDoc('event-1780320243798-yyyyy', {}));

  const v = standard();
  const link = join(v.eventsDir, 'borrowed.md');
  let kind = null;
  try {
    // A real file symlink is what a synced or hand-linked vault would contain.
    symlinkSync(externalEvent, link, 'file');
    kind = 'file symlink';
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'UNKNOWN') throw error;
    try {
      // No privilege for a file symlink on this machine: a directory junction under a
      // .md name exercises the identical code path — a path inside the vault that
      // resolves somewhere else. The check is on the resolved path, not on the kind.
      symlinkSync(external, link, 'junction');
      kind = 'directory junction named .md';
    } catch (fallback) {
      t.skip('this machine refuses both file symlinks (' + error.code + ') and junctions (' + fallback.code + ')');
      return;
    }
  }

  const run = client('vault', 'import', v.dir);

  assert.equal(run.status, 2, 'a reparse point out of the vault must be refused (' + kind + '): ' + run.output);
  assert.match(run.output, /outside the vault/);
  assert.equal(archives().length, beforeArchives, 'nothing may reach the service — not even an archive');
  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq);
  assert.ok(!after.board.schedule.some((e) => e.id === 'event-1780320243798-yyyyy'),
    'the external file must not be on the board');
  assert.ok(!after.board.schedule.some((e) => e.sourceRef && e.sourceRef.includes('borrowed')),
    'and it must not be recorded as having come from inside the vault either');
});

test('the service refuses a payload whose own paths escape, without a client to stop it', async () => {
  const before = await snapshot();

  const escapedFile = await command('vault.import', {
    source: { root: root, origin: 'vault:test' },
    files: [{ path: '../../outside/events/event-1780320243799-zzzzz.md', bytes: eventDoc('event-1780320243799-zzzzz', {}) }],
    folders: [],
  });
  assert.equal(escapedFile.ok, false);
  assert.equal(escapedFile.code, 'VAULT_PATH_ESCAPE');
  assert.deepEqual(escapedFile.details.paths, ['../../outside/events/event-1780320243799-zzzzz.md']);

  const escapedFolder = await command('vault.import', {
    source: { root: join(root, 'declared-vault'), origin: 'vault:test' },
    files: [],
    folders: [{ id: 'proj-1780057127027-esc', path: join(root, 'external-md') }],
  });
  assert.equal(escapedFolder.ok, false);
  assert.equal(escapedFolder.code, 'VAULT_PATH_ESCAPE');

  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq);
  assert.equal(archives().length, 0, 'a refused payload is not archived');
});

// ── 2. Collisions ───────────────────────────────────────────────────────────

test('import, then re-import: identical records are a no-op, and both archives survive', async () => {
  const v = standard('r');
  const first = clientJson('vault', 'import', v.dir, '--json');
  assert.equal(first.status, 0, first.output);
  const firstReport = first.parsed.report;

  assert.equal(firstReport.projects.created, 2);
  assert.equal(firstReport.events.created, 2);
  assert.equal(firstReport.projects.skipped, 0);
  const afterFirst = await snapshot();
  assert.equal(afterFirst.board.projects.length, 2);
  assert.equal(afterFirst.board.schedule.length, 2);
  assert.equal(afterFirst.board.schedule.filter((e) => e.project === v.ids.project).length, 1);
  // Provenance is derived from the canonical root, so it reads as vault-relative.
  assert.ok(afterFirst.board.schedule.every((e) => e.sourceRef === '-Hide/Proxima/events/' + e.id + '.md'),
    JSON.stringify(afterFirst.board.schedule.map((e) => e.sourceRef)));

  const archivesAfterFirst = archives();
  assert.equal(archivesAfterFirst.length, 1);

  const second = clientJson('vault', 'import', v.dir, '--json');
  assert.equal(second.status, 0, second.output);
  const secondReport = second.parsed.report;
  assert.equal(secondReport.projects.created, 0);
  assert.equal(secondReport.events.created, 0);
  assert.equal(secondReport.projects.skipped, 2, 'identical records are a no-op, not a refusal');
  assert.equal(secondReport.events.skipped, 2);

  const afterSecond = await snapshot();
  assert.equal(afterSecond.headSeq, afterFirst.headSeq, 'a no-op import writes no event');
  assert.equal(afterSecond.board.projects.length, 2);
  assert.equal(afterSecond.board.schedule.length, 2);
  const archivesAfterSecond = archives();
  assert.equal(archivesAfterSecond.length, 2, 'the second import must not overwrite the first archive');
  assert.notEqual(archivesAfterSecond[0], archivesAfterSecond[1]);
});

test('a project whose id is already on the board with different content refuses the whole import', async () => {
  const v = standard('p');
  assert.equal(clientJson('vault', 'import', v.dir, '--json').status, 0);
  const before = await snapshot();
  const archivesBefore = archives().length;

  // The same id, the same file, a name the creator changed in the vault. This used to
  // be reported as "skipped": the import succeeded and the change vanished silently.
  writeProject(v, v.ids.project, { name: 'Articulate (renamed)' });
  // And a record that would genuinely be new, in the same import — it must not land
  // either, because the whole import refuses before anything is written.
  const heldBack = 'event-1780320243721-ccccc';
  writeEvent(v, heldBack, { project: v.ids.project });

  const run = clientJson('vault', 'import', v.dir, '--json');
  assert.equal(run.status, 1, run.output);
  assert.equal(run.parsed.ok, false);
  assert.equal(run.parsed.code, 'VAULT_ID_CONFLICT');
  const conflict = run.parsed.details.conflicts.find((c) => c.id === v.ids.project);
  assert.ok(conflict, JSON.stringify(run.parsed.details));
  assert.ok(conflict.fields.includes('name'), JSON.stringify(conflict));

  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq, 'a refused import writes no event');
  assert.equal(after.board.projects.length, before.board.projects.length);
  assert.equal(after.board.schedule.length, before.board.schedule.length, 'the new event must not be written either');
  assert.ok(!after.board.schedule.some((e) => e.id === heldBack));
  assert.equal(after.board.projects.find((p) => p.id === v.ids.project).name, 'Articulate',
    'the board keeps what it had: an import never overwrites');
  assert.equal(archives().length, archivesBefore, 'a refused import writes no archive');

  // Put the vault back the way it was, and the import is a no-op again — with the new
  // event created, proving the refusal held a record back rather than losing it.
  writeProject(v, v.ids.project, { name: 'Articulate' });
  const recovered = clientJson('vault', 'import', v.dir, '--json');
  assert.equal(recovered.status, 0, recovered.output);
  assert.equal(recovered.parsed.report.projects.created, 0);
  assert.equal(recovered.parsed.report.projects.skipped, 2);
  assert.equal(recovered.parsed.report.events.created, 1);
  const final = await snapshot();
  assert.ok(final.board.schedule.some((e) => e.id === heldBack));
});

test('an event whose id is already on the board with a different date refuses the import', async () => {
  const v = standard('e');
  assert.equal(clientJson('vault', 'import', v.dir, '--json').status, 0);
  const before = await snapshot();

  writeEvent(v, v.ids.event, { project: v.ids.project, start: '2026-06-05T03:00:00.000Z' });
  const run = clientJson('vault', 'import', v.dir, '--json');

  assert.equal(run.parsed.ok, false);
  assert.equal(run.parsed.code, 'VAULT_ID_CONFLICT');
  const conflict = run.parsed.details.conflicts.find((c) => c.id === v.ids.event);
  assert.ok(conflict.fields.includes('start_at'), JSON.stringify(conflict));

  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq);
  assert.equal(after.board.schedule.find((e) => e.id === v.ids.event).startAt,
    before.board.schedule.find((e) => e.id === v.ids.event).startAt, 'the stored instant is unchanged');
});

// ── 3. The settings file, and two sources claiming one id ───────────────────

/**
 * Make the vault's own `data.json` a link to one that lives outside it.
 *
 * Returns which shape it had to use, or null when this machine allows neither. A real
 * file symlink is what a synced or hand-linked vault would hold; without the privilege
 * for one, a junction replacing the settings folder puts the same external file at the
 * same path, through the same realpath.
 */
function pointSettingsOutside(vaultDir, externalDir, t) {
  const settingsDir = join(vaultDir, '.obsidian', 'plugins', 'proxima');
  const settingsPath = join(settingsDir, 'data.json');
  rmSync(settingsPath, { force: true });
  try {
    symlinkSync(join(externalDir, 'data.json'), settingsPath, 'file');
    return 'file symlink to data.json';
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'UNKNOWN') throw error;
    rmSync(settingsDir, { recursive: true, force: true });
    try {
      symlinkSync(externalDir, settingsDir, 'junction');
      return 'directory junction around data.json';
    } catch (fallback) {
      t.skip('this machine refuses both file symlinks (' + error.code + ') and junctions (' + fallback.code + ')');
      return null;
    }
  }
}

test('a settings file that resolves outside the vault is refused, even when it names folders inside it', async (t) => {
  const before = await snapshot();
  const beforeArchives = archives().length;

  // The settings say what a perfectly ordinary vault would say. Nothing about their
  // CONTENT is unusual — the problem is that they came from outside the vault, and the
  // settings file is what decides which folders are read. If it were honoured, this
  // import would succeed and look completely normal, which is exactly why it may not.
  const external = join(root, 'external-settings-plain');
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, 'data.json'), JSON.stringify({
    eventsFolder: '-Hide/Proxima/events',
    projectsFolder: '-Hide/Proxima/projects',
  }));

  const v = vault();
  writeEvent(v, 'event-1780320243796-vvvvv', {});
  const kind = pointSettingsOutside(v.dir, external, t);
  if (!kind) return;

  const run = client('vault', 'import', v.dir);

  assert.equal(run.status, 2, 'settings from outside the vault must be refused (' + kind + '): ' + run.output);
  assert.match(run.output, /plugin settings/, 'the refusal must name the settings file, not a folder it named');
  assert.match(run.output, /outside the vault/);
  assert.equal(archives().length, beforeArchives, 'nothing may reach the service — not even an archive');
  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq);
  assert.ok(!after.board.schedule.some((e) => e.id === 'event-1780320243796-vvvvv'),
    'the import must not have run at all, however ordinary its settings looked');
});

test('a settings file that resolves outside the vault cannot pull external folders in', async (t) => {
  const before = await snapshot();
  const beforeArchives = archives().length;

  const external = join(root, 'external-settings');
  mkdirSync(join(external, 'events'), { recursive: true });
  mkdirSync(join(external, 'projects'), { recursive: true });
  writeFileSync(join(external, 'events', 'event-1780320243797-wwwww.md'),
    eventDoc('event-1780320243797-wwwww', {}));
  writeFileSync(join(external, 'data.json'), JSON.stringify({
    eventsFolder: '../../external-settings/events',
    projectsFolder: '../../external-settings/projects',
  }));

  const v = vault();
  const kind = pointSettingsOutside(v.dir, external, t);
  if (!kind) return;

  const run = client('vault', 'import', v.dir);

  assert.equal(run.status, 2, 'settings from outside the vault must be refused (' + kind + '): ' + run.output);
  assert.match(run.output, /plugin settings/);
  assert.equal(archives().length, beforeArchives, 'nothing may reach the service — not even an archive');
  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq);
  assert.ok(!after.board.schedule.some((e) => e.id === 'event-1780320243797-wwwww'),
    'the external record must not be on the board');
});

test('two source records claiming one project id are refused, not merged', async () => {
  const before = await snapshot();
  const beforeArchives = archives().length;
  const id = 'proj-1780057127099-dup';

  // Two `projects/<same-id>/index.md` files with different names. The Map this used to
  // feed took the last write, so one of these names would simply have vanished.
  const run = await command('vault.import', {
    source: { root: join(root, 'declared-vault'), origin: 'vault:test' },
    files: [
      { path: 'one/projects/' + id + '/index.md', bytes: projectDoc(id, 'First name') },
      { path: 'two/projects/' + id + '/index.md', bytes: projectDoc(id, 'Second name') },
    ],
    folders: [],
  });

  assert.equal(run.ok, false, JSON.stringify(run));
  assert.equal(run.code, 'VAULT_ID_CONFLICT');
  const conflict = run.details.conflicts.find((c) => c.id === id);
  assert.ok(conflict, JSON.stringify(run.details));
  assert.match(conflict.why, /one\/projects\//);
  assert.match(conflict.why, /two\/projects\//);
  assert.match(run.message, /two source records claim this id/);

  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq, 'a refused import writes no event');
  assert.ok(!after.board.projects.some((p) => p.id === id), 'neither name may land');
  assert.equal(archives().length, beforeArchives, 'a refused import writes no archive');
});

test('two folders claiming one project id are refused', async () => {
  const before = await snapshot();
  const id = 'proj-1780057127097-two';

  const run = await command('vault.import', {
    source: { root: join(root, 'declared-vault'), origin: 'vault:test' },
    files: [],
    folders: [
      { id, path: join(root, 'declared-vault', 'a', id) },
      { id, path: join(root, 'declared-vault', 'b', id) },
    ],
  });

  assert.equal(run.ok, false, JSON.stringify(run));
  assert.equal(run.code, 'VAULT_ID_CONFLICT');
  assert.match(run.details.conflicts[0].why, /two source folders claim this id/);

  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq);
  assert.ok(!after.board.projects.some((p) => p.id === id));
});

test('a folder and its own record are the expected pairing, and consistent duplicates are not collisions', async () => {
  const id = 'proj-1780057127098-pair';
  const folderPath = join(root, 'declared-vault', 'projects', id);

  const run = await command('vault.import', {
    source: { root: join(root, 'declared-vault'), origin: 'vault:test' },
    // The same folder twice, and the same record twice: idempotent duplicates, which
    // say nothing new rather than contradicting anything.
    folders: [{ id, path: folderPath }, { id, path: folderPath }],
    files: [
      { path: 'projects/' + id + '/index.md', bytes: projectDoc(id, 'Paired') },
      { path: 'projects/' + id + '/index.md', bytes: projectDoc(id, 'Paired') },
    ],
  });

  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.value.projects.created, 1);
  assert.equal(run.value.projects.linked, 1);
  assert.equal(run.value.projects.skipped, 0);

  const after = await snapshot();
  const row = after.board.projects.find((p) => p.id === id);
  assert.equal(row.name, 'Paired', 'the record names the project');
  assert.equal(row.link.path, folderPath, 'the folder says where it is');
});

test('a settings entry that exists but cannot be resolved is refused, read nowhere, and sent nowhere', async () => {
  const before = await snapshot();
  const beforeArchives = archives().length;

  const v = vault();
  // An ordinary record of the vault's own, so "refused" cannot be confused with
  // "imported nothing": if the import ran at all, this file would land.
  writeEvent(v, 'event-1780320243795-uuuuu', {});

  // The settings entry is a normal, readable file naming the vault's own folders. What
  // is broken is establishing WHAT it is — injected as an EPERM from realpathSync.native,
  // which is what a denied ancestor or a broken reparse point looks like from here.
  const settingsPath = join(v.dir, '.obsidian', 'plugins', 'proxima', 'data.json');
  const logPath = join(root, 'settings-fault.log');
  const run = clientWatched({
    PROXIMA_TEST_HOOK_LOG: logPath,
    PROXIMA_TEST_REALPATH_FAULT: settingsPath,
    PROXIMA_TEST_WATCHED: 'proxima-client.mjs',
  }, 'vault', 'import', v.dir);

  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];
  const reads = log.filter((line) => line.startsWith('readFileSync '));
  const fetches = log.filter((line) => line.startsWith('fetch '));

  assert.ok(log.includes('preload installed'), 'the watcher must have been running: ' + JSON.stringify(log));
  assert.ok(log.some((line) => line.startsWith('realpath-fault ')),
    'the fault must have been injected, or this proves nothing: ' + JSON.stringify(log));
  assert.equal(run.status, 2, 'an unresolvable settings entry must fail closed: ' + run.output);
  assert.match(run.output, /plugin settings entry/);
  assert.match(run.output, /cannot be resolved/);
  assert.equal(reads.filter((line) => line.includes('settings') || line.includes('data.json')).length, 0,
    'the unverified pathname must never be read: ' + JSON.stringify(reads));
  assert.equal(reads.length, 0, 'nothing at all may be read after the refusal: ' + JSON.stringify(reads));
  assert.equal(fetches.length, 0, 'no request may reach the service: ' + JSON.stringify(fetches));

  // And the state of the world agrees with the log.
  assert.equal(archives().length, beforeArchives, 'no archive may be written');
  const after = await snapshot();
  assert.equal(after.headSeq, before.headSeq, 'no event may be written');
  assert.ok(!after.board.schedule.some((e) => e.id === 'event-1780320243795-uuuuu'),
    'the import must not have run at all');
});
