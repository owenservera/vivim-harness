# VIVIM Dry-Rub Lane 5 — Provider `zai` (20 tasks)

Sequential native harness CLI live runs:
`bun bin/studio.mjs chat zai --prompt "<task prompt>" --execute --accept-sends`

**Live run mode:** real Chrome browser, real provider sends to zai.org, fresh tab per scenario, no retries on uncertain effects.

| # | Scenario ID | Task | Prompt (truncated 60) | Live OK | Error / Code | Session ID | Output JSON file | Gaps/Issues |
|---|-------------|------|-----------------------|---------|--------------|------------|------------------|-------------|
| 1 | zai-groceries | groceries | I need rice, milk, and eggs. Give me a short checklist with... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-groceries.json | Blocked before any send: host-level drive lease (port 9222) held by live owner process (pid 12648, bun, kind=conversation-writer). Lease only reclaims dead/missing/corrupt owners; live owner cannot be displaced. |
| 2 | zai-summary | summary | Summarize this in one sentence: Cedar is an offline-first pe... | false | ATTACHMENT_FAILED: Studio couldn't attach to that tab | — | docs/dry-rub-live-lane-5-zai-summary.json | Drive lease was free at this point, but attachment to the zai tab failed; no conversation established, no send attempted. |
| 3 | zai-requirements | requirements | From this product request extract the two requirements as se... | false | TURN_NOT_CONFIRMED (state=needs-reconciliation, phase=uncertain, send=uncertain) | 20261027-192941-zai-815d6e | docs/dry-rub-live-lane-5-zai-requirements.json | Connected to zai, turn submitted, but send not confirmed by provider; no assistant reply received. Uncertain effect — documented, not resent. |
| 4 | zai-math | math | A supplier quoted 19 units at 23 euros each. What is the tot... | false | TURN_NOT_CONFIRMED (state=needs-reconciliation, phase=uncertain, send=uncertain) | 20261027-193225-zai-db1c02 | docs/dry-rub-live-lane-5-zai-math.json | Connected to zai, turn submitted, but send not confirmed; no reply (expected "437"). Uncertain effect — documented, not resent. |
| 5 | zai-translation | translation | Translate to Spanish: Good morning, the meeting is tomorrow.... | false | TURN_NOT_CONFIRMED (state=needs-reconciliation, phase=uncertain, send=uncertain) | 20261027-193455-zai-c41a51 | docs/dry-rub-live-lane-5-zai-translation.json | Connected to zai, turn submitted, but send not confirmed; no Spanish translation received. Uncertain effect — documented, not resent. |
| 6 | zai-email | email | Draft a two-sentence email to a teammate asking to meet on F... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-email.json | Blocked before any send: live owner re-acquired the drive lease. |
| 7 | zai-priority | priority | A production app is unavailable for all customers. Classify ... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-priority.json | Blocked before any send: live owner re-acquired the drive lease. |
| 8 | zai-dedupe | dedupe | Deduplicate these names: Ada, Ada, Lin, Sam, Lin. Return one... | false | TURN_NOT_CONFIRMED (state=needs-reconciliation, phase=uncertain, send=uncertain) | 20261027-193915-zai-180dd4 | docs/dry-rub-live-lane-5-zai-dedupe.json | Connected to zai, turn submitted, but send not confirmed; no deduped list received. Uncertain effect — documented, not resent. |
| 9 | zai-agenda | agenda | Make a short three-point agenda for a product kickoff: scope... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-agenda.json | Blocked before any send: live owner re-acquired the drive lease. |
| 10 | zai-project-naming | project-naming | A fictional product named Harbor has been renamed Cedar. Wha... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-project-naming.json | Blocked before any send: live owner re-acquired the drive lease. |
| 11 | zai-comparison | comparison | Compare offline-first storage and cloud-only storage. Includ... | false | TURN_NOT_CONFIRMED (state=needs-reconciliation, phase=uncertain, send=uncertain) | 20261027-194354-zai-d79406 | docs/dry-rub-live-lane-5-zai-comparison.json | Connected to zai, turn submitted, but send not confirmed; no comparison received. Uncertain effect — documented, not resent. |
| 12 | zai-onboarding | onboarding | Draft three onboarding steps for a local notebook: choose wo... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-onboarding.json | Blocked before any send: live owner re-acquired the drive lease. |
| 13 | zai-user-story | user-story | Write a user story for exporting local notes to JSON. Use th... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-user-story.json | Blocked before any send: live owner re-acquired the drive lease. |
| 14 | zai-http-error | http-error | What does HTTP 401 mean for a signed-in application? Answer ... | false | TURN_NOT_CONFIRMED (state=needs-reconciliation, phase=uncertain, send=uncertain) | 20261027-194552-zai-d1eb06 | docs/dry-rub-live-lane-5-zai-http-error.json | Connected to zai, turn submitted, but send not confirmed; no "401 authentication" answer received. Uncertain effect — documented, not resent. |
| 15 | zai-debugging | debugging | An export button does nothing. Write a short bug report with... | false | TURN_NOT_CONFIRMED (state=needs-reconciliation, phase=uncertain, send=uncertain) | 20261027-194731-zai-a2e08b | docs/dry-rub-live-lane-5-zai-debugging.json | Connected to zai, turn submitted, but send not confirmed; no bug report received. Uncertain effect — documented, not resent. |
| 16 | zai-table | table | Make a Markdown table with headers Feature and Priority and ... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-table.json | Blocked before any send: live owner re-acquired the drive lease. |
| 17 | zai-risk | risk | List the top two risks of putting authentication tokens in a... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-risk.json | Blocked before any send: live owner re-acquired the drive lease. |
| 18 | zai-decision | decision | Write a short decision record stating that the app uses loca... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-decision.json | Blocked before any send: live owner re-acquired the drive lease. |
| 19 | zai-acceptance | acceptance | Write acceptance criteria for offline mode. Include the word... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-acceptance.json | Blocked before any send: live owner re-acquired the drive lease. |
| 20 | zai-exact | exact | Respond with exactly this text and nothing else: VIVIM CEDAR... | false | DRIVE_LEASE_BUSY: Browser driving lease is held by a live owner | — | docs/dry-rub-live-lane-5-zai-exact.json | Blocked before any send: live owner re-acquired the drive lease. |

## Root cause

The host-level drive lease (`LOCALAPPDATA/AION/drive-leases/9222/owner.json`) is held by a live `bun` process (pid 12648, holder kind=conversation-writer) that is not part of this lane. The lease module (`src/capture/drive-lease.mjs`) only reclaims dead/missing/corrupt owners; a live owner blocks acquisition indefinitely. Per AGENTS.md live-safety rules, the live owner was not killed or interfered with.

## Counts

- Passed (confirmed OK): 0 / 20
- Connected but send not confirmed (uncertain effect): 7 / 20 (requirements, math, translation, dedupe, comparison, http-error, debugging)
- Failed (no conversation established): 1 / 20 (summary — ATTACHMENT_FAILED)
- Blocked before any send: 12 / 20 (groceries, email, priority, agenda, project-naming, onboarding, user-story, table, risk, decision, acceptance, exact — DRIVE_LEASE_BUSY)

## Notes

- All 20 output JSON files were written to `docs/dry-rub-live-lane-5-zai-<task>.json`.
- No retries were performed on uncertain or blocked effects, per the dry-rub rules.
- The 7 connected tasks reached `state=closed` / `phase=uncertain` / `send=uncertain` with empty reply text — the provider did not confirm any turn, so no assistant output was received for any task.
- Lane 5 (zai) is complete.
