# Capture Studio — Governing vision

**Status:** this is the only governing vision for Capture Studio. Queues, sprint plans, live-test notes, and the capability one-pager are subordinate. If they disagree with this page, this page wins. **Updated:** 2026-10-23.

## Vision

Capture Studio is an **agent harness whose model sessions are real AI-webapp conversations**, not provider API calls. ChatGPT is the first provider. The AION team is the **first workload**, not the product boundary.

The harness drives the full visible webapp surface through the existing loopback Chrome DevTools connection: discover chats, projects, and workspaces; create, open, resume, switch, rename, archive, and delete conversations; select model and mode; use attachments, tools, and artifacts; read history and streams; stop, edit, regenerate, and branch; then recover without replaying an uncertain action. A browser tab is an attachment to a conversation. It is not the conversation, and the list of open tabs is not the account chat list.

Under that harness, the original capture engine remains: immutable raw evidence, honest gaps, derived shapes, search, replay, and export. Capture is **deferred, not removed**. An open chat stays idle. An explicit send or full record arms the existing network and DOM capture for that operation, then stops it. A read or chat-list check is one DevTools query. Explicit `record` / `start` keeps full capture.

New-chat creation and later interaction use that same DevTools connection: open a Studio-owned tab, navigate to a fresh chat, submit once, and pin only a newly created `/c/<id>` that was not already open. Private ChatGPT backend calls, Playwright, and Puppeteer are not the path. An uncertain send is never retried.

## Next phase — one UI for every AI webapp

**Owner direction, 2026-10-23.** The next phase is one Studio interface for all of the owner's AI webapp chats, using the `vivim-final` chat shell as the interaction reference. It is not a second product and it does not replace this vision.

The current Studio UI is split across `src/studio/ui/index.html`, `chat.html`, `drive.html`, `live.html`, and `platform.html`. The next phase replaces that split, for conversation work, with one shell:

- one provider rail and one conversation list across every connected webapp, not one page per site;
- one transcript and one composer, with the active provider and exact thread visible;
- the same Read, new-chat, send, and follow-up actions already defined for ChatGPT, extended per provider only where that provider's page supports them;
- capture, search, and export remain available from that shell. They do not become separate applications.

`vivim-final` is owned source and may be adapted where it helps. The reference is the chat-column layout, not the live home page and not the slot runtime. `frontend/src/app/page.tsx` does not compose `ChatSidebar`, `ConversationList`, and `ComposerShell` into one shell. `ChatSurface` registers those pieces through the canvas slot SDK, and the thread slot is empty. Copy the shapes. Do not mount `page.tsx`, `ChatSurface`, `ChatSlotSurface`, or any `@/sdk/web` hook.

The Studio shell is one left rail about 240px wide, one transcript, and the composer under the transcript. It is not vivim's right-hand composer column.

- The provider rail is single-select. Studio supplies the providers and the selected id. Do not import vivim's checkbox list, workspace switcher, collections panel, or no-op toggles.
- The conversation list is search, new chat, and rows with a provider chip, title, and active state. Selection, create, and delete are Studio callbacks. Do not import `useConversation` or `/api/conversations`.
- The transcript is a scroll region with user and assistant messages. The composer is a textarea, send button, and optional model text. Model lists and send are Studio callbacks. Do not call `/api/providers`, `dispatchBehavior`, the ML prerouter, or `ws://localhost:9420/ws`.

A provider that is not signed in, or whose page cannot be identified, shows that state in the same shell. It is not hidden and it is not replaced by another chat.

The ChatGPT new-chat transition and idle-capture deferral are now in source. A fresh Studio tab stays unbound until CDP observes a new `/c/<id>`, and connect does not arm full capture until an explicit send. Focused create tests passed 90/90, and the full unit suite passed 1,194 with 0 failures and 1 existing TODO. This is not a live new-chat acceptance. This phase still does not drop exact-thread checks, uncertain-send protection, or the ability to capture a real turn.

**Studio seam, 2026-10-23.** Grow `/chat` (`src/studio/ui/chat.html` and `chat.mjs`) in place. Do not add a conversation page or a second browser. `/`, `/drive`, `/live/view`, and `/platform` stay tools reached from the shell.

- The provider rail replaces the single site select. Its list is the existing conversation-target sites, with each adapter's label. The drive-site catalog is not a second provider list. A signed-out or unidentified provider stays visible.
- The conversation list keeps the Studio lifecycle rows and gains the account chat index in the same list. Chat-index is ChatGPT-only and has no UI caller yet. Generalize that reader per provider. The open-tab list remains only the attach path.
- One transcript pane combines the live turn and the explicit zero-send Read. The exact thread reference stays visible. Only ChatGPT `/c/<uuid>` is a durable thread today.
- The composer keeps one explicit send. Create stays one fresh-tab connection through the existing DevTools path, not a second sender. Finish and transcript export stay actions on the shell. Dataset export and observe-only capture stay available from the main Studio page.

## Evidence boundary

This page separates **source**, **offline tests**, **live browser connectivity**, and **authenticated harness acceptance**. Dedicated Studio Chrome connectivity has been demonstrated. No authenticated create, send, and follow-up has been accepted. The milestone detail below is the implementation order, not a claim that the full surface exists.

The capture capability list remains [UNIVERSAL-CAPTURE-STUDIO-CAPABILITIES.md](../UNIVERSAL-CAPTURE-STUDIO-CAPABILITIES.md). It describes the observation engine. It does not define a second product.

## 2. Principles

1. **Raw evidence is immutable and separate from inference.** Everything derived can be recomputed from the raw log.
2. **Read-only observation by default.** Capture uses CDP `Network.*`, an isolated-world DOM agent and the accessibility tree. It never uses `Fetch` interception and never stores typed form values. Page interaction is a separate, opt-in layer (`src/capture/actions.mjs` + `src/capture/human.mjs`) that types with real key events and runs only for `studio drive` or `campaign --execute`; a plain `record`/`capture` never touches the page. Playwright and Puppeteer are excluded.
3. **Honest coverage.** Gaps, pauses, masking, metadata-only streams and pre-attach blind spots are declared, never hidden. "Unbounded" means no arbitrary truncation, not infinite storage.
4. **Credentials never reach disk.** Cookie and auth headers are dropped, auth endpoints are metadata-only, and in-body tokens are masked in place with each mask recorded.
5. **Inferences are hypotheses with evidence and confidence** until the user confirms them.
6. **Universal core, families as priors.** Nothing in the core names a website. `ai-chat`, `data-table` and the other families are reusable semantic guides, not classification gates.
7. **Zero-dependency Node ≥ 22** for Windows-first portability. Python or other languages are allowed later as optional sidecars only where measurement shows they beat the JS algorithms.

## 3. Layered architecture

```text
 Chrome (dedicated profile, DevTools on 127.0.0.1 only)
   │  CDP flatten sessions: page + child targets
   ▼
 CAPTURE        src/capture/   network.mjs (L1 raw chunks via streamResourceContent, WS, EventSource)
                               dom.mjs + page-agent.js (L3 DOM, turns, content blocks, actions, a11y)
                               redact.mjs (credential policy)   recorder.mjs (run lifecycle, pause, quota)
                               actions.mjs (opt-in drive primitives: composer, send, reply, login wall)
                               human.mjs (human pacing: key events, pauses, mouse, focus prep)
                               campaign.mjs (sequential multi-site run: drive -> derive -> family)
   ▼
 STORAGE        src/store/     raw-log.mjs (append-only segments, sha256 manifest, bounded queue,
                               hysteretic overflow → declared gap ranges)   session.mjs (Dataset / KV /
                               verify)   versioned.mjs (profiles & families, rollback)
   ▼
 DECODE / L2    src/decode/    SSE, NDJSON, JSON, WS + envelope sniffing for unknown formats;
                               delta assembly: json-patch, path-ops, typed-events
   ▼
 REPLAY         src/replay/    reducer.mjs (one reducer for live + offline; duplicates, out-of-order,
                               interruption, reconnect)   derive.mjs (datasets, receipt, fidelity
                               breakdown, time travel, revision replay, search)
   ▼
 INTELLIGENCE   src/shapes/    infer.mjs (v1 suggestion engine: endpoints, collections, drift, quality)
                src/families/  build.mjs (site consolidation: one normalised shape set + signature),
                               family registry, evidence-based detection, mapping proposals
                src/intel/     v2 engine (see §4)
   ▼
 SURFACES       bin/studio.mjs (CLI, including drive, campaign, library)
                src/studio/server.mjs + ui/index.html (localhost UI, token + Host/Origin checks)
                exports: json, jsonl, csv, md, transcript
```

### Capture -> derive -> family

One pipeline, used by `campaign --execute` and reproducible by hand:

1. **Drive.** `src/capture/actions.mjs` (`driveSite()`) finds the composer — adapter selectors
   first, the generic heuristic second, so a site with no adapter still works — brings the tab to
   the front, types the prompt with `src/capture/human.mjs`, sends it, waits until the reply stops
   changing and reads it back. The exchange is recorded by the same `src/capture/recorder.mjs` the
   `record` command uses, so it lands as an ordinary session.
2. **Derive.** `src/replay/derive.mjs` produces datasets, `SHAPES` and `ASSEMBLED` (dialects) from
   that session, exactly as for a captured one.
3. **Consolidate.** `src/families/build.mjs` `buildFamily()` inspects all saved sessions but publishes only G1–G7 `capture_accepted` same-origin, fully derived sessions (unassessed/failed evidence remains accessible). It previously collected every derived session of the
   host, groups streams by transport and endpoint path (ids normalised to `{id}`), unions the field
   paths with occurrence counts, sorts everything and hashes the normalised shape set into a
   deterministic signature. `writeFamily()` persists it through `FamilyStore`, so each build is a
   new immutable `vNNNN.json` plus `CURRENT`.

`library build` runs step 3 alone over whatever sessions already exist; `library show` and
`library list` read the store. The pipeline is idempotent: two builds over the same sessions give
the same objects and the same signature.

### Canonical data model (three strata)

| Stratum | Contents | Where |
| --- | --- | --- |
| Observations | Immutable raw records (`seq`, `t`, `sid`, chunk bytes, frames, DOM batches, actions, gaps) | `sessions/<id>/raw/*.jsonl` + `manifest.json` |
| Semantic entities | Typed nodes with time-indexed revisions, identity key or linkage cluster | `src/intel/graph.mjs` (`TemporalGraph`) |
| Edges | `contains`, `references`, `rendered_as`, `caused` / `preceded`, `same_as`; each with confidence, status and evidence | same |

Derived datasets (`events`, `streams`, `timeline`, `records-*`, `family-*`) and KV entries (`SHAPES`, `ASSEMBLED`, `RECEIPT`, `DOM_TURNS`, `DOM_INSPECT`) are always rebuildable from the raw log.

## 4. Intelligence engine v2 (`src/intel/`)

| Module | Algorithm | Status |
| --- | --- | --- |
| `schema.mjs` | Online schema lattice in the style of genson/Spark: formats, enums, optionality, explicit unions, dynamic-key **map** detection, **tagged-union** detection, field alignment (name + value similarity, synonyms), schema similarity, drift diff with rename repair | TESTED (unit 6/6) |
| `learn.mjs` + `priors.mjs` | Naive Bayes role classifier over structural features, seeded from a cross-convention prior corpus. Scoped learner (instance > page > site > family > global) with revert and promotion candidates. Histogram calibrator with ECE. Active-learning ranking (entropy × impact) | SOURCE ONLY |
| `discover.mjs` | Record-type induction from repeated objects (arrays, maps, roots, assembled docs). Envelope and patch-stream exclusion. Key inference (role, uniqueness, revision stability). Type merging. Composition and inclusion-dependency references, including dangling references. Family priors as soft labels. Confidence per type | SOURCE ONLY |
| `identity.mjs` | Keyed grouping with revision diffs. Fellegi–Sunter-style keyless linkage (data-estimated u, blocking, union-find) | SOURCE ONLY |
| `correlate.mjs` | Action→request causal vs temporal scoring. Entity/stream→element matching by TF-IDF salient values + shingle containment + activity overlap. Ambiguity and conflict states. Payload↔UI final reconciliation | SOURCE ONLY |
| `graph.mjs` | Temporal evidence graph, `stateAt(t)`, instance-level reference and composition edges | SOURCE ONLY |
| `corpus.mjs` | Session → discovery corpus with provenance; DOM handles kept as provenance, not data | SOURCE ONLY |
| `eval/` | Ground-truth fixtures with dev and held-out splits (10 patterns), metrics runner | SOURCE ONLY — **not yet run**; `eval/learning.mjs` not yet written |

Intelligence levels: (1) deterministic heuristics; (2) adaptive statistical learning, implemented here; (3) optional LLM-assisted naming and interpretation, which is not built and must never be a hard dependency.

## 5. Verified state (headless Chromium 153, synthetic sites)

- **Unit tests:** 14/14 (core storage/integrity/redaction plus schema induction).
- **Capture E2E:** 4/4. This covers live raw SSE capture, byte-faithful framing, long responses, explicit slow-disk gaps and late-attach honesty.
- **Universality E2E:** 9/9.
  - chatgpt-style and claude-style protocols both unified into the `ai-chat` canonical message model;
  - rich content blocks;
  - data-table, content-feed, form-flow and article families detected;
  - typed form values never stored;
  - duplicate, out-of-order, interrupt and reconnect events flagged;
  - pause declared, not counted as loss.
- **Integrity:** `written + declared-dropped = issued` holds across segment rotation and a gap left open at shutdown, and tampering is detected.

A known limitation, verified: connections opened before attach are invisible to CDP. The coverage note states this, and a user-requested "reload to capture from start" action exists.

### 2026-10-23 update — offline work since 617f1067

Owner decision 2026-10-23: offline work only; fresh controlled captures are deferred. Code observed at main `75e7b882` (working tree clean at observation). Evidence labels: **Build** = source exists; **Integrated** = wired into derive, API or UI; **Locally demonstrated on synthetic data** = run locally on synthetic fixtures or in-process; **Observed on saved real sessions (read-only)** = counts only. Nothing below is a live-site, real-Chrome or Windows result, and nothing is independently accepted.

Commit note: the stated range `617f1067..5bcbc5bf` does not cover every commit cited here. Commits on main after `5bcbc5bf` are `ac87148d`, `56eed0dc`, `7b7e3306`, `3ec67e46`, `7cd1fb50` and `4106b785`; items 4–7 and 10 below cite them. The Records panel commit `1b3904d1` predates the `617f1067` base.

1. **Event identity** (`23c43e2c`): the reducer stamps `n`; event id is `sid#seq.n` (`src/replay/event-id.mjs`). Locally demonstrated on synthetic data (unit tests).
2. **Stable join keys** (`bc1be28e`, `82a83ffa`): DOM blocks carry `ord`; assembled stream blocks carry `key = messageId:index` and `parentIndex`. Message id comes from `message_start`, `response.created`, an `item_id` fallback, or the first full-document snapshot (`source 'snapshot'`, not written to `doc.meta`). Locally demonstrated on synthetic data.
3. **Stream-to-DOM join** (`bd42ade3`, `183a463f`, `99242658`; `src/intel/join.mjs`): statuses verified / partial / near_match / ambiguous / text_mismatch / unlinked_stream / unlinked_dom; role, markdown, entity and citation normalisation; blocks pair by rank order and inherit message finality; identical duplicate DOM elements are ambiguous. Synthetic fixtures only. Locally demonstrated on synthetic data.
4. **Derive steps and routes** (`61b880fd`, `bc2e946e`, `a81b82c5`): guarded, deterministic `STREAM_DOM_JOIN` (160-character stream preview and sid), `STREAM_COMPONENTS` (stream map applied), and an acceptance label (`acceptance.json`; label only, not used by family builds). Routes `/join`, `/components`, `/acceptance`. Integrated; the session record gives no separate test count for these steps.
5. **Stream-to-component maps** (`f6ae8750`, `56eed0dc`; `src/profiles/stream-map.mjs`): claude-typed-events, chatgpt-path-ops (ignore and finalize rules derived from a survey; semantics inferred) and openai-responses. Build.
6. **Decoders and capture bounds** (`ba251fab`, `ac87148d`, `07664233`): exact byte spans when CRLF is split across chunks (RF-1; Locally demonstrated on synthetic data); zero-dependency schema-less protobuf decoder (`src/decode/protobuf.mjs`); Connect/gRPC frames inflate (gzip, deflate, deflate-raw via `node:zlib`) and expose proto strings; live-only 2 MiB JSON cap with an oversize marker (derive is uncapped); streaming byte cap splits at the boundary; pre-raw arming buffer bounded. Build, except RF-1.
7. **Capture-path performance** (`f88d116f`, `ef66536f`, `07664233`, `4106b785`): live shape observation moved off the append path (deferred, time-sliced, sampled under load); events dataset was already buffered; DOM block normalisation cached per report. Measured on synthetic in-process runs only:
   - the saturation lab is too noisy to claim a p99 gain (CV 23–40%);
   - realistic chat scenario (paced SSE, DOM bursts, 6 MB JSON burst; n=3): event-loop p99 about 27–33 ms and queue-age p99 about 65–92 ms, within targets;
   - **longest single stall 101-105 ms (n=3, CV about 2%) misses the 100 ms target by 1-5%; it was 114-146 ms before the periodic STATE/SHAPES snapshots were written asynchronously (fc72fcb2)** (reference with capture disabled, i.e. the load generator alone: 24–53 ms; this is not a before/after of a fix);
   - remaining synchronous owners at the 5 s persist tick: the evidence walk (gatherEvidence) 41-56 ms, suggest 15-25 ms, profiler 6-22 ms; the STATE and SHAPES writes now run asynchronously.

   No real-Chrome performance number exists. Locally demonstrated on synthetic data; the 100 ms target is not met.
8. **UI** (`1b3904d1`, `4bfdf814`, `e87a4672`): read-only Records panel, Stream-to-page panel, Page components panel, and cursor-paged events scrubbing. Build: source and vm-stub tests only; no browser run.
9. **Tests**: `bun run test` (node --test unit suite) reports 817 tests, 816 pass, 0 fail and 1 pre-existing todo at the last full run. QA suites outside the unit suite: replay-fidelity (`617f1067`, 10/10 reported in `034d0e21`) shows 10 of 10 finished synthetic sessions byte- and event-faithful, with 2 sessions having an unfinished stream correctly excluded and one open todo (S1-F1: family build does not require an acceptance verdict). native-shape-fidelity (`2062f9f4`) shows 6 of 6 variants faithful at stream, components and page layers, with 3 cut variants correctly non-final. Locally demonstrated on synthetic data.

Defect fixes and their commits are listed in `workspace/aion/qa/capture-studio/FINDINGS.md` (2026-10-23 section).

## 6. Capability matrix (16 families)

States: NOT IMPLEMENTED · SOURCE IMPLEMENTED · TESTED SYNTHETIC (headless Chromium + fixtures) · TESTED SAVED REAL SESSIONS (read-only survey) · TESTED REAL WEBSITE · VERIFIED WINDOWS.

`TESTED SAVED REAL SESSIONS (read-only survey)` means counts computed read-only over the owner's saved sessions, with no live run and no text recorded. It is not a real-website test. `TESTED REAL WEBSITE` and `VERIFIED WINDOWS` stay empty.

| # | Capability | State |
| --- | --- | --- |
| 1 | Point at an active site | TESTED SYNTHETIC |
| 2 | Learn by watching (actions, navigation) | TESTED SYNTHETIC |
| 3 | Discover data layers (L1/L2/L3, a11y, media) | TESTED SYNTHETIC; TESTED SAVED REAL SESSIONS (read-only survey): Connect/protobuf transport observed in claude.ai traffic (reply-field path is a lead, not a parse) |
| 4 | Identify data shapes | TESTED SYNTHETIC (v1); v2 SOURCE IMPLEMENTED |
| 5 | Nested and mixed structures (blocks, tagged unions, maps) | TESTED SYNTHETIC (blocks, unit-tested unions) |
| 6 | Entities, fields, relationships | SOURCE IMPLEMENTED (v2); stream-to-DOM join TESTED SYNTHETIC; TESTED SAVED REAL SESSIONS (read-only survey): join linked 0 of 60 ChatGPT assistant turns in 11 sessions (old DOM extractor) |
| 7 | Suggested capture rules | TESTED SYNTHETIC |
| 8 | Visual inspect and fine-tune | SOURCE IMPLEMENTED (API + model ops); UI not yet updated for v2, families or model editor. Read-only Records, Stream-to-page and Page components panels: Build (source + vm-stub tests, no browser run) |
| 9 | Live evolving preview | SOURCE IMPLEMENTED (preview and draft API) |
| 10 | Full-fidelity recording | TESTED SYNTHETIC (split-CRLF exact byte spans fixed, RF-1; replay-fidelity 10 of 10 finished synthetic sessions) |
| 11 | Streaming semantics | TESTED SYNTHETIC; dialect detection TESTED SAVED REAL SESSIONS (read-only survey): chatgpt-path-ops matched 28 sessions; claude.ai connect+proto traffic is not matched by the claude typed-events map |
| 12 | Adaptive site profiles (versioned, rollback, drift) | TESTED SYNTHETIC (profiles, families); drift repair SOURCE |
| 13 | Calibration and quality scoring | SOURCE IMPLEMENTED |
| 14 | Search, replay, time travel | TESTED SYNTHETIC (replay-fidelity: 10 of 10 finished synthetic sessions faithful); cursor-paged events scrubbing Build (vm-stub only) |
| 15 | Local ownership and interoperability | TESTED SYNTHETIC (datasets, exports) |
| 16 | Privacy, permissions, resource control | TESTED SYNTHETIC; default local-raw capture mode bypasses stream credential guards by design, per owner direction in issue #65; issue #64 open |

No row is TESTED REAL WEBSITE or VERIFIED WINDOWS yet.

### Real-data findings and open items (2026-10-23)

**Observed on saved real sessions (read-only).** Read-only survey scripts (`scripts/fidelity-survey.mjs`, `scripts/proto-field-search.mjs`) over the owner's 107 saved sessions: 107 ok, 0 errors, no writes detected, 29 with finished status. Only counts were recorded; no text, URLs or session ids.

- **ChatGPT dialect:** real ChatGPT uses the path-ops dialect (28 sessions matched `chatgpt-path-ops`). After the map update about 590 previously unmapped protocol events are recognised; A later value-type check (types only, no values) showed that the events the survey labelled "redacted-shape" are routine message-open frames (a message object in `v.message` with null `error` and `error_code`), not errors. With message-open rules (`75e7b882`), a replay of the 27 replayable ChatGPT sessions leaves 3 of the 329 previously unmapped events unmapped, and no false error signals. An earlier inference that they were error envelopes, made from the key names alone, was wrong and was corrected before commit.
- **Stream-to-DOM join links nothing on real ChatGPT data:** 0 verified, partial or near-match links across the 60 ChatGPT assistant turns in 11 sessions that have saved DOM turns (the survey diagnosed 68 assistant turns in 19 sessions in total; the other 8 turns are Claude, whose protocol produces no stream message to join). The saved DOM turns came from the old turn extractor; every saved ChatGPT turn is exactly 13 characters (a hidden heading label). The extractor fix (generic, text-aware ranking) is verified only on synthetic DOM structures. Its effect on the real page is unverified until a fresh capture.
- **claude.ai:** conversation traffic is `application/connect+proto`, partly gzip-compressed. No server-sent-events reply stream was found in the 8 Claude sessions with DOM turns, and the claude typed-events map cannot match claude.ai. Reply text is carried partly in protobuf string field path `1.1.5.9` (top-5 in 8 of 8 sessions; best aggregation unionAll; median token Dice 0.66; presence coverage 0.71–0.73). This is a **lead, not an established parse**: the sample holds only about 2 distinct conversations (7 of 8 sessions repeat one prompt).
- **Stream arm:** 29 of 47 stream-arm attempts in one Claude session fell back to whole-body capture (small JSON responses).

**Open list (not verified):**

- Any live run on a real site after these changes.
- Real-Chrome performance (no number exists).
- The turn-extractor effect on the real ChatGPT page.
- Claude reply reconstruction.
- The 100 ms longest-stall target (synthetic: 101-105 ms, missed by 1-5%).
- Independent acceptance: none; L4/L5 0/7 unchanged.
- Development / Track B acknowledgement of the Studio consolidation: AX-0022/0023 still absent from `EXCHANGE.jsonl`.
- Issue #64 (credential masking): open. The default capture mode is local-raw, which bypasses the stream credential guards by design per owner direction in issue #65.
- S1-F1 (family build does not require an acceptance verdict): OPEN.
- Owner decision 2026-10-23: offline work only; fresh controlled captures deferred.

### Agent harness over real AI webapp conversations: product frame and critical path M0-M5 (2026-10-23, revised)

**Product frame (owner, 2026-10-23).** The product is an **agent harness** whose sessions are the user's
real AI webapp conversations (ChatGPT first) instead of API sessions. The AION team is the **first
workload**, not the product boundary; the earlier framing around one team workspace and a roster of 13
agents is replaced by this frame (the 13 roles are the M4 workload). The target is the **full visible
surface**: chat list, search, projects and workspaces; open, create, resume, switch, rename, archive,
delete; model and mode; attachments, tools and artifacts; stop, edit, regenerate, branch; context and
scheduling; recovery. This is a destination, not a claim: see the families table for what exists.

**Historical pre-M2 checkpoint (2026-10-23; superseded by the consolidation below).** Architecture reviewed. M1 is implemented as source with synthetic tests
(parent 201/201 on M1); there is still **no live exchange** and nothing is LIVE VERIFIED. M1 is
not accepted until its live gates pass. The 1,126 pass / 0 fail / 1 todo figure (log `studio-parent-harness-unit.log`), the standalone journal (33) and pure chat-index (19/19) counts, and the Chat UI 107/107 then 57 copy-correction count are this earlier checkpoint only. They predate the Sol source handoff. Current source and the parent suite that covers it are in the consolidated checkpoint below. Nothing in that later suite is LIVE VERIFIED. Live facts
are time-scoped: 17:44:39 UTC server health 200 with no browser on port 9222; 17:44:54 UTC
`conversation-targets` HTTP 500; 18:22:34 UTC still nothing on 9222; **18:24:48 UTC the dedicated Studio
Chrome (pid 20048) is running with CDP on 9222 connected (parent verified), and the DOM gate reports
LOGIN REQUIRED**, which is a human step. The earlier no-browser facts describe those times only. Ordinary
launch and owned server refresh need no extra approval; sign-in is the human's. Evidence, anchors and the
gates RT-0..RT-9 are in [`docs/LIVE-TEST.md`](docs/LIVE-TEST.md) section 6; routes are reconciled in
[`docs/DESIGN-live-drive-studio.md`](docs/DESIGN-live-drive-studio.md) section 17.

**Receipts, stated at their true strength.** Every passing test (168 focused conversation tests at 17:45:55
UTC, 33 new M1 tests, parent 201/201) uses injected fake adapters; they say nothing about ChatGPT or about
the running server, which was started before the M1 edits. A 503 in source is not M0: it must be observed
from a loaded runtime.

**Harness identities (distinct, never conflated).** *harness run* (a local task/workflow with checkpoints,
independent of a Studio process and potentially spanning threads; persistent run identity not implemented yet) · *account scope* (which signed-in account; not yet read) · *workspace* (personal vs team;
not modelled) · *project* (project and custom-GPT URL forms are not observed, so they stay `unverified`) ·
*thread* (`chatgpt-c:<uuid>` from the URL path; M1 source) · *message / branch / generation* (DOM `ord`
and stream message ids exist; branch and generation are not modelled) · *browser attachment* (CDP target
id, origin, owner) · *capture* (Studio session id) · *turn* (attempt id, key, payload digest; per
conversation today) · *optional role binding* (agent to thread; local, private, optional because a
harness conversation need not be a team role).

**Surface rules.** The [Command Space](../../../../../../ops/command-space/README.md) supplies the
vocabulary: the 105-row [capability universe](../../../../../../ops/chrome-relay/harvest/external/reference/capability-universe.csv)
(29 core, 11 existing, 65 future, none verified) and the 40-command x 1,000-row matrix. **A catalog entry is
not an implementation.** (1) *Open targets are not the account chat list:* `conversation-targets` lists
live tabs only; the sidebar is a **partial rendered index** (virtualized, never complete) and a full scrape
is not a prerequisite for the first useful exchange. (2) Observing a private backend endpoint is not
permission to replay authenticated requests; the default route is the actual page UI through the existing
adapter. (3) Evidence, current availability, effect class and coverage are separate columns and are never
merged into one status.

| Family | Command Space ids (catalog) | Effect class | Evidence | Studio availability today | Coverage |
| --- | --- | --- | --- | --- | --- |
| Discovery and navigation | `sessions.list`, `chat.search`, `discover`, `project.select`; workspace and account groups | read; `project.select` local or external mutation | source + offline tests for bounded rendered index | open tabs and explicit `POST /api/v1/chat-index` | partial candidates only; no complete account list, search, projects or workspaces |
| Lifecycle | `chat.create`, `chat.open`, `session.bind`, `chat.rename`, `chat.archive`, `chat.delete`, `chat.share`, `chat.export` | external mutation; `chat.delete` destructive | catalog only | attach to an existing tab and a fresh new-chat tab: SOURCE + synthetic; rest MISSING | bind and new tab only |
| Exchange | `send`, `observe`, `stream`, `reply.read`, `history.read`, `message.copy` | `send` external mutation; rest read | Studio source + offline tests | bounded visible Read; M2 journal/runtime turn ownership and guarded follow-up wired | rendered DOM; unloaded history unknown; authenticated exchange unproved |
| Turn control | `generation.stop`, `steer`, `message.edit`, `response.regenerate`, `branch.create` | external mutation | catalog only (branch: partial donor reference) | MISSING (stopping a capture is not stopping generation) | none |
| Model, mode, context | `model.list`, `model.select`, `mode.select`, `thinking.level.set`, `context.inject` | read; select and set are external mutation | catalog only | MISSING | none |
| Attachments, tools, artifacts | `file.attach`, `tool.toggle`, `tool.call`, `result.export`; artifacts group | external mutation or read | catalog only | MISSING | none |
| Scheduling, automation, recovery | `recover`, `cancel`, `health`, `receipt.read`, `agent.delegate`; scheduling and automation groups | read; others to be classified | catalog; Studio restart recovery synthetic | snapshot recovery and lease release SOURCE + synthetic; scheduling MISSING | recovery partial |

**Page readiness is not network completion.** Network completion stays network-only evidence. Page
readiness is a separate, attributed state that needs all of: the exact bound thread, the delivered user turn
attributable to this attempt, the reply turn attributed after the pre-send boundary, and stable controls in
the idle state (no stop control, composer and send idle) - then a fresh preflight before the next action.
Quiet text or an observed reply alone is not readiness.

**Ordered critical path.** Each milestone needs its own observed evidence; do not skip ahead.

| # | Milestone | Done means | Today |
| --- | --- | --- | --- |
| M0 | Harness contract + launch/readiness | The contract above is the documented base. The Studio's dedicated-profile Chrome runs with CDP (the local executor may start it with `studio launch` / `studio start`, which reuses the dedicated profile and does not reset it); the account sign-in is the human's; `/api/status` reports a browser; `conversation-targets` returns 200; browser-unreachable is a coded 503, not 500, **observed from a loaded runtime**. | Live: Chrome pid 20048 with CDP 9222 connected at 18:24:48 UTC (parent verified); LOGIN REQUIRED (human). 503 in source (synthetic tests) but unobserved: the server was not restarted |
| M1 | Exact existing-thread Read | The user's own already-open `/c/<id>` thread is selected by its URL path reference (never an inferred title); binding and the adapter check also compare that reference, so a thread switch gives `BINDING_CHANGED`; a bounded, source-labelled transcript Read that **preserves a draft already in the composer** (reports only presence and length) and does no focus, scroll, typing, clearing, navigation or send; list/get never write. It returns what the page currently renders, **including messages that predate the connection**; only history the page has not loaded is missing, and that is reported (`olderHistory` / `newerHistory`). **Sends are unchanged in M1.** | SOURCE + TESTED SYNTHETIC (parent 201/201); not live |
| M2 | Integrated useful SITREP + follow-up through the actual bridge from this agent session | Durable turn-owned reply, thread-level unknown-delivery fence, verified fast input and attributed page readiness; real useful SITREP plus substantive follow-up through the same runtime, no duplicate on uncertainty. | SOURCE HANDOFF offline (Sol): journal, exact-thread read/connect, candidate index POST, pre-typing cancellation fix, nine Studio tools, same injected runtime, no retries. Parent suite 1,187/0/1 covers that handoff. No real exchange; loaded runtime unverified |
| M3 | Discovery, search, navigation, create, rename, model and context | Partial rendered chat index, open targets versus account list, search, switching, create, rename, model/mode/context select. | bounded chat-index POST wired and offline tested; remaining navigation/full-surface work incomplete |
| M4 | Rich surface + team workload | Attachments, tools, artifacts; stop, edit, regenerate, branch; archive, delete, share. The AION team as the first workload: the 13 roles reported verified / unbound / blocked from local private bindings. | MISSING |
| M5 | Scheduling + recovery | Scheduling and automation; Studio restart recovers snapshots and the fence, replays no action, and releases leases. | restart/no-replay TESTED SYNTHETIC only; scheduling MISSING |
**Chat-index integration contract (now wired in source; real-page semantics unverified).** One read
operation through the same Studio runtime, API and tool manifest: `runtime.chatIndex({site, targetId, ...bounds})`
exposed once as a hub route (so the OpenAPI document and the MCP-style tool manifest list it together) that
delegates to the runtime. The target is **explicit** (`targetId` from `conversation-targets`; never a title)
and may be the ChatGPT root or sidebar page; it does **not** require a `/c/<uuid>` tab or an existing
conversation, and it creates **no** capture, recorder, session directory, raw-log record or lease. A small
reader seam performs one page evaluation of `chatIndexExpression(options)` and passes the same `containers`
array to `normalizeChatIndex(raw, options)`; before and after it checks that the target still exists and that
the target URL, `location.origin` and path are unchanged (otherwise `BINDING_CHANGED`, result discarded). No
scroll, click, search, focus, navigation, private-backend request or new driver. Container labels stay
`unknown` until sidebar selectors are verified by a read-only probe on the real page. Errors reuse the
existing codes (`BROWSER_UNAVAILABLE` 503, `TARGET_NOT_FOUND` 404, `TARGET_SITE_MISMATCH`, `BINDING_CHANGED`,
400 for bad options). Output is the module's `complete:false` index plus `{targetId, origin, readAt}`; each
 entry's `threadRef` is a candidate for `connect({expectedThread})`, not proof of a live binding. Tests first (fake CDP): root page lists without a
Recorder or session directory, navigation pre/post, foreign origin, one explicit tab among several, no
scroll/click/write calls, hostile links, bounds, coded 503, lease untouched.
**M1 launch receipts (2026-10-23, synthetic fakes only; nothing here is live).** 33 new tests
(`test/unit/conversation-thread.test.mjs` 29, `test/unit/conversation-read-api.test.mjs` 4) pass. The
168 existing focused conversation tests pass again after four deliberate edits to
`test/unit/conversation-runtime.test.mjs` (the existing-tab fixture now uses a `/c/<uuid>` URL, and three
tests call the explicit `recover` instead of relying on `get` to recover). Full unit suite via
`bun run test` (runs `node --test`): 1052 tests, 1051 pass, 0 fail, 1 pre-existing todo. The live facts
above (health 200, no browser on 9222, targets 500) are time-scoped to 17:44-18:22 UTC (see Status for
18:24:48 UTC); no live M1 check has run. The parent later reports 201/201 on its own M1 run. The 1,126 full-suite figure is historical; the suite that covers the Sol handoff is in the consolidated checkpoint.

**Read coverage semantics (clarification, 2026-10-23).** `coverage.preAttachHistory = 'not-captured-by-this-read'` (`src/capture/conversation-thread.mjs:124`) means the *raw network capture* did not record traffic from before attach; it does not mean those messages are absent from the Read, because messages still rendered in the DOM can predate the connection and are returned. The field name invites misreading; a rename such as a network-capture-scoped name is an optional later source change and is not made here. Likewise "reading the attached page changes no file" refers to the Read operation itself: the background recorder on the attached page keeps writing its own raw log and periodic STATE/SHAPES autosnapshots.

**M1 compatibility decisions (for parent confirmation).** (1) An existing ChatGPT tab whose path is not
a supported `/c/<uuid>` (home, project or custom-GPT forms, none observed in saved sessions or source)
connects as `unverified`: it can be browsed and finished but cannot send or Read (`THREAD_IDENTITY_UNVERIFIED`);
this is a behavior change for such tabs, including `studio chat --target`. (2) A fresh Studio-owned tab
is `unbound` (new chat) and sends exactly as before; locking the thread after the first send is M2.
(3) Sites without a thread parser stay `unbound` and unchanged. (4) Snapshots written before this change
read as `unverified / LEGACY_SNAPSHOT`: browseable, never silently verified for a send; replay of an
original key stays read-only. (5) `get`/`list` are pure and report `recovery.pending`; `recover(id)` is the
explicit runtime mutation, and reconcile/finish/submit keep their existing recovery. No HTTP recover route
was added. (6) Read is `POST /api/v1/conversations/{id}/read` with optional `maxMessages` (1-200, default
40) and `maxChars` (1-200000, default 60000), per-message cap 20000, live conversations only, no snapshot
write. (7) Optional `expectedThread` on connect. (8) The conversation routes were never registered in the
OpenAPI document; none was added (no OpenAPI overhaul).

**Rules for the path (M1-era rationale; current implementation status below).**

- **Never remove the single-turn guard alone.** M2 now wires its replacement: durable turn-owned replies and a thread-level fence with negative tests. This is source integration, not live follow-up acceptance.
- **Role mapping and connection are separate.** A role registry says which thread reference belongs to
  which agent (extend the existing `workspace/aion/ops/chrome-relay/role-launcher/ROLES.json`; it is
  stale at 8 roles against 13 agents; no new roster file). A connection is a live attach to one exact
  tab. Mapping never implies a connection, and a connection never rewrites the map.
  - **Privacy boundary.** The tracked roster holds non-sensitive identities only. Real thread URLs or
    references are never written to tracked files; a future registry may point at a **local private
    binding** under the Studio data directory (outside Git). The null URLs in `ROLES.json` mean
    "unverified in that registry", not proof that no real team threads exist.
  - **Workstream identities.** Core, UI, QA, Systems and similar are established Studio workstream
    identities, distinct from the 13 canonical roster agents. M4 (team workload) reports the 13 as
    verified / unbound / blocked, but must not reject an owner-intended lane conversation merely because it is not a
    canonical agent. `#AION` / `@name` are instruction conventions: no parser is installed
    (`parserInstalled=false`) and ChatGPT has no native commands for them, so Studio does not parse them.
  - M1 is identity and Read only; it does not touch the roster.
- **Browser profile safety (M0).** Use the Studio launcher, which owns the dedicated profile
  `<data-dir>/chrome-profile` (a real directory: `src/config.mjs:25`, `src/chrome/launch.mjs:45`). Do not
  use `scripts/chrome-cdp.ps1` with its default profile: it points at `%LOCALAPPDATA%\chrome-cdp-profile`
  (`scripts/chrome-cdp.ps1:22`), which on this machine is a junction (read-only check 2026-10-23 18:22
  UTC; reported by the M0 investigation to resolve to the default Chrome profile, not verified by this
  lane). A normal Chrome without a DevTools port cannot be attached. Login state is classified read-only
  first; manual sign-in is needed only if that classification says so.
- **Foreground writer lease and capture lifetime are separate.** Implemented 2026-10-23 (source + offline tests only; nothing here is a live claim): the drive lease is no longer held for the whole
  connection/capture. A fresh Studio-owned tab holds it only for the connect window (tab creation +
  navigation) and an existing-tab attach takes none; typing/dispatching hold it inside a per-turn
  writer window (`writerWindow` in `src/capture/conversation-runtime.mjs`) that stays open while an
  unresolved unknown delivery or partial draft exists and closes on observed delivery, proven
  pre-effect, or reconcile/finish resolution. Passive capture, Read, chat-index and reconcile are
  lease-free. `close()` finalizes every live entry even when no lease is held. See the checkpoint
  below for the exact offline evidence and the unchanged live gates.
- **Live scope.** The first live binding is the user's own existing `/c/<id>` thread, opened by the
  user. Titles are never used for identity or role matching. A role binding is optional and local; the
  harness serves any real conversation, with the AION team as the first workload.
- **Implementation order.** M0/M1 real-runtime gates still precede M2 real use; M2 source integration and the bounded M3 index slice do not close either gate. Full-surface/navigation and M4/M5 remain incomplete.

**Population denominators (not a single accepted total).** Two counts of ChatGPT sessions disagree and
are both recorded; neither establishes an accepted capture. The count of `capture_accepted` is **0**
under every denominator.

| Denominator (2026-10-23, read-only) | Count | Acceptance reading |
| --- | --- | --- |
| API `/api/v1/sessions` with site label `chatgpt` or `chatgpt.com` | 27 (26 with a ChatGPT target host plus 1 blank-target session still `recording`) | the acceptance endpoint returned `unassessed` for 27 of 27 |
| Oracle file inventory, ChatGPT origins | 26 | 15 without an acceptance sidecar, 11 `capture_rejected` |
| My sidecar check of the 27 | 27 | 15 absent; 12 stored `capture_rejected` (the 11 above plus the blank-target session, by subtraction) |

Why the API says `unassessed` for sidecars that say `capture_rejected`: `GET /api/sessions/{id}/acceptance`
calls `readAcceptance`, which fails closed to `unassessed` when the stored document no longer binds to
current evidence. All 12 stored sidecars lack a DOM_TURNS digest, which `readAcceptance` treats as
"legacy acceptance has no DOM_TURNS binding; re-evaluate" (`src/capture/acceptance.mjs:351`). The two
readings answer different questions (stored verdict versus currently re-verifiable verdict). Do not
quote either as an accepted total.

### Consolidated current checkpoint — 2026-10-23, Sol source handoff, parent suite before push

- **Source handoff (Sol), in tree, not a live claim:** durable thread journal and M2 runtime integration; exact-thread read/connect; candidate chat-index `POST /api/v1/chat-index` (partial candidates, `complete:false`, never a verified thread binding); pre-typing cancellation fix. Nine executable Studio conversation tools — `conversation_targets`, `chat_index`, `list_conversations`, `get_conversation`, `connect_conversation`, `read_conversation`, `submit_conversation_turn`, `reconcile_conversation`, `finish_conversation` — are invoked as `bun run -- node bin/studio.mjs tools ...`. They delegate to the same injected conversation runtime and do not construct a second runtime. No automatic retries or replacement keys after unknown delivery. These are harness operations, not the ChatGPT attachment / tool / artifact surface; that family remains MISSING.
- **Focused offline evidence:** cancellation **87/87** at **19:17:37–19:17:51Z**; tools **42/42** at **19:23:26–19:23:41Z**. Injected fakes. Not ChatGPT, and not proof a running server loaded this source.
- **Parent full suite after those changes:** `bun run test` **1,187 passed, 0 failed, 1 existing TODO, 1,188 total**. Log `studio-parent-final-before-push.log`. This count covers the pre-typing cancellation fix and the nine-tool registration. It is not live ChatGPT acceptance and not loaded-server proof.
- **Earlier offline receipts, superseded for this handoff:** M1 **201/201**; Chat UI **107/107**, copy-corrected focus **57 passing**; index-origin fix **29 passing**; guarded reader + index module **51 passing**; worker focus **221 passing**. Parent `bun run test` at 19:10+ UTC was **1,176 pass / 0 fail / 1 TODO / 1,177 total** (`studio-parent-m2-index-full.log`) and predates the final cancellation fix and nine-tool registration. The 1,126-pass log is older still. Scopes overlap; do not add their totals.
- **Not proved live:** no server refresh and no live send in this checkpoint. Dedicated Studio Chrome PID 20048/CDP 9222 was launched at 18:22 and parent-verified connected at **18:24:48 UTC**, with LOGIN REQUIRED then. Current login, and whether that Chrome or server PID 7996 (started **17:25 UTC**, before this source) loaded the later source, is unverified. No authenticated exchange. Default Chrome on 8448 was untouched; the `chrome-cdp-profile` junction points to the default profile and is not a safe dedicated-profile substitute.
- **Research not completed:** donor UI first-pass pattern notes remain useful. `vivim-final` is owner-owned and eligible for reuse. Deeper UI/sync/slave-profile lanes were cancelled for Claude credit before completion; that is neither a completed assessment nor a ban on reuse. Third-party dependencies remain unaudited. No config was changed by this docs pass.
- **Next, still outside this docs pass:** refresh only an ownership-checked Studio server and verify the loaded routes/manifest; human login; real zero-send exact-thread Read; useful SITREP and follow-up; then the remaining full-surface/navigation work. Parent validates, commits and pushes. The original five owner files stay excluded.

### Short writer lease checkpoint — 2026-10-23, Z.ai sandbox, offline only

- **Baseline repair (commit `0dd12c2c`):** `main` `521b9822` failed `test/unit/loadlab.test.mjs`
  ("repeat mode runs every mode N times...") on this machine: the queue-age probe only observes
  `RawLog.flush()`, whose periodic timer (50 ms default) never fires inside the tiny run's ~37 ms
  window, so repeats' `queueAgeP50Ms`/`queueAgeP99Ms` summarised `n:0`. The lab now takes one
  explicit end-of-window flush while still armed (both scenarios); `close()`'s final drain stays
  uncounted. After the repair the parent suite reports **1,195 tests, 1,194 pass, 0 fail, 1 existing
  TODO**. This supersedes the older "1,187/0/1" receipts for this environment; the earlier counts
  were recorded on other machines/times and are not re-verified here.
- **Short writer lease (commit `0a34e6dc`):** the target model above, implemented in
  `conversation-runtime.mjs` (writerWindow, scoped connect lease, close() fix, `writer.active` in
  conversation views) and `conversation-service.mjs` (window entry before browser-facing turn work,
  resolution-point releases, ownership-guarded release so a pre-effect failure never releases a
  window an earlier unresolved turn owns, reconcile-resolution release). `DRIVE_LEASE_BUSY` from a
  window collision now leaves no journal residue (the window opens before reserve). Evidence label:
  **Locally demonstrated on synthetic data (injected fake adapters)** — 4 new tests (idle connect
  lease-free; two conversations attach freely and collide only inside the effect window with no
  journal residue; unknown delivery holds the window until reconcile resolves it; fresh-tab creation
  window end-to-end) plus the two rewritten whole-lifetime-lease tests. Full suite after the change:
  **1,199 tests, 1,198 pass, 0 fail, 1 existing TODO** (`bun run test`, node --test).
- **Not proved live, unchanged:** no loaded server, no real Chrome, no authenticated ChatGPT turn,
  no `capture_accepted`. M0-M2 live gates (LIVE-TEST.md RT-0..RT-9) still require the owner's
  Windows runtime. The lease change is a precondition cleanup for M2/M5, not live acceptance of
  either.

### Release accounting and restart semantics checkpoint — 2026-10-24, Z.ai sandbox, offline only

Responds to the owner's integration review (INTEGRATION_REVIEW.md flags 1-3). Evidence label for
everything in this section: **Locally demonstrated on synthetic data (injected fake adapters and a
real drive-lease directory; child processes for dead-owner proofs)** — no live claim.

- **Unproven-release accounting (flag 1, commit `6a3635ec`):** `writerWindow.release()` no longer
  swallows a failed underlying release. A release that cannot be proven (ownership unreadable,
  taken over, or deletion failed) records `leaseReleaseError { code, at, message }` on the entry;
  `writer.active` stays **true** — the host may still be occupied — and `writer.releaseError`
  carries the code until a later `enter()` proves a fresh window or a release succeeds.
  `abortFailedConnect` uses the same accounting and attaches `leaseReleaseError` to the
  failed-connect error. There is deliberately **no retry, no reclaim and no blind resend**: a
  subsequent `enter()` that hits `DRIVE_LEASE_BUSY` surfaces the live holder honestly and leaves
  no journal residue.
- **Restart semantics (flag 2, corrected description + tests):** the earlier comment claimed a
  restarted runtime "re-opens the window on the next submit"; that was inaccurate — a restarted
  runtime admits **no new sends** into a loaded conversation (`CONVERSATION_NOT_WRITABLE`, a gate
  that predates the lease work). The accurate semantics, now tested: a restarted runtime holds no
  lease for loaded snapshots (`writer.active false`, `writer.releaseError null`); a refused submit
  opens no window and leaves no journal residue; a **stale crashed-holder lease is reclaimed by
  the next real window open anywhere on the host** (dead-pid proof in drive-lease, proven with a
  child process that acquires and exits); and the durable thread journal keeps fencing the
  unresolved crashed turn — a new live conversation on the same thread gets `THREAD_FENCED`, its
  opened window stays held on the fenced thread until reconcile/finish resolves, and teardown
  frees the host.
- **Failure-case matrix additions (flag 3):** partial typing (`TYPING_INTERRUPTED`) keeps the
  window held with `partial-draft-possible`, is **never promoted by a page observation** (the same
  rule as a preparing crash — the journal turn stays `unknown`, the thread stays fenced), and only
  teardown (`finish`) closes the window while keeping the uncertainty honest. Cross-runtime host
  interlock is proven at runtime level: a second runtime instance sharing the lease root hits
  `DRIVE_LEASE_BUSY` with the live `conversation-writer` holder and no journal residue.
- Full suite after these changes: **1,204 tests, 1,203 pass, 0 fail, 1 existing TODO** at commit
  `6a3635ec` (node --test, offline).
- **Not proved live, unchanged:** all M0-M2 live gates still require the owner's Windows runtime.

### Full-integration checkpoint — 2026-10-24, Z.ai sandbox (Core #68 freshness, streamed reply text, durable harness runs)

Evidence labels: **offline suite** (node --test), **real-Chrome fixture** (`scripts/live-e2e.mjs`,
Chrome for Testing 143), and **real-provider browser receipt** (guest Duck.ai dispatch; provider
refused generation). No authenticated conversation, no paid API, no new harness/browser actor.

- **Acceptance freshness, G1/G2 (Core #68, commit `7e19a0f0`):** the clean-data gate no longer
  accepts a historical prompt/reply that merely matches. The drive now records a **pre-send
  baseline cursor** — user/assistant turn counts sampled by the SAME page-agent full-DOM scan that
  later produces `DOM_TURNS`, before anything is typed (`attempt.baseline`, exposed in the
  conversation view; `driveSite` supplies `baselineTurns` to campaign contexts). With a baseline,
  G1/G2 enforce post-send growth and match the FIRST new turn (a re-rendered historical
  transcript cannot pass); without one, a text match alone is `unknown`, so the verdict is
  `capture_incomplete` — `capture_accepted` is unreachable on historical text. Evaluator version
  1.1.0 refuses to reuse accepted G1-G3 across the semantics change. New
  `POST /api/sessions/{session}/acceptance` evaluates with validated caller-supplied context
  (prompt, expectedReplyWords, completionRule, baseline) through the same reuse/receipt path as
  derive. live-e2e now proves the API path flips the stored fixture label to `capture_accepted`
  with "pre-send baseline enforced" recorded.
- **Streamed reply text (commit `b4538f42`):** the conversation event stream gains an opt-in text
  feed on the same EventFeed contract: default subscribers keep the exact metadata-only stream;
  `GET /api/v1/conversations/{id}/events?include=text` additionally receives bounded
  `conversation.reply_text` snapshots (source confidence network/page/differ, attribution
  identity, durable revision, true char count, truncated flag at 16k chars). Snapshots make any
  single event self-sufficient under bounded replay; prompts are still never included; events
  still cannot cause a resend. The Studio chat UI subscribes with include=text while a
  conversation is open — text merges monotonically, the poll loop remains the owner of state,
  and `reset` still forces a GET re-read.
- **Durable harness runs (commit `f3f9130b`):** run/task identity is now a durable file
  (`<data-dir>/harness-runs/<id>.run.json`) with an append-only, idempotent step ledger, bound to
  an optional conversation and resumable across processes. Steps execute the SAME nine
  conversation tools through the SAME runtime owner (`executeConversationTool` is the single
  shared path for the tool registry and the harness); steps record digests and bounded summaries,
  never bodies. Caller-owned step keys: same key + same arguments replays the recorded outcome
  without re-execution; a different digest is `IDEMPOTENCY_CONFLICT`; failed steps may be retried
  with both attempts retained. Surfaces: `/api/v1/harness/runs*` (tool manifest
  `harness_start_run` / `harness_run_step` / `harness_get_run` / `harness_list_runs` /
  `harness_finish_run` / `harness_note_run`) and `studio run create|list|get|step|context|finish`.
- **Suites at head `03dd5291`:** unit 1,241 tests / 1,240 pass / 0 fail / 1 pre-existing TODO;
  live-e2e 14/14 on real Chrome (fixture capture, derive, kb search, outcome packet, export,
  mirror, dedupe/detect/csv, integrity, studio API with acceptance-context flip and an idempotent
  harness run).
- **Real-provider receipt (2026-10-24, sandbox):** Duck.ai guest — the first dispatch LANDED
  (user turn rendered, `?chatID=<uuid>` assigned; consent "Continue" gate observed once) and the
  provider refused generation ("temporarily unavailable", anonymous code 02f8) for a datacenter
  IP; the failure-path session was captured and derived through this build (baseline sampled
  0/0 pre-send) and its acceptance honestly abstains (G1 unknown — the generic L3 role scan does
  not recognize `data-testid="user-message"` turns, recorded in the duck-ai profile). Also
  re-verified from this environment: z.ai renderer wedge (CDP evaluate timeout), Lumo
  `ERR_HTTP2_PROTOCOL_ERROR` in Chrome, qwen bot-gated landing, HuggingFace composer found but
  its send gate never enabled (real key events included), chatgpt/deepseek/arena 403,
  minimax/kimi redirects. **No real model reply was obtainable; none is claimed.** The
  authenticated two-turn live gate remains with the owner's Windows runtime.

### Webapp-native harness checkpoint — 2026-10-24, Z.ai sandbox (observation projection, capability capsules, shape atlas)

Implements the first concrete L02/L3 seam of the frozen architecture decision (one harness, one
evidence engine, one browser authority, per-provider native shape systems, small common graph) as
defined in `roles/14-webapp-native-harness/CONTRACTS.md` v0.1. Branch rebased onto the moved
`main` (`bbf9d674`: the specialist's docs-only workspace) with all 15 prior commits intact.

- **`aion.web-observation/1` (commit `d8d3a030`):** `src/shapes/observation.mjs` +
  `GET /api/v1/sessions/{session}/observation` — a loss-aware projection over the EXISTING derive
  outputs. Unknown native parts project as `unknown-native` with loss markers (never coerced to
  text); conversation identity is surfaced ONLY through the source-supported durable parser
  (ChatGPT `/c/<uuid>`) — guest `?chatID` ids and every other site stay `binding:'unverified'`,
  `nativeRef:null`; the five completion facts are distinct fields (providerNetworkEnded /
  pageStable / turnAttribution / captureFinalized / captureAccepted), each naming its evidence
  class. Bench Tier-0 E00/E03 covered as negative tests.
- **`aion.capability-capsule/1` (same commit):** `src/capture/conversation-capsule.mjs` +
  `runtime.capsule(id)` + `GET /api/v1/conversations/{id}/capsule` — page-local
  supported/unavailable/unverified operations with the runtime's own gate reasons; `stop_generation`
  reports NOT_IMPLEMENTED_IN_RUNTIME rather than fabricating a capability; advisory only, every
  gate re-checked at effect time. Bench E08 covered.
- **`aion.shape-atlas/1` (commit `0b54d0b6`):** `scripts/shape-atlas.mjs` +
  `docs/shape-atlas/{README,chatgpt,claude}.md` + committed `atlas.json` — the side-by-side
  native-shape atlas with every claim labeled SOURCE/SYNTHETIC/REAL/PRODUCT/UNKNOWN: ChatGPT
  identity grammar + path-ops stream (SOURCE+SYNTHETIC), Claude StreamTimeline Connect/protobuf
  leads with field hypothesis 1.1.5.9 UNCONFIRMED and no durable binding claimed, sandbox live
  receipts (duck.ai dispatch/refusal, z.ai, huggingface, claude.ai 302 login wall, chatgpt 403),
  and five explicit gaps.
- **Suites at head `0b54d0b6`:** unit 1,253 / 1,252 pass / 0 fail / 1 pre-existing TODO;
  live-e2e 14/14 on real Chrome — step 13 now also asserts the observation envelope on the REAL
  captured session (unverified identity for the non-parser fixture site, chat surface, five
  completion facts, accepted verdict preserved, loss markers present).
- **Still not claimed:** authenticated ChatGPT/Claude fresh observation (login walls recorded,
  not bypassed), verified Claude reply reconstruction, artifact/task native parses (PRODUCT-only),
  and the authenticated two-turn live gate (owner's Windows runtime).

### Round 6 integration checkpoint — 2026-10-24, Z.ai sandbox (Agent 14 hardened harness-run store + dispatch preflight)

Agent 14 published an executable package on GitHub main
(`roles/14-webapp-native-harness/implementations/round6/`, 5 files, 18 focused tests, remote
readback verified). This round integrated it into the product rather than rebuilding it, after
reconciling the 18-commit sandbox branch onto the moved main (`91039694`).

- **Hardened harness-run store (integrated verbatim):** `src/capture/harness-runs.mjs` is now
  Agent 14's hardened drop-in. Upgrades over the Round 4 store: step identity is
  `(runId, key, tool, canonical JSON args digest)` — order-independent canonical serialization
  (the previous digest hashed JS insertion order; equivalent key orders now replay, real changes
  conflict), with prototype-pollution and cycle rejection; an `in_flight` step is written to
  durable JSON BEFORE the executor is invoked; every state transition runs under an exclusive
  per-run `.run.json.lock` (busy locks are refused `RUN_BUSY`, never force-stolen); an executor
  exception is an UNCERTAIN effect unless the executor proves `effectState:'not_dispatched'`
  (only then is a `failed` step recorded); same-key retry after a proven not-dispatched failure
  is restricted to `retryableTools`; `finish` refuses a run with `in_flight`/`uncertain` steps
  (`RUN_HAS_UNRESOLVED_EFFECT`); concurrent notes are preserved by fresh re-read under the lock;
  and `recoverAbandonedLock(id,{expectedPid})` releases a crash-left lock only after verifying
  the owner process is dead — it never clears `in_flight`/`uncertain` effect fences.
- **Dispatch preflight (new module, verbatim):** `src/studio/harness-executor-preflight.mjs`
  wraps the single shared executor: `withDispatchPreflight(execute, validate)` runs the pure
  `validateConversationTool` first and annotates only pre-dispatch validation failures with
  `effectState:'not_dispatched'` — grounded because validation precedes execution. Errors after
  that point stay unannotated, so the store fences them as uncertain. `harness-api.mjs`'s
  `conversationToolExecutor` now routes through it; retry policy is DERIVED from the single tool
  registry (`HARNESS_RETRYABLE_TOOLS` = tools whose own annotations mark them read-only), so a
  future read-only tool is automatically covered and an effectful tool can never slip in.
  `submit_conversation_turn` is never auto-retried here — the conversation journal owns re-dispatch.
- **Superseded semantics (intentional, not restored):** the Round 4 behavior "any executor error
  records a failed step, failed steps auto-retry under the same key" is replaced by
  fail-closed fencing. Two original test assertions were superseded accordingly and are NOT
  restored; the HTTP fixture's argument-validation failure remains `failed` (proven
  not_dispatched by the pure preflight). Migration note: steps persisted by the Round 4 store
  used order-dependent digests — replaying them across the upgrade is fail-closed
  (`IDEMPOTENCY_CONFLICT`) rather than silently re-executing; per-run ledgers are local task
  state, not captured evidence, so no evidence migration is implicated.
- **Tests:** Agent 14's 15 adversarial store tests + 3 preflight tests installed at product
  paths (`test/unit/harness-runs.test.mjs`, `test/unit/harness-executor-preflight.test.mjs`),
  plus one preserved-original assertion block (identity validation, not-found and finished-run
  fencing). Focused: 22/22. Full unit suite at the integration head: 1,263 tests / 1,262 pass /
  0 fail / 1 pre-existing TODO (offline).
- **Real crash/lock probe (new):** `scripts/harness-crash-probe.mjs` proves the store's
  invariants with REAL child processes, no injected io faults — P1 cross-process same-key
  contention (`STEP_UNCERTAIN` while the first process's executor runs; replay without
  re-execution afterwards), P2 real SIGKILL mid-executor (step stays `in_flight` after restart,
  same key refused `STEP_UNCERTAIN`, `finish` refused `RUN_HAS_UNRESOLVED_EFFECT`, executor ran
  exactly once), P3 owner-verified stale-lock recovery (wrong pid `LOCK_OWNER_MISMATCH`, living
  owner `LOCK_OWNER_STILL_ALIVE`, verified dead pid released, run usable afterwards).
  14/14 invariants held in this sandbox (Linux); the SAME command is the standing Windows/NTFS
  local test for the owner runbook. live-e2e: 14/14 on Chrome for Testing 143 — step 13 drives
  the hardened store through the real HTTP API (idempotent replay, conflict, finish).
- **Still not claimed:** authenticated two-turn live acceptance (owner runtime); uncertain-step
  journal reconciliation remains a documented boundary (Agent 14's package does not implement
  the journal-specific resolution action; uncertain steps stay fenced until reconciled).

## 7. Roadmap (intelligence-first order)

> **Agent-harness path (2026-10-23):** the intelligence-first list below remains context. For the owner's
> current goal (an agent harness over real AI webapp conversations, the AION team as first workload) the
> controlling order is M0-M5 above. The Sol source handoff is offline-tested (see the consolidated checkpoint); nothing is live verified and no running server is proved to have loaded that source.

> **Superseded in detail by [ASSESSMENT-AND-WORKLOG.md](ASSESSMENT-AND-WORKLOG.md)** (2026-10-21 step-back: measured baseline, review findings R1–R10, worklog W1–W18). The list below is kept for context.

1. **Measure v2.** Write `eval/learning.mjs` (learning loop: improvement after corrections, contamination check, promotion). Run `node eval/run.mjs`, commit the measured `eval/results/latest.md`, then fix the algorithms against the dev split only and report held-out numbers unchanged.
2. **Unit-test v2 modules** with adversarial cases: identity linkage, inclusion dependencies, correlation ambiguity and conflict, graph `stateAt`, scoped learner revert and promotion, calibrator.
3. **Integrate v2 into `derive`** to persist the graph, model, hypotheses and active-learning questions. Expose them in the server API and wire user corrections into `ScopedLearner` with explicit scope selection. *Status 2026-10-21 (Sprint 01, `8218e6c`, PENDING INDEPENDENT QA):* model, entities, hypotheses and graph are persisted by `derive` (kv `MODEL`/`GRAPH`/`HYPOTHESES`, dataset `entities`) and served at `/api/sessions/:id/model|graph|hypotheses` and `studio model`. Suggestion accept/reject feeds the calibrator. Still open: active-learning questions, field-role corrections with scope selection.
4. **Connector contract.** Formalize CDP network, DOM, accessibility and interaction as connectors that describe surfaces, fidelity, lifecycle and limits. Add a HAR-import connector (non-CDP, retrospective) and a reconciliation planner that deduplicates semantic events across connectors.
5. **Cross-session knowledge store.** Resolve entities across sessions per site; align types across sites (family transfer).
6. **UI for intelligence.** Model graph explorer, hypotheses with confirm/reject, active-learning questions, model editor with live preview, families library, fidelity breakdown panel, non-colour cues.
7. **Optional level 3.** LLM-assisted naming behind a provider interface (local Ollama or external key), off by default, with validated outputs and minimized data.
8. **Windows packaging and acceptance.** PowerShell launcher and first-run flow, a concise README, a real-browser run, a chatgpt.com field run per EXPERIMENTS.md, and receipts.

## 8. Running it

```powershell
node bin/studio.mjs doctor
node bin/studio.mjs start            # capture browser + studio UI
node bin/studio.mjs record --target chatgpt
node bin/studio.mjs sessions ; node bin/studio.mjs receipt latest
npm test                              # unit
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"; npm run test:e2e
node bin/studio.mjs doctor
node scripts/harness-crash-probe.mjs  # harness-run store crash/lock recovery proof (keep the receipt)
node eval/run.mjs                     # intelligence evaluation (roadmap step 1)
```

### Round 8 integration checkpoint — 2026-10-24, Z.ai sandbox (Agent 14 adaptive adapter factory + Round 7 uncertain-step reconciler)

Agent 14 published two executable packages on GitHub main: `implementations/round8/` (generic
adaptive webapp adapter factory: candidate synthesis, evidence-weighted ranking, drift detection,
held-out shadow evaluation; 17 tests) and `implementations/round7/` (pure uncertain-step
reconciler; 17 tests). Both are now installed in the product verbatim and wired to the existing
Capture Studio systems — no second registry, no second browser actor, no send grant.

- **Self-generating webapp adapters (Round 8).** The corrected architecture is now live in code:
  handwritten `src/profiles/sites/*.mjs` adapters remain the seeds/fallbacks, while the factory
  turns Capture Studio's own evidence into data-only learned adapters.
  - Probe production (`src/studio/adapter-probes.mjs`): SAVED_REAL_CAPTURE probes from existing
    derive outputs (DOM_TURNS attribute selectors, ASSEMBLED stream endpoints, DOM_INSPECT /
    RECEIPT thread-URL route templates) and SANDBOX_REAL_BROWSER probes from a bounded READ-ONLY
    in-page measurement through the existing DomObserver. Absence is only claimed by a complete
    whole-document measurement; saved captures contribute presence votes only; thread routes are
    only proposed when the page URL carries identity-shaped tokens (never titles/ordinals/text).
  - Lifecycle (`src/studio/adapter-factory-service.mjs`): synthesize -> shadow-evaluate ->
    promote -> rollback over a VersionedStore at `<root>/learned-adapters/`. Promotion RE-COMPUTES
    the held-out shadow evaluation server-side; a client receipt alone never promotes;
    `AUTHORITY_VIOLATION`, `SHADOW_MISMATCH` and `PROMOTION_NOT_EARNED` fail closed. A learned
    adapter activates only held-out-confirmed READ features (user-turn, assistant-turn,
    thread-route, stream-component; composer/send-control/stop-control can never appear).
  - One registry, two views (`src/profiles/sites/index.mjs`): the execution path (`getAdapter`,
    used by drive/send) is byte-identical to before and can never resolve a learned adapter;
    `getReadAdapter`/`listReadAdapters` expose seeds + learned to observation surfaces. Defense
    in depth: a learned adapter carries `send.strategy 'learned-readonly'` and
    `sendMessage` refuses it before any CDP traffic (`src/capture/actions.mjs`).
  - API/tools (`src/studio/integration-hub.mjs`): `/api/v1/adapters/learned/*` (synthesize with
    optional live=1 measurement of the actively captured tab, shadow-evaluate, promote, list,
    get, rollback, transcript with `live=1` through the serve process's own recorder) and
    `/api/v1/adapters/read` (read view). Drift = synthesis with a prior: live absence of the
    previous selectors yields `PREVIOUS_CANDIDATE_NEGATIVE_OBSERVATION`; a replacement candidate
    yields `PROPOSED_REPLACEMENT_REQUIRES_SHADOW_VALIDATION`; learned-adapter rollback appends a new version restoring the target under a strict, explicit expectedVersion (promote: null for first create or the current integer; rollback: the current integer; a missing value is refused, never inferred), and all learned-adapter writes go through the one shared VersionedStore owner (per-name lock, expected-version CAS); profile/family rollback remains a pointer move.
- **Uncertain-step reconciliation (Round 7).** `src/studio/uncertain-step-reconciler.mjs`
  (verbatim) classifies unresolved submit steps against a durable pre-effect intent binding
  (`src/studio/intent-bindings.mjs`, atomic tmp+rename, one record per run+step, digests and
  identifiers only) recorded by the harness API BEFORE dispatch and completed from the OWNING
  journal (the submit args' durable request key IS the journal turn key) in a `finally` block —
  uncertain steps throw, and that is exactly the case the binding must survive. Read-only query:
  `POST /api/v1/harness/runs/{run}/reconcile`. Missing/incomplete/mismatched bindings stay
  `still_unknown`; `executed` is observed delivery, not acceptance; `not_executed` is never a
  resend permit. Journal access is the service's own read-only snapshot (new `journalSnapshot()`
  accessor; pure snapshot when the conversation is not open) — no competing parser. The step
  args digest comes from the store's own canonicalization (now exported as `argsDigestOf`) so
  binding and step identity can never diverge.
- **Local-integrator flag:** `launchChrome` honors opt-in `CAPTURE_STUDIO_CHROME_ARGS` (owner
  machines and synthetic-https fixtures); the CDP listener stays loopback-only.
- **Unseen-webapp demonstration** (`scripts/adapter-factory-demo.mjs` + unregistered synthetic
  https chat host `scripts/adapter-fixture-site.mjs`): zero handwritten adapters; four real
  `studio drive` exchanges through generic heuristics; candidate synthesized from three captures
  (probes=9, user-turn/assistant-turn/thread-route all shadow-ready); held-out shadow evaluation
  3/3 positive -> `candidate-read-only-preview`; server-re-verified promotion to v1
  (readFeatures=assistant-turn+thread-route+user-turn); saved-session transcript (2 turns,
  thread binding honestly `unverified` — no supported parser for the host); LIVE transcript while
  the serve process records; read view shows the learned adapter while a dry-run drive still
  resolves generic heuristics; v2 UI mutation -> two more drives + live measurement -> both drift
  reasons -> shadow 3/3 -> v2 promoted (`[data-msg-role="user"]`); rollback v2->v1->v2 verified.
  All 15 steps PASS on Chrome for Testing 143.0.7499.4.
- **Evidence labels:** everything above is OFFLINE-SUITE + SANDBOX-REAL-BROWSER against a local
  synthetic host (SANDBOX-DEMO). No third-party provider, no authenticated surface, no
  Windows-specific claim. `shadow-ready`/`candidate-read-only-preview` are ranking outcomes,
  not acceptance, runtime send capability or permission.
- **Tests:** +63 (Agent 14 packages 17+17 verbatim; probes 14; factory service 5; registry 4;
  learned-readonly send fence 2; Round 7 reconciler integration 4 with a real journal fixture).
  Full suite at the Round 8 head: 1326 tests / 1325 pass / 0 fail / 1 pre-existing todo.
  live-e2e 14/14 unchanged on Chrome for Testing 143.
- **Remaining gaps:** automatic extraction from provider-native encodings (Claude
  Connect/protobuf) stays a specialist decoder path (atlas B03); scheduled drift sweeps not
  built (drift fires on synthesis with a prior); learned-composer activation deliberately never
  (read-only authority); Windows/NTFS conformance for the learned/binding stores remains the
  owner handoff (same as the Round 6 store probe); read-only transcript identity stays
  `unverified` for hosts without a source-supported parser (by design, anti-fabrication).

Session data lives outside the repository, under `%LOCALAPPDATA%\AION\capture-studio`. Never commit captured data.
