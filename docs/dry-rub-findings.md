# VIVIM Harness — Dry Rub Findings (100 live user scenarios) — RESET

**Method:** Manual decomposition of `studio live-100` into per-scenario `studio chat <provider> --prompt "<task>" --execute --accept-sends` runs.
**Lanes:** 5 parallel lanes, each running 20 scenarios one at a time (single provider per lane).
**Profile:** Dedicated vivim workspace, `profiles/chatgpt.json` (family `ai-chat`).
**Providers:** chatgpt, claude, gemini, deepseek, zai (20 tasks each = 100 scenarios).
**Mode:** LIVE — real browser, real provider sends, consumes account quota.
**Status:** Dispatching — no lanes complete yet.

## Agent-context gaps identified (pre-live, from harness study)

1. Five recipe families have zero executable recipes: `capture`, `world`, `knowledge`, `diagnostics`, `verification` (reserved taxonomy only; 10 executable recipes exist in `provider`/`conversation`/`recovery` families).
2. `conversation.connect-existing` is ChatGPT-only (`site` enum: `["chatgpt"]`); no exact-thread attach for claude/gemini/deepseek/zai.
3. No cross-provider tab discovery for non-chatgpt providers (`provider.targets` exists but no equivalent).
4. Browser account state: `unknown-not-probed` — no account-probing capability; auth walls (e.g., gemini `preflight.requiresAuth`) not verified until live send.
5. `studio chat` dry-run emits metadata-only preview (`browserAction: false`); task-specific correctness (exact text "VIVIM CEDAR READY", number 437, required words, headings, labels, table shape) requires live `--execute` + provider reply observation.

## Per-lane results (filled in as lanes complete)

### Lane 1 — chatgpt

| # | Scenario ID | Task | Prompt (truncated) | Live OK | Error / Code | Gaps / Issues |
|---|-------------|------|-------------------|---------|--------------|---------------|

### Lane 2 — claude

| # | Scenario ID | Task | Prompt (truncated) | Live OK | Error / Code | Gaps / Issues |
|---|-------------|------|-------------------|---------|--------------|---------------|

### Lane 3 — gemini

| # | Scenario ID | Task | Prompt (truncated) | Live OK | Error / Code | Gaps / Issues |
|---|-------------|------|-------------------|---------|--------------|---------------|

### Lane 4 — deepseek

| # | Scenario ID | Task | Prompt (truncated) | Live OK | Error / Code | Gaps / Issues |
|---|-------------|------|-------------------|---------|--------------|---------------|

### Lane 5 — zai

| # | Scenario ID | Task | Prompt (truncated) | Live OK | Error / Code | Gaps / Issues |
|---|-------------|------|-------------------|---------|--------------|---------------|

## Cross-lane summary (pending lane completion)

- Total scenarios: 100
- Passed: 0
- Failed: 0
- Blocked: 0
- Not attempted: 100

## Authorization note

Live sends were authorized by user ("live run only"). Each send consumes provider account quota. No retries on uncertain effects.
