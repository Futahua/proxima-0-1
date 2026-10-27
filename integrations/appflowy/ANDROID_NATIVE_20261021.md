# Dedicated Android AppFlowy — 2026-10-21

Installed on RF8M73S4NEM as io.appflowy.appflowy, launcher AppFlowy. Native fork 0.11.4, Flutter 3.27.4 / Dart 3.6.2. Default self-host URL is the existing BOP private server. A fresh personal login callback was delivered in memory through the paired desktop exchange; no session tokens written to artifacts or printed. Final screenshot shows This is Minh / Proxima with feed sorter and đồ án q1. No login required from the user.

Includes native source changes hiding DocumentCollaborators and excluding own-user remote cursor selections across devices. No document mutations or upload acceptance tests performed. App data separate from Papers Android.

Build uses flutter assemble --output=build/android-papers -dTargetPlatform=android-arm64 -dBuildMode=release -dAndroidArchs=android-arm64 android_aot_bundle_release_android-arm64. Packages the fork AOT plus Flutter assets into the matching upstream 0.11.4 Android shell/native libraries (SHA256 709fec51dc9659c5229d5ce0bf46c348d7b58f6e53ffd4905aa153c56e6ccfb1). Upstream release CI pins Flutter 3.27.4. META-INF/services and other runtime metadata must be preserved; only old signature files removed. Native libraries remain uncompressed and 16KB zipaligned. Signed with the existing private PapersMobileSigning key, password held through DPAPI and env only. First packaging attempts failed native-library extraction and service-loader startup; final installed build preserves both. adb install returned Success and process remains running with workspace visible.

Reproduction and signed APK: D:/Programs/evTEMP/appflowy-android-20261021 (package.py, sign.ps1, AppFlowy-Papers.apk). Keep signing identity for future updates. No BOP server changes.

## Final backend and branding correction
The compatible native Android backend is pinned official 0.9.3 libdart_ffi.so (APK SHA256 6ea2973fedd2b75df4caa0d44aba5954252d04ddb2b88b920eeb29b8273f1e4d), packaged with 0.11.4 shell and custom Flutter AOT. Newer Android backends use incompatible v2 authentication. User confirmed receipt of Liu tiu xiu after this correction. Updated in place again as Flow with supplied portrait launcher and removed sidebar branding row; adb install -r succeeded and native process remains running. Signature verified. Temporary diagnostic helper uninstalled. No app data cleared.
