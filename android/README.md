# Android shell: phone pairing and recovery

This is the native WebView shell for the Windows VIVIM phone surface, not a
separate copy of the web app. On Windows, open **VIVIM phone pairing** (the
shortcut runs `scripts/windows/VIVIM.ps1 -LanPair`). Keep the PC and phone on
the same Wi-Fi. Paste the printed `http://<PC address>:<port>/mobile?token=...`
link into the Android app and tap **Connect**. Use the printed port, not an
assumed default. Android also accepts a `vivim://pair?pairUrl=<encoded URL>`
app link, either opened from another app or pasted into the pairing field.

An incoming link opens a confirmation screen; it does not silently replace
your PC. Once confirmed, the link is saved in Android preferences. The WebView
also saves the PC's pairing cookie when the page finishes and when the app
pauses. Closing and reopening the app uses the saved link. A changed PC address
or a new pairing code requires a fresh link from Windows.

## Recovery and navigation

- Failed main-page connections and HTTP errors return to the pairing screen
  with the saved link and a next step, rather than leaving a browser error page.
- A main-page load that has not completed after 20 seconds is stopped. Check
  the PC and Wi-Fi, then tap **Connect** to retry. There is no automatic retry
  loop and the shell never replays a message send.
- If Android closes the WebView renderer, the app offers the same manual
  reconnect. Check any message you were writing before sending it.
- Back follows page history. At the root, Back opens **Reload page**,
  **Re-pair**, **Close VIVIM**, and **Cancel**. Long-pressing an empty page area
  also opens this menu. Reload starts from the saved pairing link.
- Re-pair cancels any pending page load so a late network failure cannot
  overwrite the pairing form. Back can return to the previous working page.
- Other websites open in the phone's browser. Subframe navigation is left to
  the WebView rather than launching the browser for embedded page navigation.

The native loading deadline covers document navigation, not stalled background
requests after the web page has loaded. Those remain owned by the mobile web app.

## Build without an emulator

```powershell
pwsh -NoProfile -File android/build.ps1
```

Requires JDK 17+ and Android SDK platform 34 / build-tools 34.0.0. The script
compiles Java, dexes, packages, aligns, signs and verifies
`android/build/vivim.apk`. It does not start an emulator or install the APK.
See `docs/architecture/ANDROID-APP.md` for the original build-tool setup; its
older description of automatic intent confirmation/debugging is superseded
by the source and this document.

No emulator or physical-device runtime outcome is implied by a successful build.

## Verification receipt — 2026-10-29

- Scope: existing `MainActivity.java` plus this Android-local documentation;
  no new runtime files or dependencies.
- `git diff --check -- android`: passed.
- First `pwsh -NoProfile -File android/build.ps1` attempt: resource compile/link,
  Java compilation, d8, packaging and alignment completed; the foreground
  command hit its 120-second deadline during signing. Java emitted only the
  existing deprecated-API notice. This attempt did **not** establish a verified APK.
- A second invocation uses the same build script in the background to avoid
  the foreground deadline. Final signing/build outcome is recorded below when
  it completes.
- No unit-test suite run (owner directive). No emulator started. No APK
  installed, no phone UI observed, and no Studio/Chrome lifecycle changed.
- Still needs device observation: reopening after pairing, offline Connect,
  recovery after Wi-Fi/PC changes, app-link confirmation and root Back menu.
