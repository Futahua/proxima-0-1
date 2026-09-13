# Open findings

Everything a review has flagged and nobody has actioned, in one place.

This file exists because of a specific failure. The first fidelity review named
nine or ten divergences; seven were sent on to be fixed, and the rest were
dropped on the floor when the findings were compressed into a work brief. One
of the dropped ones — a clamp that silently rewrote contradictory dates — came
back a day later as a visible bug, and it looked like the reviewer had missed
it. The reviewer had not missed it. The ledger had.

So: a finding goes in here the moment it is reported, and comes out only when
it is fixed or deliberately closed with a reason. Being unimportant is not a
reason to leave it unwritten.

Verified against the working tree at `148803c` unless noted. The integrity pass
below (lock snapshot, deadline expiry, timeline clipping) is not yet in a tagged
commit; it is in the working tree on top of it.

---

## Open — from the fidelity review of Timekeeping

| # | Finding | Original | State here |
| --- | --- | --- | --- |
| 2 | **Shift-resize of either bar edge.** The original resizes a bar's start or end with a modifier. | `460-463`, `505-510`, `561-566` | Not built; `shiftKey` appears nowhere. Whole-bar movement only. |
| 3 | **Pixel/time-based bar movement.** The original moves a bar in continuous time (`newStartMs = zeroMs + newLeftPx / ganttZoom * 86400000`); we round displacement to whole days. | `542-550` | Open. Sub-day precision is unreachable while the store keeps dates as `YYYY-MM-DD` — see #5. |
| 4 | **Configurable colour rules.** The original evaluates a user-configurable `colorRules` set at render time, affecting calendar, timeline and countdowns. We hardcode urgency bands. | `142-161` | Open, and knowingly a placeholder: `URGENCY_COLOR` carries a comment saying it stands in for the rules system. |
| 5 | **Day-granularity deadlines.** We store `deadline` as `YYYY-MM-DD`; the original does arithmetic on whatever timestamp its model supplied. Countdown bucket maths is now faithful, but identical sub-day semantics cannot be proven without the original's task schema. | store.js | Open question, not yet a decision. Blocks #3 and #15. |
| 6 | **Persisted calendar/countdown column resizing.** | `84-122` | Not built. |

## Open — not from a review

| # | Finding | File | State |
| --- | --- | --- | --- |
| 7 | **A failed `localStorage` write reports success.** `save()` returns `{ ok: false, reason }` on a quota or security failure, but every mutating method ignored the return value and the caller saw a normal success. The in-memory state moved ahead of durable state with nothing telling the user, so a full disk looked exactly like a working save until the next load. | `store.js` — `save()` and every call site | **Closed.** Every mutation now runs inside `commit()`, which snapshots the state, applies the change, and rolls the whole thing back when the write fails. The change returns `null`, the board cannot show it, and the failure is announced once through `Store.onWriteFailure`. Verified for add / update / weight / delete with the write refused: memory and durable bytes both unchanged, nothing on screen, one sticky notice. |
| 8 | **An unreadable or wrong-version store is silently replaced with an empty one.** Corrupt JSON, a truncated write, or a future schema all presented as "no tasks", with the original bytes still in localStorage and the first ordinary mutation free to overwrite them. | `store.js` — `load()` | **Partially closed.** Corrupt and wrong-version are now distinct reports, nothing is deleted, and the unreadable bytes are copied once to `proxima.store.unreadable` before any write can reach them (the copy is never overwritten by a later bad read, so the first rescue is the one that survives). Verified by hand-writing corrupt JSON and a version 2 document. Remaining gap: the main key is still replaced by the empty state on the first mutation after a bad read, so recovery depends on the rescue copy. Blocking writes until the reader decides is the honest fix and is **still open** (see #19). |
| 18 | **Shape validation and unknown statuses.** The store trusted whatever it found: records that were not tasks or projects, references to projects that no longer exist, non-numeric weights, negative rows, impossible dates like `2026-13-45`, and statuses with no column to appear in — the last of which made a task countable in the header while rendering nowhere. | store.js | **Closed.** `normalise()` checks every record and field on read: unreadable records are dropped and counted, dates must exist (not merely match `\d{4}-\d{2}-\d{2}`), numbers are clamped, a vanished project reference reads as uncategorised, and a status the board cannot show is filed under Backlog — the one repair that is reported and visible, because the alternative is a task that is counted but never seen. |
| 19 | **A bad read still lets the next mutation write over the original key.** The rescue copy makes it recoverable, but the app does not stop writing, and a reader who never looks at `localStorage` loses the distinction between "my data is gone" and "my data is parked". | store.js | Open. The honest fix is to refuse writes until the reader chooses — restore, or start fresh and archive — which is a small UI decision, not a store one. |

---

## Open — from the Projects Hub

| # | Finding | Original | State here |
| --- | --- | --- | --- |
| 20 | **"Task projects" vs "schedule projects".** The original's Hub splits projects by `projectType`, with a tab for each and a different card for schedules — events, upcoming, active-today — because a schedule project runs calendar events rather than tasks. | `AgingView.svelte:74-75`, `258-274`, `361-431`; the type is chosen in `NewProjectModal`, `Modals.ts:251-255` | Deliberately out of scope: we have no schedule surface, no events store and no event model, so there is nothing for a schedule project to hold. The Hub ignores the split entirely rather than inventing half of it. **When the Schedule surface is built**, this is the first thing to settle: whether `projectType` becomes a stored field (a schema change, so a version bump and the #8 machinery matter) or whether a project is simply "whatever its items are". |
| 21 | **No project editing or visual identity of the reader's choosing.** The original edits the Hub's own header text, uploads a per-project icon, sets the global Hub icon, and resizes it by dragging a grip. | `AgingView.svelte:30-40`, `90-94`, `170-174`, `186-213` | Open. Our Hub derives a colour and a monogram from the project id instead, which needs no stored field and cannot be left half-configured. A reader-chosen icon would need a place to live (data URI in the project record, most likely) and a size control, which is the sort of thing to add once the identity scheme is actually wanted. |
| 22 | **A card's destination is a scope, not a workspace.** The original opens a project workspace in a central tab — the project's own surface, with the type chosen at creation. | `AgingView.svelte:115-118`, `166-168` | Deliberate for this round: clicking a card scopes the whole page to that project and says so. The right eventual destination is a **project workspace** — a per-project surface carrying its board, its timeline and its run, entered from the card. Scoping is the honest interim because it is real, reversible and invents nothing; see the report for the fuller argument. |

## Open — from the drag-feel review

| # | Finding | Original | State here |
| --- | --- | --- | --- |
| 9 | **No custom drag image, so there is no grab point.** The original clones the card at its true size, pins it under the cursor at the exact offset the user grabbed (`e.clientX - rect.left`), and outlines it. Ours lets Chromium snapshot the element, which centres the ghost under the pointer and picks its own scale and transparency. On a 540px card the thing under the hand does not correspond to the thing that was grabbed. | `ElasticView.svelte:333-349` | Open. Note the ghost keeps the card's full height; the 90px cap is the placeholder's, not the ghost's. |
| 10 | **The whole card is both draggable and a click target.** The original drags `.pos-card` but attaches the open-editor click only to the inner content div, so a press anywhere on the card body can still be read as a click after a wobble. Ours puts both on the card, so a near-miss drag opens the editor. | `ElasticView.svelte:504-519` | Open. |
| 11 | **No `dropEffect = 'none'` on a forbidden target.** The original sets it so the cursor itself says the drop will be refused. Ours returns silently, so a locked running column looks just as inviting as an open one right up until release. | `ElasticView.svelte:383-386` | Open. Related to the locked-plan refusal, which currently explains itself only *after* the drop. |
| 12 | **`dragend` always rebuilds.** Ours calls a full `render()` on every dragend, including an aborted one that changed nothing. The original only clears its local drag state. | `ElasticView.svelte:358-362` | Open. Cheap to fix; correctness is unaffected. |
| 13 | **The Gantt has no shift-resize of either bar edge.** Raised here as "no vertical axis" too, but row packing and vertical drag are now closed (see Closed below); what remains of this finding is the resize, which is #2. | `ProjectDeadlines.svelte:460-463`, `505-510`, `561-566` | Open as #2. Restated only to keep the review's wording traceable. |
| 14 | **The Timeline header does not pan.** The original is grab-to-pan; ours is zoom and Today buttons only. | `ProjectDeadlines.svelte:652-678` | Open. |
| 15 | **A purely vertical drag still moves an instant task sideways.** The original writes `newStartMs` from the pointer whether or not the gesture moved horizontally, so a zero-duration task dragged straight down is re-anchored under the cursor rather than staying put. We commit dates only when the horizontal displacement rounds to a non-zero day count, so a purely vertical drag leaves the dates alone — which is what the gesture asked for, and what makes row changes independently usable. | `ProjectDeadlines.svelte:590-608` | Deliberate divergence, not a defect. Recorded so it is not "restored" later. Still open for sub-day movement (#3) and bounded by day granularity (#5). |
| 16 | **Filtering leaves gaps in the timeline, it does not renumber.** Because a stored row is kept, filtering a project out leaves the rows it held empty — the visible bars keep their vertical positions and the grid keeps the height of the highest row in use. The original renders a flat 300 tracks, so it has the same property; ours just does not render the unused ones. | `ProjectDeadlines.svelte:64` | Accepted, and the reason stored rows are worth having: a bar returns to where the user put it. Worth revisiting only if gaps ever read as a bug rather than as spacing. |

---

## Test fixtures

`tsk_fixture_reversed` — "FIXTURE — reversed dates" — is a deliberately
contradictory task (start after deadline) left in the store on purpose, so the
invalid treatment is always visible on screen rather than only in a test. It is
labelled a fixture in its own name, because an unlabelled broken task was once
mistaken for real corruption.

---

## Closed

| Finding | How |
| --- | --- |
| **A failed write reported success** — in-memory state moved ahead of durable state and the reader saw a normal save | One mechanism, `commit()`, wraps every mutation: snapshot, apply, and roll the whole state back if the write fails. The change returns `null` so the board cannot render it, and `onWriteFailure` announces it once. Verified with the write refused: add / update / weight / delete all left memory and durable bytes untouched, nothing on screen, one sticky notice |
| **An unreadable store became an empty one with the bytes still there** | Corrupt and wrong-version are now reported distinctly (`wrong-version` is not corruption and will happen the first time the schema changes), nothing is deleted, and the unreadable bytes are parked once under `proxima.store.unreadable` where no later write can reach them. Verified with hand-written corrupt JSON and a version 2 document, each reloaded and each left byte-intact |
| **The store trusted whatever shape it found** — non-records, dangling project references, non-numeric weights, negative rows, impossible dates, and statuses with no column | `normalise()` validates every record and field on read; unreadable records are dropped and counted, impossible dates are refused, numbers clamped, a vanished project reads as uncategorised, and a status with no column is filed under Backlog and reported. Verified against a document containing all of those at once |
| **Projects were a filter dropdown and a button** — no place where a project's identity and its pressure could be seen together | The Projects Hub, a third section on the page: cards carrying name, description, derived age, task count, overdue count, P1 count, next deadline, archive state, and a warning when a project's own tasks contradict themselves. New Project through a modal, Archive / Restore / Delete with Delete confirmed by a dialog that names the exact consequence. Verified: every card's four derived numbers match the store and the board; two archived-test tasks orphaned to uncategorised on delete with their count stated before the reader agreed; cancel wrote nothing |
| **Archive state could have been a flag plus a filter** | One field, `archivedAt`: present means archived, absent means active. The Hub's "show archived" toggle only decides what is listed, so there is no second source of truth to fall out of step. Scoping is likewise derived from the filter control rather than mirrored in a variable — a copy was written, disagreed with the control, and was removed |
| **Gantt row packing** — the timeline was one row per task, a list with bars rather than a spatial surface | `ganttRow` is a stored field; packing places a task in the first free row, keeps a stored row unless it now collides, and resolves drops against what is already settled. Vertical drag is continuous during and resolves at 40px per row on release. Verified: overlapping spans never share a row, non-overlapping ones do, a colliding task yields while the others hold their rows, rows survive filtering, a finished task's row survives its return, re-rendering writes nothing, and filtered-out rows leave a gap rather than renumbering |
| Finished tasks appeared in all three panels | Excluded at the source of all three, `93c4b1b` |
| Calendar drew deadline-day chips, not start→deadline span bars | Rewritten as week-clipped span bars, `93c4b1b` |
| Calendar spans ran one day long | The three `+ DAY_MS` uses removed, `ec78d01` |
| Gantt bars ran one day long | Width is `deadline - start` with a 24px visual floor, `93c4b1b` |
| Dragging a startless task invented a `start` | First drag now materialises `start`; `createdAt` immutable, `5d74bad` — a deliberate divergence, see the comments at the write site |
| Countdown buckets used calendar-day differences | Rolling hours from now, `93c4b1b` |
| Countdown progress measured from `start` | Always `createdAt → deadline`, `93c4b1b` |
| All three panels could be switched off; composition not persisted | Last panel forced on, persisted through Store, `93c4b1b` |
| Bar tooltip claimed a startless task starts today | Reads the resolved span, `ec78d01` |
| Launching the app rewrote the store | `views()` is a pure read; `setViews` writes only on a real change, `ec78d01` |
| Invented collapsible countdown group headers | Removed; headers are plain non-interactive elements again |
| Surface sub-tabs that switched nothing | Removed; one page, `148803c` |
| Empty state rendered at the same time as the panels | `[hidden]` now wins over the component display rule, `148803c` |
| No validation that a deadline follows a start | Refused in the dialog, naming both dates; the stored contradiction is shown rather than corrected, `148803c` |
| Reversed spans were silently rewritten | `Math.max` clamp removed from `spanOf`; the span is reported as stored, drawn at its real deadline and flagged invalid in all three panels, `148803c` |
| **Lock did not lock** — the run re-derived allocation from live tasks every tick, so a weight edit or a task dragged into Running retroactively rewrote a frozen horizon | Lock now snapshots the plan: member ids, order, weights, durations and each slot's start/end instant. Allocation and progress read the snapshot only; participating cards are non-draggable with disabled steppers; drops into Running are refused, `ec78d01`-era integrity pass |
| A project filter (or a reload under a different one) redefined a locked run | The running column is built from the plan's roster, not from a status filter, so filtering cannot change membership and a reload cannot adopt another project's tasks |
| Locking with nothing running, and a run whose members all leave | Empty lock refused; the run ends with a stated reason when its last member leaves |
| A date-only deadline went overdue at 00:00 on its due date | Expiry is the end of the deadline day (`dayEnd`); urgency, the countdown timer and its progress all measure to it |
| Timeline clipped only the left edge, so a bar starting before the window kept its full width and appeared to end in the future | Width is clipped to the window alongside the edge, with a continuation arrow and a tooltip naming the real dates |
| **The Timeline bar snapped to whole days during the gesture**, leaving a dead zone from 3px to half a day where the bar had stopped tracking the hand; a wobble back to the origin counted as nothing; vertical movement was ignored | The bar follows the pointer in continuous pixels; pixels become days once, at commit; click-vs-drag is decided on final displacement in either axis |
| **The running column could not open a slot.** Its cards were `position: absolute`, so the in-flow drop placeholder could not push them and the column visibly refused the drop | Cards are ordinary flow items. Their inline heights are still written from `max(125, (w/totalWeight)H)` — `flex-grow` was tried and rejected because each item's 125px floor skews its share (weights 6/3/1 over 900px gave 416/271/174 where the formula wants 540/270/125) — while the column's own height is definite and independent, so H stays stable. The placeholder also needed `flex: 0 0 auto` or the overflowing column crushed it from 90px to 2px |
| Drop placeholder sized to the card's full height, tearing a 250-540px cavity into the destination list | Capped at 90px, as the original caps it |
| No edge autoscroll, so a column taller than the viewport stopped coming to meet the hand | 8px per dragover within 60px of the top or bottom edge, applied before the insertion index is resolved |
| **A refusal used to be a full-width red banner**, and the guard around a reversed task refused *every* drag of it — a gesture that could never succeed, explained only after it failed | The guard is gone: `(end + k) - (start + k) === end - start` exactly, so a drag cannot change validity either way, and a reversed bar keeps its invalid treatment wherever it lands. Every refusal now uses one quiet mechanism — a small chip near whatever was touched, gone after five seconds — with wording that names the task and says what to do. Reversed bars take a pointer cursor and a tooltip that says so before the gesture |

