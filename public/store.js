/*
 * The store. One place, one format, no Markdown.
 *
 * Records live as plain objects in one JSON document under a single localStorage key.
 * Every write goes through save(), so there is exactly one path that can change
 * durable state and exactly one thing to swap out later (a file, SQLite, OPFS)
 * without the surface knowing.
 */
const Store = (() => {
  const KEY = 'proxima.store.v1';
  /** Where a store we could not read is parked, before anything can overwrite it. */
  const RESCUE_KEY = 'proxima.store.unreadable';
  const EMPTY = { version: 1, projects: [], tasks: [], run: null, views: null };

  /** Default composition of the Timekeeping cockpit. Its own save path, as ever. */
  const DEFAULT_VIEWS = { calendar: false, timeline: true, countdown: false };

  /**
   * Timeline zoom, in pixels per day. The original keeps this in plugin settings
   * (`settings.ts:18`, default 40) and so survives a reload; ours goes through
   * Store for the same reason the panel composition does. The bounds and the
   * default are the original's own (10–300, 40).
   */
  const DEFAULT_ZOOM = 40;
  const MIN_ZOOM = 10;
  const MAX_ZOOM = 300;

  /** The statuses the board actually has columns for. */
  const STATUSES = ['backlog', 'running', 'finished'];

  const loaded = load();
  let state = loaded.state;

  /**
   * Read the store.
   *
   * This NEVER destroys anything and never silently substitutes an empty store.
   * It reports what it found instead:
   *
   *   ok        — read and understood
   *   empty     — nothing stored yet; the normal first run
   *   wrong-version — a document from a different schema. Not corruption, and it
   *                   will happen the first time the schema changes, so it says so
   *                   specifically rather than presenting as an empty app.
   *   corrupt   — unparseable, or not an object. The bytes are still in
   *               localStorage, unread.
   *
   * When it cannot read the store it makes a copy under RESCUE_KEY, so the first
   * ordinary mutation cannot serialise empty state over data that was merely
   * unreadable. The copy is taken once and never overwritten by a later rescue.
   */
  function load() {
    const raw = safeGet(KEY);
    if (raw === null || raw === '') return { state: structuredClone(EMPTY), status: { kind: 'empty' } };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return damaged('corrupt', raw, 'The stored data is not valid JSON (' + String(error && error.name || 'parse error') + ').');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return damaged('corrupt', raw, 'The stored data is not in a shape this app recognises.');
    }
    if (parsed.version !== 1) {
      return damaged('wrong-version', raw,
        'The stored data was written by a different version of this app (found version ' +
        String(parsed.version) + ', this build reads version 1).');
    }
    return normalise(parsed);
  }

  /**
   * A document we will not read: park the bytes and report. Nothing is deleted,
   * and the rescue copy is only taken if there is not one already, so a later
   * launch cannot clobber the original with a subsequent bad write.
   */
  function damaged(kind, raw, detail) {
    let rescued = false;
    try {
      if (localStorage.getItem(RESCUE_KEY) === null) {
        localStorage.setItem(RESCUE_KEY, raw);
        rescued = true;
      }
    } catch {
      rescued = false; // nothing more we can do; the original is still in place
    }
    return { state: structuredClone(EMPTY), status: { kind: kind, detail: detail, rescued: rescued } };
  }

  /**
   * A readable document, checked field by field rather than trusted wholesale.
   * Entries that cannot be a task or a project are dropped and counted; a task
   * whose status is not one the board can show is placed in Backlog and counted,
   * because the alternative is a task that is counted in the header while
   * appearing in no column at all.
   */
  function normalise(parsed) {
    const notes = { droppedTasks: 0, droppedProjects: 0, unknownStatus: 0 };

    const projects = (Array.isArray(parsed.projects) ? parsed.projects : [])
      .map(normaliseProject)
      .filter((project) => {
        if (project) return true;
        notes.droppedProjects++;
        return false;
      });

    const knownProjects = new Set(projects.map((p) => p.id));
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .map((raw) => normaliseTask(raw, knownProjects, notes))
      .filter((task) => {
        if (task) return true;
        notes.droppedTasks++;
        return false;
      });

    return {
      state: {
        version: 1,
        projects: projects,
        tasks: tasks,
        run: parsed.run && typeof parsed.run === 'object' ? parsed.run : null,
        views: parsed.views && typeof parsed.views === 'object' ? parsed.views : null,
      },
      status: { kind: 'ok', notes: notes },
    };
  }

  /** A project, or null when the record cannot be one. */
  function normaliseProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    return {
      // Unknown fields survive; every field the Hub reads is brought into shape.
      ...raw,
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : 'Untitled project',
      description: typeof raw.description === 'string' ? raw.description : '',
      // Age is read from this, so it has to be a real instant. A project written
      // before the field existed is dated from now rather than left unusable.
      createdAt: validInstant(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
      // Archive state has ONE source of truth: this instant. `archivedAt` set
      // means archived, absent means active — there is no separate status flag to
      // fall out of step with it, and the Hub's "show archived" toggle only
      // decides what is listed.
      archivedAt: validInstant(raw.archivedAt) ? raw.archivedAt : null,
    };
  }

  function validInstant(value) {
    return typeof value === 'string' && value !== '' && !Number.isNaN(new Date(value).getTime());
  }

  /**
   * A task, or null when the record cannot be one. Unknown fields survive — the
   * store keeps what it was given — but every field the app relies on is brought
   * into a shape the app can actually render.
   */
  function normaliseTask(raw, knownProjects, notes) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;

    let status = raw.status;
    if (!STATUSES.includes(status)) {
      // Not silently dropped and not left to render nowhere: filed under Backlog,
      // which is where an unfinished task with an odd status belongs, and counted
      // so the reader is told.
      notes.unknownStatus++;
      status = 'backlog';
    }

    return {
      ...raw,
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : 'Untitled task',
      note: typeof raw.note === 'string' ? raw.note : '',
      // A project reference to a project that is not there reads as uncategorised
      // rather than pointing at nothing.
      project: knownProjects.has(raw.project) ? raw.project : '',
      status: status,
      weight: clampWeight(raw.weight),
      start: clampDay(raw.start, today()),
      deadline: clampDay(raw.deadline, ''),
      ganttRow: clampRow(raw.ganttRow),
      order: Number.isFinite(Number(raw.order)) ? Math.round(Number(raw.order)) : 0,
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    };
  }

  function safeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error && error.name || 'write-failed') };
    }
  }

  // ── The write contract ────────────────────────────────────────────────────
  // A mutation either persists or it visibly did not happen. There is no third
  // outcome, and no per-call-site handling: every mutation below runs inside
  // commit(), which snapshots the in-memory state, applies the change, and rolls
  // the whole state back if the write fails.
  //
  // Rolling back rather than keeping the change was the deliberate choice. A UI
  // that renders state the store does not hold is a lie, and this project has
  // spent several rounds removing exactly that shape of lie — the difference here
  // is only that the falsehood lasts until the next reload, when the work is
  // simply gone. The failure is reported through onWriteFailure so the surface can
  // say so plainly.
  let lastError = null;
  let failureHandler = null;

  /** Apply a change and persist it atomically. Returns null when it did not stick. */
  function commit(mutate) {
    const before = structuredClone(state);
    const result = mutate();
    const outcome = save();
    if (outcome.ok) { lastError = null; return result; }
    state = before;
    lastError = { reason: outcome.reason, at: new Date().toISOString() };
    if (failureHandler) {
      try { failureHandler(lastError); } catch { /* reporting must never throw */ }
    }
    return null;
  }

  const id = (prefix) => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  return {
    snapshot: () => structuredClone(state),

    /**
     * What happened when the store was read, and whether the last write failed.
     * The surface asks this once at startup, so unreadable data is reported rather
     * than presented as an empty app.
     */
    loadStatus: () => ({ ...loaded.status }),
    writeError: () => (lastError ? { ...lastError } : null),
    onWriteFailure(handler) { failureHandler = typeof handler === 'function' ? handler : null; },

    projects: () => state.projects.slice(),

    project: (projectId) => state.projects.find((p) => p.id === projectId) ?? null,

    addProject(name, description) {
      const project = {
        id: id('prj'),
        name: String(name).trim().slice(0, 120) || 'Untitled project',
        description: String(description || '').trim().slice(0, 500),
        createdAt: new Date().toISOString(),
        archivedAt: null,
      };
      return commit(() => { state.projects.push(project); return project; });
    },

    /** Archive state is this one field; there is no second flag to disagree with it. */
    setArchived(projectId, archived) {
      const project = state.projects.find((p) => p.id === projectId);
      if (!project) return null;
      return commit(() => {
        project.archivedAt = archived ? new Date().toISOString() : null;
        return project;
      });
    },

    /**
     * Delete a project. Its tasks are NOT deleted — they keep their text, dates and
     * history and become uncategorised. Deleting a container should not quietly
     * destroy the work inside it, and the confirmation says how many tasks are
     * affected before the reader agrees.
     */
    deleteProject(projectId) {
      const project = state.projects.find((p) => p.id === projectId);
      if (!project) return null;
      return commit(() => {
        const orphaned = state.tasks.filter((t) => t.project === projectId).length;
        state.tasks.forEach((t) => { if (t.project === projectId) t.project = ''; });
        state.projects = state.projects.filter((p) => p.id !== projectId);
        // A run's frozen plan references tasks, not projects, so it is untouched.
        return { orphaned: orphaned };
      });
    },

    tasks: () => state.tasks.slice(),
    task: (taskId) => state.tasks.find((t) => t.id === taskId) ?? null,

    addTask(fields) {
      const task = {
        id: id('tsk'),
        name: String(fields.name || '').trim().slice(0, 200) || 'Untitled task',
        note: String(fields.note || '').slice(0, 500),
        project: fields.project || '',
        status: STATUSES.includes(fields.status) ? fields.status : 'backlog',
        weight: clampWeight(fields.weight),
        start: clampDay(fields.start, today()),
        deadline: clampDay(fields.deadline, ''),
        // No row yet: the timeline packs a fresh task into the first row where it
        // does not overlap anything and writes the result back. A row is a
        // scheduling decision, so it lives on the task like any other field.
        ganttRow: null,
        order: state.tasks.length,
        createdAt: new Date().toISOString(),
      };
      return commit(() => { state.tasks.push(task); return task; });
    },

    updateTask(taskId, fields) {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      return commit(() => {
        if ('name' in fields) task.name = String(fields.name).trim().slice(0, 200) || task.name;
        if ('note' in fields) task.note = String(fields.note).slice(0, 500);
        if ('project' in fields) task.project = fields.project || '';
        if ('status' in fields && STATUSES.includes(fields.status)) task.status = fields.status;
        if ('weight' in fields) task.weight = clampWeight(fields.weight);
        if ('start' in fields) task.start = clampDay(fields.start, task.start || today());
        if ('deadline' in fields) task.deadline = clampDay(fields.deadline, '');
        // A timeline row: a small non-negative integer, or null for "not placed
        // yet" — which is what a task written before rows existed carries.
        if ('ganttRow' in fields) task.ganttRow = clampRow(fields.ganttRow);
        // DELIBERATE DIVERGENCE from the original, do not "restore fidelity" here.
        //
        // The original moves a startless task's whole bar by rewriting createdAt
        // (ProjectDeadlines.svelte:546-555; the same coupling appears in its calendar
        // drag at ProjectDeadlines.svelte:434-440). We do not, and there is
        // intentionally no createdAt path in this function: createdAt is provenance —
        // when the task came into existence — and a scheduling gesture must not
        // restate history. The coupling is not academic: countdown progress is
        // measured createdAt -> deadline, so a drag used to silently rewrite a task's
        // countdown. Scheduling intent is what `start` means, so the timeline
        // materialises a real start on the first deliberate whole-bar drag instead.
        // See the write site in app.js for the other half of this note.
        return task;
      });
    },

    deleteTask(taskId) {
      const before = state.tasks.length;
      return commit(() => {
        state.tasks = state.tasks.filter((t) => t.id !== taskId);
        return state.tasks.length < before;
      }) === true;
    },

    /** Move a task to a status, inserting it before `beforeId` (or at the end). */
    moveTask(taskId, status, beforeId) {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return false;
      return commit(() => {
        task.status = status;
        const rest = state.tasks.filter((t) => t.id !== taskId);
        const column = rest.filter((t) => t.status === status);
        const index = beforeId ? column.findIndex((t) => t.id === beforeId) : -1;
        if (index < 0) column.push(task); else column.splice(index, 0, task);
        column.forEach((t, i) => { t.order = i; });
        state.tasks = rest.filter((t) => t.status !== status).concat(column);
        return true;
      }) === true;
    },

    /**
     * The locked run, or null. A run carries the plan it was locked with:
     * `members` is a frozen snapshot of the participating tasks in order, each
     * with the weight and the calculated duration it was given at lock time, plus
     * the resolved start and end instants of its slot.
     *
     * That snapshot is the point. Without it, every tick re-derived the allocation
     * from whatever happened to be running, so editing a weight or dragging a task
     * into Running retroactively rewrote a horizon that was supposed to be frozen —
     * a task that joined halfway could show progress accrued before it took part.
     */
    run: () => (state.run ? { ...state.run, members: state.run.members ? state.run.members.map((m) => ({ ...m })) : null } : null),

    setRun(run) {
      // A locked run with no participants is not a run: there is no plan to
      // freeze and nothing to consume. Refuse it rather than store a ghost.
      if (run && Array.isArray(run.members) && run.members.length === 0) return null;
      return commit(() => {
        state.run = run
          ? {
            lockedAt: run.lockedAt,
            target: run.target,
            members: Array.isArray(run.members) ? run.members.map((m) => ({ ...m })) : null,
            total: Number(run.total) || 0,
          }
          : null;
        return state.run ? { ...state.run } : null;
      });
    },

    /**
     * The visible composition of the Timekeeping panels, so the workspace the
     * reader builds survives a reload. This is a read: it normalises whatever is
     * on disk into a usable shape and writes nothing, so merely launching the app
     * never touches the store.
     */
    views: () => normaliseViews(state.views),

    /**
     * Persist a composition, and the timeline's zoom with it. Writes only when
     * normalisation actually changed what is stored, so a no-op call leaves the
     * store byte-identical — which matters here because zoom changes arrive on
     * every wheel tick.
     */
    setViews(views) {
      const next = normaliseViews(views);
      const current = normaliseViews(state.views);
      if (next.calendar === current.calendar && next.timeline === current.timeline &&
          next.countdown === current.countdown && next.zoom === current.zoom) {
        return next;
      }
      const saved = commit(() => { state.views = next; return { ...next }; });
      // A refused write leaves the previous composition in place; report that,
      // rather than handing back a composition the store does not hold.
      return saved || current;
    },
  };

  /**
   * A composition the cockpit can actually show. All three panels off is not one
   * of them: fall back to the timeline, exactly as the original does when the last
   * panel is switched off. Also the single place a partial or absent record on
   * disk becomes a complete one, and where a missing or unusable zoom becomes the
   * default rather than a broken timeline.
   */
  function normaliseViews(value) {
    const views = {
      calendar: value ? Boolean(value.calendar) : DEFAULT_VIEWS.calendar,
      timeline: value && typeof value.timeline === 'boolean' ? value.timeline : DEFAULT_VIEWS.timeline,
      countdown: value ? Boolean(value.countdown) : DEFAULT_VIEWS.countdown,
      zoom: clampZoom(value ? value.zoom : undefined),
    };
    if (!views.calendar && !views.timeline && !views.countdown) views.timeline = true;
    return views;
  }

  function clampZoom(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_ZOOM;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
  }

  function clampWeight(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 1;
    return Math.min(100, Math.max(1, n));
  }

  /**
   * A timeline row. Anything that is not a usable row number becomes null, which
   * the timeline reads as "pack me" — so a missing or corrupt value results in a
   * placement rather than an invented one.
   */
  function clampRow(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(10000, n);
  }

  /**
   * A task day, kept as a YYYY-MM-DD string so a deadline or start never drifts by
   * a timezone. `fallback` is what an empty value resolves to, which is how tasks
   * written before the start field existed still get a usable date.
   *
   * The date has to EXIST, not merely look right: the shape check alone let
   * "2026-13-45" through, which parses as a real Date object rolled into the next
   * year and would then be rendered as a deadline that was never stored. Round-
   * tripping through Date is what proves it.
   */
  function clampDay(value, fallback) {
    const text = typeof value === 'string' ? value.trim().slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fallback;
    const parts = text.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const probe = new Date(y, m - 1, d);
    return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d ? text : fallback;
  }

  function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
})();
