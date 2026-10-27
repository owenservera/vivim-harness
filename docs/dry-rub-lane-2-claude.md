# Dry-rub results — Lane 2, provider `claude` (20 tasks)

Source: `C:\0-BlackBoxProject-0\vivim-harness`
Command used (dry run, zero effect, no browser, no sends):
`bun bin/studio.mjs chat claude --prompt "<task prompt>"`

Every task ran one at a time, sequentially, with no `--execute` and no `--accept-sends`.
The chat command's dry-run branch (`bin/commands/chat.mjs:19-22`) emits a zero-effect JSON preview without constructing the runtime or touching the browser.

## Results table

| # | Task | Prompt (truncated to 60 chars) | Dry-run OK | Output key fields | Errors | Gaps/Issues |
|---:|---|---|---:|---|---|---|
| 1 | groceries | I need rice, milk, and eggs. Give me a short checklist with ... | true | site=claude, targetId=null, freshTab=true, promptChars=86, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | Dry-run emits no model text, so the "exactly three items" content constraint cannot be verified at preview time. |
| 2 | summary | Summarize this in one sentence: Cedar is an offline-first pe... | true | site=claude, targetId=null, freshTab=true, promptChars=119, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; one-sentence constraint and JSON/sign-in/offline-first keyword coverage unverified. |
| 3 | requirements | From this product request extract the two requirements as se... | true | site=claude, targetId=null, freshTab=true, promptChars=133, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; two-bullet structure and local-save/JSON-export keyword coverage unverified. |
| 4 | math | A supplier quoted 19 units at 23 euros each. What is the tot... | true | site=claude, targetId=null, freshTab=true, promptChars=99, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; expected "437" in answer unverified. |
| 5 | translation | Translate to Spanish: Good morning, the meeting is tomorrow.... | true | site=claude, targetId=null, freshTab=true, promptChars=97, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; Spanish output and required words "buenos"/"mañana" unverified. |
| 6 | email | Draft a two-sentence email to a teammate asking to meet on F... | true | site=claude, targetId=null, freshTab=true, promptChars=113, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; two-sentence count and "Subject: Friday sync" line unverified. |
| 7 | priority | A production app is unavailable for all customers. Classify ... | true | site=claude, targetId=null, freshTab=true, promptChars=118, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; HIGH/LOW classification and explanation unverified. |
| 8 | dedupe | Deduplicate these names: Ada, Ada, Lin, Sam, Lin. Return one... | true | site=claude, targetId=null, freshTab=true, promptChars=103, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; single-occurrence alphabetical output unverified. |
| 9 | agenda | Make a short three-point agenda for a product kickoff: scope... | true | site=claude, targetId=null, freshTab=true, promptChars=95, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; three points covering scope/owners/risks unverified. |
| 10 | project-naming | A fictional product named Harbor has been renamed Cedar. Wha... | true | site=claude, targetId=null, freshTab=true, promptChars=106, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; one-sentence "Cedar" answer unverified. |
| 11 | comparison | Compare offline-first storage and cloud-only storage. Includ... | true | site=claude, targetId=null, freshTab=true, promptChars=107, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; required words "offline"/"cloud" and one tradeoff unverified. |
| 12 | onboarding | Draft three onboarding steps for a local notebook: choose wo... | true | site=claude, targetId=null, freshTab=true, promptChars=96, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; three steps (workspace/note/export JSON) unverified. |
| 13 | user-story | Write a user story for exporting local notes to JSON. Use th... | true | site=claude, targetId=null, freshTab=true, promptChars=92, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; required phrases "As a user"/"so that" unverified. |
| 14 | http-error | What does HTTP 401 mean for a signed-in application? Answer ... | true | site=claude, targetId=null, freshTab=true, promptChars=108, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; required "401" and "authentication" unverified. |
| 15 | debugging | An export button does nothing. Write a short bug report with... | true | site=claude, targetId=null, freshTab=true, promptChars=98, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; Steps/Expected/Actual headings unverified. |
| 16 | table | Make a Markdown table with headers Feature and Priority and ... | true | site=claude, targetId=null, freshTab=true, promptChars=83, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; header/row structure unverified. |
| 17 | risk | List the top two risks of putting authentication tokens in a... | true | site=claude, targetId=null, freshTab=true, promptChars=107, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; two risks and required words "tokens"/"logs" unverified. |
| 18 | decision | Write a short decision record stating that the app uses loca... | true | site=claude, targetId=null, freshTab=true, promptChars=121, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; "Decision" label and local-first/JSON-export content unverified. |
| 19 | acceptance | Write acceptance criteria for offline mode. Include the word... | true | site=claude, targetId=null, freshTab=true, promptChars=89, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; required words "offline"/"restart"/"saved" unverified. |
| 20 | exact | Respond with exactly this text and nothing else: VIVIM CEDAR... | true | site=claude, targetId=null, freshTab=true, promptChars=66, timeoutSeconds=120, action=connect-submit-poll-finish, browserAction=false | none | No live send; exact-text "VIVIM CEDAR READY" with nothing else unverified. |

## Observation notes

- All 20 dry-runs succeeded (`dryRun: true`, exit code 0). Output shape was identical across every task: `site=claude`, `targetId=null`, `freshTab=true`, `action=connect-submit-poll-finish`, `browserAction=false`, `timeoutSeconds=120`, `promptChars` matching each prompt's length.
- The chat command accepts a positional `<site>` argument, not a separate `<provider>`. The task's "provider `claude`" maps to site `claude`, which resolves to `profiles/claude.json`. No provider-vs-profile mismatch was observed for `claude`.
- `freshTab` defaults to `true` when `--target` is absent; `timeoutSeconds` defaults to `120`. Dry-run cannot exercise custom timeouts, target binding, or `--execute` without leaving dry-run mode.
- Dry-run deliberately performs no browser launch, no CDP connection, and no provider send (see `bin/commands/chat.mjs:19-23`), so **no model output, content constraint, or keyword requirement can be validated at this stage**. Every "Gaps/Issues" entry above reflects that limitation, not a command failure.
- No `--accept-sends` flag exists in the chat command; it was correctly not used. `--execute` was also not used, per scope.

## Agent-context gaps

- **No content verification in dry-run**: the preview only confirms the request is well-formed and within limits (prompt ≤ 250000 chars, timeout 1–900s). Task-specific correctness (exact item counts, required keywords, numeric answers, exact text) requires a live `--execute` send, which is out of scope for this lane.
- **Command surface limitation**: `studio chat <site> --prompt` takes `site` positionally; there is no separate `provider` flag, so provider-site pairing is implicit via the profile registry (`chatgpt`, `claude`, `generic`). A provider name that lacks a matching profile would not be distinguishable from a site name at the CLI boundary.
- **Missing recipe capabilities**: this lane exercised only the `chat` command's dry-run path. No recipe (`studio recipe ...`) was invoked, and no capture/replay/derive flow was exercised — consistent with the dry-run-only scope, but means end-to-end capture behavior for `claude` remains untested here.
- **Profile/family**: `claude.json` exists under `profiles/`; `families/` contains no `claude`-specific family (families are UI pattern families such as `ai-chat`, `search-results`, etc.), so family/profile alignment for `claude` is profile-driven only.
- **Default `freshTab=true`**: dry-run always requests a fresh Studio-owned tab; there is no preview path for binding to an existing `--target ID` without also supplying `--fresh` false, which the connect validator rejects as "Choose either --target ID or a fresh tab, not both" when both are set.

## Completion

All 20 provider-`claude` tasks completed one at a time via native harness CLI dry-run. Zero live sends, zero browser actions, zero errors.

File: `C:\0-BlackBoxProject-0\vivim-harness/docs/dry-rub-lane-2-claude.md`
Summary: 20/20 dry-runs OK; consistent zero-effect output (site=claude, freshTab=true, browserAction=false, action=connect-submit-poll-finish); no model content verified because dry-run excludes live sends.
