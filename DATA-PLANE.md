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

An archive's name is `<origin>-<YYYYMMDD-HHMMSS-mmm>-<command>-<sha8>-<nonce>.json`, and it
is created with `wx`. The instant is to the millisecond, and it is not the only thing
keeping two archives apart: the command id (or a random nonce when there is none) and the
SHA-256 of the bytes are in the name too. The name used to be `<origin>-<YYYYMMDD-HHMMSS>`
and the write was an ordinary one, so two imports of the same origin inside one second
silently became one file — the second replaced the first, and nothing said so. Now a name
that is somehow taken fails the create instead of overwriting it, and the writer takes a
fresh nonce and tries again, reporting the retry rather than hiding it.

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

### The control plane is gone, and that is the decision

The creator's policy is one user, one machine, no security constraint between the
credentials, and agents that write directly. The round before this one answered the
review by forbidding an agent the control plane; that was half a policy, and the
reviewer was right that it was the worst half — import was refused to an agent while
writing rows into the log under an actor no undo could reach.

So there are no permission guards left. What replaced them is the thing they were
standing in for:

| Act | Now |
| --- | --- |
| Import | A command (`import.legacy`) with the caller's actor, one event and one `create` effect per record — attributed and revertible like anything else. `POST /v1/import` is a thin door onto it. |
| Minting and revoking credentials | Open to every credential. Identity is still the credential, which is not a permission: it is what makes attribution possible. |
| `history.revert` for another actor | Allowed, and the revert is itself an effect-bearing event — so an undo can be undone. |

`migration.*` events stay out of revert selection: they predate the command path and
belong to an actor that no longer exists. A revert that changed nothing stays out too —
there is nothing there to revert.

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
  sequence it planned against (`throughSeq`), and the execution is given it back —
  from the CLI and from the cockpit, which hand back the same number. Two calls that
  each computed "the last hour" would let everything that happened while the reader was
  reading the confirmation join a set nobody described.
- **Everything outside the frozen set is foreign, including the same actor.** Shadow
  planning covers the actor's own events *inside* the plan; an event of theirs after
  `throughSeq` is outside what the reader agreed to, and treating it as their own would
  let a record-destructive compensation delete a record out from under an edit made
  while the confirmation was on screen.
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

### The calendar, and the projects that are places

Two things arrived with the vault import, and neither is a task.

**`schedule_events`** — the creator's calendar, one row per entry the Obsidian plugin
wrote. It is a *separate table from `tasks` on purpose*: a schedule entry is an instant
with a duration, a task is a piece of work with a share of a run, and filing one as the
other would put an appointment in a column it has no place in. Times are instants
(`start_at`, `end_at`), never days. `recurrence`, `recurrence_until`,
`recurrence_exceptions`, `recurrence_days` and `occurrence_of` are kept **as the source
stated them** — nothing expands a recurrence, because an expansion is a decision the
source never made and a calendar that invents occurrences is a calendar that lies.
`source_ref` records the file each row came from, so an import is auditable rather than
a claim. It is exposed as `board.schedule` and it is **read-only**: there is no command
that creates or edits one yet, and the page says so instead of offering controls that
would refuse.

**Project links** — a project can BE a place on this machine. `projects.link_kind` and
`projects.link_path` hold that, and the row is a *pointer*: nothing inside the folder is
copied, parsed or counted. On a backpack page the link is opened by asking **Papers**,
which is the only thing in the arrangement allowed to open anything:

```
papers:project:as-you-go-load               -> the shortcuts Papers will open, with targets
papers:project:as-you-go-launch {actionId}  -> the machine's own handler: Explorer, or
                                               whatever application owns the file
```

The shortcut is matched **by target**, not by a name this app invented: a link is
openable while its path is one of Papers' declarations. `actions.json` beside
`project.json` is where those declarations ship. When Papers has no shortcut for a path
— or when the page is not inside Papers at all — the link says exactly that and prints
the path rather than pretending it opened something.

### Importing a vault

`vault.import` takes the bytes of every source file and the list of project folders, and
it is shaped by four rules:

1. **The source is archived before anything is written.** One bundle in `backups/`, with
   a SHA-256 per file, written outside the transaction and before the first row — an
   import that cannot be undone is not an import, it is a move. (This is why a second
   import of the same vault still writes an archive: what was *offered* is worth recording
   even when nothing was taken. An import that is *refused* archives nothing, because
   nothing was going to be written in the first place.)
2. **Ids and dates are preserved.** `event-1780320243719-dpooq.md` becomes a row with
   that id; a project id `proj-1780057127027-m1c` carries its creation instant in its own
   name, used when the source has no `createdAt` rather than inventing "now". An instant
   the import had to invent is never the reason two imports are called different — the
   board's stored value stands.
3. **Nothing is overwritten, and nothing that differs is quietly dropped.** A record whose
   id is already on the board and whose content is *identical* is a no-op, so importing
   the same vault twice creates nothing and says so — and, because a command that changed
   nothing writes no event, the log does not grow either. A record whose id is already
   there with *different* content is `VAULT_ID_CONFLICT`: the whole import refuses, naming
   every colliding id and the fields that differ. It used to be counted as "skipped"
   without ever being compared, which meant an import could report success while throwing
   away a change the creator had made in the vault.
4. **Every collision is found before any of them is acted on.** The plan is decided up
   front, so a conflict cannot leave half an import on the board. Two source files in one
   payload claiming the same id are a conflict too.

Its effects are one `create` per record, so the whole import is attributed, revertible,
and visible in the activity diff like any other change.

Two consequences worth stating plainly, because they are refusals rather than conveniences:

- **A different vault folder is a different source.** Each project row stores the folder
  it links to, so importing the *same records* from a second copy of the vault refuses on
  `link_path` — thirty times, once per project. That is the rule working, not a bug: the
  import will not silently keep pointing at the old place while the source says otherwise.
- **The import reads only inside the vault it was given.** The client canonicalizes the
  vault root and the configured `eventsFolder`/`projectsFolder` with `realpath`, refuses a
  configured folder whose `relative(realRoot, realDir)` escapes (including one reached
  through a symlink or a junction), refuses any file that resolves outside the root, and
  derives every stored source path with `relative(realRoot, realFile)`. The service checks
  the payload on its own terms as well — a file path that is absolute or contains `..`, or
  a folder path outside the declared root, is `VAULT_PATH_ESCAPE`. An import that reads
  outside the directory it was pointed at has broken the only promise it makes.

### The locked plan is the service's rule, not the cockpit's

A locked run freezes a plan, and the cockpit has always enforced that by disabling
things: planned cards are not draggable, their weight steppers are disabled, drops into
Running are refused. That made the rules *gestures* rather than rules — an agent with a
token could change a member's weight, walk a member out of the running column, fill the
column with newcomers, or delete the last member and leave a plan with nobody in it.
Both clients answer to the service now:

- Changing the **weight** of a planned member → `RUN_MEMBER_LOCKED`.
- Moving a planned member **out of** the running column → `RUN_MEMBER_LOCKED`.
- Moving anything else **into** the running column while a run is locked → `RUN_LOCKED`
  — and the same boundary at `task.create`, because creating straight into the column
  is joining it.
- Reordering a member *within* the column stays allowed: it does not touch the frozen
  plan, and the plan snapshots its own order.
- Deleting the last member **ends the run**, and the delete event names the run it
  ended — so the undo puts both back rather than leaving a plan with nobody in it.
- `run.unlock` says **which** run it means (`lockedAt`, and an agent must name the run's
  revision): ending a plan is not reversible by repetition, so a caller that names a
  run that has been replaced is refused rather than ending somebody else's horizon.
- `task.layout` is derived, so a pass computed from a board that has moved on is stale:
  a row that names a `rev` is held to it, and an agent must name one. A row with no
  revision is still PLACED when the caller is not an agent — the cockpit draws and
  sends in one gesture on one screen.

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

## Where the cockpit is served from, and why it is not a detail

The service serves the cockpit itself (`GET /`), and that is the only arrangement in
which the cockpit can talk to it *directly*. Three cases, and the last one is how the
creator actually uses Proxima:

| Served from | What happens |
| --- | --- |
| **the service** — `http://127.0.0.1:4181/` | Same origin as the API. No CORS, the session cookie is first-party, SSE works. |
| **a dev static server** — `http://127.0.0.1:4180` | Works only with `--allow-origin http://127.0.0.1:4180` and `?api=http://127.0.0.1:4181/v1`: the nonce is injected by the service when it serves the page, and a page the service did not serve has none. |
| **a Papers backpack** — `papers-backpack://<projectId>` | A direct fetch cannot work, for two reasons stacked one behind the other: the page's own policy refuses the connection before the network layer (nothing is sent), and with that relaxed the request goes out with `Origin: papers-backpack://<projectId>` and dies on CORS. Cookies do not survive the trip at all. So the page does not fetch: it **asks Papers**, which makes the request from its main process and attaches the project's declared credential. |

### The bridge, from the page's side

`local-service.json` beside `project.json` is the project's declaration — the service
origin it may reach and the id of a credential that names a file to read:

```json
{ "schemaVersion": 1,
  "services": [{ "origin": "http://127.0.0.1:4181", "secret": "operator" }],
  "secrets": [{ "id": "operator",
                "file": "D:\\…\\Proxima Data Home\\token",
                "header": "authorization", "scheme": "Bearer" }] }
```

A request is one `postMessage` and one reply, correlated by `requestId`:

```js
window.postMessage({ type: 'papers:project:local-service-fetch',
  requestId, url, method, headers, body }, location.origin);
// → { type: 'papers:host:result', requestId, ok: true,
//     localService: { ok, status, headers, body, detail? } }
```

Three things the page must respect, all of them the host's rules rather than ours:

- **The credential is never the page's.** Papers attaches it from the declared file and
  strips any `authorization` or `cookie` the page tries to set. There is nothing to
  build that relies on the page supplying one, and the cockpit does not.
- **`localService.ok: false` means the SERVICE WAS NOT REACHED** — and that is the only
  thing that produces the "not reachable" banner. A non-2xx status is `ok: true` with
  that status: a 401 is the service's own answer about the credential, and it is
  reported as it stands, never softened and never retried into a session that a
  backpack page cannot have anyway.
- **No stream.** The bridge is a request and a reply, so on that path the cockpit polls
  `GET /v1/log?after=<headSeq>` every four seconds while the page is visible. That
  keeps cross-window liveness and the activity diff, and it is the recovery loop too.

**The service was not made more permissive for any of this.** Its CORS policy, its
token, its nonce and its 401 are exactly what they were; the bridge exists precisely so
that they can stay that way.

## Running proximad on this machine day to day

The daemon owns the board and serves the cockpit, so "Proxima is not running" and
"Proxima cannot be reached" are the same sentence, and the arrangement has to make the
first one rare and repairable:

```
service/Proxima.cmd                    the thing to click: starts proximad if it is not
                                       answering, then opens http://127.0.0.1:4181/
service/proxima.ps1 -Action ensure     the same, headless (-NoOpen for logon use)
service/proxima.ps1 -Action status     is it up, on which home, at which head sequence
service/proxima.ps1 -Action stop       stop the process holding the port
```

The launcher finds the data home by what is on disk — an explicit `-DataHome` or
`PROXIMA_HOME`, then the home the running daemon reports, then the nearest
`Proxima Data Home` above the script that holds a `proxima.db`, then the per-user
default — because the board the creator has been using is the one that must be opened,
and a launcher that picked a fresh empty home would look exactly like data loss.

For it to be there before anything is opened, register it once, from a normal shell:

```
schtasks /Create /TN "Proxima service (proximad)" /SC ONLOGON /F ^
  /TR "pwsh -NoProfile -ExecutionPolicy Bypass -File \"<path>\service\proxima.ps1\" -Action ensure -NoOpen"
```

(A shortcut to `Proxima.cmd` in the Startup folder does the same job.) Neither could be
installed by the agent that wrote this — the Task Scheduler refused every form of the
command and the Startup folder refused the write — so this is the creator's one step.
Until it is done, the daemon's lifetime is whatever started it, which for the session
that built this was the agent's own process tree.

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
