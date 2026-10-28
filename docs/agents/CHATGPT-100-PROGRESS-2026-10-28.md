# ChatGPT-100 progress matrix — 2026-10-28

Companion to `docs/agents/CHATGPT-100-LIVE-2026-10-28.json` (evidence ledger) and
`docs/agents/CHATGPT-100-INVESTIGATION-2026-10-28.json` (investigation ledger).
Objective text source: `docs/agents/CHATGPT-100-OBJECTIVES.md`.

Every row is derived mechanically from the live ledger: latest appended attempt per
objective, objective status per the ledger rule ("status derives from the latest appended
attempt"). Nothing in this table is inferred beyond what an attempt record states.

## Column definitions

- **Latest status** — the objective's `status` value, equal to its latest attempt's status.
- **Attempt phase** — phase of the latest attempt: `baseline` (pre-era record, no
  `attemptPhase`), `ERA2_RETEST`, `ERA2_RETEST_2`, `ERA2_RETEST_3`, or `-` when the
  objective has zero attempts.
- **Evidence class** — one class per objective, assigned from the strongest evidence present across that objective's attempts, so a later blocked attempt does not erase an earlier observed reply.
  - `provider-response` — an actual assistant or user message observed from the provider.
  - `live-browser-observation` — real DOM, CDP or target metadata observed from the live
    page, with no provider message in the record.
  - `tool-metadata` — native tool catalog, recipe output or stored Studio/CLI state only.
  - `offline-test` — an offline unit-test receipt only. No objective qualifies; the single
    receipt (conversation-create, 8/8 pass, exit 0) is not scoped to an objective.
  - `none` — zero attempts recorded.

  Legend: `provider-response` = an actual assistant/user message observed from the provider; `live-browser-observation` = real DOM/CDP/target metadata, no provider message; `tool-metadata` = native tool catalog/recipe output only; `offline-test` = unit test receipt; `none`.
- **Blocking requirement** — the first gate that stops the objective:
  `navigation` (browser/tab/thread opening plus read-only tool calls is enough),
  `send` (a provider send is required), `sign-in` (an authentication-state cycle is
  required), `effect` (an effectful UI action other than a plain send: upload, download,
  click-through, rename, archive, settings change, share/revoke, offline manipulation,
  process kill), `unsupported capability` (no primitive exists in the harness for the
  required action), `none` (already satisfied; do not rerun).
- **Next concrete action** — the single next step, not a plan.

## Matrix

| ID | Title | Latest status | Attempt phase | Evidence class | Blocking requirement | Next concrete action |
|---|---|---|---|---|---|---|
| 001 | Account identity | UNSUPPORTED | ERA2_RETEST | tool-metadata | unsupported capability | Add an account-identity reader, or authorize identity disclosure explicitly. |
| 002 | Authentication state | PARTIAL | ERA2_RETEST | tool-metadata | sign-in | Fresh attempt with real time budget: navigate `https://chatgpt.com`, read login wall vs composer, record revision. Prior attempt `timedOut: true`, `finishedAt: null`, and states it cannot be treated as an authentication test. |
| 003 | Native thread identity | PARTIAL | ERA2_RETEST | tool-metadata | navigation | `create_conversation` then read `binding.targetId` and native thread identity; no send. |
| 004 | Tab discovery | PARTIAL | ERA2_RETEST_2 | tool-metadata | navigation | Open one non-ChatGPT webapp tab, then re-run `targets` and `chat_index` to prove discrimination. |
| 005 | Chrome-profile isolation | PARTIAL | ERA2_RETEST_2 | tool-metadata | unsupported capability | Needs an explicit profile-verified flag in `doctor`/`agent status`; status alone disclaims proof. |
| 006 | Page readiness | UNSUPPORTED | ERA2_RETEST_2 | tool-metadata | unsupported capability | Needs a readiness signal surface; only signal today is `create_conversation` readiness, which returned `ready: false` reason `BINDING_CHANGED` on 2026-10-28. |
| 007 | Streaming state | UNSUPPORTED | ERA2_RETEST_2 | tool-metadata | send | One authorized send, then observe generating vs finished state. |
| 008 | Ephemeral chat awareness | UNSUPPORTED | ERA2_RETEST_2 | tool-metadata | unsupported capability | No Temporary Chat mode reader exists. |
| 009 | Duplicate-title identity | UNSUPPORTED | ERA2_RETEST_2 | tool-metadata | effect | Requires creating two threads with identical titles, i.e. two sends. |
| 010 | UI obstruction recognition | BLOCKED | ERA2_RETEST_2 | tool-metadata | navigation | Re-run with a live `chatgpt.com` tab bound; the attempt hit `TARGET_SITE_MISMATCH` (exit 5, `effect: none`) against `about:blank`. |
| 011 | New-chat navigation | PASS | ERA2_RETEST_5 | live-browser-observation | none | Do not rerun. Discriminator after the parent restarted Studio: conversation `83d3fcd2` read `state ready`, `readiness {"ready":true,"draft":{"present":false,"chars":0},"reason":null}` on two reads at revision 3, target `D89CFEC580FAB598328983941B9195D9`, 0 turns, nothing sent. The pre-restart `BINDING_CHANGED` + null draft did not reproduce. |
| 012 | Sidebar history selection | PARTIAL | ERA2_RETEST_3 | live-browser-observation | unsupported capability | `chat_index` read 18 rendered links but returns every `displayTitle` with no text; needs a title-text extraction fix. No message observed. |
| 013 | Deep-link navigation | PASS | ERA2_RETEST_3 | live-browser-observation | none | Do not rerun. Exact `/c/` thread loaded as tab `2FB0E3DCFE1F80BCD226B2D8C12FA0EC`; no message observed. Only URL-opening route is `capture`, which also writes a local session. |
| 014 | Cross-thread navigation | UNSUPPORTED | ERA2_RETEST_3 | tool-metadata | unsupported capability | No tab activation/focus primitive; `targets` exposes no visibility field. |
| 015 | Native history search | UNSUPPORTED | ERA2_RETEST_3 | tool-metadata | unsupported capability | No search-input primitive; `chat_index` documents "No search, pagination, creation or click". |
| 016 | Recent-thread recovery | UNSUPPORTED | ERA2_RETEST_3 | tool-metadata | unsupported capability | No navigate-and-return primitive and no MRU/focus field. |
| 017 | Long-thread traversal | UNSUPPORTED | ERA2_RETEST_3 | tool-metadata | unsupported capability | No scroll or message-jump primitive. |
| 018 | Scroll-to-latest | UNSUPPORTED | ERA2_RETEST_3 | tool-metadata | unsupported capability | No scroll primitive (same gap as 017). |
| 019 | Sidebar expansion | UNSUPPORTED | ERA2_RETEST_3 | tool-metadata | unsupported capability | No click/hover/key primitive; all container values read `unknown`. |
| 020 | Archived-history navigation | UNSUPPORTED | ERA2_RETEST_3 | tool-metadata | unsupported capability | No click primitive; settings navigation is outside the current grant. |
| 021 | First-turn delivery | PASS | ERA2_RETEST_2 | provider-response | none | Do not rerun. Gate opened on conversation `4e6bd859` (`state ready`, `readiness.ready true`, revision 3), one send under key `rb-20261028-021` was observed as a new user turn, and the provider reply containing `21` was observed (page text `ChatGPT dijo:\n\n21`, provider parts `["21"]`, assistant `4bfe2638-272c-4b1c-a980-1ee3fdaad370`). |
| 022 | Same-thread follow-up | BLOCKED | baseline | tool-metadata | send | Reconcile 021 first, then one authorized follow-up send on the same thread. |
| 023 | Long-range thread continuity | BLOCKED | baseline | tool-metadata | send | Needs at least three authorized turns in one thread. |
| 024 | Message edit and branch awareness | UNSUPPORTED | baseline | tool-metadata | unsupported capability | No message-edit or answer-branch control exposed by any native tool. |
| 025 | Response regeneration | UNSUPPORTED | baseline | tool-metadata | unsupported capability | No regenerate control exposed. |
| 026 | Interrupt generation | UNSUPPORTED | baseline | tool-metadata | send | Needs a generating answer, and no stop/interrupt primitive exists either. |
| 027 | Generation continuation | UNSUPPORTED | baseline | tool-metadata | send | Needs an interrupted generation plus the site's own resume control. |
| 028 | Conversation branching | UNSUPPORTED | baseline | tool-metadata | unsupported capability | No branch-continuation primitive. |
| 029 | Conversation rename | UNSUPPORTED | baseline | tool-metadata | effect | Rename is an effectful UI action, excluded by the current grant. |
| 030 | Archive mutation | NOT_TESTED | - | none | effect | Archive is an effect with no primitive; excluded. |
| 031 | Multiline payload fidelity | NOT_TESTED | - | none | send | One authorized send containing multiple paragraphs with blank lines. |
| 032 | Unicode editing | NOT_TESTED | - | none | send | One authorized send with accents, emoji, RTL text. |
| 033 | Keyboard send action | NOT_TESTED | - | none | send | Submit via the Enter strategy already used by `drive`/`chat`. |
| 034 | Keyboard newline action | NOT_TESTED | - | none | send | Newline without submit. |
| 035 | Model selection | NOT_TESTED | - | none | unsupported capability | No model-picker control primitive. |
| 036 | Temporary Chat activation | NOT_TESTED | - | none | unsupported capability | No Temporary Chat control primitive. |
| 037 | Speech input | NOT_TESTED | - | none | unsupported capability | No microphone/audio primitive. |
| 038 | Suggestion-chip interaction | NOT_TESTED | - | none | unsupported capability | No click primitive. |
| 039 | Copy action | NOT_TESTED | - | none | unsupported capability | No clipboard-read primitive. |
| 040 | Feedback UI discovery | NOT_TESTED | - | none | unsupported capability | No click/control-inventory primitive. |
| 041 | Long-answer extraction | NOT_TESTED | - | none | send | Needs a completed multi-screen answer. |
| 042 | Role attribution | NOT_TESTED | - | none | send | Needs a mixed user/assistant thread. |
| 043 | List structure | NOT_TESTED | - | none | send | Needs a nested-list answer. |
| 044 | Code block fidelity | NOT_TESTED | - | none | send | Needs a fenced code answer. |
| 045 | Table semantics | NOT_TESTED | - | none | send | Needs a table answer. |
| 046 | Math fidelity | NOT_TESTED | - | none | send | Needs a rendered math answer. |
| 047 | Quotation structure | NOT_TESTED | - | none | send | Needs a blockquote answer. |
| 048 | Hyperlink extraction | NOT_TESTED | - | none | send | Needs a link-bearing answer. |
| 049 | Citation anchoring | NOT_TESTED | - | none | send | Needs a cited/search-assisted answer. |
| 050 | Image-block extraction | NOT_TESTED | - | none | send | Needs an image-bearing answer. |
| 051 | Search-tool activation | NOT_TESTED | - | none | send | Needs one web-search send and proof the action ran. |
| 052 | Source card reading | NOT_TESTED | - | none | send | Needs a search answer with source cards. |
| 053 | Citation-source navigation | NOT_TESTED | - | none | effect | Needs click-through of the source UI. |
| 054 | Tool-panel expansion | NOT_TESTED | - | none | unsupported capability | No expand/click primitive. |
| 055 | Evidence presence | NOT_TESTED | - | none | send | Needs one sourced and one unsourced answer for comparison. |
| 056 | Reasoning mode awareness | NOT_TESTED | - | none | unsupported capability | No mode-selector control. |
| 057 | Reasoning completion | NOT_TESTED | - | none | send | Needs a long reasoning answer to judge completion. |
| 058 | Deep Research discovery | PARTIAL | ERA3_NAV | live-browser-observation | navigation | Capture of `https://chatgpt.com/` completed (`integrityOk true`, 1901 records) and the sidebar text rendered, but no Deep Research entry point appears in the captured text in English or Spanish. Needs a full-page or menu-open read, which requires a click primitive. |
| 059 | Research job monitoring | NOT_TESTED | - | none | navigation | Reopen an existing research task if the account has one. |
| 060 | Research report navigation | NOT_TESTED | - | none | navigation | Navigate report sections and reference links. |
| 061 | File-picker input | NOT_TESTED | - | none | effect | File upload is excluded by the current grant. |
| 062 | Vision-file submission | NOT_TESTED | - | none | effect | Upload excluded. |
| 063 | PDF interpretation | NOT_TESTED | - | none | effect | Upload excluded. |
| 064 | Tabular file analysis | NOT_TESTED | - | none | effect | Upload excluded. |
| 065 | Spreadsheet rendering | NOT_TESTED | - | none | effect | Upload excluded. |
| 066 | Source-file input | NOT_TESTED | - | none | effect | Upload excluded. |
| 067 | File download | NOT_TESTED | - | none | effect | Download excluded. |
| 068 | Attachment preview | NOT_TESTED | - | none | effect | Needs an attachment first; upload excluded. |
| 069 | Image generation result | NOT_TESTED | - | none | send | Needs one image-generation send. |
| 070 | Upload failure detection | NOT_TESTED | - | none | effect | Upload excluded. |
| 071 | Generated-document controls | NOT_TESTED | - | none | send | Needs a generated document from a send. |
| 072 | Writing-artifact surface | NOT_TESTED | - | none | send | Needs a canvas/artifact-producing send. |
| 073 | Artifact edit | NOT_TESTED | - | none | unsupported capability | No artifact-edit primitive. |
| 074 | Data-analysis execution provenance | NOT_TESTED | - | none | send | Needs an executed analysis run. |
| 075 | Tool failure detection | NOT_TESTED | - | none | send | Needs a deliberately failing tool run. |
| 076 | Diagram artifact recognition | NOT_TESTED | - | none | send | Needs a diagram-producing send. |
| 077 | Chart semantics | NOT_TESTED | - | none | send | Needs a chart-producing send. |
| 078 | Input-output provenance | NOT_TESTED | - | none | send | Needs a file-based answer. |
| 079 | Code copying | NOT_TESTED | - | none | send | Needs a code answer, then the native copy control. |
| 080 | Artifact-open navigation | NOT_TESTED | - | none | send | Needs a generated attachment to open. |
| 081 | Project creation | NOT_TESTED | - | none | effect | Project creation is an effect. |
| 082 | Conversation-to-Project move | NOT_TESTED | - | none | effect | Moving a conversation into a Project is an effect. |
| 083 | Project unlink | NOT_TESTED | - | none | effect | Unlinking is an effect. |
| 084 | Project instructions read | NOT_TESTED | - | none | navigation | Read-only Project instructions read. |
| 085 | Project file attachment | NOT_TESTED | - | none | effect | Upload excluded. |
| 086 | Project-specific history | NOT_TESTED | - | none | navigation | Read-only Project thread listing. |
| 087 | Sharing control discovery | NOT_TESTED | - | none | unsupported capability | No share-control reader; publishing is excluded regardless. |
| 088 | Share-link revocation | NOT_TESTED | - | none | effect | Revocation is destructive and needs its own explicit grant. |
| 089 | Memory setting inspection | NOT_TESTED | - | none | navigation | Read-only settings page read; no change. |
| 090 | Personalization settings discovery | NOT_TESTED | - | none | navigation | Read-only settings page read; no change. |
| 091 | Network loss detection | NOT_TESTED | - | none | effect | Needs offline manipulation of the browser. |
| 092 | Session expiration | NOT_TESTED | - | none | sign-in | Needs a real expiry or sign-out cycle. |
| 093 | Target drift | NOT_TESTED | - | none | send | Needs a pending interaction to drift under. |
| 094 | Snapshot freshness | NOT_TESTED | - | none | navigation | Reload the page, then compare captured content against the fresh read. |
| 095 | Runtime reconnection | NOT_TESTED | - | none | effect | Needs a dropped CLI request or a Studio restart. |
| 096 | No-resend reconciliation | NOT_TESTED | - | none | send | Needs an uncertain send, then reconcile with the original key. |
| 097 | Rate-limit detection | NOT_TESTED | - | none | effect | Needs a real quota/rate-limit condition. |
| 098 | Timeout truthfulness | NOT_TESTED | - | none | send | Needs a slow generation to distinguish slow from failed. |
| 099 | Capture provenance | PASS | ERA3_NAV | live-browser-observation | none | Do not rerun. Session `20261028-125034-chatgpt-com-d2a33c` is complete, `integrityOk true`, `collector.sourceSha 5c006ef6a10ef0ed`, url `https://chatgpt.com/c/6ad2b82b-e9bc-83ed-8a38-09a2bbc5f2be`. |
| 100 | Return-to-source continuity | PASS | ERA3_NAV | live-browser-observation | none | Do not rerun. Local transcript (9 turns) reopens from `C:\VIVIM\sessions` and points at the exact `/c/` URL; four transcript phrases also appear in the native DOM text. |

## Summary

Counts by status (100 objectives):

| Status | Count |
|---|---|
| PASS | 5 |
| PARTIAL | 6 |
| BLOCKED | 3 |
| UNSUPPORTED | 18 |
| FEATURE_UNAVAILABLE | 0 |
| NOT_TESTED | 68 |

- Objectives with any attempt: 32. Total attempts recorded: 57.
- `provider-response`: **1** (021 — `ERA2_RETEST_2` observed one authorized send as a new user turn and the provider reply containing `21`, both in the page observation and in the captured session stream as assistant content parts `["21"]`; `reply.completion` stayed `unknown`, so completion rests on the `conversation-turn-complete` event, not on a completion flag).
- `live-browser-observation`: **6** (011 page opened at `https://chatgpt.com/`; 012 18 rendered sidebar links read; 013 thread rendered at its `/c/` URL, title `TOOLSMITH`; 058 sidebar text captured, no Deep Research entry; 099 completed thread captured with `integrityOk true`; 100 local transcript compared against the native DOM text). No provider message in any of the six.
- `tool-metadata`: **25** (001–010, 014–020, 022–029).
- `none`: **68** (030-100, excluding 058, 099 and 100, which now carry attempts).
- `offline-test`: **0**. One unit receipt exists
  (conversation-create, 8/8 pass, exit 0, revision `9560f567`) but it is not scoped to an
  objective, and `reconciliationNotes.verification.liveVerified` is `false`.
- Objectives with **any live observation** (`provider-response` or `live-browser-observation`): **7**.
  Objectives with **zero live observation**: **93**.
- Objectives with **an observed provider response**: **1** (021). Objectives with **zero
  provider response**: **99** — the earlier "zero provider evidence: 96" figure counted the
  three browser-observation objectives as live evidence, which was correct for observation
  but wrong as a provider-response count.

### Run with navigation-only authorization (10, in order)

003, 004, 010, 059, 060, 084, 086, 089, 090, 094

These need browser/tab/thread opening plus read-only tool calls only. No provider send, no
upload, no settings change, no destructive action.

### Needs a send (36, in order)

007, 022, 023, 026, 027, 031, 032, 033, 034, 041, 042, 043, 044, 045, 046, 047, 048,
049, 050, 051, 052, 055, 057, 069, 071, 072, 074, 075, 076, 077, 078, 079, 080, 093, 096,
098

### Needs an effect other than a plain send (21, in order)

009, 029, 030, 053, 061, 062, 063, 064, 065, 066, 067, 068, 070, 081, 082, 083, 085, 088,
091, 095, 097

### Needs a missing harness capability (26, in order)

001, 005, 006, 008, 012, 014, 015, 016, 017, 018, 019, 020, 024, 025, 028, 035, 036, 037,
038, 039, 040, 054, 056, 058, 073, 087

### Needs a sign-in cycle (2)

002, 092

Cross-check: 10 + 36 + 21 + 26 + 2 + 5 (already satisfied: 011, 013, 021, 099, 100) = 100.

## Do not rerun

Evidence is already sufficient; a rerun would spend authorization without adding signal.

- **011 New-chat navigation** — PASS. Conversation `83d3fcd2-1b40-48c1-87d9-d550f38d2d8c`
  read `state ready` with `readiness {"ready":true,"draft":{"present":false,"chars":0},"reason":null}`
  on two reads at revision 3, target `D89CFEC580FAB598328983941B9195D9`, 0 turns, nothing sent.
  The pre-restart `BINDING_CHANGED` with null draft did not reproduce after the Studio restart.
- **021 First-turn delivery** — PASS. Conversation `4e6bd859-f916-4fdd-9c66-12a8a4fbfb81`
  read `state ready` with `readiness {"ready":true,"draft":{"present":false,"chars":0},"reason":null}`
  at revision 3, one send under key `rb-20261028-021` was observed as a new user turn, and the
  provider reply containing `21` was observed: page text `ChatGPT dijo:\n\n21`, assistant
  `4bfe2638-272c-4b1c-a980-1ee3fdaad370`, provider parts `["21"]`.
- **013 Deep-link navigation** — PASS. Exact `/c/6ad2b82b-e9bc-83ed-8a38-09a2bbc5f2be`
  opened as tab `2FB0E3DCFE1F80BCD226B2D8C12FA0EC`.
- **099 Capture provenance** — PASS. Session `20261028-125034-chatgpt-com-d2a33c`,
  `integrityOk true`, `collector.sourceSha 5c006ef6a10ef0ed`, 1155 records, url
  `https://chatgpt.com/c/6ad2b82b-e9bc-83ed-8a38-09a2bbc5f2be`.
- **100 Return-to-source continuity** — PASS. Local transcript of 9 turns reopens from
  `C:\VIVIM\sessions` and points at the same `/c/` URL; `conversation titles can be changed`,
  `AION bus`, `Track B investigation` and `Research result` all appear in both the transcript
  and the captured native DOM text.
- **001 Account identity**, **006 Page readiness**, **012 Sidebar history selection**,
  **014 Cross-thread navigation**, **015 Native history search**, **016 Recent-thread
  recovery**, **017 Long-thread traversal**, **018 Scroll-to-latest**, **019 Sidebar
  expansion**, **020 Archived-history navigation** — the recorded absence of the required
  primitive (account reader, readiness signal, title text, tab activation, search input,
  navigate-and-return, scroll, click) is a harness fact, not a scenario fact. Rerunning
  repeats the same catalog read.

Not on this list: 002, 022, 023, 058 and every `NOT_TESTED` row have unresolved
evidence and would legitimately run again under the right authorization. 059 and 060 are
still `NOT_TESTED` because no research task or completed research report is known to exist,
so their routes have nothing to open.

## Known audit caveats carried from the ledger

- All 29 `baseline` attempts (one per objective 001–029) predate `attemptPhase` and
  `testedRevision`; for 022–029 the current status therefore has no revision anchor. 021
  gained an anchored `ERA2_RETEST` attempt on 2026-10-28 and is no longer unanchored.
- 19 attempts carry an empty `evidenceRefs` array, including the latest attempt of 001 and
  002 and a `PASS` baseline attempt at 005.
- 002's latest attempt is `PARTIAL` on an attempt that `timedOut: true`, has
  `finishedAt: null`, and states it cannot be treated as an authentication test.
- 021's baseline attempt is `PARTIAL` with `timedOut: true` and `finishedAt: null`, reviewed
  after its deadline; its 2026-10-28 `ERA2_RETEST` attempt never reached the send gate and is
  `BLOCKED` on `BINDING_CHANGED`.
- Live results are attributable to the running process, not to HEAD alone: another lane held
  uncommitted edits to `src/capture/*` and `src/studio/conversation-tools.mjs` during the
  first sweep. The 2026-10-28 post-restart attempts were made against a Studio restarted
  after those edits, but the same five files were still uncommitted, so they remain
  attributable to HEAD `9560f567` plus the dirty tree, not to HEAD alone.
- The 058 route left one unfinalized artifact on disk: session
  `20261028-124323-chatgpt-com-bd4b36` reports `status: recording`, `endedAt: null`,
  `integrityOk: null` because an outer 45 second shell timeout killed the CLI before it
  finalized. It is not used as evidence; the recorded 058 attempt is the second run,
  `20261028-124456-chatgpt-com-33ca43`, which finalized with `integrityOk true`.
- `node bin/studio.mjs targets --port 38702 --json` still exits 5 with
  `BROWSER_PROFILE_UNVERIFIED`, while `capture` on the same port opens the browser without
  that error. Target listing through the CLI is therefore unusable even though capture is not.
