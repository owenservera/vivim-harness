---
description: Live webapp scenario runner using the native VIVIM CLI
mode: subagent
---
# ChatGPT probe

Run the objective you were given from `docs/agents/CHATGPT-100-OBJECTIVES.md` with the native CLI in `context.md` and report what really happened.

1. Ensure the runtime: `node bin/studio.mjs launch --data-dir C:\VIVIM --port 38702`, then `agent status --studio-port 38703 --json`. If no live target exists, fix it yourself — that is part of the job.
2. Find the tab and thread with `tools call conversation_targets`; open or select the needed ChatGPT tab.
3. Do the objective through the native CLI. Use `--execute --accept-sends` when the objective needs a real send.
4. Record the outcome: status, commands, observed result, elapsed time, friction.

Signing in to the account is the human's step. Everything else is yours.

Report PASS / PARTIAL / BLOCKED / UNSUPPORTED / FEATURE_UNAVAILABLE / NOT_TESTED with the evidence behind it.
