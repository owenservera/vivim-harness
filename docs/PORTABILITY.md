# Native Windows + Linux portability

**Permanent contract:** [issue #5](https://github.com/owenservera/vivim-harness/issues/5). One Node >=22 codebase on Windows and Linux. No WSL, Docker, shell-based Chrome discovery, duplicated browser actor or platform-specific source fork.

## Identical commands

```text
node bin/studio.mjs doctor
node bin/studio.mjs start
node bin/studio.mjs selftest
node scripts/platform-smoke.mjs
```

Install Node >=22 and Chrome, Chromium or Edge. `CHROME_PATH` is the operator-supplied executable override; on Linux, default installation paths, Snap and `PATH` are searched. On Windows, standard installation locations and `Path` are searched. `npm run chrome:cdp` invokes the **existing** `studio launch` actor using its separate profile and loopback CDP port. The historical `scripts/chrome-cdp.ps1` is Windows-only optional maintenance tooling, not the standard entrypoint. Use `node bin/studio.mjs serve --no-open` for a Studio UI without starting Chrome.

## Evidence tiers

| Tier | Procedure | Establishes | Does not establish |
| --- | --- | --- | --- |
| P0 | `node --test test/unit/platform-parity.test.mjs` | Simulated Windows/Linux browser candidates, external data roots, single launcher | Installed real browser |
| P1 | `node scripts/platform-smoke.mjs` | Real disposable native Node process, CLI, loopback chat, all dynamic WORLD modules, health API | Provider capture or human browser |
| P2 | `npm test` and OS-process persistence tests | Actual suite on the executing OS | Other OS without a separate run |
| P3 | `doctor`, `start`, `selftest` with browser evidence on **each** OS | CDP/browser discovery, local runtime | Unobserved network/provider effects |
| P4 | Windows + Ubuntu Node 22/24 GitHub Actions | Matrix acceptance **only if runners actually execute and pass** | Success from workflow YAML or startup failure |

The smoke script creates a temporary directory with `os.tmpdir()`, uses only local HTTP, never launches Chrome, and deletes its data. It must not read private sessions or capture online provider content. WORLD J1–J4 requires a separate browser-level T3u receipt to close G5.

## Verified boundary and remaining work (2026-10-26)

- The repository's [integration queue](track/queue.md) reports the GitHub Actions failures are an **account billing lock** before steps execute. Hosted cross-OS CI remains unverified.
- A Windows local R456 suite and separate-process T3p receipt exist, but Linux Node and installed-browser runtime execution need an actual receipt.
- The current Chrome launcher can reuse an already-reachable loopback CDP endpoint. Its owner/profile must be confirmed before attaching in an actual provider task; neither this sprint nor a P1 smoke run authorizes remote effects.
- Real-browser WORLD export/download/import, keyboard navigation and provider-native capture are separate acceptance tracks.
- Avoid claiming parity *passed* until Windows and Linux execute the relevant real tests and receive their own receipts.

New platform-specific code must add coverage on both operating systems without duplicating runtime, persistence, browser ownership or UI.
