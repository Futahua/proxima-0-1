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
   *
   * The stored dates are reported AS THEY ARE. There used to be a
   * `Math.max(start, end)` here, which silently dragged a reversed deadline up to
   * equal the start: a task that cannot exist was drawn as a plausible block,
   * nowhere near the deadline it claimed. Contradictory data is now flagged by
   * `reversed` and rendered as visibly wrong instead of being normalised away.
   * Only the RENDERED width is clamped, never the data.
   */
  function spanOf(task) {
    const end = dayStart(task.deadline);
    if (Number.isNaN(end)) return null;
    let start = dayStart(task.start);
    if (Number.isNaN(start)) start = dayStart(String(task.createdAt || '').slice(0, 10));
    if (Number.isNaN(start)) start = startOfToday();
    return { start, end, reversed: end < start };
  }

  /** Short, unambiguous date for a message: "15 Sep 2026". */
  const readableDay = (value) => {
    const ms = dayStart(value);
    if (Number.isNaN(ms)) return String(value || '—');
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  /** True when a task's stored dates contradict each other. */
  const isReversed = (task) => {
    const span = spanOf(task);
    return Boolean(span && span.reversed);
  };

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

  /**
   * The instant a date-only deadline actually expires: the END of that day.
   *
   * A stored deadline is a plain YYYY-MM-DD, and `dayStart` turns it into local
   * midnight. Measuring urgency from that midnight made a task due on the 13th
   * overdue at 00:00 on the 13th — technically consistent, and wrong for everyone
   * who reads "due the 13th" as "you have the 13th". So deadlines are measured to
   * the end of their day; `dayStart` stays what it is, because span geometry,
   * calendar placement and the Gantt all legitimately mean the start of a day.
   */
  const dayEnd = (value) => {
    const ms = dayStart(value);
    return Number.isNaN(ms) ? NaN : ms + DAY_MS;
  };

  /** Whole days from `fromMs` to a deadline's expiry, negative once past. */
  function daysUntil(deadline, fromMs) {
    const ms = dayEnd(deadline);
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
  /** Packed row per visible task, refreshed by every timeline render. */
  let timelineRows = new Map();
  /** The task whose bar is under the hand, so a tick leaves its position alone. */
  let tlDraggingId = null;

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
   * Read the running column's real client height, and give it back to the column
   * as a definite height.
   *
   * The write matters. The cards are in flow now, so if the column sized itself to
   * them H would depend on the current allocation — the loop that produced the
   * original feedback bug — AND the flex algorithm would have no free space left
   * to distribute, collapsing every card onto its floor. Pinning the measured
   * height keeps H independent of the cards, which is what makes the ratios apply.
   *
   * Never measure mid-layout with a stale number: if the host collapsed, fall back
   * to the last good reading, and otherwise to the 300px baseline the original
   * uses when it has none.
   */
  function measureRunningHeight() {
    const host = runningHost();
    const measured = host ? host.clientHeight : 0;
    if (measured > 0) runningHeight = measured;
    const H = runningHeight > 0 ? runningHeight : MIN_CONTAINER_HEIGHT;
    if (host && Math.abs((parseFloat(host.style.height) || 0) - H) > 0.5) host.style.height = H + 'px';
    return H;
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
   * A locked run's frozen plan. Returns null when there is no run, and
   * `{ legacy: true }` when a run was stored before snapshots existed — such a
   * run has no roster, so it cannot be rendered honestly and says so instead of
   * re-deriving membership from live state (which is the bug the snapshot fixes).
   */
  function lockedPlan() {
    const run = Store.run();
    if (!run) return null;
    if (!Array.isArray(run.members)) return { legacy: true, run };
    return {
      legacy: false,
      run,
      members: run.members,
      from: new Date(run.lockedAt).getTime(),
      target: fromLocalInput(run.target),
      total: run.total || 0,
    };
  }

  /** The tasks an unlocked board currently has running — used for planning only. */
  function liveRunning() {
    return visibleTasks().filter((t) => t.status === 'running');
  }

  /**
   * The allocation model for one pass.
   *
   * While a run is locked this reads the SNAPSHOT and nothing else: membership,
   * order, weights and durations are all the ones frozen at lock time. Live task
   * state cannot influence it, which is what makes the lock mean something.
   */
  function allocations() {
    const plan = lockedPlan();
    const H = measureRunningHeight();

    if (plan && !plan.legacy) {
      const durations = new Map(plan.members.map((m) => [m.id, m.duration]));
      // A member whose task no longer exists is not rendered — there is no card to
      // draw — so the remaining slots are scaled to fill the column rather than
      // leaving a gap for something that is gone. The snapshot itself is untouched;
      // this only decides what the surviving plan looks like.
      const present = plan.members.filter((m) => Store.task(m.id));
      const presentTotal = present.reduce((sum, m) => sum + m.duration, 0);
      const heights = new Map();
      plan.members.forEach((m) => {
        if (!Store.task(m.id)) return;
        heights.set(m.id, Math.max(MIN_CARD_HEIGHT, presentTotal > 0 ? (m.duration / presentTotal) * H : 0));
      });
      return {
        locked: true,
        plan,
        members: plan.members,
        presentMembers: present,
        durations,
        total: plan.total,
        presentTotal: presentTotal,
        available: plan.target ? Math.max(0, plan.target.getTime() - plan.from) : 0,
        from: new Date(plan.from),
        target: plan.target,
        height: H,
        heights,
        progress: progressForPlan(plan),
      };
    }

    const running = liveRunning();
    const from = new Date();
    const target = fromLocalInput(targetInput.value);
    const available = target ? Math.max(0, target - from) : 0;
    const { items: durations, total } = timelineFor(running, from, target);
    return {
      locked: false,
      plan: plan || null,
      members: null,
      durations,
      total,
      available,
      from,
      target,
      height: H,
      heights: heightsFor(running, durations, total, H),
      progress: new Map(),
    };
  }

  /**
   * Progress straight off the frozen plan: each member's slot has a fixed start
   * and end instant, so elapsed time indexes into it directly. No live task is
   * consulted, so a task that joined late cannot inherit earlier progress.
   */
  function progressForPlan(plan) {
    const ratios = new Map();
    const now = Date.now();
    plan.members.forEach((member) => {
      if (!member.duration || member.duration <= 0) { ratios.set(member.id, 0); return; }
      if (now >= member.endsAt) ratios.set(member.id, 1);
      else if (now <= member.startsAt) ratios.set(member.id, 0);
      else ratios.set(member.id, Math.min(1, Math.max(0, (now - member.startsAt) / member.duration)));
    });
    return ratios;
  }

  /**
   * Everything one painting pass needs. Deliberately free of DOM writes so the
   * same model can serve both a full rebuild and a tick that only restyles.
   */
  function viewModel() {
    const tasks = visibleTasks();
    const allocation = allocations();

    // The running column is the plan's members, not "whatever says running".
    // Membership comes from the snapshot, so filtering the view cannot redefine a
    // locked run and a reload cannot silently adopt another project's tasks.
    const running = [];
    const seen = new Set();
    if (allocation.locked) {
      allocation.members.forEach((member) => {
        const task = Store.task(member.id);
        if (task && !seen.has(task.id)) { seen.add(task.id); running.push(task); }
      });
    } else {
      tasks.filter((t) => t.status === 'running').forEach((t) => { seen.add(t.id); running.push(t); });
    }
    // Anyone who reached Running after the lock is not part of the plan. They are
    // still shown, flagged, rather than hidden or quietly given a slice.
    const outsiders = tasks.filter((t) => t.status === 'running' && !seen.has(t.id));

    return { tasks, running, outsiders, allocation, run: allocation.locked || (allocation.plan && allocation.plan.legacy) ? Store.run() : null };
  }

  /** What one running task owns: its slice of duration, or of weight with no target. */
  function shareFor(task, allocation) {
    const duration = allocation.durations.get(task.id);
    if (duration !== undefined) return duration;
    if (allocation.locked) return null; // not in the plan: it owns no slice
    const totalWeight = liveRunning().reduce((sum, t) => sum + t.weight, 0) || 1;
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
    if (run && allocation.locked) {
      const total = allocation.available;
      const left = Math.max(0, total - (Date.now() - allocation.from.getTime()));
      // Count what is actually on the board, not what was frozen: a member whose
      // task was deleted is gone, and saying "3 tasks in the plan" over two cards
      // would be its own small lie.
      const active = (allocation.presentMembers || []).filter((m) => {
        const task = Store.task(m.id);
        return task && task.status === 'running';
      }).length;
      const frozen = (allocation.presentMembers || []).length;
      const dropped = frozen - active;
      const roster = active + (active === 1 ? ' task' : ' tasks') + ' in the plan' +
        (dropped > 0 ? ', ' + dropped + ' no longer running' : '');
      return left > 0
        ? 'Locked — ' + humanDuration(left) + ' left of ' + humanDuration(total) + ', ' + roster
        : 'Run finished — the target has passed. ' + roster + '.';
    }
    if (run) {
      // A run stored before plans were snapshotted. It cannot be rendered from a
      // roster it never recorded, so say that rather than invent one.
      return 'Locked, but this run was stored before plans were snapshotted — it has no frozen roster. Unlock and lock again.';
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

    // A run stored before plans were snapshotted has no roster to lay out. The
    // line under the button explains it; nothing is invented here.
    if (view.run && !view.allocation.locked) {
      runInfo.textContent = runLine(view);
      return;
    }

    // Heights are written, but the cards stay IN FLOW with no `top` — that is the
    // point of the change. An absolute card cannot be pushed aside by the drop
    // placeholder, so the column had to look like it was refusing the drop.
    view.running.forEach((task) => {
      const card = host.querySelector('.card[data-id="' + task.id + '"]');
      if (!card) return;
      const height = Math.round(view.allocation.heights.get(task.id) || MIN_CARD_HEIGHT);
      card.style.height = height + 'px';
      // A floor-height card has no room for its footer; hide it rather than spill.
      card.classList.toggle('tight', height < 132);
      paintWipe(card, view.allocation.progress.get(task.id) || 0);
    });

    // Anything that reached Running after the lock is not in the plan: it has no
    // slice and no progress, and it never will have had any. It still occupies a
    // normal slot, flagged, so it is never hidden.
    view.outsiders.forEach((task) => {
      const card = host.querySelector('.card[data-id="' + task.id + '"]');
      if (!card) return;
      card.style.height = MIN_CARD_HEIGHT + 'px';
      card.classList.add('tight');
      paintWipe(card, 0);
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
    const { tasks, running, outsiders, allocation, run } = viewModel();

    // A rebuild replaces every column's children, so any drop highlight left on
    // the previous nodes would survive as a stale tint on the column.
    $$('.cards').forEach((c) => c.classList.remove('over'));

    $('#taskCount').textContent = tasks.length + (tasks.length === 1 ? ' task' : ' tasks');
    const active = Store.projects().find((p) => p.id === projectFilter.value);
    $('#scopeLabel').textContent = active ? active.name.toUpperCase() : 'ALL PROJECTS';

    ['backlog', 'running', 'finished'].forEach((status) => {
      const host = $('.cards[data-drop="' + status + '"]');
      // Backlog and Finished are the filtered view. Running is not: while a run is
      // locked its roster is the plan, so a member stays on the board even when the
      // project filter excludes it. Otherwise filtering would look like the plan
      // changing, and a reload under a different filter would look like it too.
      const list = status === 'running'
        ? running.concat(outsiders)
        : tasks.filter((t) => t.status === status);
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

  /**
   * Inline plus/minus stepper, clamped at a minimum of one.
   *
   * While a run is locked the stepper is rendered but disabled for participating
   * tasks: their weight is part of the frozen plan, and letting it move would
   * either silently re-plan the run or show a number the plan is ignoring. Both
   * are lies, so the control is inert and says why.
   */
  function stepperFor(task, frozen) {
    const group = document.createElement('span');
    group.className = 'stepper';
    group.title = frozen
      ? 'Weight is part of the locked plan. Unlock to change it.'
      : 'Weight';
    if (frozen) group.classList.add('frozen');

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'step';
    down.textContent = '−';
    down.disabled = frozen || task.weight <= 1;
    down.addEventListener('click', (event) => {
      event.stopPropagation();
      if (frozen) return;
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
    up.disabled = frozen;
    up.addEventListener('click', (event) => {
      event.stopPropagation();
      if (frozen) return;
      Store.updateTask(task.id, { weight: task.weight + 1 });
      render();
    });

    group.append(down, value, up);
    return group;
  }

  function cardFor(task, allocatedMs, run, from, allocation) {
    const card = document.createElement('article');
    card.className = 'card ' + task.status;
    card.dataset.id = task.id;

    const isRunning = task.status === 'running';
    const locked = isRunning && Boolean(run);
    const inPlan = locked && Boolean(allocation && allocation.locked && allocation.durations.has(task.id));
    const outsider = locked && !inPlan;

    // A participating task is part of a frozen plan: it must not be draggable
    // into another column, because that would rewrite the run's roster after the
    // fact. Its weight stepper is disabled for the same reason.
    card.draggable = !inPlan;
    if (inPlan) card.classList.add('locked-member');
    if (outsider) card.classList.add('not-in-plan');

    if (locked && allocation && allocation.locked) {
      // Same path the tick uses, so a rebuild and a restyle agree on the wipe.
      paintWipe(card, allocation.progress.get(task.id) || 0);
    }

    // Everything a click should still reach sits above the wipe.
    const body = document.createElement('div');
    body.className = 'body';

    const kind = document.createElement('p');
    kind.className = 'kind';
    kind.textContent = outsider ? 'RUNNING — NOT IN THE LOCKED PLAN' : task.status.toUpperCase();
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
    if (isRunning) acts.append(stepperFor(task, inPlan));

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete task';
    del.textContent = '×';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      // Deleting a plan member is allowed: it is a data operation, not a re-plan,
      // and the run ends honestly rather than keeping a slot for a task that is
      // gone. See endRunIfEmpty().
      if (Store.deleteTask(task.id)) { render(); endRunIfEmpty(); }
    });
    acts.append(del);
    card.append(acts);

    card.addEventListener('click', () => openTask(task.id));
    return card;
  }

  let dragId = null;
  let placeholder = null;

  /** The gap a drop opens: capped, so a tall card cannot tear the list apart. */
  const PLACEHOLDER_MAX = 90;
  const AUTOSCROLL_EDGE = 60;
  const AUTOSCROLL_STEP = 8;

  /**
   * Scroll a list while the pointer is held near its top or bottom edge, so a
   * column taller than the viewport keeps coming to meet the hand. Called before
   * the insertion point is resolved, so the index is computed against the position
   * the list is moving to rather than the one it is leaving.
   */
  function autoScrollVert(event, host) {
    const rect = host.getBoundingClientRect();
    if (event.clientY > rect.bottom - AUTOSCROLL_EDGE) host.scrollTop += AUTOSCROLL_STEP;
    else if (event.clientY < rect.top + AUTOSCROLL_EDGE) host.scrollTop -= AUTOSCROLL_STEP;
  }

  columns.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
    // A plan member is not draggable — the card is built with draggable=false, and
    // this is the belt to that braces: a drag must never be able to rewrite the
    // roster of a locked run.
    if (card.classList.contains('locked-member')) {
      event.preventDefault();
      return;
    }
    dragId = card.dataset.id;
    card.classList.add('dragging');
    placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    // Capped at 90px rather than the card's full height. Running cards are
    // hundreds of pixels tall because height encodes allocation, so an uncapped
    // placeholder tore a 250-400px cavity into the destination list and threw
    // everything away from the pointer.
    placeholder.style.height = Math.min(PLACEHOLDER_MAX, card.getBoundingClientRect().height) + 'px';
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
    autoScrollVert(event, host);
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
    // Dropping into Running while locked would add a task to a roster that is
    // supposed to be frozen. Refuse it where the reader is looking, rather than
    // admit a task the plan cannot give a slice to.
    if (host.dataset.drop === 'running' && lockedPlan()) {
      if (placeholder) placeholder.remove();
      dragId = null;
      $$('.cards').forEach((c) => c.classList.remove('over'));
      render();
      flash('The running column is a locked plan — unlock to change who is in the run.', host);
      return;
    }
    const next = placeholder ? placeholder.nextElementSibling : null;
    const beforeId = next && next.classList.contains('card') ? next.dataset.id : null;
    Store.moveTask(dragId, host.dataset.drop, beforeId);
    dragId = null;
    render();
    endRunIfEmpty();
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
    // An existing reversed task opens showing its contradiction, rather than
    // hiding it behind a tidy value the user never entered.
    validateTaskDates();
    taskDialog.showModal();
  }

  /**
   * A task cannot be due before it starts, and the dialog says so in words rather
   * than reverting or coercing either date. Returns true when the form is sane.
   */
  function validateTaskDates() {
    const start = taskForm.elements.start.value;
    const deadline = taskForm.elements.deadline.value;
    const error = $('#taskDateError');
    if (!start || !deadline) { error.hidden = true; return true; }
    if (dayStart(deadline) < dayStart(start)) {
      error.textContent = 'The deadline (' + readableDay(deadline) + ') is before the start (' +
        readableDay(start) + '). A task cannot be due before it begins — move one of the dates.';
      error.hidden = false;
      return false;
    }
    error.hidden = true;
    return true;
  }

  // Live, so the contradiction is named before the user tries to save.
  taskForm.elements.start.addEventListener('change', validateTaskDates);
  taskForm.elements.deadline.addEventListener('change', validateTaskDates);

  taskForm.addEventListener('submit', (event) => {
    const action = event.submitter ? event.submitter.value : 'save';
    // Cancel and Delete keep the form's own dialog behaviour.
    if (action === 'cancel' || action === 'delete') {
      if (action === 'delete') {
        if (editingId) Store.deleteTask(editingId);
        queueMicrotask(renderEverything);
      }
      return;
    }

    // A save is ours to complete. The form is `method="dialog"`, so letting the
    // submit through would close the dialog even when the save is refused, taking
    // the explanation with it. Hold the dialog open and close it ourselves once
    // the write has actually happened.
    event.preventDefault();
    if (!validateTaskDates()) return;

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
    taskDialog.close();
    queueMicrotask(renderEverything);
    // Editing a plan member's status is how it leaves the run. If that was the
    // last one, the run is over and says so rather than ticking against nobody.
    queueMicrotask(endRunIfEmpty);
  });

  projectForm.addEventListener('submit', (event) => {
    if (!event.submitter || event.submitter.value !== 'save') return;
    Store.addProject(projectForm.elements.name.value);
    projectForm.reset();
    queueMicrotask(() => { refreshProjectOptions(); renderEverything(); });
  });

  $('#newTaskBtn').addEventListener('click', () => openTask(null));
  $('#newProjectBtn').addEventListener('click', () => projectDialog.showModal());
  // The project filter scopes the whole page, board and panels alike.
  projectFilter.addEventListener('change', renderEverything);
  // A new target is a new horizon: every proportional share changes with it.
  targetInput.addEventListener('change', render);
  // A resize only changes how tall the running column is, so restyle rather than
  // rebuild — otherwise resizing would also throw away the reader's scroll spot.
  window.addEventListener('resize', () => {
    runningHeight = 0;
    paint();
  });

  /**
   * Freeze the current running set into a plan: the participating task ids, their
   * order, their weights, and the duration each is given over the horizon — plus
   * the resolved start and end instant of every slot, so progress can be read off
   * the plan without consulting live tasks at all.
   */
  function snapshotPlan(targetValue) {
    const lockedAt = new Date();
    const target = fromLocalInput(targetValue);
    const running = liveRunning();
    if (running.length === 0) return null;
    if (!target || target <= lockedAt) return null;

    const totalMs = target.getTime() - lockedAt.getTime();
    const totalWeight = running.reduce((sum, t) => sum + t.weight, 0) || 1;
    let cursor = lockedAt.getTime();
    let total = 0;
    const members = running.map((task) => {
      const duration = (task.weight / totalWeight) * totalMs;
      const startsAt = cursor;
      const endsAt = cursor + duration;
      cursor = endsAt;
      total += duration;
      return {
        id: task.id,
        name: task.name,
        weight: task.weight,
        duration,
        startsAt,
        endsAt,
      };
    });
    return { lockedAt: lockedAt.toISOString(), target: targetValue, members: members, total: total };
  }

  /**
   * A locked run whose members have all left — finished, dragged out or deleted —
   * is over. End it and say so, rather than leaving a live run that is consuming
   * time for nobody and would hand that elapsed time to the next task to arrive.
   */
  function endRunIfEmpty() {
    const plan = lockedPlan();
    if (!plan || plan.legacy) return false;
    const remaining = plan.members.filter((m) => {
      const task = Store.task(m.id);
      return task && task.status === 'running';
    });
    if (remaining.length > 0) return false;
    Store.setRun(null);
    clearInterval(ticker);
    ticker = null;
    render();
    runInfo.textContent = 'The run ended: none of its planned tasks are still in the running column.';
    return true;
  }

  lockBtn.addEventListener('click', () => {
    if (Store.run()) {
      Store.setRun(null);
      clearInterval(ticker);
      ticker = null;
    } else {
      const target = fromLocalInput(targetInput.value);
      // These go through the flash channel rather than the line under the button:
      // that line is rewritten by the next tick, so a refusal written there was
      // erased about a second later — visible just long enough to be missed.
      if (!target || target <= new Date()) {
        flash('Pick a target in the future before locking.', targetInput);
        return;
      }
      // Locking nothing is not a run: there is no plan to freeze and no one to
      // consume the horizon. Refuse it instead of storing a run with no members.
      if (liveRunning().length === 0) {
        flash('Nothing to lock — no tasks are in the running column.', lockBtn);
        return;
      }
      const plan = snapshotPlan(targetInput.value);
      if (!plan) {
        flash('Pick a target in the future before locking.', targetInput);
        return;
      }
      Store.setRun(plan);
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
    // What this counts is exactly what the panels can show: open tasks carrying a
    // deadline. Finished work is excluded (as the original excludes it), so the
    // board above can legitimately show more tasks than this number — the label
    // says which, rather than claiming to count the board.
    $('#tkCount').textContent = tasks.length === 0
      ? 'No open tasks with deadlines'
      : tasks.length + (tasks.length === 1 ? ' task with a deadline' : ' tasks with deadlines');

    // The message and the panels are mutually exclusive: one or the other, never
    // both. `hidden` is set on both, every pass.
    const anyDeadline = tasks.length > 0;
    $('#tkEmpty').hidden = anyDeadline;
    $('#tkPanels').hidden = !anyDeadline;

    if (panels.calendar) renderCalendar(tasks);
    if (panels.timeline) renderTimeline(tasks);
    if (panels.countdown) renderCountdowns(tasks);

    // Paint the live layer once so the panels never show a stale second.
    tickTimekeeping();
  }

  // ── Refusals ──────────────────────────────────────────────────────────────
  // One channel for every refused action in the app: a small chip near whatever
  // was touched, gone on its own after a few seconds. It replaced a full-width
  // red banner that carried the same visual weight as a real error and sat above
  // the whole panel, which is far too loud for "that gesture did not apply".
  let flashTimer = 0;

  /**
   * Say something to the reader. `anchor` is the element they touched, so the
   * message appears where their attention already is; without one it appears under
   * the top bar.
   *
   * Transient by default — nothing to dismiss, nothing lingering to be mistaken
   * for live state. `sticky` is for conditions that are still true after you have
   * read them (a store that could not be read, a write that is still failing):
   * those must not evaporate, or the reader is back to not being told.
   */
  function flash(text, anchor, options) {
    const el = $('#flash');
    if (!el) return;
    const opts = options || {};
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle('warn', Boolean(opts.warn));
    el.classList.toggle('sticky', Boolean(opts.sticky));
    // Measure only after it has content, so the placement is right first time.
    const box = el.getBoundingClientRect();
    let left = Math.round((window.innerWidth - box.width) / 2);
    let top = 68;
    if (anchor && anchor.isConnected) {
      const a = anchor.getBoundingClientRect();
      left = Math.round(a.left + a.width / 2 - box.width / 2);
      top = Math.round(a.top - box.height - 8);
      // Keep it on screen, and below the bar if there is no room above.
      if (top < 8) top = Math.round(a.bottom + 8);
    }
    el.style.left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) + 'px';
    window.clearTimeout(flashTimer);
    if (!opts.sticky) flashTimer = window.setTimeout(() => { el.hidden = true; }, opts.hold || 5000);
  }

  // ── Store integrity ───────────────────────────────────────────────────────
  // Every mutation goes through the store's commit(), which rolls the whole state
  // back when the write fails. So a failed write can no longer leave the board
  // showing work that is not saved — but silence would be just as bad in the other
  // direction, so the failure is announced here, once, from one place.
  Store.onWriteFailure((failure) => {
    flash('Not saved — the browser refused the write (' + failure.reason +
      '). The change has been undone so nothing on screen is unsaved. Free some storage or check site permissions, then try again.',
      null, { sticky: true, warn: true });
  });

  /** Report a store that could not be read, instead of showing an empty app. */
  function reportLoadStatus() {
    const status = Store.loadStatus();
    if (status.kind === 'corrupt') {
      flash('Your saved data could not be read, so this is an empty board — nothing has been deleted. ' +
        (status.rescued
          ? 'The original bytes were copied to localStorage key "proxima.store.unreadable" before anything could overwrite them.'
          : 'The original bytes are still under "proxima.store.v1"; the rescue copy already existed, so it was left alone.') +
        ' ' + status.detail, null, { sticky: true, warn: true });
      return;
    }
    if (status.kind === 'wrong-version') {
      flash('This board was written by a different version of Proxima, so it has been left untouched rather than shown wrongly. ' +
        (status.rescued ? 'A copy of the original is under "proxima.store.unreadable". ' : '') +
        status.detail, null, { sticky: true, warn: true });
      return;
    }
    if (status.kind === 'ok' && status.notes) {
      const notes = status.notes;
      const parts = [];
      if (notes.unknownStatus) parts.push(notes.unknownStatus + (notes.unknownStatus === 1 ? ' task had a status this board has no column for and was filed under Backlog' : ' tasks had a status this board has no column for and were filed under Backlog'));
      if (notes.droppedTasks) parts.push(notes.droppedTasks + (notes.droppedTasks === 1 ? ' unreadable task record was skipped' : ' unreadable task records were skipped'));
      if (notes.droppedProjects) parts.push(notes.droppedProjects + (notes.droppedProjects === 1 ? ' unreadable project record was skipped' : ' unreadable project records were skipped'));
      if (parts.length) flash(parts.join('; ') + '. Your other data loaded normally.', null, { warn: true, hold: 9000 });
    }
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
      // Draw between the earlier and later of the two dates, so a reversed span's
      // marker lands on the deadline the task claims instead of being anchored to
      // a start that is days away from it. Only the drawn geometry is normalised;
      // `span` carries the stored values through untouched, and the chip is marked
      // invalid so nothing about the contradiction is hidden.
      const from = Math.min(span.start, span.end);
      const to = Math.max(span.start, span.end);
      const clampedStart = Math.max(from, weekStartMs);
      const clampedEnd = Math.min(to, weekEndMs);
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
        if (bar.span.reversed) {
          // Contradictory data: say so, show it where the deadline actually is, and
          // say what to do — the same wording the timeline bar uses, so one state
          // reads the same wherever it appears.
          chip.classList.add('invalid');
          chip.title = bar.task.name + ' — its dates are reversed: it starts ' +
            readableDay(dayString(new Date(bar.span.start))) + ' but is due ' +
            readableDay(dayString(new Date(bar.span.end))) +
            '. Open it to fix the start or the deadline.';
          chip.textContent = '⚠ ' + bar.task.name;
        } else {
          // The tooltip names the same span the bar is drawn from, so a task whose
          // start is resolved through its creation day does not claim to start today.
          chip.title = bar.task.name + ' — ' + shortDay(dayString(new Date(bar.span.start))) +
            ' → ' + shortDay(dayString(new Date(bar.span.end)));
          chip.textContent = bar.task.name;
        }
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

  // ── Row packing ───────────────────────────────────────────────────────────
  // The timeline is a spatial surface, not a list: a task occupies a row, and two
  // tasks may share one only while their spans do not overlap. A row is stored on
  // the task, so it is a scheduling decision that survives filtering and reloads
  // rather than a position recomputed from whatever happens to be on screen.

  const ROW_HEIGHT = 40;

  /** The day span a task occupies, in milliseconds, for overlap tests only. */
  function rowSpanOf(task) {
    const span = spanOf(task);
    if (!span) return null;
    // Reversed spans are compared on the interval they actually cover, so a
    // contradictory task blocks a row for the days it claims rather than
    // vanishing from the collision test.
    return { start: Math.min(span.start, span.end), end: Math.max(span.start, span.end) };
  }

  /**
   * The overlap rule, taken from the original: any touch collides, including a
   * shared endpoint (`start <= item.end && end >= item.start`).
   */
  function rowsCollide(a, b) {
    return a.start <= b.end && a.end >= b.start;
  }

  /**
   * Pack a task into rows without disturbing rows that did not have to move.
   *
   * A task with a stored row keeps it unless something already placed there
   * overlaps it; only then is that task — the one being placed — sent down to the
   * next free row. Tasks are therefore visited in row order, so the ones holding
   * their positions are placed first and the one that has to give way is the one
   * that changed. A task with no row yet (a new one, or one written before rows
   * existed) starts at row 0 and takes the first row that is free.
   *
   * `placed` is the mutable accumulator; pass the same object across a pass to
   * pack a whole set. It records the span each placed task occupies per row, so
   * overlap is tested against what is really there.
   */
  function packTask(task, placed, origin) {
    const span = rowSpanOf(task);
    if (!span) return null;
    const stored = typeof task.ganttRow === 'number' ? task.ganttRow : null;
    let row = stored === null ? 0 : Math.max(0, stored);
    while (true) {
      const occupants = placed.get(row);
      if (!occupants || !occupants.some((other) => other.id !== task.id && rowsCollide(span, other.span))) break;
      row++;
    }
    const list = placed.get(row) || [];
    list.push({ id: task.id, span: span });
    placed.set(row, list);
    if (origin) origin.set(task.id, span);
    return row;
  }

  /**
   * Resolve rows for a whole visible set and persist any that changed.
   *
   * Returns the settled rows, including the highest one in use, without touching
   * the store unless something actually moved — so a re-render with an unchanged
   * layout writes nothing and no bar jumps.
   */
  function resolveRows(tasks) {
    const placed = new Map();
    const order = tasks.slice().sort((a, b) => {
      const ra = typeof a.ganttRow === 'number' ? a.ganttRow : Infinity;
      const rb = typeof b.ganttRow === 'number' ? b.ganttRow : Infinity;
      if (ra !== rb) return ra - rb;
      const sa = rowSpanOf(a);
      const sb = rowSpanOf(b);
      if (sa && sb && sa.start !== sb.start) return sa.start - sb.start;
      return a.order - b.order;
    });

    const rows = new Map();
    const updates = [];
    let maxRow = 0;
    order.forEach((task) => {
      const row = packTask(task, placed);
      if (row === null) return;
      rows.set(task.id, row);
      maxRow = Math.max(maxRow, row);
      if (row !== task.ganttRow) updates.push({ id: task.id, row: row });
    });

    // Persist placements so they survive a filter change or a reload. Kept
    // outside the render pass's own writes, through the one Store path.
    updates.forEach((u) => Store.updateTask(u.id, { ganttRow: u.row }));
    return { rows: rows, maxRow: maxRow, moved: updates.length };
  }

  /**
   * The row a dropped task should end up in: the row the drag asked for, walked
   * down while anything already settled there overlaps it. This is the original's
   * collision rule, applied at drop time rather than invented.
   *
   * `occupied` maps row number to the spans already placed there, and
   * `pendingIds` are the visible tasks not yet placed — a task cannot be dropped
   * on top of either.
   */
  function resolveDroppedRow(taskId, wantedRow, occupied, pendingIds, pending) {
    const me = rowSpanOf(Store.task(taskId));
    if (!me) return Math.max(0, wantedRow);
    let row = Math.max(0, wantedRow);
    while (true) {
      const settled = (occupied.get(row) || []).some((other) => other.id !== taskId && rowsCollide(me, other.span));
      if (settled) { row++; continue; }
      const waiting = pendingIds.some((id) => {
        if (id === taskId) return false;
        const task = pending.get(id);
        const span = task ? rowSpanOf(task) : null;
        return span ? rowsCollide(me, span) : false;
      });
      if (!waiting) return row;
      row++;
    }
  }

  /**
   * What is already settled, for the drop-time collision check: the spans each
   * stored row holds, plus the tasks that have no row yet and so could take any
   * of them. A dropped task must clear both, or it would land on top of a task
   * that is about to be packed.
   */
  function buildPackContext(tasks, movingId) {
    const occupied = new Map();
    const pendingIds = [];
    const pending = new Map();
    tasks.forEach((task) => {
      if (task.id === movingId) return;
      const span = rowSpanOf(task);
      if (!span) return;
      if (typeof task.ganttRow === 'number') {
        const list = occupied.get(task.ganttRow) || [];
        list.push({ id: task.id, span: span });
        occupied.set(task.ganttRow, list);
      } else {
        pendingIds.push(task.id);
        pending.set(task.id, task);
      }
    });
    return { occupied: occupied, pendingIds: pendingIds, pending: pending };
  }

  /**
   * The single place a bar's geometry is decided, shared by build and tick.
   * Width is deadline minus start, with no extra inclusive day: a same-day task
   * spans zero days and is held open only by the visual 24px floor, and a
   * two-day task covers exactly two columns.
   *
   * A reversed span yields a negative width, which the floor turns into a 24px
   * marker. That marker is anchored on the EARLIER of the two dates so it lands on
   * the deadline the task claims — the alternative, anchoring on the start, draws
   * it days away from its own deadline, which hides the contradiction the marker
   * exists to expose. The data is still reported untouched; only the drawn
   * geometry is made presentable, and it is drawn where the user was told to look.
   *
   * The window is finite, so the span is CLIPPED to it — both ends. Clipping only
   * the left edge was a lie: a task that began before the window kept its full
   * width, so a 60-day task ending today appeared to run a month into the future.
   * Clipped ends are reported so the bar can show that it continues off-screen.
   */
  function barGeometry(task, win) {
    const span = spanOf(task);
    if (!span) return null;
    const from = Math.min(span.start, span.end);
    const to = Math.max(span.start, span.end);
    // Width stays exclusive of the end day, as reviewed: a one-day task is one
    // column, a two-day task two. Only the clip is new.
    const rawLeft = tlLeftInWindow(from, win);
    const rawRight = tlLeftInWindow(to, win);
    const windowEnd = tlLeftInWindow(win.max, win);
    const left = Math.max(0, rawLeft);
    const right = Math.min(windowEnd, rawRight);
    return {
      left: left,
      width: Math.max(right - left, 24),
      clippedStart: rawLeft < 0,
      clippedEnd: rawRight > windowEnd,
    };
  }

  function placeBar(bar, task, win) {
    const geometry = barGeometry(task, win);
    if (!geometry) return;
    bar.style.transform = 'translateX(' + Math.round(geometry.left) + 'px)';
    bar.style.width = Math.round(geometry.width) + 'px';
    bar.classList.toggle('clipped-start', geometry.clippedStart);
    bar.classList.toggle('clipped-end', geometry.clippedEnd);
    paintBarClips(bar, geometry);
  }

  /** The arrow that says a bar continues past the window rather than ending here. */
  function paintBarClips(bar, geometry) {
    let head = bar.querySelector('.tk-tl-more-before');
    let tail = bar.querySelector('.tk-tl-more-after');
    if (geometry.clippedStart && !head) {
      head = document.createElement('span');
      head.className = 'tk-tl-more-before';
      head.textContent = '◀';
      bar.prepend(head);
    } else if (!geometry.clippedStart && head) {
      head.remove();
    }
    if (geometry.clippedEnd && !tail) {
      tail = document.createElement('span');
      tail.className = 'tk-tl-more-after';
      tail.textContent = '▶';
      bar.append(tail);
    } else if (!geometry.clippedEnd && tail) {
      tail.remove();
    }
  }

  function renderTimeline(tasks) {
    const win = tlWindow();
    const viewportWidth = tlViewport.clientWidth || 600;
    const gridWidth = Math.max(viewportWidth, Math.round(((win.max - win.min) / DAY_MS) * tlZoom));

    // Rows first: the pack is the layout, and it may write placements back.
    const layout = resolveRows(tasks);
    timelineRows = layout.rows;

    tlInner.style.width = gridWidth + 'px';
    tlDates.style.width = gridWidth + 'px';
    tlDates.replaceChildren();
    tlRows.replaceChildren();
    // Only the rows in use, not the original's flat 300. An idle row that is not
    // the last one still occupies its place in the grid, so row identity is kept
    // without rendering hundreds of empty tracks.
    tlRows.style.height = Math.max(ROW_HEIGHT, (layout.maxRow + 1) * ROW_HEIGHT) + 'px';

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

    // One track per task, placed at its packed row. Rows are absolute so a task's
    // vertical position is its row number rather than its index in this list,
    // which is what lets a row survive filtering and reloading.
    tasks.forEach((task) => {
      const row = document.createElement('div');
      row.className = 'tk-tl-row';
      row.dataset.id = task.id;
      const rowIndex = layout.rows.get(task.id) || 0;
      row.style.top = rowIndex * ROW_HEIGHT + 'px';
      if (rowIndex % 2 === 1) row.classList.add('alt');

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
        // A reversed task is drawn at its REAL deadline and marked invalid. It is
        // never dragged up to meet its start, and it never disappears: it degrades
        // visibly where the user would expect to find it.
        if (span.reversed) {
          bar.classList.add('invalid');
          label.textContent = '⚠ ' + task.name;
          // Wording matters here: this state was saved by the app, so the message
          // says what to do about it rather than reciting the rule it breaks. The
          // bar is still draggable — a move preserves the relation, so it is not
          // refused — but the reader should know the dates themselves need fixing.
          bar.title = task.name + ' — its dates are reversed: it starts ' +
            readableDay(dayString(new Date(span.start))) + ' but is due ' +
            readableDay(dayString(new Date(span.end))) +
            '. Dragging moves it as it is; open it to fix the start or the deadline.';
        }
        placeBar(bar, task, win);
        // Say so in words too: a clipped bar must not read as a task that simply
        // ends at the window edge.
        const geometry = barGeometry(task, win);
        if (geometry && (geometry.clippedStart || geometry.clippedEnd)) {
          const windowNote = (geometry.clippedStart ? 'Starts before ' + readableDay(dayString(new Date(win.min))) + '. ' : '') +
            (geometry.clippedEnd ? 'Ends after ' + readableDay(dayString(new Date(win.max))) + '. ' : '') +
            'The bar is cut off at the edge of the visible range; its stored dates are ' +
            readableDay(dayString(new Date(span.start))) + ' → ' + readableDay(dayString(new Date(span.end))) + '.';
          bar.title = bar.title ? bar.title + ' ' + windowNote : windowNote;
        }
      }

      // The gesture follows the pointer in continuous pixels on BOTH axes while it
      // is held; whole days and whole rows are COMMIT-time decisions, never
      // gesture-time ones. Snapping during the gesture was the worst of it: between
      // 3px and half a day the bar had stopped tracking the hand, so releasing
      // there moved nothing and the bar sprang back — a dead zone that widened with
      // every zoom step.
      //
      // Click versus drag is decided on FINAL displacement, in either axis, at
      // release. So a wobble that comes back to where it started is still a click,
      // and a purely vertical pull is still a drag.
      const DRAG_SLOP = 3;
      let armed = false;
      let dragging = false;
      let grabX = 0;
      let grabY = 0;
      let originLeftPx = 0;
      let originStartDay = '';
      let originEndDay = '';
      let originRow = 0;

      const onMove = (event) => {
        if (!armed) return;
        const dx = event.clientX - grabX;
        const dy = event.clientY - grabY;
        if (!dragging) {
          if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
          dragging = true;
          tlDraggingId = task.id;
          document.body.classList.add('tk-dragging');
        }
        // Continuous on both axes: the bar sits where the pointer puts it, and the
        // row it will land in is decided at release at ROW_HEIGHT per row.
        bar.style.transform = 'translate(' + Math.round(originLeftPx + dx) + 'px, ' + Math.round(dy) + 'px)';
      };

      const onUp = (event) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('tk-dragging');
        tlDraggingId = null;
        if (!armed) return;
        armed = false;

        const dx = event.clientX - grabX;
        const dy = event.clientY - grabY;
        const travelled = Math.abs(dx) >= DRAG_SLOP || Math.abs(dy) >= DRAG_SLOP;

        if (!travelled) { openTask(task.id); return; }

        // Commit, both axes, once.
        const shiftDays = Math.round(dx / tlZoom);
        const rowShift = Math.round(dy / ROW_HEIGHT);

        // The one real write in this panel, and it happens only when the gesture
        // actually asked for a change: the original also leaves the dates alone
        // when there is no horizontal displacement, so a purely vertical drag
        // moves a task to another row without also sliding it sideways.
        //
        // DELIBERATE DIVERGENCE from the original, do not "restore fidelity" here.
        // The original leaves a startless task startless and moves it by rewriting
        // createdAt (ProjectDeadlines.svelte:546-555). We refuse to touch createdAt
        // — it is provenance, and countdown progress is measured from it, so moving
        // it would rewrite the task's countdown history behind the user's back.
        // Scheduling intent is what `start` means, so this first deliberate drag
        // materialises a real start at the shifted effective start it was drawn
        // from. It stays startless until the user actually moves it.
        const fields = {};

        if (shiftDays !== 0) {
          // A whole-bar drag shifts both ends by the same whole number of days.
          // That is order-preserving EXACTLY: (end + k) - (start + k) === end - start,
          // so a valid task cannot become reversed and a reversed one cannot become
          // valid. The relation between the two dates is a property of the task, not
          // of where it sits, and a drag changes only where it sits.
          //
          // There used to be a guard here that refused a move which would land the
          // deadline before the start. It could never fire for a task that was valid
          // to begin with, and for an already-reversed task it fired on EVERY drag —
          // the move changes nothing about the contradiction, which the store already
          // holds, so the task became permanently undraggable and complained only
          // after the reader had tried. Removed: the invariant makes the refusal
          // unnecessary, and the bar keeps its invalid treatment wherever it lands.
          // Repairing the relation is the dialog's job, and only the dialog's.
          fields.start = shiftDay(originStartDay, shiftDays);
          fields.deadline = shiftDay(originEndDay, shiftDays);
          Store.updateTask(task.id, fields);
        }

        if (rowShift !== 0) {
          // Ask for the row the gesture pointed at, then walk down while anything
          // already there overlaps — the original's collision resolution.
          const visible = deadlineTasks();
          const wanted = Math.max(0, originRow + rowShift);
          const context = buildPackContext(visible, task.id);
          const settled = resolveDroppedRow(task.id, wanted, context.occupied, context.pendingIds, context.pending);
          Store.updateTask(task.id, { ganttRow: settled });
        }

        refreshAfterWrite();
      };

      bar.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        armed = true;
        dragging = false;
        grabX = event.clientX;
        grabY = event.clientY;
        // Anchor on the geometry that is actually drawn, so the interval the user
        // grabbed is the interval that moves, and a startless task's materialised
        // start lands exactly where its bar already was.
        const geometry = barGeometry(task, win);
        originLeftPx = geometry ? geometry.left : 0;
        originRow = timelineRows.get(task.id) || 0;
        originStartDay = dayString(new Date((span ? span.start : startOfToday())));
        originEndDay = dayString(new Date((span ? span.end : startOfToday())));
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      row.append(bar);
      tlRows.append(row);
    });

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
    if (isReversed(task)) {
      // The timer counts to the real deadline, so it stays truthful; the card
      // says the stored dates contradict each other rather than hiding it. Same
      // wording as the other two panels.
      card.classList.add('invalid');
      const span = spanOf(task);
      card.title = task.name + ' — its dates are reversed: it starts ' +
        readableDay(dayString(new Date(span.start))) + ' but is due ' +
        readableDay(dayString(new Date(span.end))) +
        '. Open it to fix the start or the deadline.';
    }

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
        // The bar under the hand is being positioned by the gesture, in both axes.
        // A tick that reset it would fight the pointer mid-drag.
        if (task.id === tlDraggingId) return;
        const geometry = barGeometry(task, win);
        if (!geometry) return;
        bar.style.transform = 'translate(' + Math.round(geometry.left) + 'px, 0px)';
        bar.style.width = Math.round(geometry.width) + 'px';
        bar.classList.toggle('clipped-start', geometry.clippedStart);
        bar.classList.toggle('clipped-end', geometry.clippedEnd);
        paintBarClips(bar, geometry);
        // The row is part of the layout, so it is kept current here too: a row
        // only changes when something writes one, but the tick must not leave a
        // bar sitting in the row it has just left.
        const rowIndex = typeof task.ganttRow === 'number' ? task.ganttRow : 0;
        const top = rowIndex * ROW_HEIGHT;
        if (row.style.top !== top + 'px') row.style.top = top + 'px';
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
        // Expiry is the end of the deadline day, so a task due today is not
        // overdue at one second past midnight.
        const deadlineMs = dayEnd(task.deadline);
        const diff = deadlineMs - now;
        card.__timer.textContent = formatCountdown(diff);
        // Progress runs from the start of the creation day to the deadline's
        // expiry, as the original does, whatever start the task may also carry.
        // That is why createdAt must stay immutable: this measurement would
        // otherwise change under a scheduling gesture. `start` governs where the
        // bar is drawn, not this clock.
        const createdMs = dayStart(String(task.createdAt || '').slice(0, 10));
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

  // ── One page ──────────────────────────────────────────────────────────────
  // The board and Timekeeping are a single scroll, not two surfaces: there is no
  // switcher and no surface state to keep. Both are on screen at once, so a pass
  // renders both and every change to the task set goes through renderEverything.
  //
  // `hidden` is honoured throughout — see the [hidden] rule in app.css, which is
  // what stops an element that sets its own `display` from ignoring the attribute.
  function renderEverything() {
    render();
    renderTimekeeping();
  }

  /** A write landed: re-read it everywhere it can show up. */
  const refreshAfterWrite = renderEverything;

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
  renderEverything();
  // Said after the board is drawn, so the reader sees the app and the explanation
  // together rather than a notice over a blank page.
  reportLoadStatus();
  // One clock for the whole page. Nothing about a tick writes or rebuilds.
  setInterval(tickTimekeeping, 1000);
})();
