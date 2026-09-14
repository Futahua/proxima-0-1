#!/usr/bin/env node
/*
 * A Proxima client with no browser in it.
 *
 * This exists because "an agent can work headlessly" is the entire point of the
 * service, and a claim like that should be provable by running it. It is also the
 * smallest honest example of the protocol: read the token the service wrote, take a
 * snapshot, send commands, subscribe to events.
 *
 *   node proxima-client.mjs health
 *   node proxima-client.mjs snapshot
 *   node proxima-client.mjs events [afterSeq]        (streams until interrupted)
 *   node proxima-client.mjs create "<name>" [--project id] [--deadline YYYY-MM-DD]
 *   node proxima-client.mjs patch <taskId> <field> <value>
 *   node proxima-client.mjs move <taskId> <status> [beforeTaskId]
 *   node proxima-client.mjs delete <taskId>
 *   node proxima-client.mjs lock <YYYY-MM-DDTHH:MM> <taskId>... 
 *   node proxima-client.mjs unlock
 *   node proxima-client.mjs raw <type> '<json payload>'
 *
 * Options: --url http://127.0.0.1:4181 --token <token> --home <data home> --json
 *
 * The actor is `agent:headless` unless --actor says otherwise, and the client id
 * is `client:node` — which is the whole difference between this and a cockpit as
 * far as the service is concerned. Nothing here knows what a board looks like.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = { url: process.env.PROXIMA_URL || 'http://127.0.0.1:4181', token: null, home: null, actor: 'agent:headless', json: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url') flags.url = argv[++i];
  else if (a === '--token') flags.token = argv[++i];
  else if (a === '--home') flags.home = argv[++i];
  else if (a === '--actor') flags.actor = argv[++i];
  else if (a === '--json') flags.json = true;
  else positional.push(a);
}

const [command, ...rest] = positional;

function token() {
  if (flags.token) return flags.token;
  if (process.env.PROXIMA_TOKEN) return process.env.PROXIMA_TOKEN;
  const home = resolve(flags.home || process.env.PROXIMA_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', 'Proxima Data Home'));
  const path = join(home, 'token');
  if (!existsSync(path)) {
    console.error('No token at ' + path + '. Start proximad first, or pass --token/--home.');
    process.exit(2);
  }
  return readFileSync(path, 'utf8').trim();
}

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
  type, payload, commandId: (extra && extra.commandId) || id(),
  ...(extra && extra.ifRev !== undefined ? { ifRev: extra.ifRev } : {}),
  actor: flags.actor, client: 'client:node',
});

async function main() {
  switch (command) {
    case 'health': return show((await api('GET', '/v1/health')).body);

    case 'snapshot': {
      const { body } = await api('GET', '/v1/snapshot');
      if (flags.json) return show(body);
      const board = body.board;
      console.log('schema v' + body.schemaVersion + ' · head seq ' + body.headSeq + ' · instance ' + body.instanceId);
      console.log(board.projects.length + ' projects, ' + board.tasks.length + ' tasks, run: ' +
        (board.run ? 'locked since ' + board.run.lockedAt + ' (' + board.run.members.length + ' members)' : 'none'));
      board.tasks.forEach((t) => console.log('  ' + t.id + '  ' + t.status.padEnd(8) + ' w' + String(t.weight).padEnd(3) + ' ' +
        (t.start || '') + ' → ' + (t.deadline || '—') + '  ' + t.name));
      return undefined;
    }

    case 'events': {
      const after = Number(rest[0] || 0);
      const controller = new AbortController();
      const response = await fetch(flags.url + '/v1/events?after=' + after, {
        headers: { Authorization: 'Bearer ' + token(), Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (response.status !== 200) { show(await response.json()); return undefined; }
      console.log('subscribed after ' + after + '; ctrl-c to stop');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      process.on('SIGINT', () => { controller.abort(); process.exit(0); });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
          if (data) console.log(data);
        }
      }
      return undefined;
    }

    case 'create': {
      const name = rest[0];
      if (!name) throw new Error('create needs a name');
      const payload = { name };
      for (let i = 1; i < rest.length; i += 2) {
        const key = rest[i].replace(/^--/, '');
        payload[key] = rest[i + 1];
      }
      const { body } = await send('task.create', payload);
      show(body);
      return undefined;
    }

    case 'patch': {
      const [taskId, field, value] = rest;
      if (!taskId || !field) throw new Error('patch needs <taskId> <field> <value>');
      const parsed = field === 'weight' ? Number(value) : value;
      const { body } = await send('task.patch', { taskId, patch: { [field]: parsed } });
      show(body);
      return undefined;
    }

    case 'move': {
      const [taskId, toStatus, beforeTaskId] = rest;
      const { body } = await send('task.move', { taskId, toStatus, beforeTaskId: beforeTaskId || null });
      show(body);
      return undefined;
    }

    case 'delete': {
      const { body } = await send('task.delete', { taskId: rest[0] });
      show(body);
      return undefined;
    }

    case 'lock': {
      const [target, ...taskIds] = rest;
      const { body } = await send('run.lock', { target, taskIds });
      show(body);
      return undefined;
    }

    case 'unlock': {
      const { body } = await send('run.unlock', {});
      show(body);
      return undefined;
    }

    case 'raw': {
      const [type, json] = rest;
      const { body } = await send(type, json ? JSON.parse(json) : {});
      show(body);
      return undefined;
    }

    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*/, ''));
      return undefined;
  }
}

main().catch((error) => { console.error(String(error && error.message || error)); process.exit(1); });
