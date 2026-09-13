/*
 * Elastic Boards.
 *
 * The board is an execution controller, not three lists. Running cards are sized by
 * their share of the time left before the execution target; locking freezes that
 * allocation and starts a live run you watch being consumed.
 *
 * Sizing is proportional to the running column's real clientHeight, never to a
 * constant. Unlocked, a card's height is its share of total weight; locked, it is
 * its share of total calculated duration, because once a run starts time — not
 * appetite — is what a card actually owns.
 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const columns = $('#columns');
  const targetInput = $('#target');
  const lockBtn = $('#lockBtn');
  const runInfo = $('#runInfo');
  const projectFilter = $('#projectFilter');
  const taskDialog = $('#taskDialog');
  const taskForm = $('#taskForm');
  const projectDialog = $('#projectDialog');
  const projectForm = $('#projectForm');

  /** Floor height for one running card, and the baseline horizon of the board. */
  const MIN_CARD_HEIGHT = 125;
  const MIN_CONTAINER_HEIGHT = 300;
  const CARD_GAP = 8;

  /** Last non-zero reading of the running column's clientHeight. */
  let runningHeight = 0;

  let editingId = null;
  let ticker = null;

  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (date) =>
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  const fromLocalInput = (value) => (value ? new Date(value) : null);
  const minutes = (ms) => Math.max(0, Math.round(ms / 60000));
  const humanDuration = (ms) => {
    if (ms > 0 && ms < 60000) return '<1m';
    const m = minutes(ms);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return m % 60 === 0 ? h + 'h' : h + 'h ' + (m % 60) + 'm';
  };

  // ── Days ──────────────────────────────────────────────────────────────────
  // Task dates are plain YYYY-MM-DD strings. Every comparison goes through
  // dayStart(), so "overdue" flips when the wall clock passes midnight and no
  // write of any kind is involved.
  const DAY_MS = 86400000;

  function dayStart(value) {
    if (!value || typeof value !== 'string') return NaN;
    const parts = value.slice(0, 10).split('-');
    if (parts.length !== 3) return NaN;
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.getFullYear() === Number(parts[0]) ? d.getTime() : NaN;
  }

  const dayString = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const todayDay = () => dayString(new Date());
  const startOfToday = () => dayStart(todayDay());
  const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / DAY_MS);
  const shortDay = (value) => {
    const ms = dayStart(value);
    return Number.isNaN(ms) ? '—' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  /**
   * Effective span of a task: from its start day, falling back to the day it was
   * created (and finally today) so tasks written before the start field existed
   * still lay out on the timeline, through to its deadline.
   *
   * The creation day is only ever a fallback for a task that has no start. The
   * first whole-bar drag of such a task writes a real start, after which this
   * fallback is no longer consulted for it — createdAt itself never moves.
   */
  function spanOf(task) {
    const end = dayStart(task.deadline);
    if (Number.isNaN(end)) return null;
    let start = dayStart(task.start);
    if (Number.isNaN(start)) start = dayStart(String(task.createdAt || '').slice(0, 10));
    if (Number.isNaN(start)) start = startOfToday();
    return { start, end: Math.max(start, end) };
  }

  // ── Urgency ───────────────────────────────────────────────────────────────
  /**
   * The five urgency bands. These are rollings durations measured from this
   * instant, not calendar-day steps: a deadline sixteen hours away is "within a
   * day" even though its date is tomorrow. Each band holds everything below its
   * own upper bound in days.
   */
  const URGENCY_GROUPS = [
    { key: 'overdue', label: 'Overdue', bound: 0, hue: 0 },
    { key: 'today', label: 'Due within a day', bound: 1, hue: 32 },
    { key: 'soon', label: 'Due within three days', bound: 3, hue: 52 },
    { key: 'week', label: 'Due within a week', bound: 7, hue: 92 },
    { key: 'later', label: 'Later', bound: Infinity, hue: 205 },
  ];

  // Placeholder band colours, used until the original's configurable colorRules
  // system exists here. The hues above are only labels: do not read them as the
  // rule engine.
  const URGENCY_COLOR = {
    overdue: '#e06c75', today: '#e7a24b', soon: '#e7d24b', week: '#9fd04a', later: '#6fa8dc',
  };

  /** Whole days from `fromMs` to a deadline, negative when past. */
  function daysUntil(deadline, fromMs) {
    const ms = dayStart(deadline);
    if (Number.isNaN(ms)) return NaN;
    return (ms - fromMs) / DAY_MS;
  }

  function urgencyOf(deadline, fromMs) {
    const days = daysUntil(deadline, fromMs);
    if (Number.isNaN(days)) return 'later';
    if (days < 0) return 'overdue';
    if (days < 1) return 'today';
    if (days < 3) return 'soon';
    if (days < 7) return 'week';
    return 'later';
  }

  /** "3d 04h 12m 09s", counting up once a deadline has passed. */
  function formatCountdown(diffMs) {
    const past = diffMs < 0;
    const total = Math.floor(Math.abs(diffMs) / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    let text = '';
    if (d > 0) text += d + 'd ';
    if (d > 0 || h > 0) text += pad(h) + 'h ';
    text += pad(m) + 'm ' + pad(s) + 's';
    return past ? 'overdue by ' + text : text;
  }

  // ── Timekeeping view state ────────────────────────────────────────────────
  // Which panels are on screen is a composition the reader chooses, not a mode:
  // any combination is allowed, including all three at once, but never none. The
  // composition is persisted through Store so it survives a reload; zoom is a
  // session detail and is not task data either.
  const panels = { calendar: false, timeline: true, countdown: false };
  const calCursor = { y: new Date().getFullYear(), m: new Date().getMonth() };
  let tlZoom = 44;
  let tlCentered = false;
  let countdownSignature = '';

  const tlViewport = $('#tlViewport');
  const tlInner = $('#tlInner');
  const tlDates = $('#tlDates');
  const tlRows = $('#tlRows');

  /** Default execution horizon: four hours out, per the original. */
  function ensureTarget() {
    const run = Store.run();
    if (run && run.target) { targetInput.value = run.target; return; }
    if (!targetInput.value) {
      const soon = new Date(Date.now() + 4 * 60 * 60 * 1000);
      soon.setSeconds(0, 0);
      targetInput.value = toLocalInput(soon);
    }
  }

  /** The running column itself — the box whose clientHeight drives every card. */
  function runningHost() {
    return $('.cards[data-drop="running"]');
  }

  /**
   * Read the running column's real client height. Never measure mid-layout with a
   * stale number: if the host collapsed, fall back to the last good reading, and
   * otherwise to the 300px baseline the original uses when it has none.
   */
  function measureRunningHeight() {
    const host = runningHost();
    const measured = host ? host.clientHeight : 0;
    if (measured > 0) runningHeight = measured;
    return runningHeight > 0 ? runningHeight : MIN_CONTAINER_HEIGHT;
  }

  function timelineFor(runningTasks, from, target) {
    const items = new Map();
    const totalMs = target ? target.getTime() - from.getTime() : 0;
    if (totalMs <= 0) return { items, total: 0 };

    // Fixed spans are honoured first; whatever is left is split by weight. The
    // board has no fixed-duration field, so each task's calculated duration is its
    // weighted share of the whole horizon.
    const totalWeight = runningTasks.reduce((sum, t) => sum + t.weight, 0) || 1;
    let total = 0;
    runningTasks.forEach((task) => {
      const duration = (task.weight / totalWeight) * totalMs;
      items.set(task.id, duration);
      total += duration;
    });
    return { items, total };
  }

  /**
   * Proportional heights, recomputed from the live container height on every pass
   * that can change either the container or the weights.
   */
  function heightsFor(runningTasks, durations, totalDuration, H) {
    const heights = new Map();
    if (runningTasks.length === 0) return heights;

    if (totalDuration <= 0 || H <= 0) {
      const totalWeight = runningTasks.reduce((sum, t) => sum + t.weight, 0) || 1;
      runningTasks.forEach((task) => {
        heights.set(task.id, Math.max(MIN_CARD_HEIGHT, (task.weight / totalWeight) * Math.max(H, MIN_CONTAINER_HEIGHT)));
      });
      return heights;
    }

    runningTasks.forEach((task) => {
      const duration = durations.get(task.id) || 0;
      heights.set(task.id, Math.max(MIN_CARD_HEIGHT, (duration / totalDuration) * H));
    });
    return heights;
  }

  /**
   * A locked run is consumed in order: elapsed time fills the first card to
   * completion, then the next, and so on. Returns a ratio per task id.
   */
  function progressFor(runningTasks, durations, run) {
    const ratios = new Map();
    if (!run) return ratios;

    let remaining = Math.max(0, Date.now() - new Date(run.lockedAt).getTime());
    runningTasks.forEach((task) => {
      const duration = durations.get(task.id) || 0;
      if (duration <= 0) { ratios.set(task.id, 0); return; }
      if (remaining >= duration) {
        ratios.set(task.id, 1);
        remaining -= duration;
      } else {
        ratios.set(task.id, Math.min(1, Math.max(0, remaining / duration)));
        remaining = 0;
      }
    });
    return ratios;
  }

  /**
   * The allocation model for one pass: the horizon, each running task's calculated
   * duration, and the proportional height that duration earns it.
   */
  function allocations(runningTasks) {
    const run = Store.run();
    const target = run && run.target ? fromLocalInput(run.target) : fromLocalInput(targetInput.value);
    const from = run ? new Date(run.lockedAt) : new Date();
    const available = target ? Math.max(0, target - from) : 0;
    const { items: durations, total } = timelineFor(runningTasks, from, target);
    const H = measureRunningHeight();

    return {
      durations,
      total,
      available,
      from,
      target,
      height: H,
      heights: heightsFor(runningTasks, durations, total, H),
      progress: progressFor(runningTasks, durations, run),
    };
  }

  /**
   * Everything one painting pass needs. Deliberately free of DOM writes so the
   * same model can serve both a full rebuild and a tick that only restyles.
   */
  function viewModel() {
    const tasks = visibleTasks();
    const running = tasks.filter((t) => t.status === 'running');
    return { tasks, running, allocation: allocations(running), run: Store.run() };
  }

  /** What one running task owns: its slice of duration, or of weight with no target. */
  function shareFor(task, allocation) {
    const duration = allocation.durations.get(task.id);
    if (duration !== undefined) return duration;
    const totalWeight = visibleTasks()
      .filter((t) => t.status === 'running')
      .reduce((sum, t) => sum + t.weight, 0) || 1;
    return (task.weight / totalWeight) * allocation.available;
  }

  function visibleTasks() {
    const filter = projectFilter.value;
    return Store.tasks()
      .filter((t) => !filter || t.project === filter)
      .sort((a, b) => a.order - b.order);
  }

  /** The one line under the Lock button, shared by the rebuild and the tick. */
  function runLine(view) {
    const { allocation, running, run } = view;
    if (run) {
      const lockedAt = new Date(run.lockedAt).getTime();
      const target = fromLocalInput(run.target);
      const total = target ? target.getTime() - lockedAt : 0;
      const left = Math.max(0, total - (Date.now() - lockedAt));
      return left > 0
        ? 'Running — ' + humanDuration(left) + ' left of ' + humanDuration(total)
        : 'Run finished — the target has passed.';
    }
    return allocation.target
      ? humanDuration(allocation.available) + ' across ' + running.length +
        (running.length === 1 ? ' running task' : ' running tasks')
      : 'Set an execution target.';
  }

  /**
   * The only thing a tick is allowed to touch: the styles of cards that already
   * exist. Nothing here creates, replaces or removes a node, so a scrolled column
   * stays exactly where the reader left it — emptying a scroll container would
   * reset its scrollTop to zero every second.
   *
   * Safe to call directly from a click handler, a tick or a resize: mutating the
   * styles above dirties layout, so the measurement this pass reads at its top is
   * taken after those mutations have been flushed together.
   */
  function paint() {
    const view = viewModel();
    const host = runningHost();
    if (!host) return;

    host.style.height = view.allocation.height + 'px';

    // Heights are placed by hand because the cards are absolute: stacking them
    // from the top keeps the gaps equal no matter how the ratios fall.
    let top = 0;
    view.running.forEach((task) => {
      const card = host.querySelector('.card[data-id="' + task.id + '"]');
      if (!card) return;
      const height = Math.round(view.allocation.heights.get(task.id) || MIN_CARD_HEIGHT);
      card.style.top = Math.round(top) + 'px';
      card.style.height = height + 'px';
      // A floor-height card has no room for its footer; hide it rather than spill.
      card.classList.toggle('tight', height < 132);
      paintWipe(card, view.run ? view.allocation.progress.get(task.id) || 0 : 0);
      top += height + CARD_GAP;
    });

    runInfo.textContent = runLine(view);
  }

  /** The top-down progress layer, sized as a percentage of the card it sits in. */
  function paintWipe(card, progress) {
    let wipe = card.querySelector('.pos-wipe');
    if (!wipe) {
      // Cards start with no layer at all, so the first sliver has to create it.
      if (progress <= 0) return;
      wipe = document.createElement('div');
      wipe.className = 'pos-wipe';
      card.prepend(wipe);
    }
    wipe.style.height = (progress * 100) + '%';
    card.classList.toggle('spent', progress >= 1);
  }

  function render() {
    const { tasks, running, allocation, run } = viewModel();

    // A rebuild replaces every column's children, so any drop highlight left on
    // the previous nodes would survive as a stale tint on the column.
    $$('.cards').forEach((c) => c.classList.remove('over'));

    $('#taskCount').textContent = tasks.length + (tasks.length === 1 ? ' task' : ' tasks');
    const active = Store.projects().find((p) => p.id === projectFilter.value);
    $('#scopeLabel').textContent = active ? active.name.toUpperCase() : 'ALL PROJECTS';

    ['backlog', 'running', 'finished'].forEach((status) => {
      const list = tasks.filter((t) => t.status === status);
      const host = $('.cards[data-drop="' + status + '"]');
      $('[data-count="' + status + '"]').textContent = String(list.length);
      host.replaceChildren();
      if (list.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No tasks here.';
        host.append(empty);
        return;
      }
      list.forEach((task) => {
        const isRunning = status === 'running';
        host.append(cardFor(
          task,
          isRunning ? shareFor(task, allocation) : null,
          run,
          allocation.from,
          isRunning ? allocation : null
        ));
      });
    });

    lockBtn.textContent = run ? 'Unlock' : 'Lock';
    lockBtn.classList.toggle('on', Boolean(run));
    targetInput.disabled = Boolean(run);
    runInfo.textContent = runLine({ tasks, running, allocation, run });

    paint();
  }

  /** Inline plus/minus stepper, clamped at a minimum of one. */
  function stepperFor(task) {
    const group = document.createElement('span');
    group.className = 'stepper';
    group.title = 'Weight';

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'step';
    down.textContent = '−';
    down.disabled = task.weight <= 1;
    down.addEventListener('click', (event) => {
      event.stopPropagation();
      Store.updateTask(task.id, { weight: Math.max(1, task.weight - 1) });
      render();
    });

    const value = document.createElement('span');
    value.className = 'w';
    value.textContent = String(task.weight);

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'step';
    up.textContent = '+';
    up.addEventListener('click', (event) => {
      event.stopPropagation();
      Store.updateTask(task.id, { weight: task.weight + 1 });
      render();
    });

    group.append(down, value, up);
    return group;
  }

  function cardFor(task, allocatedMs, run, from, allocation) {
    const card = document.createElement('article');
    card.className = 'card ' + task.status;
    card.draggable = true;
    card.dataset.id = task.id;

    const isRunning = task.status === 'running';
    const locked = isRunning && Boolean(run);

    if (locked) {
      // Same path the tick uses, so a rebuild and a restyle agree on the wipe.
      paintWipe(card, allocation.progress.get(task.id) || 0);
    }

    // Everything a click should still reach sits above the wipe.
    const body = document.createElement('div');
    body.className = 'body';

    const kind = document.createElement('p');
    kind.className = 'kind';
    kind.textContent = task.status.toUpperCase();
    body.append(kind);

    const title = document.createElement('h4');
    title.textContent = task.name;
    body.append(title);

    if (task.note) {
      const note = document.createElement('p');
      note.textContent = task.note;
      body.append(note);
    }

    if (allocatedMs !== null && allocatedMs !== undefined) {
      const alloc = document.createElement('p');
      alloc.className = 'alloc';
      alloc.textContent = humanDuration(allocatedMs) + (locked ? ' budgeted' : ' allocated');
      body.append(alloc);
    }

    const footer = document.createElement('footer');
    const project = Store.projects().find((p) => p.id === task.project);
    const left = document.createElement('span');
    left.textContent = project ? project.name : 'Uncategorised';
    const right = document.createElement('span');
    right.textContent = task.deadline ? task.deadline : 'No deadline';
    footer.append(left, right);
    body.append(footer);

    card.append(body);

    const acts = document.createElement('div');
    acts.className = 'acts';
    if (isRunning) acts.append(stepperFor(task));

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete task';
    del.textContent = '×';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      if (Store.deleteTask(task.id)) render();
    });
    acts.append(del);
    card.append(acts);

    card.addEventListener('click', () => openTask(task.id));
    return card;
  }

  let dragId = null;
  let placeholder = null;

  columns.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add('dragging');
    placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.style.height = card.offsetHeight + 'px';
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragId);
  });

  columns.addEventListener('dragend', () => {
    const wasDragging = dragId !== null;
    $$('.card.dragging').forEach((c) => c.classList.remove('dragging'));
    if (placeholder) placeholder.remove();
    placeholder = null;
    dragId = null;
    $$('.cards').forEach((c) => c.classList.remove('over'));
    // A drag that ended outside any column still needs the board recomputed,
    // but a plain click must not be re-rendered out from under itself.
    if (wasDragging) render();
  });

  columns.addEventListener('dragover', (event) => {
    const host = event.target.closest('.cards');
    if (!host || !placeholder) return;
    event.preventDefault();
    host.classList.add('over');
    const after = cardAfter(host, event.clientY);
    if (after) host.insertBefore(placeholder, after);
    else host.append(placeholder);
  });

  columns.addEventListener('dragleave', (event) => {
    const host = event.target.closest('.cards');
    if (!host) return;
    // relatedTarget can be null while the drag leaves a window, and a re-render
    // during the drag can detach it — both mean the pointer has left this column.
    const next = event.relatedTarget;
    const stillInside = next && next instanceof Node && host.contains(next);
    if (!stillInside) host.classList.remove('over');
  });

  columns.addEventListener('drop', (event) => {
    const host = event.target.closest('.cards');
    if (!host || !dragId) return;
    event.preventDefault();
    const next = placeholder ? placeholder.nextElementSibling : null;
    const beforeId = next && next.classList.contains('card') ? next.dataset.id : null;
    Store.moveTask(dragId, host.dataset.drop, beforeId);
    render();
  });

  function cardAfter(host, y) {
    const cards = $$('.card:not(.dragging)', host);
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      if (y < box.top + box.height / 2) return card;
    }
    return null;
  }

  function refreshProjectOptions() {
    const projects = Store.projects();
    const build = (select, allLabel) => {
      const current = select.value;
      select.replaceChildren();
      const first = document.createElement('option');
      first.value = '';
      first.textContent = allLabel;
      select.append(first);
      projects.forEach((p) => {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = p.name;
        select.append(option);
      });
      select.value = current;
    };
    build(projectFilter, '-- All Projects --');
    build(taskForm.elements.project, 'Uncategorised');
  }

  function openTask(taskId) {
    editingId = taskId;
    const task = taskId ? Store.task(taskId) : null;
    $('#taskDialogTitle').textContent = task ? 'Edit task' : 'New task';
    $('#deleteTaskBtn').style.display = task ? '' : 'none';
    refreshProjectOptions();
    taskForm.elements.name.value = task ? task.name : '';
    taskForm.elements.note.value = task ? task.note : '';
    taskForm.elements.project.value = task ? task.project : (projectFilter.value || '');
    taskForm.elements.status.value = task ? task.status : 'backlog';
    taskForm.elements.weight.value = task ? task.weight : 1;
    taskForm.elements.deadline.value = task ? task.deadline : '';
    // New tasks start today; existing ones show the start the store resolved for
    // them, including tasks written before the field existed.
    taskForm.elements.start.value = task ? (task.start || todayDay()) : todayDay();
    taskDialog.showModal();
  }

  taskForm.addEventListener('submit', (event) => {
    const action = event.submitter ? event.submitter.value : 'save';
    if (action === 'cancel') return;
    if (action === 'delete') {
      if (editingId) Store.deleteTask(editingId);
      queueMicrotask(() => { render(); refreshTimekeeping(); });
      return;
    }
    const fields = {
      name: taskForm.elements.name.value,
      note: taskForm.elements.note.value,
      project: taskForm.elements.project.value,
      status: taskForm.elements.status.value,
      weight: taskForm.elements.weight.value,
      start: taskForm.elements.start.value,
      deadline: taskForm.elements.deadline.value,
    };
    if (editingId) Store.updateTask(editingId, fields);
    else Store.addTask(fields);
    queueMicrotask(() => { render(); refreshTimekeeping(); });
  });

  projectForm.addEventListener('submit', (event) => {
    if (!event.submitter || event.submitter.value !== 'save') return;
    Store.addProject(projectForm.elements.name.value);
    projectForm.reset();
    queueMicrotask(() => { refreshProjectOptions(); render(); refreshTimekeeping(); });
  });

  $('#newTaskBtn').addEventListener('click', () => openTask(null));
  $('#newProjectBtn').addEventListener('click', () => projectDialog.showModal());
  // The project filter scopes both surfaces, so it re-reads both.
  projectFilter.addEventListener('change', () => { render(); refreshTimekeeping(); });
  // A new target is a new horizon: every proportional share changes with it.
  targetInput.addEventListener('change', render);
  // A resize only changes how tall the running column is, so restyle rather than
  // rebuild — otherwise resizing would also throw away the reader's scroll spot.
  window.addEventListener('resize', () => {
    runningHeight = 0;
    paint();
  });

  lockBtn.addEventListener('click', () => {
    if (Store.run()) {
      Store.setRun(null);
      clearInterval(ticker);
      ticker = null;
    } else {
      const target = fromLocalInput(targetInput.value);
      if (!target || target <= new Date()) {
        runInfo.textContent = 'Pick a target in the future before locking.';
        return;
      }
      Store.setRun({ lockedAt: new Date().toISOString(), target: targetInput.value });
      ticker = setInterval(tick, 1000);
    }
    render();
  });

  /**
   * One second of a live run. A tick rewrites card heights, wipe heights and the
   * countdown line, and touches nothing else — no node is created, replaced or
   * removed, so the running column keeps its scroll position while it grows.
   */
  function tick() {
    paint();
  }

  // ══ Timekeeping ═══════════════════════════════════════════════════════════
  // A composite cockpit of three panels over one task set. The panels are not
  // alternatives to each other: each is switched on and off on its own, and the
  // reader composes the workspace from whichever ones they want, all three
  // included. Only the timeline flexes; the others keep a fixed width.

  /**
   * Tasks that carry a deadline and are still open, in calendar order, honouring
   * the project filter. Finished work is excluded from every Timekeeping panel —
   * a deadline board is about what is still owed, not what is already done.
   * A task is included on the strength of its deadline alone: `spanOf` resolves a
   * missing start, so tasks written before that field existed still appear.
   */
  function deadlineTasks() {
    return visibleTasks()
      .filter((t) => t.deadline && t.status !== 'finished')
      .sort((a, b) => dayStart(a.deadline) - dayStart(b.deadline) || a.order - b.order);
  }

  function renderTimekeeping() {
    const tasks = deadlineTasks();
    $('#tkCount').textContent = tasks.length + (tasks.length === 1 ? ' deadline' : ' deadlines');
    const anyDeadline = tasks.length > 0;
    $('#tkEmpty').hidden = anyDeadline;
    $('#tkPanels').hidden = !anyDeadline;

    if (panels.calendar) renderCalendar(tasks);
    if (panels.timeline) renderTimeline(tasks);
    if (panels.countdown) renderCountdowns(tasks);

    // Paint the live layer once so the panels never show a stale second.
    tickTimekeeping();
  }

  function syncPanelVisibility() {
    $$('.tk-toggle').forEach((btn) => {
      const on = panels[btn.dataset.panel];
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    $$('.tk-panel').forEach((panel) => { panel.hidden = !panels[panel.dataset.panel]; });
  }

  // ── Panel 1: Deadline Calendar ────────────────────────────────────────────
  // A projection of task SPANS onto a month. A task is a horizontal bar across
  // the part of each week it occupies, from its effective start to its deadline,
  // so work that began Monday and is due Friday covers the whole run rather than
  // only its last day. Navigation re-projects the same tasks against another
  // month and writes nothing at all.

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const CAL_WEEK_MS = 7 * DAY_MS;
  if ($('#calWeekdays').childElementCount === 0) {
    WEEKDAYS.forEach((name, i) => {
      const cell = document.createElement('span');
      cell.className = 'tk-weekday' + (i === 0 || i === 6 ? ' weekend' : '');
      cell.textContent = name;
      $('#calWeekdays').append(cell);
    });
  }

  /**
   * The bars a week carries: every task whose span overlaps it, clipped to the
   * week, given a percentage left/width and packed into the first free row so two
   * bars never draw over each other.
   *
   * WIDTH is measured end minus start, with no inclusive day: a same-day task
   * spans nothing and is held visible only by the 5% floor, and a Monday-to-Friday
   * task covers the four days it actually occupies.
   *
   * OVERLAP is tested on whole day indices, inclusive at both ends. The original
   * could compare raw instants because its dates carried a time of day, so a
   * same-day task ran from its creation clock time to its deadline clock time. Ours
   * are whole days, so its start and end land on the same midnight: comparing
   * instants would drop every same-day task whose day is the Sunday a week starts
   * on. Comparing day numbers keeps them, and does not put an inclusive day back
   * into the width.
   */
  function overlapDays(span, weekStartMs) {
    const startDay = Math.round(span.start / DAY_MS);
    const endDay = Math.round(span.end / DAY_MS);
    const firstDay = Math.round(weekStartMs / DAY_MS);
    const lastDay = Math.round((weekStartMs + CAL_WEEK_MS) / DAY_MS) - 1;
    return startDay <= lastDay && endDay >= firstDay;
  }

  function weekBars(tasks, weekStartMs) {
    const weekEndMs = weekStartMs + CAL_WEEK_MS;
    const overlapping = tasks
      .map((task) => ({ task, span: spanOf(task) }))
      .filter((entry) => entry.span && overlapDays(entry.span, weekStartMs))
      .sort((a, b) => a.span.start - b.span.start);

    const placed = [];
    overlapping.forEach((entry) => {
      const { task, span } = entry;
      const clampedStart = Math.max(span.start, weekStartMs);
      const clampedEnd = Math.min(span.end, weekEndMs);
      const leftPct = ((clampedStart - weekStartMs) / CAL_WEEK_MS) * 100;
      let widthPct = ((clampedEnd - clampedStart) / CAL_WEEK_MS) * 100;
      if (widthPct < 5) widthPct = 5; // keep a short task visible

      let row = 0;
      while (placed.some((p) => p.row === row && !(leftPct >= p.rightPct || leftPct + widthPct <= p.leftPct))) row++;

      placed.push({
        task,
        span,
        row,
        leftPct,
        widthPct,
        rightPct: leftPct + widthPct,
        isStart: span.start >= weekStartMs,
        isEnd: span.end <= weekEndMs,
      });
    });
    return placed;
  }

  function renderCalendar(tasks) {
    const y = calCursor.y;
    const m = calCursor.m;
    $('#calMonthLabel').textContent = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const grid = $('#calGrid');
    grid.replaceChildren();
    const firstWeekday = new Date(y, m, 1).getDay();
    const cellsInMonth = new Date(y, m + 1, 0).getDate();
    const rows = Math.ceil((firstWeekday + cellsInMonth) / 7);
    const gridStart = new Date(y, m, 1 - firstWeekday);
    const today = todayDay();

    for (let r = 0; r < rows; r++) {
      const weekStart = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + r * 7);
      const weekStartMs = dayStart(dayString(weekStart));
      const week = document.createElement('div');
      week.className = 'tk-cal-week';

      // The day numbers stay a plain grid; the bars are projected over the row.
      const days = document.createElement('div');
      days.className = 'tk-cal-days';
      for (let c = 0; c < 7; c++) {
        const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + c);
        const dayStr = dayString(date);
        const cell = document.createElement('div');
        cell.className = 'tk-cal-cell';
        if (date.getMonth() !== m) cell.classList.add('other-month');
        if (c === 0 || c === 6) cell.classList.add('weekend');
        if (dayStr === today) cell.classList.add('today');

        const num = document.createElement('span');
        num.className = 'tk-cal-num';
        num.textContent = String(date.getDate());
        cell.append(num);
        days.append(cell);
      }
      week.append(days);

      const bars = weekBars(tasks, weekStartMs);
      const track = document.createElement('div');
      track.className = 'tk-cal-bars';
      const maxRow = bars.reduce((max, bar) => Math.max(max, bar.row), -1);
      track.style.height = (maxRow < 0 ? 6 : (maxRow + 1) * 20 + 6) + 'px';

      bars.forEach((bar) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tk-cal-chip urgency-' + urgencyOf(bar.task.deadline, Date.now());
        if (bar.isStart) chip.classList.add('is-start');
        if (bar.isEnd) chip.classList.add('is-end');
        chip.dataset.id = bar.task.id;
        chip.dataset.deadline = bar.task.deadline;
        chip.style.left = bar.leftPct + '%';
        chip.style.width = bar.widthPct + '%';
        chip.style.top = (bar.row * 20 + 3) + 'px';
        // The tooltip names the same span the bar is drawn from, so a task whose
        // start is resolved through its creation day does not claim to start today.
        chip.title = bar.task.name + ' — ' + shortDay(dayString(new Date(bar.span.start))) +
          ' → ' + shortDay(dayString(new Date(bar.span.end)));
        chip.textContent = bar.task.name;
        chip.addEventListener('click', (event) => {
          event.stopPropagation();
          openTask(bar.task.id);
        });
        track.append(chip);
      });

      week.append(track);
      // Empty space stays inert on purpose: this is a deadline projection, not a
      // schedule grid, so clicking a day must never create anything.
      grid.append(week);
    }
  }

  // ── Panel 2: Timeline ─────────────────────────────────────────────────────
  // Bars span a task's effective start through its deadline. Horizontal scroll
  // and zoom are view state. Each row is a full-width track that holds its own
  // bar, so the ticks below can place a bar by writing one left offset, and the
  // viewport keeps its scroll position across a tick untouched.

  const TL_DAYS_BACK = 30;
  const TL_DAYS_FORWARD = 180;

  function tlWindow() {
    // Whole days only. The ruler steps a day at a time from `min`, so a
    // fractional offset would knock every column off the day grid and no column
    // would ever match today.
    const today = startOfToday();
    return {
      min: today - TL_DAYS_BACK * DAY_MS,
      max: today + TL_DAYS_FORWARD * DAY_MS,
      days: TL_DAYS_BACK + TL_DAYS_FORWARD + 1,
    };
  }

  function tlLeftInWindow(ms, win) {
    return ((ms - win.min) / DAY_MS) * tlZoom;
  }

  /**
   * The single place a bar's geometry is decided, shared by build and tick.
   * Width is deadline minus start, with no extra inclusive day: a same-day task
   * spans zero days and is held open only by the visual 24px floor, and a
   * two-day task covers exactly two columns.
   */
  function barGeometry(task, win) {
    const span = spanOf(task);
    if (!span) return null;
    const left = tlLeftInWindow(span.start, win);
    const right = tlLeftInWindow(span.end, win);
    return { left: Math.max(0, left), width: Math.max(right - left, 24) };
  }

  function placeBar(bar, task, win) {
    const geometry = barGeometry(task, win);
    if (!geometry) return;
    bar.style.transform = 'translateX(' + Math.round(geometry.left) + 'px)';
    bar.style.width = Math.round(geometry.width) + 'px';
  }

  function renderTimeline(tasks) {
    const win = tlWindow();
    const viewportWidth = tlViewport.clientWidth || 600;
    const gridWidth = Math.max(viewportWidth, Math.round(((win.max - win.min) / DAY_MS) * tlZoom));

    tlInner.style.width = gridWidth + 'px';
    tlDates.style.width = gridWidth + 'px';
    tlDates.replaceChildren();
    tlRows.replaceChildren();
    tlRows.style.height = '0px';

    // Date ruler
    const today = startOfToday();
    for (let i = 0; i <= (win.max - win.min) / DAY_MS; i++) {
      const ms = win.min + i * DAY_MS;
      const d = new Date(ms);
      const col = document.createElement('div');
      col.className = 'tk-tl-date';
      col.style.left = Math.round(tlLeftInWindow(ms, win)) + 'px';
      col.style.width = tlZoom + 'px';
      if (ms === today) col.classList.add('today');
      if (d.getDay() === 0 || d.getDay() === 6) col.classList.add('weekend');
      if (d.getDate() === 1) col.classList.add('month-start');
      const dow = document.createElement('span');
      dow.className = 'tk-tl-dow';
      dow.textContent = WEEKDAYS[d.getDay()].slice(0, 1);
      const num = document.createElement('span');
      num.className = 'tk-tl-num';
      num.textContent = (d.getMonth() + 1) + '/' + d.getDate();
      col.append(dow, num);
      tlDates.append(col);
    }

    // One track per task: no row packing, so a bar can never hide behind another
    // and every deadline stays readable.
    tasks.forEach((task) => {
      const row = document.createElement('div');
      row.className = 'tk-tl-row';
      row.dataset.id = task.id;

      const mark = document.createElement('div');
      mark.className = 'tk-tl-today-line';
      mark.style.transform = 'translateX(' + Math.round(tlLeftInWindow(today, win) + tlZoom / 2) + 'px)';
      row.append(mark);

      const bar = document.createElement('div');
      bar.className = 'tk-tl-bar urgency-' + urgencyOf(task.deadline, Date.now());
      bar.dataset.id = task.id;
      const label = document.createElement('span');
      label.className = 'tk-tl-bar-label';
      label.textContent = task.name;
      bar.append(label);

      const span = spanOf(task);
      if (!span) {
        bar.classList.add('invalid');
        bar.style.transform = 'translateX(0px)';
        bar.style.width = '24px';
      } else {
        placeBar(bar, task, win);
      }

      // Press and release without movement opens the editor; movement moves the
      // dates. The decision is only made on mouseup, so a click stays a click.
      let armed = false;
      let moved = false;
      let grabX = 0;
      let originStartDay = '';
      let originEndDay = '';

      const onMove = (event) => {
        if (!armed) return;
        const dx = event.clientX - grabX;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        document.body.classList.add('tk-dragging');
        const shiftDays = Math.round(dx / tlZoom);
        bar.style.transform = 'translateX(' + Math.round(tlLeftInWindow(dayStart(originStartDay), win) + shiftDays * tlZoom) + 'px)';
      };

      const onUp = (event) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('tk-dragging');
        if (!armed) return;
        armed = false;
        if (!moved) { openTask(task.id); return; }

        const shiftDays = Math.round((event.clientX - grabX) / tlZoom);
        if (shiftDays === 0) { renderTimekeeping(); return; }

        // The one real write in this panel. A whole-bar drag means "move this
        // interval, keep its duration", so both ends travel together.
        //
        // DELIBERATE DIVERGENCE from the original, do not "restore fidelity" here.
        // The original leaves a startless task startless and moves it by rewriting
        // createdAt (ProjectDeadlines.svelte:546-555). We refuse to touch createdAt
        // — it is provenance, and countdown progress is measured from it, so moving
        // it would rewrite the task's countdown history behind the user's back.
        // Scheduling intent is what `start` means, so this first deliberate drag
        // materialises a real start at the shifted effective start it was drawn
        // from. It stays startless until the user actually moves it.
        Store.updateTask(task.id, {
          start: shiftDay(originStartDay, shiftDays),
          deadline: shiftDay(originEndDay, shiftDays),
        });
        refreshAfterWrite();
      };

      bar.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        armed = true;
        moved = false;
        grabX = event.clientX;
        // Anchor on the span that is actually drawn, so the interval the user
        // grabbed is the interval that moves, and a startless task's materialised
        // start lands exactly where its bar already was.
        originStartDay = dayString(new Date((span ? span.start : startOfToday())));
        originEndDay = dayString(new Date((span ? span.end : startOfToday())));
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      row.append(bar);
      tlRows.append(row);
    });

    tlRows.style.height = tasks.length * 34 + 'px';

    if (!tlCentered) {
      tlCentered = true;
      scrollTimelineToToday(false);
    } else {
      tickTimekeeping();
    }
  }

  function shiftDay(day, days) {
    return dayString(new Date(dayStart(day) + days * DAY_MS));
  }

  function scrollTimelineToToday(smooth) {
    const win = tlWindow();
    const target = Math.max(0, tlLeftInWindow(startOfToday(), win) - 100);
    if (tlViewport.scrollTo && smooth) tlViewport.scrollTo({ left: target, behavior: 'smooth' });
    else tlViewport.scrollLeft = target;
    tickTimekeeping();
  }

  // ── Panel 3: Countdowns ───────────────────────────────────────────────────
  // Deadlines as urgency rather than position. A card only exists to be updated;
  // the group it sits in is decided by the wall clock, so crossing a boundary
  // re-groups the list and writes nothing.

  function buildCountdownCard(task) {
    const card = document.createElement('div');
    card.className = 'tk-cd-card';
    card.dataset.id = task.id;

    const info = document.createElement('div');
    info.className = 'tk-cd-info';
    const name = document.createElement('div');
    name.className = 'tk-cd-name';
    name.textContent = task.name;
    const date = document.createElement('div');
    date.className = 'tk-cd-date';
    const project = Store.projects().find((p) => p.id === task.project);
    date.textContent = 'Due ' + shortDay(task.deadline) + (project ? ' · ' + project.name : '');
    info.append(name, date);

    const right = document.createElement('div');
    right.className = 'tk-cd-right';
    const timer = document.createElement('div');
    timer.className = 'tk-cd-timer';
    const track = document.createElement('div');
    track.className = 'tk-cd-track';
    const fill = document.createElement('div');
    fill.className = 'tk-cd-fill';
    track.append(fill);
    right.append(timer, track);

    card.append(info, right);
    card.__timer = timer;
    card.__fill = fill;
    card.addEventListener('click', () => openTask(task.id));
    return card;
  }

  function renderCountdowns(tasks) {
    const host = $('#cdGroups');
    host.replaceChildren();
    const now = Date.now();
    const byGroup = new Map(URGENCY_GROUPS.map((g) => [g.key, []]));
    tasks.forEach((task) => byGroup.get(urgencyOf(task.deadline, now)).push(task));

    URGENCY_GROUPS.forEach((group) => {
      const list = byGroup.get(group.key);
      if (list.length === 0) return;

      const section = document.createElement('section');
      section.className = 'tk-group urgency-' + group.key;

      // Informational header, exactly as the original: a label and a count, not
      // a control. There is nothing to collapse.
      const head = document.createElement('div');
      head.className = 'tk-group-head';
      head.dataset.group = group.key;
      const title = document.createElement('span');
      title.className = 'tk-group-title';
      title.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'tk-group-count';
      count.textContent = String(list.length);
      head.append(title, count);

      const items = document.createElement('div');
      items.className = 'tk-group-items';
      list.forEach((task) => items.append(buildCountdownCard(task)));

      section.append(head, items);
      host.append(section);
    });

    countdownSignature = countdownSignatureOf(byGroup);
    tickTimekeeping();
  }

  /** Identity of the current grouping: when it changes, the list must be rebuilt. */
  function countdownSignatureOf(byGroup) {
    return URGENCY_GROUPS.map((g) => g.key + ':' + byGroup.get(g.key).map((t) => t.id).join(',')).join('|');
  }

  // ── The live layer ────────────────────────────────────────────────────────
  /**
   * Everything that changes with the clock, applied by mutating nodes that are
   * already on screen. Nothing here creates, replaces or removes an element, so
   * a scrolled timeline and a half-collapsed countdown list survive every tick.
   */
  function tickTimekeeping() {
    if (!deadlineTasks().length) return;
    const now = Date.now();

    if (panels.timeline) {
      const win = tlWindow();
      $$('.tk-tl-row').forEach((row) => {
        const task = Store.task(row.dataset.id);
        const bar = row.querySelector('.tk-tl-bar');
        if (!task || !bar) return;
        const geometry = barGeometry(task, win);
        if (!geometry) return;
        bar.style.transform = 'translateX(' + Math.round(geometry.left) + 'px)';
        bar.style.width = Math.round(geometry.width) + 'px';
        const mark = row.querySelector('.tk-tl-today-line');
        if (mark) mark.style.transform = 'translateX(' + Math.round(tlLeftInWindow(startOfToday(), win) + tlZoom / 2) + 'px)';
      });
    }

    if (panels.calendar) {
      $$('.tk-cal-chip').forEach((chip) => retuneChip(chip, now));
    }

    if (panels.countdown) {
      const groups = new Map(URGENCY_GROUPS.map((g) => [g.key, []]));
      deadlineTasks().forEach((task) => groups.get(urgencyOf(task.deadline, now)).push(task));
      if (countdownSignatureOf(groups) !== countdownSignature) {
        // The clock moved tasks between bands: only now is a rebuild warranted.
        renderCountdowns(deadlineTasks());
        return;
      }
      $$('.tk-cd-card').forEach((card) => {
        const task = Store.task(card.dataset.id);
        if (!task) return;
        const deadlineMs = dayStart(task.deadline);
        const diff = deadlineMs - now;
        card.__timer.textContent = formatCountdown(diff);
        // Progress runs from the day the task was created to its deadline, as the
        // original does, whatever start the task may also carry. That is why
        // createdAt must stay immutable: this measurement would otherwise change
        // under a scheduling gesture. `start` governs where the bar is drawn, not
        // this clock.
        const createdMs = new Date(task.createdAt).getTime();
        const total = deadlineMs - createdMs;
        const elapsed = now - createdMs;
        const progress = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 1;
        card.__fill.style.width = Math.round(progress * 100) + '%';
        card.style.background = urgencyTint(diff);
      });
    }
  }

  function urgencyTint(diffMs) {
    return 'linear-gradient(90deg, ' + urgencyTintColor(diffMs) + ', transparent 60%)';
  }

  /** A very light wash of the band colour, so cards read at a glance. */
  function urgencyTintColor(diffMs) {
    const days = diffMs / DAY_MS;
    const key = days < 0 ? 'overdue' : days < 1 ? 'today' : days < 3 ? 'soon' : days < 7 ? 'week' : 'later';
    return URGENCY_COLOR[key] + '29';
  }

  function retuneChip(chip, now) {
    const urgency = urgencyOf(chip.dataset.deadline, now);
    ['overdue', 'today', 'soon', 'week', 'later'].forEach((key) => chip.classList.toggle('urgency-' + key, key === urgency));
  }

  /** Full pass over both surfaces; used after any change to the task set. */
  function refreshTimekeeping() {
    if (isTimekeeping()) renderTimekeeping();
  }

  /** A write landed: re-read it everywhere it can show up. */
  function refreshAfterWrite() {
    render();
    if (isTimekeeping()) renderTimekeeping();
  }

  const isTimekeeping = () => $('[data-sub="timekeeping"]').classList.contains('active');

  // ── Sub-tab wiring ────────────────────────────────────────────────────────
  function showSurface(surface) {
    $$('.seg[data-sub]').forEach((tab) => tab.classList.toggle('active', tab.dataset.sub === surface));
    const elastic = surface === 'elastic';
    columns.hidden = !elastic;
    $('#boardHead').hidden = !elastic;
    $('#runbar').hidden = !elastic;
    $('#tkHead').hidden = elastic;
    $('#timekeeping').hidden = elastic;
    if (elastic) {
      $('#boardTitle').textContent = 'Elastic Boards';
      $('#boardSub').textContent = 'Backlog, live execution and finished work.';
      paint();
    } else {
      $('#boardTitle').textContent = 'Deadlines';
      $('#boardSub').textContent = 'Calendar, timeline and countdowns, in any combination.';
      renderTimekeeping();
    }
  }

  $$('.seg[data-sub]').forEach((tab) => {
    tab.addEventListener('click', () => showSurface(tab.dataset.sub));
  });

  $$('.tk-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.panel;
      // Every panel toggles on its own and any combination is allowed — but not
      // none. Switching the last one off puts the timeline back, which is what
      // the original does; Store.setViews enforces the same rule on the way in.
      const next = { ...panels, [key]: !panels[key] };
      Object.assign(panels, Store.setViews(next));
      syncPanelVisibility();
      renderTimekeeping();
      if (key === 'timeline' && panels.timeline && !tlCentered) scrollTimelineToToday(false);
    });
  });

  $('#calPrev').addEventListener('click', () => {
    calCursor.m -= 1;
    if (calCursor.m < 0) { calCursor.m = 11; calCursor.y -= 1; }
    renderCalendar(deadlineTasks());
  });
  $('#calNext').addEventListener('click', () => {
    calCursor.m += 1;
    if (calCursor.m > 11) { calCursor.m = 0; calCursor.y += 1; }
    renderCalendar(deadlineTasks());
  });
  $('#calToday').addEventListener('click', () => {
    const now = new Date();
    calCursor.y = now.getFullYear();
    calCursor.m = now.getMonth();
    renderCalendar(deadlineTasks());
  });

  $('#tlZoomIn').addEventListener('click', () => {
    tlZoom = Math.min(160, Math.round(tlZoom * 1.25));
    renderTimeline(deadlineTasks());
  });
  $('#tlZoomOut').addEventListener('click', () => {
    tlZoom = Math.max(16, Math.round(tlZoom * 0.8));
    renderTimeline(deadlineTasks());
  });
  $('#tlToday').addEventListener('click', () => scrollTimelineToToday(true));

  // Panning is view state only: it moves the bars' projection, never a task.
  tlViewport.addEventListener('scroll', () => tickTimekeeping());

  // The composition the reader last built comes back from the store; a fresh
  // store yields the default (timeline only), and all-off can never be loaded.
  // This is a plain read — launching the app writes nothing.
  Object.assign(panels, Store.views());
  syncPanelVisibility();
  ensureTarget();
  refreshProjectOptions();
  if (Store.run()) ticker = setInterval(tick, 1000);
  showSurface('elastic');
  render();
  // Both surfaces share one clock. Nothing about a tick writes or rebuilds.
  setInterval(() => {
    if (isTimekeeping()) tickTimekeeping();
  }, 1000);
})();
