# Work queue — one canonical active sprint

**2026-10-26 · Remote Harness source merged to main via PR #3 at `842a8c472a58118ea84a77ae4a9704ece9ee4111`.** The GitHub `main` may have later docs commits; local owner must verify actual remote/local HEAD. This file is the **single ordered queue**, not the old source-tracker estimates below. Execution issue: [#4](https://github.com/owenservera/vivim-harness/issues/4). One detailed [local OpenCode runbook](../sprints/R456-LOCAL-SPRINT-2026-10-26.md). **No local session was remotely launched.** Real Windows & browser status: **NOT RUN / G5 NOT ACCEPTED**.

## ACTIVE SPRINT — R4/R5/R6 WORLD local integration and release evidence

| Order | State | Local owner / scope | Concrete next action | Dependency | Evidence / close condition |
|---|---|---|---|---|---|
| **L0** · W00 | **READY** | Windows local-master / **read-only** Git/process snapshot | Check `git status`, worktrees, active PROVIDER mission, clean baseline, merged main, model available; protect existing local changes | None; GitHub merge already verified | Local git SHA/branch, active session and source/effect ownership; safe isolated worktree or explicit stop |
| **L1** · Q04/Q07, W05/W07/W11/W12 | **BLOCKED: L0** | Same local OpenCode test owner / `src/studio/ui/world-view.mjs`, `src/studio/world-service.mjs`, `test/unit/world-*.test.mjs` **only on failures** | Run focused world/UI R456 suites, `npm test` full suite, architecture inventory; fix real regressions, don't rebuild existing app | L0 ownership cleared | Exact Node pass/fail/skip, diff SHA, `npm test`/inventory outputs, committed fixes when needed |
| **L2** · Q08, W06/W12 | **BLOCKED: L1** | Local Studio process owner / **disposable data roots only** | Real second independent OS Studio process restart, preserved source file hashes, CAS collision/crash recovery | L1 relevant checks green | T3p process IDs, source hashes, local record integrity and version/failure receipts |
| **L3** · Q01/Q02/Q04/Q07/Q10, W03–W12 | **BLOCKED: L1,L2** | Same owner / one **existing** `/chat` UI / manual real browser; **no CDP send or second actor** | Human J1 RETURN → J2 ORGANIZE → J3 FIND → J4 TAKE incl. native part/source link, project/note, exact search focus, JSON file clean-root import, partial truth and keyboard/narrow screen | L1+L2 and browser/effect-owner clear | T3u observed UI/download/import and local custody/ID receipts; don't infer from fake DOM |
| **L4** · R6 A01–A18/G0–G6 | **BLOCKED: L1–L3** | Same owner / tests + one `docs/sprints/R456-LOCAL-SPRINT-RECEIPT.md` only | Adversarial secret boundaries, corrupted bundle/digest/CAS/stale effects; final proof/rollback; update issue #4 and progress ledger | L1+L2+L3 | Safe SHA/count/evidence grade by gate; G5 accepted **only with T3p and T3u** |

**Dispatch/authorization:** L0 is ready for a *local* OpenCode session when the human-controlled PC picks it up. ChatGPT GitHub work cannot silently execute, install or reschedule Windows agents. If another owner is working on `PROMPT.md`'s **three-provider native-turn** mission, L0/L1 may use an isolated worktree, but L2/L3 must not preempt its Chrome/effect owner. No Playwright/Puppeteer or Slack.

**Remote CI blocker (not a test failure claim):** hosted GitHub Actions on Ubuntu+Windows Node 22/24 repeatedly reported `startup_failure`/zero steps with unavailable logs. Until runner/billing/configuration is diagnosed by the actual GitHub administrator, rely on transparent local Node receipt. Never say CI passed or that `npm test` failed for a proven code assertion.

**HOLD (not in current G5 acceptance):** R4-I3 missing source binary bytes/native artifact versions; generalized automatic DLP/redaction of message text; optional C10/C11 mounting; and separate T4 provider-native mission. Don't re-open without an actual owner decision or reproduced defect.

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
