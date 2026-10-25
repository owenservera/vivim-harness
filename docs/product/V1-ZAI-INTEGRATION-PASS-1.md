# Z.ai — VIVIM V1 first integration pass
2026-10-25 · EXECUTION BRIEF · canonical repo: owenservera/vivim-harness
Companion product contract: docs/product/V1-INTEGRATED-APP-BLUEPRINT.md
Repository visibility/public donor map: docs/product/V1-ZAI-REPOSITORY-ACCESS-2026-10-25.md
All first-pass donor source reads must use public repositories; do not request publication of private donors.
Governing Capture Studio implementation contract: ARCHITECTURE.md, AGENTS.md

## Mission
Deliver meaningful implementation of **one VIVIM conversation workspace** over the EXISTING Harness runtime. Reuse discovered donor sources only when a narrow contract can be satisfied without adding another browser actor, backend, registry or source-of-truth. No code in AION nested legacy copy. No other repository changed.

## First-pass product target
A single /chat page shows (a) provider selection and actual signed-in/unsupported status, (b) connected/existing native conversations and local saved sessions, (c) selected native thread and conversation transcript, (d) one composer and explicit Send for currently supported actions, and (e) capture/source state and export/revisit controls. Already available functionality must remain accessible. One user must be able to connect, inspect and interact without navigating different Capture Studio pages.

## Existing canonical source — inspect before editing
- src/studio/ui/chat.html and src/studio/ui/chat.mjs — the sole /chat shell and state/display helpers. Grow these **in place**.
- src/studio/server.mjs — existing local app API/server.
- src/studio/conversation-api.mjs — thin facade; existing runtime owns exact target/thread lifecycle.
- src/capture/conversation-browser-adapter.mjs and src/capture/conversation-service.mjs — exactly one CDP effect owner; preserve leases, source acceptance, thread identity and uncertain action recovery.
- src/replay/, src/intel/, src/store/, src/export/ — source-qualified data, indexes, saved artifacts and exports.
- src/mcp/ — check actual modules before any MCP decision, no parallel bridge.
- test/unit/, test/e2e/ — extend existing deterministic fixtures, including adversarial state/identity tests.
- package.json: Node >=22, no runtime dependencies. Preserve this deployment advantage unless a measured benefit justifies change.

## Donor assessment — NO blanket copying
| Decision | Exact donor path | Why / required outcome |
|---|---|---|
| REFERENCE UX | PUBLIC vivim-final/frontend/src/app/page.tsx and frontend/src/features/guided-landing.tsx | Existing canvas/entry/onboarding concepts only; do not import Next, provider hooks, app router or backend. Current Harness architecture explicitly directs copying chat-column *shapes*, not mounting VIVIM Final ChatSurface |
| REFERENCE UI content types | PUBLIC vivim-final/src/schema/streaming.ts and src/schema/content.ts | Map text/code/math/table/tool/citation/image/unknown parts into source-qualified Harness display; adapt shape only, no Zod/runtime import. Private vivim-platform is NOT required. No lossy flattening; preserve unknown native blocks |
| KEEP local API | vivim-harness/src/studio/conversation-api.mjs | Read capabilities and source-qualified lifecycle, no duplicate /api/conversations |
| KEEP sole browser actor | vivim-harness/src/capture/conversation-browser-adapter.mjs | No second CDP owner |
| DO NOT IMPORT | vivim-final/src/engines/chrome-governor.ts | Would duplicate browser actor, fleet/session lifetimes |
| REFERENCE only | vivim-platform/pwa/src/lib/db/vivim-db.ts | Never introduce a parallel canonical transcript store |
| DEFER | vivim-final/src/engines/memory-engine.ts and vivim-platform/acu/src/types.ts | Next workstream: source→knowledge contract only after direct conversation V1 journey is usable |
| DEFER | vivim-final/src/mcp/browser-mcp.ts and src/mcp/server.ts | Existing MCP designs exist; adapter publish follows real supported capabilities |
| DEFER | vivim-final/src-tauri/tauri.conf.json and src/desktop/sidecar-entry.ts | Packaging donor only once one-Harness-runtime UX is verified; avoid shipping second Bun backend |
| DEFER | vivim-sdk/src/mcp/tools/identity.ts, zcode-pocket, VOMEGA, vivim-chrome | Not needed to prove first usable conversation |

## Execution gates in exact order

### Gate 0 — Repo and contract truth
1. Fetch latest main HEAD, git status, AGENTS.md, ARCHITECTURE.md, blueprint, and source above. Pin commit. Inspect existing owner-owned tests/changes and do not overwrite simultaneous work.
2. Identify existing provider rail/index/transcript/composer functions in chat.mjs and API calls already exposed. List them in <=25 lines in final report, no new architecture essay.
3. Run **existing** focused test baseline and relevant full unit suite first; report exact counts and SHA, not unverified claims.

### Gate 1 — One cohesive shell (ship code)
1. Edit existing chat.html/chat.mjs only where possible. Provider rail, account/thread status, searchable conversation list and full transcript/composer should cohere in ONE screen.
2. Use current same-origin API and lifecycle. Provider index must report actual capability; no phantom "connected" state. Distinguish local saved sessions from remote native threads and open CDP tabs.
3. First-run guidance should be concrete: launch dedicated provider browser profile, sign into their own account, select a supported thread. No fake providers and no private data samples.
4. Preserve original capture/drive/export diagnostics in secondary inspector/actions instead of replacing runtime. Right-side context panel may be shallow and collapsible.
5. Extend current UI unit tests for provider status, no provider account, unknown thread, source discrepancy, prior unsent draft, reconnection, narrowing widths and non-empty transcript.

### Gate 2 — Native content and continuity
1. Build a **small presentation adapter** at the existing conversation projection boundary only if current UI cannot present existing native parts (do not create new authoritative transcript store).
2. Preserve role, ordered parts, visible reasoning labels, tools, citations, unknown-opaque parts, stream completion, provenance and unverified markers; no invented "thought" tokens.
3. Make selected thread identity visible; confirm no sending to a different thread after tab switch. Distinguish separate new chat from follow-up.
4. Restore view/session selection after app restart where current persisted IDs are valid. If native link is stale, show truthfully and allow safe reconnect, not guessed link.

### Gate 3 — Honest acceptance + integration handoff
1. Run focused Node native test suites; run project full tests and architecture inventory check `node scripts/architecture-inventory.mjs --check` where available. Do not run Playwright or Puppeteer.
2. Synthetic/offline tests must include wrong-account/thread, unknown-effect delivery, signed-out provider, duplicate streamed delta, incomplete rich part, export missing source, restart and no-autoresend cases.
3. If owner Windows live browser is accessible under authorized scope, use the **existing** CDP actor to prove connect→read→real send→source-linked response→same native thread follow-up→reopen. No actual send without explicit owner authorization; do not infer authorization from this GitHub brief. When unreachable, mark **LIVE BLOCKED**, document exact reproduction steps for owner local runner and do not claim completion.
4. Commit and push **working tested code and tests** on intended safe branch/PR or main consistent with current AGENTS.md and concurrent ownership. Provide changed paths, test commands/results, commit SHA, true missing pieces and immediate next fix.
5. Do NOT add a new architecture/research folder, redundant browser service, auth vault, standalone MCP service, storage engine, swarm, container orchestration, or half-implemented canvas.

## Decision rubric for unplanned donor code
For each possible import, record ONLY: (contract needed; existing Harness equivalent; donor path; benefit to first-user experience; measured dependencies; identity/effect risks; decision KEEP / ADAPT / REFERENCE / REJECT; test). ADAPT only if it removes a demonstrated V1 gap at lower risk/effort than extending existing Harness. Avoid migrating dependencies or giant files for visual style alone.

## Exit condition
Gate 1 and Gate 2 demonstrably improve the app on current source, with tests and commit. Gate 3 gives an honest independent evidence grade (offline vs saved-real vs Windows-live). Report unachieved requirements clearly. Integration is NOT complete just because documents, UI screenshots or fixture tests exist.

## Z.ai operating style
Engineering-first: use the latest source, implement direct changes, no ceremonial handoffs or fan-out agents, no speculative long-horizon features. Keep one source of truth and single Browser actor. Prioritize speed and preserved correctness.
