# Optional durable replica

This is Proxima's durable server adapter. Papers supplies its existing authenticated
device gateway, resumable transfer engine and native workspace storage. An optional
public browser portal uses the current calendar UI and command owner. No Electron
process, desktop session, independent sync rules or whole-copy replacement is used.

Build with Node 22 or newer:

```
node server/build.mjs <absolute Papers source checkout> <absolute As-you-Go source checkout>
node --test server/replica.test.mjs
node server/dist/main.mjs <dedicated absolute data directory>
```

The directory must be private to the service account. Keep it out of Syncthing and
SMB shares. The native gateway listens on the Tailscale interface, port 48240.
Loopback port 48241 is reserved as an OS-owned singleton guard; it exposes no data.
The existing same-account admission policy applies. Tagged nodes are not supported
by that policy. Enable Tailscale unattended mode on Windows before relying on a
server outside a signed-in desktop session.

The server waits and retries if Tailscale is not available at startup. status.json
reports binding readiness only; it does not assert content completeness, backup
success or user-device acknowledgement. Original stamps, file ancestry, recoverable
deletion and received acknowledgements remain in the checked native journals.
No automatic retention pruning is enabled. Watch capacity growth.

Peers use the ordinary Proxima sync exchange and existing file-transfer mechanism.
The private relay is passive: a user device must connect to exchange. Direct device sync
and local editing remain available when it is offline. Discovery/enrolment on each
user device must be verified; an installed process is not proof of end-to-end sync.

Do not copy the data directory while writes are active and call it a consistent
backup. Quiesce the service, await journal flush, then snapshot/copy records,
content, device identities/grants and configuration together. Restore to an
isolated directory before relying on recovery. No offsite backup or retention
policy is provisioned by this package.

Current checks cover original-stamp retention, duplicate exchange, restart/catch-up,
and persistence of missing-byte status. Power loss, complete real-device transfer,
Windows boot persistence and loss/reconnect require installed acceptance evidence.

## Optional public workspace

The public listener is disabled unless the dedicated data directory has portal.json
with enabled:true, a random 43-character base64url key, an HTTPS origin and a port
(48242 by default). It binds only to 127.0.0.1. Expose only this listener through
Tailscale Funnel. Never expose the private gateway publicly.

The loopback portal can also be published through another standard HTTPS tunnel.
Set origin to its fixed HTTPS origin; optional allowedOrigins is an explicit list
of additional HTTPS origins accepted for browser requests and tus uploads. BOP's
current public route uses a reserved zrok name and the native zrok agent under a
SYSTEM boot task after Funnel public DNS failed. Keep tunnel credentials in the
native service account profile. Do not replace this with a second calendar store.

The persistent /s/<key>/ link opens the full calendar and blob editor, folder browser,
and resumable attachment upload/download. Its holders have edit access without
accounts. Browser commands use Store.command and the existing causal journal; files
use native managed imports/publication. No separate authoritative browser store is
created. BOP must be reachable to save browser edits. Keep the key out of source
control; rotate it to revoke a link. A portal startup failure leaves private sync
running and is recorded in portal-status.json.

Deployment, research and evidence: Proximate/PUBLIC_PROXIMA_WORKSPACE_20261018.md.

The browser blob pane serves the original AYG public renderer. portal-workspaces.js is a transport adapter loaded before the original blob-workspaces.js; it must never replace it with a second file-list presentation. Browser host bridges activate only when ProximaBrowserHost is present. Connections/input options live in the existing clock menu. Managed identities, checked revisions, native imports, immutable versions and resumable tus uploads remain the existing owners.
