# Provider-native shape contract — ChatGPT WEB (`chatgpt-web-shapes/1`)

**Version 1 · 2026-10-24 · status: implementable for the surfaces marked `supported`; everything else is labeled, not assumed.**
Evidence vocabulary: `SOURCE` (repo/recorded data) · `SYNTHETIC` (fixtures/tests) · `REAL` (live page receipt) · `PRODUCT` (official docs only) · `UNKNOWN`.
Governing authority remains Capture Studio `ARCHITECTURE.md`; the specialist contract vocabulary lives in `roles/14-webapp-native-harness/CONTRACTS.md`.

## 1. Identity grammar

| Object | Shape | Evidence | AION source |
| --- | --- | --- | --- |
| Durable thread | `/c/<uuid>` → `chatgpt-c:<uuid>` | SOURCE + SYNTHETIC | `src/capture/conversation-thread.mjs` (`THREAD_SITES=['chatgpt']`) — the one source-supported durable parser |
| Message id | `data-message-id` attribute on rendered turns | SOURCE | `src/profiles/sites/chatgpt.mjs`, DOM agent role scan |
| Branch/generation | edit/regenerate produces sibling generations under one conversation | PRODUCT | no AION-native parse; `harness-runs` records AION-side attempts only |
| Account/project/workspace | `/g/…` project URLs, account-scoped sidebars | PRODUCT | not integrated; open tabs are NOT an account index (`chatgpt-chat-index.mjs` is candidates-only) |
| Guest/anonymous | none observed usable | UNKNOWN | never elevated from URL query or title |

**Invariant (bench E03):** title, ordinal, timestamp and text similarity are never identity. The conversation observation envelope surfaces `nativeRef` only through the supported parser; everything else stays `binding:'unverified', nativeRef:null`.

## 2. Transports and stream shapes

| Shape | Detail | Evidence |
| --- | --- | --- |
| Reply carrier | `POST /backend-api/f/conversation` — path-ops over SSE | SOURCE (recorded atlas: 26 sessions, 47 streams, 9 chat-looking endpoints) + SYNTHETIC (`test/fixtures/ai-chat-dialects/chatgpt-pathops.json`, 8 payloads) |
| Dialect | JSON path-ops (`add`/`append` at dotted paths), also `json-patch`/`dotted-set` seen | SOURCE + SYNTHETIC — `src/profiles/stream-map.mjs` id `chatgpt-path-ops` |
| Component build | `message` opens on message_start; `paragraph` opens/appends on text parts | SYNTHETIC — `applyStreamMap` contract, `src/replay/stream-components.mjs` |
| History/config | `/backend-api/conversations/{id}` message records with author roles, channels, content parts, references, metadata | SOURCE (recorded atlas field paths) — forensic context only; **never dispatch against it** |
| Other carriers | WS + UNKNOWN transports present in the recorded family | SOURCE |

Negative fact retained: the historical DOM old-extractor join was **0/60** assistant turns; synthetic extractor fixes are not real-site join proof (`src/intel/join.mjs` statuses stay the authority).

## 3. Content parts observed vs documented

| Part | Native evidence | Projection (`aion.web-observation/1`) |
| --- | --- | --- |
| Prose paragraphs | SYNTHETIC (path-ops text deltas) | `text` via `paragraph` component |
| Headings/lists/tables/code/quotes/images/files/citations/equations | SOURCE (DOM block enum, `DOM_COMPONENT_MAP`) | identity kept; stream-side build currently `paragraph`-only — gap recorded as loss marker |
| Writing blocks / interactive canvas | PRODUCT | `interactive-native`/`unknown-native` with loss marker until observed |
| Visible reasoning summaries | PRODUCT (model/mode-dependent) | `visible-thinking-summary` part type reserved; no hidden-reasoning claim permitted |
| Citations/search | PRODUCT; historical reference fields SOURCE | `citation`/`reference` reserved; requires same-generation provenance before projection |
| Work tasks (stages/deliverables) | PRODUCT | first-class `progress`/`tool-activity-observed` nodes; never collapsed into one assistant message |

## 4. Action surfaces (capability capsule semantics)

| Action | Availability today | Gate evidence |
| --- | --- | --- |
| Read exact thread (zero-send) | supported | `runtime.read` — bounded transcript, live attachment, verified identity |
| Keyed first turn / follow-up | supported (gated) | exact thread binding + confirm/revision/durable-key + per-turn capture; freshness baseline enforced (Round 4, `7e19a0f0`) |
| Reconcile / finish / close owned tab | supported | existing runtime operations |
| Model/mode change, branch, regenerate, artifact export | unavailable/unverified | no measured selection readback; `aion.capability-capsule/1` reports the exact reason |

## 5. Executable contract tests (all green at head)

- Identity: `test/unit/conversation-thread.test.mjs` · freshness: `test/unit/acceptance-baseline.test.mjs` (G1/G2 baseline matrix) · stream map: `test/unit/stream-map.test.mjs` + `stream-components` · projection/identity: `test/unit/observation.test.mjs` · capsule: `test/unit/conversation-capsule.test.mjs` · safe effects: `test/unit/conversation-m2.test.mjs`, `thread-turn-journal.test.mjs`.

## 6. Gaps (explicit, not hidden)

1. Stream-side component building covers only `message`/`paragraph` — the richer DOM enum is not yet produced from real path-ops streams (SYNTHETIC gap).
2. No real-site DOM↔stream join receipt on a fresh authenticated reply (historical 0/60).
3. Artifacts, branches, projects: PRODUCT-only; no AION observation receipts.
4. All authenticated live work requires the owner's Windows runtime; sandbox guest access is provider-blocked (duck.ai anonymous-code 02f8 receipt).
