# R456 LOCAL SPRINT RECEIPT

- **Sprint:** R4/R5/R6 LOCAL SPRINT 01 (linked to GitHub issue #4)
- **Runbook:** docs/sprints/R456-LOCAL-SPRINT-2026-10-26.md
- **Date:** 2026-10-26
- **Host:** Windows, Node v24.22.1, npm 11.19.1
- **Baseline commit:** d129d5255d48524b527ae561c0ff8b9e36bd6aa8 (main, fast-forwarded from origin/main)
- **Owner:** local Windows OpenCode session

## Gate table

| Gate | Status | Evidence | Still owed |
|------|--------|----------|------------|
| L0 | PASS | Clean worktree, no Studio/CDP processes, no listeners on 19000-19300/9222/9223/19224/4310, no default private data root, PROMPT.md mission recorded as separate owner lane | — |
| L1 | PASS | Architecture inventory PASS; focused 11-file suite 85/85; full `npm test` 1878 tests, 1875 pass, 0 fail, 2 skipped, 1 todo (exit 0); two `node --check` clean; two pre-existing stale test assertions fixed | — |
| L2 | PASS | T3p two-process durability: 3 distinct OS PIDs, before/after `DOM_TURNS` byte + canonical hashes identical, cross-process CAS 409 with operands, torn commit + orphan, killed holder 423, token-checked recovery, exactly-once resubmit | — |
| L3 | NOT RUN | Disposable instance prepared and verified over HTTP (list + search); that is T1/T2 only | T3u: real-browser J1 RETURN → J2 ORGANIZE → J3 FIND → J4 TAKE with a real download (not a CI requirement) |
| L4 | PARTIAL | Risk-class matrix complete; both gap classes closed and independently verified (traversal rejected; edit-history unfiltered → owner decision) | T3u; canonical A01–A18 mapping; G5 decision |

## Gate L0 — PASS

- git status clean; single worktree `C:/0-BlackBoxProject-0/vivim-harness`; branch `main` tracking `origin/main`
- No running node/Studio process; no CDP-enabled `chrome.exe`
- No listener on ports 19000-19300 or 9222/9223/19224/4310
- `CAPTURE_STUDIO_HOME` unset; no default private data root exists (`.capture-studio` and `LOCALAPPDATA/capture-studio` both absent)
- PROMPT.md provider-native three-turn mission recorded as a separate owner lane, not active, not preempted

## Gate L1 — PASS

- `node scripts/architecture-inventory.mjs --check` -> PASS, "Uncovered source files: 0; missing ownership paths: 0"
- Focused 11-file suite (`world-r456-integration`, `world-r456-search-http-ui`, `world-service`, `world-search`, `world-ui`, `world-ui-find`, `world-ui-workspace`, `world-ui-transfer`, `world-journeys`, `world-import-hardening`, `world-provider-url`) -> 85 tests, 85 pass, 0 fail
- `node --check src/studio/ui/world-view.mjs` -> 0; `node --check src/studio/world-service.mjs` -> 0
- Two reproducible defects fixed **in test assertions (not product code)**: `test/unit/chat-ui.test.mjs` and `test/unit/chat-rich-ui.test.mjs` pinned an outdated CSS selector; `src/studio/ui/chat.html:47` legitimately widened the 44px hit-area rule to include `input[type=search]` and `input[type=file]`. Both assertions updated. Both had already failed at pre-merge commit `32b7021`, so they were pre-existing, not caused by R4-R6.
- Full `npm test` result: **PASS** — 1878 tests, 1875 pass, 0 fail, 2 skipped, 1 todo, exit 0 (Node v24.22.1, Windows, 2026-10-26)
- Focused R456 pair (`world-r456-integration`, `world-r456-search-http-ui`) -> 16/16 pass on this host

## Gate L2 — PASS (tier T3p)

Test: `test/unit/world-t3p-durability.test.mjs` (228 lines) + `test/unit/fixtures/t3p-worker.mjs` (401 lines). Command: `node --test test/unit/world-t3p-durability.test.mjs` → **tests 1, pass 1, fail 0**, exit 0, ~4.5–5.0 s. Re-run and confirmed by the session owner after the implementing lane reported.

Real evidence, not simulated:

| Claim | Observed |
|---|---|
| Independent OS processes | parent `12832`, A `372`, B `6792`, lock holder `7364` — all distinct; A and B exit 0 |
| Source evidence unchanged | `H0` `053c22db…8e6f` and `D0` `df4eefda…b994` identical before/after; `sessions/**` tree hash `c9a01e36…d61b` identical |
| Same records across processes | project `p-711f9b58…` v3, note `n-1da5d56c…` v2, object `o-fad4f82d…` v1, selection `s-1260acc4…` v1 |
| Cross-process CAS | project 409 `{expected:2, actual:3}`; note 409 `{expected:1, actual:2}` — and a rejected edit wrote nothing |
| Interrupted save (torn commit) | 5 rename attempts → `EBUSY`, `CURRENT` still names v3, orphan `v0004` present but unreachable, 0 temp residue |
| Interrupted save (killed holder) | HTTP 423 `CAS_LOCKED` while holding **and** after death; `pidAlive:false`; wrong token → `CAS_LOCK_TOKEN_MISMATCH`; `released:true` |
| Exactly-once after recovery | fresh v3 → retry v6 (numbering skips the orphan), repeat → 409 `{expected:3, actual:6}` |
| No private data | disposable `mkdtemp` root only; default data dir never reached; 0 leftover roots |

Two design points in the original briefing were **factually wrong and the lane corrected them instead of faking a pass**:
1. A single `EBUSY` on the CURRENT rename cannot create a torn commit — `EBUSY` is in `TRANSIENT_FS` (`src/store/versioned.mjs:33`) and `#setCurrent` retries (`:296-297`). A *persisting* `EBUSY` is required, and both attempt counts (2 = committed, 5 = surfaced) are asserted.
2. Blocking at the CURRENT rename leaves a half-written `CURRENT.<hex>.tmp` the product correctly never cleans, so "no `*.tmp` residue" cannot hold at that point. The holder is instead killed after its version file is durable and before CURRENT is touched.

Scope: **no `src/` file was modified.** The 4 durable edit types plus a link are driven over real HTTP against a real `startStudio`; the child imports `startStudio` (`t3p-worker.mjs:22`) and uses real `fetch` (`:46`), with 66 assertions across the two files.

**Honest limit:** draft retention is browser state and cannot cross a process boundary. It is expressed durably here as "the failed write appended no version, `CURRENT` still names the old version, and the identical body resubmitted after re-reading the version succeeds exactly once" — never as "the tab kept the text". The tab-level claim stays a T1/T3u matter. Lock recovery is likewise a **library** call (`inspectLock` / `releaseStaleLock`, `src/store/versioned.mjs:365-391`), not an operator UI feature — the world routes expose no lock endpoint.

## Gate L3 — NOT RUN (tier T3u)

Machine side is prepared and verified against a **disposable** data root `%TEMP%\world-l3u-src` (no default data dir, no private data, no CDP):

- `node bin/studio.mjs serve --studio-port 7880 --no-open --data-dir <root>`
- `GET /chat` → 200 (29,222 bytes)
- `GET /api/v1/world/conversations` → 1 record, `custody=observed`, id `c-9b05e212940e4b0cd67ecbdee6db22549ab42367`
- `GET /api/v1/world/search?q=l3uneedle` → 200, 2 hits

Seeded content covers the required classes: markdown heading, list, external link, code fence, table, quote, an opaque unknown block and a truncation marker.

**This is T1/T2 evidence only, not T3u.** T3u requires a human to click J1→J4 in a real browser and produce a real downloaded artifact. No CDP controller was attached and none will be: `scripts/chrome-cdp.ps1` junctions the owner's real Chrome profile and is the *capture* launcher, so it is deliberately not used for this gate.

## Gate L4 — adversarial coverage

### Blocker: the A01–A18 case list is not in this repository

The runbook references it only as an external AION matrix (`R6-ADVERSARIAL-ACCEPTANCE-MATRIX.md`), and the local AION checkout does not contain that file. The runbook requires case IDs here, so either the canonical IDs must be pulled from AION or this receipt must define its own. Coverage is therefore enumerated by risk class.

### Risk-class matrix

| Risk class | Enforcing code | Verdict |
|---|---|---|
| Bounded/malicious import (size, depth) | `src/studio/world-transfer.mjs:10,47` `IMPORT_CONTENT_LIMITS` | COVERED — import is JSON-only; no zip path exists |
| Tampered digest | `world-transfer.mjs:242-243` `WORLD_IMPORT_DIGEST_MISMATCH` | COVERED (digest = integrity, never authentication) |
| Record id collision | `world-transfer.mjs:19` `localId`, `world-service.mjs:164` create-on-null CAS | COVERED — partial:true + failed[] reported honestly |
| Partial HTTP 200 / truncated body | `world-transfer` failed[]/partial; `src/capture/network.mjs:259-292` `body.truncated` | COVERED |
| HTML injection into saved content | `src/studio/ui/drive.mjs:2-15` textContent-only policy | COVERED |
| Stale source reference | world service/relations readers | COVERED |
| CAS conflict | `world-service.mjs:80` compareAndSave | COVERED |
| Reference-only vs transcript/full-saved exposure | `world-transfer.mjs:134` scope by construction | COVERED — tests assert verbatim carriage rather than hide it |
| URL pathname / nested-link leakage | `src/studio/world-url.mjs:11-29` origin+pathname sanitizer | COVERED — path segments are retained by design |
| Captured remote binary bytes | none | **HOLD** (owner choice, runbook line 19) — not a pass |
| Native edit-history exposure | **none** | **OPEN — owner decision** (Finding 2) |
| Export-scope escalation | `world-transfer.mjs:124,135-141,199,228,232` | COVERED |
| Import path traversal | `validId` / idMap / integrity + `validateStoreName` | COVERED — now proven through the *restore* path (Finding 1) |

### Finding 1 — import-side traversal: rejected, no defect

`test/unit/world-import-hardening.test.mjs:378` drives record ids `../sessions`, `..\sessions` and `a/../../b` through `validateBundle` + `restoreBundle`. Observed:

- `validateBundle` → `valid:false`, codes `WORLD_IMPORT_RECORD_INTEGRITY` (id grammar) and `WORLD_IMPORT_RECORD_CONFLICT` (id/kind prefix disagreement); the traversal id never enters `idMap`.
- `restoreBundle` throws `WORLD_IMPORT_DIGEST_MISMATCH` (400) at the `report.valid` gate (`world-transfer.mjs:299`) carrying the traversal errors — it does **not** land in `failed[]` / `partial:true`, because the throw precedes plan construction. The test asserts the shape the code actually produces rather than the shape I predicted.
- Nothing written: no import receipt, world directory listing byte-identical, `notes()` / `projects()` / `conversations()` all empty.
- Out-of-band store access under those names throws `STORE_NAME_INVALID` from `validateStoreName` before any lock or file is created.

**Citation correction, recorded honestly:** the lines I originally gave the lane (`world-transfer.mjs:238-241`) are the bundle-shape gate and do **not** themselves fire for a traversal id. The enforcing code is `validId` (`:14-16`, `:255`, `:262`), the id/kind check (`:250-251`) and the `report.valid` gate (`:299`). No `src/` change was needed.

### Finding 2 — native edit-history exposure: no filter exists (owner decision)

`test/unit/world-import-hardening.test.mjs:462` is a characterisation test, deliberately adding no redaction. Observed behaviour across all three modes:

| Mode | Edit-history payload | Mechanism |
|---|---|---|
| references | absent — and so is all message content | omission (`SOURCES_NOT_REQUESTED`), not redaction |
| transcript | excluded | block **type** pruning only (`bundle.omitted` / `non-transcript-blocks-excluded`, count 2); plain message text rides untouched |
| full-saved | **carried verbatim** | no history filter exists; both a direct `edit-history` block and one nested inside another block's opaque data are exported byte-for-byte, including a prior-draft marker |

This is consistent with the runbook's stated limits — full-saved deliberately retains saved raw text, and arbitrary DLP is a separate owner decision — so it is **not a defect introduced by this sprint**. But "native edit history" was on the L4 checklist as something to *verify*, and the verified answer is: **no enforcement exists, and a `full-saved` export will carry a prior draft verbatim.** That is an owner decision to accept or to commission real redaction work. It must not be recorded as a pass.

### Executed vs reviewed

- **Executed:** `node --test test/unit/world-import-hardening.test.mjs` → 10 tests, 10 pass, 0 fail (8 pre-existing + 2 new). Diff scope `+137/−1`, the single deletion being an import line. Independently re-run by the session owner after the lane reported.
- **Not executed:** a canonical A01–A18 ID mapping (source not available locally). The matrix above is by risk class.

**No `src/` file has been changed by this sprint.** Every change is a test assertion or a documentation file.

## Hosted CI finding (important)

Every GitHub Actions run on this repo failed with zero executed steps. Root cause from run annotations: "The job was not started because your account is locked due to a billing issue." This blocks hosted CI entirely and is **not** a code/test failure. No hosted test has ever executed here. Every claim in this receipt comes from local execution on Windows and must be read that way.

## Release verdict

**G5 NOT ACCEPTED.**

- **T3p** — PASS (two-process durability, independently re-run by the owner)
- **T3u** — NOT RUN (real-browser J1→J4 journey; no fake-DOM or automated substitute accepted)
- **L4** — risk-class matrix complete and both identified gaps closed; the canonical A01–A18 mapping is unavailable locally
- **Open owner decision** — a `full-saved` export carries native edit-history payloads verbatim; no filter exists anywhere. Accept as documented behaviour or commission redaction work. It must not be recorded as a pass.
- **Hosted CI** — unusable (billing lock). Every claim here is local Windows execution.

Source-only or synthetic results must not be cited as product/browser acceptance; a passing `node --test` run is not a browser acceptance.

## Rollback

Every change is reversible and none touches product code:

- `git checkout -- test/unit/chat-ui.test.mjs test/unit/chat-rich-ui.test.mjs` reverts the two stale-assertion fixes
- delete `test/unit/world-t3p-durability.test.mjs` and `test/unit/fixtures/t3p-worker.mjs` to drop the T3p proof
- `git checkout -- test/unit/world-import-hardening.test.mjs` reverts the two adversarial gap tests
- delete this receipt to remove the sprint record

No `src/` file was modified, so no product behaviour changed and no migration is required.

Issue #4 checklist updated: no (pending T3u and L4 closeout)
