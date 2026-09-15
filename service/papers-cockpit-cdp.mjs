// Drive the REAL cockpit inside the REAL Papers, through CDP, with the surface
// created by Papers itself.
//
// A window made from outside cannot use the bridge: the main process refuses any
// sender that is not one of its own registered project surfaces ("host channel called
// from non-host sender"), and it waits for the surface to be authorised before it
// answers. Faking that would prove nothing. So this drives Papers the way the creator
// does — `papersHost.backpackProject.open(id)` in the host window — and then reads the
// project surface's own DOM.
//
//   node papers-cockpit-cdp.mjs <cdpPort> <projectId> <label>
//
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.argv[2]);
const PROJECT_ID = process.argv[3];
const LABEL = process.argv[4] || PROJECT_ID;

const list = async () => {
  const response = await fetch('http://127.0.0.1:' + PORT + '/json/list');
  return response.json();
};

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', (event) => reject(new Error('cdp connect failed: ' + (event.message || 'error'))), { once: true });
  });
}

let messageId = 0;
function send(socket, method, params) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let parsed = null;
      try { parsed = JSON.parse(event.data); } catch { return; }
      if (!parsed || parsed.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (parsed.error) reject(new Error(method + ': ' + JSON.stringify(parsed.error)));
      else resolve(parsed.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(socket, expression) {
  const result = await send(socket, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    return { error: String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'threw') };
  }
  return result.result ? result.result.value : undefined;
}

async function targetFor(match, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const found = (await list()).find((t) => match(t));
    if (found) return found;
    await sleep(500);
  }
  return null;
}

const surfaceUrl = (t) => String(t.url || '').startsWith('papers-backpack://' + PROJECT_ID + '/');
const hostUrl = (t) => String(t.url || '').includes('/out/renderer/index.html');

async function main() {
  const host = await targetFor(hostUrl);
  if (!host) throw new Error('no Papers host window on the debugging port');
  console.log('host window : ' + host.url);

  const hostSocket = await connect(host.webSocketDebuggerUrl);
  const opened = await evaluate(hostSocket, `window.papersHost.backpackProject.open(${JSON.stringify(PROJECT_ID)})`);
  console.log('open()      : ' + JSON.stringify(opened));

  const surface = await targetFor(surfaceUrl);
  if (!surface) throw new Error('the project surface never appeared: ' + JSON.stringify((await list()).map((t) => t.url)));
  console.log('surface     : ' + surface.url);

  const socket = await connect(surface.webSocketDebuggerUrl);
  // An extra query on the page URL, for pointing one project copy at a different
  // declared origin (the page honours `?api=`). Navigating rather than reopening keeps
  // the surface Papers itself created.
  const append = process.env['PROBE_APPEND_QUERY'];
  if (append) {
    const target = surface.url + (surface.url.includes('?') ? '&' : '?') + append;
    console.log('navigating  : ' + target);
    await send(socket, 'Page.enable', {});
    await send(socket, 'Page.navigate', { url: target });
    await sleep(2000);
  }
  // Give the cockpit its boot (bridge probe, snapshot, first render).
  await sleep(7000);

  const read = async (expression) => {
    const value = await evaluate(socket, expression);
    return value;
  };

  // An action to run inside the page before the report — how a WRITE is driven end to
  // end through the bridge rather than only read.
  const action = process.env['PROBE_EVAL'];
  if (action) {
    console.log('');
    console.log('=== action ===');
    console.log(JSON.stringify(await read(action), null, 2));
  }

  const report = await read(`(() => {
    const banner = document.querySelector('#serviceBanner');
    let status = null;
    try { status = Store.loadStatus(); } catch (error) { status = { error: String(error && error.message || error) }; }
    return {
      origin: location.origin,
      bannerShown: banner ? !banner.hidden : null,
      bannerText: banner ? banner.textContent : null,
      status: status,
      cards: document.querySelectorAll('#columns .card').length,
      taskCount: document.querySelector('#taskCount') ? document.querySelector('#taskCount').textContent : null,
      headSeq: (() => { try { return Store.headSeq(); } catch { return null; } })(),
      titles: Array.from(document.querySelectorAll('#columns .card h4')).slice(0, 3).map((h) => h.textContent),
    };
  })()`);

  console.log('');
  console.log('=== ' + LABEL + ' ===');
  console.log('origin        : ' + report.origin);
  console.log('banner shown  : ' + report.bannerShown);
  console.log('banner text   : ' + report.bannerText);
  console.log('transport     : ' + (report.status && report.status.transport) + '  bridge=' + (report.status && report.status.bridgeState));
  console.log('status detail : ' + (report.status && (report.status.detail || report.status.bridgeDetail)));
  console.log('cards         : ' + report.cards + '   (' + report.taskCount + ')');
  console.log('head sequence : ' + report.headSeq);
  console.log('first titles  : ' + JSON.stringify(report.titles));

  socket.close();
  hostSocket.close();
  console.log('');
  console.log('VERDICT board-rendered=' + (report.cards > 0) + ' banner-shown=' + report.bannerShown);
}

main().then(() => process.exit(0)).catch((error) => {
  console.log('DRIVER FAILED: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
