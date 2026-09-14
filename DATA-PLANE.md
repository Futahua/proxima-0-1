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
  token           the bearer token for agents, mode 0600, never given to a browser
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
| `GET /v1/snapshot` | `{ schemaVersion, headSeq, board }` |
| `POST /v1/commands` | one command: the envelope below, the same refusals back |
| `GET /v1/events?after=N` | server-sent events; resumes from `Last-Event-ID` |
| `POST /v1/session` | mint the cockpit's session cookie |
| `GET`/`PUT /v1/preferences/:client` | how a cockpit looks |
| `POST /v1/import/inspect` | what a legacy store would bring, and what conflicts |
| `POST /v1/import` | archive the bytes, then import them |
| `GET /v1/imports` | what has been imported, from where, and what was archived |

SSE rather than WebSocket: the traffic is almost all server to client, commands
already ride ordinary HTTP, and reconnection with `Last-Event-ID` comes free. Frames
are **unnamed** (`data:` with no `event:` line) on purpose — a named frame only
reaches listeners registered for that exact name, and a cockpit cannot enumerate a
vocabulary that grows. The type travels inside the JSON. `RESYNC_REQUIRED` exists for
a client asking for a sequence that has been compacted away; nothing is compacted
yet, so it is implemented and unreachable.

### Trust

The socket binds to loopback, and that is the boundary: anything that can reach it is
running as this user on this machine. Two doors through it:

- **A bearer token** in `<home>/token`, created 0600, for agents and curl. It never
  goes near a browser and never enters `localStorage`.
- **A session cookie**, HttpOnly, minted by `POST /v1/session` against a one-time
  nonce injected into the cockpit's HTML as the service serves it. The cockpit's own
  JavaScript never holds a token, so a browser compromise cannot leak one, and a page
  on another origin cannot mint a session without the nonce.

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
- `actor`, `client` — `human:minh` and `cockpit#window`. The window part matters: two
  tabs of one cockpit share the cockpit id, and a client that treated their events as
  its own would never see the other tab's changes.

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
| `proposal.accept`, `history.revert` | — | Named in the destination, not served: `COMMAND_NOT_IMPLEMENTED`, with the slice they belong to. |

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
`RUN_ALREADY_LOCKED`, `WRITE_FAILED`.

Each carries `message` (a sentence for the reader) and `details` (fields for a
client). The cockpit prevalidates for feel; the refusal is authoritative.

### Events

Every committed command writes its state change, its command row and its event in one
transaction. The event carries a monotonic `seq`, the time, the type, the command id,
the actor, the client, the entity, and before/after values. A creation is revision 1;
everything else moves the revision on by one.

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

## What is not built, and why that is next

- **Actor identity.** `human:minh` is stated by the cockpit and `agent:headless` by
  the client library. The service records what it is told. A second human, and the
  question of what an agent may do that a human may not, is what `proposal.accept`
  exists to answer.
- **Compaction.** The log keeps everything; `RESYNC_REQUIRED` is implemented for the
  day it does not.
- **Attachments.** The table exists; nothing writes to `files/` yet, because file
  content is canonical as files and Proxima links to them.
- **Offline writes.** Deliberately absent. A queue would be a second board.
- **Multi-device.** Nothing here assumes one machine, but nothing tests two either.
