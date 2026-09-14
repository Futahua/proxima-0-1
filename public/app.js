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
  const confirmDialog = $('#confirmDialog');

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
  // any combination is allowed, including all three at once, but never none. It is
  // COCKPIT state, not board state — Papers and a laptop may look at one board at
  // different zooms — so it is read from and written to Cockpit, beside the store
  // and not inside it. The original keeps the same pair in plugin settings, which
  // is per-install for the same reason.
  const cockpitPrefs = Cockpit.prefs();
  const panels = {
    calendar: cockpitPrefs.calendar,
    timeline: cockpitPrefs.timeline,
    countdown: cockpitPrefs.countdown,
  };

  const calCursor = { y: new Date().getFullYear(), m: new Date().getMonth() };
  /** Pixels per day, as this cockpit last left it. */
  let tlZoom = cockpitPrefs.zoom;
  /** Bounds are the original's own, shared by the wheel and the buttons. */
  const MIN_TL_ZOOM = 10;
  const MAX_TL_ZOOM = 300;
  let tlCentered = false;
  let countdownSignature = '';
  /** Packed row per visible task, refreshed by every timeline render. */
  let timelineRows = new Map();
  /** The task whose bar is under the hand, so a tick leaves its position alone. */
  let tlDraggingId = null;
  /** Coalesces the wheel's many zoom steps into one cockpit write. */
  let zoomSaveTimer = 0;

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

  /** The project shown by the Daily board's lens. Never page identity. */
  const lensProjectId = () => projectFilter.value;

  /**
   * The project the mounted board is scoped to; '' means everything.
   *
   * One scoping rule with two ways to set it: a project route's scope is the
   * address, and Daily's is the lens dropdown. Nothing caches the result, so the
   * two can never disagree about what is on screen.
   */
  function activeScopeId() {
    const r = route();
    if (r.name === 'project' && Store.project(r.id)) return r.id;
    return lensProjectId();
  }

  /**
   * Tasks the board and Timekeeping are looking at.
   */
  function visibleTasks() {
    const scope = activeScopeId();
    return Store.tasks()
      .filter((t) => !scope || t.project === scope)
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
    down.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (frozen) return;
      const result = await send('task.patch', { taskId: task.id, patch: { weight: Math.max(1, task.weight - 1) } });
      if (reportRefusal(result, group)) return;
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
    up.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (frozen) return;
      const result = await send('task.patch', { taskId: task.id, patch: { weight: task.weight + 1 } });
      if (reportRefusal(result, group)) return;
      render();
    });

    group.append(down, value, up);
    return group;
  }

  /** `agent:scout` -> `scout`. Anything else is not an agent and gets no marker. */
  function agentName(actor) {
    return typeof actor === 'string' && actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
  }

  /**
   * The mark a card carries when an agent has touched it.
   *
   * Agents write here directly, with no approval step, so the board itself has to
   * answer "did a person or an agent do this" — a reader should never have to open a
   * log to notice that a card changed under them. It names the agent and says which
   * act it was, and it is one short line rather than a chip per change: the card is
   * the record, and the record has one most-recent author.
   */
  function agentMarkFor(kind, id) {
    const who = Store.attributionFor(kind, id);
    if (!who) return null;
    const last = agentName(who.lastActor);
    const made = agentName(who.createdBy);
    if (!last && !made) return null;
    const mark = document.createElement('p');
    mark.className = 'agentmark';
    const name = last || made;
    mark.textContent = '◆ ' + (last ? name + ' changed this' : name + ' made this');
    const when = who.lastAt ? ' ' + ageLabel(who.lastAt, Date.now()) : '';
    mark.title = (last
      ? 'Last change by agent:' + last + ' — ' + (who.lastType || 'change') + when + '.'
      : 'Made by agent:' + made + '. Last changed by ' + (who.lastActor || 'somebody') + when + '.') +
      ' Reverting it is offered on the activity line above the board.';
    if (!last) mark.classList.add('made');
    return mark;
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

    const agentMark = agentMarkFor('task', task.id);
    if (agentMark) body.append(agentMark);

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
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      // Deleting a plan member is allowed: it is a data operation, not a re-plan,
      // and the run ends honestly rather than keeping a slot for a task that is
      // gone. See endRunIfEmpty().
      const result = await send('task.delete', { taskId: task.id });
      if (reportRefusal(result, del)) return;
      render();
      void endRunIfEmpty();
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

  /**
   * Move a task to a column, before a named task or at the end of it.
   *
   * The command names the task it goes BEFORE rather than an index: "before Y" means
   * the same thing on a replay and on another client, where "order = 12" would mean
   * whatever the list happened to look like when it was written. Everything the
   * move needs is read out of the drag BEFORE the await, because the drop's own
   * cleanup has already run by the time this resolves.
   */
  async function placeTask(taskId, toStatus, beforeTaskId) {
    const result = await send('task.move', { taskId: taskId, toStatus: toStatus, beforeTaskId: beforeTaskId });
    reportRefusal(result, null);
    render();
    void endRunIfEmpty();
  }

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
    const movedId = dragId;
    const toStatus = host.dataset.drop;
    dragId = null;
    // Deliberately not awaited here: the drag's own state has to be cleared in this
    // task, and the command applies and resolves before anything else can run. A
    // command never rejects, so this cannot leave an unhandled failure behind.
    void placeTask(movedId, toStatus, beforeId);
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
        // Archived projects stay selectable: the Hub's "show archived" toggle is a
        // view choice, and a scope must not silently break because the project it
        // points at is not currently listed.
        option.textContent = p.archivedAt ? p.name + ' (archived)' : p.name;
        select.append(option);
      });
      select.value = current;
    };
    build(projectFilter, '-- All Projects --');
    build(taskForm.elements.project, 'Uncategorised');
  }

  /**
   * One command id per opening of the dialog.
   *
   * A create is the one act here that a double submit would duplicate rather than
   * merely repeat, and the store's idempotency is keyed on the command id, so the
   * id belongs to the act of filling the form in rather than to the click. Two
   * clicks on Save are then one task, and a second dialog is a second create.
   */
  let createCommandId = null;

  function openTask(taskId) {
    editingId = taskId;
    createCommandId = taskId ? null : Store.newCommandId();
    const task = taskId ? Store.task(taskId) : null;
    $('#taskDialogTitle').textContent = task ? 'Edit task' : 'New task';
    $('#deleteTaskBtn').style.display = task ? '' : 'none';
    refreshProjectOptions();
    setTaskError('');
    taskForm.elements.name.value = task ? task.name : '';
    taskForm.elements.note.value = task ? task.note : '';
    // A new task lands in whatever the mounted board is scoped to, so creating one
    // inside a project's workspace files it there rather than in the lens the reader
    // happened to leave set on Daily.
    taskForm.elements.project.value = task ? task.project : activeScopeId();
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
   * The dialog's one error line. It carries the cockpit's own prevalidation AND
   * anything the store refuses, because from the reader's seat those are the same
   * kind of sentence: this cannot be saved, and here is why.
   */
  function setTaskError(text) {
    const error = $('#taskError');
    error.textContent = text || '';
    error.hidden = !text;
  }

  /**
   * A task cannot be due before it starts, and the dialog says so in words rather
   * than reverting or coercing either date. Returns true when the form is sane.
   *
   * This is prevalidation for feel, not the rule. The store refuses an impossible
   * pair with DEADLINE_BEFORE_START and its refusal is the one that decides; this
   * only saves the reader a round trip they can see coming.
   */
  function validateTaskDates() {
    const start = taskForm.elements.start.value;
    const deadline = taskForm.elements.deadline.value;
    if (!start || !deadline) { setTaskError(''); return true; }
    if (dayStart(deadline) < dayStart(start)) {
      setTaskError('The deadline (' + readableDay(deadline) + ') is before the start (' +
        readableDay(start) + '). A task cannot be due before it begins — move one of the dates.');
      return false;
    }
    setTaskError('');
    return true;
  }

  // Live, so the contradiction is named before the user tries to save.
  taskForm.elements.start.addEventListener('change', validateTaskDates);
  taskForm.elements.deadline.addEventListener('change', validateTaskDates);

  taskForm.addEventListener('submit', async (event) => {
    const action = event.submitter ? event.submitter.value : 'save';
    // Cancel and Delete keep the form's own dialog behaviour.
    if (action === 'cancel' || action === 'delete') {
      if (action === 'delete' && editingId) {
        const doomed = editingId;
        const result = await send('task.delete', { taskId: doomed });
        reportRefusal(result, taskForm);
        renderRoute();
        // A plan member that is deleted takes its slot with it, and the run ends
        // honestly if it was the last one.
        void endRunIfEmpty();
      }
      return;
    }

    // A save is ours to complete. The form is `method="dialog"`, so letting the
    // submit through would close the dialog even when the save is refused, taking
    // the explanation with it. Hold the dialog open until the command has actually
    // been accepted, and put the store's own refusal in the dialog when it has not.
    event.preventDefault();
    if (!validateTaskDates()) return;

    const fields = {
      name: taskForm.elements.name.value,
      note: taskForm.elements.note.value,
      project: taskForm.elements.project.value,
      status: taskForm.elements.status.value,
      weight: taskForm.elements.weight.value === '' ? 1 : taskForm.elements.weight.value,
      start: taskForm.elements.start.value,
      deadline: taskForm.elements.deadline.value,
    };

    let result;
    if (editingId) {
      const editing = Store.task(editingId);
      if (!editing) {
        setTaskError('That task is no longer in the store.');
        return;
      }
      // Where a task SITS is a move, not a patch: task.patch refuses `status`
      // outright and points here. So a save that changes the column is two
      // commands — the edit, then the move — which is also the honest account of
      // what happened in the log.
      const wantedStatus = fields.status;
      const patch = {
        name: fields.name,
        note: fields.note,
        project: fields.project,
        weight: fields.weight,
        start: fields.start,
        deadline: fields.deadline,
      };
      result = await send('task.patch', { taskId: editingId, patch: patch });
      if (result.ok && wantedStatus !== editing.status) {
        result = await send('task.move', { taskId: editingId, toStatus: wantedStatus, beforeTaskId: null });
      }
    } else {
      result = await send('task.create', {
        name: fields.name,
        note: fields.note,
        project: fields.project,
        status: fields.status,
        weight: fields.weight,
        start: fields.start,
        deadline: fields.deadline,
      }, { commandId: createCommandId });
    }

    if (!result.ok) {
      // The dialog stays open with the refusal in it — including the write failure
      // the store has already announced, which is worth repeating where the reader
      // is actually looking.
      setTaskError(result.message);
      return;
    }
    createCommandId = null;
    taskDialog.close();
    renderRoute();
    // Editing a plan member's status is how it leaves the run. If that was the
    // last one, the run is over and says so rather than ticking against nobody.
    void endRunIfEmpty();
  });

  // New Project, through a modal the way task creation works. A save is ours to
  // complete: the form is method="dialog", so letting the submit through would
  // close the dialog even when the create is refused, taking the reason with it.
  //
  // The name field deliberately has no `required`: browser validation would block
  // the submit entirely, so the refusal would have no way to say why.
  projectForm.addEventListener('submit', async (event) => {
    const action = event.submitter ? event.submitter.value : 'save';
    if (action !== 'save') return;
    event.preventDefault();
    const name = projectForm.elements.name.value.trim();
    const error = $('#projectError');
    if (!name) {
      error.textContent = 'A project needs a name before it can be created.';
      error.hidden = false;
      projectForm.elements.name.focus();
      return;
    }
    const result = await send('project.create', { name: name, description: projectForm.elements.description.value });
    if (!result.ok) {
      // The dialog stays open with the store's refusal in it, rather than closing
      // over a project that was never created.
      error.textContent = result.message;
      error.hidden = false;
      return;
    }
    projectForm.reset();
    error.hidden = true;
    projectDialog.close();
    // A new project changes the lens's options, so it is rebuilt before the
    // surface that shows it is redrawn.
    refreshProjectOptions();
    renderRoute();
  });

  // A cancelled, dismissed or completed create leaves nothing behind — no stored
  // text, and no message from an attempt that was abandoned.
  projectDialog.addEventListener('close', () => {
    projectForm.reset();
    $('#projectError').hidden = true;
  });

  /**
   * One confirmation dialog for destructive actions. Cancelling does nothing at
   * all — no write, no state change — because the work lives in the OK handler and
   * the handler is only attached when the dialog is opened.
   */
  confirmDialog.addEventListener('close', () => { confirmDialog.__onOk = null; });
  $('#confirmForm').addEventListener('submit', (event) => {
    const action = event.submitter ? event.submitter.value : 'cancel';
    confirmDialog.close();
    if (action !== 'ok') return;
    const run = confirmDialog.__onOk;
    confirmDialog.__onOk = null;
    if (run) run();
  });

  $('#newTaskBtn').addEventListener('click', () => openTask(null));
  $('#newProjectBtn').addEventListener('click', () => projectDialog.showModal());
  $('#hubNewProject').addEventListener('click', () => projectDialog.showModal());
  $('#hubShowArchived').addEventListener('change', (event) => {
    // Which projects are listed is presentation only; nothing is written.
    showArchived = event.currentTarget.checked;
    renderHub();
  });
  // The lens scopes the Daily board. On a project route it is hidden and the
  // address decides, so this handler can only ever fire on Daily.
  projectFilter.addEventListener('change', renderRoute);
  // A new target is a new horizon: every proportional share changes with it.
  targetInput.addEventListener('change', render);
  // A resize only changes how tall the running column is, so restyle rather than
  // rebuild — otherwise resizing would also throw away the reader's scroll spot.
  window.addEventListener('resize', () => {
    runningHeight = 0;
    paint();
  });

  /**
   * A locked run whose members have all left — finished, dragged out or deleted —
   * is over. End it and say so, rather than leaving a live run that is consuming
   * time for nobody and would hand that elapsed time to the next task to arrive.
   *
   * Asynchronous now, and reported here rather than by its callers: every caller is
   * mid-flow (a drop, a delete, a save) and none of them has anything better to say
   * about a refusal than this function does. `run.unlock` treats an already-ended
   * run as success, so the store never refuses this for being late.
   */
  async function endRunIfEmpty() {
    const plan = lockedPlan();
    if (!plan || plan.legacy) return false;
    const remaining = plan.members.filter((m) => {
      const task = Store.task(m.id);
      return task && task.status === 'running';
    });
    if (remaining.length > 0) return false;
    const result = await send('run.unlock', {});
    if (reportRefusal(result, runInfo)) return false;
    stopTicker();
    render();
    runInfo.textContent = 'The run ended: none of its planned tasks are still in the running column.';
    return true;
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  lockBtn.addEventListener('click', async () => {
    if (Store.run()) {
      const result = await send('run.unlock', {});
      if (reportRefusal(result, lockBtn)) return;
      stopTicker();
    } else {
      const target = fromLocalInput(targetInput.value);
      // Prevalidation for feel: the target is a form field the reader can fix, and
      // saying so here saves them a round trip. Everything else about a lock — that
      // there is something to lock, that the horizon is in the future as the store
      // measures it — is the store's refusal to make, and it says so in the same
      // words this used to.
      if (!target || target <= new Date()) {
        flash('Pick a target in the future before locking.', targetInput);
        return;
      }
      const result = await send('run.lock', {
        target: targetInput.value,
        taskIds: liveRunning().map((t) => t.id),
      });
      if (reportRefusal(result, lockBtn)) { render(); return; }
      ticker = setInterval(tick, 1000);
    }
    render();
  });

  /**
   * One second of a live run. A tick rewrites card heights, wipe heights and the
   * countdown line, and touches nothing else — no node is created, replaced or
   * removed, so the running column keeps its scroll position while it grows.
   *
   * Guarded, rather than stopped and started around navigation: only Daily and a
   * project route mount the board, and a tick against unmounted sections would be
   * painting nodes nobody is looking at. Nothing is lost by not painting — the run
   * is measured from wall-clock timestamps, so the single render on return is
   * already caught up. One interval for the life of the page is also the version
   * that cannot go wrong: stopping and restarting is how a second interval gets
   * started by accident, and then every later tick happens twice.
   */
  function tick() {
    if (!boardMounted()) return;
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

  // ── The command boundary ──────────────────────────────────────────────────
  // Board data changes one way now: an explicit command, awaited, whose refusal is
  // a value to be handled. These two helpers are the whole of the cockpit's side of
  // that contract, so no call site has to remember the envelope's shape or decide
  // for itself which failures the reader has already been told about.

  /**
   * Send one command. The envelope is the store's; this only fills in what a call
   * site should not have to think about — a fresh idempotency key unless the caller
   * is deliberately retrying an act it already sent (see openTask's create id, and
   * the timeline's layout pass).
   */
  function send(type, payload, options) {
    const opts = options || {};
    return Store.command({
      type: type,
      payload: payload || {},
      commandId: opts.commandId || Store.newCommandId(),
      ifRev: opts.ifRev,
    });
  }

  /**
   * Say what the store refused, in the reader's terms, and say whether it refused.
   *
   * A refusal is a value rather than an exception, and one place decides which of
   * them the reader has to see: the store's own durability failure is already on
   * screen as a sticky notice, and repeating it here would replace that notice with
   * a shorter version of itself, because the flash channel is a single chip.
   */
  function reportRefusal(result, anchor) {
    if (!result || result.ok) return false;
    if (result.code === 'WRITE_FAILED') return true;
    flash(result.message, anchor || null, { warn: true });
    return true;
  }

  // ── The service, and saying so when it is not there ───────────────────────
  // The board lives in proximad now. Two things the reader must be able to tell at a
  // glance: whether what they are looking at is live, and — if it is not — that
  // nothing they do here will be kept. A read-only copy is honest; a local write is
  // how two boards start disagreeing.

  function updateServiceBanner(status) {
    const banner = $('#serviceBanner');
    if (!banner) return;
    const state = status || Store.loadStatus();
    // `mode` is what the store reports live; `kind` is the same thing in the shape the
    // rest of the cockpit asks for. Either will do here.
    const mode = state.mode || (state.kind === 'offline' ? 'offline' : state.kind === 'connecting' ? 'connecting' : 'online');
    if (mode === 'online') { banner.hidden = true; banner.textContent = ''; return; }
    banner.hidden = false;
    banner.classList.toggle('connecting', mode === 'connecting');
    if (mode === 'connecting') {
      banner.textContent = 'Contacting the Proxima service…';
      return;
    }
    const when = Store.cachedAt() ? new Date(Store.cachedAt()).toLocaleString() : null;
    banner.textContent = 'The Proxima service is not reachable' + (state.detail ? ' (' + state.detail + ')' : '') +
      '. This board is a read-only copy' + (when ? ' from ' + when : '') +
      ' — nothing you change here will be saved, and nothing has been written to this browser.';
  }

  // ── The migration bridge ──────────────────────────────────────────────────
  // The pre-service board is still in this browser. It is never imported silently:
  // the reader is shown what was found and asked. Nothing here writes it, and a
  // "not now" leaves it exactly where it is.

  function legacyWantsAttention() {
    const summary = Store.legacySummary();
    if (!summary) return false;
    if (Store.migratedNote()) return false;
    return summary.unreadable || !summary.empty;
  }

  async function openMigrateDialog() {
    const summary = Store.legacySummary();
    if (!summary) return;
    const dialog = $('#migrateDialog');
    const body = $('#migrateBody');
    const report = $('#migrateReport');
    const confirmBtn = $('#migrateConfirm');
    report.hidden = true;
    report.textContent = '';
    confirmBtn.disabled = false;
    body.textContent = summary.unreadable
      ? 'This browser holds a board under “proxima.store.v1” that cannot be read as this app’s format. ' +
        'It will be archived byte for byte before anything else happens, and nothing will be imported from it.'
      : 'This browser holds a board that predates the Proxima service: ' + summary.tasks +
        (summary.tasks === 1 ? ' task' : ' tasks') + ', ' + summary.projects +
        (summary.projects === 1 ? ' project' : ' projects') + (summary.run ? ', and an active run' : '') +
        '. Importing copies it into the service under the actor “migration:localstorage”, keeping ids, dates and ' +
        'anything this app does not recognise. The exact bytes are archived first, and this browser copy is left ' +
        'alone either way.';
    dialog.showModal();
    if (summary.unreadable) return;
    // What would actually happen, from the service's point of view.
    const inspected = await Store.inspectLegacy();
    if (!inspected || !inspected.ok) {
      report.hidden = false;
      report.textContent = 'The service could not read that board: ' + ((inspected && inspected.error) || 'unknown reason') + '.';
      confirmBtn.disabled = true;
      return;
    }
    const lines = [];
    lines.push(inspected.serviceEmpty
      ? 'The service is empty, so everything found here is new to it.'
      : 'The service already holds a board: ' + inspected.novel.tasks + ' of these tasks and ' +
        inspected.novel.projects + ' of these projects are new, ' + inspected.same.tasks + ' tasks and ' +
        inspected.same.projects + ' projects are already there and identical.');
    if (inspected.conflicts.length) {
      lines.push(inspected.conflicts.length + (inspected.conflicts.length === 1 ? ' record has' : ' records have') +
        ' the same id but different contents: ' + inspected.conflicts.map((c) => c.kind + ' ' + c.name).join(', ') +
        '. Those will NOT be imported — two old boards are never merged by overwriting one with the other. ' +
        'The archive keeps the bytes so it can be decided by hand.');
    }
    if (inspected.dropped && (inspected.dropped.tasks || inspected.dropped.projects)) {
      lines.push(inspected.dropped.tasks + inspected.dropped.projects + ' records cannot be read at all and will be reported, not dropped silently.');
    }
    report.hidden = false;
    report.textContent = lines.join(' ');
  }

  async function runMigration() {
    const confirmBtn = $('#migrateConfirm');
    const report = $('#migrateReport');
    confirmBtn.disabled = true;
    report.hidden = false;
    report.textContent = 'Importing…';
    const result = await Store.importLegacy();
    if (!result || !result.ok) {
      report.textContent = (result && result.message) || 'The import was refused.';
      confirmBtn.disabled = false;
      return;
    }
    report.textContent = result.message + ' This browser’s copy has been left exactly as it was.';
    confirmBtn.textContent = 'Done';
    confirmBtn.disabled = false;
    // The migration brought the old layout across with it, so this cockpit adopts it
    // now rather than at the next launch.
    await adoptServicePreferences();
    refreshProjectOptions();
    renderRoute();
  }

  /** How this cockpit looks, from the service — the layout a wiped profile lost. */
  async function adoptServicePreferences() {
    const adopted = await Store.adoptPreferences();
    if (!adopted) return false;
    Object.assign(panels, Cockpit.prefs());
    tlZoom = Cockpit.prefs().zoom;
    syncPanelVisibility();
    renderTimekeeping();
    return true;
  }

  // ── Failures, reported rather than swallowed ──────────────────────────────
  // A write the SERVICE could not complete is still rolled back by the service and
  // still worth saying plainly: the change is not in the board, and the reader
  // should not be left thinking it is. The connection itself is reported by the
  // banner, which is the right weight for it — a state, not an event.
  Store.onWriteFailure((failure) => {
    flash('Not saved — the service could not write that (' + failure.reason +
      '). Nothing was changed, on the service or here.', null, { sticky: true, warn: true });
  });

  /**
   * Say what the cockpit found when it started.
   *
   * There is no "this browser's board was corrupt" report any more: the board is not
   * in the browser. What is left in the browser is a pre-service copy, and that is
   * the migration dialog's business — it shows what was found, in full, before
   * anything is done with it.
   */
  function reportLoadStatus() {
    const status = Store.loadStatus();
    if (status.kind === 'offline') {
      updateServiceBanner(status);
      return;
    }
    if (Store.writeError()) return; // onWriteFailure has already said it, stickily
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

  // ── Gesture bindings ──────────────────────────────────────────────────────
  /**
   * The ONE place a gesture's binding is named. Shift+drag stretches a bar, as in
   * the original (ProjectDeadlines.svelte:501-504); the chord is a taste decision,
   * not a law, so it lives here as data. Changing it to another modifier — or to a
   * dedicated grab handle, which would read `event.target` instead — is an edit to
   * this object and the two predicates below, and nothing else in the file has to
   * be hunted down.
   *
   *   eventFlag  the mouse event property the press is read from
   *   key        the key whose press and release light up the hint
   *   hintAttr   the body attribute the hint's CSS hangs off
   */
  const STRETCH_BINDING = {
    eventFlag: 'shiftKey',
    key: 'Shift',
    hintAttr: 'data-shift-pressed',
  };

  function stretchRequested(event) {
    return event[STRETCH_BINDING.eventFlag] === true;
  }

  /**
   * Where the pointer last was over a bar, so the hint can be lit the instant the
   * binding key goes down without waiting for the pointer to move first.
   */
  let lastPointer = null;

  /**
   * Which end a stretch takes hold of: the half of the bar the pointer is in,
   * exactly as the original decides it. The hover hint calls this too, so what the
   * cursor promises before the press is what the drag does after it.
   */
  function stretchEdgeAt(clientX, rect) {
    return clientX < rect.left + rect.width / 2 ? 'left' : 'right';
  }

  function clearStretchHints() {
    $$('.tk-tl-bar.hover-left-half, .tk-tl-bar.hover-right-half').forEach((el) => {
      el.classList.remove('hover-left-half', 'hover-right-half');
    });
  }

  /**
   * Mark the half of the bar under a point, so the stretch announces itself the
   * moment the key goes down rather than waiting for the pointer to move first.
   */
  function showStretchHintAt(clientX, clientY) {
    clearStretchHints();
    if (tlDraggingId) return;
    const under = document.elementFromPoint(clientX, clientY);
    const bar = under && under.closest ? under.closest('.tk-tl-bar') : null;
    if (!bar) return;
    const edge = stretchEdgeAt(clientX, bar.getBoundingClientRect());
    bar.classList.add(edge === 'left' ? 'hover-left-half' : 'hover-right-half');
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
   * Resolve rows for a whole visible set.
   *
   * Returns the settled rows, including the highest one in use, and — separately —
   * asks for the ones that moved to be remembered. THE RENDER NO LONGER WAITS FOR
   * THAT WRITE, and cannot: a command is asynchronous now, and a render pass cannot
   * be. So the packing the pass computed is what gets drawn, and the same packing is
   * proposed to the store afterwards, in one command for the whole pass.
   *
   * That is a real change in the shape of the render path and it is deliberate. What
   * it costs: for the moment between the draw and the commit, the bars show a
   * packing the store has not accepted yet. Both packings are valid layouts of the
   * same spans, the refusal path re-renders from the stored one, and the log gets one
   * event for a pass instead of one per row.
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
      if (row !== task.ganttRow) updates.push({ taskId: task.id, ganttRow: row });
    });

    // Placements are persisted so they survive a filter change or a reload: a row is
    // a scheduling decision. Asked for, not waited on — see above.
    if (updates.length) void proposeLayout(updates);
    return { rows: rows, maxRow: maxRow, moved: updates.length };
  }

  /**
   * Ask the store to remember a packing the renderer has already drawn.
   *
   * A refusal here does NOT trigger a re-render, which is the one place this
   * deliberately differs from a refused task edit. A layout is derived: the drawn
   * packing and the stored one are both valid packings of the same spans, nobody
   * asked for either by hand, and a re-render would immediately propose the same
   * thing again — the only refusal this can realistically hit is a write failure,
   * which the store is already announcing stickily.
   */
  async function proposeLayout(rows) {
    const result = await send('task.layout', { rows: rows });
    reportRefusal(result, null);
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
   * A reversed span is drawn as the interval between its two days, with the LEFT
   * edge on the EARLIER of them — which for a reversed task is the deadline it
   * claims, so the bar still lands where the reader was told to look. The 24px
   * floor is not what holds a reversed bar open; it only keeps a zero-length span
   * (a start and a deadline on one day) visible as a mark. The original instead
   * computes `deadline - start` as a negative width, which CSS drops, leaving a 24px
   * stub at the task's START: days away from its own deadline, which hides the very
   * contradiction the invalid treatment exists to expose. The data is reported
   * untouched either way — only the drawn geometry is made presentable.
   *
   * The window is finite, so the span is CLIPPED to it — both ends. Clipping only
   * the left edge was a lie: a task that began before the window kept its full
   * width, so a 60-day task ending today appeared to run a month into the future.
   * Clipped ends are reported so the bar can show that it continues off-screen.
   */
  function barGeometry(task, win) {
    const span = spanOf(task);
    if (!span) return null;
    return spanGeometry(Math.min(span.start, span.end), Math.max(span.start, span.end), win);
  }

  /**
   * The geometry of ANY interval, whether it is stored on a task or only proposed
   * by a gesture in progress. `earlier` and `later` are milliseconds and must
   * already be ordered — ordering is the reversed-span decision, and it is made by
   * the caller that knows what the two dates mean.
   *
   * This is split out of `barGeometry` for exactly one reason: a stretch preview
   * must be drawn by the same rule as the bar it will become. A preview with its
   * own clamping or its own anchor would let the hand see one shape and leave
   * another behind on release.
   */
  function spanGeometry(earlier, later, win) {
    // Width stays exclusive of the end day, as reviewed: a one-day task is one
    // column, a two-day task two. Only the clip is new.
    const rawLeft = tlLeftInWindow(earlier, win);
    const rawRight = tlLeftInWindow(later, win);
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

  /** The whole-day column a stored day sits in, counted from the window's first day. */
  function dayIndexIn(day, win) {
    return Math.round((dayStart(day) - win.min) / DAY_MS);
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
      // 'move', 'resize-left' or 'resize-right'. Decided once, at press, from the
      // binding and the half of the bar that was pressed.
      let mode = 'move';
      let grabX = 0;
      let grabY = 0;
      let originLeftPx = 0;
      let originStartDay = '';
      let originEndDay = '';
      let originRow = 0;
      // Where the two ends sit as day columns, taken from the STORED days rather
      // than from the drawn pixels: a bar whose start falls before the window is
      // drawn clipped at 0, and a stretch must move its real start, not the edge it
      // happens to be painted at.
      let originStartIndex = 0;
      let originEndIndex = 0;

      /** The whole-day column the pointer is over, in the grid's own coordinates. */
      const dayIndexAt = (clientX) => Math.round((clientX - tlRows.getBoundingClientRect().left) / tlZoom);

      /**
       * Draw the bar for a span the gesture is only proposing. It goes through the
       * same geometry as the committed bar — the same 24px floor, the same clipping,
       * the same anchor on the earlier of the two days when the span is reversed —
       * so the shape under the hand is the shape left behind on release.
       */
      const previewSpan = (startIndex, endIndex) => {
        const geometry = spanGeometry(
          win.min + Math.min(startIndex, endIndex) * DAY_MS,
          win.min + Math.max(startIndex, endIndex) * DAY_MS,
          win,
        );
        bar.style.transform = 'translate(' + Math.round(geometry.left) + 'px, 0px)';
        bar.style.width = Math.round(geometry.width) + 'px';
        bar.classList.toggle('clipped-start', geometry.clippedStart);
        bar.classList.toggle('clipped-end', geometry.clippedEnd);
        paintBarClips(bar, geometry);
      };

      const onMove = (event) => {
        if (!armed) return;
        const dx = event.clientX - grabX;
        const dy = event.clientY - grabY;
        if (!dragging) {
          if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
          dragging = true;
          tlDraggingId = task.id;
          document.body.classList.add(mode === 'move' ? 'tk-dragging' : 'tk-resizing');
          // The hover hint is about a bar nobody is holding yet.
          bar.classList.remove('hover-left-half', 'hover-right-half');
        }
        if (mode === 'move') {
          // Continuous on both axes: the bar sits where the pointer puts it, and the
          // row it will land in is decided at release at ROW_HEIGHT per row.
          bar.style.transform = 'translate(' + Math.round(originLeftPx + dx) + 'px, ' + Math.round(dy) + 'px)';
          return;
        }
        // Stretching: the end that was taken hold of goes to the column under the
        // pointer and the other end stays exactly where it was. Only that one end is
        // a proposal — the far end is read from the days the store already holds.
        // Vertically nothing happens, which is also true of the original's stretch.
        //
        // The horizontal slop is the COMMIT's own condition, not a second one: a pull
        // that never left its column will not be written at release, so it must not
        // be shown as a change either. Without this a nine-pixel downward pull on a
        // bar's right half redrew the bar days shorter and then sprang back when the
        // hand let go — the same "it moved and then it didn't" the whole-bar drag was
        // cured of.
        if (Math.abs(dx) < DRAG_SLOP) return;
        const pointed = dayIndexAt(event.clientX);
        if (mode === 'resize-left') previewSpan(pointed, originEndIndex);
        else previewSpan(originStartIndex, pointed);
      };

      // Asynchronous, because the commit is a command. Everything that has to happen
      // in the gesture's own task — dropping the listeners, clearing the drag state,
      // measuring the displacement — happens before the first await, so the pointer
      // is never holding a bar that is still listening for it.
      const onUp = async (event) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('tk-dragging', 'tk-resizing');
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
        let result = null;

        if (mode !== 'move') {
          // Stretching writes ONE end, and it writes it only when the gesture moved
          // horizontally — the same principle the move above applies with its
          // `shiftDays !== 0`: a pull that never left its column never asked for a
          // date change, and without this a five-pixel vertical wobble on a bar's
          // right half would silently shorten the task.
          if (Math.abs(dx) >= DRAG_SLOP) {
            // The day under the pointer becomes that end's day. That is the
            // original's rule (ProjectDeadlines.svelte:609-614): the end is PLACED
            // where it was dropped, not nudged by a delta, so the edge takes hold of
            // the pointer and lands on the column the reader aimed at. Rounding is
            // the commit-time snapping every gesture in this panel shares, and the
            // preview rounds the same way, so nothing moves on release.
            const day = dayString(new Date(win.min + dayIndexAt(event.clientX) * DAY_MS));
            // A startless task gains a real start here rather than having its
            // provenance rewritten — the same treatment the move above gives it.
            const end = mode === 'resize-left' ? 'start' : 'deadline';
            // Nothing refuses a stretch that lands the start after the deadline. The
            // pair is stored exactly as asked and the bar draws it by the one
            // reversed-span rule there is — the interval between the two days, left
            // edge on the earlier of them, which for a reversed task is the deadline
            // it claims — and that is what the preview drew too, so the contradiction
            // appears under the hand instead of after the fact. A refusal here would
            // be a second rule for the same state, and the task editor stays the one
            // place the contradiction is repaired.
            result = await send('task.patch', { taskId: task.id, patch: { [end]: day } });
            if (reportRefusal(result, bar)) { refreshAfterWrite(); return; }
          }
        } else if (shiftDays !== 0) {
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
          result = await send('task.patch', {
            taskId: task.id,
            patch: { start: shiftDay(originStartDay, shiftDays), deadline: shiftDay(originEndDay, shiftDays) },
          });
          if (reportRefusal(result, bar)) { refreshAfterWrite(); return; }
        }

        // The row, once, for every gesture. A stretch changes the span, so it can
        // create a collision the task did not have before; a move can too. Both go
        // through the drop-time walk rather than leaving it to the next pack pass, so
        // the row a task lands in is decided by the gesture that moved it. The walk
        // reads the task's span back out of the store, so it has to happen AFTER the
        // dates above have been committed — which is now a real ordering the awaits
        // above are doing the work for, rather than the accident of a synchronous
        // write that happened to run first.
        const wanted = mode === 'move' ? Math.max(0, originRow + rowShift) : originRow;
        const visible = deadlineTasks();
        const context = buildPackContext(visible, task.id);
        const settled = resolveDroppedRow(task.id, wanted, context.occupied, context.pendingIds, context.pending);
        if (settled !== originRow) {
          const rowResult = await send('task.patch', { taskId: task.id, patch: { ganttRow: settled } });
          if (reportRefusal(rowResult, bar)) { refreshAfterWrite(); return; }
        }

        refreshAfterWrite();
      };

      bar.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Which gesture a press starts is decided here, once, and nowhere else.
        mode = stretchRequested(event)
          ? 'resize-' + stretchEdgeAt(event.clientX, bar.getBoundingClientRect())
          : 'move';
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
        originStartIndex = dayIndexIn(originStartDay, win);
        originEndIndex = dayIndexIn(originEndDay, win);
        bar.classList.remove('hover-left-half', 'hover-right-half');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      // The hint the cursor gives before anyone presses: the half under the pointer
      // is named by the same predicate the press reads, so the promise and the
      // behaviour cannot drift apart. It is only *shown* while the binding key is
      // held — the CSS does that — so an ordinary drag is not dressed up as a
      // stretch.
      bar.addEventListener('mousemove', (event) => {
        if (armed || dragging) return;
        lastPointer = { x: event.clientX, y: event.clientY };
        const edge = stretchEdgeAt(event.clientX, bar.getBoundingClientRect());
        bar.classList.toggle('hover-left-half', edge === 'left');
        bar.classList.toggle('hover-right-half', edge === 'right');
      });
      bar.addEventListener('mouseleave', () => {
        lastPointer = null;
        bar.classList.remove('hover-left-half', 'hover-right-half');
      });

      row.append(bar);
      tlRows.append(row);
    });

    if (!tlCentered) {
      // The opening scroll can only happen on a viewport that has layout. While the
      // panels are hidden — an empty store, or a route that does not mount them —
      // this element measures zero and a `scrollLeft` write is silently dropped, so
      // latching "already centred" there would park the timeline at the start of its
      // window for the rest of the session: thirty days of empty past and today off
      // screen. The flag therefore waits for a render that can actually move.
      if (tlViewport.clientWidth > 0) {
        tlCentered = true;
        scrollTimelineToToday(false);
      }
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
    // Same guard, same reason as the board's tick: the panels below the board are
    // mounted by the same two routes, and a tick that rebuilt a hidden countdown
    // group would do so against a box that measures zero.
    if (!boardMounted()) return;
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

  // ══ Routes ═════════════════════════════════════════════════════════════════
  // What is on screen, decided by the address.
  //
  // The fragment, not the History API: there is no server here to rewrite a path,
  // so a refresh must land on the one document and let the fragment decide which
  // surface it mounts. `#/hub` survives F5 and a bookmark; `/hub` would be a 404.
  //
  // `hidden` is honoured throughout — see the [hidden] rule in app.css, which is
  // what stops an element that sets its own `display` from ignoring the attribute.

  const ROUTE_HOME = '#/';

  /**
   * Read a route out of an address. Parsed on every call rather than cached in a
   * variable, for the same reason the Daily lens is read from its own control
   * instead of mirrored: a copy is a second source of truth, and this one would
   * disagree with the address bar the first time somebody pressed Back.
   *
   * The route stays semantic — `#/project/<id>` — and is never derived from a
   * project's display name, which the reader can edit: a rename must not break a
   * bookmark, and two renamed projects must not be able to collide.
   */
  function parseRoute(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    const path = raw.replace(/^\/+/, '').replace(/\/+$/, '');
    if (path === '') return { name: 'daily', id: '' };
    if (path === 'hub') return { name: 'hub', id: '' };
    if (path === 'schedule') return { name: 'schedule', id: '' };
    if (path.indexOf('project/') === 0) {
      let id = '';
      try {
        id = decodeURIComponent(path.slice('project/'.length));
      } catch (err) {
        // A malformed escape is not an id; it falls through to "no such page".
        return { name: 'missing', id: '', bad: raw };
      }
      if (id) return { name: 'project', id: id };
    }
    return { name: 'missing', id: '', bad: raw };
  }

  function route() {
    return parseRoute(location.hash);
  }

  /**
   * The surface actually shown. A project id that resolves to nothing is not a
   * workspace, it is a dead link, and it says so rather than quietly mounting the
   * whole board — a fallback would look like the project's own page with
   * suspiciously broad contents.
   */
  function currentSurface() {
    const r = route();
    if (r.name === 'project') return Store.project(r.id) ? 'project' : 'missing';
    return r.name;
  }

  /** The two surfaces that mount the board and Timekeeping. */
  function boardMounted() {
    const name = currentSurface();
    return name === 'daily' || name === 'project';
  }

  const lensPick = $('#lensPick');
  const navProject = $('#navProject');

  function setRouteVisibility(surface, project) {
    const board = surface === 'daily' || surface === 'project';
    ['#boardHead', '#runbar', '#columns', '#timekeeping']
      .forEach((sel) => { $(sel).hidden = !board; });
    // The activity line belongs to the board and nowhere else: it is a diff of the
    // tasks and projects, and the Hub is not the place either of those is read.
    if (!board) $('#activityLine').hidden = true;
    $('#projectsHub').hidden = surface !== 'hub';
    $('#schedule').hidden = surface !== 'schedule';
    $('#routeMissing').hidden = surface !== 'missing';

    // The lens lives on the Daily board only. On the Hub it would do nothing, and
    // on a project route the address has already decided — a control that means
    // something different on every page is worse than no control.
    lensPick.hidden = surface !== 'daily';

    // The open project's own nav item exists only while its workspace does.
    navProject.hidden = surface !== 'project';
    if (project) {
      navProject.textContent = project.name;
      navProject.href = '#/project/' + encodeURIComponent(project.id);
      // Says which address it points at, since the label is editable and the
      // address is not.
      navProject.title = 'This project’s workspace — #/project/' + project.id;
    } else {
      // Empty rather than merely hidden: an item left over from the last project
      // would still be a link to it, and this one can outlive the project.
      navProject.textContent = '';
      navProject.removeAttribute('href');
      navProject.removeAttribute('title');
    }

    // `aria-current` marks the one nav item that is this page. A dead link marks
    // none: the reader is not on any of the surfaces the nav can offer.
    $$('.surfaces a[data-route]').forEach((link) => {
      const here = link.dataset.route === surface;
      if (here) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  /** Say which address failed, in the reader's terms rather than in HTTP's. */
  function describeMissingRoute() {
    const r = route();
    if (r.name === 'project') {
      $('#routeMissingTitle').textContent = 'That project is not in this store';
      $('#routeMissingBody').textContent = 'Nothing here has the id “' + r.id +
        '”. It may have been deleted, or the link may come from a store this browser no longer has. Nothing has been changed.';
      return;
    }
    $('#routeMissingTitle').textContent = 'That address is not a page';
    $('#routeMissingBody').textContent = '“' + (r.bad || '') +
      '” is not one of this app’s destinations. The links below go to the ones that exist.';
  }

  /**
   * The diff of what moved, and the way back from it.
   *
   * Two things are being said on one quiet line. First: what changed since the reader
   * last looked, counted per actor, because an agent writes here without asking and
   * the reader's question is "what did it do", not "is there a message for me".
   * Second: an agent named on this line is a handle — clicking it offers to take that
   * agent's last hour back. The undo lives here rather than in a menu because this is
   * the only place the app knows an agent has been working.
   *
   * It says nothing at all when nothing moved and no agent has been active: an empty
   * strip that says "no changes" is a notification centre with nothing to notify.
   */
  function renderActivity() {
    const line = $('#activityLine');
    if (!line) return;
    const summary = Store.activity();
    line.textContent = '';

    // The line shows if there is a diff to read OR something of an agent's inside
    // the window an undo would cover. The second case is what keeps the undo
    // reachable after the reader has acknowledged everything.
    const named = new Map();
    summary.agents.forEach((entry) => named.set(entry.actor, { actor: entry.actor, count: entry.count, hour: 0 }));
    summary.agentsLastHour.forEach((entry) => {
      if (named.has(entry.actor)) named.get(entry.actor).hour = entry.count;
      else named.set(entry.actor, { actor: entry.actor, count: 0, hour: entry.count });
    });
    if (!summary.total && named.size === 0) { line.hidden = true; return; }
    line.hidden = false;

    const lead = document.createElement('span');
    lead.className = 'activity-lead';
    if (summary.total) {
      lead.textContent = (summary.total === 1 ? '1 change' : summary.total + ' changes') + ' since you last looked';
    } else {
      lead.textContent = 'Nothing new since you last looked';
    }
    line.append(lead);

    // Every actor is counted the same way, agent or not: the diff is about what
    // moved, and a line that only counted the agents would be a line about agents.
    summary.agents.concat(summary.humans).forEach((entry) => {
      const chip = document.createElement('span');
      chip.className = 'activity-actor';
      chip.textContent = entry.actor + ' ' + entry.count;
      line.append(chip);
    });

    // The undo is offered WITHOUT a number.
    //
    // "Revert scout (9)" would be a count of what the agent did in the hour, and the
    // reader would reasonably read it as what is about to happen — but some of those
    // nine may be refused, and some may already have been put back. The honest number
    // only exists after the dry run, so the button asks first and the dialog says it.
    named.forEach((entry) => {
      const name = entry.actor.slice('agent:'.length);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'activity-agent';
      button.textContent = 'Revert ' + name + '’s last hour';
      button.title = 'Ask what taking back agent:' + name + '’s last hour would do, and then do it. ' +
        'Changes whose fields somebody else has touched since are refused rather than stamped over.';
      button.addEventListener('click', () => offerRevert(entry.actor, button));
      line.append(button);
    });

    const seen = document.createElement('button');
    seen.type = 'button';
    seen.className = 'activity-seen';
    seen.textContent = 'Mark as seen';
    seen.title = 'Start the diff again from the newest change. Nothing is deleted — the log keeps everything.';
    seen.addEventListener('click', () => { Store.markSeen(); renderActivity(); });
    line.append(seen);
  }

  /**
   * Offer to take an agent's last hour back, describing the undo before doing it.
   *
   * The dry run is not a preview feature — it is the same command with `dryRun`, so
   * the sentence in the confirmation is produced by the code that will do the work.
   * A separate "what would happen" implementation could disagree with the real one,
   * and the disagreement would show up after the fact.
   *
   * The window is computed ONCE and passed to both calls. Computing "the last hour"
   * twice would let the reader's own reading time shrink the window between the
   * promise and the act.
   */
  async function offerRevert(actor, anchor) {
    const since = new Date(Date.now() - Store.activity().undoWindowMs).toISOString();
    const plan = await Store.revert(actor, since, true);
    if (reportRefusal(plan, anchor)) return;
    const report = (plan && plan.value) || {};
    const willRevert = (report.willRevert || []).length;
    const conflicts = report.conflicts || [];
    const skipped = report.skipped || [];
    const who = actor.replace(/^agent:/, '');
    const window = 'since ' + new Date(since).toLocaleTimeString();

    if (!willRevert) {
      flash(conflicts.length
        ? 'Nothing by ' + who + ' can be put back ' + window + ' — ' + conflicts.length +
          ' change' + (conflicts.length === 1 ? ' was' : 's were') + ' refused because somebody changed the same field afterwards.'
        : 'Nothing by ' + who + ' in the last hour to put back.',
        anchor, { warn: true });
      return;
    }

    $('#confirmTitle').textContent = 'Revert ' + who + '’s last hour?';
    const parts = [
      willRevert + (willRevert === 1 ? ' change will be put back' : ' changes will be put back') +
        ' exactly as it was before agent:' + who + ' touched it, newest first.',
    ];
    if (conflicts.length) {
      parts.push(conflicts.length + (conflicts.length === 1 ? ' change is refused' : ' changes are refused') +
        ' because something else touched the same fields afterwards — ' +
        conflicts.map((c) => (c.name || c.entity) + (c.fields && c.fields.length ? ' [' + c.fields.join(', ') + ']' : '')).join('; ') +
        '. Those keep the value they have now.');
    }
    if (skipped.length) parts.push(skipped.length + ' cannot be compensated and will be left alone.');
    parts.push('The revert is itself a change, so it can be seen in the log and reverted in turn.');
    $('#confirmBody').textContent = parts.join(' ');
    $('#confirmOk').textContent = 'Revert ' + willRevert + (willRevert === 1 ? ' change' : ' changes');

    confirmDialog.__onOk = async () => {
      const result = await Store.revert(actor, since, false);
      if (reportRefusal(result, null)) return;
      const done = (result.value && result.value.reverted ? result.value.reverted.length : 0);
      const left = (result.value && result.value.conflicts ? result.value.conflicts.length : 0);
      refreshAfterWrite();
      flash(done + (done === 1 ? ' change by ' : ' changes by ') + who + ' put back' +
        (left ? ', ' + left + ' refused — a later edit touched the same field' : '') + '.',
        null, left ? { warn: true } : {});
    };
    confirmDialog.showModal();
  }

  /**
   * The one place the board's heading is written, because two routes mount the
   * board and each names itself: Daily is the whole board, and a project route is
   * that project's workspace, titled with the project's name either way.
   */
  function renderBoardHead(project) {
    const lens = project ? null : Store.projects().find((p) => p.id === lensProjectId());
    $('#scopeLabel').textContent = project
      ? (project.archivedAt ? 'PROJECT · ARCHIVED' : 'PROJECT')
      : (lens ? lens.name.toUpperCase() : 'ALL PROJECTS');
    $('#boardTitle').textContent = project ? project.name : 'Elastic Boards';
    $('#boardSub').textContent = project
      ? (project.description || 'Board and Timekeeping for this project.')
      : 'Backlog, live execution and finished work.';
  }

  function renderDaily() {
    renderBoardHead(null);
    renderActivity();
    render();
    renderTimekeeping();
  }

  /**
   * A project's workspace: the same board and Timekeeping, scoped by the ROUTE.
   * The lens dropdown is not touched — it is hidden here, and its value stays the
   * Daily board's own filter, which is why walking back to Daily is not a
   * surprise.
   */
  function renderProject(project) {
    renderBoardHead(project);
    renderActivity();
    render();
    renderTimekeeping();
  }

  function renderSchedule() {
    // Deliberately empty. The Schedule is a destination, not a surface: it says in
    // static markup that it is not built, and derives nothing to draw. The branch
    // exists so the dispatch has one arm per surface instead of a silent
    // fall-through that would read as an oversight.
  }

  /**
   * Render the surface the address names, and only that one.
   *
   * This is what replaced renderEverything(). "Everything" stopped being true the
   * moment the app had more than one surface: a pass that repaints unmounted
   * sections is wasted work, and — because a hidden element measures zero — it is
   * also a way to get an invented measurement onto the screen.
   */
  function renderRoute() {
    const surface = currentSurface();
    if (surface === 'daily') renderDaily();
    else if (surface === 'project') renderProject(Store.project(route().id));
    else if (surface === 'hub') renderHub();
    else if (surface === 'schedule') renderSchedule();
    // 'missing' draws nothing: the section is a statement, written once on entry.
  }

  /**
   * Enter a route: reveal first, render second, re-measure third.
   *
   * A hidden element measures zero, and two numbers in this app fall back to
   * invented ones when they read zero — the running column to its 300px baseline
   * and the timeline viewport to 600px. So rendering while hidden and revealing
   * afterwards would paint the board at the fallback height and the timeline at the
   * fallback width, and both would look plausible, which is the worst kind of
   * wrong. Visibility is therefore set first, and the render that follows reads
   * elements the browser has really laid out (reading clientWidth/clientHeight
   * forces that layout).
   *
   * The frame after that re-measures once more: the cards this pass inserted can
   * change the height their own column resolves to, so the number read before they
   * existed is not the number the proportional ratios should be applied to. This is
   * the same reset-then-repaint the window resize handler does, for the same reason.
   */
  function applyRoute() {
    const surface = currentSurface();
    const project = surface === 'project' ? Store.project(route().id) : null;
    setRouteVisibility(surface, project);
    if (surface === 'missing') describeMissingRoute();
    runningHeight = 0;
    renderRoute();
    if (surface !== 'daily' && surface !== 'project') return;
    requestAnimationFrame(() => {
      // The route can change again inside a frame — a quick Back then Forward would
      // otherwise settle the numbers on a surface that is no longer mounted.
      if (!boardMounted()) return;
      runningHeight = 0;
      paint();
    });
  }

  // ══ Projects Hub ═══════════════════════════════════════════════════════════
  // A portfolio view: a project's identity and its PRESSURE, legible before you
  // open anything. Every number on a card is derived from the tasks in the store
  // at render time — nothing here is stored, so nothing here can go stale or
  // disagree with the board it summarises.

  /**
   * A project's pressure, counted the same way the rest of the app counts it.
   * "Overdue" matches Timekeeping's band exactly: an open task whose deadline day
   * has passed, using end-of-day expiry so a task due today is not overdue.
   */
  function projectStats(project, tasks, now) {
    const own = tasks.filter((t) => t.project === project.id);
    const open = own.filter((t) => t.status !== 'finished');
    const overdue = open.filter((t) => t.deadline && dayEnd(t.deadline) < now).length;
    const p1 = open.filter((t) => t.weight >= P1_WEIGHT).length;
    const upcoming = open
      .filter((t) => t.deadline && dayEnd(t.deadline) >= now)
      .map((t) => dayStart(t.deadline));
    const nextDeadline = upcoming.length ? Math.min.apply(null, upcoming) : null;
    const reversed = own.filter((t) => isReversed(t)).length;
    return {
      total: own.length,
      open: open.length,
      finished: own.length - open.length,
      running: own.filter((t) => t.status === 'running').length,
      overdue: overdue,
      p1: p1,
      nextDeadline: nextDeadline,
      reversed: reversed,
      unplaced: open.filter((t) => !t.deadline).length,
    };
  }

  /**
   * A stable visual identity per project. The original tints a card by the
   * project's age relative to the others; we do not store an icon or a colour, so
   * identity is derived from the id — the same project always wears the same
   * colour, and no two projects in a Hub are likely to collide. Age is shown as
   * text instead, where it can be read rather than inferred from a shade.
   */
  function projectHue(project) {
    let hash = 0;
    const key = String(project.id || project.name || '');
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 360;
    return hash;
  }

  /** "3w ago", "2mo ago" — derived from an instant, never stored. */
  function ageLabel(iso, now) {
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) return 'unknown age';
    const mins = Math.floor((now - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + (days === 1 ? 'd' : 'd') + ' ago';
    const months = Math.floor(days / 30);
    if (months < 12) return months + 'mo ago';
    return Math.floor(months / 12) + 'y ago';
  }

  let showArchived = false;

  /**
   * What "P1" means here. We have no priority field — the store keeps weight, a
   * task's share of the run — so the Hub reads the closest thing it has rather
   * than inventing a field and leaving it empty. Weight 5+ is the heaviest fifth
   * of the scale, i.e. the work that dominates a horizon. Says so on hover.
   */
  const P1_WEIGHT = 5;

  function renderHub() {
    const tasks = Store.tasks();
    const now = Date.now();
    const projects = Store.projects().slice().sort((a, b) =>
      String(a.name).localeCompare(String(b.name)));
    const listed = projects.filter((p) => Boolean(p.archivedAt) === showArchived);

    const archivedCount = projects.filter((p) => p.archivedAt).length;
    $('#hubCount').textContent = projects.length === 0
      ? 'No projects'
      : showArchived
        ? archivedCount + (archivedCount === 1 ? ' archived project' : ' archived projects')
        : (projects.length - archivedCount) + ' active of ' + projects.length;

    const grid = $('#hubGrid');
    grid.replaceChildren();
    const none = listed.length === 0;
    $('#hubEmpty').hidden = !none;
    grid.hidden = none;
    if (none) {
      $('#hubEmpty').textContent = showArchived
        ? 'No archived projects.'
        : 'No projects yet. Create one and its tasks will gather here.';
      return;
    }

    listed.forEach((project) => grid.append(hubCardFor(project, projectStats(project, tasks, now), now)));
  }

  function hubCardFor(project, stats, now) {
    const card = document.createElement('article');
    card.className = 'hub-card' + (project.archivedAt ? ' archived' : '');
    card.dataset.id = project.id;
    card.style.setProperty('--hue', String(projectHue(project)));

    // Identity: a monogram block in the project's own colour, then name, then the
    // description the modal collects.
    const head = document.createElement('div');
    head.className = 'hub-head';
    const mark = document.createElement('span');
    mark.className = 'hub-mark';
    mark.textContent = (project.name || '?').trim().charAt(0).toUpperCase() || '?';
    mark.setAttribute('aria-hidden', 'true');
    const title = document.createElement('div');
    title.className = 'hub-title';
    const name = document.createElement('h3');
    name.textContent = project.name;
    title.append(name);
    const meta = document.createElement('p');
    meta.className = 'hub-meta';
    meta.textContent = project.archivedAt
      ? 'Archived ' + new Date(project.archivedAt).toLocaleDateString() + ' · age ' + ageLabel(project.createdAt, now)
      : 'Age ' + ageLabel(project.createdAt, now);
    title.append(meta);
    head.append(mark, title);
    if (project.archivedAt) {
      const badge = document.createElement('span');
      badge.className = 'hub-badge';
      badge.textContent = 'ARCHIVED';
      head.append(badge);
    }
    card.append(head);

    if (project.description) {
      const desc = document.createElement('p');
      desc.className = 'hub-desc';
      desc.textContent = project.description;
      card.append(desc);
    }

    // Pressure. The same numbers the board and Timekeeping will show once this
    // project is scoped, because they are counted from the same tasks.
    const pressure = document.createElement('div');
    pressure.className = 'hub-pressure';
    pressure.append(hubStat(String(stats.total) + (stats.total === 1 ? ' task' : ' tasks'), stats.total === 0 ? 'No tasks in this project yet' : stats.running + ' running, ' + stats.finished + ' finished'));
    pressure.append(hubStat(stats.overdue + ' overdue', stats.overdue === 0 ? 'Nothing past its deadline' : 'Deadlines that have passed', stats.overdue > 0 ? 'bad' : ''));
    pressure.append(hubStat(stats.p1 + ' P1', 'Tasks at weight ' + P1_WEIGHT + ' or above', stats.p1 > 0 ? 'hot' : ''));
    pressure.append(hubStat(
      stats.nextDeadline === null ? 'No next deadline' : 'Next ' + new Date(stats.nextDeadline).toLocaleDateString(),
      stats.nextDeadline === null ? 'No open task has a deadline' : 'The soonest deadline among open tasks',
      ''));
    card.append(pressure);

    // Anything the card knows is wrong with its own data says so, rather than
    // being averaged into a healthy-looking total.
    if (stats.reversed > 0) {
      const warn = document.createElement('p');
      warn.className = 'hub-warn';
      warn.textContent = '⚠ ' + stats.reversed + (stats.reversed === 1 ? ' task has' : ' tasks have') + ' reversed dates — open the project to fix';
      card.append(warn);
    }

    const acts = document.createElement('div');
    acts.className = 'hub-acts';

    // A card ENTERS the project: it is a destination, and this is a link, so the
    // address it goes to can be read, copied, bookmarked or opened in a new tab.
    // It used to set the project dropdown and re-render the page under the reader —
    // filtering dressed as navigation, which left them on the same page with a
    // changed control and a note telling them how to change it back.
    const open = document.createElement('a');
    open.className = 'primary';
    open.href = '#/project/' + encodeURIComponent(project.id);
    open.textContent = 'Open project';
    open.title = 'Open this project’s own workspace';
    acts.append(open);

    if (project.archivedAt) {
      acts.append(hubAction('Restore', 'Return this project to the active list', async (button) => {
        const result = await send('project.restore', { projectId: project.id });
        if (reportRefusal(result, button)) return;
        // The lens labels archived projects, so it is rebuilt with them.
        refreshProjectOptions();
        refreshAfterWrite();
      }));
    } else {
      acts.append(hubAction('Archive', 'Hide from the Hub without touching its tasks', async (button) => {
        const result = await send('project.archive', { projectId: project.id });
        if (reportRefusal(result, button)) return;
        // A lens pointing at a project that has just been archived is a state the
        // reader never asked for, so the lens is released with it. Only the lens:
        // which project the page IS is the address's business now.
        clearLensIf(project.id);
        refreshProjectOptions();
        refreshAfterWrite();
      }));
    }

    acts.append(hubAction('Delete', 'Delete this project', () => confirmDeleteProject(project, stats)));
    card.append(acts);
    return card;
  }

  function hubStat(value, title, tone) {
    const span = document.createElement('span');
    span.className = 'hub-stat' + (tone ? ' ' + tone : '');
    span.textContent = value;
    span.title = title;
    return span;
  }

  function hubAction(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Deleting a project does not delete its tasks. The dialog says exactly how many
   * will become uncategorised, because that number is the whole consequence and
   * the reader is entitled to it before agreeing.
   */
  function confirmDeleteProject(project, stats) {
    const taskWord = stats.total === 1 ? 'task' : 'tasks';
    const consequence = stats.total === 0
      ? 'It has no tasks.'
      : 'Its ' + stats.total + ' ' + taskWord + ' will not be deleted — they become uncategorised and stay on the board.';
    $('#confirmTitle').textContent = 'Delete “' + project.name + '”?';
    $('#confirmBody').textContent = consequence + ' This cannot be undone.';
    $('#confirmOk').textContent = stats.total === 0 ? 'Delete project' : 'Delete project, keep ' + stats.total + ' ' + taskWord;
    confirmDialog.__onOk = async () => {
      const result = await send('project.delete', { projectId: project.id });
      if (reportRefusal(result, null)) return;
      clearLensIf(project.id);
      refreshProjectOptions();
      refreshAfterWrite();
      const orphaned = (result.value && result.value.orphaned) || 0;
      flash('Deleted “' + project.name + '”. ' + (orphaned
        ? orphaned + ' ' + (orphaned === 1 ? 'task is' : 'tasks are') + ' now uncategorised.'
        : 'It had no tasks.'), null, {});
    };
    confirmDialog.showModal();
  }

  /**
   * Release the Daily lens when the project it points at stops being listed.
   *
   * Only the lens. Which project the page IS belongs to the address now, so a
   * project disappearing can no longer leave the page showing something that is
   * not there — and a stale address says so in its own words (see the missing
   * route) instead of silently falling back to the whole board.
   */
  function clearLensIf(projectId) {
    if (projectFilter.value === projectId) projectFilter.value = '';
  }

  /** A write landed: re-read it on the surface that is actually mounted. */
  const refreshAfterWrite = renderRoute;

  $$('.tk-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.panel;
      // Every panel toggles on its own and any combination is allowed — but not
      // none. Switching the last one off puts the timeline back, which is what the
      // original does, and Cockpit.prefs() enforces the same rule on the way in.
      //
      // This is a cockpit preference, not a board command: no event, no revision,
      // and a refusal means the composition will not survive the next reload rather
      // than that the change did not happen.
      const next = { ...panels, [key]: !panels[key] };
      const saved = Cockpit.patch(next);
      if (!saved) flash('This cockpit could not save its layout, so it will not be remembered.', btn, { warn: true });
      Object.assign(panels, saved || next);
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

  // ── Timeline zoom ─────────────────────────────────────────────────────────
  /**
   * The one way the zoom changes, whoever asked. Both the wheel and the header
   * buttons come through here, so they share the clamps and the persistence and
   * cannot drift apart.
   *
   * `anchorPx` is where in the viewport the zoom should hold still — the pointer,
   * for the wheel. Without it the view keeps its left edge, which is fine for a
   * button whose whole point is a predictable step.
   */
  function setTimelineZoom(nextZoom, anchorPx) {
    const clamped = Math.max(MIN_TL_ZOOM, Math.min(MAX_TL_ZOOM, nextZoom));
    if (Math.abs(clamped - tlZoom) < 0.01) return;

    // The grid does not start at the viewport's left edge: the ruler and the rows
    // sit inside an inset wrapper, so viewport pixel 0 is not day 0. Anchoring
    // without that offset creeps by the inset on every step of a wheel gesture —
    // small, systematic, and exactly the drift this anchoring exists to prevent.
    // Measured live, so moving the inset in CSS cannot silently break the zoom.
    const viewportRect = tlViewport.getBoundingClientRect();
    const anchor = Number.isFinite(anchorPx) ? anchorPx : 0;
    const gridOrigin = tlRows.getBoundingClientRect().left - viewportRect.left
      + tlViewport.scrollLeft;
    // What the anchor is pointing at, in days from the grid's own start. Kept
    // fractional: a whole-day-quantised anchor would jump the view by up to a day on
    // every step.
    const dayUnderAnchor = (anchor + tlViewport.scrollLeft - gridOrigin) / tlZoom;

    tlZoom = clamped;
    renderTimeline(deadlineTasks());

    // Put that same point back under the anchor at the new scale. This is the whole
    // difference between zooming that feels anchored and zooming that feels like
    // the timeline jumped: without it, whatever was under the cursor slides away.
    tlViewport.scrollLeft = gridOrigin + dayUnderAnchor * tlZoom - anchor;
    tickTimekeeping();
    saveZoomSoon();
  }

  /**
   * Remember the zoom in this cockpit, coalesced. A wheel gesture fires many events
   * and each one would otherwise be a write; the write is local (Cockpit), not a
   * board command, so it stays synchronous and cannot make the wheel stutter.
   */
  function saveZoomSoon() {
    window.clearTimeout(zoomSaveTimer);
    zoomSaveTimer = window.setTimeout(() => {
      if (!Cockpit.patch({ zoom: tlZoom })) {
        flash('This cockpit could not save the zoom, so it will not be remembered.', $('#tlViewport'), { warn: true });
      }
    }, 250);
  }

  /**
   * Ctrl+wheel to zoom, anchored to the pointer. Without ctrl the wheel is left
   * entirely alone, so the ordinary scroll — including the browser's own
   * page-scroll — keeps working.
   */
  tlViewport.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const rect = tlViewport.getBoundingClientRect();
    const pointerPx = event.clientX - rect.left;
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    setTimelineZoom(tlZoom * factor, pointerPx);
  }, { passive: false });

  $('#tlZoomIn').addEventListener('click', () => setTimelineZoom(tlZoom * 1.25, null));
  $('#tlZoomOut').addEventListener('click', () => setTimelineZoom(tlZoom * 0.8, null));
  $('#tlToday').addEventListener('click', () => scrollTimelineToToday(true));

  // ── Header grab-to-pan ────────────────────────────────────────────────────
  // The other half of the original's timeline navigation: the date ruler is a
  // handle. Small enough to fall out of the zoom work, so it did.
  (function wireHeaderPan() {
    let panning = false;
    let startX = 0;
    let startScroll = 0;
    const stop = () => {
      panning = false;
      document.body.classList.remove('tk-panning');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    const move = (event) => {
      if (!panning) return;
      tlViewport.scrollLeft = startScroll - (event.clientX - startX);
    };
    tlDates.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      panning = true;
      startX = event.clientX;
      startScroll = tlViewport.scrollLeft;
      document.body.classList.add('tk-panning');
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', stop);
    });
  })();

  // ── The stretch hint's key ────────────────────────────────────────────────
  // Shift+drag is invisible until you know it exists, so the gesture's one need is
  // to announce itself: while the binding key is held, the half of the bar under
  // the pointer is marked as the end a drag would take hold of. The key is tracked
  // here rather than read only at press time precisely so the hint can appear
  // BEFORE the press — a hint that only shows up after you have already committed
  // to the gesture is not a hint.
  window.addEventListener('keydown', (event) => {
    if (event.key !== STRETCH_BINDING.key) return;
    document.body.setAttribute(STRETCH_BINDING.hintAttr, 'true');
    if (lastPointer) showStretchHintAt(lastPointer.x, lastPointer.y);
  });
  const dropStretchHint = () => {
    document.body.removeAttribute(STRETCH_BINDING.hintAttr);
    clearStretchHints();
  };
  window.addEventListener('keyup', (event) => {
    if (event.key === STRETCH_BINDING.key) dropStretchHint();
  });
  // Key events are not delivered to a window that has lost focus, so a key held
  // while the reader switches away would otherwise leave the hint stuck on.
  window.addEventListener('blur', dropStretchHint);

  // Panning is view state only: it moves the bars' projection, never a task.
  tlViewport.addEventListener('scroll', () => tickTimekeeping());

  // The composition and the zoom this cockpit last left came in with `panels` and
  // `tlZoom` at the top of the file, out of Cockpit — not out of the board, which no
  // longer has an opinion about how it is being looked at. All-off can never be
  // loaded, and a corrupt or absent zoom reads as the default. Launching writes
  // nothing, to either place.
  syncPanelVisibility();
  ensureTarget();
  refreshProjectOptions();
  if (Store.run()) ticker = setInterval(tick, 1000);
  // The address decides what is mounted, here and on every later hash change.
  // Launching into `#/project/...` or `#/hub` is therefore the same code path as
  // walking there, and a refresh lands on the surface it names.
  window.addEventListener('hashchange', applyRoute);
  applyRoute();
  // Said after the surface is drawn, so the reader sees the app and the explanation
  // together rather than a notice over a blank page.
  reportLoadStatus();
  // One clock for the whole page. Nothing about a tick writes or rebuilds, and both
  // ticks leave a surface they are not mounted on alone.
  setInterval(tickTimekeeping, 1000);

  // ── Connecting to the service ─────────────────────────────────────────────
  // The first paint above used the local cache, so the cockpit opens instantly and
  // says what it is showing. Everything after this is the service: the board it
  // sends replaces the cache, and every later change — this cockpit's or another
  // one's — arrives as an event and redraws what is on screen.

  Store.onChange(() => {
    // Another cockpit, or a reconnection, changed the board under us.
    Object.assign(panels, Cockpit.prefs());
    syncPanelVisibility();
    refreshProjectOptions();
    if (Store.run() && !ticker) ticker = setInterval(tick, 1000);
    if (!Store.run() && ticker) stopTicker();
    renderRoute();
  });
  Store.onStatus((status) => updateServiceBanner(status));

  (async function connect() {
    await Store.bootstrap();
    Object.assign(panels, Cockpit.prefs());
    syncPanelVisibility();
    refreshProjectOptions();
    if (Store.run() && !ticker) ticker = setInterval(tick, 1000);
    renderRoute();
    updateServiceBanner(Store.loadStatus());
    if (Store.mode() === 'online' && legacyWantsAttention()) openMigrateDialog();
  })();

  $('#migrateConfirm').addEventListener('click', (event) => {
    event.preventDefault();
    if ($('#migrateConfirm').textContent === 'Done') { $('#migrateDialog').close(); return; }
    runMigration();
  });
  $('#migrateLater').addEventListener('click', (event) => {
    event.preventDefault();
    // Nothing is imported and nothing is deleted: the browser copy stays exactly
    // where it was, and the dialog can be asked for again from the banner.
    $('#migrateDialog').close();
  });
  $('#serviceBanner').addEventListener('click', () => {
    if (Store.mode() === 'offline') { Store.reconnect().catch(() => {}); return; }
    if (legacyWantsAttention()) openMigrateDialog();
  });
})();
