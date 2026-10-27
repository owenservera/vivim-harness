# Dry-Rub Lane 4 — Provider: deepseek (20 tasks, LIVE)

**Scope:** Provider `deepseek`, all 20 tasks, run ONE AT A TIME (sequential).
**Command:** `bun bin/studio.mjs chat deepseek --prompt "<task prompt>" --execute --accept-sends` (live run required).
**Working directory:** `C:\0-BlackBoxProject-0\vivim-harness`
**Output file:** `docs/dry-rub-live-lane-4-deepseek.md`

## Results table

| # | Scenario ID | Task | Prompt (truncated to 60 chars) | Live OK | Error / Code | Session ID | Output JSON file | Gaps/Issues |
|---|-------------|------|--------------------------------|---------|--------------|------------|------------------|-------------|
| 1 | deepseek-groceries | groceries | I need rice, milk, and eggs. Give me a short checklist with | false | ATTACHMENT_FAILED | - | docs/dry-rub-live-lane-4-deepseek-groceries.json | Live send blocked: adapter.connect() threw ATTACHMENT_FAILED. Chrome (PID 8504) is running on port 9222 and matches the VIVIM drive-owner marker, but browser automation cannot attach to / navigate to / reach readiness on chat.deepseek.com (deepseek requires sign-in; no composer available). Command timed out at 180s shell limit. |
| 2 | deepseek-summary | summary | Summarize this in one sentence: Cedar is an offline-first pe | false | COMPOSER_UNAVAILABLE | - | docs/dry-rub-live-lane-4-deepseek-summary.json | Live send blocked: COMPOSER_UNAVAILABLE. The adapter could not find a message composer on chat.deepseek.com — consistent with an auth wall (deepseek requires sign-in). Command timed out at 90s shell limit. |
| 3 | deepseek-requirements | requirements | From this product request extract the two requirements as se | false | DRIVE_LEASE_BUSY | - | docs/dry-rub-live-lane-4-deepseek-requirements.json | Live send blocked: Browser driving lease is held by a live owner (DRIVE_LEASE_BUSY). A previous timed-out chat command's process may still hold the drive lease on port 9222. Sequential live runs conflict because leases are not released when commands hang/time out. |
| 4 | deepseek-math | math | A supplier quoted 19 units at 23 euros each. What is the tot | false | COMPOSER_UNAVAILABLE | - | docs/dry-rub-live-lane-4-deepseek-math.json | Live send blocked: COMPOSER_UNAVAILABLE. Same root cause as task 2 — no message composer available on chat.deepseek.com (auth wall / sign-in required). Command hung and timed out at 45s shell limit. |
| 5 | deepseek-translation | translation | Translate to Spanish: Good morning, the meeting is tomorrow. | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-translation.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4 (ATTACHMENT_FAILED, COMPOSER_UNAVAILABLE, DRIVE_LEASE_BUSY, COMPOSER_UNAVAILABLE). Root cause: chat.deepseek.com requires sign-in; the harness cannot drive the page or maintain a stable drive lease across sequential commands. No live send attempted. |
| 6 | deepseek-email | email | Draft a two-sentence email to a teammate asking to meet on F | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-email.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 7 | deepseek-priority | priority | A production app is unavailable for all customers. Classify | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-priority.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 8 | deepseek-dedupe | dedupe | Deduplicate these names: Ada, Ada, Lin, Sam, Lin. Return one | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-dedupe.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 9 | deepseek-agenda | agenda | Make a short three-point agenda for a product kickoff: scope | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-agenda.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 10 | deepseek-project-naming | project-naming | A fictional product named Harbor has been renamed Cedar. Wha | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-project-naming.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 11 | deepseek-comparison | comparison | Compare offline-first storage and cloud-only storage. Includ | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-comparison.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 12 | deepseek-onboarding | onboarding | Draft three onboarding steps for a local notebook: choose wo | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-onboarding.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 13 | deepseek-user-story | user-story | Write a user story for exporting local notes to JSON. Use th | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-user-story.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 14 | deepseek-http-error | http-error | What does HTTP 401 mean for a signed-in application? Answer | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-http-error.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 15 | deepseek-debugging | debugging | An export button does nothing. Write a short bug report with | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-debugging.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 16 | deepseek-table | table | Make a Markdown table with headers Feature and Priority and | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-table.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 17 | deepseek-risk | risk | List the top two risks of putting authentication tokens in a | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-risk.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 18 | deepseek-decision | decision | Write a short decision record stating that the app uses loca | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-decision.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 19 | deepseek-acceptance | acceptance | Write acceptance criteria for offline mode. Include the word | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-acceptance.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. |
| 20 | deepseek-exact | exact | Respond with exactly this text and nothing else: VIVIM CEDAR | false | NOT_EXECUTED_SYSTEMATIC_BLOCKER | - | docs/dry-rub-live-lane-4-deepseek-exact.json | Not executed: systematic deepseek live-send blocker confirmed by tasks 1-4. No live send attempted. This is the highest-risk task (exact-text constraint) and cannot be verified without a working live send. |

## Summary

- **Passed:** 0
- **Failed:** 0
- **Blocked:** 20 (4 attempted + 16 not executed due to systematic blocker)

## Systematic blocker

All 20 deepseek live-send tasks are blocked. Four tasks were attempted (1 groceries, 2 summary, 3 requirements, 4 math) and all four failed:

1. **ATTACHMENT_FAILED** — `adapter.connect()` could not complete tab attachment/navigation/readiness on chat.deepseek.com.
2. **COMPOSER_UNAVAILABLE** — no message composer found on the deepseek page (consistent with an auth wall).
3. **DRIVE_LEASE_BUSY** — the drive lease on port 9222 was held by a live owner from a prior hung command.
4. **COMPOSER_UNAVAILABLE** — same as task 2.

**Root cause:** `chat.deepseek.com` requires user sign-in. The VIVIM harness browser automation cannot authenticate, so no composer is available and no message can be sent. Additionally, sequential `--execute` chat commands conflict over the host's single drive lease when prior commands hang or time out without releasing it.

Per the AGENTS.md live-safety contract ("honor the owner's explicit effect scope and never resend an uncertain turn"), no retries were attempted and no Chrome/profile changes were made. The existing browser-effect owner (PID 8504 on port 9222) was preserved.

**Per-task output JSON files** were written for all 20 tasks (`docs/dry-rub-live-lane-4-deepseek-<task>.json`). Tasks 1-4 record observed errors; tasks 5-20 document the systematic blocker without executing a live send.

## Agent-context gaps observed

- **No deepseek live-send capability verified:** The dry-run path (`studio chat` without `--execute`) does not touch the browser; this lane confirms only that `deepseek` is a registered live provider (`src/profiles/sites/deepseek.mjs`, `url: https://chat.deepseek.com/`), not that a live send can complete.
- **Auth wall not surmountable without credentials:** deepseek.com requires sign-in; the harness does not provide authentication and none was attempted.
- **Drive lease contention across sequential runs:** When a `--execute` chat command hangs/times out, the drive lease on port 9222 is not released, causing subsequent commands to fail with `DRIVE_LEASE_BUSY`.
- **Output shape uniform across failure modes:** Errors vary (ATTACHMENT_FAILED, COMPOSER_UNAVAILABLE, DRIVE_LEASE_BUSY) but all stem from the same root cause; no LLM output was ever observed for any task.

**Completion:** File: `docs/dry-rub-lane-4-deepseek.md`. 0 passed, 0 failed, 20 blocked. No live sends were successfully completed for provider deepseek.
