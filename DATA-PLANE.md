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
| `GET`/`POST /v1/agents` | list agent credentials; `POST { name }` mints one (operator only) |
| `POST /v1/agents/revoke` | `{ name }` — file, credentials row and cached credential, together (operator only) |
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

### The control plane is the operator's

The creator chose frictionless, so **the data plane is open to every credential**:
create, edit, move, delete — an agent that had to ask would not be one. Four things
are not data, and are refused to an agent with `FORBIDDEN`:

| Act | Why it is not an agent's |
| --- | --- |
| `POST /v1/import`, `/v1/import/inspect` | It writes rows attributed to `migration:localstorage`, which `history.revert` excludes — a door into the board that both attribution and undo look away from. |
| `POST /v1/agents`, `/v1/agents/revoke` | Handing out or taking away authority is not writing a task. |
| `history.revert` for another actor | Rewriting somebody else's history. **An agent may at most revert itself**; the operator may revert anyone. |
| anything else the service later grows that is not a board change | The test is "is this a change to the board", not "is this dangerous". |

Revocation is one call and it is immediate: `POST /v1/agents/revoke` removes the token
file, deletes the `credentials` row and drops the cached credential in the same
request. A token file deleted by hand is also honoured on the next request — the
credential cache re-checks that the file still exists — because a revoked credential
that keeps working until a restart is not revoked.

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
- **`ifRev` is required of an agent** on any command that changes a record which
  already exists: `task.patch`, `task.move`, `task.delete`, `project.archive`,
  `project.restore`, `project.delete`. Missing it is `REV_REQUIRED`; stale is
  `ENTITY_REV_CONFLICT`. This is optimistic concurrency, not permission: a person acts
  on what is on their screen, and so does an agent — except an agent's screen can be an
  hour old, and without this a change computed from a world that no longer exists
  overwrites one that does.

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
  grow every time somebody used it. An agent may only revert **itself**.
- **The set is frozen between the plan and the act.** A dry run answers with the
  sequence it planned against (`throughSeq`), and the execution is given it back. Two
  calls that each computed "the last hour" would let everything that happened while the
  reader was reading the confirmation join a set nobody described. Later *human* edits
  still take part in conflict checking — but a later agent event cannot silently join
  the undo.
- **Compensation is per EFFECT, newest first.** Two agent edits to the same field in a
  row are the normal case, not an edge case; the plan walks every effect of every
  event, and a shadow state records what each record will hold once the plan so far is
  applied — so both the conflict test and the lifecycle branches read the value the
  newer compensation is *about to* put back, not the row as it stands.
- **Lifecycle branches read that shadow state too.** An agent that created a task and
  then deleted it plans restore-then-delete, so the board ends where it started. Reading
  the live rows instead left a task that existed neither before nor after the agent.
- **Conflicts refuse; they never stamp.** If somebody else has changed *the same field*
  since that effect, it is reported in `conflicts` and left alone. Field-aware on
  purpose: a human who renamed a task while the agent was changing its weight has not
  touched anything the compensation would overwrite. Where the whole record is at stake
  — deleting what the agent created, or restoring what it deleted — any foreign touch
  refuses, because what is about to appear or disappear is not one field.
- **Deletes are recoverable.** `task.delete` and `project.delete` keep the whole record
  in the effect, so it comes back with its id, its `createdAt`, its unknown fields and
  the creator it had.
- **`dryRun: true`** returns the same report without writing. The cockpit's
  confirmation is produced by this call, so the sentence describing the undo and the
  undo itself are the same code.
- The revert is itself an event with effects, attributed to whoever asked for it, so
  the log says who undid what and the undo can be undone in turn. Re-running an undo
  that already happened refuses rather than re-applying: the earlier revert is a
  foreign event like any other.

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
`RUN_ALREADY_LOCKED`, `RUN_MEMBER_LOCKED`, `RUN_LOCKED`, `ACTOR_MISMATCH`,
`REV_REQUIRED`, `FORBIDDEN`, `WRITE_FAILED`.

### The locked plan is the service's rule, not the cockpit's

A locked run freezes a plan, and the cockpit has always enforced that by disabling
things: planned cards are not draggable, their weight steppers are disabled, drops into
Running are refused. That made the rules *gestures* rather than rules — an agent with a
token could change a member's weight, walk a member out of the running column, fill the
column with newcomers, or delete the last member and leave a plan with nobody in it.
Both clients answer to the service now:

- Changing the **weight** of a planned member → `RUN_MEMBER_LOCKED`.
- Moving a planned member **out of** the running column → `RUN_MEMBER_LOCKED`.
- Moving anything else **into** the running column while a run is locked → `RUN_LOCKED`.
- Reordering a member *within* the column stays allowed: it does not touch the frozen
  plan, and the plan snapshots its own order.
- Deleting the last member **ends the run**, and the delete event names the run it
  ended — so the undo puts both back rather than leaving a plan with nobody in it.

Each carries `message` (a sentence for the reader) and `details` (fields for a
client). The cockpit prevalidates for feel; the refusal is authoritative.

### Events

Every committed command writes its state change, its command row and its event in one
transaction. The event carries a monotonic `seq`, the time, the type, the command id,
the actor, the client, the entity, and before/after values. A creation is revision 1;
everything else moves the revision on by one.

### Effects: what an event actually did

An event used to name one entity and hope. A `task.move` renumbered every sibling in
the destination column and said nothing about them; a `project.delete` orphaned a dozen
tasks silently. Compensation then had to *infer* those effects, and the inference was
wrong exactly where it mattered — an undo could drag a task back into a project the
human had since moved it out of, or renumber a column away from the values it had just
restored.

So every event carries `effects_json`: the list of records it touched, each with one of
three ops.

| op | before / after | taken back by |
| --- | --- | --- |
| `create` | `null` / the whole record | deleting the record |
| `delete` | the whole record / `null` | restoring it, with its id, `createdAt` and unknown fields |
| `update` | the CHANGED FIELDS only | putting those fields back |

Handlers describe their own effects — a move names the siblings it renumbered, a
project delete names every task it orphaned, a layout pass names each task whose row
moved, and deleting the last member of a locked plan names the run that ended with it.
A handler that describes nothing gets the single obvious effect, so a new command is
attributable and revertible by default rather than by memory.

Three things read that list and nothing else:

- **Attribution** — every record in it is stamped, in the same transaction.
- **Revisions** — every `update` effect's record has its revision moved on. A sibling
  renumbered by somebody else's move used to change with no revision movement at all,
  which is precisely the change an `ifRev` is supposed to catch.
- **Undo** — conflict checking and compensation both walk effects, so "did anyone else
  touch this field" is answerable for a record the event never named.

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
agent" without being asked. Three places do it:

- **On the card.** A task an agent created or last changed carries one short line
  naming it (`◆ scout changed this`), from `board.attribution`. One line, not a badge
  per change: the card is the record, and the record has one most-recent author. The
  cockpit updates this from the event its own command returns, because the stream
  skips a window's own changes — without that, a marker would still name the agent
  after the reader had edited the card themselves, which is the one thing attribution
  must never do.
- **In the shell, on every route** — a handle that names the busiest agent in the last
  hour and opens a panel of **what kind of work** it did: `9 changes — 3 new, 2 edits,
  2 moves, 1 delete, 1 plan change · last 5m ago`, with deletes marked in the danger
  colour wherever they appear. Counting is not summarising: "23 changes" does not tell
  the creator whether their coworker spent the hour tidying or deleting. It is on every
  route because attribution is the FIRST line of defence — the creator standing on the
  Hub, watching the portfolio, is exactly who needs it — while the board's own line
  exists only where the board does.
- **On the activity line**, above the board: a **diff, not a notification centre**.
  Nothing is delivered and nothing expires. It counts what moved since this window
  last looked, per actor; the watermark (`proxima.seen.v1`) is this window's, and
  `Mark as seen` moves it. The SSE stream and a `GET /v1/log?after=` catch-up at boot
  both feed it — **in pages**, and if the paging bound is ever reached the line says
  how many it did not read rather than reporting a quiet hour.

Each agent named in either place is a handle: `Revert scout's last hour` dry-runs the
revert, states exactly what will be put back and what will be refused (naming the
fields), and only then does it. The button carries **no number** — the honest count
only exists after the dry run, and a button that promised three and took back nine
would make the reader distrust every number on the page. Both calls share one window
AND one `throughSeq`, computed once, so neither the reader's reading time nor a busy
agent can change what the confirmation described.

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
node service/proxima-client.mjs agents [add <name> | revoke <name>]
node service/proxima-client.mjs raw <type> '<json payload>' [--ifRev <n>]
```

**Who you are comes from which token file is read**, never from a flag: `--as scout`
reads `<home>/agents/scout.token` and the service decides who that is. There is no
`--token` and there will not be: a command line is visible in the process table, and
a per-agent credential exists so that it is not something anyone waves around.

**Mutations of an existing record read first, then act** — `patch`, `move`, `delete`,
`archive`, `restore` and `project delete` all fetch the revision they are acting on
and send it as `ifRev`. That is the same requirement the service puts on an agent
(`REV_REQUIRED`), done for the caller so the honest path is the easy one.

---

## What is not built, and why that is next

- **Per-operation permission policy.** Agents may write anything the vocabulary can
  write — the creator chose frictionless, and what stands in for a policy is
  attribution, `ifRev` and undo. The control plane (import, credentials, reverting
  somebody else) is the operator's; see above. A second *human* is still open.
- **Compaction.** The log keeps everything; `RESYNC_REQUIRED` is implemented for the
  day it does not.
- **Attachments.** The table exists; nothing writes to `files/` yet, because file
  content is canonical as files and Proxima links to them.
- **Offline writes.** Deliberately absent. A queue would be a second board.
- **Multi-device.** Nothing here assumes one machine, but nothing tests two either.
- **Sharing.** No second human exists in this store, and no policy decides what one
  might do.
