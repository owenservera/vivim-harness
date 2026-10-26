# VIVIM Harness — R4/R5/R6 LOCAL SPRINT 01

**Date:** 2026-10-26 · **Owner:** one locally-authorized Windows/OpenCode session · **Thinking effort:** HIGH (executor), MEDIUM (focused fixes), INSTANT (reporting only). **Status:** READY FOR LOCAL PICKUP; **not started remotely**.

**Authority:** Windows checkout remains sole human/master. Canonical implementation is [`owenservera/vivim-harness` main](https://github.com/owenservera/vivim-harness), at remote merge baseline [`842a8c472a58118ea84a77ae4a9704ece9ee4111`](https://github.com/owenservera/vivim-harness/commit/842a8c472a58118ea84a77ae4a9704ece9ee4111). This is the squash merge of [PR #3](https://github.com/owenservera/vivim-harness/pull/3). Always inspect newer actual main and local HEAD, never pin pull to an older SHA. **Sprint GitHub issue:** [#4](https://github.com/owenservera/vivim-harness/issues/4). **Only ordered queue:** [`docs/track/queue.md`](../track/queue.md); this file is the detailed execution/runbook for those same items, not a competing task tracker.

**Source investigations:** AION Product Agent Role 15 [R4](https://github.com/owenservera/aion/blob/main/workspace/aion/sessions/roles/15-product-to-market/remote-prep-2026-10-26/R4-CAPTURE-TO-WORLD-TRUTH-MATRIX.md), [R5](https://github.com/owenservera/aion/blob/main/workspace/aion/sessions/roles/15-product-to-market/remote-prep-2026-10-26/R5-HUMAN-JOURNEY-COMPOSITION-MAP.md), [R6](https://github.com/owenservera/aion/blob/main/workspace/aion/sessions/roles/15-product-to-market/remote-prep-2026-10-26/R6-ADVERSARIAL-ACCEPTANCE-MATRIX.md). Code and tests are now **in Harness main**; do not re-create them. [Merged receipt](https://github.com/owenservera/aion/blob/main/workspace/aion/sessions/roles/15-product-to-market/remote-prep-2026-10-26/R456-INTEGRATION-EXECUTION-RECEIPT-2026-10-26.md).

## The five finite sprint gates

| Order / IDs | One action that advances the product | Pass evidence | Fail/stop contract |
|---|---|---|---|
| **L0 · W00** local-master reconciliation | Discover actual Windows Git state, existing `PROMPT.md` provider mission, active worktrees, installed Node/OpenCode and single CDP owner. Bring merged `main` into a safe separate worktree only if owner files are free. | Actual `git status`, `worktree list`, `git rev-parse HEAD`, no untracked files or profiles overwritten | Stop on overlapping work/dirty conflict; do not reset, clean, overwrite, force push, kill Chrome or schedule tasks |
| **L1 · Q04/Q07, W05/W07/W11/W12** source & executable regression | Run architecture check, targeted source/world/UI/security/test suites and complete `npm test` from the merged commit. Fix actual reproducible failures in the **one** existing implementation; no new service/frontend/store. | Exact command + Node version + pass/fail/skip; new `world-r456-integration` and `world-r456-search-http-ui` passes on actual Node/loopback | A failure means defect; keep it red and create one minimal fix with test + SHA; never cite synthetic V8 checks as Node pass |
| **L2 · Q08, W06/W12 · G2/G5** real durability | Test two genuinely independent OS processes with the **same disposable** root; verify DOM_TURNS source hash unchanged across project/source-ref/selection/note edits and restarts, CAS conflict/draft retention and recovery after simulated interrupted save. | Distinct OS PIDs, process exit/restart, before/after source hashes, same record IDs/versions and actual observed behavior; tier **T3p** | Avoid private data or existing Studio process/ports. Same-process second `startStudio()` is only T2 and cannot close this gate |
| **L3 · Q01/Q02/Q04/Q07/Q10, W03/W04/W05/W07/W09–W12 · G1–G5** single-app user journey | In a **real local browser**, offline WORLD (no capture/send), J1 **RETURN** saved mixed native content/links/code/table/unknown/truncation → J2 **ORGANIZE** save visible message part into an existing or new project, add note, CAS collision & duplicate prevention → J3 **FIND** unique code part and follow selection→object→saved source, stale fallback → J4 **TAKE** inspect export scope, actual JSON download, validate/dry-run/confirm into second fresh disposable root, open imported items, prove partial-result honesty. Add keyboard/narrow-screen and no-provider first-run checks. | Real browser interactions; exact source IDs, scope, version and saved root; actual JSON file; imported custody distinct; tier **T3u** | T1 fake DOM cannot substitute. No Playwright/Puppeteer, browser/Chrome takeover, unapproved provider send, or user-private captures in fixtures |
| **L4 · R6 A01–A18, Q03/Q08/Q09, G5** security & release verdict | Run synthetic malicious/bounded imports, tampered digest, collision, partial HTTP 200, anti-HTML injection, stale source and CAS. Verify reference-only exclusion vs transcript/full-saved raw-body risk, URL pathname/nested-link exposure, no captured remote binary bytes or native edit history. Capture one final source-only/T0/T1/T2/T3p/T3u gate table; fix any confirmed release-blocker in existing modules, push verified work and decide G5 only on real proof. | A dated `docs/sprints/R456-LOCAL-SPRINT-RECEIPT.md` with case IDs, exact SHA/commands/results, safe saved-file hashes, regression/rollback notes; issue #4 checklist updated | **Never** call an SHA-256 digest exporter authentication or full secret scrub; **never** call G5 accepted if T3p or T3u missing |

**No endless queue:** complete L0→L4, then stop with explicit `PASSED` / `BLOCKED` / `NOT RUN` cases. R4-I3 binary asset bytes/version history and optional C10/C11 mounting are **owner-choice HOLD**, not an excuse for parallel new capture actors. R6 arbitrary DLP/redaction requires owner selection; transcript/full-saved deliberately preserve saved raw text. The provider-native T4 lane is separate.

## Copy-ready local OpenCode execution directive

> Run the following in **the established local OpenCode session**, after checking its active mission and model availability. This text does not remotely install/run an agent.

```text
#VIVIM-HARNESS @LOCAL-OPENCODE +/EXECUTE /R456-LOCAL-SPRINT-01

THINKING EFFORT: HIGH. You are the sole Windows local-master implementation and
verification owner for the existing VIVIM Harness; don't create another actor,
orchestrator, store, frontend, repo or task ledger. GitHub issue #4 and
docs/sprints/R456-LOCAL-SPRINT-2026-10-26.md are your exact finite sprint scope.
Main already contains R4/R5/R6 via squash merge 842a8c472a58118ea84a77ae4a9704ece9ee4111.
Fetch newest main safely, inspect local state/owner concurrency first.
AION is NOT assumed cloned locally.

READ FIRST: root AGENTS.md, .opencode/agents/local-opencode.md,
docs/agents/integration-coordinator.md, docs/agents/ralph-loop.md,
docs/track/queue.md, docs/INTEGRATION-PROGRESS.md, PROMPT.md, and this runbook.

GATE L0: check git status/HEAD/remote/worktrees, recent changes and any active
PROVIDER-lane work. Preserve untracked files, local master, saved sessions,
active ports, process ownership and existing scheduled tasks. No reset/clean,
force push, new browser actor, Chrome takeover, Playwright/Puppeteer or Slack.
No automatic retry of an uncertain provider send. If conflict, use an isolated
worktree and report the conflict; do not rebase/overwrite a running owner.

GATE L1: actual Node architecture check, focused tests for
world-r456-integration, world-r456-search-http-ui, world-service/search,
world-ui/find/workspace/transfer, world-import-hardening, world-provider-url,
world-journeys, then full npm test. Report actual counts and failures.
Fix reproducible defects in existing modules only. Commit/push explicit paths
once verified; read back remote SHA.

GATE L2: two independent Studio OS processes against disposable data root,
real terminate/restart/records/CAS/hash integrity, no private owner root.

GATE L3: REAL manual-local browser /chat, J1 RETURN → J2 ORGANIZE →
J3 FIND → J4 TAKE with observed source content, project + part selection +
note, Find exact part/source-return/stale, JSON export/import to clean root,
partial outcome, keyboard/narrow-screen/offline, no provider effects.

GATE L4: adversarial A01–A18 privacy, tamper, size, injection, CAS,
import/export semantics and G0–G6 release decision. Source-only success is
NOT product/browser acceptance. Preserve nuanced R4 capture limits.
Make a single source-safe, dated docs/sprints/R456-LOCAL-SPRINT-RECEIPT.md
with SHA, tested commands/results, OS PIDs/roots (without private secrets),
real T2/T3p/T3u evidence, defects/remaining risks and rollback; link issue #4.
Push verified changes to the approved branch, reconcile main without
overwriting local, and close issue #4 ONLY if all mandatory gates pass.

ALSO: current PROMPT.md PROVIDER-native three-turn mission is a separate
owner-authorized lane. Do not cancel or preempt it. If another session is
actively executing that lane, run non-browser L0/L1 only in an isolated
worktree until ownership is clear; do not run competing Chrome/effect actor.

Your job ends only with an executed sprint receipt or a real named blocker,
not a theoretical plan. No invented Windows/browser pass.
```

## Safe Windows PowerShell preflight and tests

These commands inspect the local repo **without touching saved user data**. Run them manually in the usual PowerShell 7 terminal, or let the local OpenCode executor run them after checking ownership:

```powershell
Set-Location 'C:\0-BlackBoxProject-0\vivim-harness'
git status --short --branch
git worktree list --porcelain
git remote -v
git log -1 --format='%H %s'
node --version
npm --version
git fetch origin main
git log -3 --oneline origin/main
```

**Do not blindly `git pull` or `git reset`.** If the active checkout is dirty, or an OpenCode PROVIDER session owns it, stop that checkout's migration and use a **new disjoint worktree** only after checking `git worktree list`. Example if path does not exist: `git worktree add --detach 'C:\0-BlackBoxProject-0\vivim-harness-r456-sprint' origin/main`. This isolates source and tests; it does **not** authorize a second running Studio/Chrome process. Source changes in a detached worktree need a named feature branch before committing.

On the verified source worktree with Node 22+:

```powershell
node scripts/architecture-inventory.mjs --check
node --test test/unit/world-r456-integration.test.mjs test/unit/world-r456-search-http-ui.test.mjs test/unit/world-service.test.mjs test/unit/world-search.test.mjs test/unit/world-ui.test.mjs test/unit/world-ui-find.test.mjs test/unit/world-ui-workspace.test.mjs test/unit/world-ui-transfer.test.mjs test/unit/world-journeys.test.mjs test/unit/world-import-hardening.test.mjs test/unit/world-provider-url.test.mjs
npm test
node bin/studio.mjs help serve
```

`npm test` and `bun run test` invoke the repo's **Node** test script; `bun test` runs a different framework and cannot stand in for that proof. Also run `node --check src/studio/ui/world-view.mjs` and `node --check src/studio/world-service.mjs` if diagnosing parser issues.

For L2/L3, **only after local ownership is confirmed**, choose a fresh root under e.g. `$env:TEMP\vivim-r456-proof-<unique-id>` (not the default `CAPTURE_STUDIO_HOME`, not Chrome profile). Verify flags with `node bin/studio.mjs help serve`; use the documented **`serve` UI-only** command with explicit `--data-dir` on a free port and ensure you stop only the process you launched. Never run default `start` for WORLD acceptance: it launches a capture browser. The local owner should seed synthetic `DOM_TURNS` through existing test fixture APIs and confirm the new data root lacks private owner captures. Use **two separate OS process launches** to record T3p. A browser should point only at the owned disposable Studio HTTP UI; do not attach a second CDP controller.

### Priority defect classes and ownership

- **R4-I1/I2:** citation/inline + truncated-original-length already merged. Check XSS, duplicate links, capture provenance and safe fallback; don't add missing file bytes or claim native history. **R4-I3** saved artifact text/bytes stays HOLD until need established.
- **R5-I1/I2:** UI part→object→selection→project (+ note) and selection→source jump already merged. Test pagination, uncertain POST status, CAS retry/selected-source stale revision with no repeated side effects.
- **R5-I3/I4:** exact `partPath` producer→HTTP→UI regression added; post-import list invalidation and direct navigation merged. Confirm real browser/file paths and honestly report failed records.
- **R5-I5:** offline first run and keyboard/narrow UX should be accepted on a **real browser**, not fake DOM.
- **R6:** existing import boundaries/CAS/scoped export retained. A01–A18 adversarial and nested secrets/URL path are proof+policy tasks; arbitrary automatic redaction needs a separate decision.
- **Current GitHub Actions:** all Windows/Ubuntu Node 22/24 jobs report **startup_failure/no executed steps and unusable logs**. Hosted CI remains **red/unverified**, not evidence of `npm test` failing assertions. L1 local Node execution is mandatory while hosted runners are blocked.

**One canonical closeout:** Record L0–L4 in [GitHub issue #4](https://github.com/owenservera/vivim-harness/issues/4), one dated receipt under `docs/sprints/`, and the existing progress ledger; only after inspecting actual implementation/test proof should a local owner mark work `done`. Do not automatically schedule monitoring or claim sprint activation on Windows.
