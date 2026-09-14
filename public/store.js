/*
 * The cockpit's side of the data plane.
 *
 * There is no board in this file any more. The service (proximad) owns the data;
 * this is a client of it. Three things live here and nothing else:
 *
 *   Store    an HTTP client for the command API, holding the last snapshot in
 *            memory so reads stay synchronous (a renderer should not await), a
 *            read-only CACHE of that snapshot on disk so a launch paints something
 *            before the service answers, and a subscription that keeps the copy
 *            current when another cockpit changes something.
 *
 *   Cockpit  how THIS cockpit looks — which panels are open, how far the timeline
 *            is zoomed. Device preference, not board data, so it stays local and is
 *            mirrored to the service's preferences table so a browser wipe stops
 *            costing the reader their layout.
 *
 *   the migration bridge: reading the pre-service board out of localStorage so it
 *            can be shown, counted and imported. Nothing here ever writes it, and
 *            nothing here ever falls back to it.
 *
 * THE RULE THAT MATTERS: once a board lives in the service, this cockpit never
 * writes board data to the browser again — not on failure, not as a fallback, not
 * "just in case". A local write is how you end up with two boards that disagree,
 * which is the whole failure this design exists to escape. If the service cannot be
 * reached the cockpit says so and goes read-only.
 */

const Cockpit = (() => {
  const KEY = 'proxima.cockpit.v1';
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

  function readLocal() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {};
    } catch {
      return {};
    }
  }

  const clientId = detectClient();
  let clients = readLocal();
  let failureHandler = null;

  function normalisePrefs(value) {
    const prefs = {
      calendar: value ? Boolean(value.calendar) : DEFAULT_PREFS.calendar,
      timeline: value && typeof value.timeline === 'boolean' ? value.timeline : DEFAULT_PREFS.timeline,
      countdown: value ? Boolean(value.countdown) : DEFAULT_PREFS.countdown,
      zoom: clampZoom(value ? value.zoom : undefined),
    };
    // All three panels off is not a composition anyone can look at, so the timeline
    // comes back — the same rule the original applies when the last one is switched
    // off.
    if (!prefs.calendar && !prefs.timeline && !prefs.countdown) prefs.timeline = true;
    return prefs;
  }

  function clampZoom(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_PREFS.zoom;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
  }

  function writeLocal() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, clients }));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String((error && error.name) || 'write-failed') };
    }
  }

  return {
    actor: ACTOR,
    clientId: clientId,
    prefs: () => normalisePrefs(clients[clientId]),
    onWriteFailure(handler) { failureHandler = typeof handler === 'function' ? handler : null; },

    /**
     * Adopt preferences the service holds for this cockpit — the layout it had
     * before a browser profile was wiped, say. Returns true when anything changed.
     */
    adopt(prefs) {
      if (!prefs) return false;
      const next = normalisePrefs(prefs);
      const current = normalisePrefs(clients[clientId]);
      if (next.calendar === current.calendar && next.timeline === current.timeline &&
          next.countdown === current.countdown && next.zoom === current.zoom) return false;
      clients[clientId] = next;
      writeLocal();
      return true;
    },

    /** The preferences as they should be sent to the service. */
    serialise: () => normalisePrefs(clients[clientId]),

    patch(partial) {
      const next = normalisePrefs({ ...normalisePrefs(clients[clientId]), ...(partial || {}) });
      const current = normalisePrefs(clients[clientId]);
      if (next.calendar === current.calendar && next.timeline === current.timeline &&
          next.countdown === current.countdown && next.zoom === current.zoom) {
        return next;
      }
      clients[clientId] = next;
      const outcome = writeLocal();
      if (outcome.ok) return { ...next };
      clients[clientId] = current;
      if (failureHandler) {
        try { failureHandler({ reason: outcome.reason, at: new Date().toISOString() }); } catch { /* reporting must never throw */ }
      }
      return null;
    },
  };
})();

const Store = (() => {
  /** The last snapshot, so a launch paints before the service answers. READ ONLY. */
  const CACHE_KEY = 'proxima.cache.v1';
  /** The pre-service board. Read once, for migration. Never written. */
  const LEGACY_KEY = 'proxima.store.v1';
  /** What the cockpit already knows about the migration. A note, not board data. */
  const MIGRATED_KEY = 'proxima.migrated.v1';

  const SCHEMA_VERSION = 1;

  /**
   * Which window this is.
   *
   * The cockpit id says WHICH COCKPIT — Papers, or the dev one, derived from how it
   * is being served. It is not enough to tell one window from another: two tabs of
   * the same cockpit share it, and a cockpit that treated their events as its own
   * would never see the other tab's changes. So the client an event records is
   * `cockpit#window`, and only this window's own changes are skipped on the stream.
   * The log gets the better answer out of it too: which window made a change.
   */
  const PAGE_ID = Math.random().toString(36).slice(2, 8);
  const clientLabel = () => Cockpit.clientId + '#' + PAGE_ID;

  let board = { projects: [], tasks: [], run: null };
  let headSeq = 0;
  let schemaVersion = SCHEMA_VERSION;
  let instanceId = null;
  let cachedAt = null;
  let mode = 'connecting';       // connecting | online | offline
  let detail = '';
  let lastError = null;
  let failureHandler = null;
  let source = null;             // the EventSource, when subscribed
  let refreshTimer = 0;
  let streamRetry = 0;
  let streamWatch = 0;
  let changeHandler = null;
  let statusHandler = null;

  const listeners = { change: null, status: null };

  // ── Local copies ──────────────────────────────────────────────────────────
  // Both of these are COPIES in the strict sense: the cache is replaced wholesale by
  // whatever the service last said, and the legacy document is only ever read.

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.board) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        at: new Date().toISOString(), headSeq, schemaVersion, instanceId, board,
      }));
      return true;
    } catch {
      return false; // a cache that cannot be written is not worth reporting
    }
  }

  function loadCache() {
    const cache = readCache();
    if (!cache) return false;
    board = {
      projects: Array.isArray(cache.board.projects) ? cache.board.projects : [],
      tasks: Array.isArray(cache.board.tasks) ? cache.board.tasks : [],
      run: cache.board.run || null,
    };
    headSeq = Number(cache.headSeq) || 0;
    cachedAt = cache.at || null;
    instanceId = cache.instanceId || null;
    return true;
  }

  function setStatus(next, why) {
    mode = next;
    detail = why || '';
    // Told every time rather than only on a change: the handler is a comparison and a
    // class toggle, and a missed transition leaves the reader looking at a banner that
    // says the service is down while the cockpit is happily writing to it.
    if (statusHandler) {
      try { statusHandler({ mode, detail, cachedAt }); } catch { /* reporting must never throw */ }
    }
  }

  function changed() {
    if (changeHandler) {
      try { changeHandler(); } catch { /* a listener must not break the store */ }
    }
  }

  // ── Talking to the service ────────────────────────────────────────────────

  const apiBase = () => {
    // In the real build the cockpit is served by the service, so the API is a path
    // on the same origin and the session cookie comes from the page load. A cockpit
    // served from anywhere else (a dev static server, say) points at the daemon with
    // `?api=http://127.0.0.1:4181/v1`, and the daemon has to be started with
    // `--allow-origin <that origin>` to accept a session from it.
    try {
      const named = new URLSearchParams(location.search).get('api');
      if (named) return named.replace(/\/+$/, '');
    } catch { /* no search params to read */ }
    try {
      if (window.__PROXIMA_BOOT__ && window.__PROXIMA_BOOT__.api) return window.__PROXIMA_BOOT__.api;
    } catch { /* no boot block: fall through */ }
    return '/v1';
  };

  async function request(method, path, body) {
    const response = await fetch(apiBase() + path, {
      method,
      // 'include' rather than 'same-origin': in the real build the API is on this
      // origin and the two are identical, and in a cockpit served from somewhere
      // else it is the difference between sending the session cookie and silently
      // not sending it. The daemon only answers with CORS headers for origins it was
      // started to trust.
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed };
  }

  /**
   * Earn a session cookie. The cockpit never holds a token: the page carries a
   * one-time nonce, and what comes back is an HttpOnly cookie the browser attaches
   * to every later request without JavaScript ever seeing it.
   */
  async function establishSession() {
    const boot = (() => { try { return window.__PROXIMA_BOOT__ || {}; } catch { return {}; } })();
    const result = await request('POST', '/session', { nonce: boot.nonce || null, client: Cockpit.clientId });
    if (result.status !== 200) {
      throw new Error((result.body && result.body.message) || 'The service refused a session.');
    }
    return result.body;
  }

  /**
   * A request with the session, earning a new one when the old one is gone.
   *
   * Sessions live in the daemon's memory, so RESTARTING the service invalidates every
   * cookie that exists. That is normal — an update, a crash, a reboot — and a cockpit
   * that answered "unauthorised" to it would be reporting its own staleness as the
   * reader's problem. One retry, then whatever the service said.
   */
  async function authed(method, path, body) {
    let result = await request(method, path, body);
    if (result.status === 401) {
      await establishSession();
      result = await request(method, path, body);
    }
    return result;
  }

  function applySnapshot(body) {
    if (!body || !body.board) return;
    board = {
      projects: Array.isArray(body.board.projects) ? body.board.projects : [],
      tasks: Array.isArray(body.board.tasks) ? body.board.tasks : [],
      run: body.board.run || null,
    };
    headSeq = Number(body.headSeq) || 0;
    schemaVersion = Number(body.schemaVersion) || SCHEMA_VERSION;
    instanceId = body.instanceId || instanceId;
    cachedAt = new Date().toISOString();
    writeCache();
  }

  async function refresh() {
    const result = await authed('GET', '/snapshot');
    if (result.status !== 200 || !result.body) throw new Error('snapshot failed');
    applySnapshot(result.body);
    changed();
  }

  /**
   * Subscribe to the log. A refresh rather than a patch: an event this cockpit did
   * not cause can renumber a whole column, and at this size re-reading the board is
   * both cheaper than reasoning about that and impossible to get subtly wrong.
   */
  function subscribe() {
    if (source || typeof EventSource === 'undefined') return;
    const url = apiBase() + '/events?after=' + headSeq;
    source = new EventSource(url, { withCredentials: true });
    source.onmessage = (event) => {
      let parsed = null;
      try { parsed = JSON.parse(event.data); } catch { return; }
      if (!parsed || parsed.client === clientLabel()) return; // our own change, already applied
      scheduleRefresh();
    };
    source.onerror = () => {
      // Two ways this ends. EventSource retries by itself while it can (readyState 0):
      // if it has not come back within a few seconds, the daemon is not there, and the
      // cockpit says so rather than claiming to be live. A CLOSED stream (readyState 2)
      // is the case it cannot fix at all: the daemon went away, or it refused the
      // request because the session died with the last restart.
      if (!source) return;
      if (source.readyState === 2) {
        source.close();
        source = null;
        setStatus('offline', 'the event stream closed');
        recoverSoon();
        return;
      }
      // Started once and NOT restarted by every retry: a stream that keeps failing
      // fires error after error, and a timer reset by each of them would never expire.
      if (!streamWatch) {
        streamWatch = window.setTimeout(() => {
          streamWatch = 0;
          if (source && source.readyState !== 1) {
            setStatus('offline', 'the event stream has not come back');
            recoverSoon();
          }
        }, 12000);
      }
    };
    source.onopen = () => {
      window.clearTimeout(streamWatch);
      streamWatch = 0;
      setStatus('online', '');
    };
  }

  /**
   * Keep trying, quietly, until the service answers again — every few seconds, not in
   * a tight loop. A cockpit that gave up after one attempt would sit there read-only
   * long after the daemon came back, and the reader would have no way to know they
   * only had to wait.
   */
  function recoverSoon() {
    window.clearTimeout(streamRetry);
    streamRetry = window.setTimeout(() => {
      if (mode === 'online') return;
      refresh()
        .then(() => { subscribe(); setStatus('online', ''); })
        .catch(() => recoverSoon());
    }, 5000);
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refresh().catch(() => { setStatus('offline', 'the service stopped answering'); recoverSoon(); });
    }, 30);
  }

  // ── Applying our own command results ──────────────────────────────────────
  // The fast path: our own change is already known, so it is applied without a
  // round trip. Anything else arrives as an event and goes through a refresh.

  function upsertTask(record) {
    const index = board.tasks.findIndex((t) => t.id === record.id);
    if (index < 0) board.tasks.push(record); else board.tasks[index] = record;
    board.tasks.sort((a, b) => a.order - b.order);
  }

  function applyOwn(type, payload, result) {
    const value = result.value;
    if (type === 'task.create' || type === 'task.patch' || type === 'task.move') {
      if (value && value.id) upsertTask(value);
    } else if (type === 'task.delete') {
      board.tasks = board.tasks.filter((t) => t.id !== payload.taskId);
    } else if (type === 'task.layout') {
      (payload.rows || []).forEach((row) => {
        const task = board.tasks.find((t) => t.id === row.taskId);
        if (task) task.ganttRow = row.ganttRow;
      });
    } else if (type === 'project.create' || type === 'project.archive' || type === 'project.restore') {
      if (value && value.id) {
        const index = board.projects.findIndex((p) => p.id === value.id);
        if (index < 0) board.projects.push(value); else board.projects[index] = value;
      }
    } else if (type === 'project.delete') {
      board.projects = board.projects.filter((p) => p.id !== payload.projectId);
      // Its tasks survive as uncategorised — the whole point of the command — so
      // they are updated here rather than re-fetched.
      (value && value.orphanedTaskIds ? value.orphanedTaskIds : []).forEach((id) => {
        const task = board.tasks.find((t) => t.id === id);
        if (task) task.project = '';
      });
    } else if (type === 'run.lock') {
      board.run = value && value.members ? value : board.run;
    } else if (type === 'run.unlock') {
      board.run = null;
    }
    headSeq = Math.max(headSeq, Number(result.seq) || 0);
    writeCache();
  }

  // ── The command boundary ──────────────────────────────────────────────────
  // Unchanged in shape from slice 1, because that shape was the point: the same
  // envelope, the same refusals, the same idempotency — it just travels now.

  async function command(envelope) {
    const env = envelope && typeof envelope === 'object' ? envelope : {};
    const payload = env.payload && typeof env.payload === 'object' ? env.payload : {};
    if (mode === 'offline') {
      return {
        ok: false,
        code: 'SERVICE_UNAVAILABLE',
        commandId: env.commandId || null,
        details: { mode: mode, detail: detail },
        message: 'The Proxima service is not reachable, so nothing was changed. This board is a read-only copy' +
          (cachedAt ? ' from ' + new Date(cachedAt).toLocaleString() : '') + '.',
      };
    }

    let result;
    try {
      result = await authed('POST', '/commands', {
        type: env.type,
        payload: payload,
        commandId: env.commandId,
        ifRev: env.ifRev,
        actor: env.actor || Cockpit.actor,
        client: env.client || clientLabel(),
      });
    } catch (error) {
      setStatus('offline', 'the service stopped answering');
      return {
        ok: false, code: 'SERVICE_UNAVAILABLE', commandId: env.commandId || null,
        details: { error: String((error && error.message) || error) },
        message: 'The Proxima service is not reachable, so nothing was changed.',
      };
    }

    if (result.status === 401) {
      // The session expired. Try once to earn another, then report honestly.
      try {
        await establishSession();
        return command(envelope);
      } catch {
        setStatus('offline', 'the service refused a session');
        return {
          ok: false, code: 'UNAUTHORISED', commandId: env.commandId || null, details: {},
          message: 'The service refused this cockpit a session. Nothing was changed.',
        };
      }
    }

    const body = result.body || {};
    if (body.ok) {
      setStatus('online', '');
      if (body.changed !== false) applyOwn(String(env.type || ''), payload, body);
      else writeCache();
      changed();
      return body;
    }
    if (body.code === 'WRITE_FAILED') {
      lastError = { reason: (body.details && body.details.reason) || 'write-failed', at: new Date().toISOString() };
      if (failureHandler) {
        try { failureHandler(lastError); } catch { /* reporting must never throw */ }
      }
    }
    return body;
  }

  // ── The migration bridge ──────────────────────────────────────────────────

  function legacyDocument() {
    let raw = null;
    try { raw = localStorage.getItem(LEGACY_KEY); } catch { return null; }
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    return { bytes: raw, parsed: parsed };
  }

  function legacySummary() {
    const legacy = legacyDocument();
    if (!legacy) return null;
    const parsed = legacy.parsed;
    if (!parsed || typeof parsed !== 'object') {
      return { origin: location.origin, bytes: legacy.bytes, unreadable: true, projects: 0, tasks: 0, run: false };
    }
    const counts = {
      origin: location.origin,
      bytes: legacy.bytes,
      projects: Array.isArray(parsed.projects) ? parsed.projects.length : 0,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.length : 0,
      run: Boolean(parsed.run && Array.isArray(parsed.run.members) && parsed.run.members.length),
      events: Array.isArray(parsed.events) ? parsed.events.length : 0,
    };
    counts.empty = counts.projects === 0 && counts.tasks === 0 && !counts.run;
    return counts;
  }

  return {
    // ── Starting up ─────────────────────────────────────────────────────────
    /**
     * Paint from the cache, then connect. Never throws: a cockpit that cannot reach
     * the service is a cockpit that says so, not one that fails to open.
     */
    async bootstrap() {
      loadCache();
      if (cachedAt) setStatus('connecting', 'showing a cached copy while the service is contacted');
      changed();
      try {
        await establishSession();
        await refresh();
        subscribe();
        setStatus('online', '');
        // How this cockpit looks, if the service remembers — a wiped browser profile
        // should not cost the reader their layout.
        try {
          const prefs = await authed('GET', '/preferences/' + encodeURIComponent(Cockpit.clientId));
          if (prefs.status === 200 && prefs.body && prefs.body.prefs) {
            if (Cockpit.adopt(prefs.body.prefs)) changed();
          }
        } catch { /* preferences are not worth failing a boot over */ }
      } catch (error) {
        setStatus('offline', String((error && error.message) || error));
        // A cockpit that opens while the service is away keeps trying, so the reader
        // does not have to guess that clicking the banner is the way back.
        recoverSoon();
      }
      return { mode, cachedAt };
    },

    mode: () => mode,
    detail: () => detail,
    cachedAt: () => cachedAt,
    instanceId: () => instanceId,
    headSeq: () => headSeq,
    schemaVersion: () => schemaVersion,
    onChange(handler) { changeHandler = typeof handler === 'function' ? handler : null; },
    onStatus(handler) { statusHandler = typeof handler === 'function' ? handler : null; },
    reconnect: () => refresh().then(() => { subscribe(); setStatus('online', ''); }),

    /** Ask the service to remember this cockpit's layout. Never blocks the reader. */
    savePreferences() {
      request('PUT', '/preferences/' + encodeURIComponent(Cockpit.clientId), { prefs: Cockpit.serialise() })
        .catch(() => { /* the local copy is the cockpit's own; this is only the mirror */ });
    },

    /**
     * Take the layout the service holds for this cockpit, if it has one. Returns true
     * when anything actually changed, so a caller can redraw only then.
     */
    async adoptPreferences() {
      try {
        const prefs = await authed('GET', '/preferences/' + encodeURIComponent(Cockpit.clientId));
        if (prefs.status !== 200 || !prefs.body || !prefs.body.prefs) return false;
        return Cockpit.adopt(prefs.body.prefs);
      } catch {
        return false;
      }
    },

    // ── Reads: synchronous, against the in-memory snapshot ───────────────────
    snapshot: () => structuredClone(board),
    projects: () => board.projects.slice(),
    project: (projectId) => board.projects.find((p) => p.id === projectId) ?? null,
    tasks: () => board.tasks.slice(),
    task: (taskId) => board.tasks.find((t) => t.id === taskId) ?? null,
    run: () => (board.run ? { ...board.run, members: board.run.members ? board.run.members.map((m) => ({ ...m })) : null } : null),

    // ── Writes: one command, one envelope, one result shape ──────────────────
    command: command,
    newCommandId: () => 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),

    // ── Migration ───────────────────────────────────────────────────────────
    legacySummary: legacySummary,
    migratedNote: () => {
      try { return JSON.parse(localStorage.getItem(MIGRATED_KEY) || 'null'); } catch { return null; }
    },
    inspectLegacy() {
      const legacy = legacyDocument();
      if (!legacy) return Promise.resolve({ ok: false, code: 'NOTHING_TO_MIGRATE', message: 'This browser has no pre-service board.' });
      return authed('POST', '/import/inspect', { origin: location.origin, bytes: legacy.bytes }).then((r) => r.body);
    },
    importLegacy() {
      const legacy = legacyDocument();
      if (!legacy) return Promise.resolve({ ok: false, code: 'NOTHING_TO_MIGRATE', message: 'This browser has no pre-service board.' });
      return authed('POST', '/import', { origin: location.origin, bytes: legacy.bytes, client: Cockpit.clientId })
        .then(async (r) => {
          if (r.body && r.body.ok) {
            try {
              localStorage.setItem(MIGRATED_KEY, JSON.stringify({
                at: new Date().toISOString(), origin: location.origin, archive: r.body.archive, report: r.body.report,
              }));
            } catch { /* a note that cannot be written is not a failure */ }
            await refresh();
          }
          return r.body;
        });
    },

    // ── Failures, reported rather than swallowed ─────────────────────────────
    loadStatus: () => ({ kind: mode === 'offline' ? 'offline' : mode === 'connecting' ? 'connecting' : 'ok', mode: mode, detail: detail, cachedAt: cachedAt }),
    writeError: () => (lastError ? { ...lastError } : null),
    onWriteFailure(handler) { failureHandler = typeof handler === 'function' ? handler : null; },
  };
})();
