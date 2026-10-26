# Work queue — one canonical active sprint

**2026-10-26 · Remote Harness source merged to main via PR #3 at `842a8c472a58118ea84a77ae4a9704ece9ee4111`.** Local HEAD is `bb6f1e2` on `main`, **ahead 2 of origin/main, NOT pushed** — `8b8a20e` ("test(world): add T3p two-process durability proof and close two adversarial import gaps", 6 files, +924/-3) and `bb6f1e2` ("docs(sprint): record verified commit, local L4 case IDs and the edit-history decision"). This file is the **single ordered queue**, not the old source-tracker estimates below. Execution issue: [#4](https://github.com/owenservera/vivim-harness/issues/4). One detailed [local OpenCode runbook](../sprints/R456-LOCAL-SPRINT-2026-10-26.md). **No local session was remotely launched.** Real Windows status (local execution, 2026-10-26): **L0 PASS · L1 PASS · L2 PASS (tier T3p) · L3 NOT RUN (tier T3u) · L4 PARTIAL**; real browser status **NOT RUN**; **G5 NOT ACCEPTED** (T3p passes, T3u has not been run).

## ACTIVE SPRINT — R4/R5/R6 WORLD local integration and release evidence

| Order | State | Local owner / scope | Concrete next action | Dependency | Evidence / close condition |
|---|---|---|---|---|---|
| **L0** · W00 | **PASS** (local Windows git/process snapshot, 2026-10-26) | Windows local-master / **read-only** Git/process snapshot | None — cleared; re-check only if the worktree or process state changes | None; GitHub merge already verified | Clean worktree, single worktree, no Studio/CDP process, no listeners on 19000–19300/9222/9223/19224/4310, no default private data root, `PROMPT.md` mission recorded as a separate owner lane and not preempted |
| **L1** · Q04/Q07, W05/W07/W11/W12 | **PASS** | Same local OpenCode test owner / `src/studio/ui/world-view.mjs`, `src/studio/world-service.mjs`, `test/unit/world-*.test.mjs` **only on failures** | None — cleared; the two needed fixes were test-assertion only and already landed | L0 ownership cleared (PASS) | Architecture inventory **PASS** (0 uncovered, 0 missing ownership); focused 11-file world/UI suite **85/85**; full `npm test` on the committed tree: **1881 tests, 1878 pass, 0 fail, 2 skipped, 1 todo, exit 0**. Two pre-existing stale assertions fixed in `test/unit/chat-ui.test.mjs` and `test/unit/chat-rich-ui.test.mjs` (they pinned an outdated 44px hit-area CSS selector; `src/studio/ui/chat.html:47` legitimately widened it to include `input[type=search]` and `input[type=file]`); both had **already failed at pre-merge `32b7021`**, so pre-existing, **not** an R4–R6 regression. **No `src/` file was modified in the sprint** — every change is a test assertion or a documentation file |
| **L2** · Q08, W06/W12 | **PASS (tier T3p)** | Local Studio process owner / **disposable data roots only** | None for the T3p durability gate — cleared. Honest scope note: lock recovery is a library call, not an operator UI feature | L1 relevant checks green (PASS) | New `test/unit/world-t3p-durability.test.mjs` + `test/unit/fixtures/t3p-worker.mjs`: genuinely independent OS processes (observed PIDs parent 12832, A 372, B 6792, holder 7364 — all distinct), process exit/restart over one disposable root, `DOM_TURNS` raw-byte hash and canonical `domDigest` identical before/after, cross-process CAS 409 with expected/actual operands, torn commit leaving an unreachable orphan version, killed lock holder returning HTTP 423 both while alive and after death, token-checked `releaseStaleLock` recovery, exactly-once resubmit after recovery. Lock recovery is a library call (`inspectLock`/`releaseStaleLock`, `src/store/versioned.mjs:365-391`), **NOT** an operator UI feature — the world routes expose no lock endpoint |
| **L3** · Q01/Q02/Q04/Q07/Q10, W03–W12 | **NOT RUN (tier T3u)** | Same owner / one **existing** `/chat` UI / manual real browser; **no CDP send or second actor** | Run the real-browser J1 RETURN → J2 ORGANIZE → J3 FIND → J4 TAKE incl. native part/source link, project/note, exact search focus, JSON file clean-root import, partial truth and keyboard/narrow screen | L1+L2 cleared (both PASS); browser/effect-owner still required clear | T3u observed UI/download/import and local custody/ID receipts; don't infer from fake DOM. A disposable UI-only instance was prepared and its HTTP surface verified (`/chat` 200; `/api/v1/world/conversations` returns 1 record; `/api/v1/world/search?q=l3uneedle` returns 2 hits) — that is **T1/T2 evidence ONLY and must not be recorded as T3u**. No CDP controller was attached, and `scripts/chrome-cdp.ps1` is deliberately not used because it junctions the owner's real Chrome profile and is the capture launcher |
| **L4** · R6 A01–A18/G0–G6 | **PARTIAL** | Same owner / tests + one `docs/sprints/R456-LOCAL-SPRINT-RECEIPT.md` only | Record the open owner decision on native edit history in `full-saved`; finish remaining adversarial evidence, final proof/rollback; update issue #4 and progress ledger | L1+L2 cleared; L3 (T3u) still NOT RUN | Adversarial coverage complete by risk class with **LOCAL case IDs `L4-01 … L4-13`** — the canonical `A01–A18` list was **retrieved in sprint 2** from `owenservera/aion` (`R6-ADVERSARIAL-ACCEPTANCE-MATRIX.md`, blob `92010eff`, 18 contiguous cases; status keyed against `R6-PROOF-AND-RELEASE-GATES.yaml` @ `cae0f49f`) — it was never in this repo, and the local AION clone simply predated it. A15's stated required proof is T3p, which L2 already satisfies; A16 needs T3p **and** T3u. Two gaps closed and independently verified: (a) import-side path traversal (`../sessions`, `..\sessions`, `a/../../b`) is **REJECTED** — `WORLD_IMPORT_RECORD_INTEGRITY` + `WORLD_IMPORT_RECORD_CONFLICT`, never gains a local id, `restoreBundle` throws `WORLD_IMPORT_DIGEST_MISMATCH` 400 at the `report.valid` gate, store directory listing byte-identical after every attempt, out-of-band access refused by `STORE_NAME_VALID`/`validateStoreName`; (b) native edit-history: **NO filter exists** — absent from `references` by omission, excluded from `transcript` by block type only, and **carried VERBATIM in `full-saved`**, including a prior-draft marker — an **OPEN OWNER DECISION, not a pass**. G5 accepted **only with T3p and T3u** |

**Dispatch/authorization:** L0, L1 and L2 were cleared by a *local* OpenCode session on 2026-10-26 (L2 at tier T3p). L3 (tier T3u, real browser) is the next gated step; L4 is PARTIAL. ChatGPT GitHub work cannot silently execute, install or reschedule Windows agents. If another owner is working on `PROMPT.md`'s **three-provider native-turn** mission, L0/L1 may use an isolated worktree, but L2/L3 must not preempt its Chrome/effect owner. No Playwright/Puppeteer or Slack.

**Hosted CI — corrected root cause (2026-10-26, replaces the earlier `startup_failure`/unavailable-logs theory):** every GitHub Actions job failed with **"The job was not started because your account is locked due to a billing issue."** Zero steps executed. This is an **account billing lock, NOT a code or test failure**, and **no hosted test has ever executed on this repo**. Every result in this sprint is local Windows execution. Rely on the transparent local Node receipt; never say CI passed or that `npm test` failed for a proven code assertion.

**HOLD (not in current G5 acceptance):** R4-I3 missing source binary bytes/native artifact versions; generalized automatic DLP/redaction of message text (now with the confirmed edit-history caveat: native edit history has **no filter** and is carried verbatim in `full-saved`, including a prior-draft marker — recorded under L4 as an open owner decision, not a pass); optional C10/C11 mounting; and separate T4 provider-native mission. Don't re-open without an actual owner decision or reproduced defect.

---

## ARCHIVE — early 2026-10-26 historical intake snapshot (not the active queue)

*The entries below predate R4–R6 merged `main`, newer Workspace and partPath implementations. Status words below are historical observations only, never current assignments or present-day test pass receipts.*

Top READY item with no unmet dependency is the next iteration. Evidence tiers: fixture / local-HTTP / synthetic-DOM /
source-only. Nothing here is live, browser, provider or owner-data proof.

HEAD `20574af45c494db46908e8d0dbf5cf8da9531f9f` (origin/main; 2026-10-26 00:37:22 +0100, branch `main`). Tree clean
except untracked `PROMPT.md` and `clone-tmp/` (`git status --porcelain` in this lane).

Lane note: this refresh is docs-only — `docs/track/queue.md` and `docs/track/crosswalk.yaml`. `docs/track/worklog.yaml`
was refreshed at `20574af` (basis `007e357`) and is outside this lane's scope.

### RUNNING
- search-side `partPath`. A free lane is emitting `partPath` on message hits (needs block-level match info) so the Find
  part focus committed in `007e357` stops being dormant. Nothing reported landed yet.
- `FORMAL-TEST-PREP` doc. Preparation for the owner-scheduled formal pass (READY 5); being written now.

### READY — owner decision (blocked on owner, not on code)
1. Mount C-10 and/or C-11 on the hub. Both are committed, tested and deliberately unmounted; wiring is a value
   decision, not a bug. Suggested narrow option: C-11 read-only with the repo root as its only root; C-10 preview-only
   with no execution grant. Either way mounting must not grant an effect.
2. VD-0057 composed workspace (conversation + project + saved objects in one surface). UI design work, not a wiring
   fix; may need the paid `luna-medium` lane. No lane dispatched.
3. Whether `PROMPT.md` and `clone-tmp/` may be pushed at all. Both are untracked and have been kept out of every
   commit in this increment; no owner instruction exists either way.

### READY — dispatchable
4. Commit this docs refresh via `git-manager`, explicit paths, no push unless authorized (needs: parent decision on
   push, see READY 3).
5. Formal testing pass per owner schedule (next week): full repo suite plus W12 acceptance, reported at its real tier.
   First-hand focused evidence at `ad01f06`, earlier lane: **62 pass / 0 fail / 0 skipped** across 10 world suites;
   **27 pass / 2 skipped / 0 fail** across `commands` + `agentic-files` (29 tests, skips platform-gated);
   architecture inventory **0 uncovered, 0 missing ownership**. Parent-reported, different suite sets: 88 across 14
   world/UI suites; 63 across UI+agentic; the earlier 101/2/0 run at `803d165` is superseded in count, same tier. This
   lane re-ran `commands` (**12 pass / 0 fail**) and `agentic-files` (**21 pass / 2 skip / 0 fail**) at `20574af`.

### BACKLOG (from atlas/worklog gaps)
- W12 formal acceptance. The J1–J4 journeys now exist (`1569abc`, 7 tests, fixture-level HTTP) but do not close W12:
  the "second instance" is a second `startStudio()` in the same process, there is no conflicting-import case, no
  secret-exclusion scan, and no import→export round trip through the UI.
  *(Correction 2026-10-26, sprint 1 — historical claim, superseded: the same-process-instance gap is now CLOSED for
  durability by L2/T3p (`test/unit/world-t3p-durability.test.mjs`, two independent OS processes, PASS); the
  real-browser T3u leg is still open. The "no conflicting-import case" claim is outdated —
  `test/unit/world-import-hardening.test.mjs:113` covers conflicting import of identical original ids with changed
  content, and `:197` covers per-record `WORLD_IMPORT_COLLISION` with `partial:true` and `failed[]`. The
  secret-exclusion scan is IN PROGRESS this sprint (a lane is building a real-bundle scan); no result yet, so not
  DONE.)*
- Exact part deep link: the UI consumer is **committed** (`007e357`) and **dormant** until search emits `partPath`. The
  consumer side is real — `planFrames()` marks each top-level saved block with `data-part-path`, `validPartPath()` applies
  the selection path grammar, `partFrameOf()` resolves the frame inside the opened message row, and `openHit()`
  (`src/studio/ui/world-view.mjs:1469`) focuses it or reports "Opened the message; the matching part could not be
  located." Committed `src/studio/world-search.mjs` still builds message hits without `partPath`, so nothing in the
  running app opens a part-level target yet.
- search side: emit partPath for message hits (needs block-level match info) so Find part focus is live — a free lane is
  on this now (RUNNING).
- Secret-exclusion proof: scan an actual exported bundle for cookies/tokens/profile data. Exclusion is by construction
  only today. Needs a real (or realistic) bundle, not a fixture assertion.
  *(Status 2026-10-26, sprint 1: IN PROGRESS — a lane is working this sprint on a real-bundle scan. No result yet; do
  not mark DONE.)*
- VD-0046 atomic knowledge-unit taxonomy (notes are title + free-text body; no addressable provenance-qualified unit).
- VD-0015 legacy content-shape migration (malformed shapes are refused, not upgraded; a second-generation export
  would not import).
- VD-0067 17 semantic symbol families (current map is 8 flat symbols → 6 command ids + 1 deferred provider send; no
  families, no interpretation pipeline).
- Security program: owner-scheduled, in two weeks. No audit artefact exists.
- Browser/keyboard/screen-reader pass over the seven shell views: five UI suites are synthetic-DOM only.
- Live provider/browser work and Windows runtime cutover: deferred until local stability.

### DONE (since last update at `803d165`)
- `2fb9476` C-10 defect fixes landed: preview never claims executability (`canProceed`/`wouldRequireConfirmation`), world
  id grammar, symbol resolution as data not code, multi-line text, own-property argument gate, deep-frozen catalog. The
  earlier 10-defect list was analysis; this is code plus tests. `test/unit/commands.test.mjs` is now **12 tests** (this
  lane: 12 pass / 0 fail at `20574af`). `src/studio/commands.mjs` is still **not** imported by `integration-hub.mjs`
  (only `registerWorldRoutes`), so no command HTTP surface is live.
- `007e357` Find part-focus consumer, committed and intentionally dormant until search emits `partPath` (see BACKLOG).
- `ed1d6b7` atlas/crosswalk correction: C-10/C-11 rows now cite the committed modules; VD-0021 `adapted_in_harness`
  with evidence through `src/studio/ui/world-view.mjs`. Verified by reading `docs/track/atlas.yaml:73-79` and the
  C-10 crosswalk rows.
- `1ec3be0` search: imported message hit ids built from the **local** imported conversation id
  (`${meta.id}:turn:${position}`), so a hit resolves in this world and cannot collide with an observed copy of the
  same origin conversation; origin ids stay only in `importedFrom`.
- `ad01f06` detail projection: `conversation(id)` derives `${id}:turn:${index}` at read time for imported snapshots,
  so detail ids, hit ids and re-export ids agree. New objects, source copied before edit; stored bytes, origin ids and
  hashes unchanged. Read-time only — nothing migrated or backfilled.
- `1569abc` J1–J4 + N1–N3 journeys, `test/unit/world-journeys.test.mjs`, **7 tests**: restart reopen, project
  link/unlink, search hit opening the same item with stale-selection honesty, export→restore in all three modes with
  idempotent repeat and custody labels, plus tampered-digest, no-confirm and active-session-source negatives.
- `eb38013` export mode picker (radiogroup of the three server modes, reasoning/tool toggles, applied-mode mismatch
  warning). Verified present in `world-view.mjs` (`EXPORT_MODE_LABEL`, `exportMode` state, `scope.parts` body).
- C-11 library reviewed and fixed at `803d165` (root-id/alias rejection, realpath containment, uniform 404); still
  **not mounted**.
- World increment unchanged from the previous refresh: `4c2cd04`, `2d74a09`, `2c62a6d`, `f728480`, `458efde`,
  `803d165` — backend service/relations/search/export/restore, export modes, Relations + Find + Transfer views,
  C-10 catalog, C-11 library.

### DONE (earlier)
- VD-0034 `WORLD_IMPORT_CONTENT` boundary: `contentErrors()` + `IMPORT_CONTENT_LIMITS`, enforced at validate and
  restore, `test/unit/world-import-content.test.mjs`.
- Transfer view: check → dry run → confirm → restore, 8 MB refusals at pick/check/paste, partial and skipped writes
  never reported as success; imported chips, imported-from lines, custody filter.
- Relations view: direction and provenance preserved, unknown kinds never folded into references, truncation honesty,
  stale map dropped on focus change.
- Backend world service, search, export/restore and restore-defect fixes (parent-verified over earlier focused runs of
  39 / 44 / 56 / 58 tests — different suite sets, same fixture tier).
- Coordinator doc, progress ledger, three tracker YAMLs, git-manager agent.
