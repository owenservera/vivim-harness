# VIVIM Harness — agent operating contract

This repository is the **standalone product candidate** extracted from AION Capture Studio. It contains the runnable application, not a second experimental runtime. Read this file before work; invoke specialized instructions when the job fits:
- [ChatGPT / AION GitHub specialist](.opencode/agents/chatgpt-aion.md) — remote GitHub integration and AION agent context.
- [OpenCode / local Windows specialist](.opencode/agents/local-opencode.md) — local execution, runtime, tests and Windows migration.

These two files are specialized subagent profiles, **not** automatically running assistants. A ChatGPT session must be given the relevant file explicitly or read it through GitHub; OpenCode may discover the files under `.opencode/agents/` according to its installed version.

## Governing decisions (from owner conversations, October 11–25, 2026)
- **Deliver actual engineering**: inspect current repo, implement smallest useful fix, run focused tests and the relevant full suite, commit/push proven results. Avoid ritual planning, extra subagents, status documents, formal handoffs and duplicated systems.
- **Windows is the local master**; GitHub is persistent task/evidence transport, not remote desktop control. Never claim a Windows install, browser test, push, or scheduled-task change without execution and verification.
- **Live-first development is the default**: when the live server, dedicated VIVIM browser, or provider is available and within authorized scope, inspect and test the actual runtime early; use observations to guide the smallest useful fix instead of repeatedly theorizing. Keep fixture tests for regression and dangerous edge cases, and distinguish live proof from synthetic results.
- **Live safety**: use the existing browser-effect owner; preserve active sessions and unresolved evidence. Read-only inspection is not permission to send, restart, close, clear, or overwrite; honor the owner's explicit effect scope and never resend an uncertain turn.
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

## Model routing for specialist lanes
- Look up the exact model id and its variants before use; ids and variant sets differ per model and change without notice.
- New lane: pass the model at dispatch as `provider/model#variant`. Lane-scoped and preferred — it leaves the parent session untouched.
- Running lane, variant change: switch it in place. Cancelling and respawning discards the context the lane already built for no gain.
  - `opencode api session.switchModel --param sessionID=<id> -d '{"model":{"providerID":"opencode","id":"deepseek-v4.1-flash-free","variant":"max"}}'`
  - The route is `POST /api/session/{sessionID}/model`; the body's `Model.Ref` is `{providerID, id, variant?}` and `variant` is what selects the reasoning tier.
  - It changes the model used by **subsequent provider turns**; an in-flight step is not interrupted.
  - Call the server through the `opencode api` CLI, which authenticates. A direct `fetch` to the loopback API port returns `401 Authentication required`.
- Never report a switch as done without read-back: `opencode api get /api/session/<id>` and confirm `data.model.providerID`, `.id`, `.variant`. The `switchModel` call itself returns `204` with no body, so an empty response is not evidence.

## Coordination trigger
When coordinating ongoing integration or resuming queued work, read docs/agents/integration-coordinator.md, docs/agents/ralph-loop.md, docs/track/queue.md and docs/INTEGRATION-PROGRESS.md before dispatch.
