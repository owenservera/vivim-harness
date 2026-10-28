# ChatGPT 100 — blank-space and missing-capability map

## 2026-10-28 gap reconciliation

**Latest-main correction:** `src/capture/conversation-rich.mjs` is wired into `src/capture/conversation-thread.mjs` for bounded read-only DOM parts. Objectives **043–048 and 050** are now **partial** in the [matrix](CHATGPT-100-RECONCILED-STATUS.md), not unsupported; citation anchoring **049** remains unsupported. This is synthetic/source evidence, **not live provider verification**.

The [001–100 objective matrix](CHATGPT-100-RECONCILED-STATUS.md) supersedes any blanket “no source” classification that overlooks newly exposed existing controls. Current source-level rollup is **10 supported / 29 partial / 61 unsupported**; no new live or automated execution proof was obtained in this pass. The added [101–200 roadmap objectives](CHATGPT-200-ROADMAP-OBJECTIVES.md) are unverified future user goals.

- **Closed: capability visibility through named tools** — `conversation_capsule` delegates read-only to the already implemented runtime capsule. The `conversation.capabilities` recipe is one native command; its result is advisory and never bypasses effect-time gates. Unit-test changes were authored, not run here.
- **Corrected: blank new conversation** — `create_conversation` exists on updated `main` and delegates to the existing Studio browser owner. Do not recreate this primitive. It does not prove native thread identity until `/c/<uuid>` is observed.
- **Still open:** account identity; native navigation/search/settings/model/upload/artifact controls; structured ChatGPT block extraction; broad history coverage; positive delivery proof after uncertain sends; live capture-to-World acceptance. Generic shape, file-inventory and export code must not be mistaken for provider-native browser actions.


Generated 2026-10-28. Companion to `CHATGPT-100-SOURCE-MAP.md` and `CHATGPT-100-DEPENDENCY-MAP.md`.

## Partial gap closures (2026-10-28)

- **003 identity provenance:** fixed source-level cross-origin identity claim, using the canonical ChatGPT parser. It does not read signed-in account identity or establish browser availability.
- **041 / 098 live reply-text events:** fixed same-length edits past the capped SSE text boundary being suppressed. Wire text remains bounded; full page/structured answer extraction and terminal delivery verification are separate gaps.
- Regression tests added in source but are **not marked executed or live-verified** here. All remaining gaps below are open pending broader read/implementation and actual verification.

## Why this file exists
The source map says **where current behavior lives**. The dependency map asks **what other existing code could affect it**. This third map explains the **blank space between a real ChatGPT user action and an exposed, verifiable harness capability**. A missing entry is not proof the functionality is impossible: it may be unimplemented, implemented but unexposed, not discovered, or only partly observable.

## Gap taxonomy
- **Missing primitive** — no browser action or reader for the required UI.
- **Unexposed primitive** — underlying implementation exists but CLI/native API does not expose it.
- **Missing orchestration** — actions exist but cannot complete a full user workflow or preserve context.
- **Missing evidence** — an action works but cannot be verified from captured structured results.
- **Missing recovery** — timeout, drift, interruption, auth or uncertainty cannot be reconciled safely.
- **Unknown until dependency review** — primary map says “no source” but adjacent modules might implement it.

## The blank spaces

| Scenarios | User capability | Why gap exists / present evidence | Likely ownership to investigate | Required closure evidence |
|---|---|---|---|---|
| 001–010 | Account identity, temporary chat, obstructions | Primary map reports no account reader, temporary-chat or modal control; auth-wall detection is partial | `src/capture/conversation-browser-adapter.mjs`, site profile, Studio capabilities | Read account/auth state; safely detect/dismiss obstruction; temporary chat state verified |
| 011–020 | History search, scroll, archive, navigation | Index can read links but lacks corresponding UI navigation/search controls | chat index, conversation service, browser adapter, `src/capture/human.mjs` | Open exact intended thread, search and navigate with stable thread identity |
| 021–030 | Edit, regenerate, stop, rename, archive | First-turn and follow-up exist; lifecycle UI controls not mapped | conversation runtime, adapter, recipe routes | Actual mutation with before/after thread/turn evidence |
| 031–040 | Newline, model, voice, chips, copy, feedback | Typing/Enter available; discrete control actions not mapped | site selectors, `src/profiles/model-ops.mjs`, Studio commands | Individual named tool per supported control; observable outcome |
| 041–050 | Structured answer extraction | Visible text is read; lists/code/tables/math/citations/images not mapped as structured blocks | `src/shapes/*`, `src/replay/stream-components.mjs`, page agent | Typed content with links, cell values, block provenance and no silent flattening |
| 051–060 | Search, thinking, research | Primary map reports no UI selectors/tool controls for these modes | profile stream-map, model ops, adapter probes | Activate/read mode and record real tool/search/research status |
| 061–070 | Uploads and downloads | No exposed attach/download tool in primary map | `src/studio/agentic-files.mjs`, capture, security | User file attachment and download through existing browser owner with receipts |
| 071–080 | Canvas, artifacts, chart/code controls | No mapped artifact surface; text-only capture is insufficient | shapes, replay, Studio UI, browser adapter | Detect/open/read/operate artifact, preserving type and provenance |
| 081–090 | Projects, shares, settings | No mapped routes; project index state unknown | conversation service, index, Studio commands | Read current state and apply safe requested action with verification |
| 091–100 | Offline, expiry, rate limits, reconciliation, World | Some safeguards exist; banner reader, reload freshness and complete recovery missing | browser ownership, runtime, event feed, store, World service | No wrong-thread send, no silent resend, explicit terminal state and reopened World record |

## Why the gap matters
A CLI response saying “done” is not proof a user action worked. For each scenario, trace **intent → tool → browser effect → observed state → captured evidence → persistent session → recoverable result**. Identify the first missing link. Fix the shared link once rather than adding 100 one-off scripts.

## Gap resolution workflow
For each objective 001–100, maintain:
- **Classification:** supported / partial / unsupported / unknown.
- **Reason:** one of the gap types above, with concrete file and function evidence.
- **Existing reusable code:** exact path/function discovered in dependency review.
- **Smallest fix:** primitive, exposure, orchestration, evidence or recovery.
- **Verification:** source review, focused automated test, or live verified (never conflate).
- **Status:** open / fixed in source / tested / live verified / blocked.

Do not fabricate completion, selectors or browser evidence. Do not implement a second browser controller, Playwright or Puppeteer. Prefer existing Studio owner and agent-friendly named tools.

## Review questions
1. Does “no source” mean genuinely absent, or merely absent from the original map?
2. Why does the feature exist elsewhere in the repo but not in the Studio tool surface?
3. Which missing shared primitive would unlock the most objectives?
4. Can a user complete the action in three or fewer agent-friendly commands?
5. Does a result retain thread identity, evidence and recoverability?

## 2026-10-28 — partial gap closure: observed streaming/idle controls

| Scenarios | Classification | Concrete source fix | Evidence level and remaining blocker |
|---|---|---|---|
| 007 | Partial | Site-profile stop/send selectors are now supplied to read-only `transcriptExpression`; `boundTranscript` exposes `busy / idle / unknown` from positive UI controls | Source-reviewed, fixture unit assertions committed but not demonstrated passing; no live streaming transition or network-terminal proof |
| 041–042 | Partial | `read_conversation` now retains both bounded role-labelled visible text and non-mutating UI-control observation | Source-reviewed; transcript remains page-visible/incomplete, not a fully attributed persisted rich reply |

**CI blocker:** the new focused GitHub Actions job reported failure without recorded steps and no downloadable job log. Treat verification as blocked pending a runnable test environment, not as a passing or conclusively failing unit test. All other scenario capability gaps listed above remain unclosed.

## 001–100 individual reconciliation — 2026-10-28

Source-reviewed classification reconciled against `CHATGPT-100-RECONCILED-STATUS.md` (10 supported / 29 partial / 61 unsupported) after source inspection, including later concurrent additions beyond the initial 132-path tree. **Supported/partial describes code availability, NOT 100 live scenario passes.** `source` means source reviewed, `isolated` is non-browser behavioral testing in this audit, and `historical-live` is a previously recorded probe, not a new live run. Open gaps are blocked on the named missing UI primitives, end-to-end integration, or actual local Chrome access. No simulated browser success is claimed.

| # | User objective | Implementation / dependency | Source status | Remaining concrete gap / improvement | Verification |
|---|---|---|---|---|---|
| 001 | Account identity | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | unsupported | Account reader absent; no credentials needed | source |
| 002 | Authentication state | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | partial | Auth wall, not complete auth state | source |
| 003 | Native thread identity | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | supported | Bound /c/ thread parse; active-tab proof incomplete | source |
| 004 | Tab discovery | `src/studio/conversation-tools.mjs` (`conversation_targets`) | supported | `conversation_targets` target metadata | source |
| 005 | Chrome-profile isolation | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | partial | Dedicated profile marker; account identity unproven | source |
| 006 | Page readiness | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | partial | Composer readiness; obstructions incomplete | source |
| 007 | Streaming state | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | partial | Control-state observer; progress certainty bounded | source |
| 008 | Ephemeral chat awareness | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | unsupported | Temporary Chat state detection absent | source |
| 009 | Duplicate-title identity | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | partial | Index keyed by /c/ not title; candidates unverified | source |
| 010 | UI obstruction recognition | `src/capture/conversation-browser-adapter.mjs`; `src/chrome/browser-ownership.mjs` | partial | Auth wall exists; modal taxonomy missing | source |
| 011 | New-chat navigation | `src/studio/conversation-tools.mjs` (`create_conversation`) → `src/capture/conversation-runtime.mjs` | supported | `create_conversation` creates a Studio-owned blank chat; no send | source |
| 012 | Sidebar history selection | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | partial | Read rendered title candidates; no click-to-open tool | source |
| 013 | Deep-link navigation | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | supported | `drive` deep-link + connect with exact-thread fence; no standalone open action | source |
| 014 | Cross-thread navigation | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | partial | Targets + exact connect; no return-stack primitive | source |
| 015 | Native history search | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | unsupported | ChatGPT native history-search tool absent | source |
| 016 | Recent-thread recovery | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | partial | Known /c/ can reopen; no last-thread recovery tool | source |
| 017 | Long-thread traversal | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | unsupported | Offscreen historical turn traversal absent | source |
| 018 | Scroll-to-latest | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | partial | `humanScroll` exists, no named Studio action | source |
| 019 | Sidebar expansion | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | unsupported | Sidebar expansion primitive absent | source |
| 020 | Archived-history navigation | `src/studio/conversation-tools.mjs`; `src/capture/chatgpt-chat-index.mjs`; `src/capture/human.mjs` | unsupported | Archived-history native reader absent | source |
| 021 | First-turn delivery | `bin/commands/drive.mjs` → `src/capture/actions.mjs` | supported | First turn in `drive`; create+submit path is wired; historical live evidence only | source; historical-live first turn |
| 022 | Same-thread follow-up | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | partial | Exact /c/ drive and bound submit; follow-up live proof pending | source |
| 023 | Long-range thread continuity | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | partial | Bound turns support continuity; long-range live proof pending | source |
| 024 | Message edit and branch awareness | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | unsupported | Message edit/branch primitive absent | source |
| 025 | Response regeneration | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | unsupported | Regenerate control absent | source |
| 026 | Interrupt generation | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | unsupported | Stop generation control absent | source |
| 027 | Generation continuation | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | unsupported | Continue generation control absent | source |
| 028 | Conversation branching | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | unsupported | Branch-at-turn action absent | source |
| 029 | Conversation rename | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | unsupported | Rename mutation absent | source |
| 030 | Archive mutation | `src/capture/conversation-runtime.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | unsupported | Archive mutation absent | source |
| 031 | Multiline payload fidelity | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | supported | `typeText` multiline; blank-line fidelity unproven | source |
| 032 | Unicode editing | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | supported | Unicode typing; visual fidelity unproven | source |
| 033 | Keyboard send action | `src/capture/actions.mjs` (`pressEnter`, `sendMessage`) | supported | `sendMessage` Enter dispatch available | source |
| 034 | Keyboard newline action | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | unsupported | Composer newline-without-send primitive absent | source |
| 035 | Model selection | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | partial | Profile model changes do not operate native model chooser | source |
| 036 | Temporary Chat activation | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | unsupported | Temporary-chat activation primitive absent | source |
| 037 | Speech input | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | unsupported | Microphone and permission interface absent | source |
| 038 | Suggestion-chip interaction | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | unsupported | Suggestion-chip reader/click absent | source |
| 039 | Copy action | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | unsupported | Native Copy control absent | source |
| 040 | Feedback UI discovery | `src/capture/actions.mjs`; `src/profiles/sites/chatgpt.mjs`; `src/profiles/model-ops.mjs` | unsupported | Feedback UI inspection absent | source |
| 041 | Long-answer extraction | `src/capture/conversation-thread.mjs`; `src/capture/conversation-rich.mjs`; `src/capture/page-agent.js` | partial | Rendered text bounded; offscreen answer remains unproven | source |
| 042 | Role attribution | `src/capture/conversation-thread.mjs`; `src/capture/conversation-rich.mjs`; `src/capture/page-agent.js` | partial | Role-labelled DOM transcript; partial coverage | source |
| 043 | List structure | `src/capture/conversation-rich.mjs` (`richPartReaderSource`, `boundRichParts`) | unsupported | `conversation-rich` returns list depth/items; rendered-only | source |
| 044 | Code block fidelity | `src/capture/conversation-rich.mjs` | unsupported | `conversation-rich` code language/text; clipped | source |
| 045 | Table semantics | `src/capture/conversation-rich.mjs` | unsupported | `conversation-rich` table rows and cells; bounded | source |
| 046 | Math fidelity | `src/capture/conversation-rich.mjs` | unsupported | `conversation-rich` math with LaTeX when available | source |
| 047 | Quotation structure | `src/capture/conversation-rich.mjs` | unsupported | `conversation-rich` blockquote text; attribution weak | source |
| 048 | Hyperlink extraction | `src/capture/conversation-rich.mjs` | unsupported | Sanitized link href/label; query/fragment removed | source |
| 049 | Citation anchoring | `src/capture/conversation-rich.mjs` | unsupported | Citation candidate extracted; passage-source anchor missing | source |
| 050 | Image-block extraction | `src/capture/conversation-rich.mjs` | unsupported | Image block with alt/source presence, no bytes | source |
| 051 | Search-tool activation | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Network stream may show search; no search-tool activation proof | source |
| 052 | Source card reading | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Source-card metadata reader absent | source |
| 053 | Citation-source navigation | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Citation-source native open absent | source |
| 054 | Tool-panel expansion | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Tool/status panel expansion absent | source |
| 055 | Evidence presence | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Stream/DOM hints partial; sourced/unsourced distinction uncertain | source |
| 056 | Reasoning mode awareness | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Thinking mode selector absent | source |
| 057 | Reasoning completion | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Streaming state observed; reasoning terminal state uncertain | source |
| 058 | Deep Research discovery | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Deep Research entrypoint discovery absent | source |
| 059 | Research job monitoring | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Research job state reader absent | source |
| 060 | Research report navigation | `src/profiles/stream-map.mjs`; `src/capture/network.mjs`; `src/studio/conversation-tools.mjs` | unsupported | Research report sections/navigation absent | source |
| 061 | File-picker input | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No browser file-picker attach primitive | source |
| 062 | Vision-file submission | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No image attach primitive | source |
| 063 | PDF interpretation | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No PDF attach primitive | source |
| 064 | Tabular file analysis | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No CSV attach primitive | source |
| 065 | Spreadsheet rendering | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No spreadsheet attach primitive | source |
| 066 | Source-file input | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No source file attach primitive | source |
| 067 | File download | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No ChatGPT native download operation | source |
| 068 | Attachment preview | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No attachment preview action | source |
| 069 | Image generation result | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | Prompt send supported; image artifact identification incomplete | source |
| 070 | Upload failure detection | `src/studio/agentic-files.mjs` (NOT browser file upload); `src/capture/network.mjs` | unsupported | No upload progress/failure observation | source |
| 071 | Generated-document controls | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | No generated document download control | source |
| 072 | Writing-artifact surface | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | No writing artifact open control | source |
| 073 | Artifact edit | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | No editor mutation for native writing artifact | source |
| 074 | Data-analysis execution provenance | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | Replay/network evidence may indicate execution, not authoritative | source |
| 075 | Tool failure detection | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | Generic site failure reader; no tool-error category | source |
| 076 | Diagram artifact recognition | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | Diagram artifact detection absent | source |
| 077 | Chart semantics | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | No chart axis/data point reader | source |
| 078 | Input-output provenance | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | No upload-to-generated output provenance path | source |
| 079 | Code copying | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | No native code-copy operation | source |
| 080 | Artifact-open navigation | `src/shapes/observation.mjs`; `src/studio/ui/universal-chat.mjs` | unsupported | No artifact open/navigation tool | source |
| 081 | Project creation | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No Project creation primitive | source |
| 082 | Conversation-to-Project move | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No move-to-Project action | source |
| 083 | Project unlink | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No Project unlink action | source |
| 084 | Project instructions read | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No Project instructions reader | source |
| 085 | Project file attachment | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No Project file upload action | source |
| 086 | Project-specific history | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No Project-scoped native history locator | source |
| 087 | Sharing control discovery | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No share-link state reader | source |
| 088 | Share-link revocation | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No share-link revocation tool | source |
| 089 | Memory setting inspection | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No Memory enabled-state reader | source |
| 090 | Personalization settings discovery | `src/capture/chatgpt-chat-index.mjs`; `src/studio/conversation-tools.mjs` | unsupported | No Personalization-settings viewer | source |
| 091 | Network loss detection | `src/capture/thread-turn-journal.mjs`; `src/studio/uncertain-step-reconciler.mjs`; `src/studio/world-service.mjs` | partial | Network error detection partial; no guaranteed recovery | source |
| 092 | Session expiration | `src/capture/thread-turn-journal.mjs`; `src/studio/uncertain-step-reconciler.mjs`; `src/studio/world-service.mjs` | partial | Auth wall found; thread preservation unverified | source |
| 093 | Target drift | `src/capture/thread-turn-journal.mjs`; `src/studio/uncertain-step-reconciler.mjs`; `src/studio/world-service.mjs` | supported | Expected-thread fence; real drift scenario unverified | source |
| 094 | Snapshot freshness | `src/capture/thread-turn-journal.mjs`; `src/studio/uncertain-step-reconciler.mjs`; `src/studio/world-service.mjs` | partial | Journal reads; reload freshness watcher missing | source |
| 095 | Runtime reconnection | `src/studio/tool-client.mjs`; `bin/commands/tools.mjs` | supported | `tool-client` reconnects to same Studio process | source |
| 096 | No-resend reconciliation | `src/capture/thread-turn-journal.mjs`; `src/studio/uncertain-step-reconciler.mjs` | partial | Thread journal and reconciler; legacy drive has no turn journal | source |
| 097 | Rate-limit detection | `src/capture/actions.mjs` (`detectSiteFailure`) | unsupported | `detectSiteFailure` sees some usage-credit errors; banner missing | source |
| 098 | Timeout truthfulness | `src/capture/actions.mjs` (`driveSite`, `waitForCompletion`) | partial | FIXED: uncertain post-dispatch timeout retains browser tab; no resend | source; 4/4 isolated checks |
| 099 | Capture provenance | `src/capture/recorder.mjs`; `src/studio/world-service.mjs` | partial | Recorder + World service; automatic chain needs confirmation | source |
| 100 | Return-to-source continuity | `src/studio/world-service.mjs`; `src/studio/world-url.mjs` | partial | World source URL exists; round-trip reopen unverified | source |

### Implemented and still blocking

**Fixed in source during this audit:** `src/capture/actions.mjs` preserves a newly created drive tab when a send was attempted but the outcome remained unresolved; `src/capture/conversation-thread.mjs` removes a duplicate unverified controls projection overriding the observed readiness result; the focused CI workflow now includes the timeout regression. Existing/additional functional surfaces: `create_conversation` creates blank owned tabs; `read_conversation` can return bounded typed DOM parts via `src/capture/conversation-rich.mjs`. Those latter two were added on `main` by concurrent repository updates; their separate authorship is not attributed to this audit.

**Open shared gaps:** most of 061–090 (native uploads, generated artifacts, Project/settings/share controls), unexposed navigation and message lifecycle UI tools, read visibility limits, citation provenance, and a true persistent no-resend journal for standalone `drive`. Source fixtures cannot establish whether these features are present on this particular signed-in account; no live scenarios 001–100 were executed. **Do not mark this 100-scenario effort complete.**

## 2026-10-28 — scenario closure reconciliation and remaining gaps

[Per-scenario source/gap/status ledger for all objectives 001–100](CHATGPT-100-AUDIT-LEDGER-2026-10-28.md): **6 source-supported, 43 partial, 51 unsupported**, where "source-supported" is not a new live verification result.

- **007:** observed generation controls exposed through existing `read_conversation`, with `busy / idle / unknown` derived from stop/send/composer selectors. Still no complete backend generation-terminal proof.
- **041–050:** typed, bounded DOM parts now flow via existing CDP read. Structure is partial and limited to rendered nodes: citation anchoring remains candidate-only; HTML tables/rows are capped; links are intentionally query/fragment sanitized; image metadata is not an asset download; math depends on DOM annotation availability. No offscreen traversal.
- **022–023, 093, 096:** thread fence and no-resend durability remain first-class; source fixes do not imply live continuity confirmation. Never resend after unknown delivery.
- **051–090:** crucial ChatGPT-native UI primitives remain mostly absent: search, thinking mode, upload/download, artifact manipulation, Project/settings/share management. Generic local file or profile modules do not close those gaps.

**Verification state:** focused V8 source-contract assertions passed, and `test/unit/conversation-rich.test.mjs` plus GitHub Actions workflow `.github/workflows/chatgpt-source-audit.yml` are committed. Latest observed GitHub Actions runs failed without retrievable job logs; the Node assertions are therefore **unverified**, and no new live scenario was run. No claim that all actionable findings are fixed; this audit is incomplete.

## Source-level 001–100 individual reconciliation — 2026-10-28

**This is not completion of the 100 live scenarios.** Classification is conditional **source availability**, not demonstrated user success. All rows are **source-reviewed only** here: no successful automated test execution and **no live provider run** in this audit. Historical 021 evidence remains historical; 022–023 continuity still needs real proof. CI jobs failed without any executed/recorded steps or retrievable logs; automation verification remains blocked. The explicit source/config file inventory across these three maps was **132/132 fetched in full at a pinned ancestor** plus **24 additional transitive imports** fetched later and the newly added `src/capture/conversation-rich.mjs`. This is file-retrieval coverage, not an exhausted transitive graph or per-scenario execution.

| # | User objective | Source status | Actual source / nearest dependency | First missing link or remaining limitation | Verification |
|---|---|---|---|---|---|
| 001 | Account identity | unsupported | `conversation-browser-adapter` + `thread-identity` + browser ownership | No verified account reader | source-reviewed; tests blocked; no new live proof |
| 002 | Authentication state | partial | `conversation-browser-adapter` + `thread-identity` + browser ownership | Auth wall only, no complete login state | source-reviewed; tests blocked; no new live proof |
| 003 | Native thread identity | supported | `conversation-thread.parseThread` + `thread-identity.chatgptConversationClaim` | Strict native /c/ parser; host-scoped identity fix | source-reviewed; tests blocked; no new live proof |
| 004 | Tab discovery | supported | `conversation_targets` + `cdp/discovery.listTargets` | CDP target metadata; authentication not asserted | source-reviewed; tests blocked; no new live proof |
| 005 | Chrome-profile isolation | partial | `chrome/launch` + `browser-ownership.verifyBrowserOwner` | Browser marker only; no independent profile UI label | source-reviewed; tests blocked; no new live proof |
| 006 | Page readiness | supported | `conversation-browser-adapter.readiness` | Readiness probe exists; live observation not repeated | source-reviewed; tests blocked; no new live proof |
| 007 | Streaming state | partial | `conversation-thread.transcriptExpression` + ChatGPT profile selectors | Observed stop/send controls only, not network terminal | source-reviewed; tests blocked; no new live proof |
| 008 | Ephemeral chat awareness | unsupported | `conversation-browser-adapter` + `thread-identity` + browser ownership | No ephemeral mode selector | source-reviewed; tests blocked; no new live proof |
| 009 | Duplicate-title identity | partial | `chatgpt-chat-index` (native link ID keys) | Index uses native link IDs but not duplicate-title selection | source-reviewed; tests blocked; no new live proof |
| 010 | UI obstruction recognition | unsupported | `conversation-browser-adapter` + `thread-identity` + browser ownership | No generalized modal/challenge classifier | source-reviewed; tests blocked; no new live proof |
| 011 | New-chat navigation | supported | `create_conversation` → `conversation-runtime.connect` | Fresh Studio-owned unbound chat tab supported | source-reviewed; tests blocked; no new live proof |
| 012 | Sidebar history selection | partial | `chat_index` + `chatgpt-chat-index-reader` | Title candidates; no native click/navigation | source-reviewed; tests blocked; no new live proof |
| 013 | Deep-link navigation | supported | `drive` URL and `connect_conversation` | Exact URL/deep-link only, no new live proof | source-reviewed; tests blocked; no new live proof |
| 014 | Cross-thread navigation | partial | `conversation_targets` + `connect_conversation` | Targets can be found but no switch-and-return command | source-reviewed; tests blocked; no new live proof |
| 015 | Native history search | unsupported | `chat-index` + `conversation_targets` + runtime connect | No history search actuator | source-reviewed; tests blocked; no new live proof |
| 016 | Recent-thread recovery | partial | `chat-index` + `conversation_targets` + runtime connect | No durable last-thread return shortcut | source-reviewed; tests blocked; no new live proof |
| 017 | Long-thread traversal | unsupported | `chat-index` + `conversation_targets` + runtime connect | Rendered-tail-only read; no oldest-turn traversal | source-reviewed; tests blocked; no new live proof |
| 018 | Scroll-to-latest | unsupported | `capture/human.humanScroll` (not exposed) | humanScroll exists but not connected to this user action | source-reviewed; tests blocked; no new live proof |
| 019 | Sidebar expansion | unsupported | `chat-index` + `conversation_targets` + runtime connect | No sidebar expansion actuator | source-reviewed; tests blocked; no new live proof |
| 020 | Archived-history navigation | unsupported | `chat-index` + `conversation_targets` + runtime connect | No archive-history navigation | source-reviewed; tests blocked; no new live proof |
| 021 | First-turn delivery | supported | `create_conversation` + `submit_conversation_turn` + journal | Create/submit path exists; no fresh live acceptance | source-reviewed; tests blocked; no new live proof |
| 022 | Same-thread follow-up | partial | `connect_conversation` + `submit_conversation_turn` + journal | Original 022 jumped threads; no re-run continuity proof | source-reviewed; tests blocked; no new live proof |
| 023 | Long-range thread continuity | partial | `thread-turn-journal` + source-bound conversation | Journal continuity exists, not long-range verified | source-reviewed; tests blocked; no new live proof |
| 024 | Message edit and branch awareness | unsupported | `conversation-runtime` + `thread-turn-journal` + browser adapter | No edit-and-branch UI actuator | source-reviewed; tests blocked; no new live proof |
| 025 | Response regeneration | unsupported | `conversation-runtime` + `thread-turn-journal` + browser adapter | No regenerate UI actuator | source-reviewed; tests blocked; no new live proof |
| 026 | Interrupt generation | unsupported | `conversation-thread` stop-selector observation | Stop state observable; no stop button actuator | source-reviewed; tests blocked; no new live proof |
| 027 | Generation continuation | unsupported | `conversation-runtime` + `thread-turn-journal` + browser adapter | No continuation actuator | source-reviewed; tests blocked; no new live proof |
| 028 | Conversation branching | unsupported | `conversation-runtime` + `thread-turn-journal` + browser adapter | No branch creation/ref binding | source-reviewed; tests blocked; no new live proof |
| 029 | Conversation rename | unsupported | `conversation-runtime` + `thread-turn-journal` + browser adapter | No native rename action | source-reviewed; tests blocked; no new live proof |
| 030 | Archive mutation | unsupported | `conversation-runtime` + `thread-turn-journal` + browser adapter | No native archive action | source-reviewed; tests blocked; no new live proof |
| 031 | Multiline payload fidelity | supported | `actions.typeText` + site profile | Multiline typing possible; end-to-end fidelity untested | source-reviewed; tests blocked; no new live proof |
| 032 | Unicode editing | supported | `actions.typeText` + site profile | Unicode typing possible; live script fidelity untested | source-reviewed; tests blocked; no new live proof |
| 033 | Keyboard send action | supported | `actions.typeText` + site profile | Keyboard send primitive available | source-reviewed; tests blocked; no new live proof |
| 034 | Keyboard newline action | partial | `actions.typeText` + site profile | No independent newline-without-send operation | source-reviewed; tests blocked; no new live proof |
| 035 | Model selection | unsupported | `profiles/model-ops.applyModelOp` (unrelated) | Capture profile model ops are NOT ChatGPT model picker | source-reviewed; tests blocked; no new live proof |
| 036 | Temporary Chat activation | unsupported | `actions.typeText` + site profile | No temporary-chat activation action | source-reviewed; tests blocked; no new live proof |
| 037 | Speech input | unsupported | `actions.typeText` + site profile | No microphone input command | source-reviewed; tests blocked; no new live proof |
| 038 | Suggestion-chip interaction | unsupported | `actions.typeText` + site profile | No suggestion chip click | source-reviewed; tests blocked; no new live proof |
| 039 | Copy action | unsupported | `actions.typeText` + site profile | Text read possible; no native Copy button control | source-reviewed; tests blocked; no new live proof |
| 040 | Feedback UI discovery | unsupported | `actions.typeText` + site profile | No feedback/reaction UI reader | source-reviewed; tests blocked; no new live proof |
| 041 | Long-answer extraction | partial | `boundTranscript` + reply SSE text key | Rendered tail capped; no full multi-screen traversal | source-reviewed; tests blocked; no new live proof |
| 042 | Role attribution | supported | `TRANSCRIPT_SELECTORS` + `boundTranscript` | Role-labelled turn boundaries; hidden history excluded | source-reviewed; tests blocked; no new live proof |
| 043 | List structure | partial | `conversation-rich` list-item reader | List-item/depth observed; full hierarchy unproven | source-reviewed; tests blocked; no new live proof |
| 044 | Code block fidelity | partial | `conversation-rich` code reader | Code language/text visible but clipped | source-reviewed; tests blocked; no new live proof |
| 045 | Table semantics | partial | `conversation-rich` table reader | Table rows/cells bounded 24x16 | source-reviewed; tests blocked; no new live proof |
| 046 | Math fidelity | partial | `conversation-rich` math reader | LaTeX only if visible in DOM | source-reviewed; tests blocked; no new live proof |
| 047 | Quotation structure | partial | `conversation-rich` blockquote reader | Blockquote text observed; attribution unknown | source-reviewed; tests blocked; no new live proof |
| 048 | Hyperlink extraction | partial | `conversation-rich.safeLink` | Href sanitized, query/fragment intentionally removed | source-reviewed; tests blocked; no new live proof |
| 049 | Citation anchoring | partial | `conversation-rich` citation-candidate | Citation candidates only; no passage/source binding | source-reviewed; tests blocked; no new live proof |
| 050 | Image-block extraction | partial | `conversation-rich` image part | Image alt and presence, not addressable image content | source-reviewed; tests blocked; no new live proof |
| 051 | Search-tool activation | unsupported | `chatgpt` seed + `adapter-probes` + `network` | No proof native search actually ran | source-reviewed; tests blocked; no new live proof |
| 052 | Source card reading | unsupported | `chatgpt` seed + `adapter-probes` + `network` | No source-card provenance classifier | source-reviewed; tests blocked; no new live proof |
| 053 | Citation-source navigation | unsupported | `chatgpt` seed + `adapter-probes` + `network` | No source-card navigation tool | source-reviewed; tests blocked; no new live proof |
| 054 | Tool-panel expansion | unsupported | `chatgpt` seed + `adapter-probes` + `network` | No panel-expansion control | source-reviewed; tests blocked; no new live proof |
| 055 | Evidence presence | partial | `conversation-rich` citation candidates | Citation candidates but no source-vs-assertion guarantee | source-reviewed; tests blocked; no new live proof |
| 056 | Reasoning mode awareness | unsupported | `chatgpt` seed + `adapter-probes` + `network` | No reasoning model/mode selector | source-reviewed; tests blocked; no new live proof |
| 057 | Reasoning completion | partial | `conversation-thread` busy/idle controls | Busy/idle UI not proof reasoning terminal | source-reviewed; tests blocked; no new live proof |
| 058 | Deep Research discovery | unsupported | `chatgpt` seed + `adapter-probes` + `network` | No Deep Research entry point discovery | source-reviewed; tests blocked; no new live proof |
| 059 | Research job monitoring | unsupported | `chatgpt` seed + `adapter-probes` + `network` | No research-job status or reopen | source-reviewed; tests blocked; no new live proof |
| 060 | Research report navigation | unsupported | `chatgpt` seed + `adapter-probes` + `network` | No research-report section navigator | source-reviewed; tests blocked; no new live proof |
| 061 | File-picker input | unsupported | `studio/agentic-files.createAgenticFileLibrary` (unrelated) | No ChatGPT file picker; agentic-files is local inventory | source-reviewed; tests blocked; no new live proof |
| 062 | Vision-file submission | unsupported | `recorder` + `agentic-files` (unrelated to upload) | No native vision upload actuator | source-reviewed; tests blocked; no new live proof |
| 063 | PDF interpretation | unsupported | `recorder` + `agentic-files` (unrelated to upload) | No PDF attach/page-proof flow | source-reviewed; tests blocked; no new live proof |
| 064 | Tabular file analysis | unsupported | `recorder` + `agentic-files` (unrelated to upload) | No CSV upload actuator | source-reviewed; tests blocked; no new live proof |
| 065 | Spreadsheet rendering | unsupported | `recorder` + `agentic-files` (unrelated to upload) | No spreadsheet upload/chart flow | source-reviewed; tests blocked; no new live proof |
| 066 | Source-file input | unsupported | `studio/agentic-files` local instruction inventory | No native source-file attachment | source-reviewed; tests blocked; no new live proof |
| 067 | File download | unsupported | `export/export` VIVIM-local exports | Local export is NOT ChatGPT native file download | source-reviewed; tests blocked; no new live proof |
| 068 | Attachment preview | unsupported | `recorder` + `agentic-files` (unrelated to upload) | No attachment preview opener | source-reviewed; tests blocked; no new live proof |
| 069 | Image generation result | partial | `submit_conversation_turn` + `conversation-rich` image part | Image may be observed after prompt, not generation proof | source-reviewed; tests blocked; no new live proof |
| 070 | Upload failure detection | unsupported | `recorder` + `agentic-files` (unrelated to upload) | No upload progress/failure state reader | source-reviewed; tests blocked; no new live proof |
| 071 | Generated-document controls | unsupported | `conversation-rich` + `shapes/observation` + UI views | No native generated-document download control | source-reviewed; tests blocked; no new live proof |
| 072 | Writing-artifact surface | unsupported | `conversation-rich` + `shapes/observation` + UI views | Local UI projection is not ChatGPT writing editor | source-reviewed; tests blocked; no new live proof |
| 073 | Artifact edit | unsupported | `conversation-rich` + `shapes/observation` + UI views | No artifact edit actuator | source-reviewed; tests blocked; no new live proof |
| 074 | Data-analysis execution provenance | partial | `capture/network` + `shapes/observation` | Captured network hints, no qualified tool-execution proof | source-reviewed; tests blocked; no new live proof |
| 075 | Tool failure detection | partial | `capture/actions.detectSiteFailure` | Generic site failure detection, not tool failure state | source-reviewed; tests blocked; no new live proof |
| 076 | Diagram artifact recognition | unsupported | `conversation-rich` + `shapes/observation` + UI views | No rendered-diagram type proof | source-reviewed; tests blocked; no new live proof |
| 077 | Chart semantics | unsupported | `conversation-rich` + `shapes/observation` + UI views | Chart type hint, no axes/points extractor | source-reviewed; tests blocked; no new live proof |
| 078 | Input-output provenance | unsupported | `conversation-rich` + `shapes/observation` + UI views | No upload-to-output provenance join | source-reviewed; tests blocked; no new live proof |
| 079 | Code copying | partial | `conversation-rich` code-part reader | Code text extractable, native copy button missing | source-reviewed; tests blocked; no new live proof |
| 080 | Artifact-open navigation | unsupported | `conversation-rich` + `shapes/observation` + UI views | No native attachment-open action | source-reviewed; tests blocked; no new live proof |
| 081 | Project creation | unsupported | `chatgpt-chat-index` + World indexing | No Project creation actuator | source-reviewed; tests blocked; no new live proof |
| 082 | Conversation-to-Project move | unsupported | `chatgpt-chat-index` + World indexing | No conversation-to-Project move | source-reviewed; tests blocked; no new live proof |
| 083 | Project unlink | unsupported | `chatgpt-chat-index` + World indexing | No Project unlink | source-reviewed; tests blocked; no new live proof |
| 084 | Project instructions read | unsupported | `chatgpt-chat-index` + World indexing | No Project instructions reader | source-reviewed; tests blocked; no new live proof |
| 085 | Project file attachment | unsupported | `studio/agentic-files` (unrelated) | No Project file attachment | source-reviewed; tests blocked; no new live proof |
| 086 | Project-specific history | unsupported | `chatgpt-chat-index` + World indexing | Project identity indexed as unknown | source-reviewed; tests blocked; no new live proof |
| 087 | Sharing control discovery | unsupported | `chatgpt-chat-index` + World indexing | No share-link discovery | source-reviewed; tests blocked; no new live proof |
| 088 | Share-link revocation | unsupported | `chatgpt-chat-index` + World indexing | No share-link revoke | source-reviewed; tests blocked; no new live proof |
| 089 | Memory setting inspection | unsupported | `chatgpt-chat-index` + World indexing | No ChatGPT Memory settings reader | source-reviewed; tests blocked; no new live proof |
| 090 | Personalization settings discovery | unsupported | `chatgpt-chat-index` + World indexing | No native Custom Instructions settings reader | source-reviewed; tests blocked; no new live proof |
| 091 | Network loss detection | partial | `capture/actions.detectSiteFailure` | General site failures observed; no explicit offline recovery | source-reviewed; tests blocked; no new live proof |
| 092 | Session expiration | partial | `conversation-browser-adapter.detectAuthWall` | Auth-wall detection, no reauthentication continuity proof | source-reviewed; tests blocked; no new live proof |
| 093 | Target drift | supported | `conversation-browser-adapter.check` + drive lease | Exact target/thread recheck guards send | source-reviewed; tests blocked; no new live proof |
| 094 | Snapshot freshness | partial | `thread-turn-journal` + `read_conversation` | Journal freshness, no reload watcher | source-reviewed; tests blocked; no new live proof |
| 095 | Runtime reconnection | supported | `studio/tool-client` | Existing Studio tool-client reused | source-reviewed; tests blocked; no new live proof |
| 096 | No-resend reconciliation | supported | `thread-turn-journal` + `uncertain-step-reconciler` | Journal no-resend fence + read-only reconcile | source-reviewed; tests blocked; no new live proof |
| 097 | Rate-limit detection | partial | `capture/actions.detectSiteFailure` | Rate/usage heuristics incomplete | source-reviewed; tests blocked; no new live proof |
| 098 | Timeout truthfulness | partial | `capture/actions.driveSite` + `conversation-events.textKey` | Post-dispatch uncertainty and capped SSE; no live terminal proof | source-reviewed; tests blocked; no new live proof |
| 099 | Capture provenance | partial | `recorder` + `conversation-evidence` + `world-service` | Recorder/session-to-World path exists, acceptance unproven | source-reviewed; tests blocked; no new live proof |
| 100 | Return-to-source continuity | partial | `world-service` + `world-url` + `conversation-thread` | Saved source pointer exists, native return navigation not verified | source-reviewed; tests blocked; no new live proof |

**Totals:** 13 source-supported, 32 partial, 55 unsupported; **0 live-verified in this audit**. No unverified scenario is promoted by a source signature or fixture alone.
