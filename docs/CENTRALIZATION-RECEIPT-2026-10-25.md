# AION → VIVIM Harness: implementation migration receipt (2026-10-25, amended 2026-10-27)

Canonical product source: [owenservera/vivim-harness](https://github.com/owenservera/vivim-harness). AION is coordinator and historical source, not the destination for new implementation.

This receipt was originally written on branch `centralize/aion-assets-20261025` (PR #1) when the whole branch was proposed for merge. It is amended here to describe **what actually landed on `main`**, after the branch was reconciled commit-by-commit on 2026-10-27. The unamended branch text claimed a `test/qa` parallel suite and a CI matrix; neither exists on `main` (hosted Actions was removed in `3503195` and verification is local-only).

Blob hashes below identify the AION source content **before** the path rewrites; they are provenance, not equality proofs for the landed files.

## Landed: saved-session outcome packet

| Kind | AION source blob | Destination on main |
| --- | --- | --- |
| implementation | `a3882b0ec8055745410e0b1f4a7b8d14acbb19a1` | `src/export/outcome-packet.mjs` |
| implementation | `d2326b11216509f64f83ffadc9941dd285065f10` | `src/export/saved-session-outcome.mjs` |
| executable | `12843b963d2fc9212628c7b0a4bab60ffe6e3c64` | `scripts/value-oracle-demo.mjs` |
| fixture | `196fc4ab807cb2fab7b301038d0268cca03daaec` | `test/fixtures/value-oracle/demo.json` |
| test | `04052842d995ce156dcbe6b8b7b296fb304dc852` | `test/unit/outcome-packet.test.mjs` |
| test | `7edb3b24e6764a63b09ac9fb87b959c15e28e3a0` | `test/unit/saved-session-outcome.test.mjs` |

These two modules are the only genuinely new implementation in the branch: nothing on `main` produced an outcome packet before this import. `scripts/live-e2e.mjs` used to import the same logic from outside the repository (six directory levels above the checkout); it now resolves `src/export/saved-session-outcome.mjs` in-repo, so step 8b is checkable inside this tree.

## Landed: QA fidelity coverage bound to canonical modules

| Kind | AION source blob | Destination on main |
| --- | --- | --- |
| test | `747a65c0eeccdc75a93e9293b3a1c63333832812` | `test/unit/native-shape-fidelity.test.mjs` |
| test | `b37d6d02302a37ae6fca1614c27dc108ad0f55d5` | `test/unit/replay-fidelity.test.mjs` |
| benchmark | `e946099bb11f4ab86b7027421390b26c6aad74ed` | `scripts/bench-agent14-systems.mjs` |

Both tests are new coverage rather than duplicates: `replay-fidelity` proves RawLog → reducer → decoder byte equality (main previously tested decoder/dialect semantics only), and `native-shape-fidelity` proves the components → stream messages → DOM join. The benchmark reads main's existing `test/unit/fixtures/systems-fixtures.json` instead of importing a byte-identical copy.

`replay-fidelity.test.mjs` carries one explicitly marked TODO (QA-S1-F1): family build does not yet exclude sessions without a passing acceptance verdict, because no evaluator exists. It is recorded as a TODO, not a silent pass.

Every landed test was moved from `test/qa/` to `test/unit/` so the existing `npm test` glob (`test/unit/**/*.test.mjs`) runs it. No parallel suite script and no second verification path was introduced.

## Rejected as duplicate (not merged)

Eleven Agent 14 test files and four fixtures from the branch were byte-identical, path-only variants, or strict subsets of files `main` already runs under `test/unit/`: `four-lane-gates`, `harness-executor-preflight`, `adaptive-adapter-factory`, `adapter-capture-to-signals`, `systems-probes`, `universal-chat`, `core-runtime-bridge`, `round9-guardrails`, `harness-runs`, `adapter-improvement-pipeline`, `uncertain-step-reconciler`, plus `test/fixtures/agent14/{offline-fixture,universal-chat-fixtures,systems-fixtures}.json`. Importing them would have added a second copy of coverage that already passes, and `test/fixtures/agent14/proposal-example.json` was referenced by nothing.

Also rejected: `.github/workflows/ci.yml` (main removed hosted Actions deliberately), and `docs/centralization-source-ownership.json` (its recorded `harnessBranch` SHA was already stale, 38 of its 66 canonical targets are absent from main by design, and it asserted an active CI leg that no longer exists).

## Deferred, with measured evidence

`test/qa/sprint01-temporal-graph.test.mjs` and `test/qa/sprint02-capture-safety.test.mjs` were not merged. `docs/sprints/R456-LOCAL-SPRINT-RECEIPT.md` records the branch's own triage: 299 tests, 289 pass, 9 fail, all fixture-or-policy drift, no product defect. Eight of the nine are in `sprint02`, where the assertions encode a credential-filtering default that conflicts with the shipped `local-raw` capture policy. Merging them as-is would either fail or silently redefine capture privacy, so they need an explicit policy decision, not a mechanical rebase.

## Verification boundary

Verification on main is local: `npm test` (`node --test "test/unit/**/*.test.mjs"`) on Windows. No hosted CI result is claimed, and none exists.
