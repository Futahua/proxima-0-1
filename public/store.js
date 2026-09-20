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
 * Today the bytes live in localStorage and a command is applied and persisted in
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
    const raw = safeGet(KEY);
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
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .map((raw) => normaliseTask(raw, knownProjects, notes))
      .filter((task) => {
        if (task) return true;
        notes.droppedTasks++;
        return false;
      });

    const events = (Array.isArray(parsed.events) ? parsed.events : []).filter((e) => e && typeof e === 'object');
    const scheduleEvents = (Array.isArray(parsed.scheduleEvents) ? parsed.scheduleEvents : [])
      .map((raw) => normaliseScheduleEvent(raw, knownProjects))
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

  function normaliseScheduleEvent(raw, knownProjects) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
    if (!validInstant(raw.start) || !validInstant(raw.deadline)) return null;
    const start = new Date(raw.start);
    const deadline = new Date(raw.deadline);
    if (deadline.getTime() <= start.getTime()) return null;
    const recurrence = raw.recurrence && typeof raw.recurrence === 'object'
      ? {
        frequency: raw.recurrence.frequency === 'daily' || raw.recurrence.frequency === 'weekly' ? raw.recurrence.frequency : 'none',
        interval: Math.max(1, Math.min(52, Math.round(Number(raw.recurrence.interval) || 1))),
        count: Math.max(0, Math.min(365, Math.round(Number(raw.recurrence.count) || 0))),
        until: isRealDay(raw.recurrence.until) ? raw.recurrence.until : '',
      }
      : { frequency: 'none', interval: 1, count: 0, until: '' };
    return {
      ...raw,
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : 'Untitled event',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 1000) : '',
      project: knownProjects.has(raw.project) ? raw.project : '',
      start: start.toISOString(),
      deadline: deadline.toISOString(),
      recurrence: recurrence,
      sourceKey: typeof raw.sourceKey === 'string' ? raw.sourceKey : '',
      color: typeof raw.color === 'string' ? raw.color : '',
      createdAt: validInstant(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
      rev: positiveInt(raw.rev, 1),
    };
  }

  function normaliseRecurrence(raw) {
    if (!raw || typeof raw !== 'object') return { frequency: 'none', interval: 1, count: 0, until: '' };
    const frequency = raw.frequency === 'daily' || raw.frequency === 'weekly' ? raw.frequency : raw.frequency === 'none' ? 'none' : null;
    if (!frequency) return null;
    return {
      frequency: frequency,
      interval: Math.max(1, Math.min(52, Math.round(Number(raw.interval) || 1))),
      count: Math.max(0, Math.min(365, Math.round(Number(raw.count) || 0))),
      until: isRealDay(raw.until) ? raw.until : '',
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

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
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

  /** The revision a command's `ifRev` is checked against. */
  function revisionOf(kind, targetId) {
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
  const COMMANDS = {
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
    'schedule-event.create'(payload, ctx) {
      if (typeof payload.name !== 'string' || !payload.name.trim()) return refuse('NAME_REQUIRED', {});
      if (!validInstant(payload.start)) return refuse('EVENT_TIME_INVALID', { field: 'start', value: payload.start });
      if (!validInstant(payload.deadline)) return refuse('EVENT_TIME_INVALID', { field: 'deadline', value: payload.deadline });
      if (new Date(payload.deadline).getTime() <= new Date(payload.start).getTime()) return refuse('EVENT_END_BEFORE_START', {});
      if (payload.project && !findProject(payload.project)) return refuse('PROJECT_NOT_FOUND', { projectId: payload.project });
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
      if ('recurrence' in patch && !normaliseRecurrence(patch.recurrence)) return refuse('RECURRENCE_INVALID', {});
      const next = {};
      if ('name' in patch) next.name = patch.name.trim().slice(0, 200);
      if ('note' in patch) next.note = typeof patch.note === 'string' ? patch.note.slice(0, 1000) : '';
      if ('project' in patch) next.project = patch.project || '';
      if ('start' in patch) { if (!validInstant(patch.start)) return refuse('EVENT_TIME_INVALID', { field: 'start', value: patch.start }); next.start = new Date(patch.start).toISOString(); }
      if ('deadline' in patch) { if (!validInstant(patch.deadline)) return refuse('EVENT_TIME_INVALID', { field: 'deadline', value: patch.deadline }); next.deadline = new Date(patch.deadline).toISOString(); }
      if ('recurrence' in patch) next.recurrence = normaliseRecurrence(patch.recurrence);
      const afterStart = new Date(next.start || item.start).getTime();
      const afterEnd = new Date(next.deadline || item.deadline).getTime();
      if (!(afterEnd > afterStart)) return refuse('EVENT_END_BEFORE_START', {});
      const changed = Object.keys(next).filter((key) => JSON.stringify(item[key]) !== JSON.stringify(next[key]));
      if (!changed.length) return { ok: true, apply: () => ({ value: { ...item }, entity: { kind: 'schedule-event', id: item.id }, before: null, after: null, changed: false }) };
      const before = {}; const after = {};
      changed.forEach((key) => { before[key] = item[key]; after[key] = next[key]; });
      return { ok: true, apply: () => { Object.assign(item, next); return { value: { ...item }, entity: { kind: 'schedule-event', id: item.id }, before, after, changed: true }; } };
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
   * Apply one command. Synchronous inside — localStorage is synchronous, and this
   * slice is not allowed to change how the app feels — and asynchronous in shape,
   * because the next slice's transport will be and every call site has to handle
   * that now rather than later.
   */
  async function command(envelope) {
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

    let outcome = null;
    const applied = commit(() => {
      const result = checked.apply();
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
        } else if (entity.kind === 'schedule-event') {
          const scheduleEvent = findScheduleEvent(entity.id);
          if (scheduleEvent) scheduleEvent.rev = positiveInt(scheduleEvent.rev, 1) + 1;
        }
      }
      const rev = revisionOf(entity.kind, entity.id);
      // The value handed back is the record AS COMMITTED, revision included: a
      // caller that wants to send ifRev next needs the number the store now holds,
      // not the one it held while the handler was building its answer.
      const value = result.value && typeof result.value === 'object' && 'rev' in result.value
        ? { ...result.value, rev: rev }
        : result.value;
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

    scheduleEvents: () => state.scheduleEvents.map((event) => ({ ...event, recurrence: event.recurrence ? { ...event.recurrence } : null })),

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
