// Drive the REAL Proxima cockpit inside a REAL Papers, through the local-service
// bridge, and report what the page shows.
//
// THIS ONE RUNS OUT OF PROCESS AND IS THEREFORE PARTLY BLIND: it loads the project's
// own `public/index.html` from `papers-backpack://<projectId>` in a Papers built at the
// bridge commit, which proves what the POLICY lets a backpack page do — and which is
// how the policy banner was first reproduced. It cannot exercise the bridge itself: a
// window Papers did not create is refused by its main process with *"host channel
// called from non-host sender"*, and it waits for the surface to be authorised before
// it answers. For the bridge, use `papers-cockpit-cdp.mjs`, which opens the surface
// through Papers' own `papersHost.backpackProject.open(id)`.
//
//   electron papers-cockpit-probe.mjs
//     PROBE_OUT          file to write the log to
//     PROBE_APP_ROOT     Papers checkout whose out/main/index.js is loaded
//     PROBE_PROJECT      the backpack project directory (holds project.json)
//     PROBE_PROJECT_ID   the backpack id the page is served under
import { app, BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = process.env['PROBE_OUT'];
const APP_ROOT = process.env['PROBE_APP_ROOT'];
const PROJECT = process.env['PROBE_PROJECT'];
const PROJECT_ID = process.env['PROBE_PROJECT_ID'];
const log = [];
const say = (line) => { log.push(line); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // The real Papers main first: the protocol handler, the scheme privileges and the
  // bridge all live there, and none of them can be faked from outside.
  await import('file://' + path.join(APP_ROOT, 'out', 'main', 'index.js').replace(/\\/g, '/'));
  await app.whenReady();
  await sleep(2500);
  say('real Papers main loaded; bridge commit build');

  const declared = JSON.parse(fs.readFileSync(path.join(PROJECT, 'local-service.json'), 'utf8'));
  say('declaration: ' + JSON.stringify(declared.services) +
    ' secret file=' + (declared.secrets && declared.secrets[0] ? declared.secrets[0].file : '(none)'));

  // The same webPreferences Papers gives a bound project surface: without the
  // preload there is no bridge to postMessage to, and the page would fall back to a
  // fetch — which is a different experiment, not this one.
  const surface = {
    preload: path.join(APP_ROOT, 'out', 'preload', 'backpackProject.cjs'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
  };
  say('surface preload: ' + surface.preload + ' (exists: ' + fs.existsSync(surface.preload) + ')');

  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: surface });
  const console_ = [];
  win.webContents.on('console-message', (_e, _level, message) => console_.push(String(message).slice(0, 300)));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => say('  [load failed] ' + code + ' ' + desc + ' ' + url));

  const url = 'papers-backpack://' + PROJECT_ID + '/public/index.html';
  say('loading ' + url);
  await win.loadURL(url);
  await sleep(6000);

  const read = async (expression) => {
    try { return await win.webContents.executeJavaScript(expression); }
    catch (error) { return { error: String(error && error.message ? error.message : error) }; }
  };

  const banner = await read("(() => { const b = document.querySelector('#serviceBanner'); return b ? { hidden: b.hidden, text: b.textContent } : null; })()");
  const status = await read('(() => { try { return Store.loadStatus(); } catch (e) { return String(e); } })()');
  const board = await read("(() => ({ cards: document.querySelectorAll('#columns .card').length, tasks: (window.Store ? Store.tasks().length : 0), head: (window.Store ? Store.headSeq() : null), first: Array.from(document.querySelectorAll('#columns .card h4')).slice(0,3).map(h => h.textContent) }))()");
  const empty = await read("(() => Array.from(document.querySelectorAll('.cards .empty, .tk-empty')).map(e => e.textContent).slice(0,2))()");

  say('');
  say('=== what the page shows ===');
  say('banner.hidden : ' + (banner && banner.hidden));
  say('banner.text   : ' + (banner ? banner.text : '(no banner element)'));
  say('loadStatus    : ' + JSON.stringify(status));
  say('board         : ' + JSON.stringify(board));
  say('empty notes   : ' + JSON.stringify(empty));
  if (console_.length) {
    say('');
    say('=== page console (first 8) ===');
    console_.slice(0, 8).forEach((line) => say('  ' + line));
  }

  say('');
  say('=== summary ===');
  say('  page origin                : ' + await read('location.origin'));
  say('  transport                  : ' + (status && status.transport));
  say('  bridge answered            : ' + (status && status.bridgeState));
  say('  board rendered from service: ' + Boolean(board && board.cards > 0));
  say('  head sequence read         : ' + (board && board.head));
  say('  banner shown               : ' + Boolean(banner && !banner.hidden));

  fs.writeFileSync(OUT, log.join('\n'), 'utf8');
  app.exit(0);
}

main().catch((error) => {
  say('PROBE FAILED: ' + (error && error.stack ? error.stack : error));
  try { fs.writeFileSync(OUT, log.join('\n'), 'utf8'); } catch { /* nothing to write to */ }
  app.exit(1);
});
