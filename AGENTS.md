# VIVIM Harness — OpenCode entrypoint

You are in the **runnable product repo**, not AION's legacy Capture Studio. Start doing the assigned job immediately. Do not run a bootstrap ceremony, read every document, regenerate a plan, or launch agents without a concrete independent objective.

## Context feeder (three authoritative surfaces)
1. This file is the automatic root policy. **Read `context.md`** for actual native CLI commands and current runtime discovery.
2. **Read `docs/agents/OPENCODE-V2.md`** only when operating OpenCode sessions, delegation, models or subagent coordination. The coordinator loads it once before delegation.
3. For a real-user ChatGPT probe, dispatch `@chatgpt-probe` with ONE objective number from `docs/agents/CHATGPT-100-OBJECTIVES.md`. That subagent reads `context.md` plus its assigned catalog entry. Do **not** give it implementation source, recipe internals or scripted steps.
These are the only required startup context files. Other docs are task-specific, not automatic homework. OpenCode v2 discovers root AGENTS.md automatically; merely linking a file here does not automatically inject its content into every child agent.

## Immediate action
- **Probe requested:** coordinator selects distinct objectives, assigns one to each `@chatgpt-probe`, collects measured outcomes; developer fixes exposed CLI gaps *after* the independent probe. Multiple read-only probes may run, but serialize all effects on the single browser/Studio owner; no parallel Chrome drivers.
- **Fix requested:** inspect only implicated source and latest diff, implement smallest correct change on `main`, run focused tests and relevant gate, commit/push with real receipts. No feature branches by default. Preserve unrelated dirty work.
- **SITREP requested:** report current commit, actual test/effect evidence, blockers and next step; avoid broad archaeology and document churn.
- **Blocked:** report the exact missing native capability or authorization. Do not manufacture an alternative browser client or a test script.

## Product and safety invariants
- One Studio server/browser-effect owner, one authoritative journal/store, dedicated Chrome profile. **No Playwright/Puppeteer, secondary CDP controller, scripted 100-case runner or provider API substitute.**
- Browser reads are not send permissions. Navigation, sends, uploads, deletes and other effects require operator scope; unknown outcomes reconcile under the *original* key, never blind resend.
- Local Windows machine is human master. Never reset/discard data, kill active Chrome, touch credentials, install services or claim live/local verification without proof. Keep private sessions/logs/tokens outside Git.
- Real browser results are different from mocks, HTTP success and authored tests. Supported user tasks should require no more than **three native CLI commands**, preferably one.
- Small, concrete work; no status theater, duplicate registries, unnecessary subagents, Slack, or speculative rearchitecture.

## Roles and pointers
- `.opencode/agents/chatgpt-probe.md`: CLI-only unfamiliar-user evaluator.
- `.opencode/agents/local-opencode.md`: focused local implementation and runtime fixes.
- `.opencode/agents/chatgpt-aion.md`: remote GitHub and refactoring.
- Source: `bin/studio.mjs`, `src/studio`, `src/capture`, `src/recipes`; architecture inventory: `node scripts/architecture-inventory.mjs --check`.
- Permanent code simplification owner: `.opencode/agents/chatgpt-aion.md`; short evidence ledger: `docs/architecture/AGENT-CODE-SIMPLIFICATION-LEDGER.md`.
