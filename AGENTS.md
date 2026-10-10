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
