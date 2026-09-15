/*
 * archive-store — the exact bytes of anything that was imported, kept once each.
 *
 * An archive is the one thing an import writes unconditionally, before it has decided
 * anything: if the parse fails, if a record collides, if the transaction rolls back,
 * the bytes the service was handed are still on disk. That promise is only worth
 * something if the file it makes is really a new file.
 *
 * The name used to be `<origin>-<YYYYMMDD-HHMMSS>.json`, which is not unique: two
 * imports of the same origin inside one second — a retry after a failure, or two
 * commands in the same tick — produced the same name, and the second write silently
 * replaced the first. The archive you were counting on was gone, and nothing said so.
 *
 * A name now carries four independent things: the origin, the full instant including
 * milliseconds, the command that produced it (or a random nonce when there is none),
 * and the SHA-256 of the bytes. `wx` makes the create exclusive, so a name that is
 * somehow already taken fails instead of overwriting; the loop then takes a fresh
 * random nonce rather than trusting arithmetic to be unique. Collision-proof by
 * construction, and exclusive by syscall rather than by hope.
 */

import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ATTEMPTS = 8;

const pad = (value, width) => String(value).padStart(width, '0');

/** The full instant, to the millisecond: two archives in one second are not one. */
export function fullStamp(at) {
  const d = at instanceof Date ? at : new Date(at);
  return pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2)
    + '-' + pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2) + pad(d.getUTCSeconds(), 2)
    + '-' + pad(d.getUTCMilliseconds(), 3);
}

export const archiveSlug = (origin) => String(origin).replace(/[^a-z0-9]+/gi, '-')
  .replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown-origin';

/** A command id is client-supplied, so it is a guest in a filename: named, never trusted. */
export const archiveTag = (tag) => String(tag).replace(/[^a-z0-9]+/gi, '').slice(0, 24);

export function archiveName({ origin, at, sha256, nonce, tag }) {
  const parts = [archiveSlug(origin), fullStamp(at)];
  const label = archiveTag(tag || '');
  if (label) parts.push(label);
  parts.push(String(sha256).slice(0, 8), nonce);
  return parts.join('-') + '.json';
}

/**
 * Write one archive, exclusively, under a name nothing else can be holding.
 *
 * Returns what it wrote, including how many names were already taken — a non-zero
 * `attempts` is not a failure, it is the retry doing its job, and it is reported
 * rather than hidden.
 */
export function storeArchive(dir, options) {
  const origin = options.origin;
  const bytes = options.bytes;
  const at = options.at instanceof Date ? options.at : new Date(options.at === undefined ? Date.now() : options.at);
  const extra = options.extra || {};
  const tag = options.tag || '';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const taken = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // The first attempt may use a caller-supplied nonce — that is what makes a frozen
    // clock reproducible in a test. Every later attempt is random, because the whole
    // point of the retry is to stop guessing and start being unpredictable.
    const nonce = attempt === 0 && options.nonce ? String(options.nonce) : randomBytes(4).toString('hex');
    const name = archiveName({ origin, at, sha256, nonce, tag });
    const path = join(dir, name);
    try {
      writeFileSync(path, bytes, { flag: 'wx' });
    } catch (error) {
      if (error && error.code === 'EEXIST') { taken.push(name); continue; }
      throw error;
    }
    const metaName = name.replace(/\.json$/, '.meta.json');
    writeFileSync(join(dir, metaName), JSON.stringify({
      origin,
      at: at.toISOString(),
      bytes: Buffer.byteLength(bytes, 'utf8'),
      sha256,
      nonce,
      ...extra,
    }, null, 2), { flag: 'wx' });
    return { name, metaName, sha256, attempts: taken.length, taken };
  }

  throw new Error('archive name collision after ' + MAX_ATTEMPTS + ' attempts: ' + taken.join(', '));
}
