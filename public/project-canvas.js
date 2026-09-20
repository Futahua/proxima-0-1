/*
 * Proxima's project canvas.
 *
 * The interaction vocabulary is intentionally familiar to As you Go — graph
 * viewport, camera, pan/zoom, selection, marquee and movable nodes — but the
 * data boundary is Proxima's: every node is a live taskId join and every layout
 * fact is stored in Store.projectCanvas(projectId). No As you Go file, bridge or
 * record is read here.
 */
const ProjectCanvas = (() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  let root = null;
  let projectId = '';
  let project = null;
  let selected = new Set();
  let activeDrag = null;
  let activeMarquee = null;
  let activePan = null;
  let renderQueued = false;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const nodeSize = { width: 220, height: 116 };

  function canvas() {
    return Store.projectCanvas(projectId) || {
      projectId,
      schemaVersion: 1,
      rev: 1,
      groups: [],
      placements: [],
      view: { x: 0, y: 0, scale: 1, expandedGroupIds: [] },
    };
  }

  function tasks() {
    return Store.tasks().filter((task) => task.project === projectId).sort((a, b) => a.order - b.order);
  }

  function placementFor(task, index, state) {
    const saved = state.placements.find((placement) => placement.taskId === task.id);
    if (saved) return { ...saved };
    const column = index % 4;
    const row = Math.floor(index / 4);
    return { taskId: task.id, parentId: null, order: index, x: 48 + column * 252, y: 48 + row * 156 };
  }

  function setCamera(state) {
    const view = state.view || { x: 0, y: 0, scale: 1 };
    const scale = clamp(Number(view.scale) || 1, 0.55, 1.8);
    $('#canvasWorld').style.transform = 'translate(' + (Number(view.x) || 0) + 'px, ' + (Number(view.y) || 0) + 'px) scale(' + scale + ')';
    $('#canvasZoom').textContent = Math.round(scale * 100) + '%';
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; if (root && !root.hidden) render(); });
  }

  function nodeFor(task, placement) {
    const node = document.createElement('article');
    node.className = 'canvas-node canvas-node-' + task.status;
    node.dataset.taskId = task.id;
    node.style.left = placement.x + 'px';
    node.style.top = placement.y + 'px';
    node.tabIndex = 0;
    node.setAttribute('aria-label', task.name);
    if (selected.has(task.id)) node.classList.add('selected');
    const status = document.createElement('span');
    status.className = 'canvas-node-status';
    status.textContent = task.status;
    const title = document.createElement('h3');
    title.textContent = task.name;
    const note = document.createElement('p');
    note.textContent = task.note || (task.deadline ? 'Due ' + task.deadline : 'No deadline');
    const footer = document.createElement('footer');
    footer.textContent = task.deadline ? task.deadline : 'Proxima task';
    node.append(status, title, note, footer);
    node.addEventListener('pointerdown', (event) => beginNodeDrag(event, task.id));
    node.addEventListener('dblclick', () => { if (typeof window.__proximaOpenTask === 'function') window.__proximaOpenTask(task.id); });
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && typeof window.__proximaOpenTask === 'function') window.__proximaOpenTask(task.id);
      if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); toggleSelection(task.id, event.shiftKey); }
    });
    return node;
  }

  function groupFor(group, placements) {
    const members = placements.filter((placement) => placement.parentId === group.id);
    const left = members.length ? Math.min(...members.map((member) => member.x)) - 24 : 0;
    const top = members.length ? Math.min(...members.map((member) => member.y)) - 44 : 0;
    const right = members.length ? Math.max(...members.map((member) => member.x + nodeSize.width)) + 24 : 360;
    const bottom = members.length ? Math.max(...members.map((member) => member.y + nodeSize.height)) + 24 : 170;
    const frame = document.createElement('div');
    frame.className = 'canvas-group';
    frame.dataset.groupId = group.id;
    frame.style.left = left + 'px';
    frame.style.top = top + 'px';
    frame.style.width = Math.max(280, right - left) + 'px';
    frame.style.height = Math.max(130, bottom - top) + 'px';
    const label = document.createElement('span');
    label.textContent = group.name;
    frame.append(label);
    return frame;
  }

  function render() {
    if (!root) return;
    const state = canvas();
    const ownTasks = tasks();
    const placements = ownTasks.map((task, index) => placementFor(task, index, state));
    selected = new Set([...selected].filter((id) => ownTasks.some((task) => task.id === id)));
    $('#canvasProjectName').textContent = project ? project.name : 'Project canvas';
    $('#canvasProjectDescription').textContent = project?.description || 'A private Proxima canvas for this project.';
    $('#canvasCount').textContent = ownTasks.length + (ownTasks.length === 1 ? ' task' : ' tasks');
    const world = $('#canvasWorld');
    world.replaceChildren();
    state.groups.forEach((group) => world.append(groupFor(group, placements)));
    ownTasks.forEach((task, index) => world.append(nodeFor(task, placements[index])));
    setCamera(state);
    $('#canvasEmpty').hidden = ownTasks.length !== 0;
    $('#canvasSelection').textContent = selected.size ? selected.size + ' selected' : 'Drag cards to arrange';
  }

  function toggleSelection(taskId, additive) {
    if (!additive) selected.clear();
    if (additive && selected.has(taskId)) selected.delete(taskId); else selected.add(taskId);
    scheduleRender();
  }

  function viewportPoint(event) {
    const viewport = $('#canvasViewport').getBoundingClientRect();
    const state = canvas();
    const scale = Number(state.view?.scale) || 1;
    return {
      x: (event.clientX - viewport.left - (Number(state.view?.x) || 0)) / scale,
      y: (event.clientY - viewport.top - (Number(state.view?.y) || 0)) / scale,
    };
  }

  function beginNodeDrag(event, taskId) {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (event.shiftKey) toggleSelection(taskId, true); else if (!selected.has(taskId)) toggleSelection(taskId, false);
    const state = canvas();
    const positions = new Map();
    tasks().forEach((task, index) => {
      if (selected.has(task.id) || task.id === taskId) positions.set(task.id, placementFor(task, index, state));
    });
    activeDrag = { pointerId: event.pointerId, start: viewportPoint(event), positions, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
    event.currentTarget.addEventListener('pointermove', moveNodeDrag);
    event.currentTarget.addEventListener('pointerup', endNodeDrag, { once: true });
  }

  function moveNodeDrag(event) {
    if (!activeDrag) return;
    const now = viewportPoint(event);
    const dx = now.x - activeDrag.start.x;
    const dy = now.y - activeDrag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) activeDrag.moved = true;
    activeDrag.positions.forEach((position, taskId) => {
      const node = $('#canvasWorld').querySelector('[data-task-id="' + CSS.escape(taskId) + '"]');
      if (node) { node.style.left = position.x + dx + 'px'; node.style.top = position.y + dy + 'px'; }
    });
  }

  async function endNodeDrag(event) {
    const drag = activeDrag;
    activeDrag = null;
    if (!drag) return;
    const now = viewportPoint(event);
    const dx = now.x - drag.start.x;
    const dy = now.y - drag.start.y;
    event.currentTarget.classList.remove('dragging');
    event.currentTarget.removeEventListener('pointermove', moveNodeDrag);
    if (!drag.moved) { scheduleRender(); return; }
    for (const [taskId, position] of drag.positions) {
      await Store.command({ type: 'project-canvas.task-place', payload: { projectId, taskId, x: Math.round(position.x + dx), y: Math.round(position.y + dy) }, commandId: Store.newCommandId() });
    }
    render();
  }

  function beginViewportGesture(event) {
    if (event.target.closest('.canvas-node') || event.target.closest('.canvas-toolbar')) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    const state = canvas();
    const viewport = $('#canvasViewport');
    const rect = viewport.getBoundingClientRect();
    if (event.shiftKey) {
      activeMarquee = { startX: event.clientX - rect.left, startY: event.clientY - rect.top, rect };
      $('#canvasMarquee').hidden = false;
      updateMarquee(event);
    } else {
      activePan = { startX: event.clientX, startY: event.clientY, x: Number(state.view?.x) || 0, y: Number(state.view?.y) || 0 };
    }
    viewport.setPointerCapture(event.pointerId);
  }

  function updateMarquee(event) {
    if (!activeMarquee) return;
    const box = $('#canvasViewport').getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const left = Math.min(activeMarquee.startX, x);
    const top = Math.min(activeMarquee.startY, y);
    const width = Math.abs(x - activeMarquee.startX);
    const height = Math.abs(y - activeMarquee.startY);
    const marquee = $('#canvasMarquee');
    marquee.style.left = left + 'px'; marquee.style.top = top + 'px'; marquee.style.width = width + 'px'; marquee.style.height = height + 'px';
    const range = { left: box.left + left, right: box.left + left + width, top: box.top + top, bottom: box.top + top + height };
    selected.clear();
    $$('#canvasWorld .canvas-node').forEach((node) => {
      const r = node.getBoundingClientRect();
      if (r.left < range.right && r.right > range.left && r.top < range.bottom && r.bottom > range.top) selected.add(node.dataset.taskId);
      node.classList.toggle('selected', selected.has(node.dataset.taskId));
    });
    $('#canvasSelection').textContent = selected.size ? selected.size + ' selected' : 'Drag cards to arrange';
  }

  async function endViewportGesture(event) {
    if (activeMarquee) {
      activeMarquee = null; $('#canvasMarquee').hidden = true; return;
    }
    if (!activePan) return;
    const pan = activePan; activePan = null;
    const patch = { x: Math.round(pan.x + event.clientX - pan.startX), y: Math.round(pan.y + event.clientY - pan.startY) };
    await Store.command({ type: 'project-canvas.view.patch', payload: { projectId, patch }, commandId: Store.newCommandId() });
    render();
  }

  async function patchView(patch) {
    await Store.command({ type: 'project-canvas.view.patch', payload: { projectId, patch }, commandId: Store.newCommandId() });
    render();
  }

  async function addGroup() {
    const name = window.prompt('Canvas group name');
    if (!name || !name.trim()) return;
    await Store.command({ type: 'project-canvas.group.create', payload: { projectId, name: name.trim() }, commandId: Store.newCommandId() });
    render();
  }

  function wire() {
    const viewport = $('#canvasViewport');
    viewport.addEventListener('pointerdown', beginViewportGesture);
    viewport.addEventListener('pointermove', (event) => { if (activeMarquee) updateMarquee(event); });
    viewport.addEventListener('pointerup', endViewportGesture);
    viewport.addEventListener('pointercancel', endViewportGesture);
    $('#canvasZoomOut').addEventListener('click', () => patchView({ scale: clamp((Number(canvas().view?.scale) || 1) - 0.1, 0.55, 1.8) }));
    $('#canvasZoomIn').addEventListener('click', () => patchView({ scale: clamp((Number(canvas().view?.scale) || 1) + 0.1, 0.55, 1.8) }));
    $('#canvasReset').addEventListener('click', () => patchView({ x: 0, y: 0, scale: 1 }));
    $('#canvasAddGroup').addEventListener('click', addGroup);
    $('#canvasNewTask').addEventListener('click', () => { if (typeof window.__proximaOpenTask === 'function') window.__proximaOpenTask(null); });
  }

  function mount(nextProject) {
    project = nextProject;
    projectId = nextProject?.id || '';
    root = $('#projectCanvas');
    selected.clear();
    root.hidden = false;
    if (!root.dataset.wired) { root.dataset.wired = 'true'; wire(); }
    render();
  }

  function unmount() {
    activeDrag = null; activeMarquee = null; activePan = null; selected.clear();
    if (root) root.hidden = true;
    project = null; projectId = '';
  }

  return { mount, unmount, render: scheduleRender };
})();
