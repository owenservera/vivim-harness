# VIVIM Personal Agent — native bootstrap scaffold

**Status:** implementation scaffold, pending successful hosted tests and local Windows acceptance.
**Date:** 2026-10-28 · **Owner:** VIVIM Harness · **Product:** VIVIM World.

## Purpose

VIVIM's principal-facing Personal Agent is a persistent local product role, not a second authority system, second database, second agent framework, separate browser controller or replacement for a provider chatbot.

The immediate goal is to give a new local instance an inspectable, resumable identity and self-description that survives Studio restarts; discovers its relevant local sources, memory and skills; and identifies the exact evidence behind each claim. Discovery never implies execution permission.

## Verified source lineage

| Source | Recovered contract | Adaptation |
| --- | --- | --- |
| [AION Master Bootstrap](https://github.com/owenservera/aion/blob/main/workspace/aion/shared/agent-bootstrap-kit/MASTER-BOOTSTRAP.md) | Ordered role/SITREP, shared intelligence, personal memory, skills | Four committed, resumable bootstrap stages |
| [AION memory](https://github.com/owenservera/aion/blob/main/workspace/aion/shared/agent-bootstrap-kit/prompts/03-THREE-TIER-MEMORY.md) | Personal CANON / Immediate / Curated; separately governed global memory | Empty scoped local tiers, explicitly user-authored entries, CAS |
| [AION skills](https://github.com/owenservera/aion/blob/main/workspace/aion/shared/agent-bootstrap-kit/prompts/04-SKILLS-FIRST-PASS.md) | Source readiness is different from installation and field success | Inert bounded inventory; evidence-qualified tool registry |
| [VOMEGA Personal Agent design](https://github.com/owenservera/VOMEGA/blob/main/harvests/old-vivim/symbolic/PERSONAL-AGENT-SELF-KNOWLEDGE-AND-COMMAND-LANGUAGE.md) | Personal-Agent self-knowledge shares canonical Identity → Intent → Capability → Authority → Work → Evidence | Local self-introspection, no claimed remote identity or auto-actions |
| [VIVIM legacy bootstrap](https://github.com/owenservera/vivim-final/blob/main/src/server/bootstrap/orchestrator.ts) | Existing historical engine wiring to study | Reference only; no speculative import |

The earlier *DNA-01 / bootstrap genome* discussion identifies future identity, purpose, boundaries, discovery, dependencies, communication, authority, evidence, adaptation, continuity and evolution dimensions. **This scaffold does not claim all of them are implemented.** They are design inputs for later verified work, not executable grants.

## Actual source and responsibilities

| File | Responsibility |
| --- | --- |
| `src/agents/personal-agent-bootstrap.mjs` | Pure schema v1, four ordered stages, validation, next-stage detection, evidence-based transitions |
| `src/agents/personal-agent-service.mjs` | Local owner, CAS persistence, explicit bootstrap, source inventory, memory CRUD with revision checks |
| `src/studio/personal-agent-routes.mjs` | Read-only status/discovery plus explicit, validated, same-owner write routes |
| `src/studio/integration-hub.mjs` | Registers routes in the **existing** Studio router and read-only tool manifest |
| `src/studio/server.mjs` | Serves the inspected UI under existing loopback/Host/Origin/token controls |
| `src/studio/ui/personal-agent.html`, `.mjs` | VIVIM World Personal Agent inspector and user controls |
| `bin/commands/personal-agent.mjs` | Native CLI lifecycle commands, using same local versioned service |
| `test/unit/personal-agent-*.test.mjs` | Unit, recovery, CAS, memory and real Studio HTTP acceptance |
| `.github/workflows/personal-agent.yml` | Focused Node 22 + CLI smoke CI |

### Local persistence owner

The existing `VersionedStore` under `src/store/versioned.mjs` is the **only** storage engine used. The dedicated dataset is `<CAPTURE_STUDIO_HOME>/personal-agent/primary`, where `CURRENT` points to an immutable versioned JSON snapshot and every mutation requires a compare-and-save expected version.

- `agentId: primary` means the single Personal Agent for this **local data directory**, not a verified global identity.
- `ownerId: local-instance` is a local scoping label, **not** a verified human identity, provider account or cross-device principal.
- Separate `--data-dir` instances stay independent.
- No passwords, provider credentials, browser profile data or remote conversations are copied into memory.
- The state includes stage evidence references, qualified source inventories and user-authored memory. The public status projection contains only memory counts, never memory text.
- Prior revisions retain historical memory values, even after removal from CURRENT: **memory removal is not secure erasure**. Disk privacy and eventual retention/erasure policy require separate design work.

### Four stages and evidence qualification

1. `identity-and-sitrep`: locally scoped primary identity; no provider account or remote principal inferred.
2. `shared-intelligence`: inspect the already-owned World store index for saved project/note counts, or honestly record an uninitialized store; no conversations are read or invented.
3. `personal-memory`: initialize/check empty CANON, Immediate and Curated tiers; does not infer private facts, promote global memory, or grant prompt injection authority.
4. `skills-and-capabilities`: inspect repository-owned, bounded agentic instruction files with the existing inert `agentic-files` library and query Studio's registered tool manifest. Partial/missing inventory roots **block** completion. Source discovery does not imply installed or live-tested skill execution.

Stages complete in order with **local observation receipts**. Each completed stage commits one immutable snapshot. An incomplete stage is marked `blocked` with a reason and a retriable status. Re-running is idempotent when all four stages are complete. Source receipts establish *local inspection* only; they do not prove full provider e2e behavior.

## Contracts

### CLI (offline; no Studio process or browser needed)

```powershell
node bin/studio.mjs personal-agent status --json
node bin/studio.mjs personal-agent bootstrap --json
node bin/studio.mjs personal-agent capabilities --json
```

Supports existing `--data-dir` selection. First bootstrap creates `primary` and completes all locally verifiable stages; subsequent bootstrap resumes the first incomplete stage.

### Studio URL and API (existing loopback server)

- Open `/personal-agent` from the **Personal Agent** link inside `/chat`.
- `GET /api/v1/personal-agent/status`: read-only; no identity creation.
- `GET /api/v1/personal-agent/capabilities`: bounded skill file inventory + registered Studio tools, with explicit "not live tested" qualifications.
- `POST /api/v1/personal-agent/initialize` with `{"expectedVersion":null}`: first initialization only.
- `POST /api/v1/personal-agent/bootstrap` with `{"expectedVersion":null}` or an integer: explicit local bootstrap/resume.
- `GET /api/v1/personal-agent/memory/{tier}`: local private memory, deliberately **not** exposed as an agent tool.
- `PUT /api/v1/personal-agent/memory/{tier}/{key}` with `{"text":"...","expectedVersion":N}`: explicit user-authored memory.
- `POST /api/v1/personal-agent/memory/{tier}/{key}/remove` with `{"expectedVersion":N}`: remove from the current snapshot, while retaining version history.

All paths are under the existing authenticated Studio router; no new listener, external HTTP endpoint, cookie or browser controller. Input is bounded and validated; failed CAS does not silently overwrite concurrent changes. Memory text is rendered with `textContent`, not HTML injection.

Only `personal_agent_status` and `personal_agent_capabilities` are exposed as agent-invocable read-only tools. Bootstrap and memory mutation are **not** exposed as tools. A request to bootstrap does not authorize external sends, navigation, data export or account changes.

## Acceptance and validation

| Gate | Current evidence |
| --- | --- |
| Pure stage ordering, evidence requirement, snapshot schema | Tests authored in `personal-agent-bootstrap.test.mjs` |
| Versioned first-run, CAS, restart/idempotence and memory CRUD | Tests authored in `personal-agent-service.test.mjs` |
| Missing root blocked, restored root resumes without redoing stages | Regression authored in `personal-agent-service.test.mjs` |
| Real Studio localhost/token/Origin HTTP, memory CAS and reopen | Test authored in `personal-agent-http.test.mjs` |
| Static page module served with CSP/token under same Studio | Studio UI route test extended |
| Node 22 parse, test and CLI first-run smoke | Workflow authored in `personal-agent.yml` |
| Actual Node tests on GitHub Actions runner | **Not yet confirmed**; reported CI run failed before any runner steps were recorded |
| Local Windows bootstrap on owner's configured data directory | **Not yet observed** |
| Real provider tool capability and end-to-end assistant Work | **Not implemented or claimed** |

Run focused tests locally on Node 22 (no Playwright/Puppeteer):

```powershell
node --test test/unit/personal-agent-bootstrap.test.mjs test/unit/personal-agent-service.test.mjs test/unit/personal-agent-http.test.mjs test/unit/studio-ui-route-contract.test.mjs
```

Do not use browser/CDP alternatives for this local-state test. Real provider acceptance, when authorized separately, remains with the existing single owner, its objective ledger and no-resend safeguards.

## Next integration depth (not silently implemented)

1. Reconcile the durable identity with a real VIVIM principal/instance schema when the canonical product identity owner is available. Migrate rather than invent duplicate principals.
2. Connect `Immediate` to the actual owner-approved current Work/commitment model; attach citations/freshness and retention policies to memory records, prevent accidental global promotion, and add explicit export/erase semantics.
3. Build typed self-knowledge projections from the existing World, capability registry and evidence; distinguish the answer's claim, basis, freshness, authority and executable action.
4. Implement controlled tool-execution capability checks through the existing harness; enforce specific authorization and log observed outcomes. Neither source files nor declarative manifests can grant permissions.
5. Add staged skill validation, discovery refresh policy, communication handoff and optional schedule semantics only after establishing one real local lifecycle and ownership contract.
6. Repeat focused Node tests and perform the first local Windows restart/recovery acceptance with real receipts before merging a runtime claim.

**Constraint:** this is a foundational *product implementation*, not a general-purpose autonomous agent runtime. Keep one product, one effect owner, one canonical storage implementation and evidence-qualified claims.
