# VIVIM Harness — one native CLI reference for all agents

**Start here, from repository root** (`C:\\0-BlackBoxProject-0\\vivim-harness` was last observed; check actual cwd). Requires Node >=22. Invoke **only** `node bin/studio.mjs` for the user-facing VIVIM product. No direct HTTP, CDP, shell automation, source reading or scripts *to complete a probe*. Developer agents may inspect source to repair a failure.

## 30-second orientation (choose the minimum commands needed)
```powershell
node bin/studio.mjs help
node bin/studio.mjs agent capabilities --json
node bin/studio.mjs agent status --studio-port 38703 --json
```
`38703` is last observed, **not guaranteed**. Do not silently substitute default `7878`, restart servers, or attach to unknown Chrome. A stale or missing server is a reportable blocker.

## Command map — native CLI
```powershell
# Discover without effect
node bin/studio.mjs tools list --studio-port 38703 --json
node bin/studio.mjs help tools call
node bin/studio.mjs recipe list --json
node bin/studio.mjs recipe choose --intent 'user objective' --json
node bin/studio.mjs recipe show conversation.read --json

# Plan, execute or reconcile a supported recipe (substitute ID and input path)
node bin/studio.mjs recipe plan conversation.read --input args.json --json
node bin/studio.mjs recipe run conversation.read --input args.json --json
node bin/studio.mjs recipe status RUN_ID --json
node bin/studio.mjs recipe reconcile RUN_ID --json

# Existing native tool bridge; names/schemas discovered via tools list/help
'{}' | node bin/studio.mjs tools call conversation_targets --input - --studio-port 38703 --json
'{}' | node bin/studio.mjs tools call list_conversations --input - --studio-port 38703 --json
```
Use `help` and the tool/recipe manifest for exact current arguments. Not every recipe taxonomy family is executable. Pure read-only recipes need no send authorization. Effectful recipe runs require `--execute`; provider sends also require `--authorize-send` and a stable original `input.key`. The separate native `studio chat` path uses `--execute --accept-sends`. **Do not use these flags without explicit operator authorization.** The prompt objective alone is never such authorization.

## Environment and identity
| Field | Last observed / verification |
|---|---|
| Source checkout | `C:\\0-BlackBoxProject-0\\vivim-harness`; check actual working directory |
| Private local data root | `C:\\VIVIM`; compare active Studio `agent status` |
| Derived dedicated Chrome profile | `C:\\VIVIM\\chrome-profile`; existence/path alone does **not** prove browser identity |
| Studio HTTP port | `38703`; discover actual running owner, never spawn a competing one |
| Chrome CDP port | `38702`; only existing Studio owner uses it |
| Browser identity | Verify correct origin/account/tab/thread and readiness; `agent status` alone does not prove profile/account binding |

`profiles/chatgpt.json` is a *site capture profile*, not the signed-in Chrome user-data directory. User's ordinary Chrome is off limits. If server owner or profile binding cannot be verified with native CLI, classify `STALE_RUNTIME_OR_CLI_GAP`; do not bypass the CLI. Do not print private transcript fields unless operator explicitly requests them.

## Probe rule (one objective, one result)
Assigned objective from `docs/agents/CHATGPT-100-OBJECTIVES.md` → native CLI discovery → actual webapp outcome → short receipt. Distinguish `PASS / PARTIAL / BLOCKED / UNSUPPORTED / FEATURE_UNAVAILABLE / NOT_TESTED`. Include command count, wall time, actual observed effect, privacy-safe evidence, exact friction. **More than 3 user commands is a UX defect.** Never rescue failure with a custom script or pre-read implementation source. Read-only tasks can be parallel; **effects serialize on one owner**, with exact durable identity and no blind retries.

## Developer verification (not probe commands)
```powershell
git status --short --branch
git rev-parse HEAD
node scripts/architecture-inventory.mjs --check
npm test
node bin/studio.mjs selftest
```
Use focused Node tests before full gate when editing. Windows is the local master; GitHub push is not evidence of executing on this PC. Escalate only the concrete blockage. Additional old command references are historical; this file and **live CLI help** are the operational source of truth.
