# VIVIM Android app (`android/`)

Native Android shell around the Studio mobile PWA (`/mobile`). It is a single
full-screen `WebView` plus a first-run pairing screen — no AndroidX, no Gradle,
no bundled web assets. The app loads whatever Studio serves, so the PWA stays the
single source of truth for the mobile UI.

## Layout

| Path | Purpose |
|---|---|
| `android/AndroidManifest.xml` | package `inc.vivim.app`, minSdk 26, targetSdk 34, `INTERNET`, `usesCleartextTraffic=true` (LAN `http://` pairing) |
| `android/src/inc/vivim/app/MainActivity.java` | WebView host, pairing screen, re-pair menu |
| `android/res/` | app label, launcher icon (adaptive), colors |
| `android/build.ps1` | aapt2 → javac → d8 → zip → zipalign → apksigner |
| `android/build/vivim.apk` | build output (gitignored) |
| `android/.keystore` | local debug keystore (gitignored, generated on first build) |

## Build

Requires a JDK 17+ (Android Studio's `jbr` is fine) and an Android SDK with
`platforms;android-34` and `build-tools;34.0.0`.

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
pwsh -File android/build.ps1          # -Clean for a full rebuild
```

Output: `android/build/vivim.apk` (debug-signed, ~17 KB).

> **d8 note:** build-tools 34.0.0 ships R8 8.2.2, which crashes with an internal
> NPE (`Cannot invoke "String.length()"`) when dexing anonymous or non-static
> inner classes compiled by recent javac. `MainActivity` therefore uses static
> named nested classes and passes the activity explicitly. Keep it that way, or
> install a newer build-tools and update `$bt` in `build.ps1`.

## Install and pair

```powershell
adb install -r android/build/vivim.apk
adb reverse tcp:38710 tcp:38710   # Studio in LAN-pair mode on 38710
adb shell am start -n inc.vivim.app/.MainActivity --es pairUrl "http://localhost:38710/mobile?token=<TOKEN>"
```

First run (no saved URL) shows the pairing screen: paste the URL Studio prints in
LAN-pair mode, tap **Connect**. The URL is stored in `SharedPreferences` (`vivim` /
`pair_url`) and loaded on every later launch.

- Supplying `--es pairUrl "…"` (or a `vivim://pair?pairUrl=…` data URI) on launch
  also persists the URL, so the pairing screen is skipped.
- **Re-pair:** long-press anywhere in the page → menu with *Reload page* /
  *Re-pair (enter a new URL)*.
- Hardware **Back** walks WebView history, then exits.
- `WebView.setWebContentsDebuggingEnabled(true)` is on, so the loaded page can be
  inspected with `adb forward tcp:9339 localabstract:webview_devtools_remote_<pid>`
  and `http://127.0.0.1:9339/json`.

## Notes

- The token URL is exchanged for a `studio_token` cookie (302 → `/mobile`); the
  WebView keeps the cookie, so later launches of the saved URL work even without
  the query string.
- Third-party cookies stay disabled; only first-party Studio cookies are used.
- `src/capture`, `src/agents` and `test/` are untouched — this is a client shell.
