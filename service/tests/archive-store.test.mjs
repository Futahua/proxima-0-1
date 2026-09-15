/*
 * Regressions for archive-store.
 *
 * The bug these pin down: archive names were `<origin>-<YYYYMMDD-HHMMSS>.json` and the
 * write was an ordinary one, so two archives of the same origin inside one second
 * silently became one file — the second import replaced the bytes of the first, and
 * nothing anywhere said so. An archive is what an import promises to keep; it is not
 * allowed to be the thing that quietly disappears.
 *
 * Run: node --test  (or: node --test "service/tests/*.test.mjs")
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveName, fullStamp, storeArchive } from '../archive-store.mjs';

const FROZEN = new Date('2026-09-15T14:14:32.123Z');
const ORIGIN = 'vault:D/Letters/MatTroiSeConMoc/vault-copy-20260913';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const freshDir = () => mkdtempSync(join(tmpdir(), 'proxima-archive-test-'));
const archivesIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')).sort();
const metasIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.meta.json')).sort();

test('frozen time, same origin, different payload: both archives survive', () => {
  const dir = freshDir();
  try {
    // Every variable that could tell these two apart is held identical except the
    // bytes: the instant, the origin, the command, even the nonce. Only the content
    // hash is left to keep them apart, which is exactly what it is in the name for.
    const first = storeArchive(dir, { origin: ORIGIN, bytes: '{"import":1}', at: FROZEN, tag: 'cmd_abc123', nonce: 'aaaa1111' });
    const second = storeArchive(dir, { origin: ORIGIN, bytes: '{"import":2}', at: FROZEN, tag: 'cmd_abc123', nonce: 'aaaa1111' });

    assert.notEqual(first.name, second.name, 'two payloads in the same millisecond must not share a name');
    assert.match(first.name, /-20260915-141432-123-/);
    assert.match(second.name, /-20260915-141432-123-/);
    assert.ok(first.name.includes(sha256('{"import":1}').slice(0, 8)));
    assert.ok(second.name.includes(sha256('{"import":2}').slice(0, 8)));

    const kept = archivesIn(dir);
    assert.equal(kept.length, 2, 'both archives must be on disk');
    assert.deepEqual(kept, [first.name, second.name].sort());
    assert.equal(readFileSync(join(dir, first.name), 'utf8'), '{"import":1}');
    assert.equal(readFileSync(join(dir, second.name), 'utf8'), '{"import":2}');
    assert.equal(metasIn(dir).length, 2, 'each archive keeps its own meta');
    assert.equal(first.attempts, 0);
    assert.equal(second.attempts, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('identical payload, identical name: exclusive create refuses, then retries', () => {
  const dir = freshDir();
  try {
    const bytes = '{"same":"bytes"}';
    const first = storeArchive(dir, { origin: ORIGIN, bytes, at: FROZEN, tag: 'cmd_abc123', nonce: 'deadbeef' });
    const second = storeArchive(dir, { origin: ORIGIN, bytes, at: FROZEN, tag: 'cmd_abc123', nonce: 'deadbeef' });

    assert.notEqual(first.name, second.name, 'the second archive must not take the first one’s name');
    assert.equal(second.attempts, 1, 'the collision must be visible as a retry, not hidden');
    assert.deepEqual(second.taken, [first.name]);
    assert.equal(archivesIn(dir).length, 2);
    assert.equal(readFileSync(join(dir, first.name), 'utf8'), bytes);
    assert.equal(readFileSync(join(dir, second.name), 'utf8'), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file already sitting at the chosen name is never overwritten', () => {
  const dir = freshDir();
  try {
    const bytes = '{"mine":true}';
    const collided = archiveName({ origin: ORIGIN, at: FROZEN, sha256: sha256(bytes), nonce: 'cafebabe', tag: 'cmd_abc123' });
    writeFileSync(join(dir, collided), 'SOMEBODY ELSE WAS HERE');

    const stored = storeArchive(dir, { origin: ORIGIN, bytes, at: FROZEN, tag: 'cmd_abc123', nonce: 'cafebabe' });

    assert.equal(stored.attempts, 1);
    assert.notEqual(stored.name, collided);
    assert.equal(readFileSync(join(dir, collided), 'utf8'), 'SOMEBODY ELSE WAS HERE', 'the existing file must be untouched');
    assert.equal(readFileSync(join(dir, stored.name), 'utf8'), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the name carries the full instant, to the millisecond', () => {
  const base = { origin: 'vault:x', sha256: sha256('a'), nonce: 'ff00ff00', tag: 'cmd_1' };
  const one = archiveName({ ...base, at: new Date('2026-09-15T14:14:32.123Z') });
  const two = archiveName({ ...base, at: new Date('2026-09-15T14:14:32.124Z') });
  const later = archiveName({ ...base, at: new Date('2026-09-15T14:14:33.123Z') });

  assert.notEqual(one, two, 'one millisecond apart is not the same archive');
  assert.notEqual(one, later, 'one second apart is not the same archive');
  assert.equal(fullStamp(new Date('2026-09-15T14:14:32.007Z')), '20260915-141432-007');
  assert.match(one, /^vault-x-20260915-141432-123-cmd1-/);
});
