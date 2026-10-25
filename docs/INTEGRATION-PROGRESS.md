# Local-world integration progress

Live ledger. Update on milestone only; not a monitor. Evidence tracking, not product decisions.

Maintainer session: `ses_e8b0588e2ffeIAOxa01JPc9IqJ` (this docs lane), `docs-only` scope. Last update 2026-10-26,
after `ad01f06`: the atlas/crosswalk correction, the J1–J4 journeys, the imported-id fixes and the export mode picker
are committed. Counts below are split by who ran them. No live, provider, browser, owner-dataset or full-suite proof
exists.

## State

- HEAD: `ad01f06b520690fab30b53734ac728f166729e8b` (2026-10-26 00:19:14 +0100), `fix(world): imported conversation
  detail projects message ids from the local imported id at read time`.
- Working tree: clean except two deliberately separate untracked paths, `PROMPT.md` and `clone-tmp/`. Verified by
  `git status --porcelain` in this lane. Everything else in this ledger is a committed SHA.
- This revision's write scope: `docs/track/queue.md` and this file only. `docs/track/worklog.yaml` is stale at
  `8098b12` and was not edited here; that refresh belongs to the tracker lane.
- Committed increments:
  - `4c2cd04` backend local world service, relations, search, export/restore with imported-snapshot custody
  - `2d74a09` selectable export modes (`references` | `transcript` | `full-saved`) with explicit reasoning/tool parts
  - `2c62a6d` C-10 semantic command catalog, preview-only, non-executing
  - `f728480`, `458efde` Relations view; labelled reasoning/status/tool blocks
  - `eb38013` export mode picker with reasoning/tool toggles and server-applied preview
  - `803d165` C-11 read-only agentic-file library, hardened twice, **not mounted**
  - `ed1d6b7` atlas/crosswalk correction for C-10/C-11, export modes, Find/Relations/Transfer UI
  - `1ec3be0` imported search hit ids built from the local imported conversation id
  - `1569abc` J1–J4 fixture-level journeys plus N1–N3 negatives (`test/unit/world-journeys.test.mjs`, 7 tests)
  - `ad01f06` imported detail ids projected at read time so detail, hit and re-export ids agree
- Product module map unchanged: `src/studio` (UI/API), `src/capture`, `src/decode`, `src/store`, `src/replay`,
  `src/intel`, `src/profiles`, `src/export`, `src/mcp`, `bin`.

## Evidence ledger (attribute the run, not the claim)

| Evidence | Run by | Status |
|---|---|---|
| `node --test` over 10 suites: `world-service`, `world-search`, `world-search-imported`, `world-restore`, `world-transfer`, `world-relations`, `world-export-modes`, `world-import-content`, `world-imported-ids`, `world-journeys` | **this docs lane, 2026-10-26, HEAD `ad01f06`, clean tree** | **62 pass / 0 fail / 0 skipped, 62 tests** (18309 ms) |
| `node --test test/unit/commands.test.mjs test/unit/agentic-files.test.mjs` | this docs lane, same HEAD | **27 pass / 2 skipped / 0 fail, 29 tests** — the 2 skips are platform-gated (chmod/symlink cases), not failures |
| `node --test test/unit/world-journeys.test.mjs test/unit/world-imported-ids.test.mjs` | this docs lane, same HEAD | **8 pass / 0 fail** (7 journey tests + 1 imported-id projection test) |
| `node scripts/architecture-inventory.mjs --check` | this docs lane, same HEAD | **0 uncovered source files, 0 missing ownership paths** |
| 101 pass / 2 skipped across 13 world suites + `agentic-files` (103 tests) at `803d165` | this docs lane, earlier run | historical; superseded in count by the 62/29 runs above, same fixture tier. Not a supersession of the parent's counts |
| 88 pass across 14 world/UI suites | parent (owner rerun) | reported, not reproduced here; different suite set |
| 63 pass across UI + agentic suites | parent (owner rerun) | reported; `world-ui-*` are fixture DOM, `agentic-files` is a read-only library |
| C-10 review: 10 defects | free reviewer, parent-dispatched | **reported only**. Review output is analysis, not proof; no defect list is committed, and no fix has landed (`commands.mjs` is still `2c62a6d` only) |
| 56 / 58 focused tests after restore and restore-defect fixes | parent (earlier runs) | superseded in count, same tier |
| VD-0034 import content boundary: 48 pass | backend lane, self-reported | not independently rerun for that count; the boundary is exercised inside `world-import-content.test.mjs` in my 62-test run |
| Export/restore, relations, agentic-file reviews | free reviewers, read-only | accepted with corrections; `458efde` and `803d165` are the post-review hardenings |
| Full repo suite, live owner dataset, provider call, browser render, Windows runtime cutover, W12 acceptance run | nobody | **not run — do not claim** |

New test files since `803d165` (from `git diff --name-status 803d165..HEAD`):
`test/unit/world-journeys.test.mjs` (added, 7 tests: J1–J4 + N1–N3), `test/unit/world-imported-ids.test.mjs` (added,
1 test) and `test/unit/world-search-imported.test.mjs` (modified, imported-hit-id case). No other test file changed.

HTTP note: real `startStudio` ephemeral-localhost route tests execute inside the world-service, world-search,
world-imported-ids, world-transfer, world-restore, export-mode and journey suites (fixture data root, synthetic bodies).
That is local HTTP proof inside one process. The `world-ui*` suites (5 files) drive a synthetic DOM, not a browser — no
layout, CSS, keyboard-at-OS or screen-reader behaviour is proven.

## Workstreams

| Work | Owner (session) | Paths | Status | Verification |
|---|---|---|---|---|
| Backend service/relations | `ses_e8b25fcc0ffenzM6egdIoYX4AS` | `src/studio/world-service.mjs`, `world-relations.mjs` | **committed `4c2cd04`** | `SOURCE_MISSING`/`SOURCE_ACTIVE`/`EVIDENCE_MISSING`/`PARTIAL_EVIDENCE` split, paging before projection, request-local projection cache, `map` rejects `offset`; covered in my 62-test run |
| Search | `ses_e8b04c6d6ffeviQ5wC58oXGW7R` | `src/studio/world-search.mjs` + `world-search.test.mjs`, `world-search-imported.test.mjs` | **committed `1ec3be0`** for imported ids | imported hits use `${meta.id}:turn:${position}` from the local imported conversation id; observed hits keep their recorded id when present; origin ids move only into `importedFrom`. Registered `world-service.mjs` → `registerWorldSearchRoutes`, `GET /world/search` |
| Selective export | `ses_e8b25fcc0ffenzM6egdIoYX4AS` | `src/studio/world-transfer.mjs` + `world-transfer.test.mjs`, `world-export-modes.test.mjs` | **committed**; contract accepted | schema `vivim.world-export/1`; modes `references`/`transcript`/`full-saved` with `includeSources` as the legacy alias; custody `user-overlay`/`referenced-only`/`imported-snapshot`; omission manifest with per-mode reasons; caps 100 selected / 3000 deps per record / 2 MiB record / 8 MiB total; 400/413; sha256 = integrity only |
| Restore (slice 2) | same backend lane | `world-service.mjs`, `world-transfer.mjs` + `world-restore.test.mjs` | **committed** | `POST /world/transfer/validate` and `/restore`; dry run default, explicit confirm, derived ids, imported custody with `sessionId: null`, receipt written last, no rollback, repeat import skipped, mid-run fault converged |
| VD-0034 import content boundary | backend lane | `world-transfer.mjs` + `world-import-content.test.mjs` | **committed** | `contentErrors()` with `IMPORT_CONTENT_LIMITS` (200 messages, 200 blocks/array, 2000 nodes, depth 12, 256 KiB strings, 512 KiB block bytes, 100-error cap, cycle detection); any hit raises `WORLD_IMPORT_CONTENT` at validate **and** restore |
| Imported id alignment | parent lane, two commits | `world-search.mjs`, `world-service.mjs` + `world-search-imported.test.mjs`, `world-imported-ids.test.mjs` | **committed `1ec3be0` + `ad01f06`** | detail projection derives `${id}:turn:${index}` at read time from the addressed local imported id; new objects, source copied before edit; stored snapshot bytes, origin ids and hashes unchanged; nothing migrated on disk |
| J1–J4 journeys | acceptance-adjacent lane | `test/unit/world-journeys.test.mjs` | **committed `1569abc`, 7 tests, fixture-level only** | restart reopen, project link/unlink, search hit opens the same item with stale-selection honesty, export→restore in all three modes with idempotent repeat, custody labels and untouched `sessions`; negatives: tampered digest, no-confirm, active-session source. Header states the second instance is a second `startStudio()` in the same process — not multi-process |
| UI world view + wiring | `ses_e8b0bda99ffeE6bBzA7vvt9bI7` | `src/studio/ui/world-view.mjs`, `chat.html`, `chat.mjs` | **committed** | seven shell views `capture/conversations/projects/notes/find/transfer/relations`; label→kind resolution; stale-save protection; per-item read errors; unavailable never rendered as empty |
| Find view | UI lane | `world-view.mjs` + `world-ui-find.test.mjs` | **committed** | query, kind filter, paging, coverage lines, "a match count is not everything that exists"; message hits open the conversation and focus the message node **by index** — `openHit()` never reads `partPath`, so a hit does not deep-link to a part |
| Transfer view + export mode picker | UI lane | `world-view.mjs` + `world-ui-transfer.test.mjs`, `world-ui-export-modes.test.mjs` | **committed `eb38013`** | export picker + downloadable preview; import strictly check → dry run → confirm → restore; 8 MB refusals at pick, check and paste; client cap mirrored; partial and skipped writes never reported as success; preview reports the SERVER-applied mode and warns on a mismatch |
| Imported chips + custody filter | UI lane | `world-view.mjs` | **committed** | `custodyChip`, `custodyCounts`, `importedFromLines`; conversations filter observed/imported/all; imported rows labelled "not a recording Studio observed" |
| Relations view | UI lane | `world-view.mjs` + `world-ui-relations.test.mjs` | **committed** | consumes `/world/map`; direction per group, unknown kinds never folded into references, truncated/not-reported scans never claim completeness, stale map dropped on focus change, unresolved refs labelled not-scanned and not openable |
| Labelled saved blocks | UI lane | `world-view.mjs` | **committed `458efde`** | reasoning/thinking and tool-activity kinds get explicit labels; unknown payloads still not leaked |
| C-10 semantic command catalog | separate lane, one review | `src/studio/commands.mjs` + `commands.test.mjs` | **committed `2c62a6d`, preview-only, NOT mounted; 10 review defects open, fix lane running** | `POST /commands/{id}/preview`; every preview says it did not perform the command; `executable` cannot grant an effect. `integration-hub.mjs` imports only `registerWorldRoutes`, so no command route is reachable in the running hub. The review output is analysis; nothing from it has landed in the tree |
| C-11 agentic file library | separate lane, reviewed twice | `src/studio/agentic-files.mjs` + `agentic-files.test.mjs` | **committed `803d165`, read-only, NOT mounted** | bounded inventory of caller-supplied roots plus a bounded per-file text read (`GET /agentic-files`, `GET /agentic-files/{id}`); root-id/alias rejection, realpath containment (case-insensitive on win32), uniform 404, no absolute paths returned; `registerAgenticFileRoutes()` is **not** imported by `integration-hub.mjs` |
| Track correction | tracker lane | `docs/track/atlas.yaml`, `crosswalk.yaml` | **committed `ed1d6b7`** | VD-0021 now `adapted_in_harness` with evidence through `world-transfer.mjs` and `world-view.mjs`; C-10/C-11 rows cite the committed modules instead of "none found". Read back in this lane |
| This ledger | `ses_e8b0588e2ffeIAOxa01JPc9IqJ` | this file, `docs/track/queue.md` | updated | code reads, `git log`/`git show`, three first-hand focused test runs and one inventory check; parent and reviewer claims attributed |

## Queue (finite, owner-authorized)

Mirrors `docs/track/queue.md`.

| State | Work | Owner (session) | Write scope | Depends on | Validation |
|---|---|---|---|---|---|
| RUNNING | C-10 defect fixes after one free review (10 defects reported, none landed) | fix lane | `src/studio/commands.mjs` + tests | review findings | defects closed in diff, focused suite green, module still unmounted |
| READY (owner) | Decide hub wiring for C-11 agentic files and C-10 command catalog. Suggested narrow option: C-11 read-only, repo root as its only root; C-10 preview-only | coordinator + owner | `src/studio/integration-hub.mjs` + tests | explicit owner authorization; both modules deliberately unmounted | mounted route tests; mounting grants no execution |
| READY (owner) | VD-0057 composed workspace (conversation + project + objects in one surface) | owner design decision; may need paid `luna-medium` lane | `src/studio/ui/*` | owner value decision | UI tests, fixture DOM; design review first |
| READY (owner) | Whether `PROMPT.md` and `clone-tmp/` may be pushed | owner | untracked paths | owner instruction | explicit decision recorded before any `git add` |
| READY | Tracker-lane refresh of `docs/track/worklog.yaml` (stale at `8098b12`; W12 evidence predates `1569abc`) | tracker lane | `docs/track/worklog.yaml` | this ledger | rows match `ed1d6b7`, `1ec3be0`, `1569abc`, `ad01f06` |
| READY | Formal testing pass | owner-scheduled, next week | verification only | RUNNING C-10 fix and W12 acceptance | full suite + W12 report at its real tier |
| BACKLOG | W12 formal acceptance: multi-process restart, conflicting import, secret-exclusion scan, import→export through the UI | not dispatched | `test/` | journeys at `1569abc` (partial) | one command, one environment, one SHA passing J1→J4 |
| BACKLOG | Security program | owner-scheduled, in two weeks | review only | — | — |
| BACKLOG | Exact part deep link (`partPath` focus) | not dispatched | `world-view.mjs` + Find tests | — | fixture DOM |
| BACKLOG | VD-0046, VD-0015, VD-0067 | not dispatched | per atlas | owner value decision | — |
| DONE | Backend world service/relations/search/export/restore + export modes + VD-0034 boundary | backend lane | `src/studio/world-*.mjs` + tests | — | `4c2cd04`, `2d74a09`; 62/0 in my run |
| DONE | Imported id alignment (search hit ids, detail projection) | parent lane | `world-search.mjs`, `world-service.mjs` + tests | — | `1ec3be0`, `ad01f06`; 8/0 focused, included in the 62 |
| DONE | J1–J4 + N1–N3 journey scenarios | acceptance-adjacent lane | `test/unit/world-journeys.test.mjs` | committed world API | `1569abc`; 7 tests, fixture-level |
| DONE | World UI: Find, Transfer, Relations, imported chips, custody filter, export mode picker | UI lane | `src/studio/ui/*` + `world-ui*` tests | backend routes | `f728480`, `458efde`, `eb38013`; fixture DOM only |
| DONE | C-10 catalog and C-11 library as unmounted modules (C-11 reviewed and fixed; C-10 reviewed once, fixes open) | separate lanes | `commands.mjs`, `agentic-files.mjs` + tests | — | `2c62a6d`, `803d165`; neither reachable in the hub |
| DONE | Atlas/crosswalk correction | tracker lane | `docs/track/*` | — | `ed1d6b7` |

No item is dispatched by this ledger; dispatch happens in the coordinator session.

## Model policy

No Sol high, per owner. Free-tier lanes only in this increment; the backend lane continued on
`cliproxy-grok/grok-4.7#medium` for restore only. VD-0057 is proposed for the paid `luna-medium` lane because it is
design work, but nothing has been dispatched and this ledger makes no quota or capacity claim.

## Broader review still owed

Reviews covered wiring, the full diff, and specific modules (export/restore, relations view, agentic files twice,
command catalog once). No end-to-end behavioural review of the composed world UI exists, no reviewer has run the app,
and the C-10 findings have no committed remediation record yet.

## Deferred

- Browser/provider work and runtime cutover: deferred until local stability.
- Full repo suite and live acceptance: not attempted; formal acceptance next week, security program in two weeks.
- Hub wiring of C-10/C-11: undecided, waiting on an owner value decision.
- HF transfer implementation: still behind source reconciliation.
- Model resource map: separate uncommitted artifact, not part of this increment.

## Caveats for the next writer

- **Committed, not accepted.** The world increment is committed at `ad01f06`. Committed ≠ verified beyond
  fixture/local-HTTP/DOM tests. Do not upgrade a claim because a SHA exists.
- **Wiring wording:** `integration-hub.mjs` imports exactly one world entry, `registerWorldRoutes`; search, export and
  restore reach their routes through `world-service.mjs`. C-10 and C-11 have registration functions that nothing
  imports. Verified again at `ad01f06`.
- **Journeys are not W12.** `world-journeys.test.mjs` says in its own header that the second instance is a second
  `startStudio()` in the same process. No multi-process restart, no conflicting import, no secret scan, no UI round
  trip. W12 is still open.
- **Fixture vs browser:** every UI claim here is synthetic-DOM. No CSS, layout, focus-ring, keyboard-at-OS, zoom or
  screen-reader behaviour has been observed.
- **Count families:** my 62-test (10 suites) and 29-test (commands + agentic) runs, the earlier 103-test run at
  `803d165`, and the parent's 88/63 runs are different suite sets. Quote the one you ran, with its suite list.
- **Track files:** `atlas.yaml` and `crosswalk.yaml` are corrected at `ed1d6b7`. `worklog.yaml` is **not** — still
  `8098b12`, still describing W12 as having no journey test. That file is outside this lane's write scope.
- **Review ≠ proof:** the C-10 defect count (10) comes from a free reviewer and has no committed artefact. Treat it as
  a work item, not a verified defect inventory.

## Unmet goals (explicit)

- W12 formal acceptance: multi-process restart, conflicting import, secret exclusion, and an import→export round trip
  through the UI. The fixture journeys at `1569abc` cover the API contract only.
- Clean-profile install, process restart, and a real exported owner bundle being restored.
- Secret/cookie/profile exclusion proven by a scan of an actual bundle rather than by construction.
- Any browser, provider, owner-dataset or Windows-runtime proof.
- Hub decision and wiring for C-11 agentic files and C-10 command catalog; C-10 review defects are still unfixed.
- Composed workspace (VD-0057).
- Exact part deep link from a Find hit.

## Counting rules

- Attribute every count to its runner and its suite list. A run I did not perform is "reported", not "verified".
- Skips are not passes. Two platform-gated skips exist in `agentic-files.test.mjs` and are recorded as skips.
- A test file's own header can scope it more narrowly than its name suggests; quote the scope, not just the count.
- Fixture / local-HTTP / synthetic-DOM evidence never implies browser, provider, owner-data or acceptance proof.
- Catalog-free model access is not unlimited quota; no model-capacity claim is made here.
