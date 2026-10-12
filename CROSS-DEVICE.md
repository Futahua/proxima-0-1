# Cross-device data checkpoint

2026-10-13. The complete experience is specified by Papers' cross-device plan.
Each machine retains its own Proxima facts and writer. Remote views are read-only;
copy/import/follow must go through the receiving machine's `Store.command`.

`Store.remoteProjection` now serializes a read behind the existing command queue
and uses the existing IndexedDB persistence owner and origin-wide lock when
available. It returns a coherent source sequence and one observation timestamp.
It does not copy database files, create another writer or append a command/event.

`public/remote-domain.js` allows approved project/task/schedule/session/activity
fields only. Unknown fields, native handles, credentials, layout/order positions,
cockpit preferences, command memory and undo history are excluded. Explicit task
selection includes its project without importing that project's other tasks;
explicit project selection includes its tasks/calendar entries. Selecting an
activity includes its sessions. A queue member includes its row and all queue
members, preserving names, weights, colors, end and ordered relationships.
Frozen run members whose original tasks are gone remain named standalone source
snapshots, rather than making a historical run unreadable.

The independent import candidate qualifies IDs by source device, Backpack,
record kind and stable copy identity. Relationships use those same IDs. It freezes live/queued intervals
at the owner-calculated observation time, retains source queue relationships in
lineage and removes active local queue links. It is a preview candidate, not a
second running timer. Imported frozen runs are archived in `importedRuns`, which
never replaces the receiving machine's existing active run. Follow remains explicit.

`remote.import-stage` saves the approved request through this command owner.
`remote.import` validates the whole graph, then commits records, lineage, import
receipt and one event in the existing atomic persistence transaction. Failed
writes roll everything back. An approved request survives restart; its snapshot
cannot be substituted before or after commit. Durable receipts deduplicate
retries even after command-memory pruning. Separate explicit copies receive
separate identities. Existing local records, active run and layout are retained.

The manifest explicitly declares read sharing. Papers requires a separate device
grant for Proxima and routes snapshots to the live renderer's Store owner. Closed
or unready owners report unavailable; Papers does not open IndexedDB itself.
The same device view presents read-only facts on PC and Android. PCs preview
selected/all dependencies before approval; interrupted approved copies can be
finished from the saved request. Phone views expose no edit/import controls.
Catalogs and snapshots are cached for honest offline reading. Project and calendar
headers both expose Devices. Completed imports refresh the existing local view.

Checks use the real Store in isolated VM data, including latest durable reads,
pending-write ordering, exact approved values, private-field exclusion, project
and queue dependency closure, missing dependencies, source-qualified identities
and frozen live times. `node --test remote-domain.test.mjs exact-timeline.test.mjs`
passes 31 checks, including the existing timeline suite and import transaction,
rollback, durable receipt, staged-request and source-run tests.

A real two-instance Electron fixture verifies host pairing, data-only grants,
snapshot through the live owner, device UI, selected task/project preview and
atomic IndexedDB import. Reload retains exactly one graph. This is two isolated
profiles on one PC, not laptop acceptance. The actual Android client passes live
owner facts/read-only UI and, after listener retirement, cached catalog/facts/UI.

Not yet complete: explicit follow/conflicts/deletions, change-stream/reconnect
acceptance, full calendar/timeline presentation of remote views, actual creator
locations and deployment of this Proxima source to the laptop. No creator
Proxima database has been modified by the isolated checks.
