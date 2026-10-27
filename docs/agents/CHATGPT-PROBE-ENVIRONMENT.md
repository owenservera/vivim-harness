# VIVIM ChatGPT probe — operating environment (read this EVERY session)
Version: 2026-10-27. This is a **helper file**, not a launcher or script. It provides the known operating map and the minimal CLI entrypoints. Never mistake historical observations for the actual running host.

## Known Windows environment / resolve at launch
| Field | Last observed | Trust rule |
|---|---|---|
| Canonical source checkout | `C:\\0-BlackBoxProject-0\\vivim-harness` | Confirm it exists; `git status --short --branch` locally; another checkout might be active |
| Local VIVIM private data root | `C:\\VIVIM` | From 2026-10-27 runtime observation; compare live `/api/status` dataDir |
| Dedicated Chrome user profile | `C:\\VIVIM\\chrome-profile` | Derived by `src/config.mjs:dataPaths(dataDir).chromeProfile`; never ordinary Chrome profile |
| Studio HTTP port | `38703` | Historical; inspect actual `/api/status` / use `agent status` before calls |
| Chrome DevTools CDP port | `38702` | Historical; obtain from running Studio status, do not scan unrelated browsers |
| Source runtime | `node bin/studio.mjs` | Node >=22, Windows PowerShell; `node bin/studio.mjs help` is CLI source of truth |
| Native tool/recipe transport | Studio HTTP owner | Only reuse verified existing Studio; never launch a second owner for convenience |

**Important distinction:** `profiles/chatgpt.json` is a capture SITE profile, not the signed-in Chrome user-data directory. ChatGPT login lives inside the dedicated Chrome profile. The repository `context.md` contains extended developer references; probe agents should not need to read it.

## Agent launch: quick, native, no scripts
In **Windows PowerShell**, start from the known source checkout:
```powershell
Set-Location 'C:\0-BlackBoxProject-0\vivim-harness'
node bin/studio.mjs help
node bin/studio.mjs agent capabilities --json
node bin/studio.mjs agent status --studio-port 38703 --json
node bin/studio.mjs tools list --studio-port 38703 --json
```
These are starting-point examples, not an automatic sequence. **Run only the command needed for your assigned user objective**. The updated `agent status` now exposes the **running server's** `dataDir`, `chromeProfile`, `studioPort`, `cdpPort` and `chromeReachable`; it explicitly reports browser profile/account verification as unproven. Compare them with the map above. If the last-observed port is unavailable, do not silently switch to 7878: ask the operator for the current Studio port. Never kill or restart processes in order to probe.

### Discover native action verbs
```powershell
node bin/studio.mjs recipe list --json
node bin/studio.mjs recipe choose --intent 'the user objective' --json
node bin/studio.mjs recipe show conversation.read --json
node bin/studio.mjs tools list --studio-port 38703 --json
node bin/studio.mjs help tools call
```
The above are *examples of discovery*, not a prescribed workflow. Some capabilities are only exposed by `tools call`, others by recipes, and some not implemented yet. Do not read source or drive Chrome by CDP directly to complete a probe. A capability you cannot discover/use via CLI + these helper files counts as friction or unsupported.

### Existing Studio vs own CLI process
- `agent status` reads **`/api/status` from the existing Studio** and reports its current data root, derived Chrome-profile directory and CDP port through the native CLI. This is a path/port truth check; it is **not** proof that the correct Chrome browser identity, ChatGPT account or thread is attached.
- A loaded Studio may come from an older checkout without updated `agent status`; if the CLI can't expose the live server's dataDir/profile/port, report **STALE_RUNTIME_OR_CLI_GAP** rather than assuming identity or using an independent HTTP/CDP workaround.
- `tools list` and `tools call` connect to Studio's existing owner; the CLI does not launch a competing CDP actor.
- `recipe run` uses the existing native owner. User-approved provider sends require `--execute --authorize-send` and a stable, original send key; `studio chat` one-shot requires `--execute --accept-sends`. A scenario assignment is not a blanket send authorization.
- The older `live-100` batch runner **was removed**. Do not recreate it, automate these objectives, or route probes through another batch tool.
- On an uncertain submission, preserve the original journal and key and use read-only `recipe status/reconcile` as applicable; never invent a replacement key or resend.
- Five independent agents can analyze/inspect simultaneously, but any browser-mutating interaction must coordinate with the **single current effect owner**. Never open or mutate the host's ordinary Chrome profile.

## Success proof and honesty
A source file, registered recipe, or "HTTP 200" is not a completed real user task. Prove the actual visible outcome, source identity and relevant saved evidence. Report `PASS / PARTIAL / BLOCKED / UNSUPPORTED / NOT TESTED`, plus wall time, number of CLI commands, and concrete limitation. Do not publish private conversations, paths with private usernames, credentials or raw captures.
