#!/usr/bin/env node
/*
 * A probe, not a product: serve the cockpit exactly the way Papers serves a backpack
 * project, so the refusal can be reproduced instead of argued about.
 *
 * Papers' own protocol handler answers every asset under `papers-backpack://<id>` with
 * this header (App/resources/app.asar, installBackpackProjectProtocol):
 *
 *   default-src 'none'; script-src <origin>; style-src <origin> 'unsafe-inline';
 *   img-src <origin> data:; font-src <origin>; connect-src 'none'; object-src 'none';
 *   base-uri 'none'; form-action 'none'; frame-src 'none'
 *
 * and the scheme is registered with `corsEnabled: false`. A document under that policy
 * cannot open a connection to anything, so "can the cockpit reach 127.0.0.1:4181 from
 * Papers" is answered before CORS, cookies or --allow-origin are consulted at all.
 *
 *   node service/papers-csp-probe.mjs [--port 4182] [--no-csp]
 *
 * --no-csp serves the identical bytes with no policy header, which is the control: it
 * shows the files and the service are fine and the policy is the whole difference.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COCKPIT = join(HERE, '..', 'public');
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4182;
const withCsp = !args.includes('--no-csp');
const ORIGIN = 'http://127.0.0.1:' + port;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

/** Papers' policy, verbatim in shape: the origin is the scheme+host it is served from. */
const papersPolicy = (origin) => [
  "default-src 'none'",
  'script-src ' + origin,
  "style-src " + origin + " 'unsafe-inline'",
  'img-src ' + origin + ' data:',
  'font-src ' + origin,
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(COCKPIT, path));
  if (!file.startsWith(COCKPIT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no such file');
    return;
  }
  const headers = { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' };
  // Exactly as Papers does it: the policy travels with every asset it serves.
  if (withCsp) headers['Content-Security-Policy'] = papersPolicy(ORIGIN);
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => {
  console.log('[probe] ' + ORIGIN + '/  ' + (withCsp
    ? "with Papers' backpack policy (connect-src 'none')"
    : 'with NO policy header (the control)'));
});
