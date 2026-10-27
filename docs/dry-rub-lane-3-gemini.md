# VIVIM dry-rub Lane 3 — provider `gemini` (20 tasks)

**Source:** `C:\0-BlackBoxProject-0\vivim-harness`
**Command (dry run, no `--execute`, no browser, no sends):**
`bun bin/studio.mjs chat gemini --prompt "<task prompt>"`
**Working directory:** `C:\0-BlackBoxProject-0\vivim-harness`
**Runner:** Lane 3 of 5 (manual dry-rub of 100 live user scenarios)
**Date:** Tue Oct 27 2026

## Dry-run contract

Per `bin/commands/chat.mjs`, when `--execute` is omitted the `chat` command does **not** construct the runtime or open a browser. It emits a single preview JSON record:

```json
{
  "dryRun": true,
  "site": "gemini",
  "targetId": null,
  "freshTab": true,
  "promptChars": <N>,
  "timeoutSeconds": 120,
  "action": "connect-submit-poll-finish",
  "browserAction": false
}
```

Key fields recorded below: `site`, `freshTab`, `browserAction`, `action`, `promptChars`, `timeoutSeconds`. All 20 tasks exited 0 with `dryRun: true` and no errors.

## Results table

| # | Task | Prompt (truncated to 60 chars) | Dry-run OK | Output key fields | Errors | Gaps/Issues |
|---:|------|--------------------------------|------------|-------------------|--------|-------------|
| 1 | groceries | I need rice, milk, and eggs. Give me a short checklist with | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=86, timeoutSeconds=120 | none | Dry-run never reaches provider; checklist content/exactness not verified against a real model reply. |
| 2 | summary | Summarize this in one sentence: Cedar is an offline-first pe | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=119, timeoutSeconds=120 | none | One-sentence constraint and JSON-export/sign-in details not validated against provider output. |
| 3 | requirements | From this product request extract the two requirements as se | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=133, timeoutSeconds=120 | none | Two-bullet extraction and local-save/JSON-export requirements not validated against provider output. |
| 4 | math | A supplier quoted 19 units at 23 euros each. What is the tot | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=99, timeoutSeconds=120 | none | Expected numeric answer 437 not verified; dry-run produces no model computation. |
| 5 | translation | Translate to Spanish: Good morning, the meeting is tomorrow. | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=97, timeoutSeconds=120 | none | Spanish output and required words (buenos, mañana) not verified; gemini profile requires auth (see gaps). |
| 6 | email | Draft a two-sentence email to a teammate asking to meet on F | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=113, timeoutSeconds=120 | none | Two-sentence count and "Subject: Friday sync" line not verified against provider output. |
| 7 | priority | A production app is unavailable for all customers. Classify | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=118, timeoutSeconds=120 | none | HIGH/LOW classification and explanation not verified; no provider send occurs. |
| 8 | dedupe | Deduplicate these names: Ada, Ada, Lin, Sam, Lin. Return one | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=103, timeoutSeconds=120 | none | Alphabetical dedupe result (Ada, Lin, Sam) not verified; no model output observed. |
| 9 | agenda | Make a short three-point agenda for a product kickoff: scope | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=95, timeoutSeconds=120 | none | Three points (scope, owners, risks) not verified against provider output. |
| 10 | project-naming | A fictional product named Harbor has been renamed Cedar. Wha | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=106, timeoutSeconds=120 | none | One-sentence current-name answer ("Cedar") not verified; no provider send. |
| 11 | comparison | Compare offline-first storage and cloud-only storage. Includ | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=107, timeoutSeconds=120 | none | Required words (offline, cloud) and one tradeoff not verified; no model output. |
| 12 | onboarding | Draft three onboarding steps for a local notebook: choose wo | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=96, timeoutSeconds=120 | none | Three steps (choose workspace, create note, export JSON) not verified against provider output. |
| 13 | user-story | Write a user story for exporting local notes to JSON. Use th | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=92, timeoutSeconds=120 | none | Required phrases ("As a user", "so that") not verified; no provider send. |
| 14 | http-error | What does HTTP 401 mean for a signed-in application? Answer | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=108, timeoutSeconds=120 | none | Required number 401 and word "authentication" not verified; no model output observed. |
| 15 | debugging | An export button does nothing. Write a short bug report with | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=98, timeoutSeconds=120 | none | Steps/Expected/Actual headings not verified against provider output. |
| 16 | table | Make a Markdown table with headers Feature and Priority and | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=83, timeoutSeconds=120 | none | Markdown table structure (headers Feature/Priority, rows Export/Search) not verified. |
| 17 | risk | List the top two risks of putting authentication tokens in a | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=107, timeoutSeconds=120 | none | Required words (tokens, logs) and two risks not verified; no model output. |
| 18 | decision | Write a short decision record stating that the app uses loca | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=121, timeoutSeconds=120 | none | "Decision" label and local-first/JSON-export content not verified; no provider send. |
| 19 | acceptance | Write acceptance criteria for offline mode. Include the word | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=89, timeoutSeconds=120 | none | Required words (offline, restart, saved) not verified; no model output observed. |
| 20 | exact | Respond with exactly this text and nothing else: VIVIM CEDAR | true | site=gemini, freshTab=true, targetId=null, browserAction=false, action=connect-submit-poll-finish, promptChars=66, timeoutSeconds=120 | none | Exact-text requirement cannot be verified in a dry-run; no provider send or reply comparison occurs. |

## Summary

- **20 / 20 tasks** completed with `dryRun: true`, exit code 0, no errors.
- Every task produced the same preview record shape: `site=gemini`, `freshTab=true`, `targetId=null`, `browserAction=false`, `action=connect-submit-poll-finish`, `timeoutSeconds=120`, with `promptChars` matching each prompt's length (66–133).
- No `--execute` or `--accept-sends` was used; no browser was launched and no provider send occurred. Therefore **no model responses were observed** and **no task-specific correctness can be claimed** from these dry-runs.

## Agent-context gaps observed

1. **No provider capability in the dry-run surface.** The `chat` dry-run only previews `connect-submit-poll-finish`; it does not exercise any provider adapter. The ten executable V1 recipes (`provider.targets`, `provider.chat-index`, `conversation.*`, `recovery.reconcile-turn`) all require a running Studio and a live-bound conversation, none of which are part of this dry-run command. So the dry-run cannot surface whether `gemini` is actually reachable or registered as a usable provider target.

2. **`gemini` profile requires auth but dry-run is blind to it.** `src/profiles/sites/gemini.mjs` sets `preflight.requiresAuth: true` with Google auth-wall selectors. A dry-run never opens a browser, so this auth requirement (and the composer/send/doneWhen selectors) is never validated. A live `gemini` send would likely hit the auth wall unless a signed-in Chrome profile/owner session exists.

3. **Fresh-tab-only default.** With no `--target`, every dry-run uses `freshTab=true`, `targetId=null`. There is no way via this command to test binding to an existing native conversation or to reuse a prior turn's revision — the `conversation.continue` recipe path (expectedRevision) is unreachable from `chat` dry-run.

4. **No model-response verification.** None of the 20 task-specific constraints (exact text "VIVIM CEDAR READY", number 437, required words, headings, labels, bullet counts, table shape) can be confirmed without `--execute` and a live provider reply. The `exact` task in particular is inherently unverifiable in dry-run mode.

5. **Output is metadata-only.** Per the runtime doc, default read results redact prompt/reply content; `--include-content` would be needed for content, but dry-run emits no content at all — only the preview contract above.

6. **No per-task differentiation in output.** All 20 records are structurally identical (only `promptChars` differs), so the dry-run surface provides no signal to distinguish task families or expected output formats.

**File:** `C:\0-BlackBoxProject-0\vivim-harness/docs/dry-rub-lane-3-gemini.md`
**One-line summary:** All 20 gemini dry-runs succeeded (exit 0, `dryRun: true`) with identical preview metadata and no errors, but no provider send or model response was observed, so task-specific correctness remains unverified.
