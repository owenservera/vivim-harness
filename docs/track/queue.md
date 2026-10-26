# Work queue (Ralph loop state)

Top READY item with no unmet dependency is the next iteration. Evidence tiers: fixture / local-HTTP / synthetic-DOM /
source-only. Nothing here is live, browser, provider or owner-data proof.

HEAD `20574af45c494db46908e8d0dbf5cf8da9531f9f` (origin/main; 2026-10-26 00:37:22 +0100, branch `main`). Tree clean
except untracked `PROMPT.md` and `clone-tmp/` (`git status --porcelain` in this lane).

Lane note: this refresh is docs-only — `docs/track/queue.md` and `docs/track/crosswalk.yaml`. `docs/track/worklog.yaml`
was refreshed at `20574af` (basis `007e357`) and is outside this lane's scope.

## RUNNING
- search-side `partPath`. A free lane is emitting `partPath` on message hits (needs block-level match info) so the Find
  part focus committed in `007e357` stops being dormant. Nothing reported landed yet.
- `FORMAL-TEST-PREP` doc. Preparation for the owner-scheduled formal pass (READY 5); being written now.

## READY — owner decision (blocked on owner, not on code)
1. Mount C-10 and/or C-11 on the hub. Both are committed, tested and deliberately unmounted; wiring is a value
   decision, not a bug. Suggested narrow option: C-11 read-only with the repo root as its only root; C-10 preview-only
   with no execution grant. Either way mounting must not grant an effect.
2. VD-0057 composed workspace (conversation + project + saved objects in one surface). UI design work, not a wiring
   fix; may need the paid `luna-medium` lane. No lane dispatched.
3. Whether `PROMPT.md` and `clone-tmp/` may be pushed at all. Both are untracked and have been kept out of every
   commit in this increment; no owner instruction exists either way.

## READY — dispatchable
4. Commit this docs refresh via `git-manager`, explicit paths, no push unless authorized (needs: parent decision on
   push, see READY 3).
5. Formal testing pass per owner schedule (next week): full repo suite plus W12 acceptance, reported at its real tier.
   First-hand focused evidence at `ad01f06`, earlier lane: **62 pass / 0 fail / 0 skipped** across 10 world suites;
   **27 pass / 2 skipped / 0 fail** across `commands` + `agentic-files` (29 tests, skips platform-gated);
   architecture inventory **0 uncovered, 0 missing ownership**. Parent-reported, different suite sets: 88 across 14
   world/UI suites; 63 across UI+agentic; the earlier 101/2/0 run at `803d165` is superseded in count, same tier. This
   lane re-ran `commands` (**12 pass / 0 fail**) and `agentic-files` (**21 pass / 2 skip / 0 fail**) at `20574af`.

## BACKLOG (from atlas/worklog gaps)
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

## DONE (since last update at `803d165`)
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

## DONE (earlier)
- VD-0034 `WORLD_IMPORT_CONTENT` boundary: `contentErrors()` + `IMPORT_CONTENT_LIMITS`, enforced at validate and
  restore, `test/unit/world-import-content.test.mjs`.
- Transfer view: check → dry run → confirm → restore, 8 MB refusals at pick/check/paste, partial and skipped writes
  never reported as success; imported chips, imported-from lines, custody filter.
- Relations view: direction and provenance preserved, unknown kinds never folded into references, truncation honesty,
  stale map dropped on focus change.
- Backend world service, search, export/restore and restore-defect fixes (parent-verified over earlier focused runs of
  39 / 44 / 56 / 58 tests — different suite sets, same fixture tier).
- Coordinator doc, progress ledger, three tracker YAMLs, git-manager agent.
