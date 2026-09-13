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
| 1 | **Gantt row packing.** The original packs tasks into non-overlapping rows, supports vertical drag with collision resolution, and persists `ganttRow` across at least 300 available rows. We draw one row per task. The reviewer's summary: "the original Gantt is a spatial scheduling surface; the rebuild is basically a task list with horizontal bars." | `ProjectDeadlines.svelte:16-57`, drag/collision persistence `557-594` | Deliberately deferred; `ganttRow` appears nowhere in our code. The largest single piece of missing Timekeeping behaviour. |
| 2 | **Shift-resize of either bar edge.** The original resizes a bar's start or end with a modifier. | `460-463`, `505-510`, `561-566` | Not built; `shiftKey` appears nowhere. Whole-bar movement only. |
| 3 | **Pixel/time-based bar movement.** The original moves a bar in continuous time (`newStartMs = zeroMs + newLeftPx / ganttZoom * 86400000`); we round displacement to whole days. | `542-550` | Open. Sub-day precision is unreachable while the store keeps dates as `YYYY-MM-DD` — see #5. |
| 4 | **Configurable colour rules.** The original evaluates a user-configurable `colorRules` set at render time, affecting calendar, timeline and countdowns. We hardcode urgency bands. | `142-161` | Open, and knowingly a placeholder: `URGENCY_COLOR` carries a comment saying it stands in for the rules system. |
| 5 | **Day-granularity deadlines.** We store `deadline` as `YYYY-MM-DD`; the original does arithmetic on whatever timestamp its model supplied. Countdown bucket maths is now faithful, but identical sub-day semantics cannot be proven without the original's task schema. | store.js | Open question, not yet a decision. Blocks #3. |
| 6 | **Persisted calendar/countdown column resizing.** | `84-122` | Not built. |

## Open — not from a review

| # | Finding | File | State |
| --- | --- | --- | --- |
| 7 | **A failed `localStorage` write reports success.** `save()` returns `{ ok: false, reason }` on a quota or security failure, but every mutating method ignores the return value and the caller sees a normal success. The in-memory state is ahead of durable state and nothing tells the user, so a full disk or a blocked origin looks exactly like a working save until the next load. | `store.js` — `save()` definition, and every call site: `addProject`, `addTask`, `updateTask`, `deleteTask`, `moveTask`, `setRun` | Open. Not fixed this round, by instruction. |
| 8 | **An unreadable or wrong-version store is silently replaced with an empty one.** `load()` catches every parse failure and returns `structuredClone(EMPTY)`, and rejects any document whose `version !== 1` the same way. Corrupt JSON, a truncated write, or a future schema all present as "you have no tasks" — data loss reported as an empty app, with the original bytes still sitting in `localStorage` unread. | `store.js` — `load()` | Open. Not fixed this round, by instruction. |

---

## Closed

| Finding | How |
| --- | --- |
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

