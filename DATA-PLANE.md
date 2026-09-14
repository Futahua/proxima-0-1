# The data plane

What owns the data, what changes it, and what is still open. Written as slice 2
landed, so that the next person starts from a document rather than a chat log.

---

## Why any of this exists

The board used to live in `localStorage` on one browser origin. Three consequences,
all observed rather than imagined:

- **Nothing outside the tab could reach it.** An agent had nowhere to write.
- **Papers and the dev server held different boards.** Same code, different origin.
- **A browser profile change emptied the bucket.** It happened once and took the
  fixtures with it. The app had no `removeItem` and no `clear()`; it simply could not
  stop it.

The creator's goal is agentic: *agents edit the files, Proxima is the cockpit*, and
*a backpack is a cockpit you can throw away and rebuild; the data is what persists*.
A store reachable only from inside one tab cannot deliver that. So the data moved out
of the browser entirely.

### A creator decision, recorded

**Structured task and project data is not human-editable files.** Files stay
canonical for *file content* — opened in their own apps, linked from Proxima — and
the service is canonical for structured facts. There is no YAML round-tripping to
design toward, no comment preservation problem, and no watcher to reconcile.

---

## What exists now

`proximad` — one dependency-free Node program (`service/proximad.mjs`) owning a
**Proxima Data Home**:

```
<home>/
  proxima.db      SQLite, WAL, one writer (the service)
  token           the operator's token, mode 0600, never given to a browser
  agents/<n>.token  one token per agent, mode 0600, read from disk by that agent
  instance.json   the instance marker (instanceId, schema, home)
  files/          content depot (empty; file content is canonical AS files)
  backups/        exact bytes of everything imported, named by origin and time
```

The home defaults to `%USERPROFILE%\Proxima Data Home` — not in a browser profile,
not in Papers, not in the source tree — and is moved with `--home` or
`PROXIMA_HOME`. In this workspace it runs from `D:\Letters\MatTroiSeConMoc\Proxima
Data Home` because the sandbox cannot write to the user profile.

```
node service/proximad.mjs [--home <dir>] [--port 4181] [--host 127.0.0.1]
                          [--allow-origin <origin>]... [--quiet]
```

It serves the cockpit from its own port, so UI and API are same-origin in the real
build. Nothing else opens the database for writing: if a client could, the command
and audit layer would be bypassed the first time it was convenient.

### Tables

`projects`, `tasks`, `runs`, `run_members`, `commands`, `events`, `proposals`,
`actors`, `credentials`, `preferences`, `attachments` — plus `meta` (schema version,
instance) and `origins` (which browsers have been imported, and what was archived for
each; the brief's migration rules cannot be kept without it).

Typed columns for the fields the vocabulary understands, and `extra_json` for
everything else, because the store has always kept fields it does not recognise and
SQLite must not be the thing that loses them. `proposals` and `attachments` are
created empty and unused: they cost nothing now, and their absence would force a
schema change the first time either lands.

### The API

| Endpoint | What it is for |
| --- | --- |
| `GET /` | the cockpit, served from the service |
| `GET /v1/health` | instance, schema version, head sequence, data home |
| `GET /v1/snapshot` | `{ schemaVersion, headSeq, board }` — board carries `attribution` |
| `POST /v1/commands` | one command: the envelope below, the same refusals back |
| `GET /v1/events?after=N` | server-sent events; resumes from `Last-Event-ID` |
| `GET /v1/log` | the log as JSON: `?after=<seq>` (a watermark) or `?since=<iso>` (a time), plus `?actor`, `?limit` |
| `GET`/`POST /v1/agents` | list agent credentials; `POST { name }` mints one |
| `POST /v1/session` | mint the cockpit's session cookie |
| `GET`/`PUT /v1/preferences/:client` | how a cockpit looks |
| `POST /v1/import/inspect` | what a legacy store would bring, and what conflicts |
| `POST /v1/import` | archive the bytes, then import them |
| `GET /v1/imports` | what has been imported, from where, and what was archived |

`/v1/log` answers two different questions with two different bounds, and neither
substitutes for the other: `after` is "everything since the last thing I read" (how a
cockpit catches up after being closed) and `since` is "what happened in this window of
clock time" (how the undo control asks what an agent did in the last hour). Asking the
second with a sequence number would mean inventing a mapping between sequences and time
that only the log itself knows.

SSE rather than WebSocket: the traffic is almost all server to client, commands
already ride ordinary HTTP, and reconnection with `Last-Event-ID` comes free. Frames
are **unnamed** (`data:` with no `event:` line) on purpose — a named frame only
reaches listeners registered for that exact name, and a cockpit cannot enumerate a
vocabulary that grows. The type travels inside the JSON. `RESYNC_REQUIRED` exists for
a client asking for a sequence that has been compacted away; nothing is compacted
yet, so it is implemented and unreachable.

### Trust

The socket binds to loopback, and that is the boundary: anything that can reach it is
running as this user on this machine. Three doors through it:

- **A per-agent bearer token** in `<home>/agents/<name>.token`, created 0600. Each
  agent has its own, so revoking one is deleting one file and the log can say which
  agent did what. It never goes near a browser and never enters `localStorage`.
- **The operator's token** in `<home>/token`, for `human:minh` from a shell.
- **A session cookie**, HttpOnly, minted by `POST /v1/session` against a one-time
  nonce injected into the cockpit's HTML as the service serves it. The cockpit's own
  JavaScript never holds a token, so a browser compromise cannot leak one, and a page
  on another origin cannot mint a session without the nonce.

**The actor comes from the credential, never from the request body.** `authorised()`
resolves a token or a session to an actor, and `runCommand` refuses `ACTOR_MISMATCH`
when the envelope claims a different one. A request body is a claim; a token is
evidence. This matters more here than it would in a system with an approval step: the
log is the whole safety net, and an event log whose actor can be set by whoever is
calling proves nothing. A token is read from a file, never passed on a command line —
a command line is visible in the process table.

A cockpit served from somewhere else (a dev static server) is trusted by naming its
origin at startup: `--allow-origin http://127.0.0.1:4180`. Without that flag the
cockpit must be served by the service itself. On Windows the 0600 mode is advisory —
NTFS ACLs are the real control — which is why the loopback boundary is stated rather
than assumed.

---

## The command vocabulary

```
{ type, payload, commandId, ifRev, actor, client }
```

- `commandId` — idempotency key. **Stored**, in the `commands` table, which is what
  makes a replay safe across a restart rather than only within one session. A
  different payload under the same id is `COMMAND_ID_CONFLICT`. A *refused* command
  does not spend its id: nothing happened, so a corrected retry is a fresh attempt,
  not a replay. That distinction was a real bug in slice 1 and is the thing to keep
  in mind once commands cross a network.
- `ifRev` — the revision the caller believed the entity was at. A mismatch is
  `ENTITY_REV_CONFLICT` and nothing is written. Absent means "not racing anybody".
- `actor`, `client` — `human:minh`, `agent:scout`, `migration:localstorage`. The
  window part matters: two tabs of one cockpit share the cockpit id, and a client that
  treated their events as its own would never see the other tab's changes. **A client
  cannot choose its actor**: it is resolved from the token or the session, and a
  mismatch is `ACTOR_MISMATCH`. A session may name its `client`; a bearer token's
  client is fixed by the credential.

| Command | Payload | Notes |
| --- | --- | --- |
| `task.create` | `{ name, note?, project?, status?, weight?, start?, deadline?, ganttRow? }` | `start` defaults to today; the task lands last in its column. |
| `task.patch` | `{ taskId, patch: { … } }` | **Refuses `status`** and points at `task.move`; refuses `createdAt` and `id` outright. Unknown keys are kept in `extra_json`. |
| `task.move` | `{ taskId, toStatus, beforeTaskId }` | **`beforeTaskId`, never an index.** "Move X before Y" survives replay and concurrent clients; "set order = 12" does not. `null` means the end of the column. |
| `task.layout` | `{ rows: [{ taskId, ganttRow }] }` | One command per render pass. Unknown ids are skipped and reported, because a pass can race a delete. |
| `task.delete` | `{ taskId }` | |
| `project.create` / `archive` / `restore` / `delete` | `{ name, description? }` / `{ projectId }` | Delete orphans its tasks (they become uncategorised) and names them in the event. It never deletes work. |
| `run.lock` | `{ target, taskIds }` | The client says **which** tasks and until when; the service computes the frozen plan from its own rows. |
| `run.unlock` | `{}` | Ending an ended run is success with `changed: false`. |
| `history.revert` | `{ actor, since?, until?, dryRun? }` | Take back what ONE actor did in a window. Defaults to the last hour. See below. |
| `proposal.accept` | — | Refused, permanently: the creator chose frictionless, so there is no approval queue to accept into. |

### Undo: `history.revert`

This is the safety net, not a nicety. An agent writes directly and without asking, so
the two things standing between a bad minute and a bad board are **attribution** (who
did it, on the record) and **this** (take it back). It reads the *event log* rather
than diffing the rows, because the log is the only place that remembers what the
values were before.

- **Selection** is by actor and time window: `actor` is required, `since`/`until`
  default to the last hour. `history.revert` and `migration.*` events are excluded —
  undoing the agent's work is not more agent work, and counting it would make the line
  grow every time somebody used it.
- **Compensation is per event, in reverse order**, not per record. Two agent edits to
  the same field in a row are the normal case; stopping after the newest one would
  leave the older edit in place, which is not what "revert what the agent did" means.
  Because the plan is built newest-first and applied newest-first, an older change is
  checked against the value the newer compensation is *about to* put back, not against
  the rows as they stand.
- **Conflicts refuse; they never stamp.** If somebody else has changed *the same field*
  since that event, that change is reported in `conflicts` and left alone — reverting
  over a person's edit would destroy work they can see, which is worse than not
  reverting. The test is field-aware on purpose: a human who renamed a task while the
  agent was changing its weight has not touched anything the compensation would
  overwrite. Where the whole record is at stake — taking back a creation, which means
  deleting it — any foreign touch refuses, because what is about to disappear is not
  one field.
- **Deletes are recoverable.** `task.delete` and `project.delete` keep the whole record
  in `before`, so the record comes back with its id, its `createdAt` and its unknown
  fields, at revision + 1.
- **`dryRun: true`** returns the same report without writing. The cockpit's
  confirmation is produced by this call, so the sentence describing the undo and the
  undo itself are the same code — a separate "what would happen" implementation could
  disagree with the real one, and the disagreement would show up after the fact.
- The revert is itself an event, attributed to whoever asked for it, so the log says
  who undid what and the undo can be undone in turn.
- The report is `{ considered, willRevert, reverted?, conflicts, skipped }`, each entry
  naming the sequence, the entity and the reason.

### Results

```
{ ok: true,  commandId, seq, rev, changed, value, replayed?, event? }
{ ok: false, commandId, code, message, details }
```

Resolves — never rejects — so a caller has one thing to handle, and the same shape
arrives whether it came over HTTP or (in slice 1) from memory. `changed: false` means
accepted with nothing to do: no event, no revision, no new sequence number.

### Refusal codes

`COMMAND_UNKNOWN`, `COMMAND_NOT_IMPLEMENTED`, `PAYLOAD_INVALID`,
`COMMAND_ID_CONFLICT`, `ENTITY_NOT_FOUND`, `ENTITY_REV_CONFLICT`, `NAME_REQUIRED`,
`DATE_INVALID`, `DEADLINE_BEFORE_START`, `WEIGHT_INVALID`, `STATUS_UNKNOWN`,
`PROJECT_NOT_FOUND`, `GANTT_ROW_INVALID`, `FIELD_NOT_PATCHABLE`,
`MOVE_ANCHOR_NOT_IN_COLUMN`, `RUN_HAS_NO_MEMBERS`, `RUN_TARGET_INVALID`,
`RUN_ALREADY_LOCKED`, `ACTOR_MISMATCH`, `WRITE_FAILED`.

Each carries `message` (a sentence for the reader) and `details` (fields for a
client). The cockpit prevalidates for feel; the refusal is authoritative.

### Events

Every committed command writes its state change, its command row and its event in one
transaction. The event carries a monotonic `seq`, the time, the type, the command id,
the actor, the client, the entity, and before/after values. A creation is revision 1;
everything else moves the revision on by one.

### Attribution

`tasks` and `projects` carry `created_by`, `last_actor`, `last_at`, `last_type`,
`last_seq`. They are maintained **inside the command transaction** — the same
transaction as the change itself — so there is no window in which a change exists
without a record of who made it, and they survive a restart. They are exposed as
`snapshot().board.attribution`, keyed `task:<id>` and `project:<id>`.

Derived columns rather than provenance inside the entity: an entity is what the
creator wrote, and provenance is a fact *about* it. A command with collateral effects
names them (`orphanedTaskIds`, and the revert's `attributes`), and those records are
attributed too — otherwise a task orphaned by a project delete, or put back by a
revert, would look untouched by the command that moved it.

---

## The cockpit's side

`public/store.js` is a client. It holds the last snapshot in memory so reads stay
synchronous (a renderer should not await), mirrors that snapshot into a **read-only**
cache under `proxima.cache.v1` so a launch paints before the service answers, and
subscribes to the event stream. An event this window did not cause triggers a
re-fetch of the snapshot — cheaper than reasoning about a renumbered column, and
impossible to get subtly wrong at this size.

**The rule that matters: after migration the cockpit never writes board data to the
browser again.** Not on failure, not as a fallback. If the service cannot be reached
it says so, on the page, in a sentence: *the board is a read-only copy from <time>;
nothing you change here will be saved, and nothing has been written to this browser*.
A local write is how two boards start disagreeing, which is the failure this whole
design exists to escape. The cockpit keeps trying quietly every few seconds, and the
banner is also a retry button.

Cockpit preferences — panel composition, timeline zoom — are device state, not board
data: they live locally for immediate use and are mirrored to the service's
`preferences` table per client, so a wiped browser profile stops costing the reader
their layout. The route and the Daily lens are pure view state and are stored nowhere.

### Seeing what an agent did, and taking it back

Because there is no approval step, the board has to answer "was this a person or an
agent" without being asked. Two places do it:

- **On the card.** A task an agent created or last changed carries one short line
  naming it (`◆ scout changed this`), from `board.attribution`. One line, not a badge
  per change: the card is the record, and the record has one most-recent author. The
  cockpit updates this from the event its own command returns, because the stream
  skips a window's own changes — without that, a marker would still name the agent
  after the reader had edited the card themselves, which is the one thing attribution
  must never do.
- **On the activity line**, above the board: a **diff, not a notification centre**.
  Nothing is delivered and nothing expires. It counts what moved since this window
  last looked, per actor; the watermark (`proxima.seen.v1`) is this window's, and
  `Mark as seen` moves it. The SSE stream and a `GET /v1/log?after=` catch-up at boot
  both feed it, so a change made while the page is open appears without a reload.

Each agent named on that line is a handle: `Revert scout's last hour` dry-runs the
revert, states exactly what will be put back and what will be refused (naming the
fields), and only then does it. The button carries **no number** — the honest count
only exists after the dry run, and a button that promised three and took back nine
would make the reader distrust every number on the page. Both calls share one
`since`, computed once, so the reader's own reading time cannot shrink the window
between the promise and the act. The line stays while an agent has been active in the
last hour even if the reader has acknowledged everything, so the undo does not
disappear with the diff.

### Migration

On first connection to an empty service the cockpit shows **what it found** (counts of
tasks, projects, and whether a run is active) and asks. It does not adopt whichever
origin connects first.

- The exact bytes are archived into `backups/` **before** anything is written, under a
  name that says which origin and when (`http-127-0-0-1-4180-20260914-021937.json`
  plus a `.meta.json` with the sha256 and counts).
- The import runs as actor `migration:localstorage`, preserving ids, `createdAt`,
  unknown fields, run snapshots, gantt rows, weights and order — and produces a report
  rather than dropping anything quietly.
- Records that cannot be read are **rescued, not refused**: an impossible date becomes
  today, an unknown status becomes Backlog, a dangling project reference reads as
  uncategorised. Refusal is for new writes; rescue is for old bytes.
- A **second origin** later gets `inspect` first: same id and same contents
  deduplicates, same id and different contents is an explicit conflict that is
  **never** imported, different ids import both. Two old boards are never merged by
  last-write-wins.
- **The browser copy is left exactly where it was.** Nothing deletes it.

---

## The agent's side

`service/proxima-client.mjs` is the entry point, and it is a command rather than a
proof of transport:

```
node service/proxima-client.mjs whoami
node service/proxima-client.mjs list [--status backlog] [--project <id>]
node service/proxima-client.mjs show <taskId>
node service/proxima-client.mjs create "<name>" [--status running] [--weight 3] [--note "…"]
node service/proxima-client.mjs patch <taskId> <field> <value>
node service/proxima-client.mjs move <taskId> <status> [beforeTaskId]
node service/proxima-client.mjs delete <taskId>
node service/proxima-client.mjs lock <YYYY-MM-DDTHH:MM> <taskId>…  |  unlock
node service/proxima-client.mjs log [--since <iso>] [--actor <actor>] [--limit 50]
node service/proxima-client.mjs activity [--hours 1]
node service/proxima-client.mjs undo --actor agent:scout [--hours 1] [--dry-run]
node service/proxima-client.mjs agents [add <name>]
node service/proxima-client.mjs raw <type> '<json payload>'
```

**Who you are comes from which token file is read**, never from a flag: `--as scout`
reads `<home>/agents/scout.token` and the service decides who that is. A token on a
command line would be visible in the process table.

---

## What is not built, and why that is next

- **Per-operation permission policy.** An agent may do anything the vocabulary can do.
  There is no "this agent may not delete" — the creator chose frictionless, and the
  answers that exist instead are attribution and undo. A second *human*, and the
  question of what an agent may do that a human may not, is still open.
- **Compaction.** The log keeps everything; `RESYNC_REQUIRED` is implemented for the
  day it does not.
- **Attachments.** The table exists; nothing writes to `files/` yet, because file
  content is canonical as files and Proxima links to them.
- **Offline writes.** Deliberately absent. A queue would be a second board.
- **Multi-device.** Nothing here assumes one machine, but nothing tests two either.
- **Sharing.** No second human exists in this store, and no policy decides what one
  might do.
