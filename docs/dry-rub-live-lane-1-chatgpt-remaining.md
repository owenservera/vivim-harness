# VIVIM Harness — Dry-Rub Lane 1 ChatGPT Remaining Tasks (3–20, LIVE)

**Method:** `bun bin/studio.mjs chat chatgpt --prompt "<task prompt>" --execute --accept-sends` (LIVE send, real browser, real provider).
**Working directory:** `C:\0-BlackBoxProject-0\vivim-harness`
**Output files:** `docs/dry-rub-live-lane-1-chatgpt-<task>.json` (full JSON per task).
**Policy:** One task at a time, sequential. No retries on uncertain effects.

| # | Scenario ID | Task | Prompt (truncated) | Live OK | Error / Code | Session ID | Output JSON file | Gaps/Issues |
|---|-------------|------|-------------------|---------|--------------|------------|------------------|-------------|
| 3 | chatgpt-requirements | requirements | From this product request extract the two requirements as se... | BLOCKED | reply state `interrupted`; completion `unknown`; reply text "This response couldn't load" (ChatGPT error) | 20261027-200638-chatgpt-efa16d | docs/dry-rub-live-lane-1-chatgpt-requirements.json | REPLY_COMPLETION_UNKNOWN, READINESS_READY_WITH_COMPLETION_UNKNOWN, CAPTURE_NOT_IDLE_AT_PRESERVATION; reply.state !== 'ready'; no requirements content verified (ChatGPT returned error message instead of bullet points). |
| 4 | chatgpt-math | math | A supplier quoted 19 units at 23 euros each. What is the tot... | BLOCKED | Browser driving lease is held by a live owner (drive lease contention; no send attempted) | - | docs/dry-rub-live-lane-1-chatgpt-math.json | DRIVE_LEASE_BUSY; output file contains error text only (not JSON); not retried per no-retry policy. |
| 5 | chatgpt-translation | translation | Translate to Spanish: Good morning, the meeting is tomorrow.... | BLOCKED | error: DRAFT_PRESENT (a draft is present in the composer; no send attempted) | - | docs/dry-rub-live-lane-1-chatgpt-translation.json | DRAFT_PRESENT; output file contains error text only (not JSON); not retried per no-retry policy. Composer has an unresolved draft blocking new sends. |
| 6 | chatgpt-email | email | Draft a two-sentence email to a teammate asking to meet on F... | BLOCKED | Cannot reach the capture browser: CDP connect failed (Connection ended) | - | docs/dry-rub-live-lane-1-chatgpt-email.json | CDP connection failed; hint: run "studio launch" or "studio doctor" first. Output file contains error text only (not JSON); not retried per no-retry policy. |
