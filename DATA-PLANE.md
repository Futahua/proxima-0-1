# The data plane

What owns the data, what changes it, and where this is going. Written at the end
of slice 1 so slice 2 starts from a document rather than from a conversation.

---

## Why this exists

Everything the app knows lives in `localStorage` on one browser origin. Three
consequences, all of them observed rather than imagined:

- **Nothing outside the tab can reach it.** An agent has nowhere to write. It
  would have to puppet the UI.
- **Papers and the dev server hold different boards.** Same code, different
  origin, different data.
- **A browser profile change empties the whole bucket.** It already did, once,
  between two rounds of work, and took the fixtures with it. The app contains no
  `removeItem` and no `clear()`; it simply could not stop it.

The creator's stated goal for this product is agentic: *agents edit the files,
Proxima is the cockpit*, and *a backpack is a cockpit you can throw away and
rebuild; the data is what persists*. A store reachable only from inside one tab
cannot deliver that.

## The destination

A small local service owns the data.

- **SQLite** for structured facts: projects, tasks, runs, commands, events,
  proposals, actors, attachments.
- A **files/ depot** for real file content.
- **Cockpits and agents are all clients.** No client is special.
- **Structured mutation happens only through explicit idempotent commands** —
  each carrying a `commandId` and an expected revision, each refused with a
  structured code rather than clamped into something plausible.
- **One transaction per command**: the state change and its event are written
  together or not at all.
- **Events carry a monotonic `seq`**, the actor, the client, and before/after
  values. Clients `GET /v1/snapshot`, then subscribe to events after N over SSE.
- This is the ACP shape used next door, **minus per-turn ownership**: durable
  shared records do not have a turn to be owned by, so conflicts are resolved by
  revision instead.

### A creator decision, recorded

**Structured task and project data will not be human-editable files.** Files stay
canonical for *file content* — opened in their own apps, linked from Proxima —
and the service is canonical for structured facts. There is therefore no
YAML/JSON round-tripping to design toward, no comment preservation problem, and
no file watcher to reconcile. If a human wants to edit a task by hand, that is a
client editing through the command API, not a text editor.

---

## This slice (slice 1): the command façade, over the same bytes

`localStorage` stays underneath. Behaviour does not change. What changes is the
*shape* of every mutation, so that slice 2 is a transport swap rather than a
rewrite.

- Mutations are `await Store.command({ type, payload, commandId, ifRev })` — not
  `addTask` / `updateTask` / `moveTask` / `deleteTask` / `setRun` / `setViews` /
  `addProject`. Those methods are gone; there is no second path.
- Reads stay **synchronous** against the in-memory snapshot (`Store.tasks()`,
  `Store.task(id)`, `Store.run()`, `Store.projects()`), because that is what the
  render path needs and a renderer should not await.
- Every command appends an event with a monotonic `seq`, the actor, the client,
  and before/after values. The log lives in the store document beside the data
  and moves wholesale to the service in slice 2.
- Every command is **idempotent by `commandId`**: a replay returns the original
  result rather than acting twice.
- Invariants live behind the command boundary and refuse with a code and details.
  The UI still prevalidates for feel; the refusal is authoritative.
- **Read-time rescue is a different job from accepting a write.** `normalise()`
  still coerces and repairs what it finds on disk — an impossible date, an
  unknown status, a dangling project reference — because old and damaged data has
  to be *usable*. A command handed the same impossible values **refuses them with
  a code**. The two live side by side on purpose and the code says so at both.

### Actor and client

For now the cockpit states them: actor `human:minh`, and a client id that
distinguishes cockpits. The id is derived, not random — `?client=papers` if the
launcher names it, `papers` when the app is running from `file:`, otherwise the
serving host (`127-0-0-1-4180`). A service will know both for certain; until then
the log records what it was told.

---

## The command vocabulary

Every command takes the envelope below. `payload` is the command's own shape.

```
{ type, payload, commandId, ifRev, actor, client }
```

- `commandId` — idempotency key. Omitted means "this is a fresh act" and the
  store mints one; the result always reports the id it used.
- `ifRev` — the revision the caller believed the target was at. Absent means the
  caller is not racing anybody (the UI's own edits are of that kind). A mismatch
  is `ENTITY_REV_CONFLICT` and nothing is written.
- `actor`, `client` — defaulted from the cockpit.

| Command | Payload | Notes |
| --- | --- | --- |
| `task.create` | `{ name, note?, project?, status?, weight?, start?, deadline?, ganttRow? }` | `start` defaults to today; `order` places it last in its column. |
| `task.patch` | `{ taskId, patch: { name?, note?, project?, weight?, start?, deadline?, ganttRow? } }` | **Refuses `status`** and points at `task.move`. Refuses `createdAt` and `id` outright. |
| `task.move` | `{ taskId, toStatus, beforeTaskId }` | **`beforeTaskId`, never an index.** "Move X before Y" survives replay and concurrent clients; "set order = 12" does not. `null` means the end of the column. |
| `task.layout` | `{ rows: [{ taskId, ganttRow }] }` | The timeline's packing, one command per render pass. Unknown ids are skipped and reported, because a pass can race a delete. |
| `task.delete` | `{ taskId }` | |
| `project.create` | `{ name, description? }` | |
| `project.archive` | `{ projectId }` | Archiving something already archived succeeds with `changed: false` — it is already true, so there is nothing to do and nothing to log. |
| `project.restore` | `{ projectId }` | Same, in the other direction. |
| `project.delete` | `{ projectId }` | Orphans its tasks (they become uncategorised) and names them in the event. Never deletes work. |
| `run.lock` | `{ target, taskIds }` | The client says **which** tasks and until when; the store computes the frozen plan from its own records. |
| `run.unlock` | `{}` | Ending an already-ended run is success with `changed: false`, not an error. |
| `proposal.accept` | — | **Named in the destination, not served this slice.** Refuses `COMMAND_NOT_IMPLEMENTED`. |
| `history.revert` | — | Same. |

Commands added for the app rather than named in the brief: `task.delete`,
`task.layout`, `project.create`, `project.archive`, `project.restore`,
`project.delete`, `run.unlock`. They are listed here rather than smuggled in, so
the vocabulary is the document and not the code.

### Results

Resolves — never rejects — with one of:

```
{ ok: true,  commandId, seq, rev, changed, value, replayed? }
{ ok: false, commandId, code, message, details }
```

`changed: false` means the command was accepted and there was nothing to do (a
patch that changed no field, archiving an archived project, unlocking no run). No
event is written and no revision is bumped for a command that changed nothing.

### Refusal codes

| Code | Meaning |
| --- | --- |
| `COMMAND_UNKNOWN` | Not in the vocabulary. |
| `COMMAND_NOT_IMPLEMENTED` | Named in the destination, not served yet. |
| `PAYLOAD_INVALID` | Missing or malformed payload (`details.missing`). |
| `COMMAND_ID_CONFLICT` | That id was already used for a *different* command. |
| `ENTITY_NOT_FOUND` | No such task/project (`details.kind`, `details.id`). |
| `ENTITY_REV_CONFLICT` | `ifRev` did not match (`details.expected`, `details.actual`). |
| `NAME_REQUIRED` | Empty name. |
| `DATE_INVALID` | A date that does not exist (`details.field`, `details.value`). |
| `DEADLINE_BEFORE_START` | The pair contradicts; **refused rather than reordered**. |
| `WEIGHT_INVALID` | Not a whole number 1–100. |
| `STATUS_UNKNOWN` | Not a column this board has (`details.allowed`). |
| `PROJECT_NOT_FOUND` | A project reference that resolves to nothing. |
| `GANTT_ROW_INVALID` | Not a timeline row. |
| `FIELD_NOT_PATCHABLE` | e.g. `status` through `task.patch` (`details.use`). |
| `MOVE_ANCHOR_NOT_IN_COLUMN` | The "before" task is not in the destination column. |
| `RUN_HAS_NO_MEMBERS` | Locking with nothing running. |
| `RUN_TARGET_INVALID` | Not an instant in the future. |
| `RUN_ALREADY_LOCKED` | Unlock before locking again. |
| `WRITE_FAILED` | The browser refused the write; the whole change was rolled back. |

Refusals are remembered for the session in memory only: a replay inside one
session gets the original code, and after a reload the command is simply
evaluated again. A refusal is not an event and is not worth a write that could
itself fail.

---

## What slice 1 deliberately kept

Because these earned their place and the refactor must not cost them:

- the single mutation path, now the command layer;
- rollback when a write cannot be persisted, with the change invisible rather
  than merely unsaved;
- a typed, visible load or write failure — never a fake empty board;
- unknown fields **inside a record** preserved (and, as of this slice, unknown
  top-level keys too);
- stable ids, and `createdAt` immutable as provenance;
- the frozen run snapshot, computed inside the store so no client can send a
  stale plan;
- strict date and weight parsing;
- an invalid write refused, never made plausible;
- one exceptional case: `normalise()` on read still rescues old and damaged data.

## State that is *not* board data

| State | Where it lives | Why |
| --- | --- | --- |
| Timekeeping panel composition | `Cockpit`, per client, in `proxima.cockpit.v1` | How *this* cockpit looks. Papers and a laptop may differ. |
| Timeline zoom | Same | Same. |
| Route (`#/`, `#/hub`, `#/schedule`, `#/project/<id>`) | The URL | It is the address; nothing durable should be able to disagree with it. |
| Project lens (the Daily filter) | Nowhere durable | A look, not a fact. |

`views` was removed from the board document in this slice. A document written by
an older build still carries one, and it is adopted into the cockpit **once**,
on first load, so nobody loses their layout to the split.

---

## Slice 2, when it comes

1. A local service (SQLite + `files/`), started by the cockpit or alongside it.
2. Tables: `projects`, `tasks`, `runs`, `commands` (unique index on `commandId`),
   `events` (`seq` monotonic), `actors`, `attachments`, `proposals`.
3. `POST /v1/commands` — the envelope above, verbatim; the same codes back.
4. `GET /v1/snapshot` — the document the cockpit already knows how to read.
5. `GET /v1/events?after=N` over SSE — the log, streamed.
6. `Store` becomes an HTTP client: reads against a snapshot the cockpit keeps in
   memory, `command()` a POST. Nothing else in `app.js` should have to change,
   which is the whole point of slice 1.
7. The event log's local trim (`EVENT_MEMORY = 1000`, `COMMAND_MEMORY = 200`,
   with `prunedThrough` recording where a pruned copy starts) disappears: the
   service keeps all of it.

## Open questions for slice 2

- **Actor identity.** `human:minh` is stated by the cockpit today. The service
  should decide it from the connection, and there needs to be a story for a
  second human.
- **What an agent may do.** The vocabulary is the same for everyone; whether an
  agent may `project.delete`, or whether proposals exist so that it cannot, is a
  policy question this slice deliberately did not answer. `proposal.accept` is
  reserved for exactly that answer.
- **Offline.** A cockpit that cannot reach the service has no writes. Whether
  that is a queue, a read-only mode, or a hard stop is undecided.
