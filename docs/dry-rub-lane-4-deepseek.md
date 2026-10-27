# Dry-Rub Lane 4 — Provider: deepseek (20 tasks)

**Command used:** `bun bin/studio.mjs chat deepseek --prompt "<task prompt>"` (default dry-run; no `--execute`, no `--accept-sends`).

**Dry-run semantics:** With no `--execute`, `bin/commands/chat.mjs` does not construct the browser runtime or perform any target discovery. It emits a single JSON record: `{ dryRun: true, site, targetId, freshTab, promptChars, timeoutSeconds, action: 'connect-submit-poll-finish', browserAction: false }`.

## Results table

| # | Task | Prompt (truncated to 60 chars) | Dry-run OK | Output key fields | Errors | Gaps/Issues |
|---|------|--------------------------------|------------|-------------------|--------|-------------|
| 1 | groceries | I need rice, milk, and eggs. Give me a short checklist with | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=86, timeoutSeconds=120 | none | none |
| 2 | summary | Summarize this in one sentence: Cedar is an offline-first pe | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=119, timeoutSeconds=120 | none | none |
| 3 | requirements | From this product request extract the two requirements as se | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=133, timeoutSeconds=120 | none | none |
| 4 | math | A supplier quoted 19 units at 23 euros each. What is the tot | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=99, timeoutSeconds=120 | none | none |
| 5 | translation | Translate to Spanish: Good morning, the meeting is tomorrow. | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=97, timeoutSeconds=120 | none | none |
| 6 | email | Draft a two-sentence email to a teammate asking to meet on F | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=113, timeoutSeconds=120 | none | none |
| 7 | priority | A production app is unavailable for all customers. Classify | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=118, timeoutSeconds=120 | none | none |
| 8 | dedupe | Deduplicate these names: Ada, Ada, Lin, Sam, Lin. Return one | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=103, timeoutSeconds=120 | none | none |
| 9 | agenda | Make a short three-point agenda for a product kickoff: scope | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=95, timeoutSeconds=120 | none | none |
| 10 | project-naming | A fictional product named Harbor has been renamed Cedar. Wha | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=106, timeoutSeconds=120 | none | none |
| 11 | comparison | Compare offline-first storage and cloud-only storage. Includ | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=107, timeoutSeconds=120 | none | none |
| 12 | onboarding | Draft three onboarding steps for a local notebook: choose wo | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=96, timeoutSeconds=120 | none | none |
| 13 | user-story | Write a user story for exporting local notes to JSON. Use th | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=92, timeoutSeconds=120 | none | none |
| 14 | http-error | What does HTTP 401 mean for a signed-in application? Answer | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=108, timeoutSeconds=120 | none | none |
| 15 | debugging | An export button does nothing. Write a short bug report with | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=98, timeoutSeconds=120 | none | none |
| 16 | table | Make a Markdown table with headers Feature and Priority and | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=83, timeoutSeconds=120 | none | none |
| 17 | risk | List the top two risks of putting authentication tokens in a | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=107, timeoutSeconds=120 | none | none |
| 18 | decision | Write a short decision record stating that the app uses loca | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=121, timeoutSeconds=120 | none | none |
| 19 | acceptance | Write acceptance criteria for offline mode. Include the word | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=89, timeoutSeconds=120 | none | none |
| 20 | exact | Respond with exactly this text and nothing else: VIVIM CEDAR | true | site=deepseek, freshTab=true, browserAction=false, action=connect-submit-poll-finish, promptChars=66, timeoutSeconds=120 | none | none |

## Summary

All 20 deepseek dry-runs completed successfully. Every invocation returned valid JSON with `dryRun: true`, `site=deepseek`, `freshTab=true`, `browserAction=false`, `action=connect-submit-poll-finish`, `timeoutSeconds=120`, and the correct `promptChars` per prompt. No errors were observed and no per-task gaps/issues were identified. No browser was launched and no sends were performed.

## Agent-context gaps observed

- **No deepseek-specific recipe/family wiring verified:** The dry-run path does not touch `src/recipes/catalog.mjs`, family stores, or profile resolution, so this lane confirms only the command-surface preview shape (`studio chat <site> --prompt`), not that `deepseek` is a registered/implemented site family capable of a live send. A live `--execute` run would be needed to confirm provider-specific capabilities.
- **Command surface limitation:** `studio chat` accepts a single `--prompt` and fixed `--timeout` (default 120s, range 1–900). There is no flag to vary `freshTab`/`targetId` independently beyond `--target`/`--fresh`, and no multi-turn or session-resume surface in the chat command itself (those live in capture/replay). For a 100-scenario dry-rub this is adequate, but it does not exercise conversation state or revision handling.
- **Profile/family mismatch risk (unverified):** The dry-run emits `freshTab=true` and `targetId=null` regardless of provider. It does not validate whether `deepseek` has a corresponding entry in the family/profile stores (`ctx.families()`, `ctx.profiles()`), so a provider/profile mismatch would only surface at live `--execute` time via `launchChrome`/runtime connect.
- **Output shape is uniform across providers:** The dry-run record is provider-agnostic (same `action`, `browserAction: false` for every site), so it cannot surface provider-specific constraints (e.g., auth requirements, rate limits, send selectors) until a live send is authorized.

Completion: all 20 tasks recorded. File: `docs/dry-rub-lane-4-deepseek.md`. All dry-runs OK, no live sends performed.
