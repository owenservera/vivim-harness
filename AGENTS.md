# VIVIM Harness — start here

This repository is the runnable VIVIM product. **Do the assigned work now**; no repository-wide ceremony, fresh status documents, or redundant agent launches.

OpenCode v2 automatically loads this file. Project `opencode.json` automatically loads **`context.md`** as the single shared native CLI command and runtime helper. Do not read it again unless the active instructions are missing or the specific task requires more detail.

## Dispatch
- **100-objective probe:** assign one distinct objective from `docs/agents/CHATGPT-100-OBJECTIVES.md` to `@chatgpt-probe`. Probe sees the shared CLI helper and its *assigned* objective, not internal source or scripted solutions. Parallel read-only probes are fine; serialize browser mutations through the one existing Studio owner.
- **Bug / implementation:** use the smallest relevant code surface; implement and verify, then commit/push on `main` where possible. `@local-opencode` handles focused local debugging. Developer may inspect source, probe may not.
- **OpenCode orchestration or model configuration:** read `docs/agents/OPENCODE-V2.md` once per coordinator task. Do not make every probe reread it.
- **SITREP:** fresh remote/local evidence, exact SHA, tests, blocker and next action; no status theater.

## Hard constraints
One Studio browser-effect owner, dedicated Chrome profile, single journal and store. No Playwright, Puppeteer, secondary CDP actor, provider API bypass or scripted `live-100` runner. Read-only discovery is not authorization to send, navigate, upload, edit, share or delete; reconcile ambiguous effects under original operation IDs and never blindly resend. Preserve Chrome, private data, login sessions, user files and local dirty work. Local Windows PC is the human/master; a GitHub commit is not local/browser proof. No Slack.

Aim for **one native user command, maximum three**. Tests, source presence and HTTP replies are not authenticated live-user acceptance. Use focused tests then appropriate full gate; report actual results only.

Existing roles: `.opencode/agents/chatgpt-probe.md`, `.opencode/agents/local-opencode.md`, `.opencode/agents/chatgpt-aion.md`. Product CLI: `bin/studio.mjs`. Refactoring ledger: `docs/architecture/AGENT-CODE-SIMPLIFICATION-LEDGER.md`. Load other documentation only when the task needs it.
