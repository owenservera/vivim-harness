# Provider-native shape contract — Claude WEB (`claude-web-shapes/1`)

**Version 1 · 2026-10-24 · status: NO durable multi-turn harness support is claimed; every authenticated surface is `unverified` or `unknown` until observed on an authorized page.**
Evidence vocabulary: `SOURCE` (repo/recorded data) · `SYNTHETIC` (fixtures/tests) · `REAL` (live page receipt) · `PRODUCT` (official docs only) · `UNKNOWN`.
Governing authority remains Capture Studio `ARCHITECTURE.md`; specialist contract vocabulary in `roles/14-webapp-native-harness/CONTRACTS.md`.

## 1. Identity grammar

| Object | Shape | Evidence | AION source |
| --- | --- | --- | --- |
| Durable thread | **not integrated** — org-scoped `chat_conversations_v2` metadata with `current_leaf_message_uuid` observed historically, but no accepted durable page binding | SOURCE (recorded atlas) + UNKNOWN (live) | none — `THREAD_SITES=['chatgpt']` deliberately excludes claude |
| Message id | candidate uuid fields in recorded metadata; no verified rendered-message identity | SOURCE leads only | none |
| Project / parallel threads | Claude projects + new project model with parallel threads | PRODUCT | not integrated |
| Guest/anonymous | no guest surface documented | UNKNOWN | never elevated |

**Invariant (bench E03):** no Claude identity may be borrowed from the ChatGPT `/c/<uuid>` grammar, from titles, ordinals or leaf-message text. Until a measured parser exists, every Claude conversation projection reads `binding:'unverified', nativeRef:null`.

## 2. Transports and stream shapes

| Shape | Detail | Evidence |
| --- | --- | --- |
| Reply carrier | `/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline` — Connect/protobuf-like framing | SOURCE (recorded atlas: 11 sessions, 31 streams, 3 chat-looking endpoints) |
| Decode capability | schema-less Connect/proto wire inspection exists; candidate text field `1.1.5.9` from a small repetitive sample — **hypothesis, not a confirmed parse** | SOURCE (`src/decode/protobuf.mjs`, `proto-features.mjs`, `scripts/proto-field-search.mjs`) |
| Declarative map | `claude-typed-events` stream map (typed events dialect) exists for the SYNTHETIC fixture | SYNTHETIC (`test/fixtures/ai-chat-dialects/claude-typedevents.json`, 13 payloads; `src/profiles/stream-map.mjs`) |
| Verified live reply reconstruction | **none** — no confirmed live full reply parse, no reliable DOM↔stream correlation | UNKNOWN — the headline asymmetry vs ChatGPT |
| Other carriers | EVENT_SOURCE / HTTP_STREAMED in family metadata | SOURCE (recorded atlas) |

**Standing rule:** observed private RPC endpoints are stream-shape forensic clues; never dispatched for authenticated effects. Supported operation is visible page UI through the single Studio browser authority.

## 3. Content parts observed vs documented

| Part | Native evidence | Projection |
| --- | --- | --- |
| Prose / markdown / code / tables | SOURCE for recorded field leads; SYNTHETIC for the typed-events map | `text`/`markdown`/`code` reserved; stream-side build unproven on real traffic |
| Thinking indicator + expandable summaries | PRODUCT | `visible-thinking-summary` reserved; never equated to private reasoning |
| Research + citations | PRODUCT (cited results, research outputs) | `citation`/`reference` reserved; same-generation provenance required |
| **Artifacts** (documents, designs, interactive apps; versions, revisions) | PRODUCT | first-class `artifact` + `ArtifactVersion` nodes reserved; ChatGPT writing blocks are a DIFFERENT shape — no cross-provider conflation |
| Cowork tasks (parallel subtasks, deliverables) | PRODUCT | first-class task/activity/progress nodes; not one assistant message |
| Files/attachments in+out | PRODUCT | `file` part + digest + source linkage required before projection |

## 4. Action surfaces (capability capsule semantics)

| Action | Availability today | Gate evidence |
| --- | --- | --- |
| Read rendered transcript | unverified | `src/profiles/sites/claude.mjs` carries measured selectors + auth-wall heuristics; no verified transcript reader end-to-end |
| Keyed send / follow-up | unavailable | no durable thread binding → the runtime's own `THREAD_IDENTITY_UNVERIFIED` gate refuses; the capsule reports exactly that |
| Model/mode, artifact open/export, Cowork control | unavailable/unverified | no observed controls; no readback |
| Auth wall detection | supported | profile `authWall` heuristics; sandbox claude.ai is login-walled (200 + wall, Round-3 receipt) |

## 5. Executable contract tests

- Typed-events map + fixture: `test/unit/stream-map.test.mjs`, `ai-chat-dialects.test.mjs` · Connect/protobuf decode: `test/unit/protobuf.test.mjs`, `connect-proto-decoder.test.mjs` · identity refusal: `test/unit/observation.test.mjs` (claude URL stays `unverified`) · capsule refusal: `test/unit/conversation-capsule.test.mjs`.

## 6. Gaps (the honest headline)

1. **Reply reconstruction unproven** — the Connect/protobuf text-field hypothesis is the single highest-value Claude experiment (bench B03/Tier-1) on an authorized page.
2. **No durable thread identity** — blocks every multi-turn harness operation (H02/H03 lanes).
3. Artifacts/Cowork/research: PRODUCT-only.
4. Fresh observations require an authorized Claude page (owner runtime); sandbox IP is login-walled — recorded, not bypassed.
