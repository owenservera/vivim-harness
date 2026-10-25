# VIVIM Harness — agent operating contract

This repository is the **standalone product candidate** extracted from AION Capture Studio. It contains the runnable application, not a second experimental runtime. Read this file before work; invoke specialized instructions when the job fits:
- [ChatGPT / AION GitHub specialist](.opencode/agents/chatgpt-aion.md) — remote GitHub integration and AION agent context.
- [OpenCode / local Windows specialist](.opencode/agents/local-opencode.md) — local execution, runtime, tests and Windows migration.

These two files are specialized subagent profiles, **not** automatically running assistants. A ChatGPT session must be given the relevant file explicitly or read it through GitHub; OpenCode may discover the files under `.opencode/agents/` according to its installed version.

## Governing decisions (from owner conversations, October 11–25, 2026)
- **Deliver actual engineering**: inspect current repo, implement smallest useful fix, run focused tests and the relevant full suite, commit/push proven results. Avoid ritual planning, extra subagents, status documents, formal handoffs and duplicated systems.
- **Windows is the local master**; GitHub is persistent task/evidence transport, not remote desktop control. Never claim a Windows install, browser test, push, or scheduled-task change without execution and verification.
- **No Playwright or Puppeteer.** Use existing CDP-based browser architecture and the one established owner of effects.
- **Capture is read-only by default**; browser send requires explicit scope and effect authorization. Preserve origin/account/tab/thread identity and evidence provenance. Never auto-resend when effect outcome is uncertain.
- **One source of truth**: no second browser actor, message store, adapter registry, knowledge engine or `/chat` UI. Source evidence remains immutable; derived outputs rebuildable. Holdout evidence must be independent; rollback must remain possible.
- Do not leak private captures, auth tokens or credentials into Git. Preserve local datasets, profiles, Chrome sessions and existing scheduled tasks until validated migration.
- User's command convention: `#repo` scopes, `@agent` selects role, `/SITREP` refreshes relevant current status, `/BOOTSTRAP` bootstraps, `+/EXECUTE` means implement. Agent/GitHub messages inform but do not authorize irreversible/local browser effects. Keep SITREP short and grounded in exact SHA/tests.
- No Slack and no speculative infrastructure. Prefer built-in tools. Propose ChatGPT tasks with Instant/Medium/High effort specified.

## Source and cutover truth
- Product source: `owenservera/vivim-harness` root. Original AION folder: `workspace/aion/sessions/roles/09-global-research/labs/website-to-local-streaming/capture-studio/` at AION source SHA `671c0b5a8f1e22822524fccc7543067ab89d121d`.
- The 386 source files were copied with matching Git blob SHAs; **full original Git ancestry was not transplanted**.
- AION original and independent Chrome Relay/Bus/Velocity remain separate. Do not assume the local Windows cutover, CI success or live provider acceptance has happened.
- Product module map: `src/studio` (UI/API), `src/capture` (CDP/turns), `src/decode`, `src/store`, `src/replay`, `src/intel`, `src/profiles`, `src/export`, `src/mcp`, and `bin`.
- Atlas manifest: `architecture/components.json`; run `node scripts/architecture-inventory.mjs --check` after structural changes.

## Verification and closeout
1. Read relevant instructions, current branch/SHA/dirty work, code and recently changed interfaces.
2. Keep development inside existing modules. Verify focused tests then full suite; also check actual browser behavior when reachable.
3. Report truthfully: source-only, synthetic/offline, saved-real-data observation, or live Windows/provider proof. GitHub action `startup_failure` is **not** a passing test.
4. Publish exact changed paths, tests run, measured outcome, SHA, and remaining genuine blockers.

## Git management
For staging, commits and pushes of verified increments, dispatch [git-manager](.opencode/agents/git-manager.md) (free model). It stages explicit paths only and pushes only when the task says "push authorized".

## Coordination trigger
When coordinating ongoing integration or resuming queued work, read docs/agents/integration-coordinator.md, docs/agents/ralph-loop.md, docs/track/queue.md and docs/INTEGRATION-PROGRESS.md before dispatch.
