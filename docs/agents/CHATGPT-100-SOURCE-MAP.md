# ChatGPT 100 — source map

## 2026-10-28 roadmap/source reconciliation

**Latest-main correction:** `src/capture/conversation-rich.mjs` is wired into `src/capture/conversation-thread.mjs` for bounded read-only DOM parts. Objectives **043–048 and 050** are now **partial** in the [matrix](CHATGPT-100-RECONCILED-STATUS.md), not unsupported; citation anchoring **049** remains unsupported. This is synthetic/source evidence, **not live provider verification**.

The [per-scenario source matrix](CHATGPT-100-RECONCILED-STATUS.md) supersedes stale aggregate status counts below. The 134 explicitly referenced code/test files across the three maps were fetched for import/owner inspection; additional transitive source was inspected. **This does not establish all-callers closure, automated-test success or 100 live passes.** Source-level classification: 10 supported, 29 partial, 61 unsupported (supported ≠ live-verified).

- **011** is now exposed through `create_conversation` (existing Studio owner, no provider send): `src/studio/conversation-tools.mjs` → `src/capture/conversation-runtime.mjs:connect`. The previous “no Studio tool for new chat” statements below are superseded.
- **Capability preflight:** `conversation_capsule` is now a named read-only tool, delegating to the existing `src/capture/conversation-runtime.mjs:capsule` and `src/capture/conversation-capsule.mjs:buildCapabilityCapsule`. `conversation.capabilities` is a one-call recipe, not permission for an effect or a claim about account availability. Regression tests authored but not executed here.
- The separate [101–200 roadmap objectives](CHATGPT-200-ROADMAP-OBJECTIVES.md) extend Own / Share / Evolve; they are product goals, not passed probes.


Date: 2026-10-27. Companion to `docs/agents/CHATGPT-100-OBJECTIVES.md`.

This maps each objective to the source that can actually perform it. "No source" means the repo has no reader, control, or command for that interaction. Running those objectives can only report `HARNESS_UNSUPPORTED`.


## 2026-10-28 targeted source corrections (not a full 100-scenario verification)

- **003 / identity provenance:** `src/capture/thread-identity.mjs:chatgptConversationClaim` now delegates ChatGPT URL identity to `src/capture/conversation-thread.mjs:parseThread`. The canonical parser rejects user-info and nondefault ports; arbitrary HTTPS hosts can no longer mint a verified ChatGPT route identity. Regression: `test/unit/thread-identity.test.mjs`. **Source-reviewed; no live verification.**
- **041 / 098 / answer event freshness:** `src/studio/conversation-events.mjs:textKey` now fingerprints complete in-memory reply text, not only the capped SSE snapshot, so a same-length edit beyond the wire cap triggers a fresh `conversation.reply_text` event without transmitting the uncapped body. Regression: `test/unit/conversation-events-text.test.mjs`. **Source-reviewed; no live verification.**
- These changes do **not** resolve the missing native controls, artifact extraction, uploads, Projects/settings or scenario 022–023 continuity proof. Existing scenario bands remain as described below unless explicitly superseded. Source audit coverage is not claimed complete.

## Shared path

| Role | File |
|---|---|
| CLI entry | `bin/studio.mjs` |
| One-shot send and reply | `bin/commands/drive.mjs` → `src/capture/actions.mjs` |
| Named tools | `bin/commands/tools.mjs` → `src/studio/conversation-tools.mjs` → `src/studio/conversation-api.mjs` → `src/capture/conversation-runtime.mjs` |
| Browser actions | `src/capture/conversation-browser-adapter.mjs`, `src/capture/actions.mjs` |
| ChatGPT selectors | `src/profiles/sites/chatgpt.mjs` |
| Thread id from `/c/<uuid>` | `src/capture/conversation-thread.mjs`, `src/capture/thread-identity.mjs` |
| Sidebar link index | `src/capture/chatgpt-chat-index.mjs`, `src/capture/chatgpt-chat-index-reader.mjs` |
| Turn journal, no-resend | `src/capture/thread-turn-journal.mjs` |
| Uncertain-send reconcile | `src/studio/uncertain-step-reconciler.mjs`, `src/recipes/service.mjs` |
| Recipe names | `src/recipes/catalog.mjs` |
| Chrome and profile | `src/chrome/launch.mjs`, `src/config.mjs` |
| Capture session | `src/capture/recorder.mjs`, `src/store/session.mjs` |
| Saved world | `src/studio/world-service.mjs`, `src/capture/conversation-evidence.mjs` |

Tools registered in `src/studio/conversation-tools.mjs`: `conversation_targets`, `chat_index`, `list_conversations`, `get_conversation`, `connect_conversation`, `read_conversation`, `submit_conversation_turn`, `reconcile_conversation`, `finish_conversation`.

`connect_conversation` requires an existing exact `/c/` thread. It does not create a fresh chat.

## Capture Studio files that should have been used

Objectives 021 and 022 were run through `bin/commands/drive.mjs`. That command launches its own tab, types, and stops. It is not the Capture Studio owner. A measured ChatGPT objective should go through the running Studio (`node bin/studio.mjs start`), keep the dedicated profile, and leave a session the World can reopen.

### Owner

| Role | File |
|---|---|
| Process | `bin/studio.mjs`, `src/studio/server.mjs` |
| HTTP and tool dispatch | `src/studio/http.mjs`, `src/studio/harness-api.mjs`, `src/studio/tool-client.mjs`, `src/studio/tool-result.mjs` |
| Conversation API | `src/studio/conversation-api.mjs`, `src/studio/conversation-tools.mjs`, `src/studio/conversation-events.mjs` |
| Effect gate | `src/studio/core-runtime-bridge.mjs`, `src/studio/harness-executor-preflight.mjs`, `src/studio/intent-bindings.mjs` |
| Drive API inside Studio | `src/studio/drive-api.mjs` |
| Studio screens | `src/studio/ui/live.mjs`, `src/studio/ui/chat.mjs`, `src/studio/ui/drive.mjs`, `src/studio/ui/universal-chat.mjs`, `src/studio/ui/world-view.mjs`, `src/studio/ui/platform.mjs` |
| CDP | `src/cdp/client.mjs`, `src/cdp/discovery.mjs` |
| Browser | `src/chrome/launch.mjs` |
| Paths and profile dir | `src/config.mjs` |

### Capture (L1 raw, L2 decode, L3 DOM)

These are the files a send must pass through so the answer is a captured session, not only a CLI reply string.

| Layer | File |
|---|---|
| Session owner | `src/capture/recorder.mjs` |
| Network bytes | `src/capture/network.mjs` |
| Page DOM | `src/capture/dom.mjs`, `src/capture/page-agent.js` |
| Live text | `src/capture/live-tap.mjs` |
| Redaction | `src/capture/redact.mjs`, `src/capture/privacy.mjs`, `src/capture/stream-guard.mjs` |
| Which tab to follow | `src/capture/targets.mjs` |
| Decode | `src/decode/decoders.mjs`, `src/decode/delta.mjs` |
| Raw log | `src/store/raw-log.mjs`, `src/store/raw-index.mjs`, `src/store/session.mjs`, `src/store/integrity.mjs` |
| Replay | `src/replay/reducer.mjs`, `src/replay/derive.mjs` |
| Site profile | `profiles/chatgpt.json`, `src/profiles/profiles.mjs`, `src/profiles/sites/chatgpt.mjs` |
| Chat family | `src/families/families.mjs` |
| Acceptance | `src/capture/acceptance.mjs` |

`drive` did start a `Recorder` (`sessionId` `20261027-230222-chatgpt-2d22b0` and `20261027-230337-chatgpt-591846`). It did not use Studio's conversation tools, the World, or a kept tab. The follow-up therefore could not return to the first thread.

### What each band should call

| Objectives | Capture Studio files that should own them |
|---|---|
| 001–002 account and auth | `src/studio/server.mjs` status, `src/capture/conversation-browser-adapter.mjs`. No account-identity module exists. |
| 003–004 thread and tab | `conversation_targets` in `src/studio/conversation-tools.mjs`, `src/cdp/discovery.mjs` `listTargets`, `src/capture/conversation-thread.mjs`. |
| 005 profile | `src/config.mjs` `dataPaths().chromeProfile`, `src/chrome/launch.mjs`. Studio status is the check, not a second Chrome. |
| 006–007 ready and streaming | `src/capture/conversation-runtime.mjs` readiness, `src/capture/dom.mjs`, `src/capture/page-agent.js`, `src/capture/live-tap.mjs`. |
| 008–010 temporary chat, duplicate title, modal | No Studio control. Index only: `src/capture/chatgpt-chat-index.mjs`. |
| 011–014 navigation | `connect_conversation` / `chat_index` on the existing Studio owner. Not `drive` opening `https://chatgpt.com/`. |
| 015–020 search, scroll, archive | No Studio route. `src/capture/human.mjs` `humanScroll` is unused here. |
| 021 first turn | `submit_conversation_turn` via `src/studio/conversation-tools.mjs` → `src/capture/conversation-runtime.mjs` → `src/capture/conversation-browser-adapter.mjs`, with `src/capture/recorder.mjs` writing `src/store/session.mjs`. The live run used `drive` instead. |
| 022–023 follow-up | Same conversation id, same `expectedThread`, `src/capture/thread-turn-journal.mjs`. `drive` dropped the `/c/` path in the 2026-10-27 run; fixed 2026-10-28. |
| 024–030 edit, regenerate, stop, rename, archive | No Studio tool. |
| 031–033 typing and Enter | `src/capture/actions.mjs` only when called from the conversation adapter, plus `src/capture/human.mjs`. |
| 034–040 model, mic, chips, copy, feedback | No Studio control. |
| 041–042 read the answer | `read_conversation` plus `src/capture/dom.mjs` / `src/capture/page-agent.js` turns. Not the one-line `reply` field from `drive`. |
| 043–050 list, code, table, math, quote, link, citation, image | No extractor. Raw blocks would be in `src/capture/page-agent.js` and `src/decode/delta.mjs` if a session had been kept. |
| 051–060 search and thinking | No Studio tool. A real search would show up only as network records in `src/capture/network.mjs` and `src/decode/decoders.mjs`. |
| 061–070 uploads | No attach tool. Bytes would land in `src/capture/network.mjs` and `src/store/raw-log.mjs` only after a human upload during a recording. |
| 071–080 artifacts | No Studio surface. `src/studio/ui/chat.mjs` does not open ChatGPT canvases. |
| 081–090 projects and settings | No Studio route. `src/capture/chatgpt-chat-index.mjs` records `project.state = unknown`. |
| 091–094 offline, expiry, drift, stale | `src/capture/recorder.mjs` reconnect notes, `src/capture/conversation-runtime.mjs` thread fence, `src/store/session.mjs` `verify()`. |
| 095 reconnect | `src/studio/server.mjs` already running. `src/studio/tool-client.mjs` must reuse it. |
| 096 no resend | `src/capture/thread-turn-journal.mjs`, `src/studio/uncertain-step-reconciler.mjs`, `reconcile_conversation`. |
| 097 rate limit | No banner reader. Would be a DOM block from `src/capture/page-agent.js` if one were classified. |
| 098 timeout | `src/capture/actions.mjs` `waitForCompletion` only inside a drive. Studio path is the conversation runtime reply state. |
| 099–100 World | `src/capture/conversation-evidence.mjs`, `src/studio/world-service.mjs`, `src/studio/world-search.mjs`, `src/studio/world-relations.mjs`, `src/studio/world-url.mjs`, `src/studio/world-transfer.mjs`, `src/studio/ui/world-view.mjs`. Not called by either live run. |

## Live evidence already taken

| Objective | Command | Result |
|---|---|---|
| 021 first turn | `node bin/studio.mjs drive chatgpt --prompt "What is 17 plus 4? Reply with only the number." --timeout 90 --json` | Sent. Reply `ChatGPT said: 21`. Session `20261027-230222-chatgpt-2d22b0`. Thread `chatgpt-c:6ae12d8e-6fd4-83ed-b2ab-5b2244406292`. Tab closed after. |
| 022 follow-up | `node bin/studio.mjs drive "https://chatgpt.com/c/6ae12d8e-6fd4-83ed-b2ab-5b2244406292" --prompt "Add 3 to that number. Reply with only the number." --timeout 90 --json` | Did **not** open that thread. Log says `opening https://chatgpt.com/`. Baseline `Where should we begin?`, 0 prior user turns. New thread `chatgpt-c:6ae12dd7-406c-83eb-95fc-d6a178fba273`. Reply `24` is a fresh-chat answer, not continuity. Session `20261027-230337-chatgpt-591846`. |

Cause of the 022 miss: `bin/commands/drive.mjs` calls `getAdapter(ref)` first. A `chatgpt.com` URL matches the site adapter in `src/profiles/sites/chatgpt.mjs`, whose home URL is `https://chatgpt.com/`, so the `/c/<id>` path is dropped before `driveSite` opens a tab.

Fix (2026-10-28, source only, not yet re-run live):
- `bin/commands/drive.mjs` keeps a full URL's path on a copy of the matched adapter, so `/c/<id>` is the address opened. `--dry-run` prints the thread.
- `src/capture/actions.mjs` `driveSite` parses the expected thread once with `parseThread`. Before typing it requires the tab to be on exactly that `/c/<id>` with at least one rendered turn (`thread-not-open`, `thread-not-rendered`). After the reply it fails with `thread-changed` if the tab left the thread. The Studio drive API (`src/studio/drive-api.mjs`) already passed the URL and was refused as `not-a-new-chat`; it now takes the same thread path.
- `--reuse-tab` with a thread URL picks the tab already on that thread, otherwise opens one. A new chat's `threadRef` is polled for up to 10 s after the send, because ChatGPT moves from `/` to `/c/<id>` after the send, not at it.

022 and 023 need a live re-run to count as proven.

## 001–010 Account and live session

| # | Objective | Source |
|---|---|---|
| 001 | Account identity | No source. No account reader. |
| 002 | Authentication state | Partial. `src/capture/conversation-browser-adapter.mjs` auth-wall check only. |
| 003 | Native thread identity | `src/capture/conversation-thread.mjs` `parseThread`. `src/capture/conversation-runtime.mjs` connect. |
| 004 | Tab discovery | `src/studio/conversation-tools.mjs` `conversation_targets`. |
| 005 | Chrome-profile isolation | Partial. `src/config.mjs` `chromeProfile`, `src/chrome/launch.mjs`. |
| 006 | Page readiness | `src/capture/conversation-runtime.mjs` readiness. `src/capture/actions.mjs` `waitForComposer`. |
| 007 | Streaming state | Partial. `src/capture/actions.mjs` `waitForCompletion`, only while a drive is in progress. |
| 008 | Temporary Chat | No source. |
| 009 | Duplicate-title identity | Partial. `src/capture/chatgpt-chat-index.mjs` keys by `/c/` id, not title. |
| 010 | UI obstruction | No source. |

## 011–020 Navigation

| # | Objective | Source |
|---|---|---|
| 011 | New chat, no send | `create_conversation` in `src/studio/conversation-tools.mjs` → existing `src/capture/conversation-runtime.mjs` `connect` (`freshTab: true`), creates Studio-owned blank tab without send. |
| 012 | Sidebar by title | `src/capture/chatgpt-chat-index.mjs` reads rendered links. It does not click. |
| 013 | Deep link | `src/capture/conversation-thread.mjs`. `drive.mjs` URL form keeps the `/c/` path since 2026-10-28. |
| 014 | Cross-thread and return | Same as 004 + 013. No return command. |
| 015 | History search | No source. |
| 016 | Recent-thread recovery | No source beyond reopening a known `/c/` URL with `drive`. |
| 017 | Long-thread traversal | No source. |
| 018 | Scroll to latest | `src/capture/human.mjs` `humanScroll` exists. Nothing calls it for this objective. |
| 019 | Sidebar expansion | No source. |
| 020 | Archived history | No source. |

## 021–030 Conversation lifecycle

| # | Objective | Source |
|---|---|---|
| 021 | First turn | `bin/commands/drive.mjs` → `src/capture/actions.mjs` `driveSite`. Proven live. |
| 022 | Same-thread follow-up | `drive <https://chatgpt.com/c/id>` → `driveSite` thread path. Fixed in source 2026-10-28; not re-run live. |
| 023 | Long-range continuity | Same path as 022. Fixed in source; not re-run live. |
| 024 | Edit and branch | No source. |
| 025 | Regenerate | No source. |
| 026 | Interrupt generation | No source. |
| 027 | Continue generation | No source. |
| 028 | Branch from earlier turn | No source. |
| 029 | Rename | No source. |
| 030 | Archive | No source. |

## 031–040 Input controls

| # | Objective | Source |
|---|---|---|
| 031 | Multiline | `src/capture/actions.mjs` `typeText`, `src/capture/human.mjs` `humanType`. |
| 032 | Unicode | Same as 031. |
| 033 | Keyboard send | `src/capture/actions.mjs` `pressEnter` / `sendMessage`. |
| 034 | Newline without send | Not separated from 033. |
| 035 | Model selection | No source. |
| 036 | Temporary Chat | No source. |
| 037 | Speech input | No source. |
| 038 | Suggestion chips | No source. |
| 039 | Copy control | No source. |
| 040 | Feedback controls | No source. |

## 041–050 Answer shape

The current `src/capture/conversation-thread.mjs` now embeds `src/capture/conversation-rich.mjs` (`richPartReaderSource`, `boundRichParts`) in the existing `read_conversation` browser observation. Typed, bounded list/code/table/quote/link/citation-candidate/image/math parts can be emitted without a second controller. Coverage remains limited to rendered DOM and sanitizes URLs; citations are candidates, not paragraph/source identity proof.

| # | Objective | Source |
|---|---|---|
| 041–042 | Long answer, user vs assistant | `src/capture/actions.mjs` reply read. `src/capture/conversation-thread.mjs` `transcriptExpression`. `read_conversation` in `src/studio/conversation-tools.mjs`. |
| 043 | Lists | Partial: live read returns bounded `list-item` parts and depth via `src/capture/conversation-rich.mjs`; hierarchy may be incomplete. |
| 044 | Code fence | Partial: live read returns `code` language/text parts; structure clipped. |
| 045 | Table cells | Partial: live read returns row/cell structures, bounded to 24 rows/16 cells. |
| 046 | Math | Partial: `math` part, LaTeX only when observed. |
| 047 | Blockquote | Partial: `blockquote` part; attribution not guaranteed. |
| 048 | Link URL vs label | Partial: sanitized `href` alongside visible text; query/hash removed. |
| 049 | Citation anchor | Partial: `citation-candidate` part, not full inline source binding. |
| 050 | Inline image block | Partial: `image` part with alt/source presence, not downloadable content. |

## 051–060 Search and thinking

No source. `src/profiles/sites/chatgpt.mjs` has no search, source-card, thinking-mode, or Deep Research selectors.

| # | Objective |
|---|---|
| 051–060 | Search activation, source cards, citation navigation, tool panel, sourced vs unsourced, reasoning mode, reasoning completion, Deep Research entry, research job, research report |

## 061–070 Files and multimodal

No source. Nothing attaches a file, image, PDF, CSV, spreadsheet, or download.

| # | Objective |
|---|---|
| 061–070 | File picker, image, PDF, CSV, spreadsheet, source file, download, preview, image generation, upload failure |

## 071–080 Artifacts

No source. `src/capture/conversation-thread.mjs` marks project and custom-GPT URLs unverified. No canvas, chart, or code-copy control.

| # | Objective |
|---|---|
| 071–080 | Generated document, writing artifact, artifact edit, analysis provenance, tool failure, diagram, chart, input-output provenance, code copy, open attachment |

## 081–090 Projects and settings

No source. `src/capture/chatgpt-chat-index.mjs` sets `project.state` to `unknown` / `NOT_OBSERVED`.

| # | Objective |
|---|---|
| 081–090 | Create project, move conversation, unlink, read instructions, attach project file, project history, share discovery, revoke share, memory setting, custom instructions |

## 091–100 Truthfulness

| # | Objective | Source |
|---|---|---|
| 091 | Network loss | No source. |
| 092 | Session expiration | `src/capture/conversation-browser-adapter.mjs` auth wall. The selected thread is not preserved after it. |
| 093 | Target drift | `src/capture/conversation-runtime.mjs` `expectedThread`. `src/capture/drive-lease.mjs`. |
| 094 | Snapshot freshness | `src/capture/thread-turn-journal.mjs` boundary. No reload watcher. |
| 095 | Reconnect Studio | `bin/commands/tools.mjs` uses the existing server. It does not start a second browser. |
| 096 | No-resend reconciliation | `src/capture/thread-turn-journal.mjs`, `src/capture/conversation-runtime.mjs` uncertain phase, `src/studio/uncertain-step-reconciler.mjs`. |
| 097 | Rate limit | Partial: `src/capture/actions.mjs` `detectSiteFailure` recognizes some credit/usage errors; no complete banner classifier. |
| 098 | Timeout vs complete | `src/capture/actions.mjs` `waitForCompletion`, and `driveSite` now retains new tab plus marks `uncertain` for post-dispatch failures; no journal on legacy drive. |
| 099 | Capture into World | `src/capture/recorder.mjs`, `src/capture/conversation-evidence.mjs`, `src/studio/world-service.mjs`. |
| 100 | Reopen saved thread | `src/studio/world-service.mjs` plus `src/capture/conversation-thread.mjs`. |

## Runnable vs not

Real browser code exists for: 003, 004, 006, 011, 012 (read only), 013 (connect tool, not `drive` URL), 014 (discovery only), 021, 031, 032, 033, 041, 042 (plain text), 093, 095, 096, 098, 099, 100.

022 and 023 were blocked by `drive.mjs` discarding the `/c/` path. That is fixed in source; a live run is still needed.

The remaining objectives vary between absent live UI primitives, partial capture-only readers and unexposed controls. Never infer missing functionality without reviewing `src/capture/conversation-rich.mjs` and the adjacent dependency map; scenario-level status is in `CHATGPT-100-GAP-MAP.md`.

## 2026-10-28 — live-read control observation source correction (partial audit)

- Objectives **007 (streaming state)** and **041–042 (answer read)**: `src/capture/conversation-browser-adapter.mjs::readTranscript` now passes existing site-profile `assistant.streamingSelectors` and `send.buttonSelectors` into `src/capture/conversation-thread.mjs::transcriptExpression`. `boundTranscript` returns `controls: {state, observed, stopPresent, idleControlPresent, composerEnabled}` in addition to bounded rendered messages. State is `busy` on observed stop, `idle` on positive enabled composer + send control, otherwise `unknown`. This is **only an observed UI control state**, never evidence that the reply completed or the full transcript was captured.
- Existing Studio path: `read_conversation` → `conversation-runtime.read` → `conversation-browser-adapter.readTranscript` → `transcriptExpression` → `boundTranscript`. No new browser controller and no send on read.
- Regression coverage added in `test/unit/conversation-thread.test.mjs`. Focused GitHub workflow: `.github/workflows/chatgpt-100-focused.yml`, but its first jobs failed without recorded test steps; **automated pass is not established**.
- This checkpoint is **not a completed 100-scenario audit**. No other scenarios are promoted to supported or live-verified.

## Source audit reconciliation (2026-10-28)

Direct CLI/native path reviewed: `bin/studio.mjs` → `bin/commands/tools.mjs` → `src/studio/tool-client.mjs` → `src/studio/conversation-tools.mjs` / `src/studio/conversation-api.mjs` → `src/capture/conversation-runtime.mjs` → `src/capture/conversation-browser-adapter.mjs` → browser/CDP → `src/capture/recorder.mjs` / `src/store/session.mjs` → World. Newly discovered transitive rich reader: `src/capture/conversation-rich.mjs`. No live campaign was executed during this audit.

Fixed source: `src/capture/actions.mjs` marks legacy drive outcome uncertain and retains the created tab after a possible send without a verified completed response. `src/capture/conversation-thread.mjs` no longer lets a duplicate raw `controls` object overwrite the observed control-state derivation. Focused regression tests were added for drive; GitHub Actions workflow now includes these tests. Verification of all 100 against the live UI remains outstanding.

## 2026-10-28 — complete 001–100 source-level reconciliation (supersedes older blanket “no source” statements)

Coverage: all 3 maps and **132/132** distinct explicitly named source/config files fetched and inspected; **40 additional transitive/adjacent source files** opened (172 total). Imports and relevant registration/call paths were examined; this is a **source-level** ledger, not proof of browser support. New files introduced by concurrent commits, including `src/capture/conversation-rich.mjs`, were read separately. Earlier historical claims of “no extractor” are superseded: `src/capture/page-agent.js::blocks` already existed, and a newer bounded `src/capture/conversation-rich.mjs` implementation exposes candidate parts in live read. Existing file infrastructure `src/studio/agentic-files.mjs` does **not** attach files to ChatGPT.

| # | Actual user objective | Status | Existing implementation / dependency | First missing link or fixed defect | Verification |
|---|---|---|---|---|---|
| 001 | Account identity | unsupported | `src/capture/conversation-browser-adapter.mjs` | Auth-wall check only; no signed-in account identity reader | source-reviewed; not live verified |
| 002 | Authentication state | partial | `src/capture/conversation-browser-adapter.mjs` | Auth-wall detection; no full account/auth-state classifier | source-reviewed; not live verified |
| 003 | Native thread identity | supported | `src/capture/conversation-thread.mjs`; ` src/capture/conversation-runtime.mjs` | Exact /c/UUID thread parser; other ChatGPT routes unverified | source-reviewed; not live verified |
| 004 | Tab discovery | supported | `src/capture/conversation-runtime.mjs::targets`; ` src/cdp/discovery.mjs` | Target metadata and site classification, not account truth | source-reviewed; not live verified |
| 005 | Chrome-profile isolation | partial | `src/config.mjs`; ` src/chrome/browser-ownership.mjs`; ` src/chrome/launch.mjs` | Dedicated profile path and owner checks; no live profile attestation | source-reviewed; not live verified |
| 006 | Page readiness | partial | `src/capture/conversation-browser-adapter.mjs::readiness` | Positive composer/control check; loading/auth modal variants unverified | source-reviewed; not live verified |
| 007 | Streaming state | partial | `src/capture/conversation-thread.mjs::transcriptExpression`; ` src/profiles/sites/chatgpt.mjs` | Busy/idle/unknown from observed controls; no terminal-generation proof | source-reviewed; not live verified |
| 008 | Ephemeral chat awareness | unsupported | `src/capture/conversation-browser-adapter.mjs`; ` src/capture/conversation-thread.mjs` | Missing account/temporary-chat/modal-specific reader or complete observed state | source-reviewed; not live verified |
| 009 | Duplicate-title identity | partial | `src/capture/chatgpt-chat-index.mjs`; ` src/capture/conversation-thread.mjs` | Thread key uses UUID rather than title; duplicate-title navigation absent | source-reviewed; not live verified |
| 010 | UI obstruction recognition | unsupported | `src/capture/conversation-browser-adapter.mjs`; ` src/capture/conversation-thread.mjs` | Missing account/temporary-chat/modal-specific reader or complete observed state | source-reviewed; not live verified |
| 011 | New-chat navigation | supported | `src/studio/conversation-tools.mjs::create_conversation`; ` src/studio/conversation-api.mjs`; ` src/recipes/catalog.mjs`; ` src/capture/conversation-runtime.mjs::connect` | Fixed: create fresh Studio-owned NEW_CHAT without send using existing runtime | source-reviewed; 16 isolated assertions |
| 012 | Sidebar history selection | partial | `src/capture/chatgpt-chat-index-reader.mjs` | Sidebar rendered links read-only; no title selection/click | source-reviewed; not live verified |
| 013 | Deep-link navigation | partial | `bin/commands/drive.mjs`; ` src/capture/conversation-thread.mjs` | Exact URL preserved by drive; no generic Studio-owned navigate-to-link | source-reviewed; not live verified |
| 014 | Cross-thread navigation | partial | `src/capture/conversation-runtime.mjs::targets`; ` src/studio/conversation-tools.mjs` | Find/connect exact thread; no return-to-previous-tab primitive | source-reviewed; not live verified |
| 015 | Native history search | unsupported | `src/capture/chatgpt-chat-index-reader.mjs`; ` src/capture/conversation-runtime.mjs` | No exposed history navigation/search/scroll primitive | source-reviewed; not live verified |
| 016 | Recent-thread recovery | partial | `bin/commands/drive.mjs`; ` src/studio/world-service.mjs` | Reopen known /c/ URL; no 'latest thread' recovery selection | source-reviewed; not live verified |
| 017 | Long-thread traversal | unsupported | `src/capture/chatgpt-chat-index-reader.mjs`; ` src/capture/conversation-runtime.mjs` | No exposed history navigation/search/scroll primitive | source-reviewed; not live verified |
| 018 | Scroll-to-latest | partial | `src/capture/human.mjs::humanScroll` | Scroll helper exists but no owner-bound scroll tool | source-reviewed; not live verified |
| 019 | Sidebar expansion | unsupported | `src/capture/chatgpt-chat-index-reader.mjs`; ` src/capture/conversation-runtime.mjs` | No exposed history navigation/search/scroll primitive | source-reviewed; not live verified |
| 020 | Archived-history navigation | unsupported | `src/capture/chatgpt-chat-index-reader.mjs`; ` src/capture/conversation-runtime.mjs` | No exposed history navigation/search/scroll primitive | source-reviewed; not live verified |
| 021 | First-turn delivery | supported | `src/studio/conversation-tools.mjs`; ` src/capture/conversation-runtime.mjs::submit`; ` src/capture/recorder.mjs` | Prior live one-shot through drive; Studio capture/send path exists; no new live run | source-reviewed; previous one-shot live evidence only |
| 022 | Same-thread follow-up | partial | `src/capture/conversation-runtime.mjs`; ` src/capture/thread-turn-journal.mjs`; ` bin/commands/drive.mjs` | Expected-thread journal present; deep-link bug source-fixed; continuity not rerun live | source-reviewed; not live verified |
| 023 | Long-range thread continuity | partial | `src/capture/conversation-runtime.mjs`; ` src/capture/thread-turn-journal.mjs` | Long-range contextual continuity requires a genuine same-thread live proof | source-reviewed; not live verified |
| 024 | Message edit and branch awareness | unsupported | `src/capture/conversation-runtime.mjs`; ` src/capture/actions.mjs`; ` src/capture/thread-turn-journal.mjs` | Lifecycle controls other than keyed send are unexposed | source-reviewed; not live verified |
| 025 | Response regeneration | unsupported | `src/capture/conversation-runtime.mjs`; ` src/capture/actions.mjs`; ` src/capture/thread-turn-journal.mjs` | Lifecycle controls other than keyed send are unexposed | source-reviewed; not live verified |
| 026 | Interrupt generation | unsupported | `src/capture/conversation-runtime.mjs`; ` src/capture/actions.mjs`; ` src/capture/thread-turn-journal.mjs` | Lifecycle controls other than keyed send are unexposed | source-reviewed; not live verified |
| 027 | Generation continuation | unsupported | `src/capture/conversation-runtime.mjs`; ` src/capture/actions.mjs`; ` src/capture/thread-turn-journal.mjs` | Lifecycle controls other than keyed send are unexposed | source-reviewed; not live verified |
| 028 | Conversation branching | unsupported | `src/capture/conversation-runtime.mjs`; ` src/capture/actions.mjs`; ` src/capture/thread-turn-journal.mjs` | Lifecycle controls other than keyed send are unexposed | source-reviewed; not live verified |
| 029 | Conversation rename | unsupported | `src/capture/conversation-runtime.mjs`; ` src/capture/actions.mjs`; ` src/capture/thread-turn-journal.mjs` | Lifecycle controls other than keyed send are unexposed | source-reviewed; not live verified |
| 030 | Archive mutation | unsupported | `src/capture/conversation-runtime.mjs`; ` src/capture/actions.mjs`; ` src/capture/thread-turn-journal.mjs` | Lifecycle controls other than keyed send are unexposed | source-reviewed; not live verified |
| 031 | Multiline payload fidelity | partial | `src/capture/actions.mjs::typeText`; ` src/capture/human.mjs` | Typing exists; multiline preservation not individually live-verified | source-reviewed; not live verified |
| 032 | Unicode editing | partial | `src/capture/actions.mjs::typeText`; ` src/capture/human.mjs` | Typing exists; mixed RTL/Unicode not individually live-verified | source-reviewed; not live verified |
| 033 | Keyboard send action | partial | `src/capture/actions.mjs::pressEnter`; ` src/capture/human.mjs` | Enter path present; no separate agent-facing keyboard-send tool | source-reviewed; not live verified |
| 034 | Keyboard newline action | unsupported | `src/capture/actions.mjs`; ` src/profiles/sites/chatgpt.mjs` | No verified named control for model, keyboard newline, voice, copy, feedback | source-reviewed; not live verified |
| 035 | Model selection | unsupported | `src/capture/actions.mjs`; ` src/profiles/sites/chatgpt.mjs` | No verified named control for model, keyboard newline, voice, copy, feedback | source-reviewed; not live verified |
| 036 | Temporary Chat activation | unsupported | `src/capture/actions.mjs`; ` src/profiles/sites/chatgpt.mjs` | No verified named control for model, keyboard newline, voice, copy, feedback | source-reviewed; not live verified |
| 037 | Speech input | unsupported | `src/capture/actions.mjs`; ` src/profiles/sites/chatgpt.mjs` | No verified named control for model, keyboard newline, voice, copy, feedback | source-reviewed; not live verified |
| 038 | Suggestion-chip interaction | unsupported | `src/capture/actions.mjs`; ` src/profiles/sites/chatgpt.mjs` | No verified named control for model, keyboard newline, voice, copy, feedback | source-reviewed; not live verified |
| 039 | Copy action | unsupported | `src/capture/actions.mjs`; ` src/profiles/sites/chatgpt.mjs` | No verified named control for model, keyboard newline, voice, copy, feedback | source-reviewed; not live verified |
| 040 | Feedback UI discovery | unsupported | `src/capture/actions.mjs`; ` src/profiles/sites/chatgpt.mjs` | No verified named control for model, keyboard newline, voice, copy, feedback | source-reviewed; not live verified |
| 041 | Long-answer extraction | partial | `src/capture/conversation-thread.mjs::boundTranscript`; ` src/capture/conversation-rich.mjs` | Bounded page-visible read; long virtualized thread incomplete | source-reviewed; not live verified |
| 042 | Role attribution | partial | `src/capture/conversation-thread.mjs::transcriptExpression`; ` src/capture/page-agent.js::turns` | Role-labelled rendered text; ambiguous/nested turns can be omitted | source-reviewed; not live verified |
| 043 | List structure | partial | `src/capture/conversation-rich.mjs::richPartReaderSource`; ` src/capture/page-agent.js::blocks` | List items observed, complete nesting/virtualization unproven | source-reviewed; not live verified |
| 044 | Code block fidelity | partial | `src/capture/conversation-rich.mjs::richPartReaderSource`; ` src/capture/page-agent.js::blocks` | Code/language candidates observed, full copy fidelity unproven | source-reviewed; not live verified |
| 045 | Table semantics | partial | `src/capture/conversation-rich.mjs::richPartReaderSource`; ` src/capture/page-agent.js::blocks` | Table header/cell candidates observed, complex spans unverified | source-reviewed; not live verified |
| 046 | Math fidelity | partial | `src/capture/conversation-rich.mjs::richPartReaderSource`; ` src/capture/page-agent.js::blocks` | Math tags observed only when rendered, fidelity unverified | source-reviewed; not live verified |
| 047 | Quotation structure | partial | `src/capture/conversation-rich.mjs::richPartReaderSource`; ` src/capture/page-agent.js::blocks` | Quotation block typed; attribution not always represented | source-reviewed; not live verified |
| 048 | Hyperlink extraction | partial | `src/capture/conversation-rich.mjs::richPartReaderSource`; ` src/capture/dom.mjs::scrubBlocks` | Observed links sanitized, full source semantics unverified | source-reviewed; not live verified |
| 049 | Citation anchoring | partial | `src/capture/conversation-rich.mjs::richPartReaderSource`; ` src/capture/page-agent.js::inlines` | Citation is candidate, not independently source-confirmed | source-reviewed; not live verified |
| 050 | Image-block extraction | partial | `src/capture/conversation-rich.mjs::richPartReaderSource`; ` src/capture/page-agent.js::blocks` | Image presence/alt observed; media provenance/completeness unverified | source-reviewed; not live verified |
| 051 | Search-tool activation | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 052 | Source card reading | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 053 | Citation-source navigation | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 054 | Tool-panel expansion | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 055 | Evidence presence | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 056 | Reasoning mode awareness | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 057 | Reasoning completion | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 058 | Deep Research discovery | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 059 | Research job monitoring | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 060 | Research report navigation | unsupported | `src/capture/network.mjs`; ` src/profiles/stream-map.mjs` | Observed transport only: no ChatGPT search/thinking/research activation or job controls | source-reviewed; not live verified |
| 061 | File-picker input | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 062 | Vision-file submission | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 063 | PDF interpretation | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 064 | Tabular file analysis | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 065 | Spreadsheet rendering | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 066 | Source-file input | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 067 | File download | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 068 | Attachment preview | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 069 | Image generation result | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 070 | Upload failure detection | unsupported | `src/studio/agentic-files.mjs`; ` src/capture/network.mjs` | Agentic file library is NOT a native ChatGPT attachment/download control | source-reviewed; not live verified |
| 071 | Generated-document controls | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 072 | Writing-artifact surface | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 073 | Artifact edit | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 074 | Data-analysis execution provenance | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 075 | Tool failure detection | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 076 | Diagram artifact recognition | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 077 | Chart semantics | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 078 | Input-output provenance | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 079 | Code copying | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 080 | Artifact-open navigation | unsupported | `src/capture/page-agent.js`; ` src/studio/ui/world-view.mjs` | Generic page shapes exist; artifact-specific controls/navigation unexposed | source-reviewed; not live verified |
| 081 | Project creation | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 082 | Conversation-to-Project move | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 083 | Project unlink | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 084 | Project instructions read | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 085 | Project file attachment | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 086 | Project-specific history | partial | `src/capture/chatgpt-chat-index.mjs` | Project state unknown; candidate index does not support project-native history navigation | source-reviewed; not live verified |
| 087 | Sharing control discovery | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 088 | Share-link revocation | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 089 | Memory setting inspection | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 090 | Personalization settings discovery | unsupported | `src/capture/chatgpt-chat-index.mjs`; ` src/studio/conversation-tools.mjs` | No Projects/sharing/settings UI primitive; project identity unknown | source-reviewed; not live verified |
| 091 | Network loss detection | partial | `src/capture/recorder.mjs` | Reconnect notes; no complete offline/online state or safe resumed-send proof | source-reviewed; not live verified |
| 092 | Session expiration | partial | `src/capture/conversation-browser-adapter.mjs::detectAuthWall` | Auth-wall partial detection; login restoration not implemented | source-reviewed; not live verified |
| 093 | Target drift | supported | `src/capture/conversation-runtime.mjs`; ` src/capture/drive-lease.mjs` | Exact-thread fence blocks known target drift before send | source-reviewed; not live verified |
| 094 | Snapshot freshness | partial | `src/capture/thread-turn-journal.mjs` | Boundary journal exists; no global reload freshness watcher | source-reviewed; not live verified |
| 095 | Runtime reconnection | supported | `bin/commands/tools.mjs`; ` src/studio/tool-client.mjs` | Reuse already-running same-owner Studio; never starts second browser | source-reviewed; not live verified |
| 096 | No-resend reconciliation | supported | `src/capture/thread-turn-journal.mjs`; ` src/studio/uncertain-step-reconciler.mjs` | No-resend fence and read-only uncertainty reconciliation | source-reviewed; not live verified |
| 097 | Rate-limit detection | unsupported | `src/capture/page-agent.js` | No rate-limit banner classifier or terminal capture proof | source-reviewed; not live verified |
| 098 | Timeout truthfulness | partial | `src/capture/actions.mjs`; ` src/capture/conversation-runtime.mjs` | Timed-out vs reply-ready states tracked; live timeout disposition unverified | source-reviewed; not live verified |
| 099 | Capture provenance | partial | `src/capture/recorder.mjs`; ` src/capture/conversation-evidence.mjs`; ` src/studio/world-service.mjs` | Saved capture/World pipeline exists; end-to-end replay not live proven | source-reviewed; not live verified |
| 100 | Return-to-source continuity | partial | `src/studio/world-service.mjs`; ` src/capture/conversation-thread.mjs` | Saved source URL/read path exists; World-to-exact-thread revisit unverified | source-reviewed; not live verified |

**Status interpretation:** Supported means source-level capability with an executable path, not end-to-end acceptance; partial means an observed or reusable primitive exists but the full user outcome cannot be verified. Unsupported is blocked for this source-only pass by absent named native UI primitive and absent live ChatGPT/CDP evidence, not a finding that the website itself lacks the feature. Historical one-shot 021 live evidence does not prove Studio continuity 022–023. Do not convert source review, isolated JS assertions, or committed fixtures into `node --test` passes or new live verification.

**Fixed here:** 011 `create_conversation` native tool + `conversation.create` recipe + `POST /api/v1/conversations/create`; 043–050 capture privacy for filtered-mode structured URL fields in `src/capture/dom.mjs`. A separate concurrent commit added `conversation-rich.mjs` for candidate structured live reads. Reevaluate runtime/HTTP tests and new fixture tests in a real Node environment before claiming regression-free release. No 100-scenario live campaign was launched.

## Complete 001–100 status ledger (2026-10-28 source audit)

The companion [100-scenario audit ledger](CHATGPT-100-AUDIT-LEDGER-2026-10-28.md) records each scenario's actual source/dependency entry, classification, first missing UI/runtime link, code fix and verification level. **All 100 scenario statuses were reconciled as 6 source-supported, 43 partial and 51 unsupported; no blanket "64 unsupported" count is current.** Source-supported means a specific native path exists; only the original 021 drive receipt has historic live evidence. No 100-case live run occurred here.

**Implemented source fixes:** `src/capture/conversation-rich.mjs::richPartReaderSource/boundRichParts` is called by `src/capture/conversation-thread.mjs::transcriptExpression/boundTranscript` for bounded, typed, read-only message parts (lists, code, table cells, math, quotes, sanitized links, citation candidates, image metadata) on scenarios 041–050. `boundTranscript` also returns positive-observation UI controls for 007. The same existing Studio/recorder/CDP owner remains authoritative; these patches do not support uploads, native artifact editing, citation attribution or historical full-scroll capture. Focused source assertions passed; Node/CI pass and live UI evidence are **not established**.

**Coverage honesty:** all 132 mapped code/configuration paths fetched and inspected at import/export level plus 12 adjacent transitive modules; complete semantic review of all file bodies and recursive callers is **not established**. The source audit remains incomplete pending action on missing native UI primitives and reliable automated verification.

## 2026-10-28 individual source reconciliation

- The full source-availability table for **every objective 001–100** is now in `CHATGPT-100-GAP-MAP.md`; statuses count 13 source-supported, 32 partial, 55 unsupported at the audit snapshot. **Source-supported is not live-verified.** No new live ChatGPT scenarios were executed.
- The direct `read_conversation` route now projects bounded typed DOM parts from `src/capture/conversation-rich.mjs` through `src/capture/conversation-thread.mjs:transcriptExpression` and `boundTranscript`. It returns list items, code blocks, tables, math, blockquotes, sanitized links, citation candidates and image presence from **currently rendered content**, with omission/truncation indicators. This is **partial source availability** for 043–050, not a promise of full-document extraction or native artifact control.
- A separate saved-capture route, `src/studio/integration-hub.mjs` `GET /sessions/{session}/observation`, calls `src/shapes/observation.mjs:observeSession` / `buildObservation` for typed network/DOM evidence and provenance. It is not the same as live ChatGPT UI interaction.
- The current tool registry `src/studio/conversation-tools.mjs` includes `create_conversation` and `conversation_capsule`, beyond the older enumerated list above. `create_conversation` uses the existing Studio runtime owner and does **not** send automatically.
- Do **not** misclassify `src/profiles/model-ops.mjs`: its model operation is editing Capture's **data model**, not selecting a ChatGPT model (#035). `src/studio/agentic-files.mjs` is a read-only local instruction-file inventory, not a ChatGPT file-picker or upload (#061–070).
- Mapped file retrieval: **132/132** explicitly referenced source/config files fetched in full, with **24 additional transitive imports** and the new rich reader inspected separately. Remaining recursive dependency edges and full live scenario verification are open.
- Focused GitHub Actions workflow jobs were reported failed **before recording steps**; no passing repository Node test run has been verified in this audit.
