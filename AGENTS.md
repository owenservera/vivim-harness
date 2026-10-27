# VIVIM Harness — start here

This repository is the runnable VIVIM product. Take initiative: pick the useful work, do it, verify it, and report what actually happened.

OpenCode loads this file automatically. `context.md` is preloaded and holds the native CLI reference.

## Who does what
- **Most work: do it yourself.** Delegate only when a second lane genuinely runs faster or a specialist adds real expertise.
- `@chatgpt-probe` — live webapp scenarios from `docs/agents/CHATGPT-100-OBJECTIVES.md`.
- `@local-opencode` — focused local debugging and implementation.
- `@git-manager` — staging, commits, pushes when asked.
- `@marketing-landing` — README and `marketing/` surfaces.
- `docs/agents/OPENCODE-V2.md` — OpenCode orchestration notes.

## Live webapp work
Do the setup yourself with the native CLI:

```powershell
node bin/studio.mjs launch --data-dir C:\VIVIM --port 38702
node bin/studio.mjs agent status --studio-port 38703 --json
'{}' | node bin/studio.mjs tools call conversation_targets --input - --studio-port 38703 --json
```

Signing in to a provider account is the human's step. Everything else — launching the browser, opening the tab, choosing a thread, running the scenario, recording the result — is yours. Run scenarios in order and record each outcome as it happens.

## Working style
- Report observed evidence: the command, the response, the result.
- A real provider reply, a passing test, or a written file is proof. A plan, a catalog entry, or an HTTP 200 is not.
- Prefer one user command. Three is the ceiling for a normal action.
- Keep every foreground command under 15 seconds; run anything longer in the background and report when it finishes.

Product CLI: `bin/studio.mjs`. Simplification ledger: `docs/architecture/AGENT-CODE-SIMPLIFICATION-LEDGER.md`.
