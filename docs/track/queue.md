# Work queue (Ralph loop state)

Top READY item with no unmet dependency is the next iteration. Evidence tiers: fixture / source-only. Nothing here is live proof.

## RUNNING
- UI owner `ses_e8b0bda99ffeE6bBzA7vvt9bI7`: Transfer view, imported chips, custody filter. Scope `src/studio/ui/*`, `test/unit/world-ui*.test.mjs`.
  - Known: `world-ui.test.mjs:43` currently fails (expects `/transfer/export` text); likely mid-edit.

## READY
1. Rerun combined suite after UI owner lands; verify Transfer view against the final restore contract (needs: UI owner).
2. Commit increment 1 via `git-manager` (explicit paths, no push) (needs: item 1 green).
3. VD-0034 validated content boundary: validate imported block payloads at import (backend owner `ses_e8b25fcc0ffenzM6egdIoYX4AS`; scope world-transfer/world-service + tests).
4. Search owner: recognize `c-i...` imported ids and `imported-reference` source; stop surfacing `originSessionId` as a local alias (`ses_e8b04c6d6ffeviQ5wC58oXGW7R`).
5. Free review of the Transfer view and the restore-defect fixes (DeepSeek, read-only).
6. Progress keeper `ses_e8b0588e2ffeIAOxa01JPc9IqJ`: update ledger for restore, Find, imported search, new tests.

## BACKLOG (from atlas/worklog gaps)
- Present `/world/map` data in a view (nothing consumes it).
- VD-0022 reasoning/status blocks reader; VD-0014 tool-call lifecycle labels.
- VD-0021 selectable export modes.
- C-11 agentic file library (core; execution deferred).
- W12 integrated acceptance scenario (formal testing is next week).

## DONE (since last update)
- VD-0034 import content boundary (backend self-reported 48 pass; parent rerun pending, free review dispatched).
- Search imported ids/source (self-reported 40 pass; parent rerun pending).

## DONE
- Backend world service/relations, search, export, restore, restore-defect fixes (58 tests, parent-verified earlier).
- Find view; imported-snapshot search (19 search tests).
- Coordinator doc, progress ledger, three tracker YAMLs, git-manager agent.
