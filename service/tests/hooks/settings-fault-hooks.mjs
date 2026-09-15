/*
 * A fault injector for the vault client, and a record of what the client touched.
 *
 * WHY THIS EXISTS. The fail-open path being pinned down here is "the settings entry
 * exists, its identity cannot be resolved, and the client reads the unverified pathname
 * anyway". There is no ordinary file on a real disk that is readable while its own
 * realpath fails, and no way to observe a read that does not happen by looking at the
 * filesystem afterwards. So the client is run with this module loaded, which:
 *
 *   - makes `realpathSync.native(<the settings entry>)` throw, exactly as a broken
 *     junction or a denied ancestor would, while leaving the file itself readable;
 *   - records every `readFileSync` and every `fetch` the client performs.
 *
 * The PRODUCT is not modified and knows nothing about this: the client is started the way
 * a person starts it, with `--import` pointing here. What the test then asserts is the
 * absence of a line in the log — the settings entry was never read, and no request was
 * ever sent.
 *
 * Loaded through service/tests/hooks/settings-fault-preload.mjs, which registers the
 * hook module below and patches the global fetch, because a bare `fetch(...)` call is a
 * global lookup while `readFileSync` is an import binding that only a loader can replace.
 */

const WATCHED = process.env.PROXIMA_TEST_WATCHED || 'proxima-client.mjs';
const FAULT = process.env.PROXIMA_TEST_REALPATH_FAULT || '';

// The module the client's own `node:fs` import is rewritten to. It re-exports the real
// builtin and wraps the two calls worth watching; everything else passes through whole.
const WRAPPER = `
import * as real from 'node:fs';
const note = globalThis.__proximaTestNote || (() => {});
export * from 'node:fs';
export function readFileSync(path, ...rest) {
  note('readFileSync ' + String(path));
  return real.readFileSync(path, ...rest);
}
const realpath = (path, ...rest) => real.realpathSync(path, ...rest);
realpath.native = (path, ...rest) => {
  const target = String(path);
  if (${JSON.stringify(FAULT)} && target.toLowerCase() === ${JSON.stringify(String(FAULT).toLowerCase())}) {
    note('realpath-fault ' + target);
    const error = new Error('EPERM: injected identity-resolution failure for ' + target);
    error.code = 'EPERM';
    throw error;
  }
  note('realpathSync.native ' + target);
  return real.realpathSync.native(path, ...rest);
};
export { realpath as realpathSync };
`;

export async function resolve(specifier, context, next) {
  // Only the module under test is rewritten. The wrapper's own `node:fs` import comes
  // from a different parent, so it is left alone — no recursion, no double wrapping.
  if (specifier === 'node:fs' && String(context.parentURL || '').includes(WATCHED)) {
    return { url: 'proxima-fs-watch:', shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === 'proxima-fs-watch:') return { format: 'module', shortCircuit: true, source: WRAPPER };
  return next(url, context);
}
