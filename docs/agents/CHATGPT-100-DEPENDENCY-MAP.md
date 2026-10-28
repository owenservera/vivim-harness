# ChatGPT 100 — dependency and adjacent-source map

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
