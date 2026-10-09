/*
 * Proxima project surface.
 *
 * This is intentionally a host/controller, not another canvas implementation.
 * The child is the real As you Go surface. Its document, commands, graph
 * layout, undo history and persistence remain owned by As you Go; this shell
 * only asks Papers for the authorized project binding and relays the child's
 * bounded host messages through the already-authorized Proxima frame.
 */
const HOST_RESULT = 'papers:host:result';
const PROJECT_PUSH_PREFIX = 'papers:project:';

let child = null;
let previewChild = null;
let previewShell = null;
let previewResizer = null;
let childOrigin = null;
let mountedProject = null;
let loadGeneration = 0;
let lastPreviewSelection = { mode: 'empty', selectionCount: 0, items: [] };
let previewReady = false;
let previewRepositionFrame = 0;
let unmountCleanup = Promise.resolve();
const parentRequests = new Map();
const childRequests = new Map();

function shell() {
  return document.querySelector('#projectWorkspaceSurface');
}

function messageTarget() {
  return window.location.origin || '*';
}

function projectOrigin(url) {
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

function parentRequest(type, detail = {}) {
  const requestId = crypto.randomUUID();
  window.parent.postMessage({ type, requestId, ...detail }, messageTarget());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      parentRequests.delete(requestId);
      reject(new Error('Papers did not provide the project workspace.'));
    }, 15000);
    parentRequests.set(requestId, { resolve, reject, timer });
  });
}

function finishParentRequest(message) {
  const pending = parentRequests.get(message.requestId);
  if (!pending) return false;
  parentRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.ok === false) pending.reject(new Error(message.error || 'The project workspace could not be opened.'));
  else pending.resolve(message.workspaceScope ?? null);
  return true;
}

function forwardToChild(message) {
  if (!child?.contentWindow) return;
  child.contentWindow.postMessage(message, childOrigin || '*');
}

function forwardPreviewSelection() {
  if (!previewReady || !previewChild?.contentWindow) return;
  previewChild.contentWindow.postMessage({
    type: 'papers:proxima-preview-selection',
    selection: lastPreviewSelection,
  }, childOrigin || '*');
}

function schedulePreviewReposition() {
  if (previewRepositionFrame) return;
  previewRepositionFrame = requestAnimationFrame(() => {
    previewRepositionFrame = 0;
    // The preview sticks while the canvas scrolls. Position the grab region
    // from its actual viewport box, never from a fixed canvas-top offset.
    const canvasBox = document.querySelector('#projectCanvas')?.getBoundingClientRect();
    const previewBox = previewShell?.getBoundingClientRect();
    if (previewResizer && canvasBox && previewBox) {
      previewResizer.style.top = Math.max(0, previewBox.top - canvasBox.top + 48) + 'px';
      previewResizer.style.height = Math.max(0, previewBox.height - 48) + 'px';
      previewResizer.style.bottom = 'auto';
    }
    previewChild?.contentWindow?.postMessage(
      { type: 'papers:proxima-preview-reposition' },
      childOrigin || '*',
    );
  });
}

function toggleEmbeddedLeftPane() {
  if (!child?.contentWindow) return false;
  child.contentWindow.postMessage({ type: 'papers:proxima-toggle-left-pane' }, childOrigin || '*');
  return true;
}

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.key !== 'Tab'
    || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
    || event.isComposing || event.repeat) return;
  if (!toggleEmbeddedLeftPane()) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

  if (child?.contentWindow && event.source === child.contentWindow) {
    if (childOrigin && event.origin !== childOrigin) return;
    if(message.type==='papers:proxima-lens-request'){previewChild?.contentWindow?.postMessage(message,childOrigin||'*');return;}
    if (['papers:proxima-preview-slice-drop','papers:proxima-document-tabs','papers:proxima-pinned-preview'].includes(message.type)) { if(message.type==='papers:proxima-document-tabs')previewShell?.classList.toggle('project-slice-maximized',Boolean(message.slices?.maximized&&!message.nativeViewport)); previewChild?.contentWindow?.postMessage(message,childOrigin||'*'); return; }
    if (message.type === 'papers:proxima-preview-selection') {
      lastPreviewSelection = message.selection ?? { mode: 'empty', selectionCount: 0, items: [] };
      forwardPreviewSelection();
      return;
    }
    // Papers' preload observes this child-origin message directly. The
    // Proxima shell records only the response route; it never forwards the
    // child request through the top-level Proxima authority.
    if (message.type.startsWith(PROJECT_PUSH_PREFIX) && typeof message.requestId === 'string') {
      childRequests.set(message.requestId, { frame: child, origin: childOrigin });
    }
    return;
  }
  if (previewChild?.contentWindow && event.source === previewChild.contentWindow) {
    if (childOrigin && event.origin !== childOrigin) return;
    if(message.type==='papers:proxima-slices-save')previewShell?.classList.toggle('project-slice-maximized',Boolean(message.slices?.maximized&&!message.nativeViewport));
    if (['papers:proxima-slices-save','papers:proxima-previews-save','papers:proxima-document-reorder','papers:proxima-document-select','papers:proxima-document-close','papers:proxima-native-selected'].includes(message.type)) { forwardToChild(message); return; }
    if (message.type === 'papers:proxima-toggle-left-pane-request') {
      toggleEmbeddedLeftPane();
      return;
    }
    if(message.type==='papers:proxima-preview-minimum-width'){
      const canvas=document.querySelector('#projectCanvas');if(!canvas||!previewShell||!Number.isFinite(message.width))return;
      const width=Math.min(Math.max(128,message.width),canvas.getBoundingClientRect().width-192);
      if(width>previewShell.getBoundingClientRect().width+2){canvas.style.setProperty('--project-preview-width',width+'px');schedulePreviewReposition();}return;
    }
    if (message.type === 'papers:proxima-preview-native-edge') {
      if (!Number.isFinite(message.x) || !previewShell) return;
      const canvas = document.querySelector('#projectCanvas');
      if (!canvas) return;
      const frame = previewChild.getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      // Native left edge owns the split. Keep the backdrop just inside it.
      // Keep native coordinates in the parent viewport. The iframe can move
      // between publishing this event and receiving it; adding its new offset
      // to an old local coordinate feeds that movement back into the split.
      const edge = (Number.isFinite(message.parentX) ? message.parentX : frame.left + message.x) + 1;
      const width = Math.max(1, Math.min(box.width, box.right - edge));
      if (Math.abs(previewShell.getBoundingClientRect().width - width) > 1) {
        canvas.style.setProperty('--project-preview-width', width + 'px');
        schedulePreviewReposition();
      }
      return;
    }
    if (message.type === 'papers:proxima-preview-ready') {
      previewReady = true;
      forwardPreviewSelection();
      schedulePreviewReposition();
      forwardToChild({type:'papers:proxima-window-surface-ready'});
      return;
    }
    if (message.type.startsWith(PROJECT_PUSH_PREFIX) && typeof message.requestId === 'string') {
      childRequests.set(message.requestId, { frame: previewChild, origin: childOrigin });
    }
    return;
  }

  // At the top level window.parent === window. Papers' preload answers both
  // requests made by this controller and requests relayed from the child.
  if (event.source !== window.parent && event.source !== window) return;
  if (message.type === 'papers:project:reserved-tab') {
    toggleEmbeddedLeftPane();
    return;
  }
  if (message.type === HOST_RESULT && typeof message.requestId === 'string') {
    if (finishParentRequest(message)) return;
    const target = childRequests.get(message.requestId);
    if (target) {
      childRequests.delete(message.requestId);
      target.frame?.contentWindow?.postMessage(message, target.origin || '*');
    }
    return;
  }
  if (message.type.startsWith(PROJECT_PUSH_PREFIX)) {forwardToChild(message);previewChild?.contentWindow?.postMessage(message,childOrigin||'*');}
});

function showMessage(text, tone = 'info') {
  const host = shell();
  if (!host) return;
  host.replaceChildren();
  const message = document.createElement('p');
  message.className = `project-workspace-message project-workspace-message-${tone}`;
  message.textContent = text;
  host.append(message);
}

function unmount() {
  loadGeneration += 1;
  const hadProjectSurface = Boolean(child || previewChild || previewShell || mountedProject);
  const retiringPreviewChild = previewChild;
  const retiringPreviewShell = previewShell;
  const retiringPreviewResizer = previewResizer;
  const retiringChildOrigin = childOrigin;
  if (child) child.remove();
  if (retiringPreviewResizer) retiringPreviewResizer.remove();
  if (retiringPreviewShell) retiringPreviewShell.hidden = true;
  child = null;
  previewChild = null;
  previewShell = null;
  previewResizer = null;
  childOrigin = null;
  previewReady = false;
  lastPreviewSelection = { mode: 'empty', selectionCount: 0, items: [] };
  if (previewRepositionFrame) cancelAnimationFrame(previewRepositionFrame);
  previewRepositionFrame = 0;
  mountedProject = null;
  for (const pending of parentRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Project workspace closed.'));
  }
  parentRequests.clear();
  childRequests.clear();
  if (!hadProjectSurface) return unmountCleanup;

  const retire = async () => {
    // Native browser tabs outlive DOM visibility. Hide them while the project
    // scope is still authorized, then tear down the sidecar and revoke scope.
    await Promise.race([
      Promise.allSettled([
        parentRequest('papers:project:file-capability', {
          operation: 'browser-download-bubble-hide',
          params: { immediate: true },
        }),
        parentRequest('papers:project:file-capability', {
          operation: 'chrome-pane-visible',
          params: { visible: false },
        }),
        parentRequest('papers:project:file-capability', {
          operation: 'browser-tabs-visible',
          params: { visible: false },
        }),
      ]),
      new Promise((resolve) => window.setTimeout(resolve, 1000)),
    ]);
    if (retiringPreviewChild?.contentWindow) {
      retiringPreviewChild.contentWindow.postMessage(
        { type: 'papers:proxima-preview-dispose' },
        retiringChildOrigin || '*',
      );
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    window.postMessage({ type: 'papers:project:workspace-scope-revoke' }, messageTarget());
    if (retiringPreviewShell?.isConnected) retiringPreviewShell.remove();
    else if (retiringPreviewChild?.isConnected) retiringPreviewChild.remove();
  };
  unmountCleanup = unmountCleanup.then(retire, retire);
  return unmountCleanup;
}

async function mount(project) {
  const cleanup = unmount();
  const generation = loadGeneration;
  await cleanup;
  if (generation !== loadGeneration) return;
  mountedProject = project;
  showMessage('Opening the As you Go project folder…');
  try {
    const scope = await parentRequest('papers:project:workspace-scope', {
      projectKey: project.id,
      projectName: project.name,
    });
    if (generation !== loadGeneration || mountedProject !== project) return;
    if (!scope?.url || !scope.rootGroupId) {
      showMessage('This project does not have an As you Go workspace binding.', 'error');
      return;
    }
    const url = new URL(scope.url);
    childOrigin = projectOrigin(url);
    url.searchParams.set('as-you-go-scope-root', scope.rootGroupId);
    url.searchParams.set('papers-embedded-surface', 'proxima');
    const parentKey=new URLSearchParams(window.location.search).get('papers-surface-key');
    if(parentKey)url.searchParams.set('papers-surface-key',`${parentKey}:project:${project.id}`);
    if(new URLSearchParams(window.location.search).get('papers-pane-legacy')==='1')url.searchParams.set('papers-pane-legacy','1');
    child = document.createElement('iframe');
    child.className = 'project-workspace-frame';
    child.title = `${project.name} — As you Go`;
    child.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    child.src = url.toString();

    // Project content scrolls on the left; the native window surface stays alongside it.
    const previewUrl=new URL(scope.url);
    previewUrl.pathname=previewUrl.pathname.replace(/workspace-20260730b\.html$/i,'proxima-preview.html');
    previewUrl.search='';previewUrl.searchParams.set('papers-embedded-surface','proxima-preview');
    previewChild=document.createElement('iframe');previewChild.className='project-preview-frame';
    previewChild.title=`${project.name} — Windows`;
    previewChild.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms');previewChild.src=previewUrl.toString();
    previewShell=document.createElement('aside');previewShell.className='project-preview-sidecar';
    previewShell.setAttribute('aria-label','Project windows');previewShell.append(previewChild);
    shell()?.replaceChildren(child);document.querySelector('#projectCanvas')?.append(previewShell);
    schedulePreviewReposition();
  } catch (error) {
    if (generation !== loadGeneration) return;
    showMessage(error instanceof Error ? error.message : String(error), 'error');
  }
}

window.addEventListener('scroll', schedulePreviewReposition, { passive: true, capture: true });
window.addEventListener('resize', schedulePreviewReposition, { passive: true });

window.ProjectCanvas = Object.freeze({ mount, unmount });
