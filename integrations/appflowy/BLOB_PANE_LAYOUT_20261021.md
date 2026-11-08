# Blob pane layout — 2026-10-21

## Accepted behaviour

- Desktop blobs containing As you Go and AppFlowy use Papers' existing native pane coordinator, with the file view as a document panel and AppFlowy as a native tab. AppFlowy retains its own upstream UI and page identity.
- Template selection uses the existing window-picker icon in each group's tab strip. The same strip contains the blob workspace close button; the former separate template/header strip is hidden.
- Ordinary template/group drags stay within the blob workspace. Shift-drag permits transfer into the surrounding Papers layout. Internal groups follow workspace open/close through their existing native owner; transferred windows belong to their destination.
- Root pane resizing and internal split boundaries remain distinct. Native root-edge observations update the blob pane width; explicit blob root geometry clears the native controller's retained left-edge offset. Blob root rectangles use explicit dimensions rather than physical-host right/bottom anchors.

## Owners and implementation

- `public/blob-pane-layout.js` adapts Proxima's template bindings and lifecycle to the shared composition renderer.
- AYG `public/app/coordinated-window-slices.js` and `native-window-tabs.js` remain the shared renderer sources. `tools/build-blob-layout.mjs` builds them into `public/blob-pane-coordinator.js` and shared styles into `blob-pane-native.css`, served from Proxima's own permitted origin. Rebuild these generated assets after shared source edits.
- Papers `programWindowService` launches the installed program; `chromePaneBridge.programOpen(..., layout=true)` attaches/selects it in the caller's mounted layout. Native checkpoints remain the topology owner.
- `nativePaneBridge.dragOverlay(..., local=true)` suspends only the source blob scope. Suspending every scope previously hid Proxima's own containing document, exposing the outer Papers drop target. Local transfers refuse a different destination scope; Shift removes that restriction.
- Pointer shields clear on capture-phase drop/dragend and on the shared controller's completion/cancellation callback. Bubble-only cleanup previously missed handled drops and left the whole AYG iframe with `pointer-events:none`.
- Tab insertion uses the hovered tab's midpoint and canonical group order, supporting both before and after placement for document/native tabs.

## Delivery and evidence

Installed on SlopTop through the NSIS installer and existing `host:app:reload` save barrier; no publication/version increment. App/Data remain siblings. Stage and rollback assets: `D:/Programs/evTEMP/proxima-pane-layout-20261021`.

Installed host ASAR SHA256: `B1DECFF272F69E14F0E82F041C2732641C2621F27577C637E2052F788489AEE1`, matching the refined installer package. Later pointer-shield/tab-insertion edits affect generated public assets only and were activated through normal save/reload.

Electron/Vite build and native C# compilation succeeded. Full TypeScript checking reports an existing error in untouched `src/main/hostFacade.ts:855` (`string | undefined` passed as `string`). No test suites or synthetic input were run.

Read-only live inspection after creator interactions showed two internal groups, both template tabs, the old header hidden, picker labelled “Blob templates”, and the content's left edge aligned one border pixel inside the blob pane. A subsequent inspection identified the stuck `blob-layout-dragging` class and `pointer-events:none`; that cleanup and after-tab insertion were then corrected. Do not describe all drag/resize gestures as acceptance-tested.

These changes are installed on SlopTop only. Phone/browser AppFlowy paths and BOP services were not changed by this work. No credentials, documents, or template bindings were migrated or deleted.

## Duplicate edge correction

Creator reported shaking when dragging narrow left edges. Live inspection found the shared document panel's six-pixel left root edge in addition to Proxima's whole-workspace handle. ResizeDocumentEdge can author the native root left boundary, which competed with the blob root geometry. In rootBoundary mode the shared renderer now hides and refuses pointer-down on document edges coinciding with the outer left boundary. Internal split edges and AYG's preview divider remain active. Generated asset installed on SlopTop through normal save/reload; no drag tests run.

## LapDog delivery and desktop shortcuts

2026-10-21: Installed the same refined Papers NSIS package on LapDog at C:/Users/admin/Documents/Papers/App. Installer receipt confirms ASAR B1DECFF272F69E14F0E82F041C2732641C2621F27577C637E2052F788489AEE1; all seven Proxima public assets match source SHA256. Native AppFlowy fork installed under Papers/Programs/AppFlowy, executable FDBA56D3507702DE1AE4403AE06208233B02054301448338BDE76838437146B9; existing profile retained, template points directly to this executable and accepts workspace/page targets. Native login/drag acceptance not claimed. Papers running PID40604 at receipt. Stage/old assets/shortcut backups: C:/Users/admin/Documents/Papers-Updates/blob-pane-layout-20261021. The first download failed because the connector shell lacked Get-FileHash; built-in SHA256 then verified all files and installation completed.

Both personal desktops now contain Papers.lnk pointing to their stable installed App/Papers.exe with the existing Data root argument. SlopTop's old Delegate Wave launcher shortcut is backed up in the local stage; LapDog's two old Proxima/clean-profile shortcuts were moved into its update stage, retaining those separate profiles. Shortcut targets were read back and exist. No published version, credentials or user documents changed.

## 2026-10-21 LapDog blank pane, zoom and Android picker repair

Both installed Papers ASARs now match 295FB009CAF085A7935B80CCE9EA362ABCC839E3C9C335B6B6E6B0045E1CD7FB. Native snapshot rectangles and document-edge input account for Papers page zoom; LapDog retains zoom 1.1. Shared overlay presentation reconciles against snapshot state. Workspace collapse uses an SVG double chevron.

LapDog native AppFlowy preferences had pointed at beta.appflowy.cloud. After a normal app exit, preferences were backed up and only the cloud type/base URL changed to the existing BOP server. All previous data directories remain. A fresh paired personal session was delivered through the official native login callback without printing tokens. The existing Papers Proxima surface was inactive during diagnostics; activating it through the normal host API allowed both template panes to open. Read-only status then reported a live file iframe with pointer-events:auto and Synced to all devices; native AppFlowy selected. Do not weaken hidden-page command authority.

Android MainActivity now handles WebChromeClient.onShowFileChooser, cancellation, multiple selected content URIs and lifecycle callback cleanup. Signed APK build succeeded and adb install -r succeeded on RF8M73S4NEM. No real file selection/upload acceptance was performed.

Native AppFlowy now hides the collaborator avatar row and filters own-user remote cursor labels across devices. Both desktop app.so files match BEAFFAE3533AFC92773A6D49212FB7940C461A706C667A915EA047C30916F753. Built successfully with Flutter release. Old installed app.so files preserved in each repair stage; normal app exits used before replacement. These presence changes are native desktop only; no BOP web deployment in this repair.

No test suites or synthetic input run. No documents, template bindings, account credentials or old profile directories removed. Private temporary update delivery servers stopped after download.

## Go / Flow branding delivery
Both desktops received matching native app.so SHA256 504F279A15C270D3DA3F13B4E74C9551B27F7BB85F07B34E8ADAB9E1E7DB3229, portrait EXE icon, removed native sidebar branding row and child-view refresh/dedup change. Native executable/protocol/profile identities retained. Go/Flow template labels and own-origin icon assets installed, generated shared renderer rebuilt. SlopTop live DOM confirmed Go/Papers icon and Flow/portrait. Android package label is Flow; signed update installed in place. No BOP web deployment performed, so browser-served labels and upstream web branding remain a separate deployment. No synthetic input or tests run.

## Branding regression repair
The first branding EXE incorrectly changed Windows ProductName to Flow, which path_provider used as a new AppData profile root. Restored internal ProductName AppFlowy; FileDescription/icon remain Flow. Both original and accidental profiles retained. LapDog config had acquired a UTF-8 BOM through Windows PowerShell Set-Content; JSON.parse ignored that override and used old UUID-only defaults, rejecting page targets and falling back to a web editor that showed a Slate insert_node error. Rewrote config as UTF-8 without BOM and restored native docking. Fixed sidebar notification refresh protobuf precondition by deepCopy + freeze instead of rebuild on an unfrozen response. Both installed app.so now SHA256 490C799EA45C60DA952789594BB273496DD89FF118FD83A527A5AEF129D13B0B. Read-only SlopTop native accessibility/screenshot confirmed signed-in This is Minh, feed sorter content including Liu tiu xiu, removed branding and To-dos nested under feed sorter. LapDog live DOM confirmed native Go/Flow tabs after config repair. No input synthesized or user data removed.

## Middle-click autoscroll
Native document editor now wraps the existing editor content with MiddleClickAutoscroll. A mouse middle click starts a ticker; pointer distance outside a 12px dead zone sets signed vertical speed capped at 1800px/sec. Uses EditorState.scrollableState.position so virtualized and shrink-wrapped documents use their existing owner. An input shield consumes the stopping click; pointer wheel/cancel, Escape, lifecycle focus loss, document replacement and dispose stop/clean up the ticker. Anchor indicator and all-scroll cursor are shown while active. Windows release build succeeded; installed app.so SHA256 BA2E9A8B3BDB2EE9D1696D871A9522BD18798220018D9BC7070BABD4C25F823E. Previous binaries preserved in each flow-autoscroll-20261021 stage. No synthetic input or gesture acceptance test performed.

## Flow sidebar controls
Built and installed native app.so SHA256 5B82C4DC105A3D340ABF9422D067B2F476632A3C3E22CEE863BDD437F04CB707. Personal header replaces notification bell with existing sidebar-collapse action. New local ChangeNotifier/inherited scope owns list navigation/selection only; focused root uses existing ViewBloc and ViewItem children/move ownership. Shift-click/double-click builds checked ancestor breadcrumb chain; Back/Forward/Up navigate scope. Ctrl/Cmd toggles selection, ordinary click selects/opens, right-click expands while ellipsis preserves actions. Expanded group captions and branch lines use theme accent; branch overlay does not add cumulative indentation. Move-page picker disables the new scope. Previous app.so files retained in flow-sidebar-20261021 stages. No synthetic input or tests run.

## Active workspace header and fast edge scrolling
The prior sidebar delivery modified only SidebarUser; the active workspace header was SidebarWorkspace and retained its bell. Replaced that notification button too with the always-visible double-chevron using HomeSettingBloc.collapseMenu. Final Windows build also accelerates middle-click scrolling in the outer 48px of the document viewport with a quadratic ramp to 6x (up to 10800px/sec), retaining the anchor dead zone and normal central speed. app.so SHA256 A87A1FD627A3E35C59B65928903FB7DED4636B728B94F2E40948DADEA1CA14B1; prior binaries retained in flow-chevron / flow-edge-speed stages. Native interactive app restarted normally, with no synthesized input.

## Shared breadcrumb parity, nested creation and popup contrast
Added widgets/flow_breadcrumbs.dart, reused by sidebar navigation and ViewTitleBar. Full paths carry page/space/emoji artwork; path changes reveal the current end, while manual vertical wheel maps to negative horizontal movement as in Go. Crumb right-click and separator click browse siblings in a bounded scrollable popup with reversible recursive expansion and icon-bearing headings/branch lines. Shared palette uses Go proximity constants (13px levels,34px rows,220px distance,45-degree separation) and bounded pair projection, rendering OKLCH(68%,0.18,hue) as sRGB. Expanded main-list headings now include icon and text; color tint applies on hover. New page uses the actual MenuSharedState.latestOpenView as parent through ViewBackendService.createView and opens the result. Narrow drawer outside-click shield hides the sidebar and consumes the click, protecting editor focus.
Readability refinement: popup explicit dark/light foregrounds, muted hover/focus fills instead of theme cyan, 14px medium labels, minimum36px rows and320px maximum width. Final app.so SHA256 1627FB80420430A6EE8B30F66B8647DE569596D9E993D92905A3C1D0AB7185BC; installed after normal Flow exits with old binaries retained under flow-popup-readable-20261021 stages. Read-only native SlopTop accessibility confirmed icon-bearing page/sidebar paths and active Collapse sidebar button in the combined prior build. No synthetic input, gesture tests or creator-page mutation tests performed. User screenshot confirmed the sibling popup before contrast refinement.

## 2026-10-22 Go tab white-flash repair
Repeated mount() appended the same iframe to its existing parent. Guarded both shared/nonshared append paths by parent identity so ordinary switching retains the document instead of reloading it. Initial and unavoidable moved frames are visibility:hidden until requested folder/render readiness; iframe fallback background is dark. Updated source and both installed Proxima public/blob-workspaces.js; flushed and reloaded live Proxima surfaces through application APIs. Existing documents and iframe message origins/protocol unchanged. No synthetic tab switching or test suite run.
