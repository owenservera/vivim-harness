# ChatGPT native scenarios 001–100 — source-to-outcome reconciliation

Date: 2026-10-28. Baseline: original objectives and the three companion maps. **Status is a source-level estimate, not provider entitlement or a passed live scenario.** Generic code and selectors do not count as full native support.

## Inspection method and limitations

- The three maps were fetched completely; all **134 unique source/test files explicitly named** across them were fetched from `main` and inspected for module imports, exports and relevant call/registration surfaces. Additional transitive modules were fetched when found along those paths. This is an import/owner-focused source pass, **not** a claim that every possible reverse caller or live edge has been exercised.
- Tool additions: `create_conversation` appeared on a newer `main` during this pass; its route reuses the existing runtime. `conversation_capsule` now exposes an already-implemented runtime capability; `conversation.capabilities` names it in recipes. Both require live verification.
- Tests were added in `test/unit/conversation-tools.test.mjs` and `test/unit/recipe-catalog.test.mjs` but **not executed in this environment**. No 100-scenario live replay was started.
- Status `supported` = code path is present, **not** live-pass; `partial` = incomplete lifecycle/extraction/evidence/recovery; `unsupported` = named native objective not exposed; `blocked` reserved for proven environmental blockers.
- The unexposed/missing user effects below remain open engineering work, not claimed fixed.

| ID | User objective | Actual current owner / dependency or closest implementation | Status | First missing or uncertain link | Verification |
|---|---|---|---|---|---|
| 001 | Account identity | No account-identity reader; `conversation_capsule` is only capability evidence | unsupported | Signed-in account UI has no observed identity primitive | source-reviewed; not live-verified here |
| 002 | Authentication state | `src/capture/actions.mjs:detectAuthWall`; `src/capture/conversation-browser-adapter.mjs` | partial | Detects some auth walls, not signed-in account proof | source-reviewed; not live-verified here |
| 003 | Native thread identity | `src/capture/conversation-thread.mjs:parseThread`; `src/capture/conversation-runtime.mjs:connect` | supported | Exact `/c/<uuid>` supported; no account proof | source-reviewed; regression source present, not run here |
| 004 | Tab discovery | `src/studio/conversation-tools.mjs:conversation_targets`; `src/cdp/discovery.mjs:listTargets` | supported | Target metadata is not verified content | source-reviewed; not live-verified here |
| 005 | Chrome-profile isolation | `src/config.mjs`; `src/chrome/browser-ownership.mjs`; `src/chrome/launch.mjs` | partial | Profile ownership exists; account isolation not proven live | source-reviewed; not live-verified here |
| 006 | Page readiness | `src/capture/actions.mjs:waitForComposer`; `src/capture/conversation-runtime.mjs` | partial | Readiness needs visible independent evidence | source-reviewed; not live-verified here |
| 007 | Streaming state | `src/capture/actions.mjs:isStreaming`; `src/studio/conversation-events.mjs` | partial | Streaming indicators alone do not certify terminal reply | source-reviewed; not live-verified here |
| 008 | Ephemeral chat awareness | `src/profiles/sites/chatgpt.mjs` | unsupported | No native Temporary Chat status reader | source-reviewed; not live-verified here |
| 009 | Duplicate-title identity | `src/capture/chatgpt-chat-index.mjs`; `src/capture/conversation-thread.mjs` | partial | URL UUID disambiguates rendered links; no full history | source-reviewed; not live-verified here |
| 010 | UI obstruction recognition | `src/capture/actions.mjs:detectAuthWall` and `detectSiteFailure` | partial | No general obstacle classifier or modal recovery | source-reviewed; not live-verified here |
| 011 | New-chat navigation | `src/studio/conversation-tools.mjs:create_conversation` → `src/capture/conversation-runtime.mjs:connect` | supported | New source route; live provider result unverified | source-reviewed; not live-verified here |
| 012 | Sidebar history selection | `src/capture/chatgpt-chat-index-reader.mjs` → `chat_index` | partial | Read-only candidate list; no sidebar click/select | source-reviewed; not live-verified here |
| 013 | Deep-link navigation | `parseThread` → `connect_conversation`; `bin/commands/drive.mjs` | supported | Deep-link browser open path source-fixed; no new live verification | source-reviewed; not live-verified here |
| 014 | Cross-thread navigation | `conversation_targets`; `connect_conversation` | partial | No single navigation/return operation with preserved selection | source-reviewed; not live-verified here |
| 015 | Native history search | `src/capture/chatgpt-chat-index.mjs` | unsupported | Index links are read-only candidates; required navigation/search control is absent | source-reviewed; not live-verified here |
| 016 | Recent-thread recovery | `chat_index`; exact `/c/` link; `connect_conversation` | partial | Requires prior exact address; no recent-thread search/recovery command | source-reviewed; not live-verified here |
| 017 | Long-thread traversal | `src/capture/chatgpt-chat-index.mjs` | unsupported | Index links are read-only candidates; required navigation/search control is absent | source-reviewed; not live-verified here |
| 018 | Scroll-to-latest | `src/capture/human.mjs:humanScroll` | partial | Existing scrolling helper is not a named conversation control | source-reviewed; not live-verified here |
| 019 | Sidebar expansion | `src/capture/chatgpt-chat-index.mjs` | unsupported | Index links are read-only candidates; required navigation/search control is absent | source-reviewed; not live-verified here |
| 020 | Archived-history navigation | `src/capture/chatgpt-chat-index.mjs` | unsupported | Index links are read-only candidates; required navigation/search control is absent | source-reviewed; not live-verified here |
| 021 | First-turn delivery | `submit_conversation_turn` → `src/capture/conversation-browser-adapter.mjs`; `src/capture/recorder.mjs` | supported | Original drive had prior live first-turn success; Studio path not live-verified here | prior live drive only; not re-run |
| 022 | Same-thread follow-up | `bin/commands/drive.mjs`; `src/capture/actions.mjs`; `src/capture/thread-turn-journal.mjs` | partial | Follow-up path source-fixed; same-thread continuity not live re-proven | prior live failure; source-fixed, not re-run |
| 023 | Long-range thread continuity | `conversation-runtime.mjs`; `thread-turn-journal.mjs` | partial | Long-range attribution across invisible history unproven | source-reviewed; not live-verified here |
| 024 | Message edit and branch awareness | `src/capture/conversation-runtime.mjs` | unsupported | Native lifecycle control is not exposed | source-reviewed; not live-verified here |
| 025 | Response regeneration | `src/capture/conversation-runtime.mjs` | unsupported | Native lifecycle control is not exposed | source-reviewed; not live-verified here |
| 026 | Interrupt generation | `src/capture/conversation-runtime.mjs` | unsupported | Native lifecycle control is not exposed | source-reviewed; not live-verified here |
| 027 | Generation continuation | `src/capture/conversation-runtime.mjs` | unsupported | Native lifecycle control is not exposed | source-reviewed; not live-verified here |
| 028 | Conversation branching | `src/capture/conversation-runtime.mjs` | unsupported | Native lifecycle control is not exposed | source-reviewed; not live-verified here |
| 029 | Conversation rename | `src/capture/conversation-runtime.mjs` | unsupported | Native lifecycle control is not exposed | source-reviewed; not live-verified here |
| 030 | Archive mutation | `src/capture/conversation-runtime.mjs` | unsupported | Native lifecycle control is not exposed | source-reviewed; not live-verified here |
| 031 | Multiline payload fidelity | `src/capture/actions.mjs:typeText` → `src/capture/human.mjs:humanType` | supported | Fidelity requires live provider observation | source-reviewed; not live-verified here |
| 032 | Unicode editing | `src/capture/actions.mjs:typeText` | supported | Unicode fidelity requires live provider observation | source-reviewed; not live-verified here |
| 033 | Keyboard send action | `src/capture/actions.mjs:sendMessage` | supported | Keyboard strategy exists; exact shortcut outcome not proven | source-reviewed; not live-verified here |
| 034 | Keyboard newline action | `src/capture/actions.mjs` | unsupported | No separately named UI primitive and observed readback | source-reviewed; not live-verified here |
| 035 | Model selection | `src/profiles/model-ops.mjs`; `src/profiles/sites/chatgpt.mjs` | partial | Profile model ops are not verified native ChatGPT model selection | source-reviewed; not live-verified here |
| 036 | Temporary Chat activation | `src/capture/actions.mjs` | unsupported | No separately named UI primitive and observed readback | source-reviewed; not live-verified here |
| 037 | Speech input | `src/capture/actions.mjs` | unsupported | No separately named UI primitive and observed readback | source-reviewed; not live-verified here |
| 038 | Suggestion-chip interaction | `src/capture/actions.mjs` | unsupported | No separately named UI primitive and observed readback | source-reviewed; not live-verified here |
| 039 | Copy action | `src/capture/actions.mjs` | unsupported | No separately named UI primitive and observed readback | source-reviewed; not live-verified here |
| 040 | Feedback UI discovery | `src/capture/actions.mjs` | unsupported | No separately named UI primitive and observed readback | source-reviewed; not live-verified here |
| 041 | Long-answer extraction | `src/capture/conversation-thread.mjs:boundTranscript`; `read_conversation` | partial | Bounded per-message/total-char caps; not complete long-answer recovery | source-reviewed; regression source present, not run here |
| 042 | Role attribution | `src/capture/conversation-thread.mjs:transcriptExpression`; `read_conversation` | partial | Role-labelled rendered nodes only; hidden/unrendered turns omitted | source-reviewed; not live-verified here |
| 043 | List structure | `src/shapes/extract.mjs`; `src/replay/stream-components.mjs` | unsupported | Generic extraction exists; typed ChatGPT answer-block reader is not exposed | source-reviewed; not live-verified here |
| 044 | Code block fidelity | `src/shapes/extract.mjs`; `src/replay/stream-components.mjs` | unsupported | Generic extraction exists; typed ChatGPT answer-block reader is not exposed | source-reviewed; not live-verified here |
| 045 | Table semantics | `src/shapes/extract.mjs`; `src/replay/stream-components.mjs` | unsupported | Generic extraction exists; typed ChatGPT answer-block reader is not exposed | source-reviewed; not live-verified here |
| 046 | Math fidelity | `src/shapes/extract.mjs`; `src/replay/stream-components.mjs` | unsupported | Generic extraction exists; typed ChatGPT answer-block reader is not exposed | source-reviewed; not live-verified here |
| 047 | Quotation structure | `src/shapes/extract.mjs`; `src/replay/stream-components.mjs` | unsupported | Generic extraction exists; typed ChatGPT answer-block reader is not exposed | source-reviewed; not live-verified here |
| 048 | Hyperlink extraction | `src/shapes/extract.mjs`; `src/replay/stream-components.mjs` | unsupported | Generic extraction exists; typed ChatGPT answer-block reader is not exposed | source-reviewed; not live-verified here |
| 049 | Citation anchoring | `src/shapes/extract.mjs`; `src/replay/stream-components.mjs` | unsupported | Generic extraction exists; typed ChatGPT answer-block reader is not exposed | source-reviewed; not live-verified here |
| 050 | Image-block extraction | `src/shapes/extract.mjs`; `src/replay/stream-components.mjs` | unsupported | Generic extraction exists; typed ChatGPT answer-block reader is not exposed | source-reviewed; not live-verified here |
| 051 | Search-tool activation | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 052 | Source card reading | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 053 | Citation-source navigation | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 054 | Tool-panel expansion | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 055 | Evidence presence | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 056 | Reasoning mode awareness | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 057 | Reasoning completion | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 058 | Deep Research discovery | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 059 | Research job monitoring | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 060 | Research report navigation | `src/profiles/sites/chatgpt.mjs` | unsupported | ChatGPT search/research/thinking UI control and observation missing | source-reviewed; not live-verified here |
| 061 | File-picker input | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 062 | Vision-file submission | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 063 | PDF interpretation | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 064 | Tabular file analysis | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 065 | Spreadsheet rendering | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 066 | Source-file input | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 067 | File download | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 068 | Attachment preview | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 069 | Image generation result | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 070 | Upload failure detection | `src/studio/agentic-files.mjs` | unsupported | Local file inventory is not a ChatGPT native attach/download action | source-reviewed; not live-verified here |
| 071 | Generated-document controls | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 072 | Writing-artifact surface | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 073 | Artifact edit | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 074 | Data-analysis execution provenance | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 075 | Tool failure detection | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 076 | Diagram artifact recognition | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 077 | Chart semantics | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 078 | Input-output provenance | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 079 | Code copying | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 080 | Artifact-open navigation | `src/studio/ui/chat.mjs`; `src/shapes/observation.mjs` | unsupported | No ChatGPT artifact UI control with typed outcome evidence | source-reviewed; not live-verified here |
| 081 | Project creation | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 082 | Conversation-to-Project move | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 083 | Project unlink | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 084 | Project instructions read | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 085 | Project file attachment | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 086 | Project-specific history | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 087 | Sharing control discovery | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 088 | Share-link revocation | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 089 | Memory setting inspection | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 090 | Personalization settings discovery | `src/studio/world-service.mjs` | unsupported | VIVIM local World must not be confused with remote ChatGPT Projects/settings/shares | source-reviewed; not live-verified here |
| 091 | Network loss detection | `src/capture/network.mjs`; `src/capture/recorder.mjs` | partial | No explicit offline state and recovery confirmation | source-reviewed; not live-verified here |
| 092 | Session expiration | `src/capture/actions.mjs:detectAuthWall`; `conversation-runtime.mjs` | partial | Auth detection does not preserve verified tab/thread reattachment | source-reviewed; not live-verified here |
| 093 | Target drift | `conversation-runtime.mjs:expectedThread`; `src/capture/drive-lease.mjs` | supported | Thread guard in source; live race safety not re-run | source-reviewed; not live-verified here |
| 094 | Snapshot freshness | `src/capture/conversation-thread.mjs:boundTranscript`; `thread-turn-journal.mjs` | partial | No reload invalidation watcher | source-reviewed; not live-verified here |
| 095 | Runtime reconnection | `src/studio/tool-client.mjs`; `bin/commands/tools.mjs` | supported | Reuse existing Studio; remote liveness not tested here | source-reviewed; not live-verified here |
| 096 | No-resend reconciliation | `src/capture/thread-turn-journal.mjs`; `src/studio/uncertain-step-reconciler.mjs` | partial | No blind resend; positive delivery proof may stay unknown | source-reviewed; not live-verified here |
| 097 | Rate-limit detection | `src/capture/actions.mjs:detectSiteFailure` | unsupported | No dedicated quota/rate-limit banner classifier | source-reviewed; not live-verified here |
| 098 | Timeout truthfulness | `src/capture/actions.mjs:waitForCompletion`; `src/studio/conversation-events.mjs` | partial | Source text event freshness improved; terminal proof still limited | source-reviewed; regression source present, not run here |
| 099 | Capture provenance | `src/capture/recorder.mjs`; `src/capture/conversation-evidence.mjs`; `src/studio/world-service.mjs` | partial | Capture-to-World verified end-to-end only with actual saved evidence | source-reviewed; not live-verified here |
| 100 | Return-to-source continuity | `src/studio/world-service.mjs`; `src/studio/world-url.mjs` | partial | Provider source reopen requires persisted verified native URL | source-reviewed; not live-verified here |

## New roadmap extension

Independent product-outcome scenarios **101–200**: [`CHATGPT-200-ROADMAP-OBJECTIVES.md`](CHATGPT-200-ROADMAP-OBJECTIVES.md). These include local capture, provenance, World, retrieval, portable context, adapter evolution, resilience, privacy and Windows/Android continuity; they are NOT marked implemented or live-passed.
