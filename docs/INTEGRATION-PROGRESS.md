# Local-world integration progress

Live ledger. Update on milestone only; not a monitor. Evidence tracking, not product decisions.
Maintainer session: `ses_e8b0588e2ffeIAOxa01JPc9IqJ`. Last update 2026-10-25 after export was
parent-verified (39-pass run) and the UI review lane completed. No other integration progress ledger exists in this repo; the blueprint
(`docs/product/V1-INTEGRATED-APP-BLUEPRINT.md`) and the separately uncommitted resource map are not reused.

## State

- HEAD: `030895e79480f23e8929e4a5de5e80d74aa8c490` (2026-10-25 17:43:43 +0100). All world work remains
  **uncommitted**; every "verified" line is working-tree evidence, not a committed SHA.
- Working tree (tracker-inspected earlier; superseded in detail by parent's full-diff inspection):
  - modified: `src/studio/integration-hub.mjs`, `src/studio/ui/chat.html`, `src/studio/ui/chat.mjs`
  - new: `src/studio/world-service.mjs`, `world-relations.mjs`, `world-search.mjs`,
    `src/studio/world-transfer.mjs`, `src/studio/ui/world-view.mjs`, and
    `test/unit/{world-service,world-relations,world-search,world-transfer,world-ui}.test.mjs`
  - deliberately separate, not part of this increment: `PROMPT.md`, `clone-tmp/`,
    `docs/MODEL-RESOURCE-MAP.md`, `docs/model-resources.json`
- Untouched by this ledger session: `PROMPT.md`, `clone-tmp/`, model resource map, all source/tests/config.

## Evidence ledger (attribute the run, not the claim)

| Evidence | Run by | Status |
|---|---|---|
| `node --test test/unit/{world-service,world-relations,world-search,world-ui,studio-local-access,studio-integration-ui}.test.mjs` | parent, after UI test fix | **44 pass / 0 fail / 0 skip**, fresh working-tree proof |
| Same combined run, first attempt | parent | 43 pass / 1 fail: `world-ui` pinned the old `#viewNote` copy ("None of them is the home"); parent updated that single assertion to `/Local edits do not change provider content/` and kept the separate no-`data-view=home` and all behaviour checks |
| `git diff --check` | parent | pass, LF/CRLF warnings only |
| `bun run scripts/architecture-inventory.mjs --check` | parent | 0 uncovered, 0 missing ownership; still valid, no structural change since |
| `node --test test/unit/{world-transfer,world-service,world-relations,world-search,world-ui}.test.mjs` | **parent, independent** | **39 pass / 0 fail**; includes a real `startStudio` `POST /world/transfer/export` test (JSON body, 400, 413, source+overlay unmodified). Narrower than the 44-run — it omits `studio-local-access`/`studio-integration-ui`, so the counts are not a regression |
| Export code review (read-only) | free reviewer `ses_e8af019bbffeqj7i6lz1OWNILg` | dispatched, **result pending** |
| HEAD/status, file presence, world-service/world-relations source read | tracker (this session, earlier) | read-only; static only |
| Full suite, live owner dataset, provider/browser proof, Windows runtime cutover | nobody | **not run** — do not claim |

HTTP note: real `startStudio` ephemeral-localhost route tests **did execute** inside the world-service,
world-search and export suites (fixture data root, synthetic bodies). That is local HTTP proof, not live
owner data, provider, browser or acceptance proof. The `world-ui` tests (now 6) use a fixture/synthetic DOM,
not a browser.

## Workstreams

| Work | Owner (session) | Paths | Status | Verification |
|---|---|---|---|---|
| Backend service/relations | `ses_e8b25fcc0ffenzM6egdIoYX4AS` | `src/studio/world-service.mjs`, `world-relations.mjs` | completed | in 44-pass run; source shows `SOURCE_MISSING`/`SOURCE_ACTIVE`/`EVIDENCE_MISSING`/`PARTIAL_EVIDENCE` split, paging before projection, request-local projection/fingerprint cache, `map` rejects `offset`, `domId`/`roleAttribute` retained |
| Search | `ses_e8b04c6d6ffeviQ5wC58oXGW7R` | `src/studio/world-search.mjs`, `test/unit/world-search.test.mjs` | completed | 13 dedicated tests in the 44; registered via `world-service.mjs` → `registerWorldSearchRoutes` |
| Selective export | `ses_e8b25fcc0ffenzM6egdIoYX4AS` | `src/studio/world-transfer.mjs`, `test/unit/world-transfer.test.mjs` | **done, parent-verified in working tree**; route registered via `registerWorldTransferRoutes` called from `world-service.mjs` | parent's independent 39-pass run includes the HTTP export test; contract as accepted (schema `vivim.world-export/1`; custody `user-overlay`/`referenced-only`/`saved-observation`; omission manifest; caps 100 selected / 256 closure / 8 MiB; 400/413; sha256 = integrity only) |
| Restore (slice 2) | `ses_e8b25fcc0ffenzM6egdIoYX4AS`, continued same session on `cliproxy-grok/grok-4.7#medium` | `world-service.mjs`, `world-relations.mjs`, `world-transfer.mjs` + tests | **active** | owner tests pending; imported custody, derived ids, no session writes, receipt last, no rollback |
| Restore contract analysis | free DeepSeek `ses_e8af019bbffeqj7i6lz1OWNILg` | read-only analysis | completed | parent reviewed and accepted **with corrections — verify claims in code, do not treat the analysis as proof** |
| UI world view + wiring | `ses_e8b0bda99ffeE6bBzA7vvt9bI7` | `src/studio/ui/world-view.mjs`, `chat.html`, `chat.mjs`, `test/unit/world-ui.test.mjs` | **review lane complete** | 5 defects fixed in `world-view.mjs` (stale save no longer overwrites later edits; per-item read errors; `memberIds` shown in linked projects; `WORLD_SOURCE_ACTIVE` message; unavailable not rendered as empty); `world-ui` now 6 tests, inside the 39; fixture DOM only, **no browser** |
| User-facing copy fix | parent | `chat.html` `#viewNote` | done | text now "Browse saved conversations, projects, and notes. Local edits do not change provider content. Your open view is remembered for this tab." No visual/layout change |
| Research (search, OpenRouter) | `ses_e8b0ac85effegfzixbdGOJWhBc`, `ses_e8b25ce90ffejuQl6Zo4QDH4GS` | research only | completed; OpenRouter proposals **rejected** (derived graph as sole semantic authority, user data seeded as captured observations, URL/session-hash merging, renderer-registry copying) | no code; none of these patterns seen in the reviewed modules |
| Free HF transfer analysis | earlier helper | analysis only | research done, **source reconciliation still required**, no implementation | none |
| This ledger | `ses_e8b0588e2ffeIAOxa01JPc9IqJ` | `docs/INTEGRATION-PROGRESS.md` | updated | read-only inspection + parent-reported milestones |

## Queue (finite, owner-authorized)

| State | Work | Owner (session) | Write scope | Depends on | Validation |
|---|---|---|---|---|---|
| active | Transfer slice 2: validate/restore with imported custody (derived ids, **no session writes**, receipt last, no rollback) | `ses_e8b25fcc0ffenzM6egdIoYX4AS` on `cliproxy-grok/grok-4.7#medium` | `world-service.mjs`, `world-relations.mjs`, `world-transfer.mjs` + their tests | export done and routed | owner focused tests, then parent rerun |
| active | Read-only review of export code | free reviewer `ses_e8af019bbffeqj7i6lz1OWNILg` | review only | export implementation | reviewer report, then coordinator triage |
| blocked | Search adaptation for imported snapshots | `ses_e8b04c6d6ffeviQ5wC58oXGW7R`, not dispatched | `world-search.mjs` + its tests | restore registered | combined focused run |
| blocked | UI imported-custody label + export/restore entry points | UI owner, not dispatched | `src/studio/ui/*` | restore registered | UI tests, fixture DOM |
| blocked | Combined focused checks, then reviewed commit/push | coordinator | none (verification only) | all rows above | full reported counts + `git diff --check` |

No item is dispatched by this ledger; dispatch happens in the coordinator session. Export is done and
parent-verified over local HTTP; restore/import acceptance, integrated live acceptance and provider/browser
proof remain unmet.

## Model policy

No Sol high, per owner. The backend lane was cancelled on Sol and continued in the same session
(`ses_e8b25fcc0ffenzM6egdIoYX4AS`) on `cliproxy-grok/grok-4.7#medium` for slice 2 only.

## Broader review still owed

Current review covered wiring, full diff and initial module sections only; UI/back-end behaviour is not
exhaustively reviewed.

## Deferred

- Browser/provider work and runtime cutover: deferred until local stability.
- Full suite and live acceptance: not attempted; formal acceptance next week, security program in two weeks.
- HF transfer implementation: behind source reconciliation.
- Model resource map: separate uncommitted artifact, not part of this increment.

## Caveats for the next writer

- **Nothing is committed.** Carry "uncommitted working tree" on any verified claim until the increment lands.
- **Wiring wording:** the hub imports only `registerWorldRoutes`; world search reaches `/api/v1/world/search`
  through `world-service.mjs`, not a separate hub registration. Same surface, indirect wiring.
- **Fixture vs browser:** the 44- and 39-pass runs and the UI tests are fixture/synthetic DOM evidence, not
  browser proof.

## Unmet goals (explicit)

Restore/import acceptance (imported custody, derived ids, no session writes, receipt last, no rollback),
import→export round trip, integrated live acceptance, full-suite confirmation, and any
owner-dataset/provider/browser proof. No deadlines are asserted for these.

## Counting rules

Catalog-free model access is not unlimited quota; no model-capacity claim is made here.
