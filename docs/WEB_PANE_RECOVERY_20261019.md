# Public As you Go pane recovery — 2026-10-19

Continuation of Claude's **Rollout plan review**, session `76c196ab-aa1e-4429-b168-d0f527f040d4`, which stopped while checking dragged uploads, wrong first-folder selection and a BOP restart.

## Ownership and correction

AYG continues to own its pane, drop handlers, placement targeting, selection and file pictures. The public adapter transports registered browser files and checked workspace saves. It does not infer a destination from the first rendered row or capture document-level drops.

Proxima prepares the template in advance, then creates one live iframe in the visible pane. Chrome repeatedly left an iframe created under the hidden pane at about:blank; a static iframe and visible-on-open iframe loaded correctly. Subsequent openings reuse that one live frame. Folder readiness names both the folder and a unique navigation request. A cover prevents exposing the previous folder or accepting drops there. New openings cancel old requests, including child folder retry loops. Child render acknowledgement has a timer fallback because animation callbacks can be suspended in hidden frames.

The browser adapter answers stat for its own not-yet-uploaded file. A successful BOP save returns canonical document bytes with managed file identities, which the coordinator installs before the next edit. Otherwise the next save can resubmit a temporary browser upload path despite a successful first save.

Public browser panes save independently through BOP's existing serialized, revision-checked owner. Browser Web Locks and BroadcastChannel cannot arbitrate other public origins/devices and can strand a follower behind a suspended older page. Native AYG retains its existing coordination. Early web saves wait for initial coordinator hydration; they cannot forward into an absent browser writer channel and later time out. Conflict controls are visible in the web surface, and an unsaved version is retained. API retries cover short network/server interruptions; no console warning interception or unconditional reload discards pending edits.

## Deployment

No-admin versioned server root: `C:\PapersServer\App`. Data: `D:\PapersServer\Data`. Current selector: `current.txt`; supervisor restart request: `restart.request`; recovery mirror: `D:\PapersServer\App`.

Deployed version `app-20261019-100608`, receipt success at `2026-10-19T03:06:11.8739611Z`. Package SHA256 `53bce15ebe056713e74baba157a644607045d04558faf08a75252c129e0cb40e`. Seven overlaid files match the C: installation and D: recovery mirror. Existing host bundle, previews, tools, server identities, public keys and user data were preserved. Both established public origins use this server. Desktop native installations were not replaced in this continuation.

## Evidence

- Proxima: `node --test blob-folder-navigation.test.mjs blob-template.test.mjs portal-ayg-host.test.mjs` — 8 passed.
- AYG: `node --test workspace-surface-coordinator.test.mjs blob-workspace-history.test.mjs` — 85 passed, including host-canonical identity before a second save.
- Headless build and whitespace checks passed.
- Live Chrome: correct first-folder opening, switching between đồ án q1 and bài tập 6,7,8 tin học, and actual AYG controls in automatic PC and touch modes. Automatic PC mode restored afterward.
- Real tus upload, checked save, canonical identity, second checked rename and matching-byte download before and after an explicit server process restart.
- Restart at `2026-10-19T03:08:58.824Z`: listener PID 4424 → 8344; fresh ready status `03:08:59.407Z`. Existing browser pane stayed open and showed the after-restart upload without a page reload.
- Local receipts and continuity record are in the task workspace under `verification-20261019` and `CLAUDE_RESUME_20261019.md`. Capability URLs and account credentials are excluded from this document.

Chrome's automation extension blocked selecting a local test file because its **Allow access to file URLs** permission is disabled. Thus the actual stored-byte checks used the upload/save API, while the browser dropped-file adapter was covered by focused tests. A physical OS-to-browser drag and physical Android/iOS acceptance are not claimed. No Windows reboot or complete four-device convergence check was performed.

All seven verified Claude/Codex test markers have every placement in the recoverable workspace Bin; zero remain active. The Bin was not emptied. BOP cleanup receipt is timestamped `2026-10-19T03:16:55.1346443Z`. The temporary delivery listener and empty tus probe upload have been removed. Final receipt locations are recorded in the local continuity file.

### Upload disappearance follow-up

Installed `app-20261019-110808` on BOP at 04:08:11Z. Fixed browser stale-save handling which previously retired later queued drops. Upload additions rebase narrowly onto fresh owner bytes; deleted destinations and unrelated field edits are not replayed. Transport failures retain the pending version. 88 coordinator checks passed. User's missing second image was recovered from the original D:\sort\a4 file through the actual AYG command/store/coordinator/browser adapter and real tus client, then freshly loaded and downloaded with matching bytes. See verification-20261019/recovered-user-upload.json. Physical OS drag after final deployment has not been independently automated. No user files were binned or deleted.
