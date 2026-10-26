# R456 LOCAL SPRINT RECEIPT

- **Sprint:** R4/R5/R6 LOCAL SPRINT 01 (linked to GitHub issue #4)
- **Runbook:** docs/sprints/R456-LOCAL-SPRINT-2026-10-26.md
- **Date:** 2026-10-26
- **Host:** Windows, Node v24.22.1, npm 11.19.1
- **Baseline commit:** d129d5255d48524b527ae561c0ff8b9e36bd6aa8 (main, fast-forwarded from origin/main)
- **Verified commit:** 8b8a20e (local only, not pushed — 6 files, +924/−3, no `src/` change)
- **Owner:** local Windows OpenCode session

## Gate table

| Gate | Status | Evidence | Still owed |
|------|--------|----------|------------|
| L0 | PASS | Clean worktree, no Studio/CDP processes, no listeners on 19000-19300/9222/9223/19224/4310, no default private data root, PROMPT.md mission recorded as separate owner lane | — |
| L1 | PASS | Architecture inventory PASS; focused 11-file suite 85/85; full `npm test` **1881 tests, 1878 pass, 0 fail**, 2 skipped, 1 todo (exit 0) on the committed tree; two `node --check` clean; two pre-existing stale test assertions fixed | — |
| L2 | PASS | T3p two-process durability: 3 distinct OS PIDs, before/after `DOM_TURNS` byte + canonical hashes identical, cross-process CAS 409 with operands, torn commit + orphan, killed holder 423, token-checked recovery, exactly-once resubmit | — |
| L3 | NOT RUN | Disposable instance prepared and verified over HTTP (list + search); that is T1/T2 only | T3u: real-browser J1 RETURN → J2 ORGANIZE → J3 FIND → J4 TAKE with a real download (not a CI requirement) |
| L4 | PARTIAL | Canonical `A01–A18` **retrieved and re-verified** (AION blob `92010eff`, 18 contiguous cases) and reconciled case-by-case; local `L4-01…L4-13` retained as a security-class index only. Both gap classes closed and independently verified (traversal rejected; edit-history unfiltered → owner decision). A15's required proof is T3p, which L2 satisfies | T3u (also the T3u half of A16); G5 decision |

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
- Full `npm test` result before the new tests were added: **PASS** — 1878 tests, 1875 pass, 0 fail, 2 skipped, 1 todo, exit 0 (Node v24.22.1, Windows, 2026-10-26)
- Full `npm test` on the committed tree `8b8a20e`: **PASS** — 1881 tests, 1878 pass, 0 fail, 2 skipped, 1 todo, exit 0. The +3 are exactly the T3p durability test and the two adversarial gap tests; nothing regressed.
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

### Canonical A01–A18 matrix — RETRIEVED (sprint 2)

The list is not in this repository and never was; it lives in AION and is public. Retrieved and independently re-verified by the session owner:

| Field | Value |
|---|---|
| Repo / path | `owenservera/aion` · `workspace/aion/sessions/roles/15-product-to-market/remote-prep-2026-10-26/R6-ADVERSARIAL-ACCEPTANCE-MATRIX.md` |
| Blob / size | `92010eff691573d9923eb6f300ae2cf09e12e021` · 24196 bytes |
| Machine form, authoritative for status | `R6-PROOF-AND-RELEASE-GATES.yaml` @ `cae0f49f0261571e8862831fb670d29b08ead165` |
| AION `main` at read | `da4243e8` |
| Cases | 18 contiguous, `A01`–`A18` |

**Which document wins.** The `.md` case titles and acceptance text are stable, but its `Current assessment` column is pre-merge (10:58Z) and stale — it rates A12 a `code_gap` for missing `/objects`/`/selections` POSTs, while the 13:05Z YAML says `source_implemented_t3u_proof_pending` with `blockers.code: []`. Status is keyed against the **YAML**; definitions against the **MD**. The matrix was authored against Harness `32b7021`, older than local `bb6f1e2`, so its source line references are provenance, not current line numbers.

#### Per-case status against the evidence in this receipt

| Case | Pri | Gate | Canonical assessment (YAML) | Required proof | Local evidence |
|---|---|---|---|---|---|
| A01 | P0 | G1 | `implemented_fixture` | T3u | none |
| A02 | P1 | G1 | `source_implemented_t3u_proof_pending` | T1 | none |
| A03 | P1 | G1 | `source_implemented_t3u_proof_pending` | T1 | none |
| A04 | P0 | G4 | `implemented_fixture` | T3u | S2-1: `references` carries no `messages` key at all; T3u outstanding |
| A05 | P0 | G4 | `implemented_fixture_and_owner_decision` | T3u | S2-1 matrix: transcript/full-saved retain text verbatim; owner decision open |
| A06 | P0 | G4 | `privacy_scope_proof_gap` | T2 | **S2-1 is T2** — providerUrl projection proven in all three modes; arbitrary nested-field audit not performed |
| A07 | P0 | G4 | `implemented_fixture` | T2 | T0/T1 digest-tamper tests only |
| A08 | P0 | G4 | `implemented_fixture` | T2 | T0/T1 traversal + malicious-structure tests only |
| A09 | P0 | G4 | `implemented_fixture` | T2 | T0/T1 collision tests only |
| A10 | P0 | G4 | `implemented_fixture` | T2 | T0/T1 closure tests only |
| A11 | P0 | G4 | `implemented_fixture_runtime_proof_gap` | T3u | T0/T1 partial-200 tests only |
| A12 | P0 | G2 | `source_implemented_t3u_proof_pending` | T1→T3u | none; the UI create path is unproven |
| A13 | P1 | G3 | `source_test_committed_node_browser_proof_pending` | T2→T1→T3u | none |
| A14 | P1 | G3 | `policy_and_test_gap` | T2 | none |
| A15 | P0 | G5 | `windows_process_proof_gap` | **T3p** | **T3p PASS (Gate L2)** — real second OS process, kill/restart, CAS/lock recovery on a disposable root |
| A16 | P0 | G5 | `release_proof_gap` | T3p **and** T3u | T3p PASS; T3u NOT RUN |
| A17 | P1 | G5 | `browser_accessibility_proof_gap` | T3u | none |
| A18 | P2 | G6 | `owner_decision_deferred` | owner only | C10/C11 intentionally unmounted |

Two points this receipt does **not** claim:

- The canonical YAML records `actual_pass_receipt: null` for all 18 and `release_status: G5_NOT_ACCEPTED`. Nothing here alters that document or asserts a canonical pass.
- Gate L2's T3p evidence **meets the requirement A15 states** (*"separate Windows process restart and CAS/lock recovery evidence"*) and is the T3p half of A16. Whether that is accepted as A15 closure is the owner's call, not this receipt's.

The canonical `prohibited_claims` list is adopted verbatim as binding on this receipt: a source-only audit is not a test pass; a sha256 digest does not verify exporter identity; the `providerUrl` origin+pathname sanitizer does not clean message bodies, nested `href`s or path secrets; a second `startStudio()` call in one Node process is not an OS restart; a partial-200 restore is not full success; and T0/T1/T2 fixture evidence is never live Chrome/provider acceptance.

### Local security-class index (`L4-01 … L4-13`)

These are retained as a **security-class index only** — the case axes genuinely differ from `A01–A18`, so no row-to-row equivalence is claimed. They attach to the A-row they actually evidence: L4-01→A08, L4-02→A07, L4-03→A09, L4-04→A11, L4-05→A08/A14, L4-06→A10, L4-07→A15, L4-08→A04/A05, L4-09→A06, L4-12→A04/A10, L4-13→A08. **L4-10 (binary bytes) and L4-11 (native edit history) map to no A-row** — they are R4/owner decisions and must not be recorded as A18.

### Risk-class matrix

| Case | Risk class | Enforcing code | Verdict |
|---|---|---|---|
| L4-01 | Bounded/malicious import (size, depth) | `src/studio/world-transfer.mjs:10,47` `IMPORT_CONTENT_LIMITS` | COVERED — import is JSON-only; no zip path exists |
| L4-02 | Tampered digest | `world-transfer.mjs:242-243` `WORLD_IMPORT_DIGEST_MISMATCH` | COVERED (digest = integrity, never authentication) |
| L4-03 | Record id collision | `world-transfer.mjs:19` `localId`, `world-service.mjs:164` create-on-null CAS | COVERED — partial:true + failed[] reported honestly |
| L4-04 | Partial HTTP 200 / truncated body | `world-transfer` failed[]/partial; `src/capture/network.mjs:259-292` `body.truncated` | COVERED |
| L4-05 | HTML injection into saved content | `src/studio/ui/drive.mjs:2-15` textContent-only policy | COVERED |
| L4-06 | Stale source reference | world service/relations readers | COVERED |
| L4-07 | CAS conflict | `world-service.mjs:80` compareAndSave | COVERED |
| L4-08 | Reference-only vs transcript/full-saved exposure | `world-transfer.mjs:134` scope by construction | COVERED — tests assert verbatim carriage rather than hide it |
| L4-09 | URL pathname / nested-link leakage | `src/studio/world-url.mjs:11-29` origin+pathname sanitizer | COVERED — path segments are retained by design |
| L4-10 | Captured remote binary bytes | none | **HOLD** (owner choice, runbook line 19) — not a pass |
| L4-11 | Native edit-history exposure | **none** | **OPEN — owner decision** (Finding 2) |
| L4-12 | Export-scope escalation | `world-transfer.mjs:124,135-141,199,228,232` | COVERED |
| L4-13 | Import path traversal | `validId` / idMap / integrity + `validateStoreName` | COVERED — now proven through the *restore* path (Finding 1) |

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
- **Not executed:** no canonical A01–A18 case has been run to its required tier; the mapping above is a status reconciliation, not a pass receipt.

**No `src/` file has been changed by this sprint.** Every change is a test assertion or a documentation file.

## Sprint 2 — non-browser evidence gaps

Scope: close evidence gaps that need no real browser and cross no HOLD in `docs/track/queue.md:19`. **No `src/` file has been changed by sprint 2 either.**

### S2-1 — Secret-exclusion proof on a real bundle (COMPLETE, tier T1/T2)

Closes the queue item *"Exclusion is by construction only today. Needs a real (or realistic) bundle, not a fixture assertion."* New `test/unit/world-secret-exclusion.test.mjs`: 3 tests, 33 assertions, 3/3 pass, independently re-run by the session owner.

Method: real `startStudio({ paths, port: 0 })` and the real `POST /api/v1/world/transfer/export` route over a disposable `mkdtemp` root seeded with a saved session, a real `RawLog` archive and a fake chrome-profile cookie file. Every artifact is synthetic and carries a random `FAKE-…` sentinel. Presence is measured by scanning `JSON.stringify(bundle)` — the actual download bytes — not by inspecting objects.

| artifact | `references` | `transcript` | `full-saved` |
|---|---|---|---|
| session cookie, bearer token, provider key, email, display name, credential URL pasted in message text | absent | **PRESENT** | **PRESENT** |
| secret inside a `key_backup` block | absent | absent (by block type) | **PRESENT** |
| raw capture `Authorization`, `Set-Cookie`, response body (plain + base64) | absent | absent | absent |
| chrome-profile cookie file | absent | absent | absent |
| `providerUrl` query token, userinfo password, fragment | absent | absent | absent |
| `providerUrl` **path segment** | **PRESENT** | **PRESENT** | **PRESENT** |

Corrections to the queue's premise, all measured:

1. **`providerUrl` really is sanitized** — not "by construction only". `src/studio/world-url.mjs:16` returns `url.origin + url.pathname`; applied at the source read (`world-service.mjs:48`) and at export (`world-transfer.mjs:184-186`) in all three modes. Query string, userinfo and fragment are dropped; origin and pathname are kept; the stored `session.json` is not rewritten (asserted), so this is a projection, not a mutation.
2. **That sanitizer is field-scoped to `source.providerUrl`.** The identical credential URL pasted into message text survives `transcript` and `full-saved` untouched. This is the place a future reader will wrongly assume is covered.
3. **Raw capture and browser-profile data are absent by omission, not scrubbing.** The test proves the raw log on disk genuinely holds the Authorization header, the Set-Cookie value and the response body (plain and base64), and that none of it reaches any mode. `src/capture/network.mjs:58-69` is a capture-time policy and was not exercised — no browser was used.
4. **Documented limit confirmed:** a secret that sits in a path segment survives every mode, because the pathname is preserved by design (`world-url.mjs:8-10`).

This is a measurement, not a pass. The current export carries cookies, tokens, provider keys and PII in two of three modes, and the bundle's own `coverage.qualification` discloses *"Selected content is not automatically redacted."* Redaction remains the owner decision at `queue.md:19`; nothing was filtered to make this table look better.

### S2-2 — PR #1 triage, `centralize/aion-assets-20261025` (COMPLETE, read-only + disposable worktree)

- Ref is **remote-only** at `63414d0`; merge-base `442b0b6`; **9 ahead / 41 behind** local `main`. The earlier "38 behind" figure was stale.
- **Zero file overlap** confirmed independently (intersection of the two changed-file sets is empty).
- **`src/capture` and `src/intel` are byte-identical** between `main` and the branch tip. Branch age therefore cannot explain any failure: the suite tests modules `main` never touched.
- `test/qa/*.test.mjs`: 299 tests, 289 pass, **9 fail**, 1 `# TODO`. The "9 of 299" figure is exact.
- All 9 classify as fixture/assertion drift. **Zero genuine product defects. Zero Windows or environment artefacts.**

| failing group | count | classification |
|---|---|---|
| `sprint01-temporal-graph.test.mjs:21` references scoped to same site | 1 | fixture omits the typed key the canonical module keys on |
| `sprint02-capture-safety.test.mjs:36` credential must never enter raw append | 3 | assertion against the non-default `filtered` policy |
| `sprint02-capture-safety.test.mjs:42/46/50` split JSON/Bearer/JWT must not persist | 3 | same |
| `sprint02-capture-safety.test.mjs:63` unverified thread must not send | 1 | fixture predates caller-resolved identity; fail-closed is by design |
| `sprint02-capture-safety.test.mjs:84` lease not stolen from live owner | 1 | test passes `staleGraceMs: 0`, removing the grace it then asserts |

Root causes re-verified in code by the session owner:

- `src/capture/privacy.mjs:9` — default mode is `local-raw`; `:22-25` return url, headers, text and bytes unredacted under it; `filtered` is the opt-in that runs `redactUrl`/`redactHeaders`/`scrubText`/`scrubSecrets`. `:1-3` documents this as *"a fidelity preference, not an authorization boundary."*
- `src/capture/drive-lease.mjs:81` — default `staleGraceMs = 2000`; `:57` reclaim eligibility requires `ageMs >= staleGraceMs`. `:2` and `:94` document reclaim-on-acquire for missing/corrupt owners.
- `src/intel/graph.mjs:17` — a type carries `key: t.key?.field ?? null`; `:142` revision signature includes `method` and `keyType`. References keying needs a typed key.
- `src/capture/conversation-service.mjs` — identity is caller-resolved; an unbound connect resolves `NOT_PROVIDED` and fail-closes.

**Owner-relevant, and not merely a stale test:** the six `sprint02` failures assert that credentials never enter a raw append. They pass under `filtered` and fail under the shipped default `local-raw`. That default is deliberate, not a regression — but it means the default capture path does not run the credential guard. Recorded as a policy fact rather than silently filed under "stale".

Recommendation: rebase-and-fix those 9 fixtures, then merge; zero file overlap makes conflicts structurally impossible. **Not executed** — no merge is authorized, and the failure count and filtered-mode probe were executed by the triage lane in a disposable worktree, with the topology and every code line above independently re-verified here.

## Hosted CI finding (important)

Every GitHub Actions run on this repo failed with zero executed steps. Root cause from run annotations: "The job was not started because your account is locked due to a billing issue." This blocks hosted CI entirely and is **not** a code/test failure. No hosted test has ever executed here. Every claim in this receipt comes from local execution on Windows and must be read that way.

## Release verdict

**G5 NOT ACCEPTED.**

- **T3p** — PASS (two-process durability, independently re-run by the owner)
- **T3u** — NOT RUN (real-browser J1→J4 journey; no fake-DOM or automated substitute accepted)
- **L4** — canonical `A01–A18` retrieved and reconciled case-by-case against local evidence; both identified gaps closed. **A15's required proof (T3p) is satisfied**; A16 still needs T3u. No canonical case is claimed as passed.
- **Privacy** — a real bundle was measured: cookies, bearer tokens, provider keys and PII ride `transcript` and `full-saved` verbatim; `providerUrl` alone is sanitized to origin+pathname, and only in that field. Recorded, not fixed.
- **Open owner decision** — a `full-saved` export carries native edit-history payloads verbatim; no filter exists anywhere. Accept as documented behaviour or commission redaction work. It must not be recorded as a pass.
- **Hosted CI** — unusable (billing lock). Every claim here is local Windows execution.

Source-only or synthetic results must not be cited as product/browser acceptance; a passing `node --test` run is not a browser acceptance.

## Rollback

Every change is reversible and none touches product code:

- `git checkout -- test/unit/chat-ui.test.mjs test/unit/chat-rich-ui.test.mjs` reverts the two stale-assertion fixes
- delete `test/unit/world-t3p-durability.test.mjs` and `test/unit/fixtures/t3p-worker.mjs` to drop the T3p proof
- `git checkout -- test/unit/world-import-hardening.test.mjs` reverts the two adversarial gap tests
- delete `test/unit/world-secret-exclusion.test.mjs` to drop the sprint-2 secret-exclusion proof
- delete this receipt to remove the sprint record

No `src/` file was modified, so no product behaviour changed and no migration is required.

Issue #4 checklist updated: no (pending T3u and L4 closeout)
