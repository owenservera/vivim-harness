# Native Windows + Linux portability

**Permanent contract:** [issue #5](https://github.com/owenservera/vivim-harness/issues/5). One Node >=22 codebase on Windows and Linux. No WSL, Docker, shell-based Chrome discovery, duplicated browser actor or platform-specific source fork.

## Identical commands

```text
node bin/studio.mjs doctor
node bin/studio.mjs start
node bin/studio.mjs selftest
node scripts/platform-smoke.mjs
```

Install Node >=22 and Chrome, Chromium or Edge. `CHROME_PATH` is the operator-supplied executable override; on Linux, default installation paths, Snap and `PATH` are searched. On Windows, standard installation locations and `Path` are searched. `node bin/studio.mjs launch` is the cross-platform browser owner: it launches a dedicated profile at `<dataDir>/chrome-profile` and loopback CDP port. Use `node bin/studio.mjs serve --no-open` for a Studio UI without starting Chrome.

`npm run chrome:cdp` deliberately keeps invoking `scripts/chrome-cdp.ps1` on Windows. That script junctions the debug profile to the operator's real Chrome profile (so existing sign-ins and cookies are reused) and `scripts/install-autostart.ps1` passes the same `chrome-cdp-profile` path. Repointing the alias at `studio launch` would silently switch to a fresh profile and appear to lose every sign-in, so the alias is Windows-only maintenance tooling by design and is not the cross-platform entrypoint.

## Evidence tiers

| Tier | Procedure | Establishes | Does not establish |
| --- | --- | --- | --- |
| P0 | `node --test test/unit/platform-parity.test.mjs` | Simulated Windows/Linux browser candidates, external data roots, single launcher | Installed real browser |
| P1 | `node scripts/platform-smoke.mjs` | Real disposable native Node process, CLI, loopback chat, all dynamic WORLD modules, health API | Provider capture or human browser |
| P2 | `npm test` and OS-process persistence tests | Actual suite on the executing OS | Other OS without a separate run |
| P3 | `doctor`, `start`, `selftest` with browser evidence on **each** OS | CDP/browser discovery, local runtime | Unobserved network/provider effects |
| P4 | Windows + Ubuntu runs of `npm test` and `node scripts/platform-smoke.mjs` under Node >=22 | Cross-OS acceptance on the executing pairs | An OS that was not actually run |

The smoke script creates a temporary directory with `os.tmpdir()`, uses only local HTTP, never launches Chrome, and deletes its data. It must not read private sessions or capture online provider content. WORLD J1–J4 requires a separate browser-level T3u receipt to close G5.

## Verified boundary and remaining work (2026-10-27)

Receipts from this repository, executed locally in this increment:

| Gate | Windows (win32, Node v24.22.1) | Ubuntu (WSL2, Node v24.14.1) |
| --- | --- | --- |
| `node scripts/architecture-inventory.mjs --check` | exit 0, 0 uncovered / 0 missing ownership | exit 0, 0 uncovered / 0 missing ownership |
| `node --test test/unit/platform-parity.test.mjs` | 5 pass, 1 skipped (POSIX exec bit) | 6 pass, 0 skipped |
| `node scripts/platform-smoke.mjs` | `ok: true`, 8 checks | `ok: true`, 8 checks |
| `npm test` (full unit suite) | 1974 tests, 1969 pass, 0 fail, 0 cancelled, 3 skipped, 2 todo | 1974 tests, 1972 pass, 0 fail, 0 cancelled, 0 skipped, 2 todo |

- Hosted cross-OS CI is **not** part of acceptance: `3503195` removed the workflow because every Actions run stopped before executing a step ("account is locked due to a billing issue"). Verification is local, and these two local receipts are the gate.
- The parity assertions are discriminating: running them against a pre-integration tree yields 1 pass / 4 fail / 1 skip, so they fail loudly if the launcher, data-root or script contract regresses.
- `node scripts/platform-smoke.mjs` alone is **not** parity proof — it passes on older trees too. It establishes that the native CLI, disposable storage, the WORLD module graph, loopback HTTP and IPC shutdown work on the executing OS; the parity unit test is what pins the platform logic.
- The Windows `npm run chrome:cdp` alias is intentionally Windows-only (see above); cross-platform browser ownership is `node bin/studio.mjs launch`.
- The current Chrome launcher can reuse an already-reachable loopback CDP endpoint. Its owner/profile must be confirmed before attaching in an actual provider task; neither this sprint nor a P1 smoke run authorizes remote effects.
- Real-browser WORLD export/download/import, keyboard navigation and provider-native capture are separate acceptance tracks. No test here sends SIGTERM to a live capture process or opens a real browser, so graceful-shutdown and the shell-free URL opener are covered by construction and unit-level assertions, not by an end-to-end browser receipt.
- Avoid claiming parity *passed* for an OS that has not executed these gates itself.

New platform-specific code must add coverage on both operating systems without duplicating runtime, persistence, browser ownership or UI.
