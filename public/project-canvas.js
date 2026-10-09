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
    previewChild?.contentWindow?.postMessage({ type: 'papers:proxima-preview-reposition' }, childOrigin || '*');
  });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

  if (child?.contentWindow && event.source === child.contentWindow) {
    if (childOrigin && event.origin !== childOrigin) return;
    if(message.type==='papers:proxima-lens-request'){previewChild?.contentWindow?.postMessage(message,childOrigin||'*');return;}
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
    if (message.type === 'papers:proxima-preview-ready') {
      previewReady = true;
      forwardPreviewSelection();
      schedulePreviewReposition();
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
  if (message.type === HOST_RESULT && typeof message.requestId === 'string') {
    if (finishParentRequest(message)) return;
    const target = childRequests.get(message.requestId);
    if (target) {
      childRequests.delete(message.requestId);
      target.frame?.contentWindow?.postMessage(message, target.origin || '*');
    }
    return;
  }
  if (message.type.startsWith(PROJECT_PUSH_PREFIX)) forwardToChild(message);
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
  window.postMessage({ type: 'papers:project:workspace-scope-revoke' }, messageTarget());
  if (child) child.remove();
  if (previewChild) previewChild.remove();
  if (previewShell) previewShell.remove();
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
}

async function mount(project) {
  unmount();
  mountedProject = project;
  const generation = loadGeneration;
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
    child = document.createElement('iframe');
    child.className = 'project-workspace-frame';
    child.title = `${project.name} — As you Go`;
    child.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    child.src = url.toString();

    const previewUrl = new URL(scope.url);
    previewUrl.pathname = previewUrl.pathname.replace(/workspace-20260730b\.html$/i, 'proxima-preview.html');
    previewUrl.search = '';
    previewUrl.searchParams.set('papers-embedded-surface', 'proxima-preview');
    previewChild = document.createElement('iframe');
    previewChild.className = 'project-preview-frame';
    previewChild.title = `${project.name} - Preview`;
    previewChild.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    previewChild.src = previewUrl.toString();

    previewShell = document.createElement('aside');
    previewShell.className = 'project-preview-sidecar';
    previewShell.setAttribute('aria-label', 'Project file preview');
    previewResizer = document.createElement('div');
    previewResizer.className = 'project-preview-resizer';
    previewResizer.setAttribute('role', 'separator');
    previewResizer.setAttribute('aria-orientation', 'vertical');
    previewResizer.setAttribute('aria-label', 'Resize project preview');
    previewResizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      previewResizer?.setPointerCapture?.(event.pointerId);
      previewShell?.classList.add('resizing');
      event.preventDefault();
    });
    previewResizer.addEventListener('pointermove', (event) => {
      if (!previewResizer?.hasPointerCapture?.(event.pointerId)) return;
      const canvas = document.querySelector('#projectCanvas');
      const bounds = canvas?.getBoundingClientRect();
      if (!bounds) return;
      const gap = 12;
      const minPane = 240;
      const width = Math.max(minPane, Math.min(bounds.width - minPane - gap, bounds.right - event.clientX));
      canvas.style.setProperty('--project-preview-width', Math.round(width) + 'px');
      schedulePreviewReposition();
      event.preventDefault();
    });
    const finishResize = (event) => {
      if (!previewResizer?.hasPointerCapture?.(event.pointerId)) return;
      previewResizer.releasePointerCapture?.(event.pointerId);
      previewShell?.classList.remove('resizing');
    };
    previewResizer.addEventListener('pointerup', finishResize);
    previewResizer.addEventListener('pointercancel', finishResize);
    previewShell.append(previewResizer, previewChild);
    shell()?.replaceChildren(child);
    document.querySelector('#projectCanvas')?.append(previewShell);
    schedulePreviewReposition();
  } catch (error) {
    if (generation !== loadGeneration) return;
    showMessage(error instanceof Error ? error.message : String(error), 'error');
  }
}

window.addEventListener('scroll', schedulePreviewReposition, { passive: true });
window.addEventListener('resize', schedulePreviewReposition, { passive: true });

window.ProjectCanvas = Object.freeze({ mount, unmount });
