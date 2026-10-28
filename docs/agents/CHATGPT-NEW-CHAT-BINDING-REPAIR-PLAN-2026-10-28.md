# New-chat binding investigation and repair plan

Scope: objective 011 only. This is a source and offline adapter investigation, not a production repair or a live pass. The recorded outcome remains PARTIAL until the coordinated operator verifies a blank composer, readiness and ownership without a send. No live status is changed by this plan.

## Source-confirmed call path and ownership mismatch

`src/studio/conversation-tools.mjs:45-47,82-94` maps create to the existing runtime's `connect` with `freshTab: true`. `src/capture/conversation-runtime.mjs:583-588,630-642` creates an unbound NEW_CHAT and passes `ownedByStudio: true` to the service. The adapter (`src/capture/conversation-browser-adapter.mjs:241-249,263-272`) requests an about:blank target, binds its exact returned ID through `hooks.bind`, navigates the idle page to the adapter home, and checks readiness. The service (`src/capture/conversation-service.mjs:379-395,400-412`) validates and persists that binding and maps a returned non-ready result to blocked.

**Confirmed reporting mismatch:** runtime `targets()` (`src/capture/conversation-runtime.mjs:497-512`) always reports `ownedByStudio: false`, including fresh owned targets. This list is not consulted by adapter readiness and does not explain its failure. A minimal prospective repair should report ownership only from current-runtime, exact fresh-target provenance. Do not infer it from origin, recording metadata, persisted ownership flags or PID; recovered or foreign targets remain unowned absent current provenance. Test lifecycle, cleanup, target-ID reuse and recovery before implementation; do not make every target owned. No production fix is made here.

## Readiness failure attribution

For an initially fresh threadless binding, ordinary returned `BINDING_CHANGED` can arise from an invalid/foreign target origin (`adapter:119-121`), foreign page origin except tolerated `null` (`123-125`), or differing target and page paths (`129-131`). `threadMatches` and `pageThreadMatches` short-circuit for an unbound thread (`74,79-81`), so branch `126-127` cannot explain the initial threadless case. These checks reject recognized existing `/c/` threads but do **not** require every accepted path to be strict root; that boundary is not evidence of the observed failure.

The `creationLocation` second target/page sample (`101-109`) can instead **throw** `BINDING_CHANGED`; service `389-392` converts an adapter throw into `needs-reconciliation` / `attachment-failed`, not the normal blocked readiness reported in 011. Therefore the live cause remains inconclusive: paired, privacy-safe target-origin category, page-origin category, path agreement and sample timing diagnostics were not observed. Do not assume loading alone or weaken real origin, path, thread, preexisting-thread, or draft fences.

## Bounded next steps

1. Run `node --test test/unit/chatgpt-new-chat-binding-investigation.test.mjs` (or compatible Bun Node-test invocation) to reproduce offline adapter branches. The tests exercise the actual adapter with injected fake dependencies; they do not prove service or live browser behavior.
2. Before any production change, design bounded, sanitized branch diagnostics that retain no raw private URLs, title, draft text or account data. Cover paired target/page observations, exception versus blocked outcomes, and timing while preserving existing owner and no-send constraints. Use injected tests for foreign and invalid origin, page null, genuine path/thread drift, preexisting thread, draft, timeout, resampling and transition races.
3. Separately test runtime provenance for fresh owned, foreign, recovered, closed, ID-reused and concurrent targets, and verify listing cannot confer ownership or change readiness. Only then consider a narrow listing fix. Service-level tests should explicitly verify thrown attachment failure becomes reconciliation while returned readiness becomes blocked.
4. After any authorized repair and fixture validation, the coordinated live probe owner may create a fresh disposable tab without sending; independently verify blank composer, readiness, exact current ownership provenance, and preservation of the original target/draft. Record actual result in the live ledger only through its owner. A source fix or fixture pass alone is not a live pass.

## Offline evidence and limits

`test/unit/chatgpt-new-chat-binding-investigation.test.mjs` persists the seven previously ephemeral scenarios: stable root, blank-to-root polling, foreign target, foreign page, target/page path mismatch, second-read blank throw, and preexisting exact thread. It also checks draft refusal. Fake effects assert only the expected fake tab request and home navigation; recorder creation, focus, typing, sending and capture ownership are forbidden. This evidence does not establish the live branch, actual Chrome timing, runtime provenance behavior, or service reconciliation mapping by execution.
