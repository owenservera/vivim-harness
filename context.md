# VIVIM Harness: command reference

Run these from the repository root in PowerShell. This is a shortcut, not proof that a running Studio has loaded this checkout. Check [AGENTS.md](AGENTS.md) first; source and live help take precedence over dated notes.

## Safety before commands

- Keep one established browser-effect owner. Confirm the exact origin, account, tab ID and native thread before any attachment or action. A read or capture does not authorize a send. Use the running owner's Studio tool bridge rather than constructing another runtime.
- Sending, opening, navigating, reloading, focusing, closing, recording, stopping and restarting need the appropriate explicit scope. Never resend an uncertain turn or replace its key; preserve the original tab, journal and evidence and reconcile through the owner. Do not use Playwright or Puppeteer.
- Raw local captures can contain credentials, private transcripts and thread URLs. Keep data outside Git; review even metadata output before sharing. Placeholders below are literal labels to replace locally, not real identifiers.
- Commands labeled **inspection** may expose private metadata. Commands labeled **effects** change local state or interact with a browser; do not run them merely to discover status.

## Orientation and CLI discovery

Source: [package.json](package.json), [CLI registry](bin/lib/registry.mjs), [CLI entry](bin/studio.mjs).

```powershell
git --no-optional-locks status --short --branch
git rev-parse HEAD
git worktree list --porcelain
bun --version
node --version
bun run studio help
bun run studio commands --json
bun run studio help tools call
bun run studio help record
```

`bun run studio …` runs the package script, which invokes Node. The project requires Node >=22; preserve its Node test-runner semantics rather than replacing them with Bun's native runner. No package install or build script is defined in `package.json`.

## Discover the running owner (inspection)

Source: [capture entrypoints](bin/commands/capture.mjs), [Studio status](src/studio/server.mjs), [Windows autostart](scripts/install-autostart.ps1).

```powershell
# Defaults are candidates only; inspect all listeners when ports were overridden.
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 7878, 9222 } |
  Select-Object LocalAddress, LocalPort, OwningProcess
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -in 'node.exe', 'bun.exe', 'chrome.exe', 'msedge.exe' -and $_.CommandLine -match 'studio\.mjs|always-on\.mjs|--remote-debugging-port' } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
$task = Get-ScheduledTask -TaskName 'CaptureStudio-AlwaysOn' -ErrorAction SilentlyContinue
$task | Select-Object TaskName, State
$task.Actions | Select-Object Execute, Arguments, WorkingDirectory
```

Process command lines can themselves contain private arguments; inspect locally. A listener or matching command line does **not** prove its working directory, loaded source SHA, account or profile. Scheduled-task actions may identify a different checkout. Do not replace the task or start a competing owner.

For an identified running Studio, substitute its actual port. Default local mode needs no token; token mode needs the owner's existing credential. `/api/v1/health` does not probe Chrome; `/api/status` also probes the configured CDP endpoint and reports that server's data root and CDP port. Coordinate even read-only browser discovery with its owner.

```powershell
$studioPort = 7878  # example default; replace after inspection
$base = "http://127.0.0.1:$studioPort"
$headers = @{}
if ($env:CAPTURE_STUDIO_TOKEN) { $headers['x-studio-token'] = $env:CAPTURE_STUDIO_TOKEN }
Invoke-RestMethod "$base/api/v1/health" -Headers $headers
Invoke-RestMethod "$base/api/status" -Headers $headers
bun run studio tools list --studio-port $studioPort --json
```

`tools list` returns conversation tool registrations, not proof of account readiness. A missing endpoint or 401/503 is a diagnostic, not permission to restart or attach elsewhere. `scripts/always-on.mjs --status` and its `--dry-run` call setup that can create the data directory; use the task and process inspection above when absolutely no writes are allowed. Autostart `-Status` invokes that same supervisor status path.

## Native threads and saved evidence

Source: [conversation tools](src/studio/conversation-tools.mjs), [conversation API](src/studio/conversation-api.mjs), [tool client](src/studio/tool-client.mjs), [harness reconciliation](src/studio/harness-api.mjs).

These use the **already running** owner; do not start a new runtime. Current source makes conversation list/get pure snapshot reads, but older loaded Studio builds could recover and rewrite snapshots on GET. If the loaded version cannot be established, do not assume those reads are pure. Target discovery and transcript reads inspect the browser; use only with owner coordination and exact identity.

```powershell
# Browser target metadata, then saved conversation summaries; local output is private.
'{}' | bun run studio tools call conversation_targets --input - --studio-port $studioPort --json
'{}' | bun run studio tools call list_conversations --input - --studio-port $studioPort --json

# Replace CONVERSATION_ID with the exact owner-supplied local identifier.
'{"conversation":"CONVERSATION_ID"}' | bun run studio tools call get_conversation --input - --studio-port $studioPort --json
'{"conversation":"CONVERSATION_ID"}' | bun run studio tools call read_conversation --input - --studio-port $studioPort --json
```

`read_conversation` observes the currently rendered, exact-bound thread without focus, scrolling or sending; its coverage is bounded and may omit unloaded history. By default the tool CLI strips fields named `text`, `prompt`, `title` and `content`, **not all sensitive metadata**. `--include-content` exposes private content. Titles are not thread identities; for supported ChatGPT threads, target discovery returns `thread.ref` in the form `chatgpt-c:<UUID>`. It does not establish the signed-in account; confirm account and page readiness independently with the owner.

For an unresolved **harness run step**, the current server exposes a read-only reconciliation projection. Replace both placeholders with the original local run ID and step key; it never authorizes resend. `reconcile_conversation`, by contrast, can persist evidence and is not a pure read.

```powershell
$runId = 'RUN_ID'
$body = @{ stepKey = 'STEP_KEY' } | ConvertTo-Json -Compress
Invoke-RestMethod "$base/api/v1/harness/runs/$runId/reconcile" -Method Post -ContentType 'application/json' -Headers $headers -Body $body
```

## Sessions, receipts and paths

Source: [data configuration](src/config.mjs), [CLI context](bin/lib/context.mjs), [session commands](bin/commands/sessions.mjs), [session store](src/store/session.mjs), [receipt API](src/studio/integration-hub.mjs).

The Windows default is `$env:LOCALAPPDATA\AION\capture-studio`; `CAPTURE_STUDIO_HOME` or CLI `--data-dir` can override it. The current shell's environment need not match the running owner's. Below is a **file-only inspection**, provided the root is already known; no directory is created. Replace `SESSION_ID` with the exact selected ID, not `latest` during concurrent capture.

```powershell
$dataDir = if ($env:CAPTURE_STUDIO_HOME) { $env:CAPTURE_STUDIO_HOME } else { Join-Path $env:LOCALAPPDATA 'AION\capture-studio' }
$sessionId = 'SESSION_ID'
$receiptFile = Join-Path $dataDir "sessions\$sessionId\kv\RECEIPT.json"
if (Test-Path -LiteralPath $receiptFile) { Get-Content -LiteralPath $receiptFile -Raw } else { 'No saved receipt at this path; do not auto-derive.' }
```

The running Studio also has `GET /api/v1/sessions/{session}/receipt`, which does not derive but may create a missing `kv` directory when opening the session. Raw records live under `sessions/<id>/raw/`, derived datasets under `datasets/`, and rendered/receipt artifacts under `kv/`; conversation snapshots and harness ledgers live under `conversations/` and `harness-runs/` in the same private root.

The following CLI commands are **inspection with possible setup writes**: ordinary CLI context initialization creates missing data directories, opening a session can create `kv/`, and `doctor` can seed built-in profiles. `doctor` also probes CDP. Run only when those effects are acceptable.

```powershell
bun run studio paths --json
bun run studio config show --json
bun run studio doctor --json
bun run studio session list --json
bun run studio session show $sessionId --json
bun run studio verify $sessionId --json
```

Inspect a completed, stable session for verification. `verify` checks raw hashes, sequences and declared gaps, not provider response correctness or acceptance. `bun run studio receipt $sessionId --json` can **derive and write** if the receipt is absent; `session streams`, `timeline`, `events` and `shapes` can also auto-derive. Explicit `derive <id>` writes derived artifacts and may operate on a named active session even without `--force`; never run it on an active or unresolved recording. Source: [derive command](bin/commands/replay.mjs).

## Studio and capture operations (effects)

These are separate alternatives, not a sequence. Use one only after the operator authorizes that specific action and confirms no competing owner.

**Existing owner:** bind an already-open ChatGPT thread. Replace both private placeholders with the exact target ID and thread reference obtained through coordinated discovery.

```powershell
'{"site":"chatgpt","targetId":"TARGET_ID","expectedThread":"THREAD_REF","freshTab":false}' |
  bun run studio tools call connect_conversation --input - --studio-port $studioPort --json
```

For an existing target, current source binds an idle page and writes a conversation snapshot; capture and the writer lease are deferred until a send. It does not send. Older running builds can behave differently; tool descriptions alone are not proof of the loaded behavior. Source: [conversation runtime](src/capture/conversation-runtime.mjs).

**No existing server:** if explicitly authorized, start the Studio UI server without launching or opening a browser.

```powershell
bun run studio serve --no-open
```

**Standalone recorder instead of the existing owner:** if explicitly assigned sole ownership, attach to an existing exact target and write a session. Do not run alongside an active Studio owner.

```powershell
$targetId = 'TARGET_ID'
bun run studio record --target $targetId --duration 30 --no-derive
```

`record` observes rather than sending, but it attaches and writes. `start` can launch Chrome and open the UI; `capture` can launch Chrome, open a new tab and reload it. `drive` sends by default, while `chat --execute` and `campaign --execute` send explicitly. Do not invoke any of these to inspect an active test. `scripts/chrome-cdp.ps1` can junction to the operator's real Chrome profile; it is not interchangeable with the dedicated-profile launcher. See [portability](docs/PORTABILITY.md) and [always-on](docs/ALWAYS-ON.md) before maintenance.

## Tests and architecture

Source: [package scripts](package.json), [gate](scripts/gate.mjs), [architecture inventory](scripts/architecture-inventory.mjs), [portability evidence tiers](docs/PORTABILITY.md).

The architecture inventory check reads the tree and manifest:

```powershell
bun run -- node scripts/architecture-inventory.mjs --check
```

The following are **test effects**, not inspection: tests and gates can create temporary data, launch local servers or subprocesses; E2E needs Chrome and may affect browser resources. Run only after confirming isolation from active work. The focused example uses the project's Node test runner.

```powershell
bun run -- node --test test/unit/conversation-thread.test.mjs test/unit/conversation-read-api.test.mjs
bun run test
bun run test:parity
bun run test:e2e
bun run gate:fast
bun run gate
```

`gate:fast` runs architecture, parity tests and a disposable local platform smoke, but skips the full suite; `gate` adds the unit suite. Neither proves provider acceptance or parity on another OS. `selftest` also probes CDP and starts a separate local Studio unless configured otherwise, so it is not a harmless check during a live lane.

## Triage and deeper references

- A reachable CDP port may belong to the wrong profile; verify the owner, not just the port. Do not close or re-profile Chrome to make a command succeed.
- `BINDING_CHANGED`, an unexpected thread, login wall or ambiguous delivery means stop effects and preserve evidence. Page-ready, network completion, capture integrity and acceptance are distinct claims.
- CLI exit codes: `0` success, `1` runtime error, `2` usage, `3` not found, `4` integrity/state conflict, `5` environment. A test or synthetic fixture is not live-provider proof.
- Module map and data flow: [architecture](docs/ARCHITECTURE.md). Current local defaults: [local-first](docs/LOCAL-FIRST.md). Windows hands-on testing: [CORE handoff](docs/CORE-LOCAL-HANDOFF-2026-10-22.md) and [live test](docs/LIVE-TEST.md); both contain historical claims, so check current source and loaded runtime before acting.
