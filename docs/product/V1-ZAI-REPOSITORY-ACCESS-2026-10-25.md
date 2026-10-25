# Z.ai V1 — repository access and donor source map
**As of:** 2026-10-25 · **Evidence:** GitHub API repository visibility and individual source-file reads. This is **not** confirmation of anonymous HTTP access inside Z.ai's specific session, actual build pass, or license/secret scan.

## Visibility decision

**NO private-to-public changes required for first-pass integration.**
Canonical repository `owenservera/vivim-harness` is **PUBLIC**, default branch `main`; principal UX, schema, onboarding, MCP and packaging donor `owenservera/vivim-final` is **PUBLIC**, default branch `master`.

Z.ai's first integration should read only public sources and work/write exclusively in `vivim-harness`. If a later needed donor is private and Z.ai lacks GitHub authorization, use the existing owner's local Git checkout or narrowly scoped authenticated repository read; do not make the whole repo public. A private repo can be reviewed in a **locally authorized ZCode workspace** without changing GitHub visibility, subject to the actual local Git credentials and workspace permissions. The agent must test that access rather than assume it.

## PUBLIC — first-pass mandatory (GitHub repo metadata confirmed)
| Repository | Branch | Exact implementation files | Z.ai directive |
|---|---|---|---|
| [vivim-harness](https://github.com/owenservera/vivim-harness) | main | `ARCHITECTURE.md`; `AGENTS.md`; `docs/product/V1-INTEGRATED-APP-BLUEPRINT.md`; `docs/product/V1-ZAI-INTEGRATION-PASS-1.md`; `src/studio/ui/chat.html`; `src/studio/ui/chat.mjs`; `src/studio/conversation-api.mjs`; `src/capture/conversation-browser-adapter.mjs` | **SOLE writable destination**, source of truth and browser-effects owner; extend existing /chat and tests |
| [vivim-final](https://github.com/owenservera/vivim-final) | master | `frontend/src/app/page.tsx`; `frontend/src/features/guided-landing.tsx`; `src/schema/streaming.ts`; `src/schema/content.ts` | **Read-only donor**: layout/onboarding flow and rich native content schema. Adapt only minimal relevant behavior, not Next.js/Prisma/Tauri runtime |
| [vivim-final](https://github.com/owenservera/vivim-final) | master | `src/mcp/browser-mcp.ts`; `src/mcp/server.ts`; `src/engines/unified-registry.ts`; `src/engines/chrome-governor.ts`; `src-tauri/tauri.conf.json` | **Read-only** for later MCP/capability/packaging understanding. **Never import** independent ChromeGovernor or start second browser actor |

**Content schemas:** `vivim-final/src/schema/streaming.ts` has discriminated parts (text, reasoning, code, file, tool call/result, etc.) and `src/schema/content.ts` re-exports schemas and migration helpers. These **replace the need to access private `vivim-platform/pwa/src/types/conversation.ts`** for pass one. Preserve native unknown parts/evidence labels. Don't copy the whole Zod dependency graph into zero-runtime-dependency Harness for type shapes alone.

## PUBLIC — only for narrowly justified future gaps
| Repository | Branch | Specific existing area | Recommendation |
|---|---|---|---|
| [edge-pwa](https://github.com/owenservera/edge-pwa) | main | `extension/src/native-messaging/protocol.ts`, `backend/src/registry/acu.rs`, `frontend/src/stores/acuStore.ts` | Later conversation/ACU/Rust/extension study; **not first pass**. The native-messaging protocol includes optional token/cookie/header fields: do not import its auth boundary or credentials propagation into Harness |
| [vivim-sdk](https://github.com/owenservera/vivim-sdk) | master | `src/mcp/tools/identity.ts`, `src/core/types.ts` | Later identity/MCP integration, not first-pass required |
| [vivim-omega-os](https://github.com/owenservera/vivim-omega-os) | main | `VISION.md`, `PRODUCT-ANCHOR.md` | Product intent and semantic/execution invariants, not code to port |
| [VOMEGA](https://github.com/owenservera/VOMEGA) | main | `README.md`, `seed-docs/README.md` | Semantic command input later, no initial runtime merge |
| [zcode-pocket](https://github.com/owenservera/zcode-pocket) | main | `README.md` / Android client source | Agent/mobile control later; not needed in Harness UI pass |
| [vivim-app](https://github.com/owenservera/vivim-app) | main | `README.md`; older user-owned memory/platform product | Reference only; inspect exact implementation and freshness before selection |
| [vivim-final-enhanced](https://github.com/owenservera/vivim-final-enhanced) | inspect HEAD | `README.md` repeats Final wording | Duplicate/variant candidate; do not bulk merge |
| [vivim-final-program](https://github.com/owenservera/vivim-final-program) | inspect HEAD | `README.md` repeats Final wording | Duplicate/variant candidate; do not bulk merge |
| [vivim-scroll](https://github.com/owenservera/vivim-scroll) | inspect HEAD | `README.md` documents older collection/scraping pipeline | No automatic copying of scraping model or provider auth |
| [vivim-server](https://github.com/owenservera/vivim-server), [vivim-network](https://github.com/owenservera/vivim-network) | inspect HEAD | repo accessible publicly, root README absent via exact fetch | Do not assume implementation maturity; defer backend/P2P |
| [aion](https://github.com/owenservera/aion) | main | historical nested Capture Studio source / first-user acceptance evidence | Historical provenance only; no product writes |
| [vivim-pwa](https://github.com/owenservera/vivim-pwa) | inspect HEAD | root README seen as stock Vite template in earlier pass | Not a better first-pass chat-shell donor without source proof |

## PRIVATE — exact recommendation: keep private
| Repo | Access decision | Why |
|---|---|---|
| `vivim-platform` | **KEEP PRIVATE** | ACU and conversation model visible via authorized inspection, but public Final rich schema serves first-pass need. Broad old monorepo also brings multi-service and credential concerns. Never publish wholesale just to read one type file |
| `vivim-chrome`, `vivim-chrome-dev` | **KEEP PRIVATE** | Chrome extension/browser/account integration donors; not needed for first /chat and can overlap one-browser-actor rule |
| `cap-store` | **KEEP PRIVATE** | Large store/knowledge implementation; not needed first pass. Inspect state, data and commit history before ever exposing |
| `Product_Hub` | **KEEP PRIVATE** | Internal product discovery/intelligence tooling, not app runtime |
| `vivim-live` | **KEEP PRIVATE** | Site/marketing and scripted demo, not a prerequisite to pass-one app; exposing code adds no speed |
| `vivim-router`, `vivim-sync`, `vivim` | **KEEP PRIVATE** | Optional/legacy routing, sync or platform implementations, not selected execution dependencies |
| `ACP`, `001.PROJECTS.PM`, `SOFTWARE_HQ`, `hq` | **KEEP PRIVATE** | Personal workstation/project operations, governance and internal integration; no first-pass public donor need |
| `THESCROLL`, `3FS-OpenScroll`, `vivim-company-os` | **KEEP PRIVATE** | Separate knowledge/content/business lanes, not pass-one runtime dependencies |
| `extension-research`, `camoufox-vivim`, `stagehand-vivim`, `dify-vivim` | **KEEP PRIVATE** | Research/imported code and potentially external-license material; no reason to change visibility |

**Private source fallback (if later necessary):**
1. Keep source private and authorize Z.ai's local workspace/Git credential to clone or inspect that precise repository.
2. Or author a small, sanitized, reviewed **interface specification** in this public Harness repository. Do not paste full private code/configuration/history into public documents.
3. Consider a **new purpose-built public module** only after ownership/license/secret/history review and proven broad reuse. Do not flip a whole private monorepo to make one file visible.

## Operational Z.ai order — speed
1. Open `owenservera/vivim-harness` main. Run repository baseline and read its AGENTS/architecture/product brief.
2. Read only four public Final files: `frontend/src/app/page.tsx`, `frontend/src/features/guided-landing.tsx`, `src/schema/streaming.ts`, `src/schema/content.ts`.
3. Implement and test one coherent existing /chat user surface, provider/native-thread identity, rich parts, provenance, honest states, first-user guidance. No private GitHub credentials needed for **these source reads**, assuming public GitHub network access in Z.ai workspace.
4. Defer all private donors and nonselected public variants. If a missing interface blocks the app, describe exact method/object/acceptance in one paragraph before requesting additional access.
5. Commit code **only** to vivim-harness. No deployment, forced visibility changes, token/cookie movement or alternate browser effects.

## Specific private-repo exposure check
An exact GitHub source read confirms that private `vivim-platform/pwa/.env.development` is tracked and contains 19 assignment lines, including two variables with key/token-like names and nonblank values. These values were **not published** in this report. They may be development-only placeholders; their validity and sensitivity were **not** tested. This is another reason not to flip the entire repo public without a separate commit-history, secret and deployment configuration review.

## Exposure and access risks
- Existing Harness `.gitignore` excludes `sessions/`, `captures/`, `data/`, `chrome-profile/`, `*.sqlite`, `.env`, etc.; this is a useful safeguard, **not** a verified audit of commit history, workflows, logs or all secrets.
- GitHub states changing private → public exposes the code to everyone and allows forks; Actions history/logs can become public and push rulesets may be disabled. A publication request requires a history/secrets/licensing review separately, not a blanket setting toggle.
- Public visibility permits source READ, **not WRITE**. Z.ai must have a credentialed checkout/installation with push permission to commit to Harness.
- All repo visibility states are a GitHub API snapshot, not a guarantee of future access; verify `git ls-remote` or clone in Z.ai before making claims.

## Final verdict
**Private repositories that MUST become public to complete Z.ai's V1 first pass: ZERO.**
**Private repositories that must be accessible through credentials for first-pass reads: ZERO**, provided public `vivim-final` rich content schema is used.
**Primary integration source:** public `vivim-harness` main.
**Mandatory donor:** public `vivim-final` master.
**Later candidates:** selectively use other public repos; keep private donors private until a precise missing contract justifies authenticated read.

*No repository visibility was changed, no files were copied from private repos, and no Z.ai execution was launched as part of this audit.*
