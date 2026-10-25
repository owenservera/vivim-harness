# Work queue (Ralph loop state)

Top READY item with no unmet dependency is the next iteration. Evidence tiers: fixture / local-HTTP / synthetic-DOM /
source-only. Nothing here is live, browser, provider or owner-data proof.

HEAD `803d165a9a8b7814f45128060c0f66b5b851659c` (2026-10-26). Tree clean except untracked `PROMPT.md` and `clone-tmp/`.

## RUNNING
- Acceptance lane (unfinished): J1–J4 integrated scenario test — worklog W12. Scope `test/` only. One command, one
  environment, one SHA; must cover restart, partial write, missing source, conflicting import, secret exclusion.
  Nothing exists yet: `test/unit/acceptance*.test.mjs` are provider capture G1–G7 tests, not world journeys.

## READY
1. Commit this docs refresh (`docs/INTEGRATION-PROGRESS.md`, `docs/track/worklog.yaml`, `docs/track/queue.md`) via
   `git-manager`, explicit paths, no push unless authorized (needs: nothing; parent decision on push).
2. Owner decision: mount C-11 agentic files and/or C-10 command catalog on the hub. Both are committed, tested,
   reviewed and deliberately **unmounted**; wiring is a value decision, not a bug (needs: owner).
3. Refresh `docs/track/atlas.yaml` + `docs/track/crosswalk.yaml`: C-10/C-11 still say "none found" and VD-0021
   still says `not_started`, contradicting `2c62a6d`, `2d74a09`, `803d165` (needs: tracker lane, docs-only).
4. Formal testing pass per owner schedule (next week): full repo suite plus the acceptance item above, reported at
   its real tier. Focused evidence already in hand at `803d165`: 101 pass / 2 skipped / 0 fail across 13 world
   suites + `agentic-files` (103 tests), `agentic-files` alone 21/2/0, architecture inventory 0 uncovered /
   0 missing ownership. Parent-reported, different suite sets: 88 across 14 world/UI suites; 63 across UI+agentic.

## BACKLOG (from atlas/worklog gaps)
- W12 integrated acceptance scenario (above; formal testing is next week).
- VD-0057 composed workspace: conversation + project + objects in one surface (today: three list views plus memberIds).
- Exact part deep link: `partPath` travels in a Find hit but `openHit()` focuses the message node, not the part.
- Secret-exclusion proof: scan an actual exported bundle for cookies/tokens/profile data; exclusion is currently by
  construction only. Needs a real (or realistic) bundle, not a fixture assertion.
- VD-0021 selectable export modes: shipped in `2d74a09` + `eb38013`; atlas row is stale, not the code.
- Security program: owner-scheduled, in two weeks. No audit artefact exists.
- Browser/keyboard/screen-reader pass over the seven shell views: five UI suites are synthetic-DOM only.

## DONE (since last update)
- World increment committed: `4c2cd04` world service/relations/search/export/restore with imported custody;
  `2d74a09` export modes `references|transcript|full-saved` with explicit reasoning/tool parts; `2c62a6d` C-10
  preview-only command catalog; `f728480` + `458efde` Relations view and labelled reasoning/status/tool blocks;
  `eb38013` export mode picker; `803d165` C-11 read-only agentic-file library (reviewed twice, unmounted).
- VD-0034 `WORLD_IMPORT_CONTENT` boundary: `contentErrors()` + `IMPORT_CONTENT_LIMITS`, enforced at validate and
  restore, `test/unit/world-import-content.test.mjs`. Committed, covered in the 103-test run.
- Find view (query, kind filter, paging, coverage honesty, `openHit()`); imported `c-i…` ids and
  `imported-reference` source recognised by search; `originSessionId` no longer surfaced as a local alias.
- Transfer view: check → dry run → confirm → restore, 8 MB refusals at pick/check/paste, partial and skipped writes
  never reported as success; imported chips, imported-from lines and the observed/imported/all custody filter.
- Relations view: direction and provenance preserved, unknown kinds never folded into references,
  truncated/complete/not-reported kept apart, stale map dropped on focus change.
- Ledger + worklog refreshed with split evidence attribution (this lane's run vs parent-reported runs).

## DONE (earlier)
- Backend world service, search, export/restore and restore-defect fixes (parent-verified over earlier runs of
  39 / 44 / 56 / 58 focused tests — different suite sets, same fixture tier).
- Coordinator doc, progress ledger, three tracker YAMLs, git-manager agent.
