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

The independent import candidate qualifies IDs by source device, Backpack and
record kind. Relationships use those same IDs. It freezes live/queued intervals
at the owner-calculated observation time, retains source queue relationships in
lineage and removes active local queue links. It is a preview candidate, not a
second running timer and not a committed import. Imported frozen runs must not
replace the receiving machine's existing active run. Follow remains explicit.

Checks use the real Store in isolated VM data, including latest durable reads,
pending-write ordering, exact approved values, private-field exclusion, project
and queue dependency closure, missing dependencies, source-qualified identities
and frozen live times. `node --test remote-domain.test.mjs exact-timeline.test.mjs`
passes 24 checks, including the existing timeline suite.

Not yet implemented: Papers grant/transport dispatch for this projection, remote
UI and change subscription, atomic receiving imports, explicit follow/conflicts
and deployment of this Proxima source. No creator database has been modified.
