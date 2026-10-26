# Native Windows + Linux parity

**Requirement:** One Harness source tree and the same commands on Windows and Linux. Cross-platform differences are contained in narrow OS-facing primitives; no per-release porting, duplicate browser actor, Windows-only prerequisite, Docker or WSL.

**Scope:** Capture Studio CLI, browser lifecycle, local world UI/API, storage, search, import/export and offline tests. macOS remains supported on a best-effort basis.

## Quick start on both operating systems

Prerequisites: Node.js 22 or newer and an installed Chrome/Chromium-family browser.

```text
node bin/studio.mjs doctor
node bin/studio.mjs start
```

The same exact commands work in Windows PowerShell, Windows Terminal and Linux terminals. The application launches an isolated, persistent browser profile in its OS-native local data directory. On Linux headless machines use `node bin/studio.mjs serve --no-open` to serve the UI without launching or opening a browser. **Provider sends remain opt-in and require an attached browser.**

`npm run chrome:cdp` uses the same Node CLI on both platforms. The older `scripts/chrome-cdp.ps1` is Windows-only legacy convenience code and is **not** a dependency of launch or verification; do not copy its junction-to-normal-Chrome-profile approach to Linux.

### Browser discovery

Harness prefers `CHROME_PATH` when set and present. Otherwise it checks common native locations, including Windows Program Files/LocalAppData, Linux distribution packages, snap installation paths, and supported executable names on the current operating system's `PATH`. A PATH lookup does not execute shell commands.

Set `CHROME_PATH` only if an unusual installation cannot be found automatically; this is not a recurring deployment step. Windows and Linux use their native path conventions. Chrome DevTools always listens on loopback only. The dedicated browser profile is not the user's normal Chrome profile.

### Storage and lifecycle

Private evidence lives outside the Git repository. Windows defaults to LocalAppData; Linux honors `XDG_DATA_HOME` and otherwise uses the home data directory. `CAPTURE_STUDIO_HOME` and `--data-dir` work on both operating systems. Use separate local evidence directories per machine; syncing source is not evidence replication.

Studio handles terminal interrupts (Ctrl+C) and SIGTERM for graceful server shutdown. A missing graphical URL opener prints the URL and does not crash the process. A failing browser spawn is returned as an actionable error. Do not use shell-specific quoting, executable paths or process signals in core application logic.

## Verification (each change, both platforms)

```text
node scripts/platform-smoke.mjs
node --test test/unit/platform-parity.test.mjs
npm test
```

The smoke check executes the *real CLI* and architecture inventory against a disposable data directory whose path includes spaces. It does not launch Chrome, send to providers, modify a normal profile or require network access. The parity tests cover browser lookup and data layout with deterministic OS simulations. GitHub Actions runs the smoke, parity and unit suites on `ubuntu-latest` and `windows-latest`, for Node 22 and 24. A configured matrix without green runs **does not** prove compatibility; if hosted CI is blocked, local platform receipts are required.

### Release acceptance

1. Same normal setup and start commands on Windows and Linux, no source edits.
2. Same browser/account identity, single browser-effect owner, no Playwright/Puppeteer.
3. Equivalent local saved-world, import/export, search, lifecycle, locking and interruption semantics.
4. Green Node/unit/parity/smoke checks on *actual* Windows and Linux hosts.
5. Separate real-browser startup and J1–J4 acceptance on both platforms using disposable evidence roots. Offline tests alone do not satisfy G5.
6. Every subsequent feature touching OS-facing behavior updates the existing shared implementation and parity tests; avoid parallel Linux/Windows implementations.

**Traceability:** [P0 parity issue #5](https://github.com/owenservera/vivim-harness/issues/5) and [local world acceptance issue #4](https://github.com/owenservera/vivim-harness/issues/4).
