# Proxima — governing document

Read this first and completely before working in this repository.

## Product north star

Papers is the creator's **personal programmable environment on an actual machine,
layered over Windows**. Its scope includes the machine's real files, installed
applications, native windows, devices, running processes, services and working state.
Actions must work with those real things and produce the intended result on the machine.

It keeps the best tools, applications, native machinery, agents, custom surfaces,
scripts and behaviors under the creator's fingers with minimal cognitive overhead.
Windows is the compatibility substrate for the software and machine the creator uses.
Electron, C#, Win32, Chromium, external programs, local services, agents and remote
systems are implementation choices; none defines or limits the product.

The creator describes the desired experience. Agents own architecture, implementation,
migration, testing and evidence. Internal implementation state must not become work
for the creator to manage.

The goal is maximum useful capability and excellent UX without growth making the
system progressively more brittle or expensive for agents to change.
**Capability is unbounded. Coupling is bounded.** Architecture preserves freedom.
Use the existing owner when it owns the truth; widen its contract when needed; create
another owner when the truth or lifecycle differs. Do not make unrelated systems own
new truth or sacrifice accepted behavior for architectural uniformity.

This vision is recorded in the opening of [the original north-star handoff](https://github.com/Futahua/Papers-3/blob/251aa0bf9e9ba3fe336b3354c3cd4b7f972af5c6/REFACTOR-HANDOFF.md).
Its dated paths, implementation plans and old runtime instructions are historical.

## Authority and working rules

This is this repository's single governing document. Current creator instructions
outrank it. Other documents supply technical reference, evidence, history or proposals;
they do not independently govern product direction or authorize work. Record accepted
corrections here rather than making several competing contracts.

- Preserve accepted behavior, creator data and unrelated changes. If recently working
  behavior regresses, compare history before inventing replacement architecture.
- Reuse existing trackers, services, applications and native behavior. Equivalent actions
  should converge on the same owner before identity, mutation and persistence.
- Keep failure local. A preview failure must not disable unrelated work or durable state.
- Inspect the actual source and running build; distinguish source tests from installed
  behavior. Use isolated fixtures and avoid taking the creator's mouse or keyboard.
- Honor authorization already given in the conversation. A document does not revoke it
  or require repeated permission. Publishing, installing, restarting or destructive work
  needs applicable authorization; ordinary inspection and reversible fixes can proceed.
- **Current cleanup scope (2026-10-07): documentation and comments first.** Reconcile
  stale or conflicting descriptions and clarify ownership. This cleanup does not authorize
  code rewrites, refactoring, behavior changes, deployment or publication. Historical
  refactor roadmaps are not the current assignment.

## What Proxima is for

Proxima is the creator's cockpit for projects, tasks, runs and their real files.
The intended experience is agentic: agents can work with durable data and Proxima
presents it. The cockpit may be rebuilt; creator data must persist independently.
This does not authorize implementing a proposed data-service migration during cleanup.

Proxima owns its presentation and project/task interaction policy. Its command/store
boundary owns structured mutations, revisions and event recording; existing applications
own real file content. Do not bypass the command owner from another surface or invent
another authoritative copy. Papers and AYG hosting do not make their document state the
owner of Proxima's project facts.

For Papers host work, read that repository's AGENTS.md. Host protocols may evolve for
accepted behavior; Backpack policy remains local. Preserve unrelated dirty UI changes.

## References

- [DATA-PLANE.md](DATA-PLANE.md) records the command façade, durable-data destination
  and proposed later slices. Distinguish implemented behavior from the destination.
- [OPEN-FINDINGS.md](OPEN-FINDINGS.md) preserves review findings and closure evidence.
  Do not lose unresolved findings by compressing a handoff.
- project.json records current hosting. public/ is the current served implementation.

Verify the affected path using isolated data. This checkout has no root package.json;
do not invent a test command or report a proposed migration as completed.

Creator-directed separation, 2026-10-10: Proxima project pages contain only the project task board. Do not mount AYG file, preview or native-window views, request embedded workspace scopes, or provision special linked project folders. The manifest has no workspaceHost binding. Existing tasks, project facts and former AYG folder contents remain preserved independently; this change removes the integration rather than deleting creator files.

Creator-directed exact timeline, 2026-10-11: the timeline is horizontal elapsed time and uses independent timelineIntervals, never task-derived deadline bars. Existing task and schedule data remain preserved. Store.command owns create/patch/delete and revisions. Geometry is (timestamp - viewportStart) * pixelsPerMillisecond; pointer zoom holds the timestamp under the cursor fixed. Labels adapt to zoom without changing interval endpoints. Double-click / Enter creates an interval; interval click edits exact timezone-bearing start/end timestamps. Old timeline controls remain hidden only for legacy app bindings, not part of the active surface. Verify with node --test exact-timeline.test.mjs and isolated live intervals.

Creator-directed storage scaling, 2026-10-12: IndexedDB owns Proxima facts after atomic migration from proxima.store.v1. Retain that localStorage document as a recovery copy; preferences remain localStorage. Bootstrap must await database readiness. Store.command serializes mutations, resolves after transaction completion and rolls back failures. Store per-record differences in one transaction, preserve unknown fields, and share an origin-wide write lock across surfaces. Timeline caches sorted lane geometry per refresh and searches the visible time range during motion; do not round timestamps.

Creator-directed timeline rows, 2026-10-12: click blank track space to insert and name a row inline, between-row clicks insert at that row position. Click a blob to rename inline; Enter or blur saves, Escape cancels. Drag the blob vertically to reorder using Store.command and durable rowOrder; timeline endpoints remain unchanged. Edge dragging resizes exact timestamps. Double-click the right edge toggles durable followNow; the live endpoint displays current time without writes on each tick, and unlink freezes it. No creation/edit popup. Existing intervals are assigned stable fallback rows until edited.

Creator-directed timeline history, 2026-10-12: Z undoes and Y redoes timeline record operations when the timeline is visible, excluding typing fields and open dialogs. History is durable, bounded to 200 actions, and uses Store.command with atomic state/event/history commits. New edits clear redo; conflicting changes are refused. Creating a draft immediately reserves a row and shifts subsequent blobs; cancellation releases the slot.

Creator-directed colors and deadlines, 2026-10-12: right-click inside a blob opens color swatches, a custom picker and saved color presets; left-click renames inline. Right-click blank future time inside an existing blob row sets a durable deadline and followNow. Render an unfilled red dashed outline from current time to deadline, updating without per-tick writes. Color and deadline edits participate in timeline undo/redo.

Creator-directed activity/session model, 2026-10-12: timelineRows owns shared activity names, colors and row order; timelineIntervals references rowId and owns each session's exact start/end, live flag and deadline. Existing intervals migrate to one activity each through Store.command. Double-click empty space within an activity adds a session without a naming popup; below activities creates a parallel activity inline. Same-activity sessions may touch but never overlap; live sessions reserve their future span and must be ended before adding another session. Selection, reorder and deletion operate on activities; per-session edges remain independent. Shared edits and sessions participate in durable undo/redo. Legacy session name/color/order fields remain compatibility projections synchronized from rows.

Creator correction, 2026-10-12: entries within one row have independent names. Session name is authoritative on timelineIntervals; row grouping never propagates names. Double-click creates and names every new session inline, including within occupied rows. Row color/order remain shared. Pointer capture begins only after the drag threshold, so occupied-row blank-space double-clicks reach creation.

Creator-directed elastic timeline queues, 2026-10-12: a queue-end icon arms future edge placement with a row preview. Queue state belongs to timelineRows.queue (end and ordered session ids); each member owns its queueWeight and color. Store.command owns queue creation, enqueue, shared-boundary resize, swap and completion, including snapshot undo/redo. Only sessions without deadlines may enter. The first session follows now; waiting sessions divide now-to-end by saved proportions without tick writes. Shared boundary resizing changes adjacent proportions; elapsed time never changes those weights. Right-clicking the active end opens the picker; successful color-and-completion is one atomic command, freezes that member and advances the live link. Horizontal dragging swaps members with their proportions attached. Reject ordinary endpoint edits that would break queue links. Preserve independent names, prior task/calendar data and existing non-queue interactions.

Creator correction, 2026-10-12: expired queue edges are deleted through timeline-queue.delete, not merely hidden. Dissolve linked queue state while preserving member blobs and independent colors. Clicking a future end edge opens a compact inline Delete/Cancel confirmation; dragging remains resize, and Escape dismisses confirmation. Expiry deletion rechecks the durable end so a concurrently extended queue is retained.

Zoom performance correction, 2026-10-12: cache schedule occurrences in a padded visible-range window keyed by schedule record revisions and current scope. Shared DateStrip reuses Intl formatters and only rewrites date text when its timestamp changes; today highlighting still updates on the Saigon day boundary. Measure labels without interleaved DOM layout reads, compare cached numeric lane geometry, and read viewport width once before schedule mutations. Preserve exact proportional event widths, recurring exceptions, read-only calendar ownership and compressed-name hover behavior. Live measurements: two-year render about 78ms before, 7ms after; repeated renders about 4ms and twenty-year view about 5.5ms on this machine.

Creator clarification, 2026-10-13: PC-to-PC Proxima may use the full interface to edit the live owner's facts. Every act goes to the owning PC's existing Store.command and is confirmed only after its persistence succeeds. Require the viewed source checkpoint, retain idempotency keys, refuse stale commands, and never queue offline edits or write remote facts to the receiver's database. Copy/follow remains distinct. Android work is outside this task; preserve the other agent's phone work.
Creator-directed machine palettes, 2026-10-13: identical desktop code must choose its palette from Papers durable owner identity. SlopTop owner dedd3a17-6f98-40ba-8daa-f6ac3d1bf82e stays muted blue; LapDog owner 417c0ac8-2d5c-4f32-9cf0-61c22ac0d774 stays muted green locally and remotely. device-theme.js owns the shared mapping and date-box/grid/control palette. Never deploy machine-specific code variants or derive identity from whether the view is remote. Remote views use the viewed owner; local cached identity is presentation-only and refreshed from Papers status. Preserve creator activity colors. Android is outside this implementation.

Creator-directed queue expiry, 2026-10-15: finish an expired queue at its durable end, never at the noticing device's wall time. Queue projections clamp the active endpoint at that end even before persistence. Waiting sessions return to their own pre-enqueue positions through the existing Store.command and snapshot history owner; preserve names/colors and refuse missing/overlapping originals atomically. Never create zero-length completed sessions. Future explicit edge deletion retains its accepted projected-blob behavior. A synchronized row queueCompletion describes the cause/time and returned members; the compact timeline notice stays until locally dismissed. Do not rewrite the creator's previously expired/restored sessions as a migration. Verify with queue-completion.test.mjs plus the timeline, remote-domain and sync checks.

Creator correction, 2026-10-17: queue-button selection containing a different blob merges into the existing collapsed group or enqueues into its live queue; it never implicitly restores grouped members. Keep existing members and colors, one atomic undo, and explicit same-group restore. Human Store.command writes carry explicit human provenance and command identity through persistence and field sync stamps. Unlabelled/background writes are automatic. An offline or skewed-clock device cannot supersede explicit human timing, live flags or deletion intent merely by clock or causal observation. Only checked queue expiry may automatically advance the exact human field version it was based on; another manual edit invalidates that authority. Preserve genuine human conflicts and protect human fields during structural repair. No migration rewrites creator records.

Creator-directed optional blob templates, 2026-10-17: an individual timeline session may choose As you Go as its template; opening it opens its workspace pane. Import independent managed copies, preserve originals, and aim for offline copies with automatic propagation on SlopTop, LapDog and Poordroid. Reuse Proxima's causal sync for workspace records and existing Papers transfers for versioned bytes; no additional sync engine unless a concrete failed acceptance case justifies it. Blob/template binding changes participate in timeline undo; edits within these new workspaces do not. The replicated recoverable Bin is their safety net and belongs in the first three-device acceptance test. Preserve unrelated standalone AYG history. Incoming changes retain their original authorship and causal stamps while being applied through the checked local writer as sync delivery, never restamped as local human intent. Local template/pane work can proceed alongside sync tests. Show saved-locally, waiting, error and conflict states from the first slice; never claim all-device completion without acknowledgements. SlopTop may be the preferred relay, never a mandatory authority or an editing prerequisite; direct paired-device fallback must work. Android editor-return and reconciliation scans must cover external saves when notifications cannot. The first real three-device test must include offline competing saves, recoverable deletion, restart, background/closed presentation and later reconciliation. This supersedes project separation only for explicitly chosen blob templates, not ordinary project task pages.

Future server assumption, 2026-10-17: an optional always-on server may become the preferred durable replica/relay, retaining the same original actions, file versions and recoverable deletion records. Its receipt sequence is an audit/catch-up cursor, not edit authority. Server receipt never stands for acknowledgement by the three user devices. Keep offline local editing and paired direct sync available; adding or removing this server must not require another sync model or ownership migration.
