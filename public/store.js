/*
 * The store, and the cockpit's own preferences beside it.
 *
 * BOARD DATA is structured fact: projects, tasks, the locked run, and the log of
 * every command that produced them. It is shared — Papers, an agent and this dev
 * cockpit are all looking at the same board — so it changes only through
 * `Store.command()`: one explicit, idempotent, logged command at a time, carrying
 * who asked and what revision they expected. Reads stay synchronous against the
 * in-memory snapshot, because that is what a render pass needs.
 *
 * Today the durable bytes live in IndexedDB and a command is applied and persisted in
 * one synchronous step. The command boundary is the point: in the next slice the
 * same envelope goes to a local service over HTTP, the same refusals come back as
 * structured codes, and the cockpit does not have to be rewritten to get there.
 * See DATA-PLANE.md in the project root for the destination, the vocabulary and
 * the refusal codes.
 *
 * COCKPIT PREFERENCES are not board data. Which Timekeeping panels are open and
 * how far the timeline is zoomed are properties of the cockpit you are sitting at,
 * not of the board: Papers and a laptop may look at one board at different zooms.
 * They live in `Cockpit` below, per client, and are read and written synchronously
 * because they are local and stay local.
 *
 * What this file keeps on purpose, because it earned it: exactly one path that can
 * change durable state; a rollback when that path cannot persist; a typed, visible
 * load or write failure instead of a fake empty board; unknown fields inside a
 * record preserved; stable ids and an immutable createdAt; the frozen run
 * snapshot; strict date and weight handling; and the rule that an invalid write is
 * REFUSED rather than made plausible.
 */

/**
 * Cockpit-local preference state and identity.
 *
 * Nothing here is shared, nothing here is a command and nothing here is logged:
 * losing a zoom level costs nothing, and a board that had to be told about it
 * would be a board that could disagree with the cockpit about how it looks.
 */
const Cockpit = (() => {
  const KEY = 'proxima.cockpit.v1';

  /**
   * Who is asking. The actor is the human; the client distinguishes the cockpit
   * they are asking from. Until there is a service to authenticate either, the
   * cockpit states them and the event log records them as stated.
   *
   * A client is named by the launcher (`?client=papers`), else by what it is
   * running as: the packaged app reads its files over `file:` and is therefore
   * Papers, and anything served over HTTP is named for its host. Deterministic on
   * purpose — a random id per launch would make the log unreadable.
   */
  const ACTOR = 'human:minh';
  const DEFAULT_PREFS = { calendar: false, timeline: true, countdown: false, zoom: 40 };
  const MIN_ZOOM = 10;
  const MAX_ZOOM = 300;

  function slug(value) {
    const text = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return text.slice(0, 40);
  }

  function detectClient() {
    let named = '';
    try {
      named = slug(new URLSearchParams(location.search).get('client'));
    } catch {
      named = '';
    }
    if (named) return named;
    if (location.protocol === 'file:') return 'papers';
    return slug(location.hostname + (location.port ? '-' + location.port : '')) || 'cockpit';
  }

  function readDocument() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      return { clients: {} };
    }
    if (!raw) return { clients: {} };
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { clients: {} };
      const clients = parsed.clients && typeof parsed.clients === 'object' && !Array.isArray(parsed.clients)
        ? parsed.clients
        : {};
      return { clients: clients };
    } catch {
      // A cockpit that cannot read its own preferences starts at the defaults. It
      // is not board data and it is not worth a rescue copy or a notice.
      return { clients: {} };
    }
  }

  const clientId = detectClient();
  let document_ = readDocument();
  let failureHandler = null;

  /**
   * A cockpit's preferences, made complete. All three panels off is not a
   * composition anyone can look at, so the timeline comes back — the same rule the
   * original applies when the last panel is switched off — and a zoom outside the
   * original's own bounds is brought inside them.
   */
  function normalisePrefs(value) {
    const prefs = {
      calendar: value ? Boolean(value.calendar) : DEFAULT_PREFS.calendar,
      timeline: value && typeof value.timeline === 'boolean' ? value.timeline : DEFAULT_PREFS.timeline,
      countdown: value ? Boolean(value.countdown) : DEFAULT_PREFS.countdown,
      zoom: clampZoom(value ? value.zoom : undefined),
    };
    if (!prefs.calendar && !prefs.timeline && !prefs.countdown) prefs.timeline = true;
    return prefs;
  }

  function clampZoom(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_PREFS.zoom;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
  }

  const prefs = () => normalisePrefs(document_.clients[clientId]);

  function hasStoredPrefs() {
    return Boolean(document_.clients[clientId]);
  }

  function write() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, clients: document_.clients }));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String((error && error.name) || 'write-failed') };
    }
  }

  return {
    actor: ACTOR,
    clientId: clientId,
    prefs: prefs,
    hasStoredPrefs: hasStoredPrefs,
    onWriteFailure(handler) { failureHandler = typeof handler === 'function' ? handler : null; },

    /**
     * Change this cockpit's preferences. Returns the preferences it now holds, or
     * null when the write was refused — in which case the caller is holding a
     * composition the cockpit cannot remember, and is told so rather than handed a
     * preference that is not stored.
     */
    patch(partial) {
      const next = normalisePrefs({ ...prefs(), ...(partial || {}) });
      const current = prefs();
      if (next.calendar === current.calendar && next.timeline === current.timeline &&
          next.countdown === current.countdown && next.zoom === current.zoom) {
        return next;
      }
      document_.clients[clientId] = next;
      const outcome = write();
      if (outcome.ok) return { ...next };
      document_.clients[clientId] = current;
      if (failureHandler) {
        try { failureHandler({ reason: outcome.reason, at: new Date().toISOString() }); } catch { /* reporting must never throw */ }
      }
      return null;
    },
  };
})();

const Store = (() => {
  const KEY = 'proxima.store.v1';
  /** Where a store we could not read is parked, before anything can overwrite it. */
  const RESCUE_KEY = 'proxima.store.unreadable';

  /**
   * The board document. `views` is deliberately absent: which panels a cockpit has
   * open is that cockpit's business and lives in Cockpit.
   */
  const EMPTY = {
    version: 1,
    projects: [],
    tasks: [],
    run: null,
    // Proxima-owned calendar records. These are deliberately separate from the
    // append-only command event log below and are never imported from a vault.
    scheduleEvents: [],
    timelineIntervals: [],
    timelineRows: [],
    importedRuns: [],
    remoteImports: [],
    // Append-only record of what changed, and the counter that numbers it.
    events: [],
    seq: 0,
    // commandId -> what that command did, so a replay returns the original result
    // instead of acting twice.
    commands: {},
  };

  /** The statuses the board actually has columns for. */
  const STATUSES = ['backlog', 'running', 'finished'];

  /**
   * How much history this build keeps. localStorage is a few megabytes and has
   * already run out once, so the log is trimmed rather than allowed to grow until
   * the next write fails. Trimming is a compromise, not a design: the service holds
   * the whole log in a table with no window at all, and `prunedThrough` is what
   * lets a reader tell "nothing happened before this" from "this is where my copy
   * starts".
   */
  const EVENT_MEMORY = 1000;
  const COMMAND_MEMORY = 200;

  const loaded = load();
  let state = loaded.state;

  /** What an older document kept under `views`, for Cockpit to adopt once. */
  const legacyViews = loaded.legacyViews;
  ensureTimelineRows();

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
   * ordinary command cannot serialise empty state over data that was merely
   * unreadable. The copy is taken once and never overwritten by a later rescue.
   *
   * Everything below this line is RESCUE: it makes old or damaged records usable.
   * It is emphatically not the policy for new writes — a command that is handed an
   * impossible date is refused with a code, not repaired into a plausible one. The
   * two jobs are different and are kept apart on purpose.
   */
  function load() {
    const raw = globalThis.ProximaPersistence ? ProximaPersistence.initialRaw : safeGet(KEY);
    if (raw === null || raw === '') return { state: structuredClone(EMPTY), status: { kind: 'empty' }, legacyViews: null };

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
    const outcome = normalise(parsed);
    outcome.legacyViews = parsed.views && typeof parsed.views === 'object' ? parsed.views : null;
    return outcome;
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
    return { state: structuredClone(EMPTY), status: { kind: kind, detail: detail, rescued: rescued }, legacyViews: null };
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
    const knownScheduleProjects = new Set(projects.filter((p) => p.projectType === 'schedule').map((p) => p.id));
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .map((raw) => normaliseTask(raw, knownProjects, notes))
      .filter((task) => {
        if (task) return true;
        notes.droppedTasks++;
        return false;
      });

    const events = (Array.isArray(parsed.events) ? parsed.events : []).filter((e) => e && typeof e === 'object');
    const scheduleEvents = (Array.isArray(parsed.scheduleEvents) ? parsed.scheduleEvents : [])
      .map((raw) => normaliseScheduleEvent(raw, knownScheduleProjects))
      .filter(Boolean);
    const seqFromEvents = events.reduce((max, e) => (Number.isFinite(Number(e.seq)) ? Math.max(max, Number(e.seq)) : max), 0);
    const commands = parsed.commands && typeof parsed.commands === 'object' && !Array.isArray(parsed.commands)
      ? parsed.commands
      : {};

    // Unknown top-level keys survive, so a document written by a later build is not
    // silently stripped of a section this build does not know about yet. `views` is
    // the one exception: it moved to the cockpit, and is adopted there rather than
    // left behind here to be read as board data.
    const known = new Set(['version', 'projects', 'tasks', 'run', 'scheduleEvents', 'events', 'seq', 'commands']);
    const extras = {};
    Object.keys(parsed).forEach((key) => {
      if (!known.has(key) && key !== 'views') extras[key] = parsed[key];
    });

    return {
      state: {
        ...extras,
        version: 1,
        projects: projects,
        tasks: tasks,
        run: parsed.run && typeof parsed.run === 'object' ? parsed.run : null,
        scheduleEvents: scheduleEvents,
        timelineIntervals: Array.isArray(parsed.timelineIntervals)?parsed.timelineIntervals:[],
        events: events,
        seq: Number.isFinite(Number(parsed.seq)) ? Math.max(Number(parsed.seq), seqFromEvents) : seqFromEvents,
        commands: commands,
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
      projectType: raw.projectType === 'schedule' ? 'schedule' : 'task',
      // Age is read from this, so it has to be a real instant. A project written
      // before the field existed is dated from now rather than left unusable.
      createdAt: validInstant(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
      // Archive state has ONE source of truth: this instant. `archivedAt` set
      // means archived, absent means active — there is no separate status flag to
      // fall out of step with it, and the Hub's "show archived" toggle only
      // decides what is listed.
      archivedAt: validInstant(raw.archivedAt) ? raw.archivedAt : null,
      // Every entity carries the revision its last command left it at, which is
      // what `ifRev` is checked against. A record from before revisions existed is
      // at revision 1, not at zero: zero would mean "never written".
      rev: positiveInt(raw.rev, 1),
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
      rev: positiveInt(raw.rev, 1),
    };
  }

  function normaliseScheduleEvent(raw, knownScheduleProjects) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
    if (!validInstant(raw.start) || !validInstant(raw.deadline)) return null;
    const start = new Date(raw.start);
    const deadline = new Date(raw.deadline);
    if (deadline.getTime() <= start.getTime()) return null;
    const recurrence = raw.recurrence && typeof raw.recurrence === 'object'
      ? {
        frequency: ['daily', 'weekly', 'monthly', 'custom'].includes(raw.recurrence.frequency) ? raw.recurrence.frequency : 'none',
        interval: Math.max(1, Math.min(52, Math.round(Number(raw.recurrence.interval) || 1))),
        count: Math.max(0, Math.min(365, Math.round(Number(raw.recurrence.count) || 0))),
        until: isRealDay(raw.recurrence.until) ? raw.recurrence.until : '',
        weekdays: Array.isArray(raw.recurrence.weekdays) ? raw.recurrence.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).filter((day, index, all) => all.indexOf(day) === index).sort((a, b) => a - b) : [],
        unit: raw.recurrence.frequency === 'daily' ? 'days' : raw.recurrence.frequency === 'weekly' ? 'weeks' : raw.recurrence.frequency === 'monthly' ? 'months' : ['days', 'weeks', 'months'].includes(raw.recurrence.unit) ? raw.recurrence.unit : 'days',
      }
      : { frequency: 'none', interval: 1, count: 0, until: '', weekdays: [], unit: 'days' };
    const exceptions = Array.isArray(raw.exceptions)
      ? raw.exceptions.map(normaliseScheduleException).filter(Boolean)
      : [];
    return {
      ...raw,
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : 'Untitled event',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 1000) : '',
      project: knownScheduleProjects.has(raw.project) ? raw.project : '',
      start: start.toISOString(),
      deadline: deadline.toISOString(),
      recurrence: recurrence,
      exceptions: exceptions,
      sourceKey: typeof raw.sourceKey === 'string' ? raw.sourceKey : '',
      color: typeof raw.color === 'string' ? raw.color : '',
      createdAt: validInstant(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
      rev: positiveInt(raw.rev, 1),
    };
  }

  function normaliseScheduleException(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !raw.key) return null;
    if (raw.cancelled) return { key: raw.key, cancelled: true };
    if (!validInstant(raw.start) || !validInstant(raw.deadline) || new Date(raw.deadline) <= new Date(raw.start)) return null;
    return {
      key: raw.key,
      start: new Date(raw.start).toISOString(),
      deadline: new Date(raw.deadline).toISOString(),
      name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : '',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 1000) : '',
      color: typeof raw.color === 'string' ? raw.color : '',
      cancelled: false,
      detached: true,
    };
  }

  function normaliseRecurrence(raw) {
    if (!raw || typeof raw !== 'object') return { frequency: 'none', interval: 1, count: 0, until: '', weekdays: [], unit: 'days' };
    const frequency = ['daily', 'weekly', 'monthly', 'custom'].includes(raw.frequency) ? raw.frequency : raw.frequency === 'none' ? 'none' : null;
    if (!frequency) return null;
    return {
      frequency: frequency,
      interval: Math.max(1, Math.min(52, Math.round(Number(raw.interval) || 1))),
      count: Math.max(0, Math.min(365, Math.round(Number(raw.count) || 0))),
      until: isRealDay(raw.until) ? raw.until : '',
      weekdays: Array.isArray(raw.weekdays) ? raw.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).filter((day, index, all) => all.indexOf(day) === index).sort((a, b) => a - b) : [],
      unit: frequency === 'daily' ? 'days' : frequency === 'weekly' ? 'weeks' : frequency === 'monthly' ? 'months' : ['days', 'weeks', 'months'].includes(raw.unit) ? raw.unit : 'days',
    };
  }

  function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  }

  // ── Read-time rescue ──────────────────────────────────────────────────────
  // The three helpers below make a record READABLE. They are the opposite of
  // VALIDATION further down, which refuses a command: this half repairs what is
  // already on disk, because a task with an impossible date still has to appear
  // somewhere, while a command handed an impossible date must not be obeyed. Keep
  // them apart.

  /**
   * A day that really exists, not merely one that looks like a date. The shape
   * check alone let "2026-13-45" through, which parses as a real Date object rolled
   * into the next year and would then be rendered as a deadline nobody stored.
   * Round-tripping through Date is what proves it.
   *
   * Shared by both halves on purpose: the rescue half uses it to decide a stored
   * value is unusable, and the command half uses it to refuse a new one. One
   * definition of "a real day", two different things done about it.
   */
  function isRealDay(value) {
    const text = typeof value === 'string' ? value.trim().slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const parts = text.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const probe = new Date(y, m - 1, d);
    return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
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
   * a timezone. `fallback` is what an empty or unusable value resolves to, which is
   * how tasks written before the start field existed still get a usable date.
   */
  function clampDay(value, fallback) {
    const text = typeof value === 'string' ? value.trim().slice(0, 10) : '';
    return isRealDay(text) ? text : fallback;
  }

  function safeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  async function save() {
    try {
      if(globalThis.ProximaPersistence) await ProximaPersistence.write(state);
      else localStorage.setItem(KEY, JSON.stringify(state));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error && error.name || 'write-failed') };
    }
  }

  // ── The write contract ────────────────────────────────────────────────────
  // A command either persists or it visibly did not happen. There is no third
  // outcome, and no per-call-site handling: every command below runs inside
  // commit(), which snapshots the in-memory state, applies the change — the data,
  // the revision, the event and the command's own memory of itself, all together —
  // and rolls the whole lot back if the write fails.
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
  async function commit(mutate) {
    const before = structuredClone(state);
    const result = mutate();
    const outcome = await save();
    if (outcome.ok) { lastError = null; return result; }
    state = before;
    lastError = { reason: outcome.reason, at: new Date().toISOString() };
    if (failureHandler) {
      try { failureHandler(lastError); } catch { /* reporting must never throw */ }
    }
    return null;
  }

  const id = (prefix) => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ── The command layer ─────────────────────────────────────────────────────
  // One envelope, one vocabulary, one place where a refusal is decided.
  //
  //   command({ type, payload, commandId, ifRev, actor, client })
  //
  //     type       one of COMMANDS below — the whole vocabulary, nothing implied
  //     payload    the command's own shape (see DATA-PLANE.md)
  //     commandId  idempotency key. Replaying an id returns what it did the first
  //                time. Omitted means "this is a fresh act" and one is minted.
  //     ifRev      the revision the caller believed the entity was at. A mismatch
  //                is refused rather than applied over somebody else's change.
  //     actor, client  who and where; defaulted from the cockpit until a service
  //                can say for certain.
  //
  // Resolves — never rejects — with either
  //   { ok: true,  commandId, seq, rev, value, changed, replayed }
  //   { ok: false, commandId, code, message, details }
  // so a caller has exactly one thing to handle and the same shape arrives from
  // HTTP in the next slice.

  const REFUSAL_MESSAGES = {
    COMMAND_UNKNOWN: (d) => 'This build has no command called “' + d.type + '”.',
    COMMAND_NOT_IMPLEMENTED: (d) => '“' + d.type + '” is part of the destination but is not served yet.',
    PAYLOAD_INVALID: (d) => 'That ' + d.type + ' command is missing ' + (d.missing || []).join(', ') + '.',
    COMMAND_ID_CONFLICT: () => 'That command id was already used for a different command.',
    ENTITY_NOT_FOUND: (d) => 'There is no ' + d.kind + ' with the id “' + d.id + '”.',
    ENTITY_REV_CONFLICT: (d) => 'Somebody else changed this ' + d.kind + ' first (you expected revision ' + d.expected + ', it is at ' + d.actual + '). Nothing was written.',
    NAME_REQUIRED: () => 'A name is required.',
    DATE_INVALID: (d) => '“' + d.value + '” is not a real date, so ' + d.field + ' was not written.',
    DEADLINE_BEFORE_START: (d) => 'The deadline (' + d.deadline + ') is before the start (' + d.start + '). Nothing was written.',
    WEIGHT_INVALID: (d) => 'A weight has to be a whole number from 1 to 100; “' + d.value + '” is not.',
    STATUS_UNKNOWN: (d) => '“' + d.value + '” is not a column this board has (' + (d.allowed || []).join(', ') + ').',
    PROJECT_NOT_FOUND: (d) => 'There is no project with the id “' + d.projectId + '”.',
    GANTT_ROW_INVALID: (d) => '“' + d.value + '” is not a timeline row.',
    EVENT_TIME_INVALID: (d) => '“' + d.value + '” is not a valid event time.',
    EVENT_END_BEFORE_START: (d) => 'The event ends before it starts. Nothing was written.',
    RECURRENCE_INVALID: () => 'That recurrence is not supported. Choose none, daily, or weekly.',
    PROJECT_TYPE_INVALID: () => 'Schedule events can only belong to Schedule projects.',
    OCCURRENCE_INVALID: () => 'That scheduled occurrence is no longer available.',
    FIELD_NOT_PATCHABLE: (d) => 'task.patch cannot change ' + d.field + ' — use ' + d.use + '.',
    MOVE_ANCHOR_NOT_IN_COLUMN: (d) => 'The task to insert before is not in that column any more.',
    RUN_HAS_NO_MEMBERS: () => 'Nothing to lock — no tasks are in the running column.',
    RUN_TARGET_INVALID: (d) => '“' + d.target + '” is not an instant in the future, so there is no horizon to lock.',
    RUN_ALREADY_LOCKED: () => 'A run is already locked. Unlock it before locking another.',
    WRITE_FAILED: (d) => 'Not saved — the browser refused the write (' + d.reason + '). The change has been undone so nothing on screen is unsaved.',
  };

  const VALIDATION = {
    day(value) {
      return isRealDay(value);
    },
    weight(value) {
      const n = Number(value);
      return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 100;
    },
    row(value) {
      if (value === null) return true;
      const n = Number(value);
      return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 10000;
    },
  };

  function refuse(code, details) {
    const shape = details || {};
    const build = REFUSAL_MESSAGES[code];
    return {
      ok: false,
      code: code,
      details: shape,
      message: build ? build(shape) : 'That command was refused (' + code + ').',
    };
  }

  /**
   * A stable fingerprint of what a command was asked to do, so a reused id with a
   * different intent is caught. Key order is normalised because two callers
   * building the same payload should not look like two different commands.
   */
  function fingerprint(type, payload) {
    const stable = (value) => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
      if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
      return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    };
    return type + ' ' + stable(payload || {});
  }

  const findTask = (taskId) => state.tasks.find((t) => t.id === taskId) || null;
  const findProject = (projectId) => state.projects.find((p) => p.id === projectId) || null;
  const findScheduleEvent = (eventId) => state.scheduleEvents.find((e) => e.id === eventId) || null;
  const findScheduleException = (event, key) => (event && Array.isArray(event.exceptions) ? event.exceptions.find((exception) => exception.key === key) : null) || null;

  /** The revision a command's `ifRev` is checked against. */
  function revisionOf(kind, targetId) {
    if (kind === 'timeline-interval') {const item=state.timelineIntervals.find(x=>x.id===targetId);return item?.rev??null;}
    if (kind === 'task') { const t = findTask(targetId); return t ? t.rev : null; }
    if (kind === 'project') { const p = findProject(targetId); return p ? p.rev : null; }
    if (kind === 'run') return state.run ? positiveInt(state.run.rev, 1) : null;
    if (kind === 'schedule-event') { const e = findScheduleEvent(targetId); return e ? e.rev : null; }
    return null;
  }

  /**
   * Refuse an `ifRev` that does not match, before anything is touched. The expected
   * revision travels in the ENVELOPE, not in the payload: it is about the state the
   * caller believed it was editing, which is a property of the request rather than
   * of the change. An absent `ifRev` means the caller is not racing anybody — the
   * UI's own edits are of that kind — and the command proceeds.
   */
  function checkRev(ctx, kind, targetId) {
    const ifRev = ctx.ifRev;
    if (ifRev === undefined || ifRev === null) return null;
    const actual = revisionOf(kind, targetId);
    if (actual === null) return refuse('ENTITY_NOT_FOUND', { kind: kind, id: targetId });
    if (Number(ifRev) !== actual) {
      return refuse('ENTITY_REV_CONFLICT', { kind: kind, id: targetId, expected: Number(ifRev), actual: actual });
    }
    return null;
  }

  /**
   * Refusals are remembered for the session, in memory only, and only against the
   * exact command that was refused.
   *
   * Two reasons for the fingerprint. A refusal changes nothing, so the id is not
   * spent: a caller that fixes its payload and sends the same id again is making a
   * fresh attempt, not replaying one — which is exactly what the task dialog does
   * when the reader corrects a weight and presses Save again. And a byte-identical
   * replay inside one session still gets the original code rather than whatever the
   * changed state would now say.
   *
   * They are deliberately not persisted: refusing is not an event, and a refusal is
   * not worth a write that could itself fail.
   */
  const refusalMemory = new Map();

  /**
   * The vocabulary. Each handler VALIDATES and returns a closure that applies the
   * change; nothing is mutated until the whole command is known to be acceptable,
   * so a refusal can never leave half a change behind.
   *
   * Handlers return either
   *   { ok: true, apply: () => ({ value, entity, before, after, changed, extra }) }
   *   { ok: false, ... refusal }
   */
  function ensureTimelineRows(){state.timelineRows=Array.isArray(state.timelineRows)?state.timelineRows:[];state.timelineIntervals.forEach((item,index)=>{item.rowId=item.rowId||item.id;if(!state.timelineRows.some(row=>row.id===item.rowId))state.timelineRows.push({id:item.rowId,name:item.name||'Activity',color:item.color||'#a1cc43',rowOrder:Number.isFinite(item.rowOrder)?item.rowOrder:index});});}
  function overlapsSession(candidate,exclude){return state.timelineIntervals.some(item=>item.id!==exclude&&item.rowId===candidate.rowId&&Date.parse(candidate.start)<(item.followNow?Infinity:Date.parse(item.end))&&Date.parse(item.start)<(candidate.followNow?Infinity:Date.parse(candidate.end)));}
  // Queue proportions are durable; their current endpoints are a read-time projection.
  function queueForInterval(id){return state.timelineRows.find(row=>row.queue?.ids?.includes(id));}
  function queueProjection(row,now=Date.now(),sessions=state.timelineIntervals){return ProximaRemoteDomain.queueProjection(row,sessions,now);}
  function queueChange(apply){return {ok:true,apply:()=>{const value=apply();return {changed:true,entity:{kind:'timeline-queue',id:'queue'},value};}};}
  // Rows in the order the timeline draws them: by their intervals' rowOrder, else the row's own. A row's stored
  // rowOrder can lag its intervals (an undo restores interval orders only), so renumbering never trusts it alone.
  function displayRows(){const shown=row=>{const orders=state.timelineIntervals.filter(x=>x.rowId===row.id&&Number.isFinite(x.rowOrder)).map(x=>x.rowOrder);return orders.length?Math.min(...orders):row.rowOrder;};return state.timelineRows.map((row,index)=>({row,order:shown(row),index})).sort((a,b)=>a.order-b.order||a.row.rowOrder-b.row.rowOrder||a.index-b.index).map(x=>x.row);}
  function timelineSnapshot(){return {rows:structuredClone(state.timelineRows),sessions:structuredClone(state.timelineIntervals)};}
  const followObservations=new Map();
  function followedRead(now=Date.now()){const projected=new Map();for(const receipt of state.remoteImports||[]){const follow=receipt.follow;if(!follow?.enabled)continue;const observation=followObservations.get(receipt.id),source=observation?.projection||follow.snapshot;if(!source)continue;const sourceNow=Date.parse(source.source.observedAt)+(observation?.online?Math.max(0,now-observation.receivedAt):0),effective=new Map();for(const row of source.records.timelineRows)if(row.queue)for(const [id,item] of queueProjection(row,sourceNow,source.records.timelineIntervals))effective.set(id,item);const snapshot=structuredClone(source);snapshot.effectiveIntervals=source.records.timelineIntervals.map(item=>{const value={...item,...(effective.get(item.id)||{}),...(item.followNow&&!effective.has(item.id)?{end:new Date(Math.max(Date.parse(item.start)+1,sourceNow)).toISOString()}: {})};return Object.fromEntries(['id','start','end','followNow','color','queueId','queueIndex','queueEnd'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));});let candidate;try{candidate=ProximaRemoteDomain.prepareImport(ProximaRemoteFollow.subset(snapshot,follow.entries.filter(entry=>!entry.independent)),receipt.id);}catch{continue;}for(const entry of follow.entries.filter(entry=>entry.kind==='timelineIntervals'&&!entry.independent&&!entry.conflict&&!entry.deleted)){const local=state.timelineIntervals.find(item=>item.id===entry.localId),rowId=local?.rowId,related=follow.entries.filter(other=>other.kind==='timelineRows'&&other.localId===rowId||other.kind==='timelineIntervals'&&state.timelineIntervals.find(item=>item.id===other.localId)?.rowId===rowId);if(related.some(other=>other.independent||other.conflict||ProximaRemoteDomain.semantic(other.kind,(state[other.kind]||[]).find(item=>item.id===other.localId))!==other.localBase))continue;const item=candidate.records.timelineIntervals.find(item=>item.id===entry.localId),raw=source.records.timelineIntervals.find(item=>item.id===entry.sourceId);if(item&&raw&&(raw.followNow||source.records.timelineRows.some(row=>row.queue?.ids.includes(raw.id))))projected.set(entry.localId,{start:item.start,end:item.end,sourceFollowing:true,sourceLive:observation?.online===true,sourceOwner:receipt.label||source.source.ownerId});}}return projected;}
  function timelineRead(now=Date.now()){const projections=followedRead(now);for(const row of state.timelineRows)if(row.queue)for(const [id,value] of queueProjection(row,now))projections.set(id,value);return state.timelineIntervals.map(x=>{const row=state.timelineRows.find(row=>row.id===x.rowId);return {...x,...(row?{color:row.queue||row.independentColors?(x.color||row.color):row.color,rowOrder:row.rowOrder}:{}),...(projections.get(x.id)||{})};});}
  function freezeFollowEdit(envelope){const type=envelope?.type||'',payload=envelope?.payload||{};if(!type.startsWith('timeline-interval.')&&!type.startsWith('timeline-queue.')||type.includes('reorder')||envelope.commandId&&state.commands[envelope.commandId])return null;const selected=new Set(payload.intervalIds||[payload.intervalId].filter(Boolean)),rows=new Set(payload.rowIds||[payload.rowId].filter(Boolean));for(const item of state.timelineIntervals)if(selected.has(item.id))rows.add(item.rowId);const projected=followedRead(),updates=state.timelineIntervals.filter(item=>rows.has(item.rowId)&&projected.has(item.id));if(!updates.length)return null;const before=structuredClone(state);for(const item of updates){const value=projected.get(item.id);item.start=value.start;item.end=value.end;item.followNow=false;}return before;}
  function syncTimelineRows(type,payload){ensureTimelineRows();if(type==='timeline-interval.patch'){const item=state.timelineIntervals.find(x=>x.id===payload.intervalId),row=item&&state.timelineRows.find(x=>x.id===item.rowId);if(row&&!row.queue&&!row.independentColors)for(const key of ['color'])if(payload.patch?.[key]!==undefined)row[key]=payload.patch[key];}if(type.includes('reorder')){const ids=payload.intervalIds||[payload.intervalId];for(const id of ids){const item=state.timelineIntervals.find(x=>x.id===id),row=item&&state.timelineRows.find(x=>x.id===item.rowId);if(row)row.rowOrder=item.rowOrder;}}for(const item of state.timelineIntervals){const row=state.timelineRows.find(x=>x.id===item.rowId);if(row){if(!row.queue&&!row.independentColors)item.color=row.color;item.rowOrder=row.rowOrder;}}if(type.includes('delete'))for(const row of state.timelineRows){if(!row.queue)continue;const previous=row.queue.ids[0];row.queue.ids=row.queue.ids.filter(id=>state.timelineIntervals.some(x=>x.id===id));if(previous!==row.queue.ids[0]){const next=state.timelineIntervals.find(x=>x.id===row.queue.ids[0]);if(next){next.start=new Date(Date.now()).toISOString();next.end=new Date(Date.now()+1).toISOString();next.followNow=true;next.rev++;}}}if(type.includes('delete'))state.timelineRows=state.timelineRows.filter(row=>row.queue||state.timelineIntervals.some(x=>x.rowId===row.id));}
  function intervalRowPosition(beforeId,exclude){const rows=state.timelineIntervals.map((item,index)=>({item,order:Number.isFinite(item.rowOrder)?item.rowOrder:index})).filter(x=>x.item.id!==exclude).sort((a,b)=>a.order-b.order);const index=beforeId?rows.findIndex(x=>x.item.id===beforeId):rows.length;if(index<0)return null;if(!rows.length)return 0;if(index===0)return rows[0].order-1;if(index===rows.length)return rows.at(-1).order+1;return (rows[index-1].order+rows[index].order)/2;}

  function timelineHistory(){return state.timelineHistory||(state.timelineHistory={undo:[],redo:[]});}
  function timelineRestore(direction){const history=timelineHistory(),entry=history[direction].at(-1);if(entry?.beforeState){const desired=direction==='undo'?entry.beforeState:entry.afterState,expected=direction==='undo'?entry.afterState:entry.beforeState;const comparable=value=>JSON.stringify(value,(key,val)=>key==='rev'?undefined:val);if(comparable(timelineSnapshot())!==comparable(expected))return refuse('HISTORY_CONFLICT',{});return {ok:true,apply:()=>{const old=new Map(state.timelineIntervals.map(x=>[x.id,x.rev]));state.timelineRows=structuredClone(desired.rows);state.timelineIntervals=structuredClone(desired.sessions).map(x=>({...x,rev:(old.get(x.id)||x.rev||1)+1}));history[direction].pop();history[direction==='undo'?'redo':'undo'].push(entry);return {changed:true,entity:{kind:'timeline-batch',id:'rows'},value:null,before:expected,after:desired};}};}if(!entry)return {ok:true,apply:()=>({changed:false,value:null})};if(entry.entries){const target=direction==='undo'?'before':'after',expectedKey=direction==='undo'?'after':'before';const comparable=x=>x?JSON.stringify(Object.fromEntries(Object.entries(x).filter(([key])=>key!=='rev').sort(([a],[b])=>a.localeCompare(b)))):'null';if(entry.entries.some(x=>{const current=state.timelineIntervals.find(item=>item.id===x.id);return comparable(current||null)!==comparable(x[expectedKey]);}))return refuse('HISTORY_CONFLICT',{});return {ok:true,apply:()=>{const before=[];for(const change of entry.entries){const item=state.timelineIntervals.find(x=>x.id===change.id);before.push(item?{...item}:null);const desired=change[target];if(!desired){state.timelineIntervals=state.timelineIntervals.filter(x=>x.id!==change.id);}else if(item){const rev=item.rev+1;Object.assign(item,desired,{rev});}else{state.timelineIntervals.push({...desired,rev:(desired.rev||1)+1});}}for(const change of entry.entries){const item=state.timelineIntervals.find(x=>x.id===change.id),row=item&&state.timelineRows.find(x=>x.id===item.rowId);if(row&&Number.isFinite(item.rowOrder))row.rowOrder=item.rowOrder;}history[direction].pop();history[direction==='undo'?'redo':'undo'].push(entry);return {changed:true,entity:{kind:'timeline-batch',id:'rows'},before,after:entry.entries.map(x=>{const item=state.timelineIntervals.find(item=>item.id===x.id);return item?{...item}:null;}),value:{ids:entry.entries.map(x=>x.id)}};}};}const expected=direction==='undo'?entry.after:entry.before,desired=direction==='undo'?entry.before:entry.after,current=state.timelineIntervals.find(x=>x.id===entry.id)||null;const comparable=x=>x?JSON.stringify(Object.fromEntries(Object.entries(x).filter(([key])=>key!=='rev').sort(([a],[b])=>a.localeCompare(b)))):'null';if(comparable(expected)!==comparable(current))return refuse('HISTORY_CONFLICT',{});return {ok:true,apply:()=>{const before=current?{...current}:null;state.timelineIntervals=state.timelineIntervals.filter(x=>x.id!==entry.id);let restored=null;if(desired){restored={...desired,rev:current?current.rev:(desired.rev||1)+1};state.timelineIntervals.push(restored);}history[direction].pop();history[direction==='undo'?'redo':'undo'].push(entry);return {changed:true,created:!current&&!!desired,value:restored?{...restored}:{id:entry.id},entity:{kind:'timeline-interval',id:entry.id},before,after:restored?{...restored}:null};}};}

  function remoteIntent(payload){const value={projection:payload.projection,importId:payload.importId,mode:payload.mode||'independent'};if(value.mode==='follow'){value.receiver=payload.receiver;value.binding=payload.binding;}return fingerprint('remote.import',value);}
  function remoteCandidate(payload){if(!['independent','follow'].includes(payload.mode||'independent'))throw Error('Unsupported copy mode.');const candidate=ProximaRemoteDomain.prepareImport(payload.projection,payload.importId);if(payload.mode==='follow')candidate.follow=ProximaRemoteFollow.create(candidate,payload.projection,payload.receiver,payload.binding);return candidate;}
  function remoteTimelineSafe(updates){const affected=new Set(updates.filter(update=>update.kind==='timelineIntervals').flatMap(update=>[update.incoming?.rowId,state.timelineIntervals.find(item=>item.id===update.localId)?.rowId]));const sessions=state.timelineIntervals.filter(item=>affected.has(item.rowId)).map(item=>updates.find(update=>update.kind==='timelineIntervals'&&update.localId===item.id)?.incoming||item);return !sessions.some(a=>sessions.some(b=>a.id!==b.id&&a.rowId===b.rowId&&Date.parse(a.start)<(b.followNow?Infinity:Date.parse(b.end))&&Date.parse(b.start)<(a.followNow?Infinity:Date.parse(a.end))));}
  const COMMANDS = {
    'remote.import-stage'(payload){
      let candidate;try{candidate=remoteCandidate(payload);}catch(error){return refuse('IMPORT_INVALID',{reason:error.message});}
      const intent=remoteIntent(payload),pending=state.remotePendingImports||[],receipts=state.remoteImports||[];
      if(!Array.isArray(pending)||!Array.isArray(receipts))return refuse('IMPORT_INVALID',{reason:'Local import history needs recovery.'});const saved=pending.find(item=>item.id===payload.importId);
      if(saved){if(saved.fingerprint!==intent)return refuse('IMPORT_ID_CONFLICT',{});return {ok:true,apply:()=>({changed:false,value:{importId:payload.importId}})};}
      const completed=receipts.find(item=>item.id===payload.importId);if(completed){if(completed.fingerprint!==intent)return refuse('IMPORT_ID_CONFLICT',{});return {ok:true,apply:()=>({changed:false,value:{importId:payload.importId,completed:true}})};}
      return {ok:true,apply:()=>{state.remotePendingImports??=[];state.remotePendingImports.push({id:payload.importId,fingerprint:intent,label:typeof payload.label==='string'?payload.label.slice(0,256):'Source Proxima',mode:payload.mode||'independent',...(payload.mode==='follow'?{receiver:structuredClone(payload.receiver),binding:structuredClone(payload.binding)}:{}),projection:structuredClone(payload.projection)});return {changed:true,created:true,entity:{kind:'remote-import-request',id:payload.importId},value:{importId:payload.importId,counts:Object.fromEntries(ProximaRemoteDomain.kinds.map(kind=>[kind,candidate.records[kind].length]))},before:null,after:{importId:payload.importId,source:candidate.source}};}};
    },
    'remote.import'(payload){
      let candidate;try{candidate=remoteCandidate(payload);}catch(error){return refuse('IMPORT_INVALID',{reason:error.message});}
      const intent=remoteIntent(payload),receipts=state.remoteImports||[];
      if(!Array.isArray(receipts))return refuse('IMPORT_INVALID',{reason:'Local import history needs recovery.'});
      const pending=state.remotePendingImports||[];if(!Array.isArray(pending))return refuse('IMPORT_INVALID',{reason:'Local copy requests need recovery.'});const staged=pending.find(item=>item.id===payload.importId);if(staged&&staged.fingerprint!==intent)return refuse('IMPORT_ID_CONFLICT',{});
      const previous=receipts.find(receipt=>receipt.id===payload.importId);
      if(previous){if(previous.fingerprint!==intent)return refuse('IMPORT_ID_CONFLICT',{});return {ok:true,apply:()=>({changed:false,entity:{kind:'remote-import',id:previous.id},value:structuredClone(previous.value)})};}
      const kinds=ProximaRemoteDomain.kinds;
      for(const kind of kinds){if(state[kind]!==undefined&&!Array.isArray(state[kind]))return refuse('IMPORT_INVALID',{reason:'Local '+kind+' needs recovery.'});if(candidate.records[kind].some(item=>(state[kind]||[]).some(existing=>existing.id===item.id)))return refuse('IMPORT_COLLISION',{kind});}
      return {ok:true,apply:()=>{
        const ids={},counts={},at=new Date().toISOString();
        for(const kind of kinds){const items=structuredClone(candidate.records[kind]);ids[kind]=items.map(item=>item.id);counts[kind]=items.length;state[kind]??=[];for(const item of items){if(kind==='timelineRows'){item.rowOrder=state.timelineRows.length;}else if(kind==='tasks'){item.order=state.tasks.filter(task=>task.status===item.status).length;item.ganttRow=null;}if(kind!=='timelineRows')item.rev=1;state[kind].push(item);}}
        const value={importId:payload.importId,source:structuredClone(candidate.source),mode:payload.mode||'independent',ids,counts,notices:candidate.notices};const receipt={id:payload.importId,fingerprint:intent,createdAt:at,label:typeof payload.label==='string'?payload.label.slice(0,256):'Source Proxima',value};if(candidate.follow){receipt.follow=candidate.follow;for(const entry of receipt.follow.entries){const local=state[entry.kind].find(item=>item.id===entry.localId);local.sourceLineage.mode='follow';entry.localBase=ProximaRemoteDomain.semantic(entry.kind,local);}}state.remoteImports??=[];state.remoteImports.push(receipt);state.remotePendingImports=(state.remotePendingImports||[]).filter(item=>item.id!==payload.importId);
        return {changed:true,created:true,entity:{kind:'remote-import',id:payload.importId},value,before:null,after:{importId:payload.importId,source:value.source,mode:value.mode,counts}};
      }};
    },
    'remote.reconcile'(payload){
      const receipt=(state.remoteImports||[]).find(item=>item.id===payload.importId);if(!receipt?.follow?.enabled)return refuse('FOLLOW_NOT_FOUND',{});
      let plan;try{plan=ProximaRemoteFollow.plan(state,receipt,payload.projection);}catch(error){return refuse('FOLLOW_INVALID',{reason:error.message});}
      if(!remoteTimelineSafe(plan.updates.map(update=>({kind:update.entry.kind,localId:update.entry.localId,incoming:update.value}))))return refuse('FOLLOW_INVALID',{reason:'Source changes overlap a local session. Keep local work and review this copy.'});
      const conflicts=plan.changes.map(change=>({kind:change.entry.kind,localId:change.entry.localId,status:change.status,expectedLocal:change.localBase,incoming:change.incoming,sourceBase:change.sourceBase??null}));
      const changed=plan.updates.length>0||JSON.stringify(conflicts)!==JSON.stringify(receipt.follow.conflicts||[]);if(!changed)return {ok:true,readOnlyResult:{updates:0,conflicts:conflicts.length}};
      return {ok:true,apply:()=>{if(!changed)return {changed:false,value:{updates:0,conflicts:conflicts.length}};for(const update of plan.updates){const list=state[update.entry.kind],index=list.findIndex(item=>item.id===update.entry.localId);list[index]=ProximaRemoteDomain.mergeOwned(update.entry.kind,list[index],update.value);update.entry.localBase=ProximaRemoteDomain.semantic(update.entry.kind,list[index]);update.entry.sourceBase=update.sourceBase;update.entry.deleted=false;update.entry.conflict=null;}for(const change of plan.changes){change.entry.deleted=change.status==='deleted';change.entry.conflict=change.status;}receipt.follow.conflicts=conflicts;receipt.follow.snapshot=structuredClone(plan.projected);receipt.follow.sourceSeq=plan.full.source.seq;return {changed:true,entity:{kind:'remote-follow',id:receipt.id},value:{updates:plan.updates.length,conflicts:conflicts.length},before:null,after:{sourceSeq:plan.full.source.seq,updates:plan.updates.length,conflicts:conflicts.length}};}};
    },
    'remote.stop'(payload){const receipt=(state.remoteImports||[]).find(item=>item.id===payload.importId);if(!receipt?.follow?.enabled)return refuse('FOLLOW_NOT_FOUND',{});const projected=followedRead();return {ok:true,apply:()=>{for(const entry of receipt.follow.entries){entry.independent=true;entry.conflict=null;const local=(state[entry.kind]||[]).find(item=>item.id===entry.localId);if(!local)continue;const current=projected.get(local.id);if(current){local.start=current.start;local.end=current.end;local.followNow=false;local.rev=(local.rev||0)+1;}local.sourceLineage.mode='independent';}receipt.follow.enabled=false;receipt.follow.conflicts=[];return {changed:true,entity:{kind:'remote-follow',id:receipt.id},value:{stopped:true},before:null,after:{stopped:true}};}};},
    'remote.resolve'(payload){
      const receipt=(state.remoteImports||[]).find(item=>item.id===payload.importId),follow=receipt?.follow;if(!follow?.enabled)return refuse('FOLLOW_NOT_FOUND',{});const conflicts=follow.conflicts||[];if(!['keep','source','both'].includes(payload.choice)||!conflicts.length)return refuse('FOLLOW_INVALID',{reason:'Choose an available conflict action.'});
      if(payload.expected!==fingerprint('follow-conflicts',conflicts)||conflicts.some(conflict=>ProximaRemoteDomain.semantic(conflict.kind,(state[conflict.kind]||[]).find(item=>item.id===conflict.localId))!==conflict.expectedLocal))return refuse('HISTORY_CONFLICT',{reason:'Local work or the source changed after review. Review again.'});
      let second=null;if(payload.choice==='both'){try{const projection=ProximaRemoteFollow.subset(follow.snapshot,follow.entries.filter(entry=>!entry.independent));second=COMMANDS['remote.import']({projection,importId:payload.copyId,mode:'independent'});if(!second.ok)return second;}catch(error){return refuse('FOLLOW_INVALID',{reason:error.message});}}
      if(payload.choice==='source'&&(conflicts.some(conflict=>!conflict.incoming)||!remoteTimelineSafe(conflicts)))return refuse('FOLLOW_INVALID',{reason:'The source removed entries or changed dependencies. Keep your copy or save the reviewed source as another copy.'});
      return {ok:true,apply:()=>{let copy=null;if(second)copy=second.apply().value;for(const conflict of conflicts){const entry=follow.entries.find(item=>item.kind===conflict.kind&&item.localId===conflict.localId),list=state[conflict.kind],index=list.findIndex(item=>item.id===conflict.localId);if(payload.choice==='source'){list[index]=ProximaRemoteDomain.mergeOwned(conflict.kind,list[index],conflict.incoming);entry.localBase=ProximaRemoteDomain.semantic(conflict.kind,list[index]);entry.sourceBase=conflict.sourceBase;entry.deleted=false;entry.conflict=null;}else{entry.independent=true;entry.conflict=null;if(index>=0)list[index].sourceLineage.mode='independent';}}follow.conflicts=[];if(follow.entries.every(entry=>entry.independent))follow.enabled=false;return {changed:true,entity:{kind:'remote-follow',id:receipt.id},value:{choice:payload.choice,copy},before:null,after:{choice:payload.choice,resolved:conflicts.length}};}};
    },
    'timeline-queue.extend-selection'(payload){const ids=[...new Set(payload.intervalIds||[])],members=ids.map(id=>state.timelineIntervals.find(x=>x.id===id)),time=Date.parse(payload.time);if(!ids.length||members.some(x=>!x))return refuse('INTERVAL_NOT_FOUND',{});if(!Number.isFinite(time)||!['start','end'].includes(payload.edge))return refuse('INTERVAL_TIME_INVALID',{});if(members.some(x=>queueForInterval(x.id)))return refuse('QUEUE_LINKED_EDGE',{});if(payload.revisions&&members.some(x=>payload.revisions[x.id]!==x.rev))return refuse('HISTORY_CONFLICT',{});const candidates=members.map(item=>({...item,[payload.edge]:new Date(time).toISOString(),...(payload.edge==='end'?{followNow:false}:item.followNow?{end:new Date(Math.max(time+1,Date.now())).toISOString()}:{} )}));if(candidates.some(x=>Date.parse(x.end)<=Date.parse(x.start)))return refuse('INTERVAL_TIME_INVALID',{});const partialRow=!!payload.reorder&&members.some(a=>state.timelineIntervals.some(b=>!ids.includes(b.id)&&b.rowId===a.rowId));const overlaps=partialRow||candidates.some(a=>state.timelineIntervals.some(b=>!ids.includes(b.id)&&b.rowId===a.rowId&&Date.parse(a.start)<(b.followNow?Infinity:Date.parse(b.end))&&Date.parse(b.start)<(a.followNow?Infinity:Date.parse(a.end))))||candidates.some(a=>candidates.some(b=>a.id!==b.id&&a.rowId===b.rowId&&Date.parse(a.start)<Date.parse(b.end)&&Date.parse(b.start)<Date.parse(a.end)));return queueChange(()=>{const sorted=displayRows(),created=[];for(const next of candidates){const current=state.timelineIntervals.find(x=>x.id===next.id);if(overlaps){const row={id:id('row'),name:next.name,color:next.color||'#a1cc43',rowOrder:0,independentColors:true};created.push(row);next.rowId=row.id;}Object.assign(current,next,{rev:current.rev+1});}if(created.length){const remaining=sorted.filter(row=>row.queue||state.timelineIntervals.some(x=>x.rowId===row.id));remaining.splice(Math.max(0,Math.min(remaining.length,payload.index||0)),0,...created);state.timelineRows=remaining;}else if(payload.reorder){const rowIds=[...new Set(members.map(x=>x.rowId))],moving=sorted.filter(row=>rowIds.includes(row.id)),remaining=sorted.filter(row=>!rowIds.includes(row.id));remaining.splice(Math.max(0,Math.min(remaining.length,payload.index||0)),0,...moving);state.timelineRows=remaining;}else state.timelineRows=sorted;state.timelineRows.forEach((row,index)=>{row.rowOrder=index;for(const item of state.timelineIntervals.filter(x=>x.rowId===row.id))item.rowOrder=index;});return {ids};});},
    'timeline-queue.color-selection'(payload){const ids=[...new Set(payload.intervalIds||[])],members=ids.map(id=>state.timelineIntervals.find(x=>x.id===id));if(!ids.length||members.some(x=>!x))return refuse('INTERVAL_NOT_FOUND',{});if(!/^#[0-9a-f]{6}$/i.test(payload.color))return refuse('PAYLOAD_INVALID',{});if(payload.revisions&&members.some(x=>payload.revisions[x.id]!==x.rev))return refuse('HISTORY_CONFLICT',{});return queueChange(()=>{for(const item of members){const row=state.timelineRows.find(x=>x.id===item.rowId);if(row){if(!row.queue&&!row.independentColors)for(const sibling of state.timelineIntervals.filter(x=>x.rowId===row.id))sibling.color=sibling.color||row.color;row.independentColors=true;}item.color=payload.color;item.rev++;}return {ids};});},
    'timeline-queue.reorder-rows'(payload){const ids=[...new Set(payload.rowIds||[])],rows=displayRows(),moving=rows.filter(x=>ids.includes(x.id));if(!ids.length||moving.length!==ids.length)return refuse('INTERVAL_NOT_FOUND',{});const remaining=rows.filter(x=>!ids.includes(x.id));let index=payload.beforeRowId?remaining.findIndex(x=>x.id===payload.beforeRowId):remaining.length;if(index<0)return refuse('PAYLOAD_INVALID',{});return queueChange(()=>{remaining.splice(index,0,...moving);remaining.forEach((row,index)=>{row.rowOrder=index;for(const item of state.timelineIntervals.filter(x=>x.rowId===row.id)){item.rowOrder=index;item.rev++;}});return {rowIds:ids};});},
    'timeline-queue.restore'(payload){
      const requested=[...new Set(payload.intervalIds||[payload.intervalId])],members=requested.map(id=>state.timelineIntervals.find(x=>x.id===id));if(!requested.length||members.some(x=>!x))return refuse('INTERVAL_NOT_FOUND',{});
      function savedFor(member){const row=state.timelineRows.find(x=>x.id===member.rowId);return member?.enqueueReturn||(()=>{if(!row?.queue?.ids.includes(member?.id))return null;const entry=[...timelineHistory().undo].reverse().find(entry=>{const before=entry.beforeState,after=entry.afterState;if(!before||!after)return false;const oldRow=before.rows.find(r=>r.queue?.ids.includes(member.id)),newRow=after.rows.find(r=>r.id===row.id&&r.queue?.ids.includes(member.id));return !oldRow&&!!newRow;});if(!entry)return null;const ids=entry.afterState.rows.find(r=>r.id===row.id).queue.ids.filter(id=>!entry.beforeState.rows.some(r=>r.queue?.ids.includes(id)));return {sessions:structuredClone(entry.beforeState.sessions.filter(x=>ids.includes(x.id))),rows:structuredClone(entry.beforeState.rows.filter(r=>entry.beforeState.sessions.some(x=>ids.includes(x.id)&&x.rowId===r.id)))};})()||row?.queueReturn;}
      const snapshots=members.map(savedFor);if(snapshots.some(x=>!x))return refuse('QUEUE_NO_SAVED_STATE',{});
      const candidates=[...new Map(snapshots.flatMap(x=>x.sessions).map(x=>[x.id,structuredClone(x)])).values()],rows=[...new Map(snapshots.flatMap(x=>x.rows).map(x=>[x.id,structuredClone(x)])).values()],ids=candidates.map(x=>x.id);
      if(candidates.some(a=>state.timelineIntervals.some(b=>!ids.includes(b.id)&&b.rowId===a.rowId&&Date.parse(a.start)<(b.followNow?Infinity:Date.parse(b.end))&&Date.parse(b.start)<(a.followNow?Infinity:Date.parse(a.end)))))return refuse('INTERVAL_OVERLAP',{});
      return queueChange(()=>{const revisions=new Map(state.timelineIntervals.map(x=>[x.id,x.rev]));for(const member of members){const row=state.timelineRows.find(x=>x.id===member.rowId);if(row&&snapshots.includes(row.queueReturn))delete row.queueReturn;}for(const row of state.timelineRows)if(row.queue)row.queue.ids=row.queue.ids.filter(id=>!ids.includes(id));for(const original of rows){const current=state.timelineRows.find(x=>x.id===original.id);if(current)Object.assign(current,original);else state.timelineRows.push(original);}for(const original of candidates){const current=state.timelineIntervals.find(x=>x.id===original.id);if(current){for(const key of Object.keys(current))delete current[key];Object.assign(current,original,{rev:(revisions.get(original.id)||1)+1});}else state.timelineIntervals.push(original);}state.timelineRows=state.timelineRows.filter(x=>x.queue||state.timelineIntervals.some(y=>y.rowId===x.id));return {ids};});
    },
    'timeline-queue.collapse'(payload){
      const ids=[...new Set(payload.intervalIds||[])],members=ids.map(id=>state.timelineIntervals.find(x=>x.id===id));
      if(!ids.length||members.some(x=>!x))return refuse('INTERVAL_NOT_FOUND',{});
      if(members.some(x=>queueForInterval(x.id)))return refuse('QUEUE_LINKED_EDGE',{});
      if(payload.revisions&&members.some(x=>payload.revisions[x.id]!==x.rev))return refuse('HISTORY_CONFLICT',{});
      if(members.filter(x=>x.followNow).length>1)return refuse('QUEUE_RUNNING_SELECTION',{});if(new Set(members.map(x=>Date.parse(x.end))).size!==members.length)return refuse('QUEUE_SHARED_END',{});
      const now=Date.now(),end=x=>x.followNow?now:Date.parse(x.end);
      members.sort((a,b)=>end(a)-end(b)||Date.parse(a.start)-Date.parse(b.start)||a.id.localeCompare(b.id));
      const row=state.timelineRows.filter(row=>members.some(x=>x.rowId===row.id)).sort((a,b)=>a.rowOrder-b.rowOrder)[0];
      if(!row||row.queue)return refuse('QUEUE_LINKED_EDGE',{});
      let cursor=Math.min(...members.map(x=>Date.parse(x.start)));
      const candidates=members.map((item,index)=>{const finish=end(item),next={...item,rowId:row.id,rowOrder:row.rowOrder,start:new Date(cursor).toISOString(),end:new Date(finish).toISOString(),followNow:!!item.followNow&&index===members.length-1,color:item.queueCollapseColor||payload.colors?.[item.id]||item.color};cursor=finish;return next;});
      if(candidates.some(x=>Date.parse(x.end)<=Date.parse(x.start)))return refuse('INTERVAL_TIME_INVALID',{});
      if(candidates.some(x=>!/^#[0-9a-f]{6}$/i.test(x.color)))return refuse('PAYLOAD_INVALID',{});
      if(candidates.some(a=>state.timelineIntervals.some(b=>!ids.includes(b.id)&&b.rowId===row.id&&Date.parse(a.start)<(b.followNow?Infinity:Date.parse(b.end))&&Date.parse(b.start)<(a.followNow?Infinity:Date.parse(a.end)))))return refuse('INTERVAL_OVERLAP',{});
      return queueChange(()=>{row.queueReturn=row.queueReturn||{rows:structuredClone(state.timelineRows.filter(r=>members.some(x=>x.rowId===r.id))),sessions:structuredClone(members)};row.independentColors=true;for(const next of candidates){const item=state.timelineIntervals.find(x=>x.id===next.id);Object.assign(item,next,{queueCollapseColor:next.color,rev:item.rev+1});}state.timelineRows=state.timelineRows.filter(row=>row.queue||state.timelineIntervals.some(x=>x.rowId===row.id));return {rowId:row.id,intervalIds:members.map(x=>x.id)};});
    },
    'timeline-interval.move-selection'(payload){const ids=[...new Set(payload.intervalIds||[])],members=ids.map(id=>state.timelineIntervals.find(x=>x.id===id));if(!ids.length||members.some(x=>!x))return refuse('INTERVAL_NOT_FOUND',{});if(members.some(x=>queueForInterval(x.id)))return refuse('QUEUE_LINKED_EDGE',{});if(payload.revisions&&members.some(x=>payload.revisions[x.id]!==x.rev))return refuse('HISTORY_CONFLICT',{});const destination=payload.rowId&&state.timelineRows.find(x=>x.id===payload.rowId);if(payload.rowId&&!destination)return refuse('INTERVAL_NOT_FOUND',{});if(destination?.queue)return refuse('QUEUE_LINKED_EDGE',{});const newRow=payload.newRow?{id:id('row'),name:'Activity',color:members[0].color||'#a1cc43',rowOrder:Math.max(-1,...state.timelineRows.map(x=>x.rowOrder||0))+1,independentColors:true}:null;const candidates=members.map(item=>{const time=payload.times?.find(x=>x.id===item.id);return {...item,rowId:newRow?.id||destination?.id||item.rowId,...(time?{start:time.start,end:time.end,followNow:false}:{})};});if(candidates.some(x=>!Number.isFinite(Date.parse(x.start))||Date.parse(x.end)<=Date.parse(x.start)))return refuse('INTERVAL_TIME_INVALID',{});const all=[...state.timelineIntervals.filter(x=>!ids.includes(x.id)),...candidates];if(candidates.some(a=>all.some(b=>a.id!==b.id&&a.rowId===b.rowId&&Date.parse(a.start)<(b.followNow?Infinity:Date.parse(b.end))&&Date.parse(b.start)<(a.followNow?Infinity:Date.parse(a.end)))))return refuse('INTERVAL_OVERLAP',{});return {ok:true,apply:()=>{if(newRow)state.timelineRows.push(newRow);if(destination)destination.independentColors=true;for(const next of candidates){const item=state.timelineIntervals.find(x=>x.id===next.id);Object.assign(item,next,{rev:item.rev+1});const row=state.timelineRows.find(x=>x.id===item.rowId);if(row)item.rowOrder=row.rowOrder;}state.timelineRows=state.timelineRows.filter(row=>row.queue||state.timelineIntervals.some(x=>x.rowId===row.id));const history=timelineHistory();history.undo.push({});if(history.undo.length>200)history.undo.shift();history.redo=[];return {changed:true,entity:{kind:'timeline-batch',id:'entries'},value:{ids}};}};},
    'timeline-queue.delete'(payload){const row=state.timelineRows.find(x=>x.id===payload.rowId);if(!row?.queue)return {ok:true,apply:()=>({changed:false})};if(payload.expired&&Date.parse(row.queue.end)>Date.now())return {ok:true,apply:()=>({changed:false})};const projected=queueProjection(row);return queueChange(()=>{for(const [id,view] of projected){const item=state.timelineIntervals.find(x=>x.id===id);item.start=view.start;item.end=view.end;item.followNow=false;delete item.queueWeight;item.rev++;}delete row.queue;row.independentColors=true;if(!state.timelineIntervals.some(x=>x.rowId===row.id))state.timelineRows=state.timelineRows.filter(x=>x.id!==row.id);return {rowId:row.id};});},
    'timeline-queue.create'(payload){const end=Date.parse(payload.end);if(!Number.isFinite(end)||end<=Date.now())return refuse('INTERVAL_TIME_INVALID',{});let row=payload.rowId&&state.timelineRows.find(x=>x.id===payload.rowId);if(payload.rowId&&!row)return refuse('INTERVAL_NOT_FOUND',{});if(row?.queue)return refuse('QUEUE_ALREADY_EXISTS',{});const running=row&&state.timelineIntervals.find(x=>x.rowId===row.id&&x.followNow);if(running?.deadline)return refuse('QUEUE_DEADLINE_TASK',{});const original=running?{rows:structuredClone([row]),sessions:structuredClone([running])}:null;return queueChange(()=>{if(!row){row={id:id('row'),name:'Queue',color:'#a1cc43',rowOrder:Math.max(-1,...state.timelineRows.map(x=>x.rowOrder||0))+1};state.timelineRows.push(row);}row.queue={end:new Date(end).toISOString(),ids:running?[running.id]:[]};if(running){running.enqueueReturn=original;running.queueWeight=1;running.rev++;}return {rowId:row.id};});},
    'timeline-queue.enqueue'(payload){const row=state.timelineRows.find(x=>x.id===payload.rowId),ids=[...new Set(payload.intervalIds||[])],members=ids.map(id=>state.timelineIntervals.find(x=>x.id===id));if(!row?.queue||Date.parse(row.queue.end)<=Date.now())return refuse('QUEUE_EXPIRED',{});if(!ids.length||members.some(x=>!x))return refuse('INTERVAL_NOT_FOUND',{});if(members.some(x=>x.deadline))return refuse('QUEUE_DEADLINE_TASK',{});if(members.some(x=>queueForInterval(x.id)))return refuse('QUEUE_ALREADY_MEMBER',{});if(payload.revisions&&members.some(x=>payload.revisions[x.id]!==x.rev))return refuse('HISTORY_CONFLICT',{});const existingRunning=!row.queue.ids.length?state.timelineIntervals.find(x=>x.rowId===row.id&&x.followNow&&!ids.includes(x.id)):null;if(existingRunning?.deadline)return refuse('QUEUE_DEADLINE_TASK',{});if(state.timelineIntervals.some(x=>x.id!==existingRunning?.id&&x.rowId===row.id&&!ids.includes(x.id)&&!row.queue.ids.includes(x.id)&&(x.followNow||Date.parse(x.end)>Date.now())))return refuse('INTERVAL_OVERLAP',{});return queueChange(()=>{if(existingRunning){existingRunning.enqueueReturn={rows:structuredClone([row]),sessions:structuredClone([existingRunning])};existingRunning.queueWeight=1;existingRunning.rev++;row.queue.ids.push(existingRunning.id);}const saved={rows:structuredClone(state.timelineRows.filter(r=>members.some(x=>x.rowId===r.id))),sessions:structuredClone(members)};for(const item of members)item.enqueueReturn=structuredClone(saved);for(const item of members){item.color=item.color||state.timelineRows.find(x=>x.id===item.rowId)?.color||'#a1cc43';item.rowId=row.id;item.rowOrder=row.rowOrder;item.queueWeight=1;item.followNow=false;item.rev++;row.queue.ids.push(item.id);}if(row.queue.ids.length===members.length){const first=members[0];first.end=new Date(Math.max(Date.parse(first.start)+1,Date.now())).toISOString();first.followNow=true;}state.timelineRows=state.timelineRows.filter(x=>x.queue||state.timelineIntervals.some(y=>y.rowId===x.id));return {ids};});},
    'timeline-queue.resize'(payload){const row=state.timelineRows.find(x=>x.id===payload.rowId),time=Date.parse(payload.time);if(!row?.queue||!Number.isFinite(time))return refuse('PAYLOAD_INVALID',{});if(payload.end){if(time<=Date.now())return refuse('INTERVAL_TIME_INVALID',{});return queueChange(()=>{row.queue.end=new Date(time).toISOString();return {rowId:row.id};});}const index=row.queue.ids.indexOf(payload.intervalId),projection=queueProjection(row),left=state.timelineIntervals.find(x=>x.id===row.queue.ids[index]),right=state.timelineIntervals.find(x=>x.id===row.queue.ids[index+1]);if(index<1||!right)return refuse('QUEUE_BOUNDARY_INVALID',{});const a=Date.parse(projection.get(left.id).start),b=Date.parse(projection.get(right.id).end);if(time<=a||time>=b)return refuse('INTERVAL_TIME_INVALID',{});return queueChange(()=>{const total=(left.queueWeight||1)+(right.queueWeight||1),ratio=(time-a)/(b-a);left.queueWeight=total*ratio;right.queueWeight=total*(1-ratio);left.rev++;right.rev++;return {rowId:row.id};});},
    'timeline-queue.swap'(payload){const row=state.timelineRows.find(x=>x.id===payload.rowId),ids=row?.queue?.ids,a=ids?.indexOf(payload.intervalId),b=ids?.indexOf(payload.targetId);if(a==null||a<0||b==null||b<0)return refuse('INTERVAL_NOT_FOUND',{});const left=state.timelineIntervals.find(x=>x.id===payload.intervalId),right=state.timelineIntervals.find(x=>x.id===payload.targetId);return queueChange(()=>{[left.name,right.name]=[right.name,left.name];left.rev++;right.rev++;return {rowId:row.id};});},
    'timeline-queue.complete'(payload){const row=queueForInterval(payload.intervalId),item=state.timelineIntervals.find(x=>x.id===payload.intervalId);if(!row||row.queue.ids[0]!==payload.intervalId)return refuse('QUEUE_NOT_ACTIVE',{});if(!/^#[0-9a-f]{6}$/i.test(payload.color))return refuse('PAYLOAD_INVALID',{});if(payload.rev&&payload.rev!==item.rev)return refuse('HISTORY_CONFLICT',{});return queueChange(()=>{const now=Date.now();item.followNow=false;item.end=new Date(Math.max(Date.parse(item.start)+1,now)).toISOString();item.color=payload.color;item.rev++;row.queue.ids.shift();const next=state.timelineIntervals.find(x=>x.id===row.queue.ids[0]);if(next){next.start=new Date(Math.max(now,Date.parse(item.end))).toISOString();next.end=new Date(Date.parse(next.start)+1).toISOString();next.followNow=true;next.rev++;}return {completed:item.id,next:next?.id};});},
    'timeline.migrate':()=>({ok:true,apply:()=>({changed:true,entity:{kind:'timeline-schema',id:'rows'},value:{rows:state.timelineRows.length},before:null,after:timelineSnapshot()})}),
    'timeline.undo':()=>timelineRestore('undo'),
    'timeline.redo':()=>timelineRestore('redo'),
    /**
     * A new task. Placement is "last in its own column": every existing order is
     * lower than a fresh count, so the task lands at the end of whichever column it
     * starts in and task.move is the only thing that reorders.
     */
    'task.create'(payload, ctx) {
      const missing = [];
      if (typeof payload.name !== 'string' || !payload.name.trim()) missing.push('name');
      if (missing.length) return refuse('PAYLOAD_INVALID', { type: 'task.create', missing: missing });
      if (payload.project && !findProject(payload.project)) {
        return refuse('PROJECT_NOT_FOUND', { projectId: payload.project });
      }
      if (payload.status !== undefined && !STATUSES.includes(payload.status)) {
        return refuse('STATUS_UNKNOWN', { value: payload.status, allowed: STATUSES });
      }
      if (payload.weight !== undefined && !VALIDATION.weight(payload.weight)) {
        return refuse('WEIGHT_INVALID', { value: payload.weight });
      }
      if (payload.start !== undefined && payload.start !== '' && !VALIDATION.day(payload.start)) {
        return refuse('DATE_INVALID', { field: 'start', value: payload.start });
      }
      if (payload.deadline !== undefined && payload.deadline !== '' && !VALIDATION.day(payload.deadline)) {
        return refuse('DATE_INVALID', { field: 'deadline', value: payload.deadline });
      }
      if (payload.ganttRow !== undefined && payload.ganttRow !== null && !VALIDATION.row(payload.ganttRow)) {
        return refuse('GANTT_ROW_INVALID', { value: payload.ganttRow });
      }
      const start = payload.start === undefined || payload.start === '' ? today() : payload.start;
      const deadline = payload.deadline === undefined ? '' : payload.deadline;
      if (deadline && deadline < start) {
        return refuse('DEADLINE_BEFORE_START', { start: start, deadline: deadline });
      }
      const task = {
        id: id('tsk'),
        name: String(payload.name).trim().slice(0, 200),
        note: typeof payload.note === 'string' ? payload.note.slice(0, 500) : '',
        project: payload.project || '',
        status: payload.status || 'backlog',
        weight: payload.weight === undefined ? 1 : Number(payload.weight),
        start: start,
        deadline: deadline,
        // No row yet: the timeline packs a fresh task into the first row where it
        // does not overlap anything and writes the result back. A row is a
        // scheduling decision, so it lives on the task like any other field.
        ganttRow: payload.ganttRow === undefined ? null : payload.ganttRow,
        order: state.tasks.length,
        createdAt: new Date().toISOString(),
        rev: 1,
      };
      return {
        ok: true,
        apply: () => {
          state.tasks.push(task);
          return { value: { ...task }, entity: { kind: 'task', id: task.id }, before: null, after: { ...task }, changed: true, created: true };
        },
      };
    },

    /**
     * Change fields on an existing task. `status` is NOT among them: where a task
     * sits is a move, and a move names an anchor rather than an index, so replays
     * and concurrent clients agree about what happened.
     */
    'task.patch'(payload, ctx) {
      const task = findTask(payload.taskId);
      if (!task) return refuse('ENTITY_NOT_FOUND', { kind: 'task', id: payload.taskId });
      const conflict = checkRev(ctx, 'task', payload.taskId);
      if (conflict) return conflict;
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : null;
      if (!patch) return refuse('PAYLOAD_INVALID', { type: 'task.patch', missing: ['patch'] });
      const fields = Object.keys(patch);
      if (fields.length === 0) return refuse('PAYLOAD_INVALID', { type: 'task.patch', missing: ['patch'] });
      if ('status' in patch) return refuse('FIELD_NOT_PATCHABLE', { field: 'status', use: 'task.move' });
      if ('createdAt' in patch) return refuse('FIELD_NOT_PATCHABLE', { field: 'createdAt', use: 'nothing — provenance is immutable' });
      if ('id' in patch) return refuse('FIELD_NOT_PATCHABLE', { field: 'id', use: 'nothing — ids are stable' });

      if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) return refuse('NAME_REQUIRED', {});
      if ('project' in patch && patch.project && !findProject(patch.project)) {
        return refuse('PROJECT_NOT_FOUND', { projectId: patch.project });
      }
      if ('weight' in patch && !VALIDATION.weight(patch.weight)) return refuse('WEIGHT_INVALID', { value: patch.weight });
      if ('start' in patch && patch.start !== '' && !VALIDATION.day(patch.start)) {
        return refuse('DATE_INVALID', { field: 'start', value: patch.start });
      }
      if ('deadline' in patch && patch.deadline !== '' && !VALIDATION.day(patch.deadline)) {
        return refuse('DATE_INVALID', { field: 'deadline', value: patch.deadline });
      }
      if ('ganttRow' in patch && !VALIDATION.row(patch.ganttRow)) return refuse('GANTT_ROW_INVALID', { value: patch.ganttRow });
      if ('note' in patch && typeof patch.note !== 'string') return refuse('PAYLOAD_INVALID', { type: 'task.patch', missing: ['note as text'] });

      const next = {};
      if ('name' in patch) next.name = String(patch.name).trim().slice(0, 200);
      if ('note' in patch) next.note = patch.note.slice(0, 500);
      if ('project' in patch) next.project = patch.project || '';
      if ('weight' in patch) next.weight = Number(patch.weight);
      if ('start' in patch) next.start = patch.start === '' ? (task.start || today()) : patch.start;
      if ('deadline' in patch) next.deadline = patch.deadline;
      if ('ganttRow' in patch) next.ganttRow = patch.ganttRow;

      const changedFields = Object.keys(next).filter((key) => task[key] !== next[key]);
      if (changedFields.length === 0) {
        return { ok: true, apply: () => ({ value: { ...task }, entity: { kind: 'task', id: task.id }, before: null, after: null, changed: false }) };
      }
      // The stored pair has to remain a pair: changing one end can contradict the
      // other, and that is refused rather than accepted as a plausible inversion.
      const startAfter = 'start' in next ? next.start : task.start;
      const deadlineAfter = 'deadline' in next ? next.deadline : task.deadline;
      if (startAfter && deadlineAfter && deadlineAfter < startAfter) {
        return refuse('DEADLINE_BEFORE_START', { start: startAfter, deadline: deadlineAfter });
      }
      const before = {};
      const after = {};
      changedFields.forEach((key) => { before[key] = task[key]; after[key] = next[key]; });
      return {
        ok: true,
        apply: () => {
          Object.assign(task, next);
          return { value: { ...task }, entity: { kind: 'task', id: task.id }, before: before, after: after, changed: true };
        },
      };
    },

    /**
     * Move a task to a column, before another task or at the end.
     *
     * `beforeTaskId` and not an index: "put X before Y" means the same thing on a
     * replay, on another client, and to an agent that has never seen this board's
     * current ordering. "Set order = 12" means whatever the ordering happened to be
     * when it was written.
     */
    'task.move'(payload, ctx) {
      const task = findTask(payload.taskId);
      if (!task) return refuse('ENTITY_NOT_FOUND', { kind: 'task', id: payload.taskId });
      const conflict = checkRev(ctx, 'task', payload.taskId);
      if (conflict) return conflict;
      if (!STATUSES.includes(payload.toStatus)) return refuse('STATUS_UNKNOWN', { value: payload.toStatus, allowed: STATUSES });
      const anchorId = payload.beforeTaskId || null;
      if (anchorId) {
        const anchor = findTask(anchorId);
        if (!anchor) return refuse('ENTITY_NOT_FOUND', { kind: 'task', id: anchorId });
        if (anchor.status !== payload.toStatus) {
          return refuse('MOVE_ANCHOR_NOT_IN_COLUMN', { beforeTaskId: anchorId, toStatus: payload.toStatus });
        }
      }
      const fromStatus = task.status;
      if (fromStatus === payload.toStatus && !anchorId) {
        // Already there, and asked for the end of the same column: nothing to say.
        const column = state.tasks.filter((t) => t.status === payload.toStatus);
        if (column[column.length - 1] && column[column.length - 1].id === task.id) {
          return { ok: true, apply: () => ({ value: { ...task }, entity: { kind: 'task', id: task.id }, before: null, after: null, changed: false }) };
        }
      }
      return {
        ok: true,
        apply: () => {
          const beforeOrder = task.order;
          task.status = payload.toStatus;
          const rest = state.tasks.filter((t) => t.id !== task.id);
          const column = rest.filter((t) => t.status === payload.toStatus);
          const index = anchorId ? column.findIndex((t) => t.id === anchorId) : -1;
          if (index < 0) column.push(task); else column.splice(index, 0, task);
          column.forEach((t, i) => { t.order = i; });
          state.tasks = rest.filter((t) => t.status !== payload.toStatus).concat(column);
          // The column that was left behind keeps its own numbering: each column is
          // ordered on its own, so gaps there mean nothing and rewriting them would
          // be a second, unasked-for change.
          return {
            value: { ...task },
            entity: { kind: 'task', id: task.id },
            before: { status: fromStatus, order: beforeOrder },
            after: { status: task.status, order: task.order, beforeTaskId: anchorId },
            changed: true,
          };
        },
      };
    },

    /**
     * Packed timeline rows, as one command for a whole pass.
     *
     * The renderer computes the packing, draws from it and then asks for it to be
     * remembered; committing them one at a time would put a burst of events in the
     * log for one automatic layout. Ids that have gone missing are skipped and
     * reported rather than refused: a render pass can legitimately race a delete.
     */
    'task.layout'(payload, ctx) {
      const rows = Array.isArray(payload.rows) ? payload.rows : null;
      if (!rows) return refuse('PAYLOAD_INVALID', { type: 'task.layout', missing: ['rows'] });
      for (const entry of rows) {
        if (!entry || typeof entry !== 'object') return refuse('PAYLOAD_INVALID', { type: 'task.layout', missing: ['rows[].taskId'] });
        if (!VALIDATION.row(entry.ganttRow)) return refuse('GANTT_ROW_INVALID', { value: entry.ganttRow });
      }
      const pending = [];
      const skipped = [];
      rows.forEach((entry) => {
        const task = findTask(entry.taskId);
        if (!task || task.ganttRow === entry.ganttRow) { if (!task) skipped.push(entry.taskId); return; }
        pending.push({ task: task, row: entry.ganttRow, from: task.ganttRow });
      });
      if (pending.length === 0) {
        return { ok: true, apply: () => ({ value: { placed: 0, skipped: skipped }, entity: { kind: 'board', id: 'timeline' }, before: null, after: null, changed: false }) };
      }
      return {
        ok: true,
        apply: () => {
          const before = {};
          const after = {};
          pending.forEach((item) => {
            before[item.task.id] = item.from;
            after[item.task.id] = item.row;
            item.task.ganttRow = item.row;
          });
          return {
            value: { placed: pending.length, skipped: skipped },
            entity: { kind: 'board', id: 'timeline' },
            before: before,
            after: after,
            changed: true,
            extra: skipped.length ? { skipped: skipped } : undefined,
          };
        },
      };
    },

    'task.delete'(payload, ctx) {
      const task = findTask(payload.taskId);
      if (!task) return refuse('ENTITY_NOT_FOUND', { kind: 'task', id: payload.taskId });
      const conflict = checkRev(ctx, 'task', payload.taskId);
      if (conflict) return conflict;
      const snapshot = { ...task };
      return {
        ok: true,
        apply: () => {
          state.tasks = state.tasks.filter((t) => t.id !== task.id);
          // A run's frozen plan references tasks, not projects or the board, so it
          // is untouched here: the run ends only when its members stop being
          // running, not when a record disappears. See endRunIfEmpty in the app.
          return { value: { id: snapshot.id }, entity: { kind: 'task', id: snapshot.id }, before: snapshot, after: null, changed: true };
        },
      };
    },

    'project.create'(payload, ctx) {
      if (typeof payload.name !== 'string' || !payload.name.trim()) return refuse('NAME_REQUIRED', {});
      const project = {
        id: id('prj'),
        name: String(payload.name).trim().slice(0, 120),
        description: typeof payload.description === 'string' ? payload.description.trim().slice(0, 500) : '',
        projectType: payload.projectType === 'schedule' ? 'schedule' : 'task',
        sourceKey: typeof payload.sourceKey === 'string' ? payload.sourceKey : '',
        createdAt: new Date().toISOString(),
        archivedAt: null,
        rev: 1,
      };
      return {
        ok: true,
        apply: () => {
          state.projects.push(project);
          return { value: { ...project }, entity: { kind: 'project', id: project.id }, before: null, after: { ...project }, changed: true, created: true };
        },
      };
    },

    'project.archive'(payload, ctx) {
      const project = findProject(payload.projectId);
      if (!project) return refuse('ENTITY_NOT_FOUND', { kind: 'project', id: payload.projectId });
      const conflict = checkRev(ctx, 'project', payload.projectId);
      if (conflict) return conflict;
      if (project.archivedAt) {
        return { ok: true, apply: () => ({ value: { ...project }, entity: { kind: 'project', id: project.id }, before: null, after: null, changed: false }) };
      }
      const at = new Date().toISOString();
      return {
        ok: true,
        apply: () => {
          project.archivedAt = at;
          return { value: { ...project }, entity: { kind: 'project', id: project.id }, before: { archivedAt: null }, after: { archivedAt: at }, changed: true };
        },
      };
    },

    'project.restore'(payload, ctx) {
      const project = findProject(payload.projectId);
      if (!project) return refuse('ENTITY_NOT_FOUND', { kind: 'project', id: payload.projectId });
      const conflict = checkRev(ctx, 'project', payload.projectId);
      if (conflict) return conflict;
      if (!project.archivedAt) {
        return { ok: true, apply: () => ({ value: { ...project }, entity: { kind: 'project', id: project.id }, before: null, after: null, changed: false }) };
      }
      const was = project.archivedAt;
      return {
        ok: true,
        apply: () => {
          project.archivedAt = null;
          return { value: { ...project }, entity: { kind: 'project', id: project.id }, before: { archivedAt: was }, after: { archivedAt: null }, changed: true };
        },
      };
    },

    /**
     * Delete a project. Its tasks are NOT deleted — they keep their text, dates and
     * history and become uncategorised. Deleting a container should not quietly
     * destroy the work inside it, and the confirmation says how many tasks are
     * affected before the reader agrees.
     */
    'project.delete'(payload, ctx) {
      const project = findProject(payload.projectId);
      if (!project) return refuse('ENTITY_NOT_FOUND', { kind: 'project', id: payload.projectId });
      const conflict = checkRev(ctx, 'project', payload.projectId);
      if (conflict) return conflict;
      const orphans = state.tasks.filter((t) => t.project === project.id).map((t) => t.id);
      const scheduleEvents = state.scheduleEvents.filter((event) => event.project === project.id).map((event) => event.id);
      const snapshot = { ...project };
      return {
        ok: true,
        apply: () => {
          state.tasks.forEach((t) => { if (t.project === project.id) { t.project = ''; t.rev = positiveInt(t.rev, 1) + 1; } });
          state.scheduleEvents = state.scheduleEvents.filter((event) => event.project !== project.id);
          state.projects = state.projects.filter((p) => p.id !== project.id);
          return {
            value: { orphaned: orphans.length, orphanedTaskIds: orphans, deletedScheduleEvents: scheduleEvents.length, deletedScheduleEventIds: scheduleEvents },
            entity: { kind: 'project', id: snapshot.id },
            before: snapshot,
            after: null,
            changed: true,
            // The tasks it let go of changed too, so they are named in the event
            // rather than left as an unexplained side effect.
            extra: (orphans.length || scheduleEvents.length) ? { orphanedTaskIds: orphans, deletedScheduleEventIds: scheduleEvents } : undefined,
          };
        },
      };
    },

    /**
     * Lock a run: the client says WHICH tasks are running and until when, and the
     * store works out the plan from its own records. The plan is a frozen snapshot
     * of weights and durations at lock time — see the note on the run in the read
     * API — so it is computed here, once, rather than sent in by a client that
     * might have been looking at something stale.
     */
    'run.lock'(payload, ctx) {
      if (state.run) {
        return refuse('RUN_ALREADY_LOCKED', { lockedAt: state.run.lockedAt });
      }
      const target = typeof payload.target === 'string' ? new Date(payload.target) : null;
      if (!target || Number.isNaN(target.getTime()) || target.getTime() <= Date.now()) {
        return refuse('RUN_TARGET_INVALID', { target: payload.target });
      }
      const ids = Array.isArray(payload.taskIds) ? payload.taskIds.filter((v) => typeof v === 'string' && v) : [];
      const members = [];
      ids.forEach((taskId) => {
        const task = findTask(taskId);
        if (task && task.status === 'running') members.push(task);
      });
      if (members.length === 0) return refuse('RUN_HAS_NO_MEMBERS', {});

      const lockedAt = new Date();
      const totalMs = target.getTime() - lockedAt.getTime();
      const totalWeight = members.reduce((sum, t) => sum + t.weight, 0) || 1;
      let cursor = lockedAt.getTime();
      let total = 0;
      const frozen = members.map((task) => {
        const duration = (task.weight / totalWeight) * totalMs;
        const startsAt = cursor;
        const endsAt = cursor + duration;
        cursor = endsAt;
        total += duration;
        return { id: task.id, name: task.name, weight: task.weight, duration: duration, startsAt: startsAt, endsAt: endsAt };
      });
      const run = { lockedAt: lockedAt.toISOString(), target: payload.target, members: frozen, total: total, rev: 1 };
      return {
        ok: true,
        apply: () => {
          state.run = run;
          return {
            value: { lockedAt: run.lockedAt, target: run.target, total: run.total, members: frozen.map((m) => ({ ...m })) },
            entity: { kind: 'run', id: run.lockedAt },
            before: null,
            after: { lockedAt: run.lockedAt, target: run.target, memberIds: frozen.map((m) => m.id), total: run.total },
            changed: true,
            created: true,
          };
        },
      };
    },

    /**
     * End the run. Ending a run that has already ended is not an error — the app
     * calls this whenever the last member leaves, and it may be called twice.
     */
    'run.unlock'(payload, ctx) {
      if (!state.run) {
        return { ok: true, apply: () => ({ value: null, entity: { kind: 'run', id: 'none' }, before: null, after: null, changed: false }) };
      }
      const snapshot = {
        lockedAt: state.run.lockedAt,
        target: state.run.target,
        memberIds: (state.run.members || []).map((m) => m.id),
      };
      return {
        ok: true,
        apply: () => {
          state.run = null;
          return { value: { ended: snapshot }, entity: { kind: 'run', id: snapshot.lockedAt }, before: snapshot, after: null, changed: true };
        },
      };
    },

    /** Proxima-owned Schedule records. They never read from the task or vault data. */
    'timeline-interval.delete-batch'(payload){const ids=new Set(Array.isArray(payload.intervalIds)?payload.intervalIds:[]),items=state.timelineIntervals.filter(x=>ids.has(x.id));if(!items.length||items.length!==ids.size)return refuse('INTERVAL_NOT_FOUND',{});if(payload.revisions&&items.some(x=>payload.revisions[x.id]!==x.rev))return refuse('HISTORY_CONFLICT',{});return {ok:true,apply:()=>{const entries=items.map(item=>({id:item.id,before:{...item},after:null}));state.timelineIntervals=state.timelineIntervals.filter(x=>!ids.has(x.id));const history=timelineHistory();history.undo.push({entries});if(history.undo.length>200)history.undo.shift();history.redo=[];return {changed:true,entity:{kind:'timeline-batch',id:'rows'},before:entries.map(x=>x.before),after:null,value:{ids:[...ids]}};}};},
    'timeline-interval.reorder-batch'(payload){const ids=Array.isArray(payload.intervalIds)?new Set(payload.intervalIds):new Set();const moving=state.timelineIntervals.map((item,index)=>({item,order:Number.isFinite(item.rowOrder)?item.rowOrder:index})).filter(x=>ids.has(x.item.id)).sort((a,b)=>a.order-b.order).map(x=>x.item);if(!moving.length||moving.length!==ids.size||ids.has(payload.beforeId))return refuse('PAYLOAD_INVALID',{});if(payload.beforeId&&!state.timelineIntervals.some(x=>x.id===payload.beforeId))return refuse('INTERVAL_NOT_FOUND',{});if(payload.revisions&&moving.some(x=>payload.revisions[x.id]!==x.rev))return refuse('HISTORY_CONFLICT',{});return {ok:true,apply:()=>{const entries=moving.map(item=>({id:item.id,before:{...item}}));for(const item of moving){item.rowOrder=intervalRowPosition(payload.beforeId,item.id);item.rev++;}entries.forEach(entry=>entry.after={...state.timelineIntervals.find(x=>x.id===entry.id)});const history=timelineHistory();history.undo.push({entries});if(history.undo.length>200)history.undo.shift();history.redo=[];return {changed:true,entity:{kind:'timeline-batch',id:'rows'},before:entries.map(x=>x.before),after:entries.map(x=>x.after),value:{ids:moving.map(x=>x.id)}};}};},
    'timeline-interval.reorder'(payload,ctx){
      const item=state.timelineIntervals.find(x=>x.id===payload.intervalId);if(!item)return refuse('INTERVAL_NOT_FOUND',{});const conflict=checkRev(ctx,'timeline-interval',item.id);if(conflict)return conflict;
      const rowOrder=intervalRowPosition(payload.beforeId,item.id);if(rowOrder===null)return refuse('INTERVAL_NOT_FOUND',{});
      return {ok:true,apply:()=>{const before={...item};item.rowOrder=rowOrder;return {value:{...item},entity:{kind:'timeline-interval',id:item.id},before,after:{...item},changed:true};}};
    },
    'timeline-interval.create'(payload) {
      if(typeof payload.name!=='string'||!payload.name.trim())return refuse('NAME_REQUIRED',{});
      if(typeof payload.start!=='string'||typeof payload.end!=='string'||!/(Z|[+-]\d\d:\d\d)$/i.test(payload.start)||!/(Z|[+-]\d\d:\d\d)$/i.test(payload.end))return refuse('INTERVAL_TIME_INVALID',{});
      const start=Date.parse(payload.start),end=Date.parse(payload.end);
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return refuse('INTERVAL_TIME_INVALID',{});
      const rowOrder=intervalRowPosition(payload.beforeId);if(rowOrder===null)return refuse('INTERVAL_NOT_FOUND',{});
      if(payload.rowId&&!state.timelineRows.some(x=>x.id===payload.rowId))return refuse('INTERVAL_NOT_FOUND',{});if(payload.rowId&&state.timelineRows.find(x=>x.id===payload.rowId)?.queue?.ids?.length)return refuse('QUEUE_LINKED_EDGE',{});
      if(payload.color!==undefined&&!/^#[0-9a-f]{6}$/i.test(payload.color))return refuse('PAYLOAD_INVALID',{});const item={...(payload.color?{color:payload.color}:{}),rowId:payload.rowId||null,rowOrder,followNow:payload.followNow===true,id:id('interval'),name:payload.name.trim().slice(0,200),start:new Date(start).toISOString(),end:new Date(end).toISOString(),rev:1,createdAt:new Date().toISOString()};
      item.rowId=item.rowId||item.id;const previousLive=payload.rowId?state.timelineIntervals.find(x=>x.rowId===item.rowId&&x.followNow&&Date.parse(x.start)<start):null;const now=Date.now();if(previousLive&&start<=now){item.followNow=true;item.end=new Date(Math.max(start+1,now)).toISOString();if(previousLive.deadline)item.deadline=previousLive.deadline;}if(overlapsSession(item,previousLive?.id))return refuse('INTERVAL_OVERLAP',{});
      return {ok:true,apply:()=>{if(previousLive){previousLive.followNow=false;previousLive.end=new Date(Math.max(Date.parse(previousLive.start)+1,Math.min(start,now))).toISOString();previousLive.rev++;}state.timelineIntervals.push(item);return {value:{...item},entity:{kind:'timeline-interval',id:item.id},before:null,after:{...item},changed:true,created:true};}};
    },
    'timeline-interval.patch'(payload,ctx) {
      const item=state.timelineIntervals.find(x=>x.id===payload.intervalId);if(!item)return refuse('INTERVAL_NOT_FOUND',{});
      const conflict=checkRev(ctx,'timeline-interval',item.id);if(conflict)return conflict;
      const patch=payload.patch||{},checkedQueue=patch.checked===true&&item.followNow?queueForInterval(item.id):null;if(checkedQueue&&checkedQueue.queue.ids[0]===item.id)return queueChange(()=>{item.checked=true;item.followNow=false;item.end=new Date(Math.max(Date.parse(item.start)+1,Date.now())).toISOString();item.rev++;checkedQueue.queue.ids.shift();const next=state.timelineIntervals.find(x=>x.id===checkedQueue.queue.ids[0]);if(next){next.start=item.end;next.end=new Date(Date.parse(item.end)+1).toISOString();next.followNow=true;next.rev++;}return {id:item.id};});if(queueForInterval(item.id)&&['start','end','followNow','deadline'].some(key=>key in patch))return refuse('QUEUE_LINKED_EDGE',{});const next={...item,...Object.fromEntries(Object.entries(patch).filter(([key])=>["name","start","end","followNow","color","deadline","checked"].includes(key)))};
      if(typeof next.start!=="string"||typeof next.end!=="string"||!/(Z|[+-]\d\d:\d\d)$/i.test(next.start)||!/(Z|[+-]\d\d:\d\d)$/i.test(next.end))return refuse("INTERVAL_TIME_INVALID",{});
      const start=Date.parse(next.start),end=Date.parse(next.end);
      if(typeof next.name!=='string'||!next.name.trim()||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return refuse('INTERVAL_TIME_INVALID',{});
      if(next.checked!==undefined&&typeof next.checked!=='boolean')return refuse('PAYLOAD_INVALID',{});
      if(typeof next.followNow!=='boolean'&&next.followNow!==undefined)return refuse('PAYLOAD_INVALID',{});
      if(next.color!==undefined&&!/^#[0-9a-f]{6}$/i.test(next.color))return refuse('PAYLOAD_INVALID',{});
      if(next.deadline!=null&&(typeof next.deadline!=='string'||!/(Z|[+-]\d\d:\d\d)$/i.test(next.deadline)||!Number.isFinite(Date.parse(next.deadline))||Date.parse(next.deadline)<=start))return refuse('INTERVAL_TIME_INVALID',{});
      if(next.deadline!=null)next.deadline=new Date(Date.parse(next.deadline)).toISOString();
      if(['start','end','followNow'].some(key=>key in patch)&&overlapsSession(next,item.id))return refuse('INTERVAL_OVERLAP',{});
      next.start=new Date(start).toISOString();next.end=new Date(end).toISOString();next.name=next.name.trim().slice(0,200);
      return {ok:true,apply:()=>{const before={...item};Object.assign(item,next);return {value:{...item},entity:{kind:'timeline-interval',id:item.id},before,after:{...item},changed:true};}};
    },
    'timeline-interval.delete'(payload,ctx) {
      const item=state.timelineIntervals.find(x=>x.id===payload.intervalId);if(!item)return refuse('INTERVAL_NOT_FOUND',{});
      const conflict=checkRev(ctx,'timeline-interval',item.id);if(conflict)return conflict;
      return {ok:true,apply:()=>{state.timelineIntervals=state.timelineIntervals.filter(x=>x.id!==item.id);return {value:{id:item.id},entity:{kind:'timeline-interval',id:item.id},before:{...item},after:null,changed:true};}};
    },

    'schedule-event.create'(payload, ctx) {
      if (typeof payload.name !== 'string' || !payload.name.trim()) return refuse('NAME_REQUIRED', {});
      if (!validInstant(payload.start)) return refuse('EVENT_TIME_INVALID', { field: 'start', value: payload.start });
      if (!validInstant(payload.deadline)) return refuse('EVENT_TIME_INVALID', { field: 'deadline', value: payload.deadline });
      if (new Date(payload.deadline).getTime() <= new Date(payload.start).getTime()) return refuse('EVENT_END_BEFORE_START', {});
      if (payload.project && !findProject(payload.project)) return refuse('PROJECT_NOT_FOUND', { projectId: payload.project });
      if (payload.project && (findProject(payload.project).projectType !== 'schedule' || findProject(payload.project).archivedAt)) return refuse('PROJECT_TYPE_INVALID', {});
      const recurrence = normaliseRecurrence(payload.recurrence);
      if (!recurrence) return refuse('RECURRENCE_INVALID', {});
      const item = {
        id: id('evt'),
        name: payload.name.trim().slice(0, 200),
        note: typeof payload.note === 'string' ? payload.note.slice(0, 1000) : '',
        project: payload.project || '',
        start: new Date(payload.start).toISOString(),
        deadline: new Date(payload.deadline).toISOString(),
        recurrence: recurrence,
        exceptions: [],
        sourceKey: typeof payload.sourceKey === 'string' ? payload.sourceKey : '',
        color: typeof payload.color === 'string' ? payload.color : '',
        createdAt: new Date().toISOString(),
        rev: 1,
      };
      return { ok: true, apply: () => {
        state.scheduleEvents.push(item);
        return { value: { ...item }, entity: { kind: 'schedule-event', id: item.id }, before: null, after: { ...item }, changed: true, created: true };
      } };
    },

    'schedule-event.patch'(payload, ctx) {
      const item = findScheduleEvent(payload.eventId);
      if (!item) return refuse('ENTITY_NOT_FOUND', { kind: 'schedule event', id: payload.eventId });
      const conflict = checkRev(ctx, 'schedule-event', payload.eventId);
      if (conflict) return conflict;
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : null;
      if (!patch || !Object.keys(patch).length) return refuse('PAYLOAD_INVALID', { type: 'schedule-event.patch', missing: ['patch'] });
      if ('id' in patch || 'createdAt' in patch) return refuse('FIELD_NOT_PATCHABLE', { field: 'id/createdAt', use: 'nothing — provenance is immutable' });
      if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) return refuse('NAME_REQUIRED', {});
      if ('project' in patch && patch.project && !findProject(patch.project)) return refuse('PROJECT_NOT_FOUND', { projectId: patch.project });
      if ('project' in patch && patch.project && (findProject(patch.project).projectType !== 'schedule' || findProject(patch.project).archivedAt)) return refuse('PROJECT_TYPE_INVALID', {});
      if ('recurrence' in patch && !normaliseRecurrence(patch.recurrence)) return refuse('RECURRENCE_INVALID', {});
      const next = {};
      if ('name' in patch) next.name = patch.name.trim().slice(0, 200);
      if ('note' in patch) next.note = typeof patch.note === 'string' ? patch.note.slice(0, 1000) : '';
      if ('project' in patch) next.project = patch.project || '';
      if ('start' in patch) { if (!validInstant(patch.start)) return refuse('EVENT_TIME_INVALID', { field: 'start', value: patch.start }); next.start = new Date(patch.start).toISOString(); }
      if ('deadline' in patch) { if (!validInstant(patch.deadline)) return refuse('EVENT_TIME_INVALID', { field: 'deadline', value: patch.deadline }); next.deadline = new Date(patch.deadline).toISOString(); }
      if ('recurrence' in patch) next.recurrence = normaliseRecurrence(patch.recurrence);
      if ('color' in patch) next.color = typeof patch.color === 'string' ? patch.color.slice(0, 32) : '';
      const afterStart = new Date(next.start || item.start).getTime();
      const afterEnd = new Date(next.deadline || item.deadline).getTime();
      if (!(afterEnd > afterStart)) return refuse('EVENT_END_BEFORE_START', {});
      const changed = Object.keys(next).filter((key) => JSON.stringify(item[key]) !== JSON.stringify(next[key]));
      if (!changed.length) return { ok: true, apply: () => ({ value: { ...item }, entity: { kind: 'schedule-event', id: item.id }, before: null, after: null, changed: false }) };
      const before = {}; const after = {};
      changed.forEach((key) => { before[key] = item[key]; after[key] = next[key]; });
      return { ok: true, apply: () => { Object.assign(item, next); return { value: { ...item }, entity: { kind: 'schedule-event', id: item.id }, before, after, changed: true }; } };
    },

    'schedule-event.occurrence.patch'(payload, ctx) {
      const item = findScheduleEvent(payload.eventId);
      if (!item) return refuse('ENTITY_NOT_FOUND', { kind: 'schedule event', id: payload.eventId });
      const conflict = checkRev(ctx, 'schedule-event', payload.eventId);
      if (conflict) return conflict;
      if (typeof payload.occurrenceKey !== 'string' || !payload.occurrenceKey) return refuse('OCCURRENCE_INVALID', {});
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : null;
      if (!patch) return refuse('PAYLOAD_INVALID', { type: 'schedule-event.occurrence.patch', missing: ['patch'] });
      const existing = findScheduleException(item, payload.occurrenceKey);
      const base = existing && !existing.cancelled ? existing : { start: payload.occurrenceStart, deadline: payload.occurrenceDeadline, name: item.name, note: item.note, color: item.color };
      if (!validInstant(base.start) || !validInstant(base.deadline)) return refuse('OCCURRENCE_INVALID', {});
      const next = {
        key: payload.occurrenceKey,
        start: 'start' in patch ? patch.start : base.start,
        deadline: 'deadline' in patch ? patch.deadline : base.deadline,
        name: 'name' in patch ? String(patch.name || '').trim().slice(0, 200) : (base.name || item.name),
        note: 'note' in patch ? String(patch.note || '').slice(0, 1000) : (base.note || item.note),
        color: 'color' in patch ? String(patch.color || '').slice(0, 32) : (base.color || item.color),
        cancelled: false,
        detached: true,
      };
      if (!next.name) return refuse('NAME_REQUIRED', {});
      if (!validInstant(next.start) || !validInstant(next.deadline)) return refuse('EVENT_TIME_INVALID', { field: 'occurrence', value: next.start });
      if (new Date(next.deadline).getTime() <= new Date(next.start).getTime()) return refuse('EVENT_END_BEFORE_START', {});
      const before = existing ? { ...existing } : null;
      return { ok: true, apply: () => {
        const exceptions = Array.isArray(item.exceptions) ? item.exceptions : (item.exceptions = []);
        const index = exceptions.findIndex((exception) => exception.key === next.key);
        exceptions.splice(index < 0 ? exceptions.length : index, index < 0 ? 0 : 1, next);
        return { value: { ...item, exceptions: exceptions.map((exception) => ({ ...exception })) }, entity: { kind: 'schedule-event', id: item.id }, before: before, after: { ...next }, changed: true };
      } };
    },

    'schedule-event.occurrence.delete'(payload, ctx) {
      const item = findScheduleEvent(payload.eventId);
      if (!item) return refuse('ENTITY_NOT_FOUND', { kind: 'schedule event', id: payload.eventId });
      const conflict = checkRev(ctx, 'schedule-event', payload.eventId);
      if (conflict) return conflict;
      if (typeof payload.occurrenceKey !== 'string' || !payload.occurrenceKey) return refuse('OCCURRENCE_INVALID', {});
      const before = findScheduleException(item, payload.occurrenceKey);
      return { ok: true, apply: () => {
        const exceptions = Array.isArray(item.exceptions) ? item.exceptions : (item.exceptions = []);
        const index = exceptions.findIndex((exception) => exception.key === payload.occurrenceKey);
        const cancelled = { key: payload.occurrenceKey, cancelled: true };
        if (index < 0) exceptions.push(cancelled); else exceptions.splice(index, 1, cancelled);
        return { value: { id: item.id, occurrenceKey: payload.occurrenceKey }, entity: { kind: 'schedule-event', id: item.id }, before: before, after: cancelled, changed: true };
      } };
    },

    'schedule-event.delete'(payload, ctx) {
      const item = findScheduleEvent(payload.eventId);
      if (!item) return refuse('ENTITY_NOT_FOUND', { kind: 'schedule event', id: payload.eventId });
      const conflict = checkRev(ctx, 'schedule-event', payload.eventId);
      if (conflict) return conflict;
      return { ok: true, apply: () => {
        const index = state.scheduleEvents.indexOf(item);
        state.scheduleEvents.splice(index, 1);
        return { value: { id: item.id }, entity: { kind: 'schedule-event', id: item.id }, before: { ...item }, after: null, changed: true };
      } };
    },

    'proposal.accept'(payload, ctx) {
      return refuse('COMMAND_NOT_IMPLEMENTED', { type: 'proposal.accept', slice: 'slice 2' });
    },
    'history.revert'(payload, ctx) {
      return refuse('COMMAND_NOT_IMPLEMENTED', { type: 'history.revert', slice: 'slice 2' });
    },
  };

  /**
   * Trim the two logs. Events keep their seq — the numbers are the log's identity —
   * and `prunedThrough` records where this copy starts, so "nothing happened yet"
   * and "this is where my copy begins" stay distinguishable.
   */
  function rememberEvent(event) {
    state.events.push(event);
    if (state.events.length > EVENT_MEMORY) {
      const dropped = state.events.splice(0, state.events.length - EVENT_MEMORY);
      state.prunedThrough = dropped[dropped.length - 1].seq;
    }
  }

  function rememberCommand(commandId, record) {
    state.commands[commandId] = record;
    const ids = Object.keys(state.commands);
    if (ids.length > COMMAND_MEMORY) {
      // Oldest first, by the sequence each command produced.
      ids.sort((a, b) => (state.commands[a].seq || 0) - (state.commands[b].seq || 0))
        .slice(0, ids.length - COMMAND_MEMORY)
        .forEach((old) => { delete state.commands[old]; });
    }
  }

  /**
   * Apply one command in a serialized transaction. Resolve only after durable
   * persistence succeeds, or roll back and report the failure.
   */
  let commandQueue=Promise.resolve();
  // An envelope marked `automatic` (not the creator's action, e.g. a queue freezing when its time is up)
  // is saved under that mark, so sync never lets it outrank or ask against the creator's edits.
  function command(envelope){const automatic=envelope?.automatic===true;const execute=async()=>{if(automatic)globalThis.__proximaAutomaticWrites=(globalThis.__proximaAutomaticWrites||0)+1;try{return await executeCommand();}finally{if(automatic)globalThis.__proximaAutomaticWrites--;}};const executeCommand=async()=>{if(globalThis.ProximaPersistence){const latest=await ProximaPersistence.read();if(latest){state=normalise(latest).state;ensureTimelineRows();}}const before=freezeFollowEdit(envelope);try{const result=await applyCommand(envelope);if(before&&(!result.ok||!result.changed))state=before;return result;}catch(error){if(before)state=before;throw error;}};const next=commandQueue.then(()=>globalThis.ProximaPersistence&&globalThis.navigator?.locks?navigator.locks.request('proxima-store-write',execute):execute());commandQueue=next.catch(()=>{});return next;}
  async function applyCommand(envelope) {
    const env = envelope && typeof envelope === 'object' ? envelope : {};
    const type = String(env.type || '');
    const payload = env.payload && typeof env.payload === 'object' ? env.payload : {};
    const handler = COMMANDS[type];
    if (!handler) return { ...refuse('COMMAND_UNKNOWN', { type: type }), commandId: env.commandId || null };

    const commandId = typeof env.commandId === 'string' && env.commandId ? env.commandId : id('cmd');
    const fingerprintNow = fingerprint(type, payload);

    const rememberedRefusal = refusalMemory.get(commandId);
    if (rememberedRefusal && rememberedRefusal.fingerprint === fingerprintNow) {
      return { ...rememberedRefusal.refusal, commandId: commandId };
    }

    const seen = state.commands[commandId];
    if (seen) {
      if (seen.fingerprint !== fingerprintNow) {
        return { ...refuse('COMMAND_ID_CONFLICT', { commandId: commandId, first: seen.type, now: type }), commandId: commandId };
      }
      // Idempotent by id: the answer it gave the first time, not a second helping.
      return {
        ok: true,
        commandId: commandId,
        replayed: true,
        seq: seen.seq,
        rev: seen.rev,
        changed: false,
        value: seen.value,
      };
    }

    if(env.expectedSeq!==undefined&&(!Number.isSafeInteger(env.expectedSeq)||env.expectedSeq!==state.seq))return {...refuse('SOURCE_CHANGED',{expected:env.expectedSeq,current:state.seq}),commandId};
    const checked = handler(payload, {
      actor: env.actor || Cockpit.actor,
      client: env.client || Cockpit.clientId,
      ifRev: env.ifRev,
      commandId: commandId,
    });
    if (!checked.ok) {
      refusalMemory.set(commandId, { fingerprint: fingerprintNow, refusal: checked });
      return { ...checked, commandId: commandId };
    }

    if(checked.readOnlyResult)return {ok:true,changed:false,value:checked.readOnlyResult,commandId};
    let outcome = null;
    const applied = await commit(() => {
      const timelineBefore=(type.startsWith('timeline-interval.')||type.startsWith('timeline-queue.'))?timelineSnapshot():null;
      const result = checked.apply();
      if(timelineBefore)syncTimelineRows(type,payload);
      if(type.startsWith('timeline-queue.')&&result.changed){const history=timelineHistory();history.undo.push({});if(history.undo.length>200)history.undo.shift();history.redo=[];}
      if (!result.changed) {
        // Accepted, and there was nothing to do: no event, no revision, no new
        // sequence number. The command is still remembered, so a replay of it is
        // answered from memory like any other.
        rememberCommand(commandId, { type: type, fingerprint: fingerprintNow, seq: state.seq, rev: null, ok: true, value: result.value });
        return result;
      }
      state.seq = positiveInt(state.seq, 0) + 1;
      const entity = result.entity || { kind: 'board', id: 'board' };
      // A creation IS revision 1 — the first version of the record — so it does not
      // bump. Everything else moves the revision on by one.
      if (!result.created) {
        if (entity.kind === 'task') {
          const task = findTask(entity.id);
          if (task) task.rev = positiveInt(task.rev, 1) + 1;
        } else if (entity.kind === 'project') {
          const project = findProject(entity.id);
          if (project) project.rev = positiveInt(project.rev, 1) + 1;
        } else if (entity.kind === 'run' && state.run) {
          state.run.rev = positiveInt(state.run.rev, 1) + 1;
        } else if(entity.kind==='timeline-interval'){const item=state.timelineIntervals.find(x=>x.id===entity.id);if(item)item.rev+=1;
        } else if (entity.kind === 'schedule-event') {
          const scheduleEvent = findScheduleEvent(entity.id);
          if (scheduleEvent) scheduleEvent.rev = positiveInt(scheduleEvent.rev, 1) + 1;
        }
      }
      if(entity.kind==='timeline-interval'&&type.startsWith('timeline-interval.')){const history=timelineHistory();history.undo.push({id:entity.id,before:result.before?structuredClone(result.before):null,after:structuredClone(state.timelineIntervals.find(x=>x.id===entity.id)||null)});if(history.undo.length>200)history.undo.shift();history.redo=[];}
      const rev = revisionOf(entity.kind, entity.id);
      // The value handed back is the record AS COMMITTED, revision included: a
      // caller that wants to send ifRev next needs the number the store now holds,
      // not the one it held while the handler was building its answer.
      const value = result.value && typeof result.value === 'object' && 'rev' in result.value
        ? { ...result.value, rev: rev }
        : result.value;
      if(timelineBefore&&result.changed){const history=timelineHistory();const entry=history.undo.at(-1);if(entry){entry.beforeState=timelineBefore;entry.afterState=timelineSnapshot();}}
      rememberEvent({
        seq: state.seq,
        at: new Date().toISOString(),
        type: type,
        commandId: commandId,
        actor: env.actor || Cockpit.actor,
        client: env.client || Cockpit.clientId,
        entity: entity,
        before: result.before === undefined ? null : result.before,
        after: result.after === undefined ? null : result.after,
        ...(result.extra ? { extra: result.extra } : {}),
      });
      rememberCommand(commandId, { type: type, fingerprint: fingerprintNow, seq: state.seq, rev: rev, ok: true, value: value });
      outcome = { seq: state.seq, rev: rev, value: value, changed: true };
      return result;
    });

    if (!applied) {
      // commit() rolled the whole change back, including the command's memory of
      // itself, and has already told the surface. Hand back the same shape as any
      // other refusal so the caller has one thing to handle.
      return { ...refuse('WRITE_FAILED', { reason: (lastError && lastError.reason) || 'write-failed' }), commandId: commandId };
    }
    if (!outcome) {
      // Nothing changed. `applied` is the handler's own answer; there is no new
      // sequence number to report and no revision to claim.
      const entity = applied.entity || null;
      return {
        ok: true,
        commandId: commandId,
        replayed: false,
        changed: false,
        seq: state.seq,
        rev: entity ? revisionOf(entity.kind, entity.id) : null,
        value: applied.value,
      };
    }
    return { ok: true, commandId: commandId, replayed: false, seq: outcome.seq, rev: outcome.rev, changed: true, value: outcome.value };
  }

  return {
    snapshot: () => structuredClone(state),
    previewImport(projection,importId){try{return {ok:true,candidate:ProximaRemoteDomain.prepareImport(projection,importId)};}catch(error){return refuse('IMPORT_INVALID',{reason:error.message});}},
    importedRuns:()=>structuredClone(state.importedRuns||[]),
    imports:()=>structuredClone(state.remoteImports||[]).map(receipt=>receipt.value),
    pendingImports:()=>structuredClone(state.remotePendingImports||[]),
    follows:()=>structuredClone((state.remoteImports||[]).filter(receipt=>receipt.follow?.enabled).map(receipt=>({id:receipt.id,label:receipt.label,source:receipt.value.source,follow:receipt.follow,expected:fingerprint('follow-conflicts',receipt.follow.conflicts||[])}))),
    observeFollow(importId,projection,online){if(!online&&projection){const validated=ProximaRemoteDomain.validateProjection(projection),receipt=(state.remoteImports||[]).find(item=>item.id===importId);if(receipt?.follow?.enabled&&validated.source.ownerId===receipt.value.source.ownerId&&validated.source.backpackId===receipt.value.source.backpackId&&validated.source.seq>=receipt.follow.sourceSeq&&!followObservations.has(importId))followObservations.set(importId,{projection:validated,online:false,receivedAt:Date.now()});}if(!online){const existing=followObservations.get(importId);if(existing?.online){const now=Date.now(),frozen=structuredClone(existing.projection);frozen.source.observedAt=new Date(Date.parse(frozen.source.observedAt)+Math.max(0,now-existing.receivedAt)).toISOString();followObservations.set(importId,{projection:frozen,online:false,receivedAt:now});}return;}const validated=ProximaRemoteDomain.validateProjection(projection),receipt=(state.remoteImports||[]).find(item=>item.id===importId);if(!receipt?.follow?.enabled||validated.source.ownerId!==receipt.value.source.ownerId||validated.source.backpackId!==receipt.value.source.backpackId||validated.source.seq<receipt.follow.sourceSeq)return;followObservations.set(importId,{projection:validated,online:true,receivedAt:Date.now()});},
    flushCommands:()=>commandQueue,
    refreshReadSnapshot(){const read=async()=>{if(!globalThis.ProximaPersistence?.device)throw Error('Only a device view uses a remote read snapshot.');const latest=await ProximaPersistence.read();if(latest){state=normalise(latest).state;ensureTimelineRows();}};const next=commandQueue.then(read);commandQueue=next.catch(()=>{});return next;},
    /** One read checkpoint through this owner; never exports raw persistence or cockpit state. */
    remoteProjection(source,selection=null,includeViewLayout=false){
      const read=async()=>{if(globalThis.ProximaPersistence){await ProximaPersistence.ready;const latest=await ProximaPersistence.read();if(latest){state=normalise(latest).state;ensureTimelineRows();}}const now=Date.now();const effective=timelineRead(now).map(item=>({...item,...(item.followNow?{end:new Date(Math.max(Date.parse(item.start)+1,now)).toISOString()}: {})}));const projection=ProximaRemoteDomain.project(state,source,selection,now,effective);if(includeViewLayout)projection.viewLayout={tasks:Object.fromEntries(state.tasks.filter(item=>projection.records.tasks.some(record=>record.id===item.id)).map(item=>[item.id,{order:item.order??0,ganttRow:item.ganttRow??null}])),timelineRows:Object.fromEntries(state.timelineRows.filter(item=>projection.records.timelineRows.some(record=>record.id===item.id)).map(item=>[item.id,{rowOrder:item.rowOrder??0}]))};return projection;};
      const next=commandQueue.then(()=>globalThis.ProximaPersistence&&globalThis.navigator?.locks?navigator.locks.request('proxima-store-write',read):read());commandQueue=next.catch(()=>{});return next;
    },

    /**
     * What happened when the store was read, and whether the last write failed.
     * The surface asks this once at startup, so unreadable data is reported rather
     * than presented as an empty app.
     */
    loadStatus: () => ({ ...loaded.status }),
    writeError: () => (lastError ? { ...lastError } : null),
    onWriteFailure(handler) { failureHandler = typeof handler === 'function' ? handler : null; },

    // ── Reads: synchronous, against the in-memory snapshot ────────────────────
    projects: () => state.projects.slice(),

    project: (projectId) => state.projects.find((p) => p.id === projectId) ?? null,

    tasks: () => state.tasks.slice(),

    task: (taskId) => state.tasks.find((t) => t.id === taskId) ?? null,

    timelineIntervals:()=>timelineRead(),
    timelineRows:()=>state.timelineRows.map(x=>({...x})),
    scheduleEvents: () => state.scheduleEvents.map((event) => ({ ...event, recurrence: event.recurrence ? { ...event.recurrence } : null, exceptions: Array.isArray(event.exceptions) ? event.exceptions.map((exception) => ({ ...exception })) : [] })),

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

    /** The event log, oldest first. An agent reads this; the UI only logs to it. */
    events: () => state.events.map((e) => ({ ...e })),

    /** Where the log's numbering starts in this copy, when it has been trimmed. */
    prunedThrough: () => (Number.isFinite(Number(state.prunedThrough)) ? Number(state.prunedThrough) : 0),

    /** The next sequence number a committed command will take. */
    nextSeq: () => positiveInt(state.seq, 0) + 1,

    /** A fresh idempotency key, for a caller that wants one act to stay one act. */
    newCommandId: () => id('cmd'),

    /** The one way board data changes. See the command layer above. */
    command: command,

    /** What an older document kept under `views`, for Cockpit to adopt once. */
    legacyViews: () => (legacyViews ? { ...legacyViews } : null),
  };

  function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
})();

/**
 * Adopt the composition an older build kept in the board document. It was never
 * board data — it was always "how this cockpit looks" — so it moves to where it
 * belonged, once, and the board document stops carrying it from the next write on.
 */
(function adoptLegacyViews() {
  if (Cockpit.hasStoredPrefs()) return;
  const legacy = Store.legacyViews();
  if (!legacy) return;
  Cockpit.patch(legacy);
})();
