# Formal test prep — world/UI test surface

Purpose: what the existing world and Studio UI test files actually establish before next week's
formal testing. This file is a **read-only audit of test source at HEAD `20574af` (2026-10-26)**.
No test was executed while writing it, so nothing below is a fresh pass/fail claim. Where a prior
count is cited it comes from `docs/INTEGRATION-PROGRESS.md` / `docs/LIVE-TEST.md`, not from this work.

Proof tiers used below:

- **T0 — module/fixture**: in-process calls against `mkdtemp` data dirs, hand-built records, no server.
- **T1 — synthetic DOM**: a hand-rolled `Node`/`Txt` fake (`createElement`, `setAttribute`, `click`,
  a `focus()` that sets a flag) or `node:vm`-extracted inline `<script>`. No browser, no CSS, no layout.
- **T2 — HTTP contract**: real `startStudio` routes on a loopback port with a **stubbed**
  `conversationRuntime`; real files, fake capture runtime.
- **T3 — live**: real Chrome/CDP, real provider, real owner data, real OS process restart. **No test
  file in this list reaches T3.**

## Per-file coverage

### `test/unit/world-service.test.mjs` — T0 + T2
- **Exercises:** rich saved conversations reopen without flattening unknown parts; project/note
  persistence with CAS; link/unlink that never edits source; source-scoped ID stability; active
  sessions excluded; world routes over the real Studio hub incl. CAS wire errors.
- **Does not prove:** anything about real capture output; the runtime session predicate is a
  stub (`isSessionActive: () => false`).
- **Skipped/gated:** none.

### `test/unit/world-transfer.test.mjs` — T0 + one T2 case
- **Exercises:** selected dependency closure exports exact IDs only; reference-only default;
  deterministic hashes; active/missing/unreadable sources become omissions not empty snapshots;
  cycles terminate; `WORLD_EXPORT_LIMITS` caps fail explicitly; JSON/400/413 endpoints.
- **Does not prove:** real 8 MiB envelope behaviour under memory pressure; no owner-sized bundle.
- **Skipped/gated:** none.

### `test/unit/world-restore.test.mjs` — T0 + T2
- **Exercises:** round trip assigns new IDs and imported custody; repeat import of the **identical**
  bundle skips (`skipped.length === applied.length`, tree hash unchanged); conflicting content collides;
  dangling references stay unresolved; tampered digest fails; mid-run fault converges on retry;
  validate/restore endpoints require confirmation and preserve source bytes.
- **Does not prove:** crash/disk-full recovery outside the injected fault; a second import of a
  **changed** bundle under the same origin ID (see gap 3).
- **Skipped/gated:** none.

### `test/unit/world-search.test.mjs` — T0 + T2
- **Exercises:** index is transient (edits visible next query); rich unknown blocks searchable by
  value/field; no cross-record dedupe; kind filter applied before top-N; paging past the list default
  with honest truncation; per-item failures disclosed instead of a clean empty result; additive
  availability states are unavailable-not-deleted; `400` on bad `q`/`kind`/pagination; `GET /world/search`
  registered on the hub.
- **Does not prove:** behaviour beyond `WORLD_SEARCH_LIMITS` (`src/studio/world-search.mjs:13-15`:
  500 conversations, 20 000 messages, 500 per other kind).
- **Skipped/gated:** none.

### `test/unit/world-search-imported.test.mjs` — T0 + T2
- **Exercises:** imported snapshots searchable with `imported` custody; custody filter
  (observed/imported/both, default all); identical text in one observation + two imports stays three
  rows; imported hits never claim observation; classification follows `custody`/`importedFrom`, not ID
  shape; hits resolvable after a real restore; invalid custody rejected pre-scan.
- **Does not prove:** search over owner data; relevance quality.
- **Skipped/gated:** none.

### `test/unit/world-export-modes.test.mjs` — T0
- **Exercises:** invalid mode/part rejected before any world read; `references`, `transcript`,
  `full-saved` round-trip through validate → restore.
- **Does not prove:** the UI's mode wiring (that is `world-ui-export-modes.test.mjs`); fidelity on
  real captured blocks beyond fixtures.
- **Skipped/gated:** none.

### `test/unit/world-import-content.test.mjs` — T0
- **Exercises:** referenced-only conversations are not stored and do not break listing;
  capture-sized text and odd roles survive validation; nested/unbounded input fails closed; unknown
  imported blocks stay inert; malformed messages rejected before any restore write.
- **Does not prove:** the true maximum of real provider payloads; text is synthetic.
- **Skipped/gated:** none.

### `test/unit/world-imported-ids.test.mjs` — T0
- **Exercises:** imported detail projects local message IDs that match search hits; re-export still
  round-trips.
- **Does not prove:** ID stability across schema versions.
- **Skipped/gated:** none.

### `test/unit/world-journeys.test.mjs` — T2
- **Exercises:** J1 reopen after a second Studio instance; J2 project + links + unlink; J3 exact
  message hit, coverage disclosure, stale selection reported stale not deleted; J4 export in each mode
  → restore into a clean second dir (dry run then confirm), idempotent repeat, imported labels,
  re-export custody, `paths.sessions` untouched, account unknown; N1 tampered digest; N2 restore without
  confirm refused; N3 active source unavailable and excluded, returns when inactive.
- **Does not prove:** its own header states the limit (`world-journeys.test.mjs:1-9`): fixture level
  only, "NOT live proof, NOT a browser test and NOT a second-OS-process scenario" — a "second Studio
  instance" is a second `startStudio()` call **in the same test process** on the same data dir.
- **Skipped/gated:** none. No commit/shipping claim may cite this file.

### `test/unit/world-relations.test.mjs` — T0
- **Exercises:** qualified identity keeps provider/origin/parser basis without account or cross-source
  merging; selections keep qualified address across reopen without copying source; notes attach to
  selections; ambiguous/unobserved addresses rejected; seven review regressions including
  page-before-project, one transcript reuse per request, declared scan bounds, DOM provenance not
  invalidating old fingerprints, corrupt-metadata coverage, availability via the same readers.
- **Does not prove:** DOM provenance captured from a real page — fingerprints are supplied as fixtures.
- **Skipped/gated:** none.

### `test/unit/world-ui.test.mjs` — T1
- **Exercises:** module imports without booting a document (no second renderer); saved blocks reuse
  markdown structure and unknown parts do not leak payload; coverage/identity/source truthful;
  writes succeed only on versioned `200` and a conflict keeps the draft; shell read/edit/stale-save;
  reconciliation distinguishes drafts, page counts, members, active and unreadable reads. Also asserts
  source text only: `assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/)`.
- **Does not prove:** rendering. `focus()` is a no-op (`world-ui.test.mjs:27`); nothing checks CSS,
  layout, scrolling, visibility, or assistive-technology output.
- **Skipped/gated:** none.

### `test/unit/world-ui-find.test.mjs` — T1
- **Exercises:** find is a peer view and never injects result text as HTML; empty text not searched;
  stale response ignored; incomplete coverage stays labelled; bad query surfaced; load-more follows
  `nextOffset`; hit opens its own record; `partPath` "focuses" the exact part with `tabindex="-1"`;
  unresolved `partPath` keeps the message open and admits it; imported hit opens via local ID.
- **Does not prove:** that focus actually moves. `focus() { this.focused = true; }`
  (`world-ui-find.test.mjs:25`) records a flag; no real focus, scroll-into-view or announcement.
- **Skipped/gated:** none.

### `test/unit/world-ui-relations.test.mjs` — T1
- **Exercises:** reasoning/status/tool parts labelled as their own blocks with unknown payloads hidden;
  provenance chips cover every provenance the map emits and unresolved nodes are never called yours;
  truncated/complete/not-reported told apart; group edges keep direction; neighbours from one record
  ignore a stale map and are not called deleted; changing focus drops the pending response; unresolved
  references labelled not-scanned and never openable; starting picker accepts saved records or a typed
  exact ID; truncated empty scan says more may exist.
- **Does not prove:** real chip layout or keyboard traversal in a browser.
- **Skipped/gated:** none.

### `test/unit/world-ui-transfer.test.mjs` — T1
- **Exercises:** transfer is a peer view; a partial restore is not success; export preview downloads and
  revokes; import waits for an explicit check; imported rows stay labelled; a finished restore must be
  checked again; a skipped write is not success; a file over `IMPORT_BYTE_CAP` clears the check.
- **Does not prove:** the byte cap is tested with a **fake file object's `size`**
  (`src/studio/ui/world-view.mjs:373`, `1778`), not a real 8 MiB read; no download actually occurs.
- **Skipped/gated:** none.

### `test/unit/world-ui-export-modes.test.mjs` — T1
- **Exercises:** mode choice replaces `includeSources` and is always named in the request; References
  disables part boxes with a reason while Transcript/Full saved enable them; preview shows
  server-applied mode/parts, per-reason omission counts and completeness meaning; changing mode or a
  box clears the preview, revokes the blob URL and removes the download; a `400` names the problem and
  keeps no bundle.
- **Does not prove:** visual disabled-state affordance or real blob/URL lifecycle in a browser.
- **Skipped/gated:** none.

### `test/unit/studio-integration-ui.test.mjs` — T1 (`node:vm`)
- **Exercises:** the whole inline `<script>` from `src/studio/ui/index.html` parses
  (`new Script(script)`); one recording selection drives breadcrumb, knowledge and scoped Search;
  clearing a selection cannot reuse the previous one; the same selection does not invalidate
  in-flight requests; as-of time syncs across history/knowledge and invalidates prior observations;
  recording context changes before the session-request epoch is captured; `401` gives local-mode-aware
  recovery cleared after a successful read.
- **Does not prove:** that the page loads or runs in a browser; extracted slices run in a VM with a
  fixture object graph, not the shipped bundle.
- **Skipped/gated:** none.

### `test/unit/studio-search-ui.test.mjs` — T1 (`node:vm`)
- **Exercises:** search slice parses with declared scope controls; recent-search snippets escaped and
  open the correct recording; selected scope requires a selected saved recording and uses the verified
  selected session identifier; API rejection not presented as successful empty search; latest search
  wins on out-of-order resolution.
- **Does not prove:** keyboard interaction, focus rings, or rendering in the real page.
- **Skipped/gated:** none.

### `test/unit/commands.test.mjs` — T0 (fake `add`)
- **Exercises:** module exposes a catalog and routes, not an execution function (`BANNED_API` at
  line 9 is asserted absent); bounded catalog entries with external effects deferred; deep-frozen
  snapshots; symbol resolution; real candidate ranking; preview responses carry only
  `PREVIEW_FIELDS` (line 11) with a future-tense confirmation flag; an external effect never proceeds
  incl. its force alias; world ID grammar; multiline text allows newline/tab only; schema limits;
  plain own-property objects; list/describe/preview plus `400`s.
- **Does not prove:** that these routes are reachable in the product. `src/studio/integration-hub.mjs`
  imports only `registerWorldRoutes` (line 23, call at line 112) — commands are **not mounted**, and
  the tests register routes against a fake `add`.
- **Skipped/gated:** none.

### `test/unit/agentic-files.test.mjs` — T0 + platform-gated
- **Exercises:** inventory-only surface (no execution/network/shell); inert records with no capability
  fields; discovery contract; path-stable hashed IDs; bounded `get()` with live rehash and no absolute
  provenance; bounded ID registry; identical not-found shape; `realInside` structural containment;
  symlink/junction refusal; policy exclusion casing; duplicate/alias/nested roots rejected; unreadable
  directories and failed root listings disclosed; strict frontmatter parser; caps/truncation and byte
  caps; precedence as disclosed ranking; coverage; bidi/zero-width stripping; list validation; read-only
  `GET` routes; honest empty inventory.
- **Does not prove:** real filesystem topology of the owner's machine; nothing here reads a real
  `~/.claude`-style tree.
- **Skipped/gated:** win32-specific `realInside` assertions are inside `process.platform === 'win32'`
  (line 258); junction-based cases call `t.skip` when link creation is denied (lines 282, 297, 339);
  `chmod`-denial cases `t.skip` when the host cannot deny directory reads (lines 352, 366). On a host
  where those skips fire, containment-by-junction and unreadable-directory disclosure are unproven.

## Gaps formal testing must close

1. **Real browser rendering of `/chat` world views.** Every UI suite drives a fake `Node` class with no
   CSS engine, no `getBoundingClientRect`, no scrolling and no real focus. `world-ui-find.test.mjs:25`
   sets a boolean; `world-ui.test.mjs:27` does nothing. Focus order, visibility of truncated rows,
   scroll-into-view of a `partPath` hit, and disabled-control affordances are untested.
2. **Real process restart.** `world-journeys.test.mjs:133` is explicit: a second `startStudio()` in the
   same process. Persistence across a genuine OS restart (locks, partial writes, stale PID/session
   state, temp-file cleanup) is not covered anywhere.
3. **Conflicting import and repeat import with changed content.** `world-restore.test.mjs` covers repeat
   import of the *identical* bundle (skip, unchanged tree hash) and conflict via `importRecord`
   collision. Re-importing a **modified** bundle under the same origin ID, and partially overlapping
   bundles from two sources, have no case.
4. **Bundle secret scan.** There is no scanner. `src/studio/world-transfer.mjs:210` excludes by
   construction — `raw-capture-files`, `browser-profiles`, `credentials-stores`, `provider-network`,
   `unrelated-world-records`, `external-asset-bytes` — and line 219 states plainly:
   "Selected content is not automatically redacted." A bundle that *contains* a pasted token inside a
   saved message will ship it. Needs a real scan plus a documented refusal/quarantine path.
5. **Owner-data conversations.** All T0/T2 cases use `mkdtempSync` dirs and hand-seeded sessions. No
   test reads a real recorded conversation, so block-shape drift from actual providers is unmeasured.
6. **Full suite run.** Not executed in this work. Recorded semantics: `package.json:16`
   `"test": "node --test \"test/unit/**/*.test.mjs\""`; run it with `bun run test` (Bun executing Node's
   runner — the package's semantics) or `bun exec node --test "test/unit/**/*.test.mjs"`. Do **not** use
   `bun test`, which would use Bun's own runner instead. `docs/INTEGRATION-PROGRESS.md:47` records the
   full repo suite as not run; `docs/LIVE-TEST.md:436` records an earlier full run (1052 tests, 1051
   pass, 1 todo) — attribute that to HEAD at the time, not to today.
7. **Large-data performance.** Current bounds are untested at their limits: `PAGE_LIMIT = 50` and
   `IMPORT_BYTE_CAP = 8 * 1024 * 1024` (`src/studio/ui/world-view.mjs:8`, `373`);
   `WORLD_EXPORT_LIMITS` (`maxSelected: 100`, `maxRecords: 256`, `maxDependenciesPerRecord: 3000`,
   `maxRecordBytes: 2 MiB`, `maxTotalBytes: 8 MiB`) and `IMPORT_CONTENT_LIMITS`
   (`src/studio/world-transfer.mjs:7-9`); `WORLD_SEARCH_LIMITS` (500/20 000/500). No timing, memory or
   UI-latency measurement exists.
8. **Windows junction/chmod cases.** The `t.skip` branches in `agentic-files.test.mjs` (282, 297, 339,
   352, 366) mean the win32 escape-prevention story is conditional. Formal testing should run once as a
   normal user and once elevated, and record which skips fired.
9. **Active-session capture safety.** `world-service.mjs:51` treats `recording`/`stopping` as active, and
   `integration-hub.mjs:112` wires the real `conversationRuntime?.isSessionActive`. Every test replaces
   that with a stub; N3 fakes activity by setting `session.meta.status = 'recording'`. A genuinely live
   capture session being excluded from export/restore is untested, as is the race where a session starts
   between listing and export.
10. **Account identity stays unknown.** `identity.account === { state: 'unknown', ref: null }` is asserted
    as a constant in `world-journeys`, `world-relations`, `world-service`. There is no test proving the
    system cannot *acquire* an account identity from a real origin; only that it does not invent one from
    fixtures.

## Explicitly deferred

- **Live providers and Chrome/CDP.** No provider call, no real browser, no CDP capture. `test/e2e/**`
  (`bun run test:e2e`) is out of scope for this prep and was not run.
- **Security program.** Planned as its own two-week effort; gap 4 (bundle secret scan) and the unaudited
  import/restore surface belong there, not to a test-file patch.
- **Windows runtime cutover.** No claim that the local Windows product path, scheduled tasks, or the
  AION/Chrome Relay separation has been validated. This document certifies nothing about deployment.
