# VIVIM V1 — Integrated Application Blueprint

**Status:** Proposed product architecture / design target, 2026-10-25. **Not** a claim of implementation, integration, acceptance, or a new mandate to replace existing code.

**Canonical application engineering repository:** `owenservera/vivim-harness`. The root [ARCHITECTURE.md](../../ARCHITECTURE.md) remains the governing architecture for **Capture Studio and its browser/evidence runtime**; this document defines the intended **integrated VIVIM V1 product experience around that runtime**. Where details collide, reconcile an explicit owner decision and measured implementation evidence before changing the governing Capture Studio contract. The AION nested copy is historical provenance, not the product edit target.

**Inputs that inform product intent, without adopting their implementations:** VIVIM-Ω `VISION.md` and `PRODUCT-ANCHOR.md`, VIVIM Final's desktop/alpha concept, VIVIM Platform's conversation and ACU concepts, VOMEGA's semantic operating environment, Product Hub's evidence-based productization, and VIVIM Harness's current source architecture. This document chooses the **product** before choosing donor code.

## 1. Product definition

**VIVIM V1 is one persistent, user-owned AI environment.**

A user brings accounts they already have (initially real AI webapp accounts), reaches them through a single understandable workspace, converses using the provider's actual surface, keeps source-grounded outputs and memory locally, relates them to projects, and returns later without recreating context. It should also mediate deliberate operations through a legible intent/authority/work/evidence path.

**User-facing promise: Own your AI · Share your AI · Evolve your AI.**

- **Own:** Local durable history, explicit origin and account identity, searchable knowledge, export/import, recoverability. The provider remains authoritative for the provider's remote conversation; VIVIM owns its local observed record, organization and user decisions.
- **Share:** Share a selected, inspectable and sanitized export of conversation/artifacts/project knowledge; no assumed cloud sync or public sharing requirement. Never silently export account cookies, raw capture secrets, or another person's content.
- **Evolve:** Improve the user's *own context and workflows* through edits, reusable instructions, traceable suggestions and reversible adapter/knowledge corrections. Autonomous self-rewriting, cross-site effect inference and global learning are not V1 requirements.

**The strategic inversion:** VIVIM is not fundamentally a chatbot + plugins, canvas + chatbot, or web-capture tool + database. It is a **persistent personal semantic world with governed execution and replaceable external intelligence**, first realized through AI webapps. A provider, model, browser, desktop window, UI framework and agent runtime are replaceable realizations, not identity or authority.

### Primary audience

One individual using multiple AI services and doing repeatable work; beta testers are trusted individual Windows users with their **own** accounts and data. Professional/project power users can use more of the same core without creating enterprise administration in V1.

### The day-one user-level test

"Use my existing AI account for a real question, save what came back in my project, find it tomorrow, and continue the same real conversation without VIVIM losing the provenance or pretending an operation succeeded."

## 2. V1 information architecture — one application shell

**Brand at the surface: VIVIM.** Harness and Capture Studio can remain technical product/module names, not separate visible products for ordinary users.

The default is a **single primary workspace**, designed around a live conversation and its context:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ VIVIM  [ Search anything or express an intention... ]   [Account] [Activity] [Settings] │
├──────────────────────┬──────────────────────────────────────┬──────────────────────────┤
│ Navigation           │ Work surface                          │ Context inspector        │
│ Home                 │                                      │ Active provider/account  │
│ Workspaces           │ Conversation | Artifact | Canvas     │ Native thread identity   │
│ Knowledge            │                                      │ Evidence/source status   │
│ Connected AI         │ Native rich messages and streams     │ Saved knowledge          │
│  ChatGPT             │ Genuine tool/artifact parts          │ Project associations     │
│  Claude              │                                      │ Related conversations    │
│ Recent conversations │ [Context attachments / preview]      │ History & revisions      │
│                      │ [Composer]                  [Send]    │ Save · Export · Inspect  │
└──────────────────────┴──────────────────────────────────────┴──────────────────────────┘
```

- **Left:** Home, Workspaces, Knowledge, connected providers, recent conversations. This is *one provider-and-thread library*, not one independent client per website. Provider account unknown, signed-out and unsupported capability states remain visible.
- **Center:** The active work surface. Usually a single native-provider conversation, but a saved artifact, project document or project canvas can occupy it. Composer displays the precise provider, account, thread, action and capabilities; an action never quietly targets another tab.
- **Right:** Optional contextual inspector with source evidence, knowledge, project membership, decisions, links, revisions and actions. Collapsible, never required to send.
- **Top omnibox:** One location for navigation, local search and inspectable natural-language intentions. Distinguish **search** vs **ask provider** vs **perform an effect** before executing.
- **Canvas / Vita:** A **view** of the same persistent objects, initially compact project boards/cards/links. The future infinite canvas is an advanced view, not an alternative store or a blocker to conversation V1.
- **Advanced evidence view:** Raw layers, network traces, profiles, adaptation, fidelity and diagnostics are accessible when useful but do not dominate the first user's screen.
- **Mobile:** Responsive reading/triage where feasible. Native Android and remote device management are separate later surfaces over the same identity/world model, not required for Windows V1.

### User journeys

**J1 — First open / connect.** Install/open VIVIM → short orientation and local-data explanation → connect an authorized provider in a distinct locally controlled browser profile → sign in normally → show actual account/provisionally known account, provider identity and capability truth → no fake demo result counted as a connection.

**J2 — Conversation.** Open an actual existing native thread or start a new provider thread → observe known messages with roles/parts/revisions → compose one explicit prompt → preview selected provider/thread and authorization → one guarded effect → display streaming/native response with source and completion status → follow up *in the same native thread*.

**J3 — Personal ownership.** Save a result, code block, document or selected answer into a workspace → preserve the source conversation/message/part/revision and observation link → search later across saved items → open a local copy even when provider is unavailable → jump to the live provider thread when it remains accessible.

**J4 — Contextual continuation.** Open a project tomorrow → view prior work and approved context → choose provider and specific real thread → explicitly include selected context in a new message if requested → continue. No private project context silently sent to providers.

**J5 — Share and evolve.** Export a user-selected project/conversation/artifact bundle with a clear preview/redaction choice; reimport without losing source labels. Correct an inferred memory item and keep who/what/when provenance. V1's evolution is user-confirmed and reversible.

**J6 — Act, inspect and recover.** "Ask Claude to summarize this project note" → show resolved intent and target → authorize the specific effect → create durable Work entry → execute once through the sole browser authority → show observed result or **uncertain** state with read-only recovery, never automatic blind resending.

### Navigation object types

A provider conversation is **not** a browser tab. A workspace is **not** a provider folder. A message is **not** a captured stream. An artifact is **not** always plain text. A knowledge claim is **not** an unqualified fact. An attempted action is **not** proof of success.

## 3. Logical application architecture

```text
 PERSON — Desktop shell / localhost web shell / later mobile shell
                       │
     [Unified UX: Chat · Workspaces · Knowledge · Activity]
                       │ same-origin versioned API/events
                       ▼
     VIVIM APPLICATION SERVICE (one local authority)
       ├─ Identity + ProviderAccount + local Workspaces
       ├─ Intent interpretation → typed capability resolution
       ├─ Authorization/consent → durable Work journal
       ├─ Conversation & native content projections
       ├─ Search, knowledge, memory, context assembly
       ├─ Source/evidence inspector and export/import
       └─ Read interfaces: UI / CLI / MCP (same services)
                       │ explicit command + read boundaries
                       ▼
    VIVIM HARNESS — ONLY BROWSER EFFECT OWNER
       ├─ Exact provider/account/thread/target binding
       ├─ Adapter capability truth + versioned read profiles
       ├─ Authorized CDP effect execution, one action at a time
       ├─ Uncertain-outcome read-only reconciliation
       └─ Raw L1 → decoded L2 → DOM/native L3 observation
                       │
                       ▼
      EXTERNAL AI WEBAPPS / PROVIDER ACCOUNTS
                       │
                  observed events
                       ▼
       APPEND-ONLY SOURCE EVIDENCE + INTEGRITY
                       │ reconstruct/derive
                       ▼
      NATIVE CONVERSATION PROJECTION + KNOWLEDGE
                       │
                       ▼
          PERSONAL WORLD / WORKSPACES / SEARCH
```

The paths above are **logical boundaries**, not a demand for twelve new packages, engines, agents, databases, or microservices. Extend existing Harness interfaces/modules in place where they fit.

### Named responsibilities (not separate applications)

| Logical responsibility | Owns | Does **not** own |
|---|---|---|
| **Experience** | Shell, rich content rendering, user intentions, context visibility, uncertainty UX | Provider-specific browser scripting |
| **Identity/World** | Local person, provider-account references, workspaces, membership and durable relationship graph | Provider credentials or external account truth |
| **Intent/Capability** | Deterministic typed operation, target, declared support, preview, policy inputs | Permission to invent an effect from inferred selectors |
| **Work/Authority** | Consent decisions, idempotency/attempt IDs, journal, outcome state, read-only recovery | Direct CDP calls |
| **Harness Runtime** | Sole browser ownership; provider/thread exact binding; known reads and authorized effects | General personal project memory |
| **Observation/Evidence** | L1/L2/L3 original observations, gaps, hashes, time, source qualification | Unqualified semantic assertions |
| **Conversation Projection** | Native thread/message/part/revision model as supported by evidence | Making unsupported provider features look implemented |
| **Knowledge/Context** | User-approved or evidenced derived knowledge, linking, search and context selection | Quiet reinterpreting raw evidence or sending data to providers |
| **Interoperability** | Versioned export/import, facade for CLI and later MCP | A second execution engine or registry |

### Runtime and packaging principle

Start with the **existing zero-runtime-dependency Node >=22 Harness local application** as the one process/core and one loopback-origin API wherever possible. A desktop wrapper/installer is an **optional shell around that same service**, not a second Bun backend with its own provider governor. The app should not require a paid cloud, a new API-key chatbot stack, P2P mesh, PostgreSQL, remote fleet or a cloud account for its first useful task.

Any Tauri/desktop packaging choice is separately validated against current Windows host, installer assets, signed/unsigned behavior, update/rollback and clean-user installation. Do not assume a past installer or independent release workflow already ships Harness.

### Physical source layout (illustrative future, not a refactor instruction)

Retain existing `src/capture`, `src/cdp`, `src/decode`, `src/store`, `src/replay`, `src/intel`, `src/profiles`, `src/studio`, `src/export`, `src/mcp`, `bin`. Product-level UX/world/work boundaries may appear as small modules inside these or narrow new `src/app` / `src/world` paths *only when a concrete user journey needs them*. All code is committed to **`vivim-harness`**. Donor repos remain read-only reference until a later design-driven harvest decision.

## 4. Durable personal-world object model

Objects have stable **VIVIM local IDs** plus optional source-native identifiers; never conflate the two.

| Object | Essential fields and semantics |
|---|---|
| `Person` | Local owner identity and settings; no public account required |
| `ProviderAccount` | Provider, account evidence/label, independent local realization/profile ref, authorization and connection state; no transferable cookies |
| `ProviderThread` | Native conversation identity (or UNKNOWN), account, site/origin, live/openability status and observation timestamps |
| `Conversation` | Stable local ID, source relationship(s), message references, versioned local metadata; provider-owned native thread may change |
| `Message` | Provider/native message ID if observed, role, order, time confidence, revision lineage, evidence links |
| `ContentPart` | Text, reasoning visibly shown, code, table, math, image, citation, tool activity, file/artifact and unknown opaque native blocks |
| `Artifact` | Durable item, version/revision, owner workspace links, source parts, readable local representation and original modality |
| `Workspace` | Project-oriented collection of conversations, notes, knowledge, artifacts and Work, without duplicating their source identity |
| `EvidenceRef` | Local source session, ordered event IDs/offsets, layer, raw/hash receipt, temporal coverage and gaps |
| `KnowledgeItem` | Assertion/summary/relationship, evidence provenance, derivation vs human approval, confidence, corrections and tombstones |
| `Intent` / `Capability` | Human request and explicit deterministic action contract with support, target and effect classification |
| `Work` / `Attempt` | Authorization, target binding, pre-effect state, attempt IDs, observations and outcome including UNKNOWN |

**Truth distinctions:**

1. **Native/provider truth**: provider's actual remote app state; VIVIM may observe it but not pretend to own it.
2. **Local observed truth**: what specific L1/L2/L3 evidence actually recorded, with source, time and gaps.
3. **Derived/semantic interpretation**: inferred roles, synthesized knowledge, confidence and lineage, always qualified.
4. **User decisions**: selected associations, corrected knowledge, explicit effects and approved context, with a journal.

No invented native thread IDs; no reading arbitrary unrelated account conversations to assign identity. Signed-out and incomplete states are first-class and user-visible.

### Evidence-to-value data flow

```text
External native page/stream
  → immutable append-only observations (L1/L2/L3 + gaps)
  → deterministic protocol replay + account/thread attribution
  → native conversation/message/part/revision projection
  → personal-world search/index + project membership
  → evidence-qualified knowledge candidates
  → user-selected/approved context and saved reusable artifacts
  → explicit export or continued provider interaction
```

Raw evidence remains recoverable and separately protected. Indexes and graph projections are derived/rebuildable. Choose concrete persistence/indexing engines after measuring current Harness storage, data sizes, query needs and migrations; **do not create a parallel canonical message store or knowledge engine by default**. Any SQLite index is a materialized view, never a replacement for immutable source evidence.

## 5. Intent → authority → Work → effect contract

```text
input → parse candidate intent → identify exact capability/target
      → show effect/required consent and context disclosure
      → journal approved Work + idempotency key
      → single Harness effect dispatch with lease
      → observe native effect + response + provenance
      → reconcile (read-only when outcome uncertain)
      → complete / fail / uncertain; persist and render
```

- **Read-only by default**; search/read/index/inspect are reads. Browser mutation (send, delete, upload, rename, edit, open external link in certain contexts) requires explicit effect authorization.
- **One browser-effects owner** across CLI, UI, MCP and future agent clients; never allow two actor stacks on the same CDP target.
- Bind by exact provider, account where verified, origin, native thread, target and attempt. Tabs are temporary attachments, not identity.
- An uncertain send is not retried automatically; continue with read-only native reconciliation or show a recovery instruction. Persist across restart.
- Typed capability registry reports actual `read-ready`, `effect-ready`, `requires-login`, `requires-authorization`, `unsupported`, `drifted`, `unavailable` statuses; never advertise thousands of catalog placeholders as completed actions.
- Adaptive learning may propose **read-side** profile changes only with source-qualified evidence, independent validation and rollback; it does not authorize arbitrary browser effects.
- Natural language interpretation can suggest targets/operations; **deterministic rules and user consent govern actual effects**. An AI is not the permission authority.

## 6. V1 product scope and staged acceptance

**The V1 architecture is broad, but the first accepted journey must be small and complete.** Stage by technical acceptance, not invented date commitments.

| Stage | User-visible result | Minimum proof |
|---|---|---|
| **V1-A — Functional spine / private owner preview** | Single Harness-hosted VIVIM shell; connect one own real provider; open/create native thread, send, receive native rich response, follow up in SAME thread | Live Windows owner-account run, exact identity/effect evidence, restart recovery, no fake completion |
| **V1-B — Own it / first friends** | User-friendly install/open; library and search; local save-to-workspace; inspect origin; export selected conversation/artifact; return/reopen | A new tester uses their own profile, completes one genuine task unaided and rediscovers it after restart |
| **V1-C — Unified V1** | Two independently accepted provider integrations through one surface; cross-provider library, reusable project context with explicit disclosure; source-linked knowledge; selected sharing export; accessible basic project view | Multiple native thread/account cases per provider, import/export round trip, uncertainty and crash recovery tests |
| **V1-D — Extension points** | One deterministic capability API behind UI/CLI/MCP; an optional semantic command surface and canvas/projection view | Real MCP handshakes and tool calls, same result/permissions as UI, no second actor; advanced UI remains optional |

**Release naming:** Stages above describe the product's complete V1 direction. A or B can be called a **private beta**, not falsely marketed as complete V1-C. V1-C is the coherent user-facing target; V1-D is an extension after the core experience is trustworthy.

### Explicitly not required for V1

Thousands of headless cloud pods; third-party training-data marketplace; guessing hidden model reasoning from SSE; multi-agent debate arena; planet-scale capture; unattended campaigns across unauthorized accounts; cloud credential vault replication; local-vs-cloud P2P synchronization; enterprise IAM; multiple separate browsers/servers/registries; autonomous code self-repair; model-provider API substitution for actual logged-in webapp interactions; universal coverage of every website. These can be researched later as independently justified products or extensions.

## 7. Safety, privacy, security and provenance UX

- Local user data lives outside Git. Raw network mode can retain sensitive tokens/headers and conversation content; show the sensitivity plainly, bound storage growth, protect local directories and never auto-upload captures.
- Only authorized, explicitly chosen accounts/surfaces. No login bypass, cookies transferred across friend devices, silent harvesting or cross-account inference.
- Local HTTP is loopback-only with origin/host checks and appropriate app-local authentication or CSRF protection where needed; do not assume localhost implies a browser-exposed endpoint is safe.
- Exports default to a clear preview of contents and redaction; no raw credentials, browser profile or private evidence attached unless the owner explicitly chooses a safe local archival path.
- Preserve native rich parts and source links, including incomplete/differing stream/page evidence. Missing data should be marked missing, not silently reconstructed as definite.
- For interrupted or uncertain effects, the UI communicates whether the effect was **attempted**, **observed**, **verified**, or **unknown**. Show recovery action separately from retry.
- Search and memory suggestions may use content locally; sending context to an external provider requires the user's knowledge and deliberate selection.
- Keep test fixture/synthetic evidence, saved real data, browser connectivity and live acceptance as different proof levels.

## 8. Invariants for all integrations

1. **One code authority:** `vivim-harness` for the integrated V1 application's source. Historic AION directories are not a second product line.
2. **One browser effect owner:** no parallel CDP/extension/governor control of the same provider session.
3. **One user-facing shell:** grow the existing `/chat` experience; advanced pages are tools, not rival apps.
4. **One canonical relationship model:** native provider IDs, local IDs, source evidence and derived knowledge stay distinct.
5. **No second source of truth:** immutable original evidence; derived indexes and project projections are rebuildable or explicitly user-authored.
6. **No speculative success:** verified send/reply and provider-specific feature support are observable facts, not interface cosmetics.
7. **No invisible authority escalation:** read-side learning never turns into an unapproved effect.
8. **No irreversible consolidation before conformance:** harvest comparisons happen only after this blueprint's interfaces and acceptance cases exist.
9. **No framework lock-in:** webapp realization first; UI, CLI, mobile, MCP and future models are adapters to the same local capabilities and Work.
10. **Release product before platform expansion:** first two real users accomplishing actual tasks beats 3,000 unimplemented declared capabilities.

## 9. Measurable product acceptance

**First-user activation:** can install/open, sign into provider's own browser account, identify correct thread, issue one authorized prompt and see a verified non-simulated reply without developer guidance.

**Continuity:** two context-dependent native turns in one verified native thread; after restart the conversation and related project artifacts can be located and resumed without cross-account confusion.

**Ownership:** local saved output remains viewable when provider disconnected; an export/import round trip retains native content types (or labels lossy transformations), source lineage and user corrections.

**Trust:** never show provider send as successful without accepted observed evidence. On intentionally uncertain operation, no auto-repeat. Provenance and source incompleteness are legible. No private data leaks into telemetry/Git.

**Cross-provider:** at least two independently tested webapp adapters satisfy the same minimal connect → read → send/follow-up → observe → save contract. Optional native operations are advertised only when validated.

**Distribution:** reproducible installer / launch process, checksum and release notes, recoverable error path, restart and uninstall preservation rules; friends can share actionable feedback. Windows host proof is separate from CI/offline tests.

**Product signal:** at least two beta users independently complete a real flow, can explain what VIVIM adds compared with using provider UIs directly, and can return to the saved result later. Collect effort/time and actual breakdowns, not impressions alone.

## 10. Decisions and unresolved questions (explicitly non-blocking until implementation)

**Proposed defaults:** product label VIVIM; engineer repository `vivim-harness`; desktop-first localhost single runtime; external provider webapps as first realization; stable local world IDs + linked native IDs; optional project-board canvas view; no paid cloud account requirement; Harness retains browser effect ownership.

**Validate before committing tech:**
- Exact GUI technology: extend existing plain Studio UI, selectively adapt richer components or embed a slim desktop shell? Choose by actual accessibility, build size, maintainability and first-user friction.
- Persistence/index physical layout: current Harness derived files vs minimal embedded index; do not duplicate transcript authority.
- Provider discovery: which first two providers have genuine, live proven native capability surfaces? The answer should be evidence-driven, not a headline list.
- Desktop packaging: whether an existing Windows shell can wrap the one Harness Node process without spinning up a second backend.
- Project/context UX: exact mechanism for attaching user-selected context and preserving consent history.
- Share/export format: minimum portable, documented package with source summaries and user-controlled sensitive fields.
- MVP canvas: does an accessible project-card/relationships view provide enough value before an infinite spatial editor?
- Memory confidence/corrections: how to preserve sourced assertions and avoid probabilistic self-reinforcing mistakes.

## 11. How to use this document

**First:** review product experience, journeys, object semantics and V1-C acceptance. This is the design alignment step.

**Second, and only then:** inspect older repositories and produce a **contract-to-existing-code** matrix: each proposed responsibility → existing candidate source → verified actual behavior → delta → license/identity/authority hazards → KEEP/ADAPT/REFERENCE/REJECT. Avoid starting from repo names, feature counts or vendor claims.

**Third:** implement one vertical slice in `vivim-harness` and independently validate live provider behavior on Windows. No massive import, new controller, second UI or parallel data engine merely to satisfy a target diagram.

### Product decision needed before donor/harvest planning

Confirm or amend the one-sentence definition: **VIVIM V1 = a persistent personal AI workspace built around governed real-provider interactions, source-grounded continuity, reusable knowledge and one user-owned local world.** This makes **Harness the runtime**, **VIVIM the app**, and **other projects potential implementations of selected contracts**, never the architecture's authors.

## Source references

- [Canonical Harness governing architecture](../../ARCHITECTURE.md), [Harness architecture atlas](../../architecture/components.json), [Harness README](../../README.md).
- [VIVIM-Ω vision](https://github.com/owenservera/vivim-omega-os/blob/main/VISION.md) and [product anchor](https://github.com/owenservera/vivim-omega-os/blob/main/PRODUCT-ANCHOR.md).
- [VIVIM Final friends-and-family alpha plan](https://github.com/owenservera/vivim-final/blob/master/docs/alpha/00-ALPHA-RELEASE-PLAN.md) (historical source assessment, not accepted live product proof).
- [VIVIM Platform conversation model](https://github.com/owenservera/vivim-platform/blob/main/pwa/src/types/conversation.ts) (candidate semantics, not adopted implementation).

*No implementation, migration, test execution, desktop installation or live provider interaction is claimed by this blueprint.*
