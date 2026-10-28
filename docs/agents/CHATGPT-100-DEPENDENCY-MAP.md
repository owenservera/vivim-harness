# ChatGPT 100 — dependency and adjacent-source map

## 2026-10-28 dependency reconciliation

**Latest-main correction:** `src/capture/conversation-rich.mjs` is wired into `src/capture/conversation-thread.mjs` for bounded read-only DOM parts. Objectives **043–048 and 050** are now **partial** in the [matrix](CHATGPT-100-RECONCILED-STATUS.md), not unsupported; citation anchoring **049** remains unsupported. This is synthetic/source evidence, **not live provider verification**.

The [per-scenario status crosswalk](CHATGPT-100-RECONCILED-STATUS.md) records owners and first missing links for 001–100. All **134 distinct source/test paths explicitly referenced across the three maps** were fetched from `main` during this pass; direct imports/exports and additional discovered transitive source were inspected. A full reverse-caller and dynamic-import closure, exhaustive line-by-line certification, and live proof are **not claimed**.

- **Verified existing capability path:** `src/studio/conversation-tools.mjs:conversation_capsule` → `src/capture/conversation-runtime.mjs:capsule` → `src/capture/conversation-capsule.mjs:buildCapabilityCapsule` → measured profile from `src/profiles/sites/index.mjs`. Existing HTTP route: `src/studio/conversation-api.mjs`. Added one-call recipe in `src/recipes/catalog.mjs`; test additions in `test/unit/conversation-tools.test.mjs` / `test/unit/recipe-catalog.test.mjs` are not executed here.
- **New-chat reuse (already present on latest main):** `create_conversation` → `runtime.connect({site:'chatgpt',freshTab:true})`; one Studio owner, no parallel browser driver.
- Read-only capabilities are descriptive and are not proof that a native ChatGPT feature is available or that a provider effect succeeded.


Generated 2026-10-28 from the repository tree at `c666d3177069f99e1cb39955aec8ad8e2550bae4`. Companion to `CHATGPT-100-SOURCE-MAP.md`.

## Verified direct and adjacent dependencies (2026-10-28 targeted pass)

- `src/capture/thread-identity.mjs:chatgptConversationClaim` → `src/capture/conversation-thread.mjs:parseThread`: **direct dependency** after host-scope consolidation. This fixes a previously unrelated-host identity mint; the native route remains read-only observation, not a send authorization.
- `src/studio/conversation-events.mjs:createConversationEvents` → `textProjection` / `textKey` → runtime `get`: **direct dependency**. Capped SSE snapshots must be keyed against full reply text to detect behind-cap changes.
- `test/unit/thread-identity.test.mjs` and `test/unit/conversation-events-text.test.mjs`: source-level regression coverage added, not proof of local execution or live provider behavior.
- This is a targeted reconciliation, not certification that every referenced file and transitive edge has been reviewed.

## Purpose
The first map identifies direct owners for 100 user objectives. This second map identifies **additional existing source files that may influence those owners**, including entrypoints, shared utilities, indirect dependencies, alternate implementations and integration surfaces. **Candidate ≠ verified import dependency**: inspect actual imports/callers before asserting a dependency or changing behavior.

## Read order and why

| Priority | Additional files | Why read for the 100 |
|---|---|---|
| P0 | `bin/lib/args.mjs`, `bin/lib/capabilities.mjs`, `bin/lib/context.mjs`, `bin/lib/registry.mjs`, `bin/lib/query.mjs`, `bin/lib/util.mjs` | CLI command parsing, discovery, dispatch and agent ergonomics |
| P0 | `src/chrome/browser-ownership.mjs`, `src/core/invariants.mjs` | Existing Chrome ownership, shared safety contracts and no-duplicate-controller behavior |
| P0 | `src/capture/conversation-service.mjs`, `src/capture/conversation-prefix.mjs`, `src/capture/conversation-capsule.mjs`, `src/capture/harness-runs.mjs` | Conversation orchestration, continuity, session context and outcome recording |
| P0 | `src/studio/capabilities.mjs`, `src/studio/commands.mjs`, `src/studio/event-feed.mjs`, `src/studio/recipe-routes.mjs`, `src/studio/agentic-files.mjs` | Actual exposed capabilities, tool routing, live events, recipe routes, file handling |
| P0 | `bin/commands/chat.mjs`, `bin/commands/run.mjs`, `bin/commands/capture.mjs`, `bin/commands/sessions.mjs`, `bin/commands/recipes.mjs`, `bin/commands/system.mjs` | Alternate user-facing commands that might already cover allegedly unsupported scenarios |
| P1 | `src/recipes/choose.mjs`, `src/recipes/plan.mjs`, `bin/commands/selftest.mjs` | Agent-friendly recipe selection and focused verification |
| P1 | `src/profiles/sites/index.mjs`, `src/profiles/apply.mjs`, `src/profiles/manage.mjs`, `src/profiles/model-ops.mjs`, `src/profiles/stream-map.mjs`, `src/profiles/stream-map-induce.mjs` | Selector discovery, profile application, model controls and streaming classification |
| P1 | `src/replay/derive-all.mjs`, `src/replay/stream-components.mjs`, `src/replay/stream-messages.mjs`, `src/replay/stream-role.mjs`, `src/replay/event-id.mjs` | Structured answers, role attribution, replay and evidence provenance |
| P1 | `src/shapes/extract.mjs`, `src/shapes/infer.mjs`, `src/shapes/observation.mjs`, `src/shapes/profiler.mjs` | Potential answer-shape extraction for tables, links, code, images and UI blocks |
| P1 | `src/store/compact.mjs`, `src/store/versioned.mjs`, `src/export/export.mjs`, `src/export/outcome-packet.mjs`, `src/export/saved-session-outcome.mjs`, `src/export/schemas.mjs` | Persisted-session integrity, export and reusable scenario evidence |
| P1 | `src/studio/adapter-probes.mjs`, `src/studio/adapter-studio-bridge.mjs`, `src/studio/adapter-evidence-intake.mjs`, `src/studio/adapter-capture-to-signals.mjs`, `src/studio/adapter-factory-service.mjs`, `src/studio/adaptive-adapter-factory.mjs` | Whether unsupported UI controls can be discovered and incorporated without a second controller |
| P2 | `src/intel/identity.mjs`, `src/intel/temporal-truth.mjs`, `src/intel/continuity.mjs`, `src/intel/search.mjs`, `src/intel/graph.mjs` | Cross-session identity, temporal truth and World search |
| P2 | `src/mcp/runtime.mjs`, `src/mcp/server-stdio.mjs`, `src/mcp/jsonrpc.mjs`, `src/mcp/resources.mjs`, `src/plugins/registry.mjs` | External agent discovery and tool invocation paths |
| P2 | `src/security/patterns.mjs`, `src/studio/four-lane-gates.mjs`, `src/studio/integration-hub.mjs` | Security, effect authorization and cross-surface integration |

## Objective bands to investigate
- 001–010: browser ownership, profile management, session identity, capabilities.
- 011–030: chat CLI, conversation service, recipe routes, thread continuity, UI actions.
- 031–040: model ops, profile controls, CLI command interfaces.
- 041–050: shapes extraction, replay stream components and message roles.
- 051–060: profile stream mapping, adapter probes and model ops.
- 061–070: agentic files, capture, export and security.
- 071–080: shapes, replay, exports, Studio integration.
- 081–090: conversation service, identity, World/search, Studio routes.
- 091–100: browser ownership, event feed, invariants, versioned storage and outcome packets.

## Required dependency verification
1. Read each P0 candidate; inspect imports and callers in both directions.
2. Read P1/P2 files when connected to an objective or discovered import path.
3. Classify each candidate: **direct dependency**, **indirect dependency**, **alternate implementation**, **related but unused**, or **irrelevant**.
4. Record exact functions/call sites, not just filenames.
5. Follow transitive dependencies outside this candidate list as necessary; this list is a starting set, not a closed boundary.
6. Amend the primary source map when a supposedly unsupported objective already has an actual usable implementation.

## Scope accounting
At the tree snapshot, 66 explicitly referenced files and 128 additional `.mjs`/`.js`/`.json` files were identified under `src/`, `bin/`, and `profiles/`. The additional set includes provider-specific modules and unrelated subsystems; do **not** treat all 128 as mandatory reads or as confirmed dependencies.

## 2026-10-28 — verified direct UI observation chain (partial audit)

- `src/profiles/sites/chatgpt.mjs` provides `assistant.streamingSelectors` and `send.buttonSelectors`; these are now passed by `src/capture/conversation-browser-adapter.mjs::readTranscript` to `src/capture/conversation-thread.mjs::transcriptExpression`. `boundTranscript` retains a conservative, source-labelled UI controls summary.
- Callers: `src/capture/conversation-runtime.mjs::read` → adapter read, `src/studio/conversation-tools.mjs::read_conversation` → same owner runtime; `src/studio/conversation-api.mjs` has the POST /read surface.
- Focused test source: `test/unit/conversation-thread.test.mjs`. This establishes only these code-level import/call relationships; other P0–P2 candidate classification and complete transitive review remain open.

## Verified dependency relationships — audit 2026-10-28

The initial three maps referenced **132 unique source/config paths**; all 132 were fetched from GitHub and their source inspected for imports, exports and runtime owners during this audit. Additional connected modules were opened, including `src/capture/conversation-rich.mjs`, `src/intel/correlate.mjs`, `src/intel/join.mjs`, `src/intel/history.mjs`, `src/intel/schema.mjs`, `src/intel/similarity.mjs`, `src/intel/discover.mjs`, `src/intel/learn.mjs`, `src/intel/platform.mjs`, `src/decode/proto-features.mjs`, `src/decode/protobuf.mjs`, `src/studio/adapter-learning-pipeline.mjs`, `src/studio/systems-probes.mjs`, `src/studio/world-url.mjs`, `src/studio/world-transfer.mjs`, and `src/export/graph-ranked.mjs`. **This is not a certification of every recursive import reachable from all unrelated subsystems**; other recursive helper edges remain outside the verified ledger.

| Classification | Verified files and dependency relationship | Relevance |
|---|---|---|
| Direct CLI/native dependency | `bin/commands/tools.mjs` → `src/studio/tool-client.mjs` → `src/studio/conversation-tools.mjs` (`executeConversationTool`) → `src/capture/conversation-runtime.mjs` | Existing Studio owner and named tools |
| Direct creation path | `create_conversation` (`src/studio/conversation-tools.mjs`) → `runtime.connect({site:'chatgpt',freshTab:true})`; HTTP in `src/studio/conversation-api.mjs` | 011: new Studio-owned blank chat without send |
| Direct browser/send path | `src/capture/conversation-runtime.mjs` → `src/capture/conversation-browser-adapter.mjs` → `src/capture/actions.mjs` → `src/cdp/client.mjs`, `src/cdp/discovery.mjs` | Turn submission, thread fence, reconciliation |
| Direct native read path | `src/capture/conversation-thread.mjs` `transcriptExpression` → `src/capture/conversation-rich.mjs` `richPartReaderSource` / `boundRichParts` → `read_conversation` | 041–050 partial live semantic extraction |
| Direct capture/persistence path | `src/capture/recorder.mjs` → `src/capture/dom.mjs` / `src/capture/page-agent.js` / `src/capture/network.mjs` → `src/store/session.mjs` → `src/replay/derive.mjs` | Session evidence and recoverable World data |
| Browser ownership | `src/chrome/launch.mjs` → `src/chrome/browser-ownership.mjs`; serialization via `src/capture/drive-lease.mjs` | Prevent duplicate CDP owner |
| Alternate implementation | `bin/commands/drive.mjs` → `src/capture/actions.mjs` `driveSite`; `bin/commands/chat.mjs`, `bin/commands/run.mjs`, `src/recipes/service.mjs` | Alternate dispatch does not imply all native tools are exposed |
| Related, not ChatGPT browser effect | `src/studio/agentic-files.mjs` (agent context files), `src/profiles/model-ops.mjs` (profile settings), `src/shapes/extract.mjs` (record selector extraction) | Do not misclassify as web upload/model selection/interaction |
| Related replay/semantic support | `src/replay/stream-components.mjs`, `src/profiles/stream-map.mjs`, `src/shapes/observation.mjs` | Structured saved evidence, not necessarily a live control |

**Remaining blocking categories:** browser-only UI controls (upload, feedback, projects, settings, research panels), incomplete rendered/offscreen coverage, missing durable send-journal integration in legacy `driveSite`, and unverified real ChatGPT feature availability. No Playwright/Puppeteer or secondary browser controller was added.

## 2026-10-28 — mandatory source-reading and dependency classification checkpoint

**Verified source inventory:** 132 distinct files explicitly referenced across the three maps were fetched in full and inspected for imports/exported functions. The **40 additional** related/imported files below were also opened (172 total). This ledger means source text was retrieved, NOT that 172 modules passed Node tests or that every runtime/dynamic import is reachable; browser calls were not executed. The new concurrent `src/capture/conversation-rich.mjs` and its fixture `test/unit/conversation-rich.test.mjs` were separately inspected.

### Additional files actually read

- `bin/lib/ui.mjs`
- `src/capture/campaign.mjs`
- `src/intel/platform.mjs`
- `src/intel/rank.mjs`
- `src/intel/correlate.mjs`
- `src/decode/csv.mjs`
- `src/decode/protobuf.mjs`
- `src/decode/proto-features.mjs`
- `src/export/graph-ranked.mjs`
- `src/export/capabilities.mjs`
- `src/intel/history.mjs`
- `src/intel/similarity.mjs`
- `src/intel/schema.mjs`
- `src/intel/corpus.mjs`
- `src/intel/discover.mjs`
- `src/intel/learn.mjs`
- `src/intel/join.mjs`
- `src/studio/adapter-holdout-gate.mjs`
- `src/studio/adapter-improvement-pipeline.mjs`
- `src/studio/adapter-learning-pipeline.mjs`
- `src/studio/systems-probes.mjs`
- `src/studio/platform-x.mjs`
- `src/studio/webhooks.mjs`
- `src/intel/autodetect.mjs`
- `src/intel/graph-analytics.mjs`
- `src/profiles/migrations.mjs`
- `src/intel/statistics.mjs`
- `src/mirror/index.mjs`
- `src/intel/priors.mjs`
- `src/intel/learner-journal.mjs`
- `src/studio/adapter-accepted-session.mjs`
- `src/profiles/sites/claude.mjs`
- `src/profiles/sites/gemini.mjs`
- `src/mirror/catalog.mjs`
- `src/mirror/match.mjs`
- `src/mirror/template.mjs`
- `src/mirror/replay.mjs`
- `src/mirror/synthesize.mjs`
- `src/mirror/ws.mjs`
- `src/intel/profile-evidence.mjs`

### Verified dependency roles and first missing edges

| Classification | Files and observed entry/call sites | Effect on objectives |
|---|---|---|
| Direct runtime dispatch | `bin/commands/tools.mjs::runToolsCall` → `src/studio/tool-client.mjs::call` → `src/studio/integration-hub.mjs::registerConversationTools` → `src/studio/conversation-tools.mjs::executeConversationTool` → `src/capture/conversation-runtime.mjs` | Same Studio owner, no alternate browser. New `create_conversation` maps to `runtime.connect({site:'chatgpt',freshTab:true})` (011) |
| Direct native HTTP dispatch | `src/studio/server.mjs` → `src/studio/conversation-api.mjs::createConversationApi` → `runtime.connect/read/submit/reconcile/finish` | Native create route, read and submit share the same runtime owner; request schemas still independently validated |
| Direct live DOM read | `src/capture/conversation-runtime.mjs::read` → `src/capture/conversation-browser-adapter.mjs::readTranscript` → `src/capture/conversation-thread.mjs::transcriptExpression` → `src/capture/conversation-rich.mjs::richPartReaderSource` → `boundTranscript` | 007, 041–050 are at most bounded page-visible observations; not full content-provenance claims |
| Direct capture and journal | `src/capture/conversation-browser-adapter.mjs::armCapture` → `src/capture/recorder.mjs::start` → `src/capture/dom.mjs::DomObserver` → `src/capture/page-agent.js::blocks/turns` and `src/store/session.mjs`; `src/capture/conversation-service.mjs` → `src/capture/thread-turn-journal.mjs` | Capture persistence and 093/096 no-resend proof sources; structured block URLs now honor filtered privacy mode |
| Alternate implementation | `bin/commands/drive.mjs` → `src/capture/actions.mjs::driveSite`; `bin/commands/chat.mjs` creates a one-shot conversation runtime | Useful single-turn or deep-link code, but NOT the persistent existing Studio conversation owner used for 100-scenario continuity |
| Indirect storage/derived evidence | `src/replay/derive.mjs` → `src/shapes/extract.mjs`, `src/replay/stream-components.mjs`, `src/decode/decoders.mjs`; `src/studio/world-service.mjs` → `src/studio/world-search.mjs` and transfer/relations | Existing offline reconstruction; does not grant a live UI action or prove 099–100 recovery |
| Related but unused for native ChatGPT action | `src/capture/human.mjs::humanScroll`; `src/profiles/model-ops.mjs::applyModelOp`; `src/studio/agentic-files.mjs::createAgenticFileLibrary`; `src/studio/adapter-probes.mjs` | Scroll exists without named owner tool; local model/profile ops are not ChatGPT model selection; local file library is not a provider upload |
| Related security/intelligence but not effect authorization | `src/studio/core-runtime-bridge.mjs`, `src/studio/four-lane-gates.mjs`, `src/intel/identity.mjs`, `src/intel/temporal-truth.mjs`, `src/mcp/runtime.mjs` | Useful gates/derivation, but no unseen browser capability can be inferred solely from their imports |

**Unfinished dynamic boundaries (explicitly blocked):** runtime-created CDP pages and origin-specific DOM selectors cannot be source-verified against a live ChatGPT tab from the GitHub connector; implicit dynamic imports and non-JS assets outside the three maps are not certified exhaustive. Test fixture presence does not imply tests executed. No second driver or browser was created.

## 2026-10-28 — direct rich-read dependency and mapped coverage

**Direct import:** `src/capture/conversation-thread.mjs` imports `richPartReaderSource` and `boundRichParts` from `src/capture/conversation-rich.mjs` (new source). `transcriptExpression` uses the embedded pure DOM reader; `boundTranscript` validates and bounds rich parts and carries an incomplete-coverage receipt. `src/capture/conversation-browser-adapter.mjs::readTranscript` evaluates this expression on the *existing* CDP-attached page; `src/capture/conversation-runtime.mjs::read` confirms exact live binding before responding; `src/studio/conversation-tools.mjs::read_conversation` and `src/studio/conversation-api.mjs` expose the operation. These are **direct dependencies**, not merely adjacent names. There is no new CDP or browser actor.

**Alternate implementations, not interchangeable:** `bin/commands/drive.mjs` → `src/capture/actions.mjs::driveSite` is a one-shot drive, not Studio-owned persistent conversation navigation; `bin/commands/chat.mjs` creates a separate one-shot lifecycle; `src/shapes/extract.mjs`/replay shapes operate on captured/assembled data, not ChatGPT's native control UI; `src/studio/agentic-files.mjs` manages local Studio assets, not a native ChatGPT file picker; `src/profiles/model-ops.mjs` operates profile state, not ChatGPT model selection. Do not promote corresponding objectives.

**Mapped read accounting:** 132 distinct primary references in `src/`, `bin/`, `profiles/` fetched; an additional 12 transitive modules fetched (`bin/lib/ui.mjs`, `src/capture/campaign.mjs`, `src/intel/{similarity,history,learn,correlate,schema,join,discover}.mjs`, `src/studio/{adapter-holdout-gate,adapter-improvement-pipeline,systems-probes}.mjs`). Each was inspected for declared import/export relationships; not every function body and reverse caller has received exhaustive inspection. This is a **partial**, not completed transitive audit. See [scenario-level source ledger](CHATGPT-100-AUDIT-LEDGER-2026-10-28.md).

## 2026-10-28 classified dependencies after full map retrieval

The three companion maps explicitly referenced **132 distinct** `bin/`, `src/` and `profiles/` source/config files at retrieval time; all 132 were fetched in full at pinned ancestors, not inferred from filenames. An additional **24 imports** were fetched outside that reference set. This is **not** an exhaustive transitive closure, fixture test run, or 100-scenario live proof.

| Imported symbol / caller | Dependency classification | Effect on ChatGPT capability truth |
|---|---|---|
| `conversation-thread.transcriptExpression` imports `conversation-rich.richPartReaderSource`; `boundTranscript` calls `boundRichParts` | **Direct dependency**, newly integrated | Bounded current-page semantic DOM reader for lists, code, table cells, quote, link, citation candidate, image, math; incomplete/provisional for 043–050 |
| `conversation-browser-adapter.readTranscript` → `conversation-thread.transcriptExpression` + ChatGPT profile streaming/send selectors → `conversation-runtime.read` → registered `read_conversation` | **Direct executable read path** | Same Studio/CDP owner, no new driver or send; controls are observed busy/idle/unknown, not completion |
| `integration-hub` `GET /sessions/{session}/observation` → `shapes/observation.observeSession` + `buildObservation` | **Alternate saved-capture read path** | Typed network/DOM carrier observations with source references; no live native UI action |
| `profiles/model-ops.applyModelOp` → capture profile/model editor | **Related but not ChatGPT capability** | Not the ChatGPT model picker; #035 still unsupported |
| `studio/agentic-files.createAgenticFileLibrary` / `registerAgenticFileRoutes` | **Related but not ChatGPT capability** | Read-only local AGENTS/CLAUDE/SKILL inventory; no native ChatGPT upload; #061–070 not closed |
| `studio/ui/universal-chat.renderNativeBlock` | **Read-only local UI presentation** | Displays semantic parts, not ChatGPT artifact edit/open, copy, generated-file download |
| `export/export.mjs`, `store/session.mjs`, `world-service` | **Indirect persistence/export** | VIVIM-local evidence export/search, not browser-native ChatGPT generated file workflow |
| `thread-identity.chatgptConversationClaim` → `conversation-thread.parseThread` | **Direct identity dependency** | Restricts verified native route identity to canonical HTTPS ChatGPT hosts; no generic-host false claim |
| `conversation-events.createConversationEvents` → `textProjection` / `textKey` | **Direct event read-model** | Same-length tail edits behind the SSE wire cap generate a new bounded snapshot; no implied terminal completion |

Known unclosed dependency groups include the dynamic/conditional downstream branches of `src/capture/actions.mjs`, `src/studio/server.mjs`, `src/replay/derive.mjs`, and transitive scoring/decode/plugin plumbing. All 100 *source-availability* classifications are in `CHATGPT-100-GAP-MAP.md`; automated CI jobs failed before recording test steps and no new live run was performed.
