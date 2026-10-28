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
Preview pin/copy correction, 2026-10-23: blob Go pin requests go through the authenticated workspace adapter to Proxima's existing native group controller. Pinned files are document tabs in the Go group, with stable slash-normalized path identities, native selection, reordering and durable references. No legacy nested pinned panel is opened in the embedded iframe. The preview host supplies Papers' native copy-text route; the embedded blob adapter forwards that route to the parent too. Clipboard errors are caught even when a host method throws synchronously. Existing unrelated changes preserved. Live recovery opened Bailam2-Model-1.png.pdf beside Go in the regular group; clipboard contents were not overwritten for a synthetic test.

Flow dead-window recovery, 2026-10-24: the existing native pane snapshot event triggers bounded restart/reconnect for an explicitly docked Flow template while its blob is open. Preserve the original dormant tab identity, order, group and prior selection; never kill a still-live/hung process. Retry at 750ms, 3s and 10s, then retain the slot with an error; one minute of confirmed healthy native presence resets the budget. Leaving the blob cancels pending recovery. Papers programOpen owns acquisition and reconnect, and refreshes the real HWND rather than trusting a surviving PID. Syntax checked; no deliberate live crash test.

Blob viewport persistence, 2026-10-24: each durable Papers surface key scopes the timeline layout preference. Migrate from the legacy shared key only when a page has no own value; main exactTimeline mounts always establish a persistence key even when the first caller supplies no options. Repeated render saves are throttled instead of endlessly postponing the save, unchanged serialized viewports are skipped, and pagehide retains the animation goal. Late mount configuration updates its save key. Current live viewports were preserved before the normal save/reload; backup under ChatGPT/Proximate/blob-zoom-20261024. Syntax checked; no test suite added or run.

Return to Live available-space correction, 2026-10-24: timeline return button, blank header and F route through one returnToLive owner. Its horizontal anchor is the midpoint of the timeline rectangle exposed beside visible blob-workspace panes, clipped to the viewport; no pane keeps normal full-width centering. Current per-page zoom survived the normal restart on SlopTop and LapDog with identical scales before/after. Updated only app.js/exact-timeline.js on LapDog after matching original hashes, backed up under Papers-Updates/blob-zoom-20261024; loaded midpoint code observed on both machines. No automated tests run.

Visible one-eighth scroll zones, 2026-10-24: wheel vertical-scroll edge detection and hover-zone bounds use the same exposed timeline viewport as Return to Live. Each edge zone is one eighth of the uncovered width, including the edge beside a blob pane. Syntax checked, original files backed up and hash-checked update applied on SlopTop/LapDog through normal save/reload.

Go tab sync indicators, 2026-10-24: waiting workspace delivery uses the structured status.waiting list matched to known peers. Go shows each pending device kind icon with an asterisk (phone/computer), removed when its acknowledgment catches up. Native protected Go document tabs and ordinary template tabs share that status; Flow is unaffected. Waiting alone no longer opens the global status banner; actual errors/conflicts remain visible. Applied as exact scoped edits on both PCs with backups, syntax checked, normal save/reload used. No synthetic sync state or tests run.

Non-live blob names, 2026-10-25: when a visible non-live blob (not followNow, not a live or parent group) cannot fit its name, the name overlay stays inside the blob and is clipped instead of moving left of the blob or spilling past its end. Live blobs keep the outside placement. Syntax checked, exact-timeline tests 20/20; not verified in the running app.

Pane interaction/Flow availability correction, 2026-10-25: preserve the newer Shift inward/name-clipping changes. Go and Flow startup proceed independently; network-bound Flow lookup does not hold the pane-open queue, and Go metadata is not a prerequisite for launching Flow. A binned Go binding does not veto the Flow-only path. Flow retains verified workspace/page IDs per logical document in a local preference cache (no launch/auth tokens), opens cached native pages immediately, and refreshes BOP mapping in the background with bounded lookup deadlines. Its open-request generation is separate from presentation generation. Tab and blob-icon actions use the same open/toggle/close owner; close invalidates pending opens and returns focus to the timeline. Hidden dialogs do not intercept Tab; an embedded Go Tab forwards through the authenticated parent bridge, excluding edit fields. Calendar-preview content buttons remain navigation targets. Syntax checked only; no tests added/run or native apps killed. Incident files are in ChatGPT/Proximate/pane-regression-20261025.

Flow minimap, space following and modal ownership, 2026-10-25: native Flow has an edge-hover document overview with click/drag scrolling through its existing editor scroll controller. Proxima projects only confirmed linked workspace/page IDs and effective live state (including live group descendants, union for shared pages) through the bounded program-window-follow capability. That local projection is a cache; Proxima facts remain authoritative and native Flow moves pages through ViewBackendService.moveViewV2 into exactly one existing Live/Archive space, retaining content and children. Ambiguous spaces/pages are not invented. Corn & 3D pipeline has two native pages; the populated research-notes page a5346b91-bc76-4aba-9295-869f291ba0e8 was identified from local content matching the visible page; its blank duplicate remains unbound. NativeModalGuard composes all visible document/ARIA dialogs with the existing pane/menu overlay state, suspends native hosting during modals and restores it afterward. Storage dialog was closed once to recover the blocked UI. Desktop native build compiled successfully and was installed via graceful close; host bridge installed via NSIS from current Runtime/App, retaining newer host/native fixes. Four linked pages currently project live=true. No synthetic transitions, modal tests or test suite run. Backups/build log/folder safety snapshot: ChatGPT/Proximate/flow-navigation-20261025.

Visible row compaction, 2026-10-25: rows whose non-live sessions leave the exposed timeline time range release their presentation slots; live rows, queues and expanded live ancestors remain. Panning back restores rows in saved order. The same projected row list owns paint and pointer targeting; freeze it during selection, drag, resize, queue placement and editing. Durable timestamps, membership, order and history are unchanged by visibility. Shift extension accepts a stable beforeRowId anchor so hidden rows cannot corrupt insertion targeting. Header add/queue/delete controls align to the exposed viewport beside panes. Isolated timeline regression tests cover compaction, shared rows, ancestors, and identity-based Shift reorder with undo/redo.

Selection actions, 2026-10-25: header icons and accessible labels follow the same selection and queueSelectionAction policy as their handlers: create/group/ungroup and place/collapse/restore/enqueue/group-to-queue. Selection painting updates them immediately. Old deadlines on completed offscreen blobs do not reserve rows; main horizontal schedule lanes also release space when their events are outside the exposed viewport (calendar preview keeps its empty lane).

Pane geometry and first free row correction, 2026-10-25: the blob-pane owner publishes a coalesced geometry event for visibility, style/class and size changes; timeline presentation responds immediately, including collapse. Plus and plus-target text creation share a durable-row search (not compacted rows), reject live/future occupants and queues, and do not steal expanded child-group rows. A hidden free row gets a temporary draft slot at its projected order; save reuses its stable rowId. 25 timeline tests passed; an isolated hidden renderer verified creation into the hidden first row, no creator data changes, and control right edge moving from 500px to 800px on collapse.

Creator constraint, 2026-10-25: portable Flow embeds must reuse existing Papers/Proxima managed files, workspace version/conflict/transfer/cache owners and applicable local file identity; no second embed sync engine, asset depot, file watcher or document store. Flow already owns a persistent WebView2 environment; preserve it rather than adding another default-profile feature. Electron browser/HTML preview sessions retain their existing ownership and isolation; their live profile directories are not interchangeable with WebView2. Remaining native/mobile bridge and multi-file HTML packaging are planned integration gaps, not implemented features. Source audit: ChatGPT/Proximate/EMBED_PORTABILITY_REUSE_AUDIT.md.

Flow portable embeds, 2026-10-25: flow-embed-bridge.js answers native Flow's embed requests through the existing replica only. Local files are received into the internal "flow-embeds" workspace (managed copy, hash, content version) and Flow stores {workspaceId, entryId, name, origin}, never a machine path. Resolution uses replica.entry(observe) so edits become versions under the same ID; conflicts report both-kept; missing content uses the existing workspace-download path (BOP first) with Flow-driven retry tokens. Removing an embed removes only Flow's reference. Answered imports are remembered in localStorage until Flow collects them, so a reload never imports twice. Several Papers pages can host Proxima at once: one leader page holds the 'proxima-flow-embed-bridge' Web Lock for its lifetime and alone answers Flow (two pages racing produced a duplicate flow-embeds entry, ae510972…, during the first live test); each tick re-reads the remembered answers. Desktop Papers-hosted page only. Installed on SlopTop and LapDog (LapDog bootstrap list gained flow-embed-bridge; backups under Papers-Updates/flow-embeds-20261025). HTML folder packages, Android and an explicit save/load API for interactive HTML state remain planned. Tests: node --test flow-embed-bridge.test.mjs (8 passed).

Embed cleanup, 2026-10-25: pending imports reuse their validated requestId as the managed entryId; existing receiveFile provides idempotence if import commits before a receipt is saved. No parallel import journal added. Ten bridge tests include lost-receipt replay and invalid identity. The three verified 71-byte agent HTML fixtures were removed through ProximaWorkspaces.remove/reconcile/flush into normal synced Bin; their history/content remain recoverable. Old minimap .bak files archived outside the Flow source tree. LapDog's one-off swap watcher was stopped and disabled, with staged host/rollback preserved; use the existing supported installer for any pending host update.

Flow embed saved data, packages and Android, 2026-10-25: interactive embeds call flowEmbedStore.load()/save(object); the leader page answers through replica.readDocument/saveDocument (document IDs flow-embed.<entry or block id>), so data syncs with the existing causal journal and a stale save returns DOCUMENT_CHANGED with the newer content instead of overwriting. A save retried after landing is reported as saved. Raw localStorage/IndexedDB are never synced. HTML packages are one managed zip created by Flow from an explicitly chosen folder (entry page kept in the Flow reference), unpacked per device into a disposable cache with zip-slip protection. Android Flow renders embeds through webview_flutter (the native code present in the grafted official APK). On the phone, Flow reaches the phone owner page through Papers mobile's paired 127.0.0.1 endpoint; owner.js loads flow-embed-bridge and calls its answer() for each batch (a missing file is marked wanted and fetched by the ordinary device exchange). Resolutions carry the content hash so phone Flow keeps its own copy until it changes. Tests: node --test flow-embed-bridge.test.mjs (13 passed).

Flow embeds: download right away and conversion, 2026-10-25: the bridge's prefetch() downloads every flow-embeds file not yet local (skipping binned ones, one at a time through the existing workspace-download path, 2-minute backoff after a failure), every 20 s on the desktop leader page and on the phone owner page, so a page opened on another device already has its files. Native Flow converts embeds that still stored a machine path: at sign-in on a PC it scans every page read-only, hands each existing local file to Proxima and rewrites the block with the portable reference; it stops retrying only after a pass leaves nothing convertible. Live on SlopTop: three path embeds converted (including the 112 MB PDF and My-Hoc-Quiz.html); the phone downloaded both files within about two minutes once its owner page ran. Tests: node --test flow-embed-bridge.test.mjs (14 passed).

Creator schedule correction and Android Back, 2026-10-26: the registered timetable screenshot replaces the stale sociology class and methodology weekday; preserve sourceKey/event identities and unrelated creator edits. Five existing schedule records were corrected through Store.command with revision checks (full prior snapshot in ChatGPT/Proximate/schedule-mobile-audit-20261026). The source fixture is corrected for future imports; no repeated startup overwrite was added. Exact timeline exposes cancellation to phone-back.js through its existing editor/selection/group owners; the existing native phone papersBack route calls papersPhoneBack before exiting. Bootstrap loads phone-back after app. Schedule/Back tests: 13 passed; timeline tests: 25 passed. Corrected data and source verified on LapDog. Native phone package rebuilt from current live Proxima and AYG and installed without clearing data. Physical Back acceptance remains distinct from unit checks.

2026-10-26 RMB correction: local preview read-only guard allows right-button selection (remote read-only remains blocked). Marquee claims pointerdown before child handlers and suppresses context menus while active, including before threshold. Left drag remains separate. Two input regressions plus 25 timeline tests pass; refreshed loaded SlopTop/LapDog pages after flush.

Pane fullscreen on F, 2026-10-28: with a blob pane open on the main Proxima page, F toggles its inline fullscreen (same owner as Shift+Tab and the edge double-click) and takes precedence over Return to Live; with no pane open F still returns to live. Not on project pages, touch screens, typing fields or open dialogs. Verified on SlopTop with a synthetic key event on a stand-in pane; LapDog not updated.
