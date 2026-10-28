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
| `docs/agents/LOCAL-VERIFICATION.md` | The local gates that replaced CI (GitHub Actions removed 2026-10-28) |

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

Stages complete in order with **local observation receipts**. Each completed stage commits one immutable snapshot. A completed stage is **terminal**: reopening it to `pending`/`blocked` throws rather than erasing its receipts and rolling progress back. An incomplete stage is marked `blocked` with a reason and a retriable status. Re-running is idempotent when all four stages are complete. `bootstrap` accepts `expectedVersion: null` to mean "start **or resume**" — an interrupted first run resumes instead of returning 409 — while an integer revision stays CAS-strict. Source receipts establish *local inspection* only; they do not prove full provider e2e behavior.

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

## 2026-10-28 — major sprint: native Work, self-knowledge, continuity and export

All additions below are implemented **in source on PR #12**, not claimed as live Windows-accepted features.

### Work: explicit local lifecycle, not a provider executor

`src/agents/personal-agent-work.mjs` defines a bounded, idempotent work index inside the **same Personal Agent VersionedStore snapshot**. There is no separate queue database or new browser controller. States: `queued → active → blocked ↔ active → completed` where completion is possible from active only and requires evidence references. Cancellation is explicit; completed/cancelled records are terminal. Blocked items require a reason and can resume.

- Client-selected idempotency keys derive stable hashed Work IDs; a lost-response replay with the **same payload** returns the earlier committed item without consuming another version, even with a stale expectedVersion. Key reuse with a different payload refuses.
- All other mutations require the current version (CAS); source records and Work events remain versioned locally.
- Completion evidence is tagged `user-attested; unverified-for-live-execution`. **No completed local Work item equals a live ChatGPT scenario PASS**, and the agent cannot send anything from this model alone.
- Maximum 200 Work records and 100 events per item; bounded title, objective, note and reference sizes.
- `GET /api/v1/personal-agent/work` lists private local Work; `POST /api/v1/personal-agent/work` creates an item; `POST /api/v1/personal-agent/work/{id}/transition` updates its state. None is in the agent-invocable tool manifest.
- Native CLI: `personal-agent work`, `personal-agent queue --title ... --objective ... [--key ...]`, `personal-agent advance <id> --to ... [--note ...] [--evidence ...]`.

### Self-knowledge: claims with citations to local reality

`src/agents/personal-agent-self-knowledge.mjs` implements a read-only, deterministic claim contract:

`{topic, value, basis, evidence, observedAt, sourceUpdatedAt, freshness, authority, qualification, nextAction, trust}`.

`sourceUpdatedAt` anchors the claim to the real `state.updatedAt` (world/capabilities fall back to observation time), so freshness is falsifiable instead of a constant label. An uninitialized agent reports `{initialized:false, total:null, byStatus:null}` for Work and `{initialized:false, tiers:null}` for memory counts rather than a grounded-looking zero.

Topics: `identity`, `bootstrap`, `memory`, `work`, `world`, `capabilities`, `privacy`. The `all` topic produces a bounded grouped overview. World counts come from existing `VersionedStore`; skill sources come from the existing inert `agentic-files` inventory; tool registrations come from the existing Studio manifest. No model guesses, private Work titles, private memory text, provider-account assumptions or fictional permissions appear in the self-knowledge tool.

- `GET /api/v1/personal-agent/self-knowledge?topic=all`
- Read-only tool `personal_agent_self_knowledge`, with a closed topic enum.
- Native CLI `personal-agent self [topic]`.
- UI offers a topic selector and sources/freshness details.

### Session continuity (SITREP) and portable JSON export

`src/agents/personal-agent-continuity.mjs` reconstructs an ephemeral **private** SITREP from canonical persisted state: bootstrap evidence, recent CANON/Immediate/Curated memory, active/blocked Work and remaining actions. It explicitly marks AION agent-to-agent communications **not inspected** rather than pretending to have read them. No external action occurs. Read through `GET /api/v1/personal-agent/sitrep` or `personal-agent sitrep --json`. This private endpoint is **not** a tool for autonomous reading of memory.

The opt-in export returns `vivim.personal-agent.export/1` with a SHA-256 digest of canonical JSON payload, bounded to 1 MiB. It excludes private memory contents and Work details **by default**; explicit `includeMemory=true` and `includeWorkDetails=true` parameters include them. No credentials or remote chat history are pulled. The UI downloads JSON locally. **Export is not encrypted and import is not yet implemented**; removing memory from CURRENT does not erase historical version files.

- `GET /api/v1/personal-agent/export?includeMemory=false&includeWorkDetails=false`
- Native CLI `personal-agent export --json [--include-memory] [--include-work]`.
- UI supports explicit SITREP review and optional inclusion checkboxes for export.

### Offline regression set

`test/unit/personal-agent-work.test.mjs` covers idempotency keys, transition validation, blocked resume, evidence qualification and bounds. `test/unit/personal-agent-self-knowledge.test.mjs` checks every topic, claim basis, redaction and failed unknown topics. `test/unit/personal-agent-continuity.test.mjs` verifies explicit private SITREP, default-redacted export and SHA-256 digest. Existing service and HTTP tests now cover Work and self-knowledge recovery, same-owner token/Origin behavior, export opt-in, private-endpoint exclusion from tool manifests and absence of duplicate retries.

The GitHub Actions workflow now includes these tests plus a CLI smoke cycle for queue → Work list → SITREP → export, but GitHub has reported **runner_id 0 and zero executed steps** on failing jobs. Those jobs do **not** constitute passing Node tests. Isolated source-level function checks are narrower than Node/end-to-end acceptance.

**Update 2026-10-28: GitHub Actions is removed from this repository.** All `.github/workflows/*.yml` files were deleted; verification is local only — `bun run test`, `node bin/studio.mjs selftest`, and `node scripts/gate.mjs`. The paragraph above is kept as history of why CI receipts were never accepted as evidence. See `docs/agents/LOCAL-VERIFICATION.md`.

## Next integration depth (not silently implemented)

1. Reconcile the durable identity with a real VIVIM principal/instance schema when the canonical product identity owner is available. Migrate rather than invent duplicate principals.
2. Connect `Immediate` to the actual owner-approved current Work/commitment model; attach citations/freshness and retention policies to memory records, prevent accidental global promotion, and add explicit export/erase semantics.
3. Extend the implemented typed self-knowledge projections to full dependency and impact graphs with source-specific freshness and falsifiable claims; do not elevate local inventories into authority.
4. Connect the implemented local Work records to the **existing** harness Work/effect owner through preflight and explicit authorization, retaining evidence receipts and no-resend safeguards. Neither source files nor declarative manifests can grant permissions.
5. Add staged skill validation, discovery refresh policy, communication handoff and optional schedule semantics only after establishing one real local lifecycle and ownership contract.
6. Execute the focused Node and HTTP tests on a functioning runner; perform a local Windows restart/recovery acceptance with actual receipts before merging a runtime claim. Add a portable import/restore path only with schema checks, rollback and explicit user review.

**Constraint:** this is a foundational *product implementation*, not a general-purpose autonomous agent runtime. Keep one product, one effect owner, one canonical storage implementation and evidence-qualified claims.
