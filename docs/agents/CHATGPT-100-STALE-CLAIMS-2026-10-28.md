# ChatGPT-100 stale-claims register (2026-10-28)

## Revision audited

- `git rev-parse HEAD` = `9560f567b97bc0b00f32f3ee5009a210b54c4925`, branch `main`, level with `origin/main`.
- Working tree is **dirty**. Uncommitted at the time of audit: `src/capture/actions.mjs`, `src/capture/conversation-browser-adapter.mjs`, `src/capture/conversation-capsule.mjs`, `src/capture/conversation-service.mjs`, `src/studio/conversation-tools.mjs`, five test files, `docs/agents/CHATGPT-100-INVESTIGATION-2026-10-28.json`, `docs/agents/CHATGPT-100-LIVE-2026-10-28.json`.
- Every "actual source" citation below is read from `git show HEAD:<path>` unless marked otherwise. Where a claim is already repaired in the working copy only, the claim entry says so explicitly. A claim marked `stale-by-fix` is stale because source changed; an uncommitted source hunk alone does not make a claim valid, because the committed tree still carries the old text.
- Source line references are for `9560f56`. Working-copy line numbers differ where lane 3's `CC-01`…`CC-07` hunks landed.

## Method

1. Read the five primary documents in full or in whole sections, from `git show HEAD:` where the working copy is dirty: `CHATGPT-100-INVESTIGATION-2026-10-28.json`, `CHATGPT-100-GAP-MAP.md`, `CHATGPT-100-RECONCILED-STATUS.md`, `CHATGPT-100-AUDIT-LEDGER-2026-10-28.md`, `CHATGPT-NEW-CHAT-BINDING-REPAIR-PLAN-2026-10-28.md`. `CHATGPT-100-SOURCE-MAP.md` received spot checks only, as instructed.
2. For every code location named in a claim, opened the cited range at HEAD and checked whether the range actually contains the behaviour the claim attributes to it.
3. For every count claim, re-derived the number mechanically (`node` over the file contents), not by eye.
4. For every status rollup, counted the rows of each table separately, per document and per table block, so a document that contradicts itself is visible as one finding rather than as agreement.
5. Re-verified the two previously-known stale claims independently and then extended the audit to the remaining claim surface.
6. Nothing under `src/**` or `test/**` was modified. Neither JSON ledger was modified. `CHATGPT-100-CODE-CHANGES-2026-10-28.md` was not modified.

## Counts

| Category | Count | IDs |
|---|---|---|
| `stale-by-fix` | 3 | SC-01, SC-02, SC-03 |
| `stale-by-drift` | 8 | SC-11, SC-12, SC-13, SC-14, SC-15, SC-16, SC-17, SC-20 |
| `line-drift` | 7 | SC-04, SC-05, SC-06, SC-07, SC-08, SC-09, SC-18 |
| `never-true` | 1 | SC-10 |
| `unverifiable` | 1 | SC-19 |
| **Total** | **20** | |

Severity is not a status. The three that change what a reader would conclude are SC-14, SC-17 and SC-15; see "Most consequential" at the end.

## Claims table

| ID | Doc | Location | Claim (abbreviated) | Category |
|---|---|---|---|---|
| SC-01 | repair plan | line 9 | `targets()` "always reports `ownedByStudio: false`" | `stale-by-fix` |
| SC-02 | investigation JSON | line 67 (`evidence` at HEAD) | `isStreaming` "returns false on evaluation failure" | `stale-by-fix` |
| SC-03 | investigation JSON | line 131 (`evidence` at HEAD) | target listing "hardcodes `ownedByStudio` false" | `stale-by-fix` |
| SC-04 | repair plan | line 7 | `adapter:241-249` = about:blank request, bind, navigate, readiness | `line-drift` |
| SC-05 | repair plan | line 7 | `runtime:630-642` passes `ownedByStudio: true` | `line-drift` |
| SC-06 | investigation JSON | line 160 | `adapter:266-270 fresh navigation` | `line-drift` |
| SC-07 | investigation JSON | lines 57, 244, 419, 521 | `actions.mjs:682-730 isStreaming` | `line-drift` |
| SC-08 | investigation JSON | lines 58, 244, 521 | `actions.mjs:847-894 detectAuthWall` | `line-drift` |
| SC-09 | investigation JSON | line 60 | `conversation-capsule.mjs:75 capsule ownership` | `line-drift` |
| SC-10 | investigation JSON | line 65 | regression test "Assert no page-global writes" | `never-true` |
| SC-11 | repair plan | line 26 | test file "persists the seven previously ephemeral scenarios" | `stale-by-drift` |
| SC-12 | investigation JSON | line 131 | "parent reports 9 focused tests passing" | `stale-by-drift` |
| SC-13 | audit ledger | line 122 | `conversation-rich.test.mjs` "(three tests)" | `stale-by-drift` |
| SC-14 | gap map | line 7 | "Current source-level rollup is 10 supported / 29 partial / 61 unsupported" | `stale-by-drift` |
| SC-15 | gap map | lines 126-133 | objectives 043-048, 050 are `unsupported` | `stale-by-drift` |
| SC-16 | gap map | line 256 | objective 049 is `partial` | `stale-by-drift` |
| SC-17 | audit ledger | line 27 | objective 011 status `S` | `stale-by-drift` |
| SC-18 | investigation JSON | lines 59, 360, 522, 785 | `adapter:114-163 readiness` | `line-drift` |
| SC-19 | audit ledger | line 7 | "All 132 distinct mapped code/configuration references were fetched from current GitHub" | `unverifiable` |
| SC-20 | repair plan | line 3 | "The recorded outcome remains PARTIAL" | `stale-by-drift` |

---

## SC-01 — repair plan line 9: `targets()` always reports `ownedByStudio: false`

`stale-by-fix`.

Quoted:

> **Confirmed reporting mismatch:** runtime `targets()` (`src/capture/conversation-runtime.mjs:498-518`) …

and the operative sentence attributes to `targets()` that it always reports `ownedByStudio: false`.

Actual source at `9560f56`:

- `git show HEAD:src/capture/conversation-runtime.mjs` line 503: `const ownedTargetIds = ownedFreshTargetIds(entries.values(), discovered);`
- line 515: `ownedByStudio: ownedTargetIds.has(t.id)`

So the listing no longer hardcodes `false`; ownership is computed from recorded fresh-target provenance. The fix landed in `1a0c3a3`. The `498-518` range itself is accurate; only the "always false" behaviour description is stale.

Smallest doc correction: replace the "always reports `ownedByStudio: false`" sentence with "reports `ownedByStudio` from `ownedFreshTargetIds(...)` (`498-518`, decision at `515`); it cannot see a live binding the runtime has not recorded."

## SC-02 — investigation JSON line 67: `isStreaming` returns false on evaluation failure

`stale-by-fix`.

At HEAD this string is the group-A `evidence` field:

> `… findComposer writes page-global state, isStreaming returns false on evaluation failure, and detectAuthWall is heuristic and false does not prove authentication.`

Actual source at `9560f56`, `src/capture/actions.mjs`:

- `684`: `export async function isStreaming(page, adapter = null) {`
- `731`: `// Do not convert a failed page evaluation into a false "generation finished".`
- `732-733`: `if (!r.ok || typeof r.value?.streaming !== 'boolean') return { streaming: null, observed: false, evidence: 'streaming observation unavailable' };`

The function returns `null` with `observed: false`, not `false`. Fixed by `e7deb05`.

State of the repair: the **uncommitted** working copy already demotes this string to `historicalEvidence` (JSON line 67 in the dirty tree) and replaces `evidence` with a version that says the current source returns unknown. The committed HEAD text still asserts the stale behaviour as present-tense `evidence`. A reader of `9560f56` alone is misled.

Smallest doc correction (already drafted in the working copy; needs to land): keep the historical string under `historicalEvidence` and state in `evidence` that the current source returns `{streaming:null, observed:false}` on evaluation failure.

## SC-03 — investigation JSON line 131: target listing hardcodes `ownedByStudio` false

`stale-by-fix`.

At HEAD this is the group-C `evidence` field:

> `Source confirms target listing hardcodes ownedByStudio false while fresh creation binding uses true. Do not set all targets true. Cause of live BINDING_CHANGED remains inconclusive.`

Same root cause as SC-01. Actual source: `conversation-runtime.mjs:503,515` as above.

The second sentence ("Do not set all targets true") remains correct advice and must not be dropped. The working copy already demotes the first sentence to `historicalEvidence` and adds current provenance text at JSON line 113. HEAD still carries the stale present-tense claim.

Smallest doc correction: same shape as SC-02 — historical label for the old sentence, present-tense `evidence` describing `ownedFreshTargetIds` provenance, keep the "do not set all targets true" guard verbatim.

## SC-04 — repair plan line 7: `adapter:241-249` described as the fresh-tab sequence

`line-drift`.

Quoted:

> `The adapter (`src/capture/conversation-browser-adapter.mjs:241-249,263-272`) requests an about:blank target, binds its exact returned ID through `hooks.bind`, navigates the idle page to the adapter home, and checks readiness.`

Actual source at `9560f56`, `src/capture/conversation-browser-adapter.mjs`:

- `241-251`: `async function effectPreflight(saved, beforeEffect, empty)` — an effect-time fence for an already-bound thread. It contains no tab request, no `hooks.bind`, no navigation, no readiness call.
- `256-264`: the fresh-tab request — `PUT http://127.0.0.1:${port}/json/new?about:blank` at `258`, `TAB_OPEN_FAILED` at `259`, `TAB_OPEN_UNCONFIRMED` at `261`, `binding.targetId = target.id; hooks.bind(binding);` at `264`.
- `265-272`: the **non-fresh** attach branch (`listTargets`, `BINDING_CHANGED`, `TARGET_RECORDER_BUSY`).
- `280-283`: `if (freshTab) { await livePage().send('Page.navigate', { url: siteAdapter.url }); }`

So the cited range `241-249` points at an unrelated function, and `263-272` spans the tail of the fresh branch plus the whole non-fresh branch. The described sequence is really `256-264` (request/bind) + `278-285` (open idle page, navigate, readiness).

Smallest doc correction: `src/capture/conversation-browser-adapter.mjs:256-264,278-285`.

## SC-05 — repair plan line 7: `runtime:630-642` passes `ownedByStudio: true`

`line-drift`.

Quoted:

> `… creates an unbound NEW_CHAT and passes `ownedByStudio: true` to the service.`

Actual source at `9560f56`, `src/capture/conversation-runtime.mjs`:

- `583-588`: adapter lookup, origin derivation and the `thread = null, identity = { state: 'unverified', reason: 'SITE_UNSUPPORTED' }` initialisation.
- `643`: `ownedByStudio: freshTab` inside the service `connect({...})` call.

Two defects: the decisive line is `643`, not inside `630-642`; and the value is the `freshTab` variable, not the literal `true`. Because `connect` throws `INVALID_TARGET_SELECTION` when `freshTab` and `targetId` are inconsistent (`581`), the effective value for the create path is `true`, but the document should cite the expression that exists.

Smallest doc correction: `src/capture/conversation-runtime.mjs:583-588,643` and "passes `ownedByStudio: freshTab`, which is `true` on the create path".

## SC-06 — investigation JSON line 160: `adapter:266-270 fresh navigation`

`line-drift`.

Group E `codeLocations`:

> `"src/capture/conversation-browser-adapter.mjs:266-270 fresh navigation"`

Actual source at `9560f56`:

- `266-271` is the `else` branch of `if (freshTab)`: `listTargets`, origin/thread re-check throwing `BINDING_CHANGED`, then the `TARGET_RECORDER_BUSY` guard. This is the non-fresh attach path.
- Fresh navigation is `280-283`.

The claim is load-bearing for group E's argument that "fresh owned adapter navigation is to adapter home", so a citation that lands on the opposite branch is materially wrong, not cosmetic.

Smallest doc correction: `src/capture/conversation-browser-adapter.mjs:280-283 fresh navigation`.

## SC-07 — investigation JSON: `actions.mjs:682-730 isStreaming`

`line-drift` (material).

Occurs at lines 57, 244, 419 and 521 (four places, same string).

Actual source at `9560f56`:

- `684` function start; `735` closing brace.
- `731-734` is the decisive block: the null/unknown return on failed evaluation.

The cited range ends at `730`, one line before the comment and three lines before the return that determines the function's failure semantics. A reader who opens `682-730` sees only the in-page expression and the `streaming: false` weak-match return at `729`, which is exactly the misunderstanding SC-02 records.

Smallest doc correction: `src/capture/actions.mjs:684-735 isStreaming`, four occurrences.

## SC-08 — investigation JSON: `actions.mjs:847-894 detectAuthWall`

`line-drift` (material).

Occurs at lines 58, 244 and 521.

Actual source at `9560f56`:

- `854` function start; `902` closing brace.
- `900`: `if (!r.ok) return { blocked: false, reason: \`auth check unavailable: ${r.error}\` };`

The cited range `847-894` starts inside the preceding section comment and ends inside the in-page expression; it excludes both the function signature and the fail-open return at `900`, which is the only reason the accompanying "false does not prove authentication" caveat is true.

Smallest doc correction: `src/capture/actions.mjs:854-902 detectAuthWall` (fail-open at `900`), three occurrences.

## SC-09 — investigation JSON line 60: `conversation-capsule.mjs:75 capsule ownership`

`line-drift`.

Actual source at `9560f56`, `src/capture/conversation-capsule.mjs`:

- `75`: `const finish = (() => {`
- `76-77`: the `finish_conversation` operation.
- `80-87`: the ownership/authorisation region the claim means.

Line 75 is a different capability's operation block, so the citation points at `finish_conversation` when the claim is about ownership checks.

Smallest doc correction: `src/capture/conversation-capsule.mjs:80-87 capsule ownership`.

## SC-10 — investigation JSON line 65: regression test forbids page-global writes

`never-true` (as a test the group can satisfy).

Group A `regressionTests[1]`:

> `Assert no page-global writes, focus, typing, navigation, send or sensitive text leakage; account identity disclosure requires explicit approval.`

Group A `evidence` (line 62/67) states the opposite about current source:

> `findComposer writes page-global state`

`src/capture/actions.mjs:59-103` `findComposer` assigns `globalThis.__aionDrive`, so a regression test that asserts "no page-global writes" across the group-A read path cannot pass against the code the group itself cites. As written the requirement is unsatisfiable without a source change that group A does not propose.

Smallest doc correction: scope the assertion to new inspector code — "no page-global writes introduced by the inspector; the pre-existing `globalThis.__aionDrive` write in `findComposer` is acknowledged and out of scope, or must be removed as part of this change."

## SC-11 — repair plan line 26: "seven previously ephemeral scenarios"

`stale-by-drift` (count).

Quoted:

> `test/unit/chatgpt-new-chat-binding-investigation.test.mjs` persists the seven previously ephemeral scenarios: stable root, blank-to-root polling, foreign target, foreign page, target/page path mismatch, second-read blank throw, and preexisting exact thread. It also checks draft refusal.

Actual at `9560f56`, `test/unit/chatgpt-new-chat-binding-investigation.test.mjs`:

- table-driven cases at `47-73`: **13** entries — stable root, initial `about:blank` polling, foreign target origin, foreign page origin, target/page path mismatch, preexisting exact thread, draft present, blank composer with disabled Send, unexpected root transcript, observed stop control, disabled composer, contradictory busy state, non-home route.
- three standalone `test(...)` calls at `89`, `95`, `108`.

Total **16** cases, not seven.

Smallest doc correction: "persists 16 offline cases: 13 table-driven readiness/binding cases and 3 standalone drift/throw cases", or drop the enumeration and cite the count.

## SC-12 — investigation JSON line 131: "parent reports 9 focused tests passing"

`stale-by-drift` (count).

Quoted (inside the group-C historical string):

> `… parent reports 9 focused tests passing …`

Actual: the focused file the plan and the JSON both name contains **16** cases at HEAD (13 table-driven + 3 standalone, see SC-11). No revision is given for the "9" figure, and no receipt exists in the repository.

Smallest doc correction: replace with the receipted figure and its provenance, or write "parent reported nine focused tests at an unstated revision; the file now contains sixteen cases and no passing receipt exists in this checkout."

## SC-13 — audit ledger line 122: `conversation-rich.test.mjs` has three tests

`stale-by-drift` (count).

Quoted:

> `test/unit/conversation-rich.test.mjs` (three tests) and `.github/workflows/chatgpt-source-audit.yml` were committed …

Actual at `9560f56`: `test/unit/conversation-rich.test.mjs` declares **5** `test(` blocks.

Smallest doc correction: "(five tests)".

## SC-14 — six mutually inconsistent status rollups across four documents

`stale-by-drift` (count). This is the most consequential item in the register.

Each of the following is presented as the authoritative total, and none is labelled as historical or superseded:

| Source | Location | supported | partial | unsupported |
|---|---|---|---|---|
| `CHATGPT-100-RECONCILED-STATUS.md` matrix | rows 15-114, all 100 objectives | 10 | 29 | 61 |
| `CHATGPT-100-GAP-MAP.md` per-objective table | header at 78, rows 79-184 | 10 | 22 | 68 |
| `CHATGPT-100-GAP-MAP.md` second per-objective table | header at 202, rows 203-307 | 13 | 32 | 55 |
| `CHATGPT-100-GAP-MAP.md` prose total | line 309 | 13 | 32 | 55 |
| `CHATGPT-100-GAP-MAP.md` grouped total | line 328 | 7 | 32 | 61 |
| `CHATGPT-100-SOURCE-MAP.md` table | rows to 388 | 7 | 32 | 61 |
| `CHATGPT-100-SOURCE-MAP.md` prose | line 396 | 13 | 32 | 55 |
| `CHATGPT-100-AUDIT-LEDGER-2026-10-28.md` table | rows 26-116 (`S`/`P`/`U`) | 7 | 42 | 51 |

`CHATGPT-100-GAP-MAP.md` line 7 asserts `10 supported / 29 partial / 61 unsupported` is the "Current source-level rollup". No table in that file produces that total. The RECONCILED matrix does, so line 7 is reporting a *different file's* numbers as this file's current rollup, while this file's own newest table (line 202) says `13/32/55` and this file's own grouped total (line 328) says `7/32/61`.

The arithmetic identifies the drift precisely: `22 + 7 = 29` and `68 − 7 = 61`. The seven objectives that moved from `unsupported` to `partial` — 043-048 and 050 — were applied to the RECONCILED matrix and to the second GAP-MAP table, but never to the first GAP-MAP table's counts or to the line-7 rollup that quotes RECONCILED through the first table's arithmetic.

Smallest doc correction: one line per document stating which table is normative and at which revision, and in `CHATGPT-100-GAP-MAP.md` replace line 7 with the total of the table that follows it, or delete line 7's number and point at RECONCILED. The eight-row table above is the correction that removes the ambiguity outright.

## SC-15 — GAP-MAP lines 126-133: objectives 043-048, 050 are `unsupported`

`stale-by-drift`.

Rows 126-133 classify 043 list, 044 code, 045 table, 046 math, 047 quote, 048 link, 049 citation, 050 image as `unsupported`, while naming `src/capture/conversation-rich.mjs` (`richPartReaderSource`, `boundRichParts`) as the actual source entry in the same row.

Contradicted by three other places:

- `CHATGPT-100-GAP-MAP.md` line 5: "Objectives **043-048 and 050** are now **partial** … citation anchoring **049** remains unsupported."
- `CHATGPT-100-GAP-MAP.md` rows 250-257 (second table): 043-050 all `partial`.
- `CHATGPT-100-RECONCILED-STATUS.md` rows 57-64: 043-048 `partial`, 049 `unsupported`, 050 `partial`.

Source agrees with the later classification: `src/capture/conversation-thread.mjs:1` imports `{ richPartReaderSource, boundRichParts } from './conversation-rich.mjs'`, uses `richPartReaderSource()` at `103` and `boundRichParts(...)` at `173`, and projects `parts`/`partsCoverage` at `177-179`. The reader is wired, so "unsupported" is wrong for 043-048 and 050.

Row 132/049 is separately wrong in the other direction — see SC-16.

Smallest doc correction: in rows 126-131 and 133 change the status to `partial` and reuse row 250-257's gap text; that also brings the table to `10/29/61` and retires SC-14's largest discrepancy.

## SC-16 — GAP-MAP line 256: objective 049 is `partial`

`stale-by-drift`.

Row 256 classifies 049 citation anchoring as `partial` with gap text "Citation candidates only; no passage/source binding".

Contradicted by `CHATGPT-100-GAP-MAP.md` line 5 ("citation anchoring **049** remains unsupported") and by `CHATGPT-100-RECONCILED-STATUS.md` row 63 (`049 … unsupported`). Source supports the `unsupported` reading for the objective as specified: the reader surfaces citation candidates but no passage-to-source anchor.

Smallest doc correction: change row 256 to `unsupported` with the row-132 gap text "Citation candidate extracted; passage-source anchor missing".

## SC-17 — audit ledger line 27: objective 011 status `S`

`stale-by-drift`. This is the second most consequential item.

Four documents record four different 011 statuses:

| Source | Location | 011 status |
|---|---|---|
| `CHATGPT-100-AUDIT-LEDGER-2026-10-28.md` | line 27 | `S` (supported) |
| `CHATGPT-100-RECONCILED-STATUS.md` | line 25 | `supported` |
| `CHATGPT-100-INVESTIGATION-2026-10-28.json` | objectives entry `id:"011"` | `observedStatus: "PARTIAL"`, "New target created; readiness and ownership conflict unverified" |
| `CHATGPT-100-GAP-MAP.md` | line 94, line 218 | `supported` |
| `CHATGPT-100-LIVE-2026-10-28.json` | objectives `id:"011"` | `status: "PASS"`, single `attempts[]` entry `status: "PARTIAL"` |

The live attempt text records the failure explicitly: `create_conversation returned a new ChatGPT target 9A3D0AAE522702601545ED3CCDAE2F5E and local conversation 1c9ab74a-605d-495b-8e1b-048f30765996 … it also reported state blocked, readiness false, reason BINDING_CHANGED.`

So the objective has a failed readiness and a recorded `BINDING_CHANGED`, and is simultaneously `S`, `supported`, `PARTIAL` and `PASS` depending on which file the reader opens. `S`/`supported` also conflict with `CHATGPT-100-AUDIT-LEDGER-2026-10-28.md` line 3 ("Status: **incomplete, source-level only** … not a passing 100-case certification").

Smallest doc correction: make the ledger row `P` with the gap text "create path exists; live attempt returned readiness false / `BINDING_CHANGED`", and have LANE 1 decide the live-ledger status question (PASS-with-failed-readiness is a live-owner call, not a doc fix).

## SC-18 — investigation JSON: `adapter:114-163 readiness`

`line-drift` (minor).

Occurs at lines 59, 360, 522 and 785.

Actual at `9560f56`: `114`: `async function readiness(end) {`; body to `165`; `166`: `}`. The cited `114-163` truncates the final `do … while` and the terminal return:

- `164`: `} while (Date.now() <= end);`
- `165`: `return blocked('READINESS_TIMEOUT');`

The range excludes the `READINESS_TIMEOUT` outcome that several SC-15 rows and the test matrix assert.

Smallest doc correction: `src/capture/conversation-browser-adapter.mjs:114-166 readiness`, four occurrences.

## SC-19 — audit ledger line 7: 132 fetched references and 12 transitive modules

`unverifiable`.

Quoted:

> `All 132 distinct mapped code/configuration references were fetched from current GitHub and their imports, exports and relevant declarations inspected. Another 12 directly discovered transitive modules were fetched and checked for export/import relationships.`

No commit SHA, no fetch log, no file list and no checksum accompanies the figure. The claim also refers to "current GitHub" while the document later says a local fast-forward could not be performed, so the fetched tree cannot be tied to `9560f56` or to any other revision from the repository.

Smallest doc correction: state the exact commit the references were fetched at, or soften to "sampled 132 mapped references at an unrecorded upstream revision; no per-file receipt retained."

## SC-20 — repair plan line 3: "The recorded outcome remains PARTIAL"

`stale-by-drift` (low severity).

Quoted:

> `Scope: objective 011 only. … The recorded outcome remains PARTIAL until the coordinated operator verifies a blank composer, readiness and ownership without a send. No live status is changed by this plan.`

`CHATGPT-100-LIVE-2026-10-28.json` now records 011 `"status":"PASS"` (with a `PARTIAL` attempt and `readiness false` / `BINDING_CHANGED`). The plan's description of the recorded outcome no longer matches the live ledger, even though the plan's substance — do not change live status from a source-only document — still holds.

Smallest doc correction: "the recorded objective status was PARTIAL when this plan was written; the live ledger has since recorded PASS on a partial attempt with unresolved readiness, which this plan does not endorse."

---

## Still VALID — do not re-open

These were checked against HEAD and hold. They do not need another pass.

**Repair plan**

- `conversation-tools.mjs:45-47,82-94` maps create to `connect` with `freshTab: true`. Verified: line 45 `create_conversation` `runtime: 'connect'`, `kind: 'create'`; `82-94` maps the runtime to `/api/v1/conversations/create`.
- Service `379-395,400-412` validates and persists the binding and maps a returned non-ready result to blocked. Verified.
- Service `389-392` converts an adapter throw into `needs-reconciliation` / `attachment-failed` rather than blocked readiness. Verified — this is the correct distinction between a thrown and a returned `BINDING_CHANGED`.
- The `threadMatches` / `pageThreadMatches` short-circuit reasoning for an unbound thread (`74,79-81`, branches `119-131`) is accurate.
- Line 3's "not a production repair or a live pass" framing and line 22's live-probe protocol are correct policy and should be kept as-is.

**GAP-MAP**

- Line 332: `create_conversation` → `connect({site:'chatgpt',freshTab:true})`, `POST /api/v1/conversations/create`. Verified; the route exists at `src/studio/conversation-api.mjs:71`.
- Line 347: `scrubBlocks` in `src/capture/dom.mjs` (5 occurrences).
- Line 348: `idle = sendBtn` — `src/capture/conversation-thread.mjs` `turnObservationExpression`, `idle` derived from the Send control only.
- Line 5's 043-048/050 `partial` + 049 `unsupported` split (correct; the tables are what is wrong, per SC-15/SC-16).
- Line 73: stop/send selectors flowing into `transcriptExpression`. Verified against `src/profiles/sites/chatgpt.mjs` `send.buttonSelectors` (`21-26`) and `assistant.streamingSelectors`.
- Lines 120, 132: 32 DOM parts per message, 8 KB budget, 32-node slice. Verified: `RICH_PARTS_MAX = 32`, `RICH_PARTS_MAX_CHARS = 8192`, `pageBudget = 8192`, `nodes.slice(0,32)`.
- Lines 76, 122, 132, 350: CI failing with no retrievable job logs, so test assertions cannot be attributed. The claim is self-limiting and correctly refuses to promote a pass.
- Line 340-342 "Fixed shared gaps" entries other than the adapter-range defects above.

**RECONCILED-STATUS**

- Line 3 and the status vocabulary at line 10 are correct and are the right norm for the other documents.
- Rows 57-64 (043-048, 050 `partial`; 049 `unsupported`) are correct.
- The whole matrix totals `10 / 29 / 61` over exactly 100 rows, no missing or duplicate IDs.

**Investigation JSON**

- Group B `codeLocations` are accurate at HEAD: `conversation-tools.mjs:33-35` (`chat_index`), `integration-hub.mjs:498` (the `content`/`structuredContent`/`isError:false` projection), `tool-client.mjs:60-61` (`STUDIO_INVALID_RESPONSE`, `structuredContent` return), `bin/commands/tools.mjs:36-44` (`runToolsCall`, `--include-content`, `metadataOnly`), `tool-result.mjs:1-15` (`PRIVATE_FIELDS`, `metadataOnly`).
- Group E `drive.mjs:48-53` (URL overlay) and `63-96` (prompt + `driveSite`) are accurate.
- Group F `conversation-service.mjs:109-111` (snapshot defaults incl. `limitations`).
- All 19 referenced module paths exist.
- Symbols claimed to exist do exist: `boundTranscript`, `richPartReaderSource`, `boundRichParts`, `scrubBlocks`, `textKey`, `humanScroll`, `pressEnter`, `driveSite`, `waitForCompletion`, `waitForComposer`.
- `"627-line"` browser adapter (lines 1338 and 1361): correct at HEAD — `git show HEAD:src/capture/conversation-browser-adapter.mjs` is 627 lines. The fixture receipts are historical (the working copy is longer), but the number is not stale.
- `sourceRepairRounds` commits `6f71804`, `6ec7181`, `778dd6f` all exist and are ancestors of `9560f56`.
- `researchSnapshot` 001-029 scope, `policy` owner split, and `revisionNotes` round-2 wording.
- `src/profiles/sites/chatgpt.mjs` has no `modelSelectors`, consistent with the #035 "model selection absent" classification.

**Audit ledger**

- Line 3's "incomplete, source-level only … not a passing 100-case certification" is honest and correct.
- Line 120's 32-parts and stripped query/fragment description.
- Line 122/132 CI attribution refusal.
- The 100-row table is complete: no missing or duplicate IDs.

**Source map (spot check)**

- Line 396's `13 / 32 / 55` matches the table it introduces; the number is wrong only in the sense that SC-14 says no single rollup is normative.
- Line 397: `read_conversation` projecting bounded typed parts via `conversation-rich.mjs` and `conversation-thread.mjs:transcriptExpression` / `boundTranscript`.
- Line 399: `create_conversation` and `conversation_capsule` exist in the registry and create does not send.
- Line 400: `src/profiles/model-ops.mjs` is Capture's data model, not ChatGPT model selection; `src/studio/agentic-files.mjs` is a local instruction-file inventory, not a file picker.

**Already fixed and not to be re-litigated**

- `isStreaming` false-on-failure → fixed `e7deb05` (see SC-02 for the remaining documentation debt).
- `targets()` hardcoded `ownedByStudio:false` → fixed `1a0c3a3` (see SC-01/SC-03).

---

## Most consequential

1. **SC-14** — six incompatible rollups across four documents, each presented as authoritative, with no label distinguishing current from historical. Any summary written from one of these documents contradicts a summary written from another, and `GAP-MAP` line 7 quotes a total its own file cannot produce.
2. **SC-17** — objective 011 is simultaneously `S`, `supported`, `PARTIAL` and `PASS`, while the live attempt records `readiness false` and `reason BINDING_CHANGED`. The one objective the whole repair plan exists for has four recorded answers.
3. **SC-15** — `GAP-MAP` rows 126-133 call 043-048 and 050 `unsupported` while naming the wired implementation in the same cell, contradicting line 5 and the RECONCILED matrix. This single edit is also what repairs the largest part of SC-14.

## Lane-1 edits required

Lane 1 owns the two JSON ledgers. These claims need edits there and were not changed by this audit:

- `CHATGPT-100-INVESTIGATION-2026-10-28.json`: SC-02 (line 67 `evidence` at HEAD), SC-03 (line 131 `evidence` at HEAD), SC-12 (line 131 "9 focused tests"), SC-06 (line 160), SC-07 (lines 57, 244, 419, 521), SC-08 (lines 58, 244, 521), SC-09 (line 60), SC-10 (line 65), SC-18 (lines 59, 360, 522, 785). SC-02 and SC-03 are already partially repaired in lane 1's uncommitted working copy; they still need to be committed, and SC-06 through SC-10 and SC-18 are untouched there.
- `CHATGPT-100-LIVE-2026-10-28.json`: SC-17's live half only — 011 is recorded `status: "PASS"` on a `PARTIAL` attempt with `readiness false` / `BINDING_CHANGED`. Whether PASS is correct is a live-probe-owner decision; this register only records that it conflicts with the other four documents.

Documents outside lane 1's ownership that also need edits (`GAP-MAP`, `AUDIT-LEDGER`, `SOURCE-MAP`, repair plan): SC-01, SC-04, SC-05, SC-11, SC-13, SC-14, SC-15, SC-16, SC-17 (ledger row), SC-19, SC-20. Not edited here.
