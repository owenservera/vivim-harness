# Agent action protocol — a web AI as the primary agent

**Status:** implemented pure module, offline-verified only. No live provider run, no loop yet.
**Date:** 2026-10-30 · **File:** `src/studio/agent-actions.mjs` · **Owner:** VIVIM Harness.

## Why

Owner north star (2026-10-30, `docs/session/GOAL.md`): assume the only AI available is the user's own web AI accounts, in the dedicated signed-in Chrome, with no API and no native tool-calling. For a web AI to be the **primary agent** it must plan, read and edit local files, run approved commands, delegate to the other web AIs, check results and report — so it needs a structured language it can write **in its own reply text**.

This module is that language and nothing else: no sends, no browser, no filesystem, no process. The agent loop (later lane) executes; `src/studio/ai-orchestrator.mjs` (Opus lane) runs `ask_ai` plans.

## Reply format

One fenced JSON block, nothing meaningful outside it:

```json
{"actions": [ {"type": "read_file", "path": "src/app.mjs"} ], "say": "Reading it."}
```

- `actions` — non-empty array, at most `MAX_ACTIONS_PER_REPLY` (8) entries.
- `say` — optional plain message for the owner. Shown as-is, never parsed.

Tolerant parsing, same approach as `personal-app-provider-reply.mjs`:

| Reply shape | Result |
| --- | --- |
| one ```` ```json ```` fence | parsed |
| one bare ```` ``` ```` fence holding an object | parsed |
| reply starts with `{` | parsed whole |
| one embedded JSON object in prose | parsed |
| more than one candidate block/object | refused `AGENT_REPLY_AMBIGUOUS`, with a retry prompt the loop can send back |
| no JSON / unparseable / wrong shape | refused `AGENT_REPLY_NO_JSON`, `AGENT_REPLY_INVALID_JSON`, `AGENT_REPLY_SHAPE` |

Smart quotes (U+2018/2019/201A/201B, U+201C/201D/201E/201F) are straightened before any parse attempt. A refusal is never a guess: `{ok:false, problem:{code,message}, retryPrompt}` where `retryPrompt` is the plain next step the loop sends to the AI.

## Action types (closed set)

| Type | Fields | Class |
| --- | --- | --- |
| `read_file` | `path`, `maxBytes` (default min(20 000, budget)) | read |
| `list_files` | `dir`, `glob` | read |
| `search` | `pattern` (text or `/regex/`), `dir` | read |
| `propose_edit` | `path` + **either** `{find, replace}` **or** `{unifiedDiff}` | effect |
| `write_file` | `path`, `content` | effect |
| `run_command` | `command`, `cwd`, `timeoutSec` (default 60) | effect |
| `ask_ai` | `pattern`, `sites` or `"auto"`, `question` | effect |
| `save_to_work` | `title`, `note` | effect |
| `note` | `text` | read |
| `finish` | `summary`, `status` (`done` \| `blocked` \| `needs_owner`) | read |

`ask_ai` maps 1:1 onto the orchestrator's patterns — `single`, `fanout`, `race`, `fallback`, `hedge`, `council`, `judge`, `relay`, `critique`, `verify` — and sites `chatgpt`, `claude`, `gemini`, `deepseek`, `zai`, `qwen`. `"auto"` leaves site choice to VIVIM's routing.

`propose_edit` with both `{find, replace}` and `{unifiedDiff}` is refused (`FIELD_INVALID`), as is neither.

## Policy

### Workspace scoping

Every path is resolved against `ctx.workspaceRoot`. Refused:

- absolute paths (`PATH_ABSOLUTE`)
- anything resolving outside the root, including `..` (`PATH_ESCAPE`)
- control characters (`PATH_INVALID`)
- secret-looking paths (`PATH_SECRET`): `.env*`, `.ssh/`, `.gnupg/`, `.aws/`, `.npmrc`, `.netrc`, `id_rsa*`, `id_ed25519*`, `*.pem|pfx|p12|keystore|jks|key`, and any path containing `credential`, `secret`, `token`, `password`

Refusal applies to reads **and** writes: the loop must not hand a web AI a credential file even read-only.

### Read-only vs effect

`classify(action)` returns `read`, `effect`, or `unknown`. Reads run immediately. Every effect (`propose_edit`, `write_file`, `run_command`, `ask_ai`, `save_to_work`) requires explicit owner approval before execution — the loop shows `summarize(action)` on an approval card and records the decision.

### Command defaults

Deny list, checked before approval is even offered (`COMMAND_DENIED`, nothing runs): recursive force delete (`rm -rf`, `Remove-Item -Recurse -Force`), delete at a drive or home root, `sudo rm`, `format X:`, `mkfs`, `diskpart`, `dd if=`, `vssadmin`, `git push --force`/`-f`, registry edits (`reg add|delete`, `regedit`, `Set-ItemProperty HKLM:|HKCU:`, `Remove-Item … HKLM:`), credential tools (`git credential`, `cmdkey`, `vault login`, `aws configure`, `gh auth login`, `ssh-keygen`), `shutdown`, `Restart-Computer`.

Everything else is not "allowed" — it is merely *approvable*: an unmatched command is still an effect needing owner approval. The allow list is deliberately not modelled; a deny list over an impossible allow list fails safe.

### Budgets

`DEFAULT_BUDGETS`: `maxSteps` 40, `maxSends` 8, `maxReadBytes` 200 000, `maxWriteBytes` 200 000, `maxCommandSeconds` 300, `maxObservationBytes` 8 000, `maxActionsPerReply` 8 (parse-time, not overridable). `validateAction(action, {workspaceRoot, budgets, used})` refuses with `BUDGET_STEPS` / `BUDGET_SENDS` when `used` is exhausted, and `CONTENT_TOO_LARGE` / `FIELD_INVALID` when a single field exceeds its ceiling.

## Exports

| Export | Contract |
| --- | --- |
| `parseAgentReply(text)` | `{ok:true, actions, say}` or `{ok:false, problem:{code,message}, retryPrompt}` |
| `validateAction(action, ctx)` | `{ok:true, action}` (normalized, scoped) or `{ok:false, problem:{code,message}}` |
| `classify(action)` | `'read' \| 'effect' \| 'unknown'` |
| `summarize(action)` | one plain-language line for the approval card: `Change 3 line(s) in src/app.mjs`, `Run: npm run build (in the project folder)` |
| `renderObservation(results, opts)` | compact text for the AI: `[n] <summary> -> OK\|ERROR`, bounded by `maxBytes`, truncated with a note, omitted results counted |
| `buildSystemBrief({goal, workspace, budgets})` | instruction text teaching this protocol, with one complete worked example |

`validateAction` requires `ctx.workspaceRoot`; it throws `TypeError` without it rather than guessing a root.

## Boundary

- This module never reads, writes, spawns, sends or navigates. `validateAction` is a shape/policy check, not execution.
- `summarize` output is what the owner sees; it must stay plain language, no codes.
- `renderObservation` is the only text sent back to the AI, and it is bounded — a huge file read cannot blow the next prompt.
- `ASK_AI_PATTERNS` / `ASK_AI_SITES` **mirror** `orchestrator-patterns.mjs` by hand to keep this file import-free. If the orchestrator catalog changes, update both.
- Restart/resume, no-resend keys and per-AI timing/outcome tracking belong to the loop and the orchestrator, not here.

## Offline evidence (2026-10-30)

`node --check src/studio/agent-actions.mjs` clean. Offline smoke, 15 replies + 2 renderers, against `workspaceRoot = C:\0-BlackBoxProject-0\vivim-harness`, `maxWriteBytes = 2000`:

| Case | Result |
| --- | --- |
| valid multi-action (3 actions) | parse ok, 3 read, all summaries rendered |
| smart quotes | parse ok, 1 read |
| two JSON blocks | `AGENT_REPLY_AMBIGUOUS` + retry prompt |
| `../../Windows/win.ini` | `PATH_ESCAPE` |
| `.env` | `PATH_SECRET` |
| `rm -rf /` | `COMMAND_DENIED` |
| `deploy_everything` | `AGENT_ACTION_UNKNOWN` at parse |
| 3000-char content, 2000 budget | `CONTENT_TOO_LARGE` |
| `finish` | ok, read |
| `propose_edit` find/replace, 3 lines | ok, effect, `Change 3 line(s) in src/app.mjs` |
| `ask_ai` council + `"auto"` | ok, effect, `Ask an AI VIVIM picks (council): …` |
| plain prose, no JSON | `AGENT_REPLY_NO_JSON` |
| `ask_ai` with `maxSends: 0` | `BUDGET_SENDS` |
| `unifiedDiff` + `write_file` | ok, 2 effects, `+1/-1 lines`, `Write docs/new.md (5 characters)` |
| bare object, no fence | parse ok, 1 read |
| `renderObservation`, 2 results, 400-byte cap | 393 bytes, truncation note present |
| `buildSystemBrief` | 2575 chars, contains budget line and a worked example |

Not verified: any live web-AI reply actually producing these actions, and any loop executing them. Source-level only.
