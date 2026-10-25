# Work queue (Ralph loop state)

Top READY item with no unmet dependency is the next iteration. Evidence tiers: fixture / local-HTTP / synthetic-DOM /
source-only. Nothing here is live, browser, provider or owner-data proof.

HEAD `ad01f06b520690fab30b53734ac728f166729e8b` (2026-10-26 00:19:14 +0100, branch `main`). Tree clean except
untracked `PROMPT.md` and `clone-tmp/` (`git status --porcelain` in this lane).

Lane note: this refresh is docs-only — `docs/track/queue.md` and `docs/INTEGRATION-PROGRESS.md`. `docs/track/worklog.yaml`
was **not** touched (outside this lane's scope); it is stale at `8098b12` and its W12 evidence still says no J1–J4
journey exists, which `1569abc` contradicts.

## RUNNING
- C-10 defect fixes. One free review of `src/studio/commands.mjs` reported **10 defects**; the fix lane is running and
  nothing has landed (`git log -- src/studio/commands.mjs` = `2c62a6d` only, tree clean). The module stays unmounted
  (`integration-hub.mjs` imports only `registerWorldRoutes`). The review output is analysis, not proof, and no defect
  list exists as a committed artefact.

## READY — owner decision (blocked on owner, not on code)
1. Mount C-10 and/or C-11 on the hub. Both are committed, tested and deliberately unmounted; wiring is a value
   decision, not a bug. Suggested narrow option: C-11 read-only with the repo root as its only root; C-10 preview-only
   with no execution grant. Either way mounting must not grant an effect.
2. VD-0057 composed workspace (conversation + project + saved objects in one surface). UI design work, not a wiring
   fix; may need the paid `luna-medium` lane. No lane dispatched.
3. Whether `PROMPT.md` and `clone-tmp/` may be pushed at all. Both are untracked and have been kept out of every
   commit in this increment; no owner instruction exists either way.

## READY — dispatchable
4. Tracker-lane refresh of `docs/track/worklog.yaml` (last written `8098b12`): W12 evidence, W13/W14 and the C-10
   review state all predate `ed1d6b7`, `1ec3be0`, `1569abc`, `ad01f06`.
5. Commit this docs refresh via `git-manager`, explicit paths, no push unless authorized (needs: parent decision on
   push, see READY 3).
6. Formal testing pass per owner schedule (next week): full repo suite plus W12 acceptance, reported at its real tier.
   First-hand focused evidence at `ad01f06`, this lane: **62 pass / 0 fail / 0 skipped** across 10 world suites;
   **27 pass / 2 skipped / 0 fail** across `commands` + `agentic-files` (29 tests, skips platform-gated);
   architecture inventory **0 uncovered, 0 missing ownership**. Parent-reported, different suite sets: 88 across 14
   world/UI suites; 63 across UI+agentic; the earlier 101/2/0 run at `803d165` is superseded in count, same tier.

## BACKLOG (from atlas/worklog gaps)
- W12 formal acceptance. The J1–J4 journeys now exist (`1569abc`, 7 tests, fixture-level HTTP) but do not close W12:
  the "second instance" is a second `startStudio()` in the same process, there is no conflicting-import case, no
  secret-exclusion scan, and no import→export round trip through the UI.
- Exact part deep link: `partPath` travels in a Find hit but `openHit()` (`src/studio/ui/world-view.mjs:1421`) focuses
  the message node by index and never reads `partPath`; no part-level target is opened.
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
