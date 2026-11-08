# Optional blob templates and offline As you Go workspaces

Research and implementation proposal, 2026-10-17. No feature implementation or
installation is represented by this document. This is a proposal, not a second
governing document.

Revision after creator review: this is a three-device file-synchronization
product with a workspace interface, not merely an embedded pane. The accepted
implementation direction is reuse of Proxima's causal sync plus version ancestry
and existing Papers byte transfers. Automerge/Yjs remain research references,
not planned dependencies. The earlier open engine choice below is superseded.

## Confirmed experience

- Ordinary timeline blobs stay lightweight. A creator chooses a template to give
  a particular blob content. As you Go is the first template, not the definition
  of every template.
- Choosing As you Go creates a workspace bound specifically to that blob.
  Opening the blob opens its file pane; the timeline does not contain a permanent
  file pane inside every bar.
- Files imported into this workspace become independent managed copies. Their
  original files remain where they were and are not enrolled in synchronization.
- Workspace organization and managed files replicate to SlopTop, LapDog and
  Poordroid. Each device retains local files for offline use after receipt.
- Changes to managed files propagate automatically. PCs observe external saves;
  Android checks on editor return, app resume and scheduled reconciliation when
  notifications are insufficient. Editing offline is supported; reconnect must
  preserve competing edits. No promise of immediate detection while Android has
  suspended or stopped the app.
- The earlier question about copying a blob was hypothetical. Inspection found
  no explicit local timeline duplicate command; remote selective-copy/import is
  a separate feature. This proposal does not add blob copying as a prerequisite.

## Existing code and the missing capability

Proxima already separates activity rows from session/blob identities. Bind to the
session's stable identity, not its name, time range, row, queue position or current
device. `public/store.js` owns commands and history; `public/sync-core.js` and
`public/proxima-sync.js` carry causal context, conflicts and human/automatic
provenance. `public/remote-domain.js` exports an explicit field allowlist, which
does not currently include template bindings.

Papers' `src/main/backpacks/backpackProjectService.ts::workspaceScope` can provision
a deterministic AYG group through an explicitly declared workspace host. AYG's
`public/workspace-scope.js` restricts a surface to records in that group. This is
useful embedding infrastructure, but remains a view into a complete canonical AYG
document. It is not an independent offline replicated workspace.

AYG's `public/app/workspace-store.js` and
`public/app/workspace-surface-coordinator.js` coordinate local surfaces through one
writer and checked document revisions. Remote panes follow the physical owner.
These protections should remain; copying whole AYG snapshots between three
independent writers would not produce the requested offline behavior.

Papers already owns device authentication, USB transport selection, resumable tus
transfers, checked file identities and remote edit sessions. Reuse those owners.
The current exclusive remote editing assignment cannot be mandatory for editing a
local managed copy offline. Workspace replication needs a separate lifecycle while
using the same file and transport capabilities.

## Recommended boundaries

1. **Proxima owns the binding.** Add a small versioned template reference through
   `Store.command`, with stable template-instance and workspace identities.
   Include it deliberately in persistence, normalisation, history, ordinary sync
   and remote projection/import. Bind creation is idempotent: a crash/retry or two
   reconnecting views must not create duplicate workspaces.
2. **A template registry owns presentation.** Initially support the unpopulated
   state and As you Go. Give templates a versioned mount/unmount contract; avoid
   special-case AYG state inside timeline geometry. Mount the existing file-pane
   implementation on demand and dispose its subscriptions when closed.
3. **AYG owns organization and interaction.** Reuse its files, folders, placements,
   authored icons, selection, native path navigation and Bin behavior. Prefer an
   independent document per template workspace, exposed through a persistence
   adapter, rather than enrolling the creator's entire existing AYG board.
4. **Papers owns local files and replication work.** Each device has a managed
   workspace root and stable local file bindings. Replication must survive pane
   closure and process restart; an open iframe cannot be the sync scheduler.
   Android needs a supported persistent work/service lifecycle and durable file
   access, not an assumption that a WebView stays running indefinitely.

Names and paths are attributes, not identities. An entry has one logical ID;
the devices have different local native paths for it. Binary versions carry
content hashes and parent version IDs. Metadata carries durable operation identity
and causal context. Runtime window IDs, credentials and local paths stay local.

Queueing/reordering/moving a blob preserves its binding. Queue members retain
their individual workspaces even when drawn together. Removing a template or a
blob must not silently destroy its files: retain a recoverable detached workspace,
and let undo restore the binding. A future true split/copy operation needs an
explicit workspace-reference rule before implementation; it must not infer one
from matching names.

## Offline edit and recovery rules

| Reconnect situation | Required result |
| --- | --- |
| Only the phone changed version A to B | B propagates to unchanged replicas. |
| PC and phone independently changed A | Preserve both heads and both files; expose a compact conflict choice. No clock-selected destructive overwrite. |
| Two devices produced identical bytes | Deduplicate content; retain the causal acknowledgements. |
| One device deleted an entry while another edited it offline | Keep the edited bytes and show the delete/edit conflict; retain recoverable deletion state. |
| Phone disappears, permission is lost, a disk fills, or a scan fails | Mark that replica unavailable/pending. Do not infer deletion or report three-device completion. |
| USB disconnects mid-transfer and Wi-Fi reconnects | Resume the existing durable job against the same device identity; no duplicate import. |
| Receiving app crashes after bytes arrive but before acknowledgement | Retry safely through verified content and idempotent publication/receipts. |

Version ancestry decides whether an edit follows another or is concurrent. An
offline device cannot know whether another disconnected device is editing too;
offline availability therefore requires preserving and resolving divergence.
Word/CAD files are opaque binaries here, not automatically mergeable documents.

Human commands keep explicit provenance. Timers, scans, reconciliation and sync
delivery do not become new human intent. A file observed changing in an external
editor is an observed content revision; the watcher must not falsely claim to
know whether a human or another program wrote it. Reapplying a received revision
must not manufacture another edit or create an echo loop.

Import takes a stable snapshot or retries a changing source. Publication uses
verified temporary content followed by checked replacement; open/locked or locally
changed destinations stay pending or branch instead of being overwritten. Metadata
arrival and content arrival are separate: show pending content until the verified
local file is usable. Native local paths resolve to the local replica.

Ordinary unlinking removes the representation. Explicit skull remains confirmed
and recoverable through the Bin; it creates a replicated recoverable deletion operation,
not an immediate permanent purge of all copies. Retain versions/tombstones needed
by offline peers, pending jobs, conflict resolution and Bin. Workspace content
edits have no undo history; only blob/template binding changes enter timeline
undo. Existing standalone AYG undo remains unchanged. Garbage
collection requires an explicit retention policy and device acknowledgement or
deliberate device retirement. An old returning device must not resurrect a purge.

Website links replicate their references. Applications and native windows need
device-local resolution; importing one does not imply copying installed programs
or a running window to Android. Imported folders require recursive managed copies
and path/case-collision handling, without following links outside the import scope.

## Research and engine choice

| Candidate | Useful contribution | Limitation for this feature |
| --- | --- | --- |
| Existing Proxima causal sync | Already carries human/automatic provenance and retained concurrent values. | Its record model is Proxima-specific; it does not replicate managed binary files or AYG organization. Reuse contracts before considering extraction of a generic engine. |
| Automerge Repo | Local persistent structured documents, offline edits, storage/network adapters, retained same-field conflicts. | Generic deterministic convergence does not supply our human-authority policy, file publication, Bin or conflict UX. Android background ownership and AYG history integration need a spike. |
| Yjs subdocuments | Stable document GUIDs and lazy loading suit independently opened template instances. | Provider support varies; binary files and application-specific conflict semantics remain separate work. |
| Syncthing | Mature file scanning, block reuse, verified temporary files and conflict copies. | File canonical-name selection uses modification time/device ordering; default versioning is off and only archives incoming replacements. It does not own AYG records, template binding or undo. A second daemon also requires Android lifecycle and transport integration. |
| Existing tus transfer owner | Resumable verified byte delivery with current pairing and USB routing. | It is transport, not a directory synchronizer or conflict-resolution engine. |
| Joplin architecture | A useful precedent for separate offline structured items, resources and transport drivers. | It is reference architecture, not a drop-in AYG engine. |

Accepted direction: extend Proxima's existing causal core to workspace records,
retain checked single-writer AYG application on each device, and reuse Papers'
transfer/authentication/USB owners. File versions are immutable records with
content hashes and parent version identities; current heads derive from ancestry,
not a last-writer current-version field. Conflict resolution creates a version
that acknowledges all resolved heads. A merge can therefore have multiple parents.
The graph rules are compact; stable capture, durable scheduling, verified atomic
publication, locked-file handling and Android lifecycle remain substantial work.
Revisit a new engine only after a specific failed test proves the existing core
cannot meet a requirement without unreasonable complexity.

SlopTop is the preferred rendezvous/relay while reachable, not the truth owner.
Any two paired devices can exchange directly when it is away. Relaying retains
original operation/version IDs and acknowledgements; receiving on SlopTop does
not imply receipt on the third device. The protocol must converge despite duplicate
delivery through both routes. Reuse existing pair discovery and transport selection
rather than creating a new hub server.

Future always-on server assumption (creator clarification): allow an additional
durable, authenticated replica/relay with the same workspace protocol and stable
identity. Initially SlopTop can fill the preferred-relay role; adding a dedicated
server changes that preference, not document ownership or merge semantics. No
server is required for local editing or paired direct exchange.

The server retains original operation IDs/provenance, version ancestry, recoverable
deletions and verified content. It may assign a receipt sequence for audit and
incremental catch-up; receipt order is not authorship, causal ancestry or conflict
authority. Its acknowledgement proves only its own durable receipt, not that all
three user devices have received the version. Content-receipt acknowledgement is
separate from metadata receipt. Retention still accounts for offline members and
explicit device retirement; the server must not silently purge their required
history. Restore a server with its durable peer identity and journal, rather than
pretending a new identity has acknowledged the old journal. Test server outage,
restart, delayed catch-up and duplicated direct/relay delivery in the same proof.

Each replica must commit workspace records, causal stamps and pending delivery
state together, or use a recoverable write-ahead transaction. Reusing the merge
core does not make separate state/stamp writes crash-atomic. A server cannot
recover an offline edit that the authoring device never durably recorded. A
replica restored from backup must not advertise acknowledgement vectors beyond
the records/content actually restored. This is part of restart acceptance, not a
reason to add another merge engine.

Do not run two independent synchronizers over the same live files or replicate a
running SQLite database/whole state.json through a folder daemon. Syncthing remains
research context; the accepted implementation uses the existing Papers transfers.

## Implementation sequence and acceptance

1. Add the optional template binding and lazy AYG pane on one device using disposable workspaces.
   Verify blank blobs remain unchanged, separate blobs stay isolated, and queue,
   rename, move, undo and reopen preserve the correct identity. Include saved locally,
   waiting for a device, failure and conflict status from the beginning.
2. Alongside the local pane slice, prove the existing sync core and version graph
   with three durable isolated replicas and the real Android runtime: concurrent
   metadata edits, skewed clock, offline file branches, deletion/edit, Bin restoration,
   restarts, duplicate/relayed delivery and interrupted publication. Exercise Android
   with the presentation closed/backgrounded; recovery after system stop must work.
3. Add managed copy import and real local opening. Verify originals are independent,
   local outside-Papers saves are observed, all three local copies hash-match after
   convergence, and device-specific paths never leak into logical identity.
4. Wire durable background replication through current transports. Exercise phone
   USB on each PC, disconnect/reconnect, Wi-Fi fallback, no third-device availability,
   low storage, lost permission, app kill, locked files and large-file resume.
5. Finish pane integration and refine conflict choice and per-device availability.
   Saved locally, waiting for another device, fully replicated and conflict are
   distinct states. Reuse the silent transfer UI; do not dim a usable local pane
   simply because a peer is offline.

Acceptance requires real end-to-end offline edit/reconnect checks on SlopTop,
LapDog and Poordroid, with both competing byte versions verified after restart.
Unit convergence or an HTTP upload test alone does not establish that result.
No existing creator files or global AYG board should be migrated during the spike.

## Source proof progress (not installed acceptance)

The first isolated source proof reuses `sync-core.js` through a configurable domain
factory; no Automerge/Yjs dependency was added. `workspace-domain.js` models immutable
content/delete versions, ancestry-derived heads, same-byte deduplication, recoverable
deletion state, explicit multi-parent resolution and availability labels. Checkpoint
tests cover three device replicas plus an optional fourth server relay, offline
competing saves, a skewed phone clock, restart, duplicate delivery and a returning
stale replica. These are model/checkpoint tests, not real Android background work,
file transfer, physical Bin restoration or an installed template pane. Those real
acceptance checks remain outstanding.

Initial validation: Proxima `node --test` passed 91 tests. AYG `npm test` passed
34 pretests and 2,107 suite tests; two new opt-in no-history tests are included in
that suite. Template command tests cover persistence, idempotency, stale-revision
refusal, separate workspace IDs, rename/reorder, undo/redo and validated remote
projection. No source changes have been installed, committed or pushed in this
prototype work. The new domain is not connected to production byte transfers or
Android background jobs, and no pane is yet mounted by the template binding.

## Primary references consulted

- [Automerge offline network sync](https://automerge.org/docs/tutorial/network-sync/)
- [Automerge repositories and adapters](https://automerge.org/docs/reference/repositories/)
- [Automerge conflict semantics](https://automerge.org/docs/reference/documents/conflicts/)
- [Yjs subdocuments and provider responsibilities](https://docs.yjs.dev/api/subdocuments)
- [Syncthing synchronization and conflict handling](https://docs.syncthing.net/users/syncing.html)
- [Syncthing versioning limitations](https://docs.syncthing.net/users/versioning.html)
- [tus resumable-upload protocol](https://tus.io/protocols/resumable-upload)
- [Joplin offline synchronization architecture](https://joplinapp.org/help/dev/spec/sync/)
- [Android durable document access](https://developer.android.com/training/data-storage/shared/documents-files)
- [Android background data-transfer choices](https://developer.android.com/develop/background-work/background-tasks/data-transfer-options)

The prior repository rule keeping Proxima project pages separate from AYG remains
historical context. The creator's new request authorizes optional blob templates;
it does not call for restoring automatic project-wide embedding or enrolling the
existing global AYG board.
