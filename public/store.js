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
  // Who touched what. Kept BESIDE the records rather than inside them — an entity is
  // what the creator wrote, and provenance is a fact about it. Keyed `task:<id>` and
  // `project:<id>`, exactly as the service sends it.
  let attribution = {};
  /**
   * What moved since this reader last looked.
   *
   * An agent writes directly here, with no approval step, so the reader's first need
   * is not a notification — it is a diff. `seenSeq` is the watermark this window last
   * acknowledged; `recent` is every event after it, newest last. It is not a queue and
   * nothing is delivered: it is a list that gets shorter when the reader says so.
   */
  const SEEN_KEY = 'proxima.seen.v1';
  let seenSeq = 0;
  let recent = [];
  /** How far back the undo reaches. One number, used by the label and by the call. */
  const UNDO_WINDOW_MS = 3600 * 1000;
  let agentHour = [];
  let truncated = 0;
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
        at: new Date().toISOString(), headSeq, schemaVersion, instanceId, board, attribution,
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
    attribution = cache.attribution && typeof cache.attribution === 'object' ? cache.attribution : {};
    headSeq = Number(cache.headSeq) || 0;
    cachedAt = cache.at || null;
    instanceId = cache.instanceId || null;
    return true;
  }

  function readSeen() {
    try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
  }

  /**
   * What kind of act an event was, in words a reader uses.
   *
   * Counting is not summarising: "23 changes" tells the creator nothing about whether
   * their coworker spent the hour tidying or deleting. The categories are coarse on
   * purpose — five words cover the vocabulary and a reader can hold five.
   */
  const emptyKinds = () => ({ created: 0, edits: 0, moves: 0, deleted: 0, projects: 0, plans: 0, layouts: 0 });

  function tally(kinds, type) {
    const t = String(type || '');
    if (t === 'task.create') kinds.created += 1;
    else if (t === 'task.patch') kinds.edits += 1;
    else if (t === 'task.move') kinds.moves += 1;
    else if (t === 'task.delete') kinds.deleted += 1;
    else if (t.startsWith('project.')) kinds.projects += 1;
    else if (t.startsWith('run.')) kinds.plans += 1;
    else if (t === 'task.layout') kinds.layouts += 1;
  }

  /** "14 edits, 7 moves, 2 deletes" — in parts, so a caller can style one of them. */
  function kindParts(kinds) {
    // [key, word, does the word take an s]
    const order = [
      ['created', 'new', false], ['edits', 'edit', true], ['moves', 'move', true], ['deleted', 'delete', true],
      ['projects', 'project change', false], ['plans', 'plan change', false], ['layouts', 'layout pass', false],
    ];
    return order.filter(([key]) => kinds[key] > 0).map(([key, word, plural]) => ({
      key: key,
      count: kinds[key],
      label: kinds[key] + ' ' + word + (plural && kinds[key] !== 1 ? 's' : ''),
    }));
  }

  function describeKinds(kinds) {
    return kindParts(kinds).map((part) => part.label).join(', ');
  }

  function writeSeen() {
    try { localStorage.setItem(SEEN_KEY, String(seenSeq)); } catch { /* a watermark that cannot be written is not a failure */ }
  }

  /**
   * Record one event as something that moved.
   *
   * Capped: this is a diff of a session, not an archive. The log itself is the
   * archive, and an agent that made ten thousand changes is a story for the log
   * rather than a line on a page.
   */
  function noteEvent(event) {
    if (!event || !Number.isFinite(Number(event.seq))) return;
    if (Number(event.seq) <= seenSeq) return;
    if (recent.some((e) => e.seq === event.seq)) return;
    // Reverts are excluded for the same reason the service excludes them: undoing
    // the agent's work is not more agent work, and counting it would make the line
    // grow every time somebody used it.
    if (String(event.type || '').startsWith('history.revert') || String(event.type || '').startsWith('migration.')) return;
    recent.push(event);
    if (recent.length > 200) recent = recent.slice(-200);
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
    attribution = body.board.attribution && typeof body.board.attribution === 'object' ? body.board.attribution : {};
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
      if (!parsed) return;
      // Recorded BEFORE the own-change test, because the diff is about what moved on
      // the board, not about who moved it: this window's own change is still a change
      // the reader will want to see named next to the agent's.
      noteEvent(parsed);
      noteAgentHour(parsed);
      if (parsed.client === clientLabel()) { changed(); return; } // our own change, already applied
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

  /**
   * Read what happened while this window was not looking.
   *
   * SSE keeps a running cockpit current; it cannot say what it missed, because it
   * was not connected. This is the read side of that: everything after the watermark
   * the reader last acknowledged, straight out of the log.
   */
  async function catchUp() {
    const page = await fetchLog({ after: Math.max(0, seenSeq) });
    recent = [];
    page.events.forEach(noteEvent);
    // Said out loud rather than swallowed: a diff that quietly stops at a page
    // boundary reads exactly like a quiet hour.
    truncated = page.complete ? 0 : Math.max(0, page.headSeq - (page.events.length ? page.events[page.events.length - 1].seq : seenSeq));
  }

  /**
   * Read the log in pages.
   *
   * Both callers used to ask for one page of 200 and keep whatever came back, so a
   * busy day silently lost everything past the first page — the diff said "nothing
   * since you last looked" while four hundred changes sat in the log. The loop is
   * bounded (not unbounded), and when it stops at the bound the caller is told.
   */
  async function fetchLog(params) {
    const limit = 200;
    const out = [];
    let after = Number(params.after) || 0;
    let head = after;
    for (let page = 0; page < 25; page++) {
      const query = '/log?after=' + after + '&limit=' + limit + (params.since ? '&since=' + encodeURIComponent(params.since) : '');
      const result = await authed('GET', query);
      if (result.status !== 200 || !result.body || !Array.isArray(result.body.events)) return { events: out, complete: false, headSeq: head };
      const batch = result.body.events;
      head = Number(result.body.headSeq) || head;
      out.push(...batch);
      if (batch.length < limit) return { events: out, complete: true, headSeq: head };
      after = batch[batch.length - 1].seq;
    }
    return { events: out, complete: false, headSeq: head };
  }

  /**
   * What agents have done in the last hour, regardless of what the reader has already
   * acknowledged.
   *
   * The diff empties when the reader says they have looked; the undo must not empty
   * with it. This is the other question — "is there anything of an agent's in the
   * window an undo would cover?" — asked of the log directly.
   */
  async function refreshAgentHour() {
    const since = new Date(Date.now() - UNDO_WINDOW_MS).toISOString();
    const page = await fetchLog({ since });
    agentHour = page.events.filter((e) => String(e.actor || '').startsWith('agent:'));
  }

  /** Keep the hour current from the stream, or the handle vanishes when the diff does. */
  function noteAgentHour(event) {
    if (!event || !String(event.actor || '').startsWith('agent:')) return;
    const type = String(event.type || '');
    if (type.startsWith('history.revert') || type.startsWith('migration.')) return;
    const cutoff = Date.now() - UNDO_WINDOW_MS;
    agentHour = agentHour.filter((e) => e.seq !== event.seq && new Date(e.at).getTime() >= cutoff);
    agentHour.push(event);
  }

  // ── Applying our own command results ──────────────────────────────────────
  // The fast path: our own change is already known, so it is applied without a
  // round trip. Anything else arrives as an event and goes through a refresh.

  function upsertTask(record) {
    const index = board.tasks.findIndex((t) => t.id === record.id);
    if (index < 0) board.tasks.push(record); else board.tasks[index] = record;
    board.tasks.sort((a, b) => a.order - b.order);
  }

  /**
   * Who touched this, according to the event that just landed.
   *
   * Our own change is not re-fetched — the stream skips it — so without this the
   * marker on a card would still name the agent after the reader edited the card
   * themselves, which is the one thing attribution must never do.
   */
  function noteAttribution(event) {
    if (!event || !event.entity) return;
    const kind = event.entity.kind;
    if (kind !== 'task' && kind !== 'project') return;
    const key = kind + ':' + event.entity.id;
    const previous = attribution[key] || {};
    attribution[key] = {
      createdBy: previous.createdBy || (event.type === kind + '.create' ? event.actor : null),
      lastActor: event.actor || previous.lastActor || null,
      lastAt: event.at || previous.lastAt || null,
      lastType: event.type || previous.lastType || null,
      lastSeq: event.seq ?? previous.lastSeq ?? null,
    };
  }

  /**
   * Apply our own command's result locally, without a round trip.
   *
   * Returns false when this command's effect is not one the cockpit can reproduce
   * from its payload and the returned value alone — a revert touches records the
   * command never names. The caller then re-reads instead of guessing, because a
   * board that is subtly out of date is worse than one that is briefly late.
   */
  function applyOwn(type, payload, result) {
    const value = result.value;
    if (result.event) noteAttribution(result.event);
    // A command with effects on records OTHER than the one it is named after — a move
    // that renumbered a column, a project delete that orphaned its tasks, an import —
    // has consequences this function cannot reproduce: the siblings' order and
    // revision, and every record's attribution. Reproducing the headline and skipping
    // the stream (our own events are ignored there) left the cockpit quietly stale.
    // At this size the honest answer is to re-read.
    const effects = (result.event && result.event.effects) || [];
    const others = effects.filter((e) => !(e.kind === (result.event.entity || {}).kind && e.id === (result.event.entity || {}).id));
    if (others.length) return false;
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
    } else {
      return false;
    }
    headSeq = Math.max(headSeq, Number(result.seq) || 0);
    writeCache();
    return true;
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
      if (body.changed !== false) {
        // A command the cockpit cannot replay locally (a revert, which touches
        // records the command never named) is re-read rather than guessed at.
        if (!applyOwn(String(env.type || ''), payload, body)) await refresh();
      } else {
        writeCache();
      }
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
      seenSeq = readSeen();
      if (cachedAt) setStatus('connecting', 'showing a cached copy while the service is contacted');
      changed();
      try {
        await establishSession();
        await refresh();
        // A window that has never looked has nothing to catch up ON: "54 changes
        // since you last looked" is not a diff, it is the whole history of the
        // board, and a first visit that opens with it teaches the reader to ignore
        // the line. The watermark starts at the board as it is.
        if (seenSeq) await catchUp(); else { seenSeq = headSeq; writeSeen(); }
        await refreshAgentHour();
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

    // ── Who touched what ─────────────────────────────────────────────────────
    attributionFor: (kind, id) => {
      const entry = attribution[kind + ':' + id];
      return entry ? { ...entry } : null;
    },

    /** "14 edits, 7 moves, 2 deletes" for one actor's entry, biggest first. */
    describeKinds: describeKinds,
    kindParts: kindParts,

    /**
     * The diff since the reader last looked: what moved, how much of it each actor
     * did, and the moment the window starts from.
     *
     * `byActor` is ordered by how much each actor moved, so an agent that has been
     * busy is not buried under a long tail of one-line edits. `since` is returned
     * because an undo has to name the window it covers, and the reader should be
     * looking at the same window the undo will use.
     *
     * `agentsLastHour` is the undo's own question, kept separate because the two
     * windows end at different moments: the diff starts when the reader last looked,
     * and the undo covers a fixed hour back from now.
     */
    activity: () => {
      const group = (events) => {
        const byActor = {};
        let oldest = null;
        events.forEach((event) => {
          const who = event.actor || 'unknown';
          if (!byActor[who]) byActor[who] = { actor: who, count: 0, lastAt: event.at || null, types: {}, kinds: emptyKinds() };
          byActor[who].count += 1;
          byActor[who].lastAt = event.at || byActor[who].lastAt;
          byActor[who].types[event.type] = (byActor[who].types[event.type] || 0) + 1;
          tally(byActor[who].kinds, event.type);
          if (!oldest || event.at < oldest) oldest = event.at;
        });
        return { actors: Object.values(byActor).sort((a, b) => b.count - a.count), oldest };
      };
      const diff = group(recent);
      const hour = group(agentHour.filter((e) => String(e.actor || '').startsWith('agent:')));
      return {
        total: recent.length,
        agents: diff.actors.filter((a) => a.actor.startsWith('agent:')),
        humans: diff.actors.filter((a) => !a.actor.startsWith('agent:')),
        since: diff.oldest,
        agentsLastHour: hour.actors,
        hourStart: new Date(Date.now() - UNDO_WINDOW_MS).toISOString(),
        undoWindowMs: UNDO_WINDOW_MS,
        truncated: truncated,
        seenSeq: seenSeq,
        headSeq: headSeq,
      };
    },

    /** The reader has looked: the diff starts again from here. */
    markSeen() {
      seenSeq = headSeq;
      recent = [];
      writeSeen();
      changed();
    },

    /**
     * Take back what one actor did in a window.
     *
     * `since` is passed in rather than derived so that a dry run and the real thing
     * cover the SAME window — two calls that each computed "the last hour" would
     * drift apart by however long the reader spent reading the confirmation, and the
     * confirmation would then be a description of a different undo.
     *
     * `throughSeq` is the rest of that promise: the sequence the dry run planned
     * against, handed back so the execution is bounded by it. Without it the clock
     * still moves between the two calls: a change made while the confirmation sat
     * open silently joined a set the reader never agreed to.
     */
    revert: (actor, since, dryRun, throughSeq) => command({
      type: 'history.revert',
      payload: {
        actor: actor,
        since: since,
        dryRun: Boolean(dryRun),
        ...(throughSeq === undefined || throughSeq === null ? {} : { throughSeq: throughSeq }),
      },
      commandId: 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    }).then(async (result) => {
      // A revert changes what is left in the hour, so the answer to "is there
      // anything of an agent's in the window" is stale the moment one lands.
      if (result && result.ok && !dryRun) await refreshAgentHour();
      return result;
    }),

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
