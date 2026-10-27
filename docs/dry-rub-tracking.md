# VIVIM Harness — ChatGPT 100-scenario assessment

**Question answered here:** what of the 100 objectives does the product actually do, judged from real runs and
from the captured data in both Studio roots (`C:\VIVIM\sessions`, `...\AION\capture-studio\sessions`).

**Capture inventory (both roots):** 89 ChatGPT sessions, 40 with captured turns, 139 turns.
Structured content found: **0 code fences, 0 tables, 0 links, 0 math, 0 images, 0 quotes, 1 list.**
The capture layer stores plain text only, so objectives 041–050 cannot be judged from it at all — the
data the objective asks for was never recorded.

**Statuses:** `PASS` proven · `PARTIAL` partial evidence · `BLOCKED-CAPTURE` the capture lacks the data ·
`UNSUPPORTED` no native primitive exists · `NOT-TESTED` runnable but not yet run.

## 01 Account and live-session awareness

| ID | Objective | Status | Basis |
|---|---|---|---|
| 001 | Account identity | UNSUPPORTED | No native surface returns the account; `agent status` reports `browserAccountState: unverified`. |
| 002 | Authentication state | PARTIAL | No explicit field; an authenticated surface was readable (`chat_index` returned 18 rendered `/c/` threads). |
| 003 | Native thread identity | PASS | `connect_conversation` bound `chatgpt-c:6ad2b82b…`, `identity.state: bound`. |
| 004 | Tab discovery | PASS | `targets` listed the ChatGPT tab beside `about:blank`. |
| 005 | Profile isolation | PASS | CLI refused the wrong data root and accepted `C:\VIVIM` after profile+port+browser identity matched. |
| 006 | Page readiness | PASS | `readiness.ready: true`, `draft 0 chars`. |
| 007 | Streaming state | PARTIAL | Idle detected; active generation not observed read-only. |
| 008 | Temporary Chat awareness | UNSUPPORTED | No surface reports the mode. |
| 009 | Duplicate-title identity | PARTIAL | Identity keyed by thread path; pin/Project grouping `NOT_OBSERVED`. |
| 010 | UI obstruction recognition | UNSUPPORTED | No obstruction surface; a modal could not be induced. |

## 02 Moving around ChatGPT

| ID | Objective | Status | Basis |
|---|---|---|---|
| 011 | New-chat navigation | PASS | Fresh conversation opened and sent into. |
| 012 | Sidebar history selection | PARTIAL | `chat_index` locates rendered threads by title; clicking one is not exposed. |
| 013 | Deep-link navigation | PASS | `/c/<uuid>` opened and bound. |
| 014 | Cross-thread navigation | PASS | Two threads open at once, distinct ids and refs. |
| 015 | Native history search | UNSUPPORTED | No search-driving primitive. |
| 016 | Recent-thread recovery | PARTIAL | Reopening a known `/c/` works; "last conversation" isn't tracked. |
| 017 | Long-thread traversal | UNSUPPORTED | No scroll primitive. |
| 018 | Scroll-to-latest | UNSUPPORTED | No scroll primitive. |
| 019 | Sidebar expansion | UNSUPPORTED | No click primitive for the sidebar. |
| 020 | Archived-history navigation | UNSUPPORTED | Archive surface not exposed. |

## 03 Native conversation lifecycle

| ID | Objective | Status | Basis |
|---|---|---|---|
| 021 | First-turn delivery | PASS | Reply `VIVIM 021 OK`; session `20261027-222710-chatgpt-95dda5`. |
| 022 | Same-thread follow-up | PASS | Two turns in `chatgpt-c:6ae129ee…`; follow-up answered `VIVIM 022 OK`. |
| 023 | Long-range thread continuity | PASS | Turn 3 asked for the phrase from turn 1 after an intervening turn; captured answer `VIVIM 022 OK` (session `20261027-225019-chatgpt-bdc721`, 6 turns). |
| 024 | Message edit and branch awareness | UNSUPPORTED | No edit/branch primitive. |
| 025 | Response regeneration | UNSUPPORTED | No regenerate primitive. |
| 026 | Interrupt generation | UNSUPPORTED | No stop primitive. |
| 027 | Generation continuation | UNSUPPORTED | No continue primitive. |
| 028 | Conversation branching | UNSUPPORTED | No branch primitive. |
| 029 | Conversation rename | UNSUPPORTED | No rename primitive. |
| 030 | Archive mutation | UNSUPPORTED | No archive primitive. |

## 04 Input controls and interaction modes

| ID | Objective | Status | Basis |
|---|---|---|---|
| 031 | Multiline payload fidelity | NOT-TESTED | Runnable as one turn; not yet run. |
| 032 | Unicode editing | NOT-TESTED | Runnable as one turn; not yet run. |
| 033 | Keyboard send action | PARTIAL | Enter dispatch is the implemented path; the shortcut variant isn't separate. |
| 034 | Keyboard newline action | NOT-TESTED | Not yet run. |
| 035 | Model selection | UNSUPPORTED | No model-selection primitive. |
| 036 | Temporary Chat activation | UNSUPPORTED | No primitive. |
| 037 | Speech input | UNSUPPORTED | No audio primitive. |
| 038 | Suggestion-chip interaction | UNSUPPORTED | No click primitive. |
| 039 | Copy action | UNSUPPORTED | No copy primitive. |
| 040 | Feedback UI discovery | UNSUPPORTED | No feedback-surface primitive. |

## 05 Structured answer extraction

| ID | Objective | Status | Basis |
|---|---|---|---|
| 041 | Long-answer extraction | BLOCKED-CAPTURE | Captures store plain text only; no long multi-screen reply was recorded with its parts. |
| 042 | Role attribution | PASS | Captured turns carry `role: user|assistant`. |
| 043 | List structure | BLOCKED-CAPTURE | 1 list found of 139 turns; no list hierarchy recorded. |
| 044 | Code block fidelity | BLOCKED-CAPTURE | 0 code fences captured. |
| 045 | Table semantics | BLOCKED-CAPTURE | 0 tables captured. |
| 046 | Math fidelity | BLOCKED-CAPTURE | 0 math expressions captured. |
| 047 | Quotation structure | BLOCKED-CAPTURE | 0 blockquotes captured. |
| 048 | Hyperlink extraction | BLOCKED-CAPTURE | 0 links captured. |
| 049 | Citation anchoring | BLOCKED-CAPTURE | No citation markers captured. |
| 050 | Image-block extraction | BLOCKED-CAPTURE | 0 images captured. |

## 06 Search, citations and thinking surfaces

| ID | Objective | Status | Basis |
|---|---|---|---|
| 051 | Search-tool activation | UNSUPPORTED | No web-search primitive. |
| 052 | Source card reading | BLOCKED-CAPTURE | No source cards recorded. |
| 053 | Citation-source navigation | UNSUPPORTED | No source-UI primitive. |
| 054 | Tool-panel expansion | UNSUPPORTED | No expansion primitive. |
| 055 | Evidence presence | BLOCKED-CAPTURE | No citations recorded to distinguish. |
| 056 | Reasoning mode awareness | UNSUPPORTED | No mode primitive. |
| 057 | Reasoning completion | PARTIAL | Completion is reported as `unknown` by design; long reasoning not observed. |
| 058 | Deep Research discovery | UNSUPPORTED | No primitive. |
| 059 | Research job monitoring | UNSUPPORTED | No primitive. |
| 060 | Research report navigation | UNSUPPORTED | No primitive. |

## 07 User-provided files and multimodal inputs

| ID | Objective | Status | Basis |
|---|---|---|---|
| 061 | File-picker input | UNSUPPORTED | No file-input primitive. |
| 062 | Vision-file submission | UNSUPPORTED | No file-input primitive; no image was ever provided. |
| 063 | PDF interpretation | UNSUPPORTED | No upload primitive. |
| 064 | Tabular file analysis | UNSUPPORTED | No upload primitive. |
| 065 | Spreadsheet rendering | UNSUPPORTED | No upload primitive. |
| 066 | Source-file input | UNSUPPORTED | No upload primitive. |
| 067 | File download | UNSUPPORTED | No download primitive. |
| 068 | Attachment preview | UNSUPPORTED | No preview primitive. |
| 069 | Image generation result | UNSUPPORTED | No generation/artifact primitive. |
| 070 | Upload failure detection | UNSUPPORTED | No upload primitive. |

## 08 Generated artifacts and richer UI

| ID | Objective | Status | Basis |
|---|---|---|---|
| 071 | Generated-document controls | UNSUPPORTED | No artifact primitive. |
| 072 | Writing-artifact surface | UNSUPPORTED | No canvas primitive. |
| 073 | Artifact edit | UNSUPPORTED | No edit primitive. |
| 074 | Data-analysis provenance | UNSUPPORTED | No tool-execution surface. |
| 075 | Tool failure detection | UNSUPPORTED | No tool-failure surface. |
| 076 | Diagram artifact recognition | UNSUPPORTED | No artifact primitive. |
| 077 | Chart semantics | BLOCKED-CAPTURE | No charts recorded. |
| 078 | Input-output provenance | UNSUPPORTED | No upload/artifact primitive. |
| 079 | Code copying | UNSUPPORTED | No copy primitive; 0 code blocks captured. |
| 080 | Artifact-open navigation | UNSUPPORTED | No artifact primitive. |

## 09 Projects, organization and controls

| ID | Objective | Status | Basis |
|---|---|---|---|
| 081 | Project creation | UNSUPPORTED | No Project primitive; Project state is `NOT_OBSERVED`. |
| 082 | Conversation-to-Project move | UNSUPPORTED | No Project primitive. |
| 083 | Project unlink | UNSUPPORTED | No Project primitive. |
| 084 | Project instructions read | UNSUPPORTED | Project state not observed. |
| 085 | Project file attachment | UNSUPPORTED | No upload or Project primitive. |
| 086 | Project-specific history | UNSUPPORTED | Project grouping not observed. |
| 087 | Sharing control discovery | UNSUPPORTED | No share primitive. |
| 088 | Share-link revocation | UNSUPPORTED | No share primitive. |
| 089 | Memory setting inspection | UNSUPPORTED | No settings primitive. |
| 090 | Personalization settings discovery | UNSUPPORTED | No settings primitive. |

## 10 Resilience, capture and truthful outcomes

| ID | Objective | Status | Basis |
|---|---|---|---|
| 091 | Network loss detection | UNSUPPORTED | No offline detection surface. |
| 092 | Session expiration | UNSUPPORTED | No expiry detection surface. |
| 093 | Target drift | PASS | `BINDING_CHANGED` fences a thread change before typing (covered by runtime tests). |
| 094 | Snapshot freshness | PARTIAL | Stored snapshots are labelled with read time; no stale-vs-fresh verdict. |
| 095 | Runtime reconnection | PASS | Studio restart re-attached to the same owner and served the same conversation. |
| 096 | No-resend reconciliation | PASS | Uncertain sends are fenced; a new key cannot repeat them (tests + live `uncertain` state). |
| 097 | Rate-limit detection | UNSUPPORTED | No quota surface. |
| 098 | Timeout truthfulness | PARTIAL | Reply completion is reported `unknown` rather than fabricated; slow-vs-failed not distinguished. |
| 099 | Capture provenance | PASS | Turn captures record role, session, sequence and thread (`DOM_TURNS` + journal). |
| 100 | Return-to-source continuity | PASS | Saved conversation reopened and its native `/c/` thread re-bound. |

## Summary

| Status | Count |
|---|---|
| PASS | 16 |
| PARTIAL | 9 |
| BLOCKED-CAPTURE | 12 |
| UNSUPPORTED | 60 |
| NOT-TESTED | 3 |

**The decisive fact:** the harness can identify, bind, send, follow up, capture and reopen a conversation.
It cannot yet touch the interaction surface of the webapp (click, scroll, edit, regenerate, upload, settings,
Projects) and it does not record structured reply parts. Those two gaps account for 72 of the 100.

## Defects found by running (all fixed unless marked)

1. Permanent ChatGPT lockout from an unattributable legacy attempt — fixed.
2. Composer looked up on the probe connection instead of the typing connection — fixed.
3. Transient composer unreadability treated as fatal — bounded retry, then fail closed.
4. Created-thread identity never recorded — `threadRef` now captured.
5. Fresh tab can restore an existing/pinned conversation — now refused before typing.
6. Split data roots: `drive` wrote to the AppData root while Studio served `C:\VIVIM` — open.
7. Captured text keeps the provider prefix (`ChatGPT dijo:`) — open.
8. Structured reply parts not captured (code/table/link/math/image/quote) — open.
