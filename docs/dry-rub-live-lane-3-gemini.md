# VIVIM Harness Live Dry-Rub — Lane 3: Provider `gemini` (20 tasks)

**Scope:** Provider `gemini`, all 20 tasks, run ONE AT A TIME (sequential).
**Command:** `bun bin/studio.mjs chat gemini --prompt "<task prompt>" --execute --accept-sends --fresh --json` (live run, real browser, real sends to gemini.google.com)
**Working directory:** `C:\0-BlackBoxProject-0\vivim-harness`
**Output file:** `C:\0-BlackBoxProject-0\vivim-harness\docs\dry-rub-live-lane-3-gemini.md`
**Date:** Tue Oct 27 2026

## Results table

| # | Scenario ID | Task | Prompt (truncated) | Live OK | Error / Code | Session ID | Output JSON file | Gaps/Issues |
|---|-------------|------|--------------------|---------|--------------|------------|------------------|-------------|
| 1 | gemini-groceries | groceries | I need rice, milk, and eggs. Give me a short checklist with... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-192649-gemini-b21bc9 | docs/dry-rub-live-lane-3-gemini-groceries.json | Send not confirmed; no model reply observed; checklist exactness unverified; CAPTURE_NOT_IDLE_AT_PRESERVATION gap |
| 2 | gemini-summary | summary | Summarize this in one sentence: Cedar is an offline-first pe... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-193121-gemini-076d98 | docs/dry-rub-live-lane-3-gemini-summary.json | Send not confirmed; no model reply observed; one-sentence constraint and JSON/sign-in details unverified; command timed out at 180s |
| 3 | gemini-requirements | requirements | From this product request extract the two requirements as se... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-requirements.json | Browser lease held by live owner; send never occurred; two-bullet/local-save/JSON-export requirements unverified |
| 4 | gemini-math | math | A supplier quoted 19 units at 23 euros each. What is the tot... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-193630-gemini-ae6ae0 | docs/dry-rub-live-lane-3-gemini-math.json | Send not confirmed; no model reply observed; answer "437" unverified; command timed out at 180s |
| 5 | gemini-translation | translation | Translate to Spanish: Good morning, the meeting is tomorrow.... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-193753-gemini-4cf0cd | docs/dry-rub-live-lane-3-gemini-translation.json | Send not confirmed; no model reply observed; Spanish/buenos/mañana unverified; command timed out at 180s |
| 6 | gemini-email | email | Draft a two-sentence email to a teammate asking to meet on F... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-email.json | Browser lease held by live owner; send never occurred; two-sentence count and subject line unverified |
| 7 | gemini-priority | priority | A production app is unavailable for all customers. Classify ... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-priority.json | Browser lease held by live owner; send never occurred; HIGH/LOW classification unverified |
| 8 | gemini-dedupe | dedupe | Deduplicate these names: Ada, Ada, Lin, Sam, Lin. Return one... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-194306-gemini-66e4cf | docs/dry-rub-live-lane-3-gemini-dedupe.json | Send not confirmed; no model reply observed; alphabetical dedupe result unverified |
| 9 | gemini-agenda | agenda | Make a short three-point agenda for a product kickoff: scope... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-194436-gemini-de4863 | docs/dry-rub-live-lane-3-gemini-agenda.json | Send not confirmed; no model reply observed; three points/scope-owners-risks unverified |
| 10 | gemini-project-naming | project-naming | A fictional product named Harbor has been renamed Cedar. Wha... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-project-naming.json | Browser lease held by live owner; send never occurred; current-name answer ("Cedar") unverified |
| 11 | gemini-comparison | comparison | Compare offline-first storage and cloud-only storage. Includ... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-194619-gemini-cd6009 | docs/dry-rub-live-lane-3-gemini-comparison.json | Send not confirmed; no model reply observed; offline/cloud/tradeoff unverified; ConnectionRefused observed in prefix |
| 12 | gemini-onboarding | onboarding | Draft three onboarding steps for a local notebook: choose wo... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-onboarding.json | Browser lease held by live owner; send never occurred; three steps unverified |
| 13 | gemini-user-story | user-story | Write a user story for exporting local notes to JSON. Use th... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-user-story.json | Browser lease held by live owner; send never occurred; required phrases unverified |
| 14 | gemini-http-error | http-error | What does HTTP 401 mean for a signed-in application? Answer ... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-194758-gemini-e114e7 | docs/dry-rub-live-lane-3-gemini-http-error.json | Send not confirmed; no model reply observed; 401/authentication unverified; connection closed observed in prefix |
| 15 | gemini-debugging | debugging | An export button does nothing. Write a short bug report with ... | false | PREFLIGHT_FAILED | none | docs/dry-rub-live-lane-3-gemini-debugging.json | Preflight failed; send never occurred; Steps/Expected/Actual headings unverified |
| 16 | gemini-table | table | Make a Markdown table with headers Feature and Priority and ... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-table.json | Browser lease held by live owner; send never occurred; Markdown table structure unverified |
| 17 | gemini-risk | risk | List the top two risks of putting authentication tokens in a... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-risk.json | Browser lease held by live owner; send never occurred; tokens/logs keywords unverified |
| 18 | gemini-decision | decision | Write a short decision record stating that the app uses loca... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-decision.json | Browser lease held by live owner; send never occurred; Decision label/local-first/JSON-export unverified |
| 19 | gemini-acceptance | acceptance | Write acceptance criteria for offline mode. Include the word... | false | DRIVE_LEASE_BUSY | none | docs/dry-rub-live-lane-3-gemini-acceptance.json | Browser lease held by live owner; send never occurred; offline/restart/saved keywords unverified |
| 20 | gemini-exact | exact | Respond with exactly this text and nothing else: VIVIM CEDAR... | false | TURN_NOT_CONFIRMED / needs-reconciliation / send: uncertain | 20261027-195738-gemini-173a93 | docs/dry-rub-live-lane-3-gemini-exact.json | Send not confirmed; no model reply observed; exact-text "VIVIM CEDAR READY" unverified (highest-risk task); command timed out at 180s |

## Summary

- **20 / 20 tasks attempted** sequentially with `--execute --accept-sends --fresh`.
- **0 passed**, **0 confirmed live sends**, **20 failed or blocked**.
  - **9 tasks**: `TURN_NOT_CONFIRMED` / `needs-reconciliation` — send attempted but not confirmed; no model reply observed (groceries, summary, math, translation, dedupe, agenda, http-error, comparison, exact).
  - **11 tasks**: blocked before send — `DRIVE_LEASE_BUSY` (browser lease held by live owner) for 10 tasks; `PREFLIGHT_FAILED` for 1 task (debugging).
- **No task-specific correctness can be claimed** — no model responses were observed for any task.
- Every output JSON is preserved under `docs/dry-rub-live-lane-3-gemini-<task>.json`.

## Root-cause observations

1. **Browser driving lease held by a live owner** (`DRIVE_LEASE_BUSY`) — the dedicated Chrome session/browser lease was already held by a prior live owner process, preventing new tabs from being driven. This affected the majority of tasks.
2. **`TURN_NOT_CONFIRMED` / `needs-reconciliation`** — for tasks that did allocate a Studio-owned tab and conversation, the send phase was recorded as `uncertain`; no reply was captured, and per dry-rub rules no resend was attempted.
3. **Command timeouts at 180s** — several tasks exceeded the polling budget without reaching a confirmed terminal state.
4. **No confirmed live send** — because every task ended in either a blocked lease or an uncertain send, zero provider replies were observed, so none of the 20 task constraints (exact text, keyword inclusion, counts, headings, table shape, numeric answer) could be verified against real model output.

## Completion

All 20 gemini live tasks completed (attempted). Results written to `C:\0-BlackBoxProject-0\vivim-harness\docs\dry-rub-live-lane-3-gemini.md`. One-line summary: Lane 3 (gemini, 20 tasks) — all 20 live runs attempted with `--execute --accept-sends`; 0 passed, 0 confirmed sends, 20 failed/blocked (9 TURN_NOT_CONFIRMED uncertain, 11 blocked by DRIVE_LEASE_BUSY/PREFLIGHT_FAILED); no model responses observed; full JSON output preserved per task.
