#!/usr/bin/env node
/*
 * proxima — the command line an agent works through.
 *
 * This is the entry point that makes "an agent can work headlessly" a fact rather
 * than a claim: everything the cockpit can do to a board, from a terminal, with no
 * browser anywhere. It is also the smallest honest description of the protocol —
 * read a token off disk, take a snapshot, send commands, read the log.
 *
 *   proxima whoami                                     which actor this shell is
 *   proxima list [--status backlog] [--project <id>]    the tasks, with who touched them
 *   proxima show <taskId>                               one task and its provenance
 *   proxima create "<name>" [--status running] [--project <id>] [--weight 3]
 *                           [--start 2026-09-14] [--deadline 2026-09-30] [--note "…"]
 *   proxima patch <taskId> <field> <value>              name|note|project|weight|start|deadline
 *   proxima move <taskId> <status> [beforeTaskId]
 *   proxima delete <taskId>                             recoverable — see undo
 *   proxima lock <YYYY-MM-DDTHH:MM> <taskId>...         freeze a run
 *   proxima unlock
 *   proxima log [--since <iso>] [--actor <actor>] [--limit 50] [--json]
 *   proxima activity [--hours 1]                        a human-readable diff, newest first
 *   proxima undo --actor agent:scout [--hours 1] [--dry-run]
 *   proxima agents [add <name>]                         list, or mint a credential
 *   proxima raw <type> '<json payload>'
 *
 * Options: --as <agent>, --url <url>, --home <dir>, --token <token>, --json
 *
 * The actor comes from WHICH TOKEN FILE IS READ, never from a flag: `--as scout`
 * reads <home>/agents/scout.token and the service decides who that is. A command
 * line is visible in the process table, so a token never appears on one.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = { url: process.env.PROXIMA_URL || 'http://127.0.0.1:4181', home: null, token: null, as: null, json: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url') flags.url = argv[++i];
  else if (a === '--home') flags.home = argv[++i];
  else if (a === '--token') flags.token = argv[++i];
  else if (a === '--as') flags.as = argv[++i];
  else if (a === '--json') flags.json = true;
  else positional.push(a);
}

const [command, ...rest] = positional;

const dataHome = () => resolve(flags.home || process.env.PROXIMA_HOME
  || join(process.env.USERPROFILE || process.env.HOME || '.', 'Proxima Data Home'));

function tokenPath() {
  if (flags.as) {
    const name = String(flags.as).replace(/^agent:/, '');
    const path = join(dataHome(), 'agents', name + '.token');
    if (!existsSync(path)) {
      console.error('No credential for agent “' + name + '” at ' + path + '.');
      console.error('Mint one with:  proxima agents add ' + name);
      process.exit(2);
    }
    return path;
  }
  const path = join(dataHome(), 'token');
  if (!existsSync(path)) {
    console.error('No operator token at ' + path + '. Start proximad first, or pass --home/--token.');
    process.exit(2);
  }
  return path;
}

function token() {
  if (flags.token) return flags.token;
  return readFileSync(tokenPath(), 'utf8').trim();
}

const tokenFile = () => (flags.token ? '(from --token)' : tokenPath());

async function api(method, path, body) {
  const response = await fetch(flags.url + path, {
    method,
    headers: { Authorization: 'Bearer ' + token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

const show = (value) => console.log(flags.json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
const id = () => 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const send = (type, payload, extra) => api('POST', '/v1/commands', {
  type,
  payload,
  commandId: (extra && extra.commandId) || id(),
  ...(extra && extra.ifRev !== undefined ? { ifRev: extra.ifRev } : {}),
  client: 'cli',
});

/** `create` takes its fields as flags; everything else is positional. */
function flagsOf(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { out[args[i].slice(2)] = args[i + 1]; i++; }
  }
  return out;
}
const bare = (args) => args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const ago = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
};

/** One line of English for one event, which is what makes the log readable. */
const describe = (event) => {
  const name = (event.after && event.after.name) || (event.before && event.before.name) || event.entity.id;
  switch (event.type) {
    case 'task.create': return 'created “' + name + '”';
    case 'task.delete': return 'deleted “' + name + '”';
    case 'task.patch': {
      const pairs = Object.keys(event.after || {}).map((f) =>
        f + ' ' + JSON.stringify(event.before ? event.before[f] : null) + ' → ' + JSON.stringify(event.after[f]));
      return 'changed “' + name + '”: ' + pairs.join(', ');
    }
    case 'task.move': return 'moved “' + name + '” to ' + (event.after && event.after.status);
    case 'task.layout': return 'repacked ' + Object.keys(event.after || {}).length + ' timeline row(s)';
    case 'project.create': return 'created project “' + name + '”';
    case 'project.delete': return 'deleted project “' + name + '”';
    case 'project.archive': return 'archived “' + name + '”';
    case 'project.restore': return 'restored “' + name + '”';
    case 'run.lock': return 'locked a run' + (event.after && event.after.memberIds ? ' with ' + event.after.memberIds.length + ' tasks' : '');
    case 'run.unlock': return 'ended the run';
    case 'history.revert': return 'reverted ' + ((event.after && event.after.reverted) ? event.after.reverted.length : 0) + ' change(s)';
    default: return event.type;
  }
};

async function main() {
  const f = flagsOf(rest);
  switch (command) {
    case 'whoami': {
      const health = await api('GET', '/v1/health');
      console.log('service   ' + flags.url + (health.body && health.body.ok ? ' (up, head seq ' + health.body.headSeq + ')' : ' (not answering)'));
      console.log('token     ' + tokenFile());
      console.log('actor     ' + (flags.as ? 'agent:' + String(flags.as).replace(/^agent:/, '') : 'human:minh (operator)'));
      console.log('data home ' + dataHome());
      return undefined;
    }

    case 'list': {
      const { body } = await api('GET', '/v1/snapshot');
      let tasks = body.board.tasks;
      if (f.status) tasks = tasks.filter((t) => t.status === f.status);
      if (f.project) tasks = tasks.filter((t) => t.project === f.project);
      if (flags.json) { show({ headSeq: body.headSeq, tasks, attribution: body.board.attribution }); return undefined; }
      console.log('head seq ' + body.headSeq + ' · ' + body.board.projects.length + ' projects · ' + body.board.tasks.length + ' tasks' +
        (body.board.run ? ' · run locked ' + ago(body.board.run.lockedAt) : ''));
      for (const t of tasks) {
        const who = body.board.attribution['task:' + t.id] || {};
        console.log('  ' + t.id + '  ' + t.status.padEnd(8) + ' w' + String(t.weight).padEnd(3) + ' ' +
          String(t.start || '').padEnd(10) + ' → ' + String(t.deadline || '—').padEnd(10) + ' ' + t.name +
          (who.lastActor ? '   [' + who.lastActor + ', ' + ago(who.lastAt) + ']' : ''));
      }
      return undefined;
    }

    case 'show': {
      const { body } = await api('GET', '/v1/snapshot');
      const task = body.board.tasks.find((t) => t.id === rest[0]);
      if (!task) { console.error('No task ' + rest[0]); process.exit(1); }
      const who = body.board.attribution['task:' + task.id] || {};
      if (flags.json) { show({ task, attribution: who }); return undefined; }
      Object.keys(task).forEach((k) => console.log(k.padEnd(12) + ' ' + JSON.stringify(task[k])));
      console.log('created by   ' + (who.createdBy || 'unknown'));
      console.log('last change  ' + (who.lastType || '?') + ' by ' + (who.lastActor || '?') + ' ' + (who.lastAt ? '(' + ago(who.lastAt) + ')' : ''));
      return undefined;
    }

    case 'create': {
      const name = bare(rest)[0];
      if (!name) throw new Error('create needs a name');
      const payload = { name };
      ['note', 'project', 'status', 'weight', 'start', 'deadline'].forEach((k) => {
        if (f[k] !== undefined) payload[k] = k === 'weight' ? Number(f[k]) : f[k];
      });
      const { body } = await send('task.create', payload);
      if (!body.ok) { show(body); process.exit(1); }
      if (flags.json) { show(body); return undefined; }
      console.log('created ' + body.value.id + '  ' + body.value.name + '  (rev ' + body.rev + ', seq ' + body.seq + ')');
      return undefined;
    }

    case 'patch': {
      const [taskId, field, ...valueParts] = bare(rest);
      const value = valueParts.join(' ');
      if (!taskId || !field) throw new Error('patch needs <taskId> <field> <value>');
      const { body } = await send('task.patch', { taskId, patch: { [field]: field === 'weight' ? Number(value) : value } });
      if (!body.ok) { show(body); process.exit(1); }
      if (flags.json) { show(body); return undefined; }
      console.log('patched ' + taskId + '  ' + field + ' → ' + JSON.stringify(body.value[field]) + '  (rev ' + body.rev + ')');
      return undefined;
    }

    case 'move': {
      const [taskId, toStatus, beforeTaskId] = bare(rest);
      const { body } = await send('task.move', { taskId, toStatus, beforeTaskId: beforeTaskId || null });
      if (!body.ok) { show(body); process.exit(1); }
      if (flags.json) { show(body); return undefined; }
      console.log('moved ' + taskId + ' to ' + body.value.status + (beforeTaskId ? ' before ' + beforeTaskId : ' (end of the column)'));
      return undefined;
    }

    case 'delete': {
      const taskId = bare(rest)[0];
      const { body } = await send('task.delete', { taskId });
      if (!body.ok) { show(body); process.exit(1); }
      if (flags.json) { show(body); return undefined; }
      console.log('deleted ' + taskId + ' — recoverable with:  proxima undo --actor ' +
        (flags.as ? 'agent:' + String(flags.as).replace(/^agent:/, '') : 'human:minh'));
      return undefined;
    }

    case 'lock': {
      const [target, ...taskIds] = bare(rest);
      const { body } = await send('run.lock', { target, taskIds });
      if (!body.ok) { show(body); process.exit(1); }
      if (flags.json) { show(body); return undefined; }
      console.log('locked a run to ' + body.value.target + ' with ' + body.value.members.length + ' task(s)');
      return undefined;
    }

    case 'unlock': {
      const { body } = await send('run.unlock', {});
      show(flags.json ? body : { ok: body.ok, changed: body.changed });
      return undefined;
    }

    case 'log':
    case 'activity': {
      const hours = Number(f.hours || 1);
      const since = f.since || new Date(Date.now() - hours * 3600 * 1000).toISOString();
      // Bounded by TIME at the service, not by "the first N events and then filter
      // here": `after=0&limit=100` returns the OLDEST hundred, so on a log longer
      // than the limit this would print "nothing since <time>" for a busy hour and
      // be wrong without ever failing.
      const { body } = await api('GET', '/v1/log?since=' + encodeURIComponent(since) +
        '&limit=' + (f.limit || 100) + (f.actor ? '&actor=' + encodeURIComponent(f.actor) : ''));
      const events = (body.events || []).reverse();
      if (flags.json) { show({ since, events }); return undefined; }
      if (!events.length) { console.log('Nothing since ' + since + '.'); return undefined; }
      console.log(events.length + ' change(s) since ' + since + ':');
      for (const e of events) {
        console.log('  ' + e.at.replace('T', ' ').slice(0, 19) + '  ' + String(e.actor).padEnd(18) + describe(e));
      }
      return undefined;
    }

    case 'undo': {
      if (!f.actor) throw new Error('undo needs --actor (for example --actor agent:scout). Reverting a whole board is not something this does.');
      const hours = Number(f.hours || 1);
      const payload = {
        actor: f.actor,
        since: f.since || new Date(Date.now() - hours * 3600 * 1000).toISOString(),
        until: f.until || new Date().toISOString(),
      };
      if (rest.includes('--dry-run') || f['dry-run'] !== undefined) payload.dryRun = true;
      const { body } = await send('history.revert', payload);
      if (!body.ok) { show(body); process.exit(1); }
      const report = body.value;
      if (flags.json) { show(body); return undefined; }
      console.log((report.reverted ? report.reverted.length : 0) + ' of ' + report.considered + ' change(s) by ' + report.actor + ' reverted' +
        (payload.dryRun ? '  (dry run — nothing was written)' : ''));
      (report.reverted || []).forEach((r) => console.log('  put back  ' + r.entity + '  (from seq ' + r.seq + ')'));
      report.conflicts.forEach((c) => console.log('  REFUSED   ' + c.entity + ' — ' + c.why + (c.fields ? ' [' + c.fields.join(', ') + ']' : '')));
      report.skipped.forEach((s) => console.log('  skipped   ' + s.entity + ' — ' + s.why));
      if (report.willRevert && !report.reverted) report.willRevert.forEach((w) => console.log('  would put back  ' + w.entity + '  (from seq ' + w.seq + ')'));
      return undefined;
    }

    case 'agents': {
      const [sub, name] = bare(rest);
      if (sub === 'add') {
        const { body } = await api('POST', '/v1/agents', { name });
        if (!body.ok) { show(body); process.exit(1); }
        console.log(body.message);
        console.log('It writes as ' + body.actor + '; every change it makes is attributed to that.');
        return undefined;
      }
      const { body } = await api('GET', '/v1/agents');
      if (flags.json) { show(body); return undefined; }
      if (!body.agents.length) { console.log('No agents yet. Mint one with:  proxima agents add scout'); return undefined; }
      body.agents.forEach((a) => console.log('  ' + String(a.actor).padEnd(24) + ' created ' + ago(a.createdAt) +
        (a.lastUsedAt ? ', last used ' + ago(a.lastUsedAt) : ', never used')));
      return undefined;
    }

    case 'raw': {
      const [type, json] = rest;
      const { body } = await send(type, json ? JSON.parse(json) : {});
      show(body);
      if (!body.ok) process.exit(1);
      return undefined;
    }

    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*/, ''));
      return undefined;
  }
}

main().catch((error) => { console.error(String((error && error.message) || error)); process.exit(1); });
