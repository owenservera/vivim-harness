# New-chat binding investigation and repair plan

Scope: objective 011 only. This is a source and offline adapter investigation, not a production repair or a live pass. The recorded outcome was PARTIAL when this plan was written; 011's authoritative status lives in `docs/agents/CHATGPT-100-LIVE-2026-10-28.json` and is not restated or changed here. The operator gate — blank composer, readiness and ownership verified without a send — still governs any promotion.

## Source-confirmed call path and ownership mismatch

`src/studio/conversation-tools.mjs:45-47,82-94` maps create to the existing runtime's `connect` with `freshTab: true`. `src/capture/conversation-runtime.mjs:583-588,643` creates an unbound NEW_CHAT and passes `ownedByStudio: freshTab`, which is `true` on the create path. The adapter (`src/capture/conversation-browser-adapter.mjs:256-264,278-285`) requests an about:blank target, binds its exact returned ID through `hooks.bind`, navigates the idle page to the adapter home, and checks readiness. The service (`src/capture/conversation-service.mjs:379-395,400-412`) validates and persists that binding and maps a returned non-ready result to blocked.

**Reporting mismatch (fixed in source):** runtime `targets()` (`src/capture/conversation-runtime.mjs:498-518`) reports `ownedByStudio` from `ownedFreshTargetIds(...)` (`503`, decision at `515`), not a hardcoded `false`; the fix landed in `1a0c3a3`. The listing is still not consulted by adapter readiness and does not explain its failure, and it cannot see a live binding the runtime has not recorded. Ownership must come only from current-runtime, exact fresh-target provenance. Do not infer it from origin, recording metadata, persisted ownership flags or PID; recovered or foreign targets remain unowned absent current provenance. Lifecycle, cleanup, target-ID reuse and recovery remain to be tested; do not make every target owned. No production fix is made by this plan.

## Readiness failure attribution

For an initially fresh threadless binding, ordinary returned `BINDING_CHANGED` can arise from an invalid/foreign target origin (`adapter:119-121`), foreign page origin except tolerated `null` (`123-125`), or differing target and page paths (`129-131`). `threadMatches` and `pageThreadMatches` short-circuit for an unbound thread (`74,79-81`), so branch `126-127` cannot explain the initial threadless case. These checks reject recognized existing `/c/` threads but do **not** require every accepted path to be strict root; that boundary is not evidence of the observed failure.

The `creationLocation` second target/page sample (`101-109`) can instead **throw** `BINDING_CHANGED`; service `389-392` converts an adapter throw into `needs-reconciliation` / `attachment-failed`, not the normal blocked readiness reported in 011. Therefore the live cause remains inconclusive: paired, privacy-safe target-origin category, page-origin category, path agreement and sample timing diagnostics were not observed. Do not assume loading alone or weaken real origin, path, thread, preexisting-thread, or draft fences.

## Bounded next steps

1. Run `node --test test/unit/chatgpt-new-chat-binding-investigation.test.mjs` (or compatible Bun Node-test invocation) to reproduce offline adapter branches. The tests exercise the actual adapter with injected fake dependencies; they do not prove service or live browser behavior.
2. Before any production change, design bounded, sanitized branch diagnostics that retain no raw private URLs, title, draft text or account data. Cover paired target/page observations, exception versus blocked outcomes, and timing while preserving existing owner and no-send constraints. Use injected tests for foreign and invalid origin, page null, genuine path/thread drift, preexisting thread, draft, timeout, resampling and transition races.
3. Separately test runtime provenance for fresh owned, foreign, recovered, closed, ID-reused and concurrent targets, and verify listing cannot confer ownership or change readiness. The narrow listing fix already landed (`src/capture/conversation-runtime.mjs:503,515`); re-verify it rather than re-implement it. Service-level tests should explicitly verify thrown attachment failure becomes reconciliation while returned readiness becomes blocked.
4. After any authorized repair and fixture validation, the coordinated live probe owner may create a fresh disposable tab without sending; independently verify blank composer, readiness, exact current ownership provenance, and preservation of the original target/draft. Record actual result in the live ledger only through its owner. A source fix or fixture pass alone is not a live pass.

## Offline evidence and limits

`test/unit/chatgpt-new-chat-binding-investigation.test.mjs` holds the offline cases: 16 at `9560f56` — 13 table-driven readiness/binding cases (stable root, blank-to-root polling, foreign target, foreign page, target/page path mismatch, preexisting exact thread, draft present, blank composer with disabled Send, unexpected root transcript, observed stop control, disabled composer, contradictory busy state, non-home route) plus 3 standalone drift/throw cases. Lane-3 working-copy additions raise the count further. Fake effects assert only the expected fake tab request and home navigation; recorder creation, focus, typing, sending and capture ownership are forbidden. This evidence does not establish the live branch, actual Chrome timing, runtime provenance behavior, or service reconciliation mapping by execution.

## Status at this correction (2026-10-28)

Code-change items referenced by this plan are not all pending:

- **CC-01 — implemented:** the creation-preflight throw now persists the receipt, disarms capture, consumes the key and still throws the original code — `src/capture/conversation-service.mjs:290-303`.
- **CC-02 — implemented:** receipt, replay and new-key assertions exist — `test/unit/conversation-create.test.mjs:95-120`.
- **CC-07 — rejected:** the proposed `conversation_capsule` sentence claiming page-state mutation is false. `conversation_capsule` is a pure projection (`src/capture/conversation-runtime.mjs:735-739`: `peek` → `view` → `buildCapabilityCapsule`), and the shipped description stays advisory-only at `src/studio/conversation-tools.mjs:43-44`. Do not re-apply it.
