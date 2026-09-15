/*
 * The `--import` entry point for the settings-fault regression.
 *
 * Two things have to be in place before the client's module graph is evaluated: the
 * loader hooks (which rewrite the client's `node:fs` import) and the global fetch patch
 * (a bare `fetch(...)` is a global lookup, so it can be wrapped from here). The log line
 * each of them writes is the evidence the test reads afterwards.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(import.meta.filename);
const log = process.env.PROXIMA_TEST_HOOK_LOG;

const note = (line) => {
  if (!log) return;
  try { appendFileSync(log, line + '\n'); } catch { /* the test reads what it can */ }
};
globalThis.__proximaTestNote = note;

await register(pathToFileURL(join(here, 'settings-fault-hooks.mjs')).href);

const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  note('fetch ' + String(args[0]));
  return realFetch(...args);
};

note('preload installed');
