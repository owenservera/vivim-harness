# VIVIM Harness — full file map

This is a navigation guide, **not a live-provider acceptance report**. The companion
[`FILE-MAP.json`](FILE-MAP.json) enumerates the working tree: tracked files, non-ignored
untracked source files, and these two map outputs. More than 200 test files are grouped
by directory, with every member path retained. No private conversation or credential
contents were read to produce the local-data directory list.

## How to read the machine map

- `area` comes from the first matching component in `architecture/components.json`, the
  same ownership manifest read by `scripts/architecture-inventory.mjs`. `areas` retains
  overlaps: Studio belongs to both experience and adapter evolution; capture belongs
  to runtime, network and native-page observation. Do not sum overlapping area totals.
- `lane` follows `lanes.owns` in `docs/product/USER-SCENARIOS-100.json`: **A** provider
  and conversation runtime, **B** UI/mobile/Android, **C** agent/app builder/platform.
  `null` means no explicit glob owns that path, not permission to edit it. A's three
  command modules take precedence over C's “bin except A-owned” rule.
- `scenarios` is an exact reverse lookup of `scenarios[].files.existing`; it is not
  inferred from imports or proof that a scenario is implemented.
- `exports` and literal local JavaScript imports are parsed without executing modules.
  `importedBy` includes source, scripts and tests, even though tests are summarized.
  Computed imports, HTML module tags, injected page scripts and Java references are not
  ordinary ES import edges. Candidate orphans therefore need manual confirmation.
- `lastCommit` is the most recent committed hash and subject touching a path. Current
  uncommitted bytes may differ. The two new outputs have no earlier commit at generation.
  Binary files have `lines: 0`. Each source file was opened by the inventory generator;
  source purposes were checked against its header/declarations/exports and corrected.
- HTTP rows enumerate registrations, not just distinct public URLs. The direct
  conversation API runs before the hub's same-URL tool registrations. Legacy `ANY`
  means the branch does not constrain the verb; it is **not** a recommendation to mutate
  through GET. Host, Origin and optional token checks run before dispatch.

## Directory tree

```text
vivim-harness/
├── bin/                         Native CLI entry point, registry and command modules
│   ├── commands/                Thin command-to-engine bindings; explicit effect flags
│   └── lib/                     Argument parsing, help, output, query and context helpers
├── src/                         Shared runnable product engines
│   ├── agents/                  Local Personal Agent identity, memory, Work and continuity
│   ├── capture/                 Conversation lifecycle, browser seam, capture and send journals
│   ├── cdp/                     Loopback DevTools discovery and protocol connections
│   ├── chrome/                  Dedicated Chrome launch and browser identity ownership
│   ├── core/                    Executable invariants and correctness boundaries
│   ├── decode/                  Streaming protocol, protobuf, delta and CSV decoding
│   ├── export/                  Transcript/dataset/graph/schema/bundle and outcome outputs
│   ├── families/                Provider-family normalization and cross-provider shape libraries
│   ├── intel/                   Inference, discovery, search, learning, ranking and temporal graph
│   ├── mcp/                     Stdio JSON-RPC server over the shared integration/tool runtime
│   ├── mirror/                  Captured endpoint matching and timed local replay server
│   ├── plugins/                 Deterministic plugin registry
│   ├── profiles/                Versioned capture profiles, migrations and streaming maps
│   │   └── sites/               Built-in provider selectors and dynamic adapter registry
│   ├── recipes/                 Declarative recipe catalog, choice, planning and orchestration
│   ├── replay/                  Offline derivation, reducers, stream roles and components
│   ├── security/                Optional secret/PII pattern engine
│   ├── shapes/                  Extraction, schema profiling and observation projections
│   ├── store/                   Raw logs, sessions, integrity and versioned JSON persistence
│   ├── studio/                  Single HTTP server, hub, routes and product services
│   │   └── ui/                  Chat/world, mobile PWA, Personal Agent and legacy dashboards
│   └── config.mjs               Settings, source version, data-root and path contracts
├── android/                     Native Android WebView shell and Gradle-free APK build
│   ├── src/inc/vivim/app/        MainActivity pairing, navigation and recovery
│   └── res/                     Application labels, colors and adaptive launcher icon
├── scripts/                     Explicit operator tools, diagnostics and source inventories
│   └── windows/                 One-click start/stop, launch helper and shortcut installation
├── architecture/                Component ownership and source-extraction manifests
├── docs/                        Product, architecture, operator and historical evidence docs
│   ├── agents/                  CLI objectives, live ledgers and source/evidence crosswalks
│   ├── architecture/            Architecture decisions, startup guidance and this file map
│   ├── product/                 Scenario catalog, scope/ownership and product contracts
│   ├── research/                Historical engineering research and measurements
│   ├── session/                 Current owner goal and session direction
│   ├── shape-atlas/             Saved protocol/shape survey documentation
│   ├── sprints/                 Sprint plans and execution records
│   ├── superpowers/             Design/implementation planning documents
│   └── track/                   Workstream notes and tracking evidence
├── test/                        Offline regression suites and synthetic fixtures (summarized)
├── eval/                        Evaluation specifications and reproducible scoring artifacts
├── profiles/                    Seed capture-profile JSON, not Chrome user-data profiles
├── families/                    Committed provider-family shape data
├── marketing/                   Public landing-page material
├── assets/                      Committed product artwork
├── ui-preview/                  Standalone visual/reference previews, not Studio's served UI
├── .opencode/agents/            Repository agent-role instructions
└── root files                   package.json, opencode.json, README, AGENTS, context and plans
```

## End-to-end request flows

### Existing Studio owner: tools, recipes and product UI

```text
bin/studio.mjs → bin/commands/{tools,recipes,run}.mjs
  → src/studio/tool-client.mjs → existing Studio HTTP server
src/studio/ui/{chat,mobile,world-view}.mjs → same-origin HTTP ─┘
  → src/studio/server.mjs (Host/Origin/token; single runtime construction)
  → src/studio/integration-hub.mjs (/api/v1 registry and tool manifest)
  → {conversation-tools,recipe-routes,harness-api,personal-app-routes,...}.mjs
  → product services → shared src/capture/conversation-runtime.mjs
  → conversation-service.mjs (lifecycle state) + thread-turn-journal.mjs (send fences)
  → conversation-browser-adapter.mjs → cdp/client.mjs → dedicated Chrome provider tab
  → recorder.mjs → store/session.mjs → replay/derive.mjs → API snapshot/SSE → UI
```

The direct `/api/v1/conversations*` handler in `conversation-api.mjs` precedes hub
dispatch and delegates to the same runtime. The diagram is a shared ownership chain,
not a claim that every URL passes through every box. `studio chat` is a one-shot
runtime lifecycle, not an HTTP client: `commands/chat.mjs → launchChrome →
defaultConversationRuntime → connect/submit/poll/finish`. Do not run it as a competing
browser actor beside an existing effect owner. Historical `drive` and recording tools
also have their own explicit entry points; the map does not grant send authorization.

### Personal Agent, app creation and provider comparison

```text
Personal Agent UI/CLI → personal-agent-routes → agents/personal-agent-service
  → bootstrap / memory-search / work / self-knowledge / continuity → versioned local JSON

World/mobile UI → personal-app-routes → personal-app-service + personal-app-blueprint
  → inert screen scaffold + personal-app-content → mobile trusted component renderer
Design with my AI → personal-app-ai-design job → shared conversation runtime
  → observed provider reply → personal-app-provider-reply → preview → explicit approval/CAS

Compare UI → compare-routes → compare-service → shared conversation runtime → provider tabs
  → compare-jobs metadata/results; cancellation does not authorize a replacement send
```

Personal Agent Work is local durable planning, not an autonomous permission grant.
Stored-reply bridges consume already observed replies; a blueprint is declarative data,
not arbitrary installed or executable app code.

### Capture, reconstruction, search and interoperability

```text
CDP Network/DOM → capture/network + dom + isolated page-agent → recorder
  → store/raw-log + session datasets/KV → replay/reducer → decode/*
  → replay/derive[-all] → shapes + intel + families → saved observation/knowledge
  → world-service → world-search / world-transfer → world/mobile UI
  → export/* → transcripts, datasets, bundles, schemas, ranked graphs
  → mirror/* → optional loopback-only timed replay of captured exchanges
MCP stdio → mcp/server-stdio → mcp/runtime → same integration contracts
```

## Areas and key entry points

| Area | Key entry points | Change boundary / normal flow |
|---|---|---|
| experience | `bin/studio.mjs`, `src/studio/server.mjs`, `src/studio/integration-hub.mjs`, `src/mcp/server-stdio.mjs`, `src/studio/ui/chat.mjs` | CLI/UI/MCP → authenticated dispatch → shared services; Studio also overlaps adapters |
| runtime | `src/capture/conversation-runtime.mjs`, `src/capture/conversation-service.mjs`, `src/capture/conversation-browser-adapter.mjs`, `src/chrome/launch.mjs`, `src/cdp/client.mjs` | Lifecycle → durable turn fence → browser adapter → dedicated provider tab |
| network | `src/capture/network.mjs`, `src/capture/recorder.mjs`, `src/capture/stream-guard.mjs` | DevTools network bytes → raw evidence and live reducer; overlaps runtime |
| protocol | `src/decode/decoders.mjs`, `src/decode/protobuf.mjs`, `src/decode/delta.mjs`, `src/decode/csv.mjs` | Raw framed bytes → decoded events → assembled documents |
| native-page | `src/capture/dom.mjs`, `src/capture/page-agent.js`, `src/capture/conversation-thread.mjs`, `src/capture/conversation-rich.mjs` | Isolated page observer → bounded DOM turns/artifacts; overlaps capture runtime |
| evidence | `src/store/session.mjs`, `src/store/raw-log.mjs`, `src/store/versioned.mjs`, `src/store/integrity.mjs`, `src/security/patterns.mjs` | Raw/dataset/KV persistence; immutable revisions, CAS and integrity manifests |
| reconstruction | `src/replay/derive.mjs`, `src/replay/derive-all.mjs`, `src/replay/reducer.mjs`, `src/mirror/index.mjs` | Read-only raw replay → derived artifacts or local timed mirror |
| intelligence | `src/intel/discover.mjs`, `src/intel/learn.mjs`, `src/intel/graph.mjs`, `src/intel/search.mjs`, `src/shapes/observation.mjs`, `src/families/families.mjs` | Observations → qualified entities/roles/relations → search and normalized families |
| adapters | `src/profiles/sites/index.mjs`, `src/profiles/sites/claude.mjs`, `src/profiles/profiles.mjs`, `src/studio/adapter-factory-service.mjs`, `src/studio/adapter-learning-pipeline.mjs` | Built-in provider selectors; independent learned read-adapter synthesis/holdout/promotion; no learned send grant |
| outputs | `src/export/export.mjs`, `src/export/outcome-packet.mjs`, `src/plugins/registry.mjs`, `src/core/invariants.mjs`, `src/config.mjs`, `bin/commands/export.mjs` | Saved artifacts → portable files/receipts; includes shared CLI and config ownership |
| personal-agent | `src/agents/personal-agent-service.mjs`, `src/agents/personal-agent-work.mjs`, `src/agents/personal-agent-bootstrap.mjs` | Explicit local identity/memory/Work → durable versioned state → continuity export |
| recipes | `src/recipes/catalog.mjs`, `src/recipes/choose.mjs`, `src/recipes/plan.mjs`, `src/recipes/service.mjs` | Intent → declarative choice/plan → authorized existing harness run/step executor |
| android | `android/src/inc/vivim/app/MainActivity.java`, `android/AndroidManifest.xml`, `android/build.ps1` | Pairing URL → same-origin WebView → Studio mobile PWA; resources/build are native shell concerns |
| scripts | `scripts/windows/VIVIM.cmd`, `scripts/windows/VIVIM.ps1`, `scripts/windows/launcher-helper.mjs`, `scripts/architecture-inventory.mjs` | Operator-owned launch/diagnostic/inventory entry points; scripts are not automatically imported services |
| documentation / repository | `docs/session/GOAL.md`, `docs/product/USER-SCENARIOS-100.json`, `architecture/components.json`, `package.json`, `AGENTS.md` | Current goal → scenario file scopes → source ownership; historical evidence is not current runtime proof |

## Where do I change X?

Paths below are starting points, not permission to cross another lane's write scope.
`—` means no explicit scenario-lane ownership; coordinate first.

| I want to change… | Start here | Lane / caution |
|---|---|---|
| Add a built-in AI provider | `src/profiles/sites/index.mjs`, neighboring `src/profiles/sites/*.mjs` | A; register selectors and validate actual provider behavior |
| Change Claude composer/send selectors | `src/profiles/sites/claude.mjs`, `src/capture/actions.mjs` | A; never treat selectors alone as send proof |
| Change ChatGPT selectors | `src/profiles/sites/chatgpt.mjs`, `src/capture/conversation-thread.mjs` | A |
| Read rendered ChatGPT chat links | `src/capture/chatgpt-chat-index.mjs`, `src/capture/chatgpt-chat-index-reader.mjs` | A; bounded candidate links, not full history |
| Change provider thread identity | `src/capture/conversation-thread.mjs`, `src/capture/thread-identity.mjs` | A |
| Change conversation lifecycle | `src/capture/conversation-service.mjs`, `src/capture/conversation-runtime.mjs` | A; shared UI/CLI contract |
| Prevent duplicate or uncertain sends | `src/capture/thread-turn-journal.mjs`, `src/capture/conversation-runtime.mjs` | A; retain original stable key |
| Fix draft protection | `src/capture/conversation-browser-adapter.mjs`, `src/capture/typed-prompt-ledger.mjs` | A; distinguish VIVIM's own persisted draft from user text |
| Change typed-prompt matching or ledger writes | `src/capture/typed-prompt-ledger.mjs` | A; shared persisted attribution |
| Change observed-prefix recovery | `src/capture/conversation-prefix.mjs`, `src/capture/conversation-browser-adapter.mjs` | A; read-only evidence, never blind resend |
| Change transcript bounds/rich parts | `src/capture/conversation-thread.mjs`, `src/capture/conversation-rich.mjs` | A |
| Change conversation HTTP schema/tools | `src/studio/conversation-api.mjs`, `src/studio/conversation-tools.mjs` | A; direct API and tool schemas both matter |
| Change reply streaming/SSE | `src/studio/conversation-events.mjs`, `src/studio/event-feed.mjs` | A / —; cursors are not durable send keys |
| Change desktop chat UI | `src/studio/ui/chat.mjs`, `src/studio/ui/chat.html` | B |
| Change saved World navigation | `src/studio/ui/world-view.mjs` | B |
| Change mobile UI/components | `src/studio/ui/mobile.mjs`, `src/studio/ui/mobile.html` | B |
| Change PWA install/offline shell | `src/studio/ui/manifest.webmanifest`, `src/studio/ui/mobile-sw.js` | B; do not cache/replay API effects |
| Change LAN pairing/QR address | `src/studio/lan-pair.mjs`, `src/studio/server.mjs` | B + C handoff; same Studio owner |
| Change Android pairing/navigation/recovery | `android/src/inc/vivim/app/MainActivity.java` | B; native shell embeds mobile PWA |
| Change Android icon/name or APK build | `android/res/`, `android/AndroidManifest.xml`, `android/build.ps1` | B |
| Change Personal Agent initialization | `src/agents/personal-agent-bootstrap.mjs`, `src/agents/personal-agent-service.mjs` | C |
| Change Personal Agent Work state/actions | `src/agents/personal-agent-work.mjs`, `src/studio/personal-agent-routes.mjs` | C; local explicit work, not provider scheduling |
| Change Personal Agent memory search | `src/agents/personal-agent-memory-search.mjs` | C; explicit local memory only |
| Change Agent self-knowledge or continuity | `src/agents/personal-agent-self-knowledge.mjs`, `src/agents/personal-agent-continuity.mjs` | C |
| Turn a stored AI reply into proposed Work | `src/agents/personal-agent-provider-reply.mjs` | C; opt-in stored-reply bridge |
| Change app templates or blueprint DSL | `src/studio/personal-app-blueprint.mjs` | C; inert declarative screens |
| Change app save/apply/CAS behavior | `src/studio/personal-app-service.mjs`, `src/studio/personal-app-routes.mjs` | C |
| Change app notes/tasks/completion | `src/studio/personal-app-content.mjs` | C; separate from AI-readable blueprint |
| Change Design with my AI jobs | `src/studio/personal-app-ai-design.mjs`, `src/studio/personal-app-provider-reply.mjs` | C; shared runtime, explicit preview/approval |
| Change provider comparison | `src/studio/compare-service.mjs`, `src/studio/compare-routes.mjs` | —; uses shared single effect owner |
| Change local notes/projects/relations | `src/studio/world-service.mjs`, `src/studio/world-relations.mjs` | C |
| Change note blocks/addressable units | `src/studio/world-note-units.mjs` | C |
| Change local-world search | `src/studio/world-search.mjs`, `src/intel/search.mjs` | C / —; preserve bounds and coverage |
| Change portable World export/import | `src/studio/world-transfer.mjs`, `src/studio/world-url.mjs` | C; private-by-default export and imported custody |
| Change transcript/dataset export | `src/export/export.mjs`, `bin/commands/export.mjs` | C |
| Change ranked graph/schema export | `src/export/graph-ranked.mjs`, `src/export/schemas.mjs` | C |
| Change Windows double-click start/stop | `scripts/windows/VIVIM.cmd`, `scripts/windows/VIVIM.ps1`, `scripts/windows/Stop-VIVIM.cmd` | —; preserve user's dedicated Chrome/sign-ins |
| Change Windows shortcut installation | `scripts/windows/install-shortcut.ps1` | — |
| Fix competing Studio CDP owners | `src/studio/cdp-owner-lock.mjs`, `src/chrome/browser-ownership.mjs` | C; do not introduce a second controller |
| Change dedicated Chrome launch/profile | `src/chrome/launch.mjs`, `src/chrome/browser-ownership.mjs` | C |
| Change host-wide foreground drive lease | `src/capture/drive-lease.mjs` | A |
| Change raw CDP transport/discovery | `src/cdp/client.mjs`, `src/cdp/discovery.mjs` | —; reused by existing owner |
| Add a versioned HTTP route/tool | `src/studio/integration-hub.mjs`, relevant `*-routes.mjs` | C hub handoff + route owner |
| Change legacy API or surface mounting | `src/studio/server.mjs` | C; direct API takes precedence over hub |
| Add/change CLI command/help | `bin/commands/`, `bin/lib/registry.mjs`, `bin/lib/args.mjs` | C except A's chat/drive/capture commands |
| Change declarative recipes | `src/recipes/catalog.mjs`, `src/recipes/plan.mjs`, `src/studio/recipe-routes.mjs` | —; preview does not authorize execution |
| Change durable harness execution | `src/studio/harness-api.mjs`, `src/capture/harness-runs.mjs`, `src/studio/uncertain-step-reconciler.mjs` | — / A; retain send fences |
| Change MCP stdio tools/resources | `src/mcp/server-stdio.mjs`, `src/mcp/runtime.mjs`, `src/mcp/resources.mjs` | —; stdout is JSON-RPC only |
| Change learned read-adapter synthesis | `src/studio/adaptive-adapter-factory.mjs`, `src/studio/adapter-factory-service.mjs` | —; distinct from handwritten send adapters |
| Change adapter holdout/promotion | `src/studio/adapter-holdout-gate.mjs`, `src/studio/adapter-learning-pipeline.mjs` | —; independent evidence and explicit CAS |
| Change streaming protocol decoding | `src/decode/decoders.mjs`, `src/decode/protobuf.mjs`, `src/decode/delta.mjs` | — |
| Change stream-role/component inference | `src/replay/stream-role.mjs`, `src/replay/stream-components.mjs` | — |
| Change offline derivation/reconstruction | `src/replay/derive.mjs`, `src/replay/derive-all.mjs` | —; raw evidence remains read-only |
| Change session buffering/persistence | `src/store/session.mjs`, `src/store/raw-log.mjs`, `src/store/raw-index.mjs` | —; flush and crash semantics matter |
| Change immutable JSON CAS/locks | `src/store/versioned.mjs` | —; shared platform persistence contract |
| Change capture privacy/masking | `src/capture/privacy.mjs`, `src/capture/redact.mjs`, `src/capture/stream-guard.mjs` | A; distinguish local-raw fidelity from filtered export |
| Change data folder/default settings | `src/config.mjs`, `bin/commands/system.mjs` | — / C; explicit --data-dir overrides defaults |
| Change shape-family consolidation | `src/families/build.mjs`, `src/families/core.mjs`, `src/families/families.mjs` | — |
| Change saved-session replay mirror | `src/mirror/index.mjs`, `src/mirror/match.mjs`, `src/mirror/replay.mjs` | —; captured URLs determine dynamic replay routes |
| Find current goal/scenario owner/evidence | `docs/session/GOAL.md`, `docs/product/USER-SCENARIOS-100.json`, `docs/agents/` | Read latest attempt, not historical PASS alone |

## Data on disk

The requested `%LOCALAPPDATA%\AION\capture-studio` directory was inspected with
`Get-ChildItem` **for immediate child names only**. It is an observed legacy/default
root on this machine, not a guarantee that the current Studio uses it: native CLI
examples also use `C:\VIVIM`, and `--data-dir`/settings can select another root.
`src/config.mjs` owns path resolution. No nested personal filenames or contents are
included here. Versioned stores generally use named records containing `vNNNN.json`
revisions and `CURRENT` pointers; exact layouts belong to their persistence owners.

| Observed child | Purpose / owning source |
|---|---|
| `chrome-profile/` | Dedicated Chrome user-data and signed-in provider state; `src/chrome/launch.mjs` |
| `compare-jobs/` | Durable comparison job state; `src/studio/compare-service.mjs` |
| `conversations/` | Stored conversation lifecycle snapshots/journals; `src/capture/conversation-runtime.mjs` |
| `families/` | Versioned local provider-family data; `src/families/families.mjs` |
| `harness-runs/` | Durable task/step run records and locks; `src/capture/harness-runs.mjs` |
| `integration-runs/` | Observed historical integration-run directory; no current literal writer was found in `src/`, so active ownership is not asserted |
| `intent-bindings/` | Durable intent/action binding metadata; `src/studio/intent-bindings.mjs` |
| `learned-adapters/` | Versioned learned read-adapter candidates/receipts; adapter factory/pipeline |
| `locks/` | Local runtime exclusion locks; `src/capture/conversation-runtime.mjs` and related owners |
| `personal-agent/` | Versioned Agent identity, bootstrap, memory and Work; `src/agents/personal-agent-service.mjs` |
| `personal-app-ai-jobs/` | Design with my AI job snapshots; `src/studio/personal-app-ai-design.mjs` |
| `personal-app-content/` | User-authored app notes/tasks, separately versioned; `src/studio/personal-app-content.mjs` |
| `personal-apps/` | Local inert app blueprints; `src/studio/personal-app-service.mjs` |
| `profiles/` | Versioned site capture profiles; `src/profiles/profiles.mjs` |
| `sessions/` | Session metadata, raw segments/indexes, datasets, key-value artifacts and acceptance evidence; `src/store/` |
| `world/` | User-owned projects/notes, relations and import records; `src/studio/world-service.mjs` |
| `always-on.json` | Supervisor status metadata; `scripts/always-on.mjs` |
| `always-on.log` | Supervisor operational log; `scripts/always-on.mjs` |
| `campaign-state.json` | Persisted per-provider campaign progress; `src/capture/campaign.mjs` |
| `typed-prompt-ledger.json` | VIVIM-typed prompt attribution used for own-draft recovery; `src/capture/typed-prompt-ledger.mjs` |

Machine-wide CDP-owner and foreground-driver lock locations are computed by their
owners (`src/studio/cdp-owner-lock.mjs`, `src/capture/drive-lease.mjs`) and are not
necessarily under this data root. Never infer that an empty per-root `locks/` means
there is no browser controller elsewhere.

<!-- GENERATED FILE-MAP TABLES -->

## Snapshot counts

Generated 2026-10-29T21:43:15.384Z; source HEAD 51a079ad442c. Working-tree changes from parallel lanes may postdate this snapshot.

| Metric | Count |
|---|---:|
| trackedFiles | 722 |
| untrackedFiles | 0 |
| generatedFiles | 2 |
| representedFiles | 724 |
| fileEntries | 499 |
| summarizedDirectories | 7 |
| summarizedFiles | 225 |
| routes | 278 |
| commands | 138 |
| orphanCandidates | 7 |

The represented-file total includes the two map outputs. Test summary directories are not extra files. Routes count registration rows (including shared-URL conversation tool registrations), not unique URLs. All other tracked data/config/doc assets are retained individually; no other fixture/data directory crossed the 200-file summary threshold.

## All HTTP routes

Studio-managed API, surface and asset handlers below were extracted from literal `add(...)` registrations, the World wrapper, conversation tool definitions, the artifact loop and hand-read explicit dispatchers. `{name}` is a path parameter. `ANY` preserves the actual legacy method-unconstrained branch. Conditional learned-adapter routes and optional capability routes are listed even when their backend may be unavailable.

The optional mirror server replays **data-defined captured METHOD/path pairs**, not a fixed product route catalog; its management endpoints are included below. Synthetic fixture servers in scripts are operator tools, not additional Studio APIs.

| Method | Path | Registering/dispatching file |
|---|---|---|
| GET | `/` | `src/studio/server.mjs` |
| POST | `/api/chrome/launch` | `src/studio/server.mjs` |
| ANY | `/api/families` | `src/studio/server.mjs` |
| POST | `/api/families/_register` | `src/studio/server.mjs` |
| ANY | `/api/families/{family}` | `src/studio/server.mjs` |
| ANY | `/api/families/{family}/records` | `src/studio/server.mjs` |
| GET | `/api/live` | `src/studio/server.mjs` |
| ANY | `/api/live/blocks/{block}` | `src/studio/server.mjs` |
| POST | `/api/live/highlight` | `src/studio/server.mjs` |
| ANY | `/api/live/inspect-dom` | `src/studio/server.mjs` |
| POST | `/api/live/pause` | `src/studio/server.mjs` |
| POST | `/api/live/reload` | `src/studio/server.mjs` |
| POST | `/api/live/resume` | `src/studio/server.mjs` |
| ANY | `/api/live/session` | `src/studio/server.mjs` |
| ANY | `/api/live/shapes` | `src/studio/server.mjs` |
| POST | `/api/live/snapshot` | `src/studio/server.mjs` |
| ANY | `/api/live/stream/{stream}/assembled` | `src/studio/server.mjs` |
| ANY | `/api/live/stream/{stream}/events` | `src/studio/server.mjs` |
| ANY | `/api/live/streams` | `src/studio/server.mjs` |
| ANY | `/api/live/turns` | `src/studio/server.mjs` |
| ANY | `/api/preview` | `src/studio/server.mjs` |
| ANY | `/api/profiles` | `src/studio/server.mjs` |
| POST | `/api/profiles/_import` | `src/studio/server.mjs` |
| ANY | `/api/profiles/{profile}` | `src/studio/server.mjs` |
| POST | `/api/profiles/{profile}/apply` | `src/studio/server.mjs` |
| POST | `/api/profiles/{profile}/clone` | `src/studio/server.mjs` |
| ANY | `/api/profiles/{profile}/diff` | `src/studio/server.mjs` |
| ANY | `/api/profiles/{profile}/export` | `src/studio/server.mjs` |
| POST | `/api/profiles/{profile}/model` | `src/studio/server.mjs` |
| ANY | `/api/profiles/{profile}/model-draft` | `src/studio/server.mjs` |
| POST | `/api/profiles/{profile}/rollback` | `src/studio/server.mjs` |
| POST | `/api/profiles/{profile}/save` | `src/studio/server.mjs` |
| POST | `/api/record/start` | `src/studio/server.mjs` |
| POST | `/api/record/stop` | `src/studio/server.mjs` |
| ANY | `/api/search` | `src/studio/server.mjs` |
| ANY | `/api/sessions` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}` | `src/studio/server.mjs` |
| GET | `/api/sessions/{session}/acceptance` | `src/studio/server.mjs` |
| POST | `/api/sessions/{session}/acceptance` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/assembled` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/assembled/{stream}` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/at` | `src/studio/server.mjs` |
| GET | `/api/sessions/{session}/components` | `src/studio/server.mjs` |
| GET | `/api/sessions/{session}/continuity` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/dataset/{dataset}` | `src/studio/server.mjs` |
| POST | `/api/sessions/{session}/delete` | `src/studio/server.mjs` |
| POST | `/api/sessions/{session}/derive` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/dom` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/events/{stream}` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/export` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/graph` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/hypotheses` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/inspect` | `src/studio/server.mjs` |
| GET | `/api/sessions/{session}/join` | `src/studio/server.mjs` |
| GET | `/api/sessions/{session}/knowledge-status` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/model` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/raw/{stream}` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/revision/{stream}` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/shapes` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/streams` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/timeline` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/transcript` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/turns` | `src/studio/server.mjs` |
| ANY | `/api/sessions/{session}/verify` | `src/studio/server.mjs` |
| ANY | `/api/status` | `src/studio/server.mjs` |
| ANY | `/api/targets` | `src/studio/server.mjs` |
| POST | `/api/v1/adapters/intelligence/promote` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/adapters/intelligence/proposals` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/adapters/intelligence/propose` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/adapters/intelligence/read-selection` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/adapters/intelligence/rollback` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/adapters/learned` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/adapters/learned/{name}` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/adapters/learned/{name}/rollback` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/adapters/learned/{name}/transcript` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/adapters/learned/promote` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/adapters/learned/shadow-evaluate` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/adapters/learned/synthesize` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/adapters/read` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/adapters/read/{id}` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/agent/capabilities` | `src/studio/recipe-routes.mjs` |
| GET | `/api/v1/agentic-files` | `src/studio/agentic-files.mjs` |
| GET | `/api/v1/agentic-files/{id}` | `src/studio/agentic-files.mjs` |
| POST | `/api/v1/chat-index` | `src/studio/conversation-api.mjs` |
| POST | `/api/v1/chat-index` | `src/studio/conversation-tools.mjs` |
| GET | `/api/v1/commands` | `src/studio/commands.mjs` |
| GET | `/api/v1/commands/{id}` | `src/studio/commands.mjs` |
| POST | `/api/v1/commands/{id}/preview` | `src/studio/commands.mjs` |
| POST | `/api/v1/compare` | `src/studio/compare-routes.mjs` |
| GET | `/api/v1/compare/{jobId}` | `src/studio/compare-routes.mjs` |
| POST | `/api/v1/compare/{jobId}/cancel` | `src/studio/compare-routes.mjs` |
| GET | `/api/v1/conversation-targets` | `src/studio/conversation-api.mjs` |
| GET | `/api/v1/conversation-targets` | `src/studio/conversation-tools.mjs` |
| GET | `/api/v1/conversations` | `src/studio/conversation-api.mjs` |
| GET | `/api/v1/conversations` | `src/studio/conversation-tools.mjs` |
| POST | `/api/v1/conversations` | `src/studio/conversation-api.mjs` |
| POST | `/api/v1/conversations` | `src/studio/conversation-tools.mjs` |
| GET | `/api/v1/conversations/{conversation}` | `src/studio/conversation-tools.mjs` |
| GET | `/api/v1/conversations/{conversation}/capsule` | `src/studio/conversation-tools.mjs` |
| POST | `/api/v1/conversations/{conversation}/finish` | `src/studio/conversation-tools.mjs` |
| POST | `/api/v1/conversations/{conversation}/read` | `src/studio/conversation-tools.mjs` |
| POST | `/api/v1/conversations/{conversation}/reconcile` | `src/studio/conversation-tools.mjs` |
| POST | `/api/v1/conversations/{conversation}/turns` | `src/studio/conversation-tools.mjs` |
| GET | `/api/v1/conversations/{id}` | `src/studio/conversation-api.mjs` |
| GET | `/api/v1/conversations/{id}/capsule` | `src/studio/conversation-api.mjs` |
| GET | `/api/v1/conversations/{id}/events` | `src/studio/conversation-api.mjs` |
| POST | `/api/v1/conversations/{id}/finish` | `src/studio/conversation-api.mjs` |
| POST | `/api/v1/conversations/{id}/read` | `src/studio/conversation-api.mjs` |
| POST | `/api/v1/conversations/{id}/reconcile` | `src/studio/conversation-api.mjs` |
| POST | `/api/v1/conversations/{id}/turns` | `src/studio/conversation-api.mjs` |
| POST | `/api/v1/conversations/create` | `src/studio/conversation-api.mjs` |
| POST | `/api/v1/conversations/create` | `src/studio/conversation-tools.mjs` |
| POST | `/api/v1/conversations/prefix` | `src/studio/conversation-api.mjs` |
| GET | `/api/v1/drive/jobs` | `src/studio/drive-api.mjs` |
| POST | `/api/v1/drive/jobs` | `src/studio/drive-api.mjs` |
| GET | `/api/v1/drive/jobs/{id}` | `src/studio/drive-api.mjs` |
| POST | `/api/v1/drive/jobs/{id}/cancel` | `src/studio/drive-api.mjs` |
| GET | `/api/v1/drive/sites` | `src/studio/drive-api.mjs` |
| GET | `/api/v1/events` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/harness/runs` | `src/studio/harness-api.mjs` |
| POST | `/api/v1/harness/runs` | `src/studio/harness-api.mjs` |
| GET | `/api/v1/harness/runs/{run}` | `src/studio/harness-api.mjs` |
| POST | `/api/v1/harness/runs/{run}/context` | `src/studio/harness-api.mjs` |
| POST | `/api/v1/harness/runs/{run}/finish` | `src/studio/harness-api.mjs` |
| POST | `/api/v1/harness/runs/{run}/reconcile` | `src/studio/harness-api.mjs` |
| POST | `/api/v1/harness/runs/{run}/steps` | `src/studio/harness-api.mjs` |
| GET | `/api/v1/health` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/integrations` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/integrations/tools` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/integrations/tools/call` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/integrations/webhooks` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/integrations/webhooks` | `src/studio/integration-hub.mjs` |
| DELETE | `/api/v1/integrations/webhooks/{id}` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/integrations/webhooks/{id}/deliveries` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/learning` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/learning/audit` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/learning/calibration` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/learning/corrections` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/learning/corrections/{id}/revert` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/learning/predict` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/learning/promotions` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/learning/proposals` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/learning/proposals` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/learning/proposals/{id}/review` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/learning/rollback` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/learning/versions` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/live` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/live/view` | `src/studio/integration-hub.mjs` |
| DELETE | `/api/v1/mirrors` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/mirrors` | `src/studio/capabilities.mjs` |
| POST | `/api/v1/mirrors` | `src/studio/capabilities.mjs` |
| DELETE | `/api/v1/mirrors/{id}` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/mirrors/{id}` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/mirrors/{id}/log` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/mirrors/{id}/requests` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/mirrors/{id}/routes` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/openapi.json` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/personal-agent/bootstrap` | `src/studio/personal-agent-routes.mjs` |
| GET | `/api/v1/personal-agent/capabilities` | `src/studio/personal-agent-routes.mjs` |
| GET | `/api/v1/personal-agent/export` | `src/studio/personal-agent-routes.mjs` |
| POST | `/api/v1/personal-agent/initialize` | `src/studio/personal-agent-routes.mjs` |
| GET | `/api/v1/personal-agent/memory/{tier}` | `src/studio/personal-agent-routes.mjs` |
| PUT | `/api/v1/personal-agent/memory/{tier}/{key}` | `src/studio/personal-agent-routes.mjs` |
| POST | `/api/v1/personal-agent/memory/{tier}/{key}/remove` | `src/studio/personal-agent-routes.mjs` |
| POST | `/api/v1/personal-agent/search-memory` | `src/studio/personal-agent-routes.mjs` |
| GET | `/api/v1/personal-agent/self-knowledge` | `src/studio/personal-agent-routes.mjs` |
| GET | `/api/v1/personal-agent/sitrep` | `src/studio/personal-agent-routes.mjs` |
| GET | `/api/v1/personal-agent/status` | `src/studio/personal-agent-routes.mjs` |
| GET | `/api/v1/personal-agent/work` | `src/studio/personal-agent-routes.mjs` |
| POST | `/api/v1/personal-agent/work` | `src/studio/personal-agent-routes.mjs` |
| POST | `/api/v1/personal-agent/work/{id}/next-action` | `src/studio/personal-agent-routes.mjs` |
| POST | `/api/v1/personal-agent/work/{id}/transition` | `src/studio/personal-agent-routes.mjs` |
| POST | `/api/v1/personal-agent/work/apply-provider-reply` | `src/studio/personal-agent-routes.mjs` |
| POST | `/api/v1/personal-agent/work/preview-provider-reply` | `src/studio/personal-agent-routes.mjs` |
| GET | `/api/v1/personal-apps` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps` | `src/studio/personal-app-routes.mjs` |
| GET | `/api/v1/personal-apps/{id}` | `src/studio/personal-app-routes.mjs` |
| GET | `/api/v1/personal-apps/{id}/ai-design` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/{id}/ai-design` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/{id}/apply-change` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/{id}/apply-provider-reply` | `src/studio/personal-app-routes.mjs` |
| GET | `/api/v1/personal-apps/{id}/content` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/{id}/content/items` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/{id}/content/items/{itemId}/completion` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/{id}/preview-change` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/{id}/preview-provider-reply` | `src/studio/personal-app-routes.mjs` |
| GET | `/api/v1/personal-apps/{id}/scaffold` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/{id}/screens` | `src/studio/personal-app-routes.mjs` |
| GET | `/api/v1/personal-apps/ai-design/{jobId}` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/ai-design/{jobId}/approve` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/ai-design/{jobId}/discard` | `src/studio/personal-app-routes.mjs` |
| POST | `/api/v1/personal-apps/from-template` | `src/studio/personal-app-routes.mjs` |
| GET | `/api/v1/personal-apps/templates` | `src/studio/personal-app-routes.mjs` |
| GET | `/api/v1/recipes` | `src/studio/recipe-routes.mjs` |
| GET | `/api/v1/recipes/{recipe}` | `src/studio/recipe-routes.mjs` |
| POST | `/api/v1/recipes/{recipe}/plan` | `src/studio/recipe-routes.mjs` |
| POST | `/api/v1/recipes/{recipe}/run` | `src/studio/recipe-routes.mjs` |
| POST | `/api/v1/recipes/choose` | `src/studio/recipe-routes.mjs` |
| GET | `/api/v1/recipes/runs/{run}` | `src/studio/recipe-routes.mjs` |
| POST | `/api/v1/recipes/runs/{run}/finish` | `src/studio/recipe-routes.mjs` |
| POST | `/api/v1/recipes/runs/{run}/reconcile` | `src/studio/recipe-routes.mjs` |
| GET | `/api/v1/search` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/sessions` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/artifacts` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/sessions/{session}/datasets` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/datasets/{dataset}` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/sessions/{session}/derive` | `src/studio/integration-hub.mjs` |
| POST | `/api/v1/sessions/{session}/derive-all` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/sessions/{session}/graph/ranked` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/sessions/{session}/knowledge` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/knowledge/continuity` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/knowledge/entities` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/knowledge/entities/{eid}` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/knowledge/graph` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/knowledge/neighbors/{eid}` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/learning/questions` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/mirror/routes` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/sessions/{session}/observation` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/receipt` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/replay/events` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/replay/records` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/replay/state` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/replay/streams/{sid}` | `src/studio/integration-hub.mjs` |
| GET | `/api/v1/sessions/{session}/schemas` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/sessions/{session}/timelines` | `src/studio/capabilities.mjs` |
| GET | `/api/v1/world/app-items` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/conversations` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/conversations/{id}` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/map` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/namespace` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/notes` | `src/studio/world-service.mjs` |
| POST | `/api/v1/world/notes` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/notes/{id}` | `src/studio/world-service.mjs` |
| PUT | `/api/v1/world/notes/{id}` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/notes/{id}/units` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/notes/{id}/units/{address}` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/objects` | `src/studio/world-service.mjs` |
| POST | `/api/v1/world/objects` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/objects/{id}` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/projects` | `src/studio/world-service.mjs` |
| POST | `/api/v1/world/projects` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/projects/{id}` | `src/studio/world-service.mjs` |
| PUT | `/api/v1/world/projects/{id}` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/search` | `src/studio/world-search.mjs` |
| GET | `/api/v1/world/selections` | `src/studio/world-service.mjs` |
| POST | `/api/v1/world/selections` | `src/studio/world-service.mjs` |
| GET | `/api/v1/world/selections/{id}` | `src/studio/world-service.mjs` |
| POST | `/api/v1/world/transfer/export` | `src/studio/world-transfer.mjs` |
| POST | `/api/v1/world/transfer/restore` | `src/studio/world-transfer.mjs` |
| POST | `/api/v1/world/transfer/validate` | `src/studio/world-transfer.mjs` |
| POST | `/api/x/autodetect` | `src/studio/platform-x.mjs` |
| GET | `/api/x/bench` | `src/studio/platform-x.mjs` |
| POST | `/api/x/csv` | `src/studio/platform-x.mjs` |
| GET | `/api/x/dedupe/{session}` | `src/studio/platform-x.mjs` |
| GET | `/api/x/graph/{session}` | `src/studio/platform-x.mjs` |
| GET | `/api/x/keyphrases/{session}` | `src/studio/platform-x.mjs` |
| GET | `/api/x/registry` | `src/studio/platform-x.mjs` |
| GET | `/api/x/stats` | `src/studio/platform-x.mjs` |
| GET | `/chat` | `src/studio/server.mjs` |
| GET | `/drive` | `src/studio/server.mjs` |
| GET | `/drive.html` | `src/studio/server.mjs` |
| GET | `/drive.mjs` | `src/studio/server.mjs` |
| GET | `/live/view` | `src/studio/server.mjs` |
| GET | `/live/view.mjs` | `src/studio/server.mjs` |
| GET | `/mobile` | `src/studio/server.mjs` |
| GET | `/mobile-sw.js` | `src/studio/server.mjs` |
| GET | `/mobile.webmanifest` | `src/studio/server.mjs` |
| GET | `/personal-agent` | `src/studio/server.mjs` |
| GET | `/platform` | `src/studio/server.mjs` |
| GET | `/ui/chat.mjs` | `src/studio/server.mjs` |
| GET | `/ui/drive.html` | `src/studio/server.mjs` |
| GET | `/ui/drive.mjs` | `src/studio/server.mjs` |
| GET | `/ui/mobile.mjs` | `src/studio/server.mjs` |
| GET | `/ui/personal-agent.mjs` | `src/studio/server.mjs` |
| GET | `/ui/platform.mjs` | `src/studio/server.mjs` |
| GET | `/ui/universal-chat.mjs` | `src/studio/server.mjs` |
| GET | `/ui/world-view.mjs` | `src/studio/server.mjs` |

## All CLI commands

Concrete `define({ name })` commands plus the two expanded session loop commands. Group defaults and aliases resolve through `bin/lib/registry.mjs`; they are not additional command definitions. This is source enumeration, not command execution or provider authorization.

| Command (after `studio`) | Defining file | Purpose |
|---|---|---|
| `agent capabilities` | `bin/commands/recipes.mjs` | Read registered agent capabilities without probing accounts |
| `agent context` | `bin/commands/recipes.mjs` | Read repository context for ordinary agents (not measured probes) |
| `agent status` | `bin/commands/recipes.mjs` | Read running Studio health without browser effects |
| `campaign` | `bin/commands/campaign.mjs` | Walk every AI chat site in order and capture, derive and build its family |
| `capture` | `bin/commands/capture.mjs` | One shot: open the page, record until idle, derive and export |
| `chat` | `bin/commands/chat.mjs` | Preview, or explicitly send one conversation turn and finish its capture |
| `commands` | `bin/commands/system.mjs` | List every command (machine-readable with --json) |
| `completion` | `bin/commands/system.mjs` | Print a shell completion script |
| `config get` | `bin/commands/system.mjs` | Print one effective setting |
| `config path` | `bin/commands/system.mjs` | Print the config file path |
| `config set` | `bin/commands/system.mjs` | Persist a default in config.json |
| `config show` | `bin/commands/system.mjs` | Show effective settings and where each value comes from |
| `config unset` | `bin/commands/system.mjs` | Remove a persisted default |
| `csv` | `bin/commands/platform.mjs` | Analyse delimited text: columns, types and row statistics |
| `dedupe` | `bin/commands/platform.mjs` | Find duplicate or near-duplicate records in a saved session |
| `derive` | `bin/commands/replay.mjs` | Rebuild datasets, shapes, knowledge and the receipt from raw |
| `detect` | `bin/commands/platform.mjs` | Detect the shape of a saved document or stream and summarise it |
| `doctor` | `bin/commands/system.mjs` | Check whether your computer and VIVIM browser are ready |
| `drive` | `bin/commands/drive.mjs` | Send a prompt to a live AI site, record it and read the reply back |
| `export bundle` | `bin/commands/export.mjs` | Portable folder: manifest with hashes, datasets, transcript, report, knowledge |
| `export dataset` | `bin/commands/export.mjs` | Export one dataset (JSON, NDJSON, CSV, TSV, Markdown, HTML) |
| `export formats` | `bin/commands/export.mjs` | List the formats each export supports |
| `export graph` | `bin/commands/export.mjs` | Temporal evidence graph for Graphviz, Mermaid, Gephi/yEd, or JSON |
| `export graph-ranked` | `bin/commands/export.mjs` | Export graph nodes ranked by confidence-weighted PageRank |
| `export knowledge` | `bin/commands/export.mjs` | Data model, entities, graph and hypotheses in one artifact |
| `export report` | `bin/commands/export.mjs` | Single-file HTML report: receipt, fidelity, streams, model, suggestions |
| `export schemas` | `bin/commands/export.mjs` | Export observed schemas as a draft-2020-12 JSON Schema definition bundle |
| `export transcript` | `bin/commands/export.mjs` | Readable session transcript: timeline, rendered turns, assembled stream text |
| `family detect` | `bin/commands/profiles.mjs` | Which families a session looks like, with the evidence |
| `family list` | `bin/commands/profiles.mjs` | List provider families, their entities and member profiles |
| `family new` | `bin/commands/profiles.mjs` | Register a new, empty family (optionally seeded with a member profile) |
| `family records` | `bin/commands/profiles.mjs` | Canonical records for a family across all sites and sessions |
| `family show` | `bin/commands/profiles.mjs` | Print a family definition as JSON |
| `help` | `bin/commands/system.mjs` | Show help for a command |
| `integrity build` | `bin/commands/platform.mjs` | Write a SHA-256 manifest for a directory |
| `integrity verify` | `bin/commands/platform.mjs` | Verify a directory against its manifest (exit 4 when it does not match) |
| `knowledge at` | `bin/commands/knowledge.mjs` | Entity and edge state at a moment in the session (graph time travel) |
| `knowledge continuity` | `bin/commands/knowledge.mjs` | Join safely keyed entities across saved sessions of the same origin |
| `knowledge entities` | `bin/commands/knowledge.mjs` | List keyed entities of one session |
| `knowledge entity` | `bin/commands/knowledge.mjs` | One entity: current state, revision history, graph neighbors, cross-session history |
| `knowledge graph` | `bin/commands/knowledge.mjs` | Temporal evidence graph: statistics, edges, neighbors |
| `knowledge graph-stats` | `bin/commands/platform.mjs` | Graph statistics, top pagerank nodes and community summary |
| `knowledge hypotheses` | `bin/commands/knowledge.mjs` | Correlation hypotheses: rendered-as and action-to-stream links |
| `knowledge keyphrases` | `bin/commands/platform.mjs` | Extract key phrases from a saved session |
| `knowledge query` | `bin/commands/knowledge.mjs` | Filter entities across sessions: type=Message role=assistant text~hello observations>3 |
| `knowledge schema` | `bin/commands/knowledge.mjs` | Inspect an observed type schema, optionally as portable JSON Schema |
| `knowledge search` | `bin/commands/knowledge.mjs` | Ranked search over the derived session corpus |
| `knowledge sites` | `bin/commands/knowledge.mjs` | Sites and origins you have captured, with session and knowledge counts |
| `knowledge status` | `bin/commands/knowledge.mjs` | Knowledge derivation state — for one session, or all of them |
| `knowledge types` | `bin/commands/knowledge.mjs` | The discovered data model: types, keys, fields, relationships |
| `launch` | `bin/commands/capture.mjs` | Open the dedicated capture browser (loopback DevTools only) |
| `learn audit` | `bin/commands/learn.mjs` | Audit trail of proposals, reviews, reverts and rollbacks |
| `learn calibration` | `bin/commands/learn.mjs` | Confidence calibration per suggestion kind (histogram bins and ECE) |
| `learn corrections` | `bin/commands/learn.mjs` | Accepted corrections (what the learner has been taught) |
| `learn predict` | `bin/commands/learn.mjs` | What role would the learner assign to a field, and why |
| `learn promotions` | `bin/commands/learn.mjs` | Corrections repeated across sites that could be promoted to family/global scope |
| `learn proposals` | `bin/commands/learn.mjs` | Proposed corrections awaiting review |
| `learn propose` | `bin/commands/learn.mjs` | Propose a correction for review (does not train until accepted) |
| `learn revert` | `bin/commands/learn.mjs` | Undo an accepted correction (models are retrained without it) |
| `learn review` | `bin/commands/learn.mjs` | Accept or reject a proposed correction |
| `learn roles` | `bin/commands/learn.mjs` | The roles and scopes the learner works with |
| `learn rollback` | `bin/commands/learn.mjs` | Restore an earlier learner revision (recorded as a new revision) |
| `learn status` | `bin/commands/learn.mjs` | Learner revision, scoped models, corrections, calibration and knowledge health |
| `learn teach` | `bin/commands/learn.mjs` | Apply a correction immediately (propose + accept in one step) |
| `learn versions` | `bin/commands/learn.mjs` | Stored learner revisions (every save is immutable) |
| `library build` | `bin/commands/library.mjs` | Build (and save) the family shape set for a site |
| `library core` | `bin/commands/library.mjs` | Build (and save) the cross-site core streaming library |
| `library list` | `bin/commands/library.mjs` | List consolidated families |
| `library show` | `bin/commands/library.mjs` | Show a consolidated family |
| `mirror routes` | `bin/commands/mirror.mjs` | List recorded mirror routes without starting a server |
| `mirror serve` | `bin/commands/mirror.mjs` | Run a loopback HTTP mirror of captured routes |
| `paths` | `bin/commands/system.mjs` | Print the data folder layout |
| `personal-agent advance` | `bin/commands/personal-agent.mjs` | Explicitly transition a local Work item; does not send to a provider |
| `personal-agent bootstrap` | `bin/commands/personal-agent.mjs` | Initialize/resume four evidence-backed local bootstrap stages (no provider effects) |
| `personal-agent capabilities` | `bin/commands/personal-agent.mjs` | Inspect discovered local skills, not installed or live-tested tools |
| `personal-agent export` | `bin/commands/personal-agent.mjs` | Export checksummed local agent JSON; private details only on explicit flags |
| `personal-agent inspect-export` | `bin/commands/personal-agent.mjs` | Read-only preflight of local portable Agent JSON; verifies checksum and privacy flags, never imports |
| `personal-agent plan` | `bin/commands/personal-agent.mjs` | Set or clear a user-authored next action for open local Work (no execution) |
| `personal-agent queue` | `bin/commands/personal-agent.mjs` | Create a local Work item with a stable idempotency key; does not execute it |
| `personal-agent self` | `bin/commands/personal-agent.mjs` | Read source-qualified local self-knowledge with freshness and provenance |
| `personal-agent sitrep` | `bin/commands/personal-agent.mjs` | Private, bounded continuity packet: bootstrap, recent memory and outstanding Work |
| `personal-agent status` | `bin/commands/personal-agent.mjs` | Read bootstrap progress, memory counts and next stage (no initialization) |
| `personal-agent work` | `bin/commands/personal-agent.mjs` | List private user-directed local Work, with no tool/provider dispatch |
| `platform registry` | `bin/commands/platform.mjs` | Snapshot of the local platform registry |
| `platform stats` | `bin/commands/platform.mjs` | Platform capability and usage statistics |
| `profile apply` | `bin/commands/profiles.mjs` | Accept or reject inferred suggestions into a new profile version |
| `profile clone` | `bin/commands/profiles.mjs` | Copy a profile under a new name |
| `profile diff` | `bin/commands/profiles.mjs` | What changed between two versions (default: previous vs current) |
| `profile export` | `bin/commands/profiles.mjs` | Write a profile to a portable JSON file |
| `profile hosts` | `bin/commands/profiles.mjs` | Show or edit the host patterns a profile matches |
| `profile import` | `bin/commands/profiles.mjs` | Validate and import a profile file as a new version |
| `profile lint` | `bin/commands/profiles.mjs` | Check profiles for invalid patterns, duplicate rules and risky settings |
| `profile list` | `bin/commands/profiles.mjs` | List profiles with version, hosts, family and rule counts |
| `profile match` | `bin/commands/profiles.mjs` | Which profile would a recording of this URL use, and why |
| `profile new` | `bin/commands/profiles.mjs` | Create a profile for a site from the generic defaults (or another base) |
| `profile op` | `bin/commands/profiles.mjs` | Apply a semantic model operation (rename_field, set_identity, merge_records, …) |
| `profile rollback` | `bin/commands/profiles.mjs` | Make an earlier version current again (history is kept) |
| `profile set` | `bin/commands/profiles.mjs` | Edit a profile by path (scalars, lists, nested settings) |
| `profile show` | `bin/commands/profiles.mjs` | Print a profile as JSON |
| `profile versions` | `bin/commands/profiles.mjs` | Version history with change notes (* marks current) |
| `receipt` | `bin/commands/sessions.mjs` | Metadata-only lab receipt (safe to paste into an issue) |
| `recipe choose` | `bin/commands/recipes.mjs` | Suggest recipes from intent text; no side effects or authorization |
| `recipe finish` | `bin/commands/recipes.mjs` | Finalize durable run status after inspecting actual evidence |
| `recipe list` | `bin/commands/recipes.mjs` | List available recipe contracts without opening Chrome |
| `recipe plan` | `bin/commands/recipes.mjs` | Validate typed inputs and effects without side effects |
| `recipe reconcile` | `bin/commands/recipes.mjs` | Inspect original uncertain send/journal without resending |
| `recipe run` | `bin/commands/recipes.mjs` | Invoke a real native tool through the running Studio harness, with durable effect fencing |
| `recipe show` | `bin/commands/recipes.mjs` | Read the exact tool, schema, effects and guard rules |
| `recipe status` | `bin/commands/recipes.mjs` | Read durable recipe run status (no browser effects) |
| `record` | `bin/commands/capture.mjs` | Record tabs from the terminal; Ctrl+C stops, saves and derives |
| `replay` | `bin/commands/replay.mjs` | Replay a captured stream with its original timing, or time-travel to a moment |
| `run context` | `bin/commands/run.mjs` | Merge durable continuation context into a running harness run |
| `run create` | `bin/commands/run.mjs` | Open a durable harness run (persistent task/run identity) |
| `run finish` | `bin/commands/run.mjs` | Close a durable harness run; the ledger becomes immutable |
| `run get` | `bin/commands/run.mjs` | Read one durable harness run with its step ledger |
| `run list` | `bin/commands/run.mjs` | List durable harness runs |
| `run step` | `bin/commands/run.mjs` | Execute one conversation-tool call inside a durable run |
| `scan` | `bin/commands/platform.mjs` | Scan text for credentials (exit 4 when any are found) |
| `selftest` | `bin/commands/selftest.mjs` | Run a local self-test of this build (Node, imports, data dir, Chrome, Studio API) |
| `serve` | `bin/commands/capture.mjs` | Run the studio UI only |
| `session compact` | `bin/commands/sessions.mjs` | Compact raw records into a new sidecar directory; original raw is kept |
| `session datasets` | `bin/commands/sessions.mjs` | List the datasets you can export, with row counts |
| `session delete` | `bin/commands/sessions.mjs` | Permanently delete saved sessions |
| `session events` | `bin/commands/sessions.mjs` | Decoded protocol events (L2) of one stream |
| `session list` | `bin/commands/sessions.mjs` | List saved recordings (newest first) |
| `session prune` | `bin/commands/sessions.mjs` | Delete old sessions in bulk (dry run unless --yes) |
| `session reindex` | `bin/commands/sessions.mjs` | Rebuild the raw seek index from saved segments |
| `session show` | `bin/commands/sessions.mjs` | Everything about one session at a glance |
| `session stats` | `bin/commands/sessions.mjs` | Raw storage statistics and index coverage |
| `session streams` | `bin/commands/sessions.mjs` | Streams and requests observed in a session |
| `session timeline` | `bin/commands/sessions.mjs` | Actions, navigations, lifecycle and gaps over time |
| `shapes` | `bin/commands/sessions.mjs` | Profile suggestions inferred from a session |
| `start` | `bin/commands/capture.mjs` | Open the capture browser and the studio UI (first-run friendly) |
| `targets` | `bin/commands/capture.mjs` | List tabs in the capture browser that can be recorded |
| `tools call` | `bin/commands/tools.mjs` | Invoke one registered conversation tool on the running Studio; never retry |
| `tools list` | `bin/commands/tools.mjs` | List the running Studio conversation tool registrations (no browser action) |
| `verify` | `bin/commands/sessions.mjs` | Integrity check: hashes, sequence accounting, declared gaps |
| `version` | `bin/commands/system.mjs` | Print the version and collector source hash |

## Orphan / dead-file candidates

These are **static-import candidates, not proven dead files**. The reverse index includes literal imports from tests/scripts as well as production source. Executable entry points (`bin/`, `scripts/`, Android activity/build, Studio server, MCP stdio), browser modules and the isolated injected page agent are excluded. Computed/dynamic module lookup cannot be proven from ordinary literal import edges.

All candidates in this snapshot are provider adapters discoverable through `src/profiles/sites/index.mjs` (`loadAdapter` / computed module URL). That is a known runtime-loading explanation: **zero confirmed dead source files**. Do not delete them on the strength of this list. Other dynamically loaded modules may also appear used only by tests; a literal import does not establish production reachability.

| Candidate | Purpose | Why it may be live |
|---|---|---|
| `src/profiles/sites/deepseek.mjs` | Measured selectors for deepseek; the generic heuristic in src/capture/actions.mjs remains the fallback. | Built-in adapter discovered by provider id through the site registry |
| `src/profiles/sites/duck-ai.mjs` | Measured selectors for Duck.ai (DuckDuckGo's guest AI chat), taken from a live guest session | Built-in adapter discovered by provider id through the site registry |
| `src/profiles/sites/kimi.mjs` | Measured selectors for kimi; the generic heuristic in src/capture/actions.mjs remains the fallback. | Built-in adapter discovered by provider id through the site registry |
| `src/profiles/sites/lmarena.mjs` | Measured selectors for lmarena; the generic heuristic in src/capture/actions.mjs remains the fallback. | Built-in adapter discovered by provider id through the site registry |
| `src/profiles/sites/minimax.mjs` | Measured selectors for minimax; the generic heuristic in src/capture/actions.mjs remains the fallback. | Built-in adapter discovered by provider id through the site registry |
| `src/profiles/sites/qwen.mjs` | Measured selectors for qwen; the generic heuristic in src/capture/actions.mjs remains the fallback. | Built-in adapter discovered by provider id through the site registry |
| `src/profiles/sites/zai.mjs` | Measured selectors for zai; the generic heuristic in src/capture/actions.mjs remains the fallback. | Built-in adapter discovered by provider id through the site registry |

## Refresh / limitations

This snapshot was produced by a temporary Node inventory script outside the repository, using `git ls-files`, `git log`, full source reads, Bun declaration/import parsing and explicit dispatcher transcription. Only the two map documents are committed. To refresh, repeat that read-only process against the current ownership and scenario manifests; do not run provider effects, test suites or inspect private data contents. Add new route-dispatch shapes to the transcription rather than assuming a literal `add` scan catches every handler.

Verification for this deliverable is JSON parsing, existence of all file/directory/member/dependency/route/command paths and coverage/count reconciliation. No unit suites, live provider sends, Chrome launches or private-data reads were performed.

