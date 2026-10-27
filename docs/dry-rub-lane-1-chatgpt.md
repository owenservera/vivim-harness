# VIVIM Harness Dry-Rub — Lane 1: Provider `chatgpt` (20 tasks)

**Scope:** Provider `chatgpt`, all 20 tasks, run ONE AT A TIME (sequential).
**Command:** `bun bin/studio.mjs chat chatgpt --prompt "<task prompt>"` (dry run only — no `--execute`, no `--accept-sends`, zero effect, no browser, no sends).
**Working directory:** `C:\0-BBlackBoxProject-0\vivim-harness` (actual: `C:\0-BlackBoxProject-0\vivim-harness`)
**Output file:** `docs/dry-rub-lane-1-chatgpt.md`

## Results table

| # | Task | Prompt (truncated to 60 chars) | Dry-run OK | Output key fields | Errors | Gaps/Issues |
|---|------|--------------------------------|------------|-------------------|--------|-------------|
| 1 | groceries | I need rice, milk, and eggs. Give me a short checklist with ... | true | site=chatgpt, freshTab=true, promptChars=86, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; no LLM output verified. targetId null (no tab binding). Single recipe path only. |
| 2 | summary | Summarize this in one sentence: Cedar is an offline-first pe ... | true | site=chatgpt, freshTab=true, promptChars=119, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run does not validate that one-sentence constraint is met; provider login/cred state not confirmed. |
| 3 | requirements | From this product request extract the two requirements as se ... | true | site=chatgpt, freshTab=true, promptChars=133, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; no content validation. freshTab always true (no session reuse). |
| 4 | math | A supplier quoted 19 units at 23 euros each. What is the tot ... | true | site=chatgpt, freshTab=true, promptChars=99, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; cannot confirm answer "437" appears in model output. |
| 5 | translation | Translate to Spanish: Good morning, the meeting is tomorrow. | true | site=chatgpt, freshTab=true, promptChars=97, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; Spanish/buenos/mañana inclusion not verified. |
| 6 | email | Draft a two-sentence email to a teammate asking to meet on F ... | true | site=chatgpt, freshTab=true, promptChars=113, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; subject line/two-sentence constraint not verified. |
| 7 | priority | A production app is unavailable for all customers. Classify ... | true | site=chatgpt, freshTab=true, promptChars=118, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; HIGH/LOW classification not verified. |
| 8 | dedupe | Deduplicate these names: Ada, Ada, Lin, Sam, Lin. Return one ... | true | site=chatgpt, freshTab=true, promptChars=103, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; dedupe/sort output not verified. |
| 9 | agenda | Make a short three-point agenda for a product kickoff: scope ... | true | site=chatgpt, freshTab=true, promptChars=95, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; three-point/all-three mention not verified. |
| 10 | project-naming | A fictional product named Harbor has been renamed Cedar. Wha ... | true | site=chatgpt, freshTab=true, promptChars=106, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; current-name answer not verified. |
| 11 | comparison | Compare offline-first storage and cloud-only storage. Includ ... | true | site=chatgpt, freshTab=true, promptChars=107, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; keyword/tradeoff inclusion not verified. |
| 12 | onboarding | Draft three onboarding steps for a local notebook: choose wo ... | true | site=chatgpt, freshTab=true, promptChars=96, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; three steps not verified. |
| 13 | user-story | Write a user story for exporting local notes to JSON. Use th ... | true | site=chatgpt, freshTab=true, promptChars=92, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; phrase inclusion not verified. |
| 14 | http-error | What does HTTP 401 mean for a signed-in application? Answer ... | true | site=chatgpt, freshTab=true, promptChars=108, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; "401" + "authentication" not verified. |
| 15 | debugging | An export button does nothing. Write a short bug report with | true | site=chatgpt, freshTab=true, promptChars=98, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; Steps/Expected/Actual headings not verified. |
| 16 | table | Make a Markdown table with headers Feature and Priority and ... | true | site=chatgpt, freshTab=true, promptChars=83, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; Markdown table structure not verified. |
| 17 | risk | List the top two risks of putting authentication tokens in a ... | true | site=chatgpt, freshTab=true, promptChars=107, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; keyword/top-two count not verified. |
| 18 | decision | Write a short decision record stating that the app uses loca ... | true | site=chatgpt, freshTab=true, promptChars=121, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; Decision label/content not verified. |
| 19 | acceptance | Write acceptance criteria for offline mode. Include the word ... | true | site=chatgpt, freshTab=true, promptChars=89, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; offline/restart/saved keywords not verified. |
| 20 | exact | Respond with exactly this text and nothing else: VIVIM CEDAR | true | site=chatgpt, freshTab=true, promptChars=66, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false, targetId=null | none | Dry-run only; exact-text constraint not verified (highest-risk task for dry-run limitation). |

## Observations

- **All 20 tasks returned `dryRun: true`** with no errors. Dry-run OK = true for every task.
- **Output key fields were identical across all tasks except `promptChars`:** `site=chatgpt`, `targetId=null`, `freshTab=true`, `timeoutSeconds=120`, `action=connect-submit-poll-finish`, `browserAction=false`.
- **No `--execute` or `--accept-sends` was used.** No live sends occurred; no browser was opened; zero side effects.

## Agent-context gaps observed

1. **Missing recipe capability variation:** The dry-run surfaces a single action (`connect-submit-poll-finish`) for every task. There is no visible per-task recipe selection or intent-based routing in the dry-run output, so it cannot be confirmed whether different task types (math, exact-text, table, etc.) map to distinct recipes or share one generic path.

2. **Command-surface limitation (dry-run hides content):** The dry-run JSON omits the actual model response and any rendered message. It confirms the CLI can connect/submit/poll/finish but cannot validate that the chatgpt provider satisfies each task's explicit constraints (exact text, keyword inclusion, counts, headings, Markdown structure). Task 20 (exact text "VIVIM CEDAR READY") is the clearest example: dry-run passes trivially without verifying the exact-text requirement.

3. **Profile/family mismatch:** None observed — provider prefix `chatgpt` consistently resolved to `site=chatgpt` with no mismatches. However, the dry-run cannot confirm profile validity, credential presence, or login state for the chatgpt provider; `targetId=null` indicates no tab/session binding is established in dry-run mode.

4. **Session reuse not exercised:** `freshTab=true` on every run and `targetId=null` mean no session/tab reuse or continuation behavior was tested. Multi-turn or stateful chat scenarios are out of scope for this dry-run lane.

## Completion

All 20 chatgpt dry-run tasks completed successfully with no errors. Results written to `C:\0-BlackBoxProject-0\vivim-harness/docs/dry-rub-lane-1-chatgpt.md`. One-line summary: Lane 1 (chatgpt, 20 tasks) — all dry-runs passed with identical key fields, no errors, zero live sends; gaps are limited to dry-run's inability to verify model-output constraints and the absence of recipe/session variation.
