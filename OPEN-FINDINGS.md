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

Verified against the working tree at `148803c` unless noted.

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

| # | Finding | State |
| --- | --- | --- |
| 7 | **No validation that a deadline follows a start.** A task can be saved with Start 09/15 and Deadline 09/13. Nothing refuses it. | In flight. |
| 8 | **Reversed spans are silently rewritten.** `spanOf` returned `end: Math.max(start, end)`, so a contradictory task rendered as a plausible one-day block at the wrong date instead of showing that it is impossible. The original preserves the real timestamps and clamps only the *rendered* width. | In flight. Flagged in review 1 and dropped — the reason this file exists. |

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
