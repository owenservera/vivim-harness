# Local-world integration progress

Live ledger. Update on milestone only; not a monitor. Evidence tracking, not product decisions.

Maintainer session: `ses_e8b0588e2ffeIAOxa01JPc9IqJ` (this docs lane), `docs-only` scope. Last update
2026-10-26: world work is now **committed** at `803d165`; the world UI has Find, Transfer and Relations views;
C-10 and C-11 exist as unwired libraries. Counts below are split by who ran them. No live, provider, browser,
owner-dataset or full-suite proof exists.

## State

- HEAD: `803d165a9a8b7814f45128060c0f66b5b851659c` (2026-10-26 00:01:31 +0100),
  `fix(agentic-files): root-id/alias rejection, realpath containment, uniform 404, no cosmetic capability claims`.
- Working tree: clean except two deliberately separate untracked paths, `PROMPT.md` and `clone-tmp/`.
  Verified by `git status --porcelain` in this lane. Everything else in this ledger is a committed SHA.
- Committed increments:
  - `4c2cd04` backend local world service, relations, search, export/restore with imported-snapshot custody
  - `2d74a09` selectable export modes (`references` | `transcript` | `full-saved`) with explicit reasoning/tool parts
  - `2c62a6d` C-10 semantic command catalog, preview-only, non-executing
  - `f728480`, `458efde` Relations view; labelled reasoning/status/tool blocks; provenance, direction, availability,
    truncation honesty
  - `eb38013` export mode picker with reasoning/tool toggles and server-applied preview
  - `803d165` C-11 read-only agentic-file library, hardened twice, **not mounted**
- Product module map unchanged: `src/studio` (UI/API), `src/capture`, `src/decode`, `src/store`, `src/replay`,
  `src/intel`, `src/profiles`, `src/export`, `src/mcp`, `bin`.

## Evidence ledger (attribute the run, not the claim)

| Evidence | Run by | Status |
|---|---|---|
| `node --test` over the 13 `test/unit/world-*.test.mjs` suites + `agentic-files.test.mjs` | **this docs lane, 2026-10-26, HEAD `803d165`, clean tree** | **101 pass / 2 skipped / 0 fail, 103 tests** (8757 ms) |
| `node --test test/unit/agentic-files.test.mjs` alone | this docs lane | **21 pass / 2 skipped / 0 fail, 23 tests** — the 2 skips are platform-gated (symlink/realpath cases), not failures |
| `node scripts/architecture-inventory.mjs --check` | this docs lane | **0 uncovered, 0 missing ownership** |
| 88 pass across 14 world/UI suites | parent (owner rerun) | reported, not reproduced here; my 103-test run uses a different suite set (it excludes `studio-local-access`/`studio-integration-ui` and adds `world-export-modes`, `world-import-content`, `world-search-imported`, `world-ui-relations`, `world-ui-transfer`, `world-ui-export-modes`). Neither count supersedes the other |
| 63 pass across UI + agentic suites | parent (owner rerun) | reported; the `world-ui-*` suites plus `agentic-files` are fixture DOM and read-only library tests |
| 56 / 58 focused tests after restore and restore-defect fixes | parent (earlier runs) | superseded in count, same tier |
| VD-0034 import content boundary: 48 pass | backend lane, self-reported | **not** independently rerun for that count; the boundary itself is exercised inside `world-import-content.test.mjs` in my run |
| Export/restore code reviews, relations/agentic-file reviews | free reviewers, read-only | accepted with corrections; `803d165` is the post-review hardening commit. Review output is analysis, not proof |
| Full repo suite, live owner dataset, provider call, browser render, Windows runtime cutover, acceptance run | nobody | **not run — do not claim** |

HTTP note: real `startStudio` ephemeral-localhost route tests execute inside the world-service, world-search,
world-transfer, world-restore and export-mode suites (fixture data root, synthetic bodies). That is local HTTP
proof. The `world-ui*` suites (5 files) drive a synthetic DOM, not a browser — no layout, CSS, keyboard-at-OS or
screen-reader behaviour is proven.

## Workstreams

| Work | Owner (session) | Paths | Status | Verification |
|---|---|---|---|---|
| Backend service/relations | `ses_e8b25fcc0ffenzM6egdIoYX4AS` | `src/studio/world-service.mjs`, `world-relations.mjs` | **committed `4c2cd04`** | `SOURCE_MISSING`/`SOURCE_ACTIVE`/`EVIDENCE_MISSING`/`PARTIAL_EVIDENCE` split, paging before projection, request-local projection cache, `map` rejects `offset`, `domId`/`roleAttribute` retained; covered in my run |
| Search | `ses_e8b04c6d6ffeviQ5wC58oXGW7R` | `src/studio/world-search.mjs` + `world-search.test.mjs`, `world-search-imported.test.mjs` | **committed**; imported ids (`c-i…`) and `imported-reference` source recognised | two suites in my run; registered from `world-service.mjs` → `registerWorldSearchRoutes`, `GET /world/search` |
| Selective export | `ses_e8b25fcc0ffenzM6egdIoYX4AS` | `src/studio/world-transfer.mjs` + `world-transfer.test.mjs`, `world-export-modes.test.mjs` | **committed**; contract accepted | schema `vivim.world-export/1`; modes `references`/`transcript`/`full-saved` with `includeSources` as the legacy alias; custody `user-overlay`/`referenced-only`/`imported-snapshot`; omission manifest with per-mode reasons; caps 100 selected / 3000 deps per record / 2 MiB record / 8 MiB total; 400/413; sha256 = integrity only |
| Restore (slice 2) | same backend lane | `world-service.mjs`, `world-transfer.mjs` + `world-restore.test.mjs` | **committed** | `POST /world/transfer/validate` and `/restore`; dry run default, explicit confirm, derived ids, imported custody with `sessionId: null`, receipt written last, no rollback, repeat import skipped, mid-run fault converged |
| VD-0034 import content boundary | backend lane | `world-transfer.mjs` + `world-import-content.test.mjs` | **committed** | `contentErrors()` with `IMPORT_CONTENT_LIMITS` (200 messages, 200 blocks/array, 2000 nodes, depth 12, 256 KiB strings, 512 KiB block bytes, 100-error cap, cycle detection); any hit raises `WORLD_IMPORT_CONTENT` at validate **and** restore |
| UI world view + wiring | `ses_e8b0bda99ffeE6bBzA7vvt9bI7` | `src/studio/ui/world-view.mjs`, `chat.html`, `chat.mjs` | **committed** | six shell views `capture/conversations/projects/notes/find/transfer` plus `relations`; label→kind resolution; stale-save protection; per-item read errors; unavailable never rendered as empty |
| Find view | UI lane | `world-view.mjs` + `world-ui-find.test.mjs` | **committed** | query, kind filter, paging (`nextOffset`), coverage lines, "a match count is not everything that exists"; message hits open the conversation and focus the message node by index |
| Transfer view | UI lane | `world-view.mjs` + `world-ui-transfer.test.mjs` | **committed** | export picker + downloadable preview; import strictly check → dry run → confirm → restore; 8 MB refusals at pick, check and paste; client-side cap mirrored (`IMPORT_BYTE_CAP`); partial and skipped writes never reported as success |
| Imported chips + custody filter | UI lane | `world-view.mjs` | **committed** | `custodyChip`, `custodyCounts`, `importedFromLines`; conversations filter observed/imported/all; imported rows labelled "not a recording Studio observed" |
| Relations view | UI lane | `world-view.mjs` + `world-ui-relations.test.mjs` | **committed** | consumes `/world/map`; direction kept per group, unknown kinds never folded into references, truncated/not-reported scans never claim completeness, stale map dropped on focus change, unresolved refs labelled not-scanned and not openable |
| Labelled saved blocks | UI lane | `world-view.mjs` | **committed `458efde`** | reasoning/thinking and tool-activity kinds get explicit labels instead of degrading to opaque parts; unknown payloads still not leaked |
| C-10 semantic command catalog | separate lane | `src/studio/commands.mjs` + `commands.test.mjs` | **committed `2c62a6d`, preview-only, NOT mounted** | `createCommandCatalog()`/`registerCommandRoutes()` expose `POST /commands/{id}/preview`; every preview says it did not perform the command and `executable` cannot grant an effect. `integration-hub.mjs` imports only `registerWorldRoutes`, so no command route is reachable in the running hub |
| C-11 agentic file library | separate lane, reviewed twice | `src/studio/agentic-files.mjs` + `agentic-files.test.mjs` | **committed `803d165`, read-only, NOT mounted** | bounded inventory of caller-supplied roots plus a bounded per-file text read (`GET /agentic-files`, `GET /agentic-files/{id}`); root-id/alias rejection, realpath containment (case-insensitive on win32), uniform 404, no absolute paths returned; `registerAgenticFileRoutes()` exists but is **not** imported by `integration-hub.mjs` |
| This ledger | `ses_e8b0588e2ffeIAOxa01JPc9IqJ` | this file, `docs/track/worklog.yaml`, `docs/track/queue.md` | updated | code and test reads plus one first-hand focused run; parent counts attributed |

## Queue (finite, owner-authorized)

Mirrors `docs/track/queue.md`.

| State | Work | Owner (session) | Write scope | Depends on | Validation |
|---|---|---|---|---|---|
| RUNNING | J1–J4 acceptance scenario test (worklog W12) | acceptance lane, unfinished | `test/` acceptance scenario only | committed world UI/API at `803d165` | one command, one environment, one SHA passing J1→J4 |
| READY | Decide hub wiring for C-11 agentic files and C-10 command catalog | coordinator + owner decision | `src/studio/integration-hub.mjs` + tests | explicit owner authorization; both modules are deliberately unmounted today | mounted route tests, no execution granted by mounting |
| READY | Formal testing pass | owner-scheduled, next week | verification only | RUNNING item | full suite + acceptance report at its real tier |
| BACKLOG | VD-0057 composed workspace (conversation + project + objects in one surface) | not dispatched | `src/studio/ui/*` | owner value decision | UI tests, fixture DOM |
| BACKLOG | Security program | owner-scheduled, in two weeks | review only | — | — |
| BACKLOG | `docs/track/atlas.yaml` + `crosswalk.yaml` refresh for C-10 / C-11 / VD-0021 / VD-0034 | tracker lane | those two files | this ledger | rows match `2c62a6d`, `2d74a09`, `803d165` (they currently still say "none found") |
| DONE | Backend world service/relations/search/export/restore + export modes + VD-0034 boundary | backend lane | `src/studio/world-*.mjs` + tests | — | `4c2cd04`, `2d74a09`; 88 parent-reported, 101/2 in my run |
| DONE | World UI: Find, Transfer, Relations, imported chips, custody filter | UI lane | `src/studio/ui/*` + `world-ui*` tests | backend routes | `f728480`, `458efde`, `eb38013`; fixture DOM only |
| DONE | C-10 catalog and C-11 library as unmounted modules | separate lanes | `commands.mjs`, `agentic-files.mjs` + tests | — | `2c62a6d`, `803d165`; both reviewed, neither reachable in the hub |

No item is dispatched by this ledger; dispatch happens in the coordinator session.

## Model policy

No Sol high, per owner. Free-tier lanes only in this increment; the backend lane continued on
`cliproxy-grok/grok-4.7#medium` for restore only. This docs lane made no model or quota claim.

## Broader review still owed

Reviews covered wiring, the full diff, and specific modules (export/restore, relations view, agentic files twice).
No end-to-end behavioural review of the composed world UI exists, and no reviewer has run the app.

## Deferred

- Browser/provider work and runtime cutover: deferred until local stability.
- Full repo suite and live acceptance: not attempted; formal acceptance next week, security program in two weeks.
- Hub wiring of C-10/C-11: undecided, waiting on an owner value decision.
- HF transfer implementation: still behind source reconciliation.
- Model resource map: separate uncommitted artifact, not part of this increment.

## Caveats for the next writer

- **Committed, not accepted.** The world increment is committed at `803d165`. Committed ≠ verified beyond
  fixture/local-HTTP/DOM tests. Do not upgrade a claim because a SHA exists.
- **Wiring wording:** `integration-hub.mjs` imports exactly one world entry, `registerWorldRoutes`; search, export
  and restore reach their routes through `world-service.mjs`. C-10 and C-11 have registration functions that
  nothing imports.
- **Fixture vs browser:** every UI claim here is synthetic-DOM. No CSS, layout, focus-ring, keyboard-at-OS,
  zoom or screen-reader behaviour has been observed.
- **Two count families:** my 103-test run and the parent's 88/63 runs are different suite sets. Quote the one you
  ran, with its suite list.
- **Stale track files:** `atlas.yaml` and `crosswalk.yaml` still describe C-10/C-11 as absent and VD-0021 as
  "not_started". Those rows were outside this lane's write scope.

## Unmet goals (explicit)

- One integrated J1→J4 acceptance scenario (W12), including restart, partial write, missing source, conflicting
  import, secret exclusion and negative cases.
- Import→export round trip proven through the UI rather than the API.
- Clean-profile install, process restart, and a real exported owner bundle being restored.
- Secret/cookie/profile exclusion proven by a scan of an actual bundle rather than by construction.
- Any browser, provider, owner-dataset or Windows-runtime proof.
- Hub decision and wiring for C-11 agentic files and C-10 command catalog.
- Composed workspace (VD-0057).

## Counting rules

- Attribute every count to its runner and its suite list. A run I did not perform is "reported", not "verified".
- Skips are not passes. Two platform-gated skips exist in `agentic-files.test.mjs` and are recorded as skips.
- Fixture / local-HTTP / synthetic-DOM evidence never implies browser, provider, owner-data or acceptance proof.
- Catalog-free model access is not unlimited quota; no model-capacity claim is made here.
