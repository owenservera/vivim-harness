# VIVIM Harness — native CLI reference

Run from the repository root with Node >=22. Data root `C:\VIVIM`, Studio on port `38703`, dedicated Chrome CDP on `38702`, profile `C:\VIVIM\chrome-profile`.

## Start and check
```powershell
node bin/studio.mjs help
node bin/studio.mjs doctor --port 38702 --json
node bin/studio.mjs launch --data-dir C:\VIVIM --port 38702
node bin/studio.mjs agent status --studio-port 38703 --json
node bin/studio.mjs targets --port 38702 --json
```

## Discover
```powershell
node bin/studio.mjs tools list --studio-port 38703 --json
node bin/studio.mjs help tools call
node bin/studio.mjs recipe list --json
node bin/studio.mjs recipe choose --intent 'user objective' --json
node bin/studio.mjs recipe show conversation.read --json
```

## Read
```powershell
'{}' | node bin/studio.mjs tools call conversation_targets --input - --studio-port 38703 --json
'{}' | node bin/studio.mjs tools call list_conversations --input - --studio-port 38703 --json
'{"conversation":"<id>"}' | node bin/studio.mjs tools call get_conversation --input - --studio-port 38703 --json
node bin/studio.mjs session list --json
node bin/studio.mjs export transcript latest --json
```

## Effectful
```powershell
node bin/studio.mjs chat chatgpt --prompt "..." --execute --accept-sends
node bin/studio.mjs drive chatgpt --prompt "..." --json
'{"conversation":"<id>","key":"<stable-key>","prompt":"...","confirm":true,"expectedRevision":<n>}' | node bin/studio.mjs tools call submit_conversation_turn --input - --studio-port 38703 --json
node bin/studio.mjs recipe run conversation.ask --input args.json --json --execute --authorize-send
node bin/studio.mjs recipe reconcile RUN_ID --json
```
The flags are the switch: `--execute` performs the action, `--accept-sends` / `--authorize-send` allow the provider send. Reuse the same `key` to re-check an outcome; a new key is a new send.

## Environment facts
| Field | Value |
|---|---|
| Source checkout | `C:\\0-BlackBoxProject-0\\vivim-harness` |
| Data root | `C:\VIVIM` |
| Chrome profile | `C:\VIVIM\chrome-profile` |
| Studio port | `38703` |
| CDP port | `38702` |

`profiles/chatgpt.json` is a site capture profile, not a Chrome user-data directory. The browser identity check compares the CDP endpoint with the expected profile; a plain reachable port is not enough.

## Scenarios
Run `docs/agents/CHATGPT-100-OBJECTIVES.md` in order through this CLI. Per objective record: status, commands used, observed outcome, elapsed time, friction.

## Checks
```powershell
git status --short --branch
node scripts/architecture-inventory.mjs --check
bun run test
node bin/studio.mjs selftest
```
