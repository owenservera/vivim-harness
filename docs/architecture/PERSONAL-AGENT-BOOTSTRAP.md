# Personal Agent bootstrap — recovery and implementation thread

Status: **foundation in source; not wired to Studio/CLI/persistence** (2026-10-28).

## Provenance and ownership
- AION [Master Bootstrap](https://github.com/owenservera/aion/blob/main/workspace/aion/shared/agent-bootstrap-kit/MASTER-BOOTSTRAP.md): four-stage sequential agent lifecycle, tracker, evidence and no duplicate workspaces.
- AION [memory stage](https://github.com/owenservera/aion/blob/main/workspace/aion/shared/agent-bootstrap-kit/prompts/03-THREE-TIER-MEMORY.md): CANON, Immediate, Curated; owner-governed global memory separate.
- AION [skills stage](https://github.com/owenservera/aion/blob/main/workspace/aion/shared/agent-bootstrap-kit/prompts/04-SKILLS-FIRST-PASS.md): capability discoverability is not runtime success.
- VOMEGA [Personal Agent self-knowledge and command language](https://github.com/owenservera/VOMEGA/blob/main/harvests/old-vivim/symbolic/PERSONAL-AGENT-SELF-KNOWLEDGE-AND-COMMAND-LANGUAGE.md): user-instance role; existing identity, authority, capability, Work and evidence remain canonical.
- Legacy [VIVIM boot orchestrator](https://github.com/owenservera/vivim-final/blob/main/src/server/bootstrap/orchestrator.ts): recovery candidate only, not a validated drop-in.

## Scope of this first slice

`src/agents/personal-agent-bootstrap.mjs` defines four ordered bootstrap stages, a versioned serializable state, evidence-required completion, explicit blockers and recovery after reload. `test/unit/personal-agent-bootstrap.test.mjs` exercises the pure contract.

This is **not** a second database, controller, browser agent, or autonomous daemon. It does not grant external-effect permissions, infer successful tools from source presence, or overwrite existing AION state.

## Next code integration
1. Locate the canonical local-world storage and agent identity owner in this repository. Persist this versioned snapshot through that existing store; scope keys to actual principal/instance identity rather than trusting arbitrary input ids.
2. Add a read-only CLI/Studio inspection surface for bootstrap status and next missing stage. Reuse existing dispatch, authorization and audit conventions.
3. Implement each stage as an idempotent function using concrete discovery results: current identity/role, relevant shared intelligence, three-tier personal memory reconciliation, and installed/discoverable skills. Maintain source receipts and failure/blocker details.
4. Connect self-knowledge queries to the current World objects and evidence; use existing capability registry and Work lifecycle. Never copy legacy implementation without reading dependencies and tests.
5. Run restart/recovery and deterministic regression tests; separately validate any live provider behavior with the established single operator. **No browser actions are authorized by bootstrap alone.**

## Acceptance gate
A fresh user-owned agent can run ordered bootstrap, persist its verified receipts, restart, resume the first incomplete stage without duplicating work, inspect what it truly can execute, and perform a separately authorized action through the existing harness.

The current branch proves only the pure state-contract foundation; it does **not** claim this acceptance gate.
