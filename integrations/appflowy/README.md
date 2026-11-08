# Full AppFlowy blob template

The active template opens the original full AppFlowy application hosted privately on BOP. See [deployment status](STATUS-20261019.md) for setup and current evidence. AppFlowy owns pages/databases; Proxima stores and syncs only the blob-to-workspace binding. Personal device sessions travel through the authenticated BOP exchange.

## Previous editor documents

# AppFlowy document template

Uses the official MIT-licensed @appflowyinc/editor 0.1.13 library, not an AppFlowy Cloud deployment. Proxima owns blob bindings and the existing workspace causal journal owns documents. This first template provides the editor's rich text, lists, code and simple tables; it does not claim AppFlowy's database/AI/team workspace features.

Build: `npm ci --prefix integrations/appflowy --legacy-peer-deps --ignore-scripts`, then `node integrations/appflowy/build.mjs` (esbuild from the adjacent Papers checkout). Upstream declares incompatible i18next peer ranges; the lock pins i18next 23.16.8 for react-i18next 14.1.3. Other peers are explicitly pinned. No install scripts run.

Document contents live separately from calendar records in `workspaceEntries` with workspaceId `blob-documents`. Each saved content has an opaque revision. The existing journal CAS, causal exchange and conflict retention apply. Browser editing requires BOP; installed devices keep local journals. Pending drafts remain in origin-local recovery storage and are never silently submitted over a competing revision. Removing a template or blob retains its document.
