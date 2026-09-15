-- proximad schema. Applied on every start; every statement is idempotent.
--
-- Two conventions worth knowing before reading a table:
--
--   * Typed columns for the fields the vocabulary understands, plus `extra_json`
--     for everything else. The cockpit's store has always kept fields it does not
--     recognise, and losing them on the way into SQLite would be a silent data
--     loss in the one place this project has decided must never have one.
--
--   * `rev` on every entity: the revision `ifRev` is checked against. A mismatch
--     is refused, never merged, because "last write wins" across two cockpits is
--     how one of them silently loses its work.
--
-- `proposals` and `attachments` are created empty and unused. They cost nothing
-- now and their absence would force a schema change the first time either lands.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  archived_at TEXT,
  -- A project can BE a place on this machine — a folder of the creator's own work
  -- that Proxima links to and never copies. `link_path` is the absolute path, and
  -- `link_kind` says how to open it ('folder' today). The contents stay where they
  -- are: this is a pointer, and the row must not become a cache of them.
  link_kind   TEXT,
  link_path   TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  extra_json  TEXT NOT NULL DEFAULT '{}'
);

-- The creator's calendar: one row per occurrence, imported from the vault that the
-- Obsidian plugin wrote. It is NOT the same thing as the `events` table below, which
-- is the audit log — hence the different name.
--
-- Times are instants (ISO 8601 with an offset), not days: a schedule entry has a
-- start and an end, where a task has a start day and a deadline day. `occurrence_of`
-- and the recurrence columns are kept as the source stated them; nothing here expands
-- a recurrence, because an expansion is a decision the source never made.
CREATE TABLE IF NOT EXISTS schedule_events (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  note                  TEXT NOT NULL DEFAULT '',
  project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL,
  start_at              TEXT,
  end_at                TEXT,
  completed             INTEGER NOT NULL DEFAULT 0,
  color                 TEXT,
  recurrence            TEXT,
  recurrence_until      TEXT,
  recurrence_exceptions TEXT,
  recurrence_days       TEXT,
  occurrence_of         TEXT,
  -- Where this row came from, exactly as the source named it: the vault-relative
  -- path of the file it was read from. Provenance is what makes an import auditable
  -- rather than a claim.
  source_ref            TEXT,
  created_at            TEXT NOT NULL,
  rev                   INTEGER NOT NULL DEFAULT 1,
  extra_json            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS schedule_events_start   ON schedule_events(start_at);
CREATE INDEX IF NOT EXISTS schedule_events_project ON schedule_events(project_id);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  -- NULL means uncategorised. Deleting a project sets this to NULL rather than
  -- deleting the work inside it.
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status       TEXT NOT NULL,
  weight       INTEGER NOT NULL,
  start_day    TEXT NOT NULL,
  deadline_day TEXT,
  gantt_row    INTEGER,
  order_index  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  rev          INTEGER NOT NULL DEFAULT 1,
  extra_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_status  ON tasks(status, order_index);

-- One run at a time, which is what the cockpit has always meant by "the run".
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  locked_at  TEXT NOT NULL,
  target     TEXT NOT NULL,
  total      REAL NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 1,
  extra_json TEXT NOT NULL DEFAULT '{}'
);

-- The frozen plan. Weights, durations and slot boundaries are copied here at lock
-- time and never re-derived: that snapshot is what makes a lock mean anything, and
-- re-deriving it from live tasks is the bug the snapshot exists to prevent.
CREATE TABLE IF NOT EXISTS run_members (
  run_id    INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id   TEXT NOT NULL,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  weight    INTEGER NOT NULL,
  duration  REAL NOT NULL,
  starts_at REAL NOT NULL,
  ends_at   REAL NOT NULL,
  PRIMARY KEY (run_id, task_id)
);

-- Commands are STORED, not merely applied. This table is what makes idempotency
-- real across a restart rather than only within one session: a client that retries
-- a command after the service bounced gets the original answer, not a second task.
CREATE TABLE IF NOT EXISTS commands (
  command_id     TEXT PRIMARY KEY,
  seq            INTEGER NOT NULL,
  type           TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  actor          TEXT NOT NULL,
  client         TEXT NOT NULL,
  at             TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  result_json    TEXT NOT NULL
);

-- The audit trail. `seq` is monotonic and gap-free because it is assigned inside
-- the same transaction as the change it describes.
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  type        TEXT NOT NULL,
  command_id  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  client      TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  extra_json  TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);

-- Empty and ready. `proposal.accept` refuses COMMAND_NOT_IMPLEMENTED until there
-- is a policy for what an agent may do that a human may not.
CREATE TABLE IF NOT EXISTS proposals (
  id           TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor        TEXT NOT NULL,
  client       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open',
  decided_at   TEXT,
  decided_by   TEXT,
  note         TEXT
);

-- Actors are recorded, not authenticated. `migration:localstorage` is an actor;
-- so is `human:minh`. When there is more than one human this becomes a real table
-- with rows rather than a convention.
CREATE TABLE IF NOT EXISTS actors (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Credentials: the root token's hash lives here so a leaked file can be rotated
-- without losing the record of what it was.
CREATE TABLE IF NOT EXISTS credentials (
  id           TEXT PRIMARY KEY,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  note         TEXT
);

-- Cockpit preferences: how a cockpit LOOKS, not what the board holds. Keyed by
-- client so Papers and a laptop can differ, and stored here rather than in a
-- browser profile so a profile wipe stops costing the reader their layout.
CREATE TABLE IF NOT EXISTS preferences (
  client     TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client, key)
);

-- Content lives in the files/ depot; this is the index of it. Nothing writes here
-- yet: file content is canonical as files, and Proxima links to them.
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  path        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);

-- Not in the brief's list, and needed by it: "if a second origin connects later
-- with its own store, offer compare / import / keep-as-archive" requires knowing
-- which origins have already been seen, what was archived for each, and when. The
-- archive file itself is the record of the bytes; this is the record of the
-- decision.
CREATE TABLE IF NOT EXISTS origins (
  origin       TEXT PRIMARY KEY,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  imported_at  TEXT,
  archive      TEXT,
  counts_json  TEXT,
  conflicts    INTEGER NOT NULL DEFAULT 0
);
