# Design: Live drive in the Studio, and what "clean data" means

**Subordinate to [../ARCHITECTURE.md](../ARCHITECTURE.md).** That file is the only governing vision. This design note does not override it.

Status: design session 2026-10-22 (manager, after pausing the four build lanes). Nothing here is an
acceptance claim. "Observed" = read in source or run on this machine today; "reported" = a lane said
so and I did not re-verify; "hypothesis" = not checked.

## 1. Goal

One prompt, sent to a logged-in AI chat site from the Studio, ends in a **saved, verified, derived
session** whose data is trustworthy enough to build the shape library from, repeatable with no manual
cleanup. The owner's words: "a clean smooth data back and forth".

Non-goals: concurrency across sites, solving captchas/logins/age gates, looping a site for volume,
spoofing the browser, replacing the CLI (the CLI stays the reference path; the UI is a front end to it).

## 2. Evidence base

Observed today:

- Chrome 155 on 127.0.0.1:9222 is up with logged-in tabs for claude, arena, qwen, z.ai, deepseek,
  gemini, chatgpt. Node 24.11. 101 sessions saved. Studio UI was not running until I started `serve`.
- `campaign-state.json` stored `failed` for chatgpt/claude/gemini/deepseek/zai with a reason saying all
  12 words matched. Root cause: `campaign.mjs` set `status:'ok'` on a copy, persistence read the
  original. Fixed and pushed as `7b69bd2` with two tests. The old state entries remain until re-run.
- Unit suite: 85/86. The one failure, `trusted-knowledge.test.mjs` "corrupt derived JSONL is excluded",
  does not import campaign code. Pre-existing is likely, not proven.
- 4 sessions sit in status `recording`. Three are 10 h old (chatgpt, claude, 1337x): dead recorders.
  One (arena, 31 min) is the always-on recorder and is probably legitimate. Not verified.
- Partial lane output on disk, uncommitted, syntax-checked only (`node --check` passes):
  `src/studio/drive-api.mjs`, `ui/drive.html`, `ui/drive.mjs`, wiring in `server.mjs`, nav links in
  `ui/index.html` and `ui/live.html`. No tests exist for any of it.
- The transcript audit and the minimax/qwen/arena/kimi diagnosis lanes were cancelled before writing
  anything. Their questions are still open.

Reported (GPT-6.1 Sol review, file:symbol cited by the reviewer, not re-read by me):

1. `waitForCompletion` accepts DOM text after ~2.5 s quiet with no protocol terminal event.
2. Recording starts after navigation and composer discovery, so connections opened earlier are
   invisible; the drive records with `follow:false`.
3. Stop failures do not clear `result.ok`; a session can be saved as `stopping`.
4. `families/build.mjs:collectSessions` treats any session with a SHAPES artifact as derived; no
   completion, integrity or acceptance check; substring host matching.
5. `runCampaign` derives and builds families before checking reply words; overall `ok` ignores
   `totals.unverified`; resume skips `ok` sites without revalidation.
6. `sendMessage` fallback can double-send (its "before" state is not threaded into later checks).

## 3. Findings from reading the partial Studio work

Good, keep:

- `drive-api.mjs` implements the contract: one job at a time (409 + `activeJobId`), dry-run default,
  `confirm:true` for live, per-site progress, jobs persisted atomically to `drive-jobs.json` (50),
  interrupted jobs marked cancelled on restart and never retried, prompts and URLs scrubbed from stored
  reasons, 405/404 handling, campaign run one site per call so cancel works between sites.
- `drive.mjs` renders site text with `textContent`/DOM nodes only, drops live confirmation whenever the
  selection changes, handles 401/403/409/network errors, polls every 1.5 s.
- `server.mjs` serves the page under a strict CSP and cancels the job on close.

Defects found (observed in source):

- **D1 cancel is cosmetic.** `drive-api` passes `signal` to `driveSite`, but `driveSite`'s signature
  (`actions.mjs:923`) has no `signal`. Cancel only stops *between* sites; an in-flight drive runs to its
  timeout (default 120 s) while the job lock is held. Must be fixed in `driveSite`, not papered over.
- **D2 contract gap.** The UI reads `defaultPrompt` from `GET /drive/sites`; the API never returns it.
- **D3 verdict logic is duplicated.** `driveVerdict()` in drive-api re-derives verdicts, including a
  regex on the reason text to rescue the legacy `failed` entries. After `7b69bd2` new state is correct;
  the regex is only a bridge for old entries and must not become a second source of truth.
- **D4 no tests**, and no test can exist for cancel until D1 is fixed.
- **D5 gate missing.** A job that "completes" (words matched) says nothing about whether the saved
  session is intact. See section 5.

## 4. Architecture

```
Studio UI (/drive)  ->  /api/v1/drive/*  ->  drive-api (job queue, 1 active)
                                                |-- drive mode:    driveSite()  ---+
                                                '-- campaign mode: runCampaign() --+--> Recorder (own tab)
                                                                                    |
                                       post-drive gate  <---------------------------'
                                       stop -> verify -> derive -> accept|reject
                                                |
                                  verdict + sessionId  -> campaign-state.json (single writer)
                                                |
                                  family build (accepted sessions only)
```

Decisions:

- **A1. One verdict, one writer.** Verdict is computed once, in `campaign.mjs`/`actions.mjs`, and
  persisted. drive-api reads and displays it. The legacy-reason regex stays only as a read-time shim,
  marked deprecated, deleted once stale entries are re-run.
- **A2. Serial, one prompt per site per job, no auto-retry of a send.** Unchanged. Uncertain send =
  report, never repeat.
- **A3. Cancellation is a first-class `driveSite` option.** `signal` is checked at each await boundary
  (type loop, send, wait loop). On abort: stop typing, do not press Enter if not yet sent, then run the
  normal cleanup (recorder stop awaited, then tab close). Job lock is released only after cleanup.
- **A4. UI stays an additive page.** No change to existing Studio views beyond nav links and the
  `#session=<id>` deep link.
- **A5. Loopback + token + Host/Origin unchanged.** No new auth surface; POST needs the cookie.

## 5. The clean-data gate (what "verified" must mean)

Words matching is necessary, not sufficient. A drive is **accepted** only if all hold:

| # | Check | Source of truth |
|---|-------|-----------------|
| G1 | Exactly one user turn submitted; prompt text equals the sent prompt | L3 transcript |
| G2 | New content appeared after send (count grew), reply words match in order | `waitForCompletion` + `replyMatchesExpectation` |
| G3 | Reply stable for N s **and** no streaming indicator; where a protocol terminal event exists (SSE `[DONE]`, `message_stop`, WS close frame) it was seen | L1/L2 |
| G4 | Recorder stopped successfully **before** the tab was closed; session status is `complete` (not `recording`/`stopping`) | session meta |
| G5 | `studio verify <id>` passes: hashes valid, no exchange gaps, no exclusions | verify |
| G6 | Derive succeeded, entity dataset present or explicit `complete` with 0 | `KNOWLEDGE_STATUS` |
| G7 | L2 answer text and L3 DOM text reconcile for the reply | derive |

A drive that fails G1-G3 is `unverified` or `failed`; one that passes G1-G3 but fails G4-G7 is
`unverified` with the failing gate named in the reason (never silently `ok`). Only `accepted` sessions
feed `library build`. Gate G3's terminal-event requirement is per-site and may start as "recorded, not
required" for sites where no terminal marker is known, with that stated in the reason.

Known limit, stated not hidden: connections opened before attach are invisible to CDP (ARCHITECTURE.md).
For drives this is mitigated by arming the recorder on the fresh tab before navigating to the site
(hypothesis: needs `Target.setAutoAttach` + `waitForDebuggerOnStart`; to be checked in `recorder.mjs`).

## 6. API contract (initial drive proposal)

Unchanged from the lane brief, plus:

- `GET /api/v1/drive/sites` also returns `defaultPrompt`.
- `job.progress[].gates`: `[{id:'G1'..'G7', ok:true|false|null, note}]` so the UI can show *why* a site is
  unverified.
- `POST .../cancel` returns 200 with the job still `running` until cleanup finishes; clients poll.

## 7. UI

Keep `drive.html`/`drive.mjs` as built. Add: gate list per site row in the job panel; "stuck sessions"
notice with a "Verify & repair" button that calls the existing verify/derive endpoints for sessions in
`recording` older than 10 min whose recorder is not alive (never touches a live recorder); a persistent
line "One prompt per site. Chrome window must be in front." Status vocabulary stays honest: the word
"success" is shown only for `accepted`.

## 8. Risks

- Accounts: every live run spends quota and leaves a chat. Mitigation: dry-run default, explicit
  confirmation, one prompt per site, stop on rate limit/captcha/login/age/consent.
- Foreground: a window behind another window reports hidden tabs and drops key input. Mitigation:
  `scripts/focus-chrome.ps1` before live runs; UI warning.
- Repair button could hit the always-on arena recorder. Mitigation: only sessions with a dead owner.
- Stale `campaign-state.json` misleading the UI. Mitigation: A1 shim + re-run.

## 9. Test plan

Unit (no browser, injected fakes): job lifecycle; 409 on concurrent job; confirm required; dry-run opens
nothing; auth required; cancel mid-drive aborts and releases the lock (needs D1); verdict mapping incl.
legacy shim; gate failure yields `unverified` with named gate; restart marks running jobs cancelled.
Live (owner's Chrome, serial, one prompt per site, foreground window): chatgpt, claude, gemini,
deepseek, zai first (already known to match), then qwen, lmarena, kimi, minimax (known problem sites).
Evidence per site: session id, verdict, gates G1-G7, `verify` output.

## 10. Phases

1. **Core (single owner, sequential):** D1 `signal` in `driveSite`; D2; gates G4-G7 in the post-drive
   path; `collectSessions` accepts only accepted sessions. Tests.
2. **Studio:** commit drive-api + UI after phase 1; add gate display and repair notice; restart `serve`.
3. **Live pass** over the nine sites with the gate; fix adapter gaps site by site (minimax/qwen/arena/
   kimi diagnosis is the first task here, read-only).
4. **Stale cleanup:** verify+derive the three dead `recording` sessions; re-run the five stale campaign
   entries.

Parallelism: phase 1 is one writer (it all touches `actions.mjs`/`campaign.mjs`). Read-only diagnosis
(minimax/qwen/arena/kimi, transcript audit) can run alongside. Live runs never run in parallel.

## 11. Open questions for the owner

1. Is requiring a protocol terminal event (G3) acceptable to start as "recorded, not required" per site?
2. May the repair button auto-run `derive` on dead `recording` sessions, or only offer it?
3. Should accepted/rejected be stored in session meta (touches the session format) or in a sidecar
   `acceptance.json` (no format change)? Recommendation: sidecar.

## 12. Unified conversation architecture — 2026-10-22 revision

**Status: proposed architecture, not implemented or live-verified.** This section supersedes the
one-shot-only product direction in sections 1, 4 and 10, not their safety constraints. The owner wants
the same Studio to interact with a website and read the result. Campaigns become a calibration tool,
not the primary interaction model. Current live testing remains one prompt per site; designing a
multi-turn interface does not authorize unattended conversations or additional live sends.

### 12.1 Product boundary

One logical conversation owns an exact Chrome target binding, its capture segments, and ordered
turns. The UI, CLI and agent clients call the same conversation service. They do not independently
drive the browser or infer success. No iframe embedding of logged-in sites, copied credentials,
provider HTTP impersonation, new daemon, or second raw-evidence store is needed.

The routine flow is connect -> inspect readiness -> submit one turn -> observe reply -> inspect
evidence -> finish. A later explicitly authorized turn uses the same binding, not another fresh tab.
Existing-tab attachment is non-destructive: never clear an existing draft, navigate, reload, or close
an owner tab implicitly. A fresh tab is Studio-owned and can be closed after capture finalization.

### 12.2 Reuse confirmed in source

- `recorder.mjs:69-137` already creates an exact-target recording and mirrors persisted records through
  `StreamReducer`. It records that pre-attach requests/history are unknown.
- `live-tap.mjs:8-43` already provides decoded events, text revisions/replacements and explicit lag;
  its bounded preview queue can drop payloads without dropping the durable raw log.
- `capabilities.mjs:246-249` already exposes a resumable SSE live feed. Reuse this transport pattern;
  stream text events alone are not proof that text belongs to the submitted turn.
- `integration-hub.mjs:81-136` already provides session metadata, receipts, derive, replay and stream
  reconstruction. Full derive/replay is deliberately saved-session-only. Do not weaken that guard
  to make a persistent conversation appear finalized.
- `actions.mjs:923-1109` is currently a one-shot lifecycle, not a persistent conversation driver:
  it probes before recording, clears the composer, sends, reads DOM text, stops recording, and closes
  its own tab. Extract reusable actions beneath a new lifecycle owner rather than keeping this
  function running forever or duplicating its logic in HTTP handlers.

### 12.3 Components and authority

**Conversation service:** sole owner of target lease, action serialization, turn journal and cleanup.
One global foreground-driving lease covers Studio conversation turns AND legacy campaign jobs.
Passive recording does not acquire permission to type. If an existing recorder already owns the
target, reuse its evidence stream only through an explicit compatible ownership interface, otherwise
return a conflict; never stop or replace an unknown recorder.

**Capture binding:** associates conversation ID, exact target ID, exact origin and capture session ID.
Target disappearance or cross-origin navigation invalidates the writable binding. A site redirect
needs an explicit adapter allowance and revalidation. Browser restart requires explicit reattachment;
never select the first same-host tab. A conversation can reference multiple finalized capture segments
without copying their raw data. Initial release uses one segment, finalized on Finish.

**Turn correlator:** snapshots transcript identity/count and durable sequence boundary before send.
Correlates outgoing request, conversation/message IDs and response stream IDs where available.
Timing alone is insufficient. Unrelated telemetry, history fetches and background answers are excluded.
One turn may span multiple streams; one persistent stream may carry multiple turns.

**Reply assembler:** consumes the existing decoder/reducer/tap, with a pinned site extraction recipe.
Shape families describe structure; they are NOT automatically trusted semantic answer extractors.
Each recipe must identify assistant content, patch/replacement semantics, message correlation and
exchange completion. Preserve separate content blocks (answer, reasoning if browser-exposed, tool
activity, citations); never concatenate every string field into an answer. Unknown recipes expose
candidate text as unverified, with an explicit DOM fallback source.

**Acceptance evaluator:** evaluates saved evidence after stop/flush/verify/derive, separately from
interactive reply readiness. Store a versioned local `acceptance.json` sidecar referencing raw-log
identity, capture segment, turn, recipe version, evaluated sequence range and individual gates. A
changed artifact or recipe invalidates the previous evaluation rather than silently inheriting it.
This sidecar choice is a manager recommendation, not recorded owner approval.

### 12.4 Independent states, not one green success flag

- Conversation: disconnected, attaching, ready, busy, blocked, needs-reconciliation, finalizing, closed.
- Send: not-attempted, submitting, observed, uncertain. Persist the attempt BEFORE the side effect.
- Reply: waiting, streaming, ready, interrupted, unknown.
- Evidence: recording, finalizing, accepted, rejected, incomplete.

A reply can be ready while evidence is still recording. Never mark the whole capture accepted before
finalization. A transport close is not necessarily an exchange terminal marker, and a WebSocket may
remain open across replies. Unknown terminal semantics remain unknown; DOM stability may establish
an interactive fallback, not full network-completion evidence.

G1 applies to the new submitted turn, not the whole pre-existing transcript. Expected-word checks
are calibration-only; normal conversations instead require observed submission, attributable new
assistant output, completion evidence and reconciliation. Compare content blocks with explicit
formatting normalization; preserve both originals and report differences rather than forcing equality.
Judge coverage against the relevant turn/streams, while still exposing all session-wide exclusions.

### 12.5 Send and cancellation protocol

Each submit carries a client-generated idempotency key and expected conversation revision. Persist
its intent, payload digest and attempt state atomically before issuing a browser action. A duplicate
key with the same payload returns the original turn; a changed payload conflicts. This prevents
Studio-side duplicate attempts, NOT exactly-once delivery by a third-party website.

If acknowledgement is lost, transition to uncertain and block further sends. Read-only reconciliation
looks for the exact submitted turn and response; never click Send again as a fallback. On process
restart, any submitting turn becomes needs-reconciliation and is never automatically resumed.

Cancellation before submission stops typing and leaves any resulting draft visible for inspection.
After submission it cancels local driving/waiting, not the provider's generation. Continue collecting
evidence until explicitly finalized or a bounded capture limit is reached. A remote Stop-generation
button is a separate explicit operation, outside the first release. Release the driving lease only
after local action cleanup; do not claim the provider stopped because a local wait was cancelled.

### 12.6 Proposed API and agent contract

Register routes through the existing integration surface and protections; all names below are proposed:

- `GET /api/v1/conversation-targets`: sanitized target choices and ownership/readiness hints.
- `POST /api/v1/conversations`: explicit existing target or known-site fresh-tab mode; attach/capture
  only, no implied send. Return binding identity and limitations.
- `GET /api/v1/conversations/{id}`: revision, binding, states and capture references.
- `POST /api/v1/conversations/{id}/turns`: explicit execute confirmation, prompt, idempotency key,
  expected revision; return 202 with a turn ID, never hold an HTTP request open until generation ends.
- `GET /api/v1/conversations/{id}/turns/{turn}`: send/reply/evidence state, structured content blocks,
  source and evidence references. Bounded paging/chunk references preserve long replies without
  silently truncating them or putting raw text into job summaries.
- `GET /api/v1/conversations/{id}/events`: ordered state and text events using existing SSE machinery.
  Text replacements carry revision semantics; reconnect never appends a full replacement as a delta.
  Event-history overflow returns an explicit resync requirement, not a fictional complete replay.
- `POST /api/v1/conversations/{id}/cancel`: cancel local activity with the semantics above.
- `POST /api/v1/conversations/{id}/finish`: stop/flush, evaluate saved evidence, release binding;
  close only Studio-owned tabs when requested. Repeat calls return the same finalization outcome.

CLI/tool wrappers call this same service. The first implementation exposes connect, submit, read,
events and finish; convenience `converse` is a wrapper, not another automation engine. Read calls
never send or mutate the website. Browser output is untrusted data, never executable tool authority.
Prompts/replies stay in protected local capture storage, not Git, campaign summaries or shared receipts.

### 12.7 Delivery slices and executable proof

1. **Lifecycle foundation:** shared driving lease, signal-aware actions, explicit tab ownership,
   durable attempt journal and uncertain-send recovery. Test concurrent campaign/conversation attempts,
   cancellation around submission and crash recovery with fakes.
2. **One-site vertical slice:** connect -> one submit -> correlated live reply -> finish -> acceptance,
   using one known adapter and recorded/synthetic fixtures. Prove unrelated streams and old DOM text
   cannot become the answer; test patches, duplicates, long replies and preview lag/replay recovery.
3. **Unified interface and agent client:** both exercise the same service. Test stale revisions,
   duplicate idempotency keys, auth/origin denials, target loss and existing-draft protection.
4. **Serial site expansion:** one authorized calibration prompt per site, no retry on uncertain send.
   Unknown sites remain visibly unsupported/unverified; do not generalize from one site's success.
5. **Later scope:** explicitly authorized multi-turn execution, bounded capture rotation, and reviewed
   extraction-recipe improvements. Accepted captures propose versioned recipes; fixture replay and
   regression checks are required before promotion. No automatic live self-modification.

No implementation, additional live sends, repair of old recordings, or runtime restart is performed
by this design revision. The earlier machine/session counts are historical observations, not refreshed
telemetry. Sonnet 5.5 reviewed the proposed architecture against the source; the following decisions
resolve its builder questions. This is ready for owner design review, not implementation acceptance.

## 13. Reconciled UX and builder decisions

Design review: retained designer session `ses_e9d3e14b3ffeWWcCmq1N1lvery`, Sonnet 5.5.
These are manager decisions where not explicitly owner-directed. This section takes precedence over
conflicting earlier proposed gate behavior, UI wording and open questions.

### 13.1 Unified Chat workspace

Add **Chat** to the existing navigation without changing the default landing view or removing `/drive`.
Chat contains a target bar, transcript, composer and progressively disclosed Details. **Calibrate sites**
links to the existing drive page; both share the same global driving lease.

Primary flow and exact action labels:

1. Choose **Open a new tab** or **Use a tab I already have open**, then **Connect and start recording**.
   Connection starts observation, not a send. Existing messages are allowed and marked earlier history;
   pre-attach traffic is explicitly not captured. The fresh-tab path may navigate only its own tab
   after capture is armed, using an explicit site profile rather than guessing from `about:blank`.
2. Show readiness, exact tab identity, recording state and draft presence. Existing drafts block send.
   Initial release offers **Resolve draft in Chrome** and **Check again** only: no replaceDraft API,
   destructive confirmation flow, or automatic clearing. Recheck the composer immediately before
   typing; a newly detected draft or changed binding blocks submission.
3. **Send message…** opens an explicit account/quota/history confirmation; **Send now** submits one
   turn. Placeholder: **Write a message to this website**. Calibration text belongs on `/drive`, not
   in the normal conversation composer. The initial composer locks after this one turn.
4. Show **Submitting**, **Send observed** or **Send not confirmed**, followed by the separate reply
   state. An observed send followed by a slow reply is not automatically an uncertain send.
5. **Reply ready. Still recording.** Content identifies its actual source: network, page fallback,
   disagreement or unverified candidate. Answer is expanded; exposed reasoning, tool activity and
   citations are separate collapsible blocks. Unknown completion remains visible.
6. **Finish capture** finalizes saved evidence. An optional **Also close the tab Studio opened** is
   permitted only for a non-uncertain Studio-owned tab. Owner tabs always remain open. Show **Capture
   accepted**, **Capture rejected** or **Capture incomplete**, with **Open session** for existing views.

Uncertain-send banner: **We can't confirm your message was sent. Studio will not send it again.**
Offer **Check again (read-only)** and **Switch to Chrome**. Preserve the tab. User statements about
whether a message was sent are recorded as assertions, not proof, and never silently authorize a retry.
Initial release has no resend shortcut. Read-only reconciliation can continue after local waiting stops.

Cancellation labels distinguish **Cancel send** before submission from **Stop waiting** afterward.
Neither label promises that the website stopped generation. Recording continues until Finish or the
declared capture limit. Partial local typing remains visible and requires manual draft resolution.

### 13.2 Acceptance and recovery decisions

- **Unknown required completion => Capture incomplete, never accepted with unknowns.** This supersedes
  the optional-terminal proposal in sections 5 and 11. A versioned recipe can establish completion by
  proven exchange semantics without a literal end token; stable DOM alone is fallback readiness.
- Gate values are `passed`, `failed`, `not-checked`, `unknown`. Missing evidence is unknown, not passed.
  Gate rows use plain labels, not success glyphs. Word matching remains calibration-only.
- Acceptance sidecar is the proposed initial format. It is derived, versioned local evidence, not a
  replacement for session metadata or raw receipts. Legacy sessions without it remain unassessed,
  not silently rejected or rewritten. Library builds exclude unassessed captures by default and
  report exclusion counts.
- Repair of historical recordings is separate deferred work. No age-only automatic repair; neither
  this design nor a dead-looking timestamp establishes recorder ownership or permission to overwrite.
- Capture default budget proposed for the first release: 15 minutes or 256 MiB raw bytes, whichever
  comes first. Expose the actual configured limits and usage, warn at 80%, and finalize as incomplete
  if the limit interrupts a turn. This is a product limit, not a claim that the current recorder
  enforces it or that the stream itself is intrinsically bounded.

### 13.3 API details closing builder gaps

Extend the proposed section 12 routes with:

- `GET /api/v1/conversations`: paged persisted summaries for recovery after refresh/restart; no prompt
  or reply bodies. Include conversations needing reconciliation.
- `POST /api/v1/conversations/{id}/reconcile`: read-only website inspection, with expected revision;
  persist observations and update state without typing, clicking Send, navigation or reload.
  Optional user assertions have provenance `user-asserted` and cannot pass evidence gates alone.
- `GET /api/v1/conversations/{id}/readiness`: read-only current binding/composer checks; return
  `draft:{present,chars}` rather than copying a private existing draft into summaries.
- Target choices include `ownedByStudio`, `recorderOwner` and tri-state `visibility` (visible, hidden,
  unknown). Until explicitly implemented, tab-switch guidance is manual; no implied focus API.
- Shared lease conflicts return `holder:{kind:'conversation'|'drive-job',id}`; preserve `activeJobId`
  for existing drive clients when applicable. Registration and lease acquisition must be atomic
  across all exposed entrypoints. Direct legacy CLI driving must participate or be blocked while
  the service owns the browser; an in-process flag alone is insufficient for separate CLI processes.

Turn snapshots have stable fields:

```json
{
  "id": "turn-id",
  "revision": 1,
  "send": { "state": "observed", "observationSource": "page" },
  "reply": {
    "state": "ready",
    "source": "network",
    "completion": "unknown",
    "blocks": [],
    "contentPage": { "nextCursor": null, "hasMore": false }
  },
  "evidence": {
    "state": "recording",
    "sessionIds": [],
    "gates": [],
    "unknowns": ["exchange-completion"]
  }
}
```

The example is a snapshot, not acceptance: `reply.ready` with unknown completion is only interactive
readiness. `blocks` contain kind, source, revision, text or paged content reference, and evidence
references to session/stream/sequence ranges. `reply.source` is `network|page|differ|candidate`.
Conversation snapshots expose `capture:{endsAt,maxBytes,bytesWritten,limitReason}`. Sensitive content
and content digests stay local under the same access protections; no raw content in history summaries.

### 13.4 Responsive and accessible interaction contract

Sonnet's layout: at 1100 px and above, transcript plus a 340 px Details drawer; below that, inline
Details; below 700 px, collapsed target selector and stacked confirmation controls. All Chat controls
have at least 44 px hit areas through scoped styles, without globally restyling existing views.

Enter inserts a newline. Ctrl/Cmd+Enter opens confirmation but never sends. Escape dismisses only
confirmation; it never cancels a submitted turn. Use visible focus and labelled radio groups. Do not
announce every streaming token: a single polite live region announces phase changes. The uncertain
banner receives accessible focus without repeatedly stealing it on subsequent events. Text is rendered
as plain text by default, not injected site HTML. Long content has explicit paging and no silent loss.

### 13.5 Review outcome

The designer identified concrete lifecycle/API gaps, now specified above. No claim is made that current
code satisfies them. First implementation remains the bounded one-site vertical slice, followed by
offline negative-case proof and only then an authorized single live turn. Broad multi-site rollout,
multi-turn automation, automatic draft replacement and historical repair are not bundled into it.

## 14. Pressure-tested development plan — owner continuation

Owner directed continued pressure testing, development and command centralization after section 13.
Sol pressure review (`ses_e9d4e30aeffe2TMeQYCvfwEWmt`) narrowed the first build further:

1. **Unexposed lifecycle core:** one `conversation-service.mjs`, named methods, injected adapter and
   local versioned snapshot. No generic dispatch bus, new server, routes, UI edits or real browser
   actions. Implement preparation/dispatch boundaries, idempotency, restart reconciliation and safe
   finalization. Existing DOM actions are adapter integration work, not reimplemented in this module.
2. **Source integration map, read-only in parallel:** locate every CLI/API/campaign driving path,
   active-recorder guards and no-retry submission seam. No live probing needed for these questions.
3. **Reconcile and verify core:** manager inspects artifacts and runs targeted/full tests, with failures
   explicitly separated from claimed baseline issues. Review malformed journal, persistence failure,
   duplicate concurrent submission, stale binding/draft, uncertain delivery and finalization failures.
4. **Only after core review:** refactor the existing submission primitive to select one action before
   dispatch, implement shared cross-process ownership and active-session guard, then wrap the service
   through existing integration/CLI facilities. HTTP/UI exposure is blocked until legacy paths cannot
   bypass ownership. Cancellation is deferred in the first offline slice rather than implemented as
   an unsafe interruption inside compound input actions.

Verification ownership: retained Sol fixer owns core implementation and fixture tests; retained
MiniMax probe owns the read-only entrypoint map; manager owns reconciliation and final verification.
An in-process lock in the initial unexposed core proves only single-process serialization, not host-wide
exclusivity. Atomic rename without explicit file sync is insufficient for the pre-side-effect boundary.
Unknown or corrupt persisted state fails closed. Recovery never repeats preparation or dispatch.

Additional reviewed integration risks: `integration-hub.mjs:savedOnly` currently recognizes only its
injected recorder, not future conversation-owned sessions; `actions.mjs:sendMessage` may fall back to
a click after an uncertain Enter attempt. Neither hazard is solved merely by adding the new service.
Finish must retain send uncertainty even after capture resources are released. Duplicate keys are
resolved before revision rejection, but changed payloads conflict and finished conversations never
accept a fresh turn.

### 14.1 Free-model planning reconciliation

MiniMax 3.1, DeepSeek 4.1 and MiMo 2.6 completed read-only insight lanes. Manager decisions:

- Prefer shared-library CLI/API integration plus one small local process lease over requiring the CLI
  to discover a running Studio server and exchange credentials. Preserve CLI operation when Studio
  is stopped. Lease implementation must handle crashed owners without silently stealing live work.
- Reuse the existing recorder/tap/reducer. Network request bodies are conditional on
  `profile.capture.requestBodies` (`network.mjs:143`); DOM action metadata alone does not prove the
  exact prompt. First adapter must supply attributable evidence, not synthesize a digest from timing.
- Before adapter exposure, test attach-success/journal-save failure recovery: recorder ownership may
  exist before sessionId is durably saved. A future adapter needs recoverable ownership identity.
- Add positive evaluated-DOM transition coverage; current positive tests use canned evaluation values.
  Decide and test same-key replay after Finish. Reconciliation may legitimately observe a send after
  capture is finalized while capture remains incomplete; these independent states are not a bug.
- MiniMax cited old Enter/click fallback lines after the repair; disregard those stale citations.
  Existing one-dispatch code is reviewed separately. Do not implement its alternative method naming
  or create another service. No free-model finding is live verification.

## 15. Approved execution slice: usable Chat, not another framework

Owner instruction: design and implement. Implement in three non-overlapping lanes, manager validates.
No new dependencies; Bun runs existing Node test scripts. Keep all private content in local data.

- Core owns `conversation-runtime.mjs`, `drive-lease.mjs`, existing lifecycle/driver fixes and core
  tests. `createConversationRuntime({paths,profileStore,familyStore,port})` exposes async `targets()`,
  `list()`, `connect(body)`, `get(id)`, `submit(id,body)`, `reconcile(id,body)`, `finish(id,body)`, `close()`
  and synchronous `isSessionActive(id)`. `targets` returns `{sites,targets}`; `list` returns an array;
  other resource methods return a conversation snapshot. Injectable dependencies enable offline tests.
- Snapshot contract: `{id,revision,state,site,binding,sessionId,turn,reply,capture,limitations}`;
  `turn` is null or `{id,send:{state},phase}`; `reply` is `{state,source,text,chars,completion}`;
  `capture` is `{state,integrity}`. Page-read replies explicitly retain unknown network completion.
  Do not claim accepted capture without the unimplemented full evaluator. No new shape-learning loop.
- Connect body: `{site,targetId?,freshTab?}`; initially known adapters only. Submit body:
  `{key,prompt,confirm:true,expectedRevision}`. Reconcile body `{expectedRevision}`. Finish body:
  `{closeTab?:boolean}`. Submit returns after registering work; background observation updates local
  snapshots. GET never drives the website. Poll snapshots rather than adding another SSE layer now.
- Surface lane owns `conversation-api.mjs`, server/hub wiring, CLI command registration, README and
  HTTP/CLI tests. GET targets `/api/v1/conversation-targets`; list/create `/api/v1/conversations`;
  GET resource `/api/v1/conversations/{id}`; POST `turns`, `reconcile`, `finish`. Responses wrap
  `{conversation}`, `{conversations}` or target result; submit status 202. Existing auth/origin applies.
- UI lane owns `ui/chat.html`, `ui/chat.mjs` and additive nav in existing index/live/drive HTML only.
  Site/tab -> connect -> confirm single send -> poll actual source-labelled reply -> finish. No draft
  clearing, auto-resend, default-page replacement or capture-accepted claim. Designer owns visuals.
- Offline proof: core crash/duplicate/ownership tests; cross-process lease exclusion and release;
  HTTP auth/method/body/409 tests using injected runtime; UI syntax/state tests. Manager reruns all.
- Live proof follows artifact reconciliation and full offline checks. Existing unrelated suite failure
  must be diagnosed rather than silently waived. No repeated send to repair an uncertain result.

## 16. Broader upgrade: raw-first, responsive, intelligently assisted

Owner requested continued system design, streamlining, automation and Claude/ChatGPT steering.
Scope is Capture Studio plus its existing CLI/API and retained research-agent workflow, not a new
AION-wide orchestration platform. These are next design decisions, not completed implementations.

### First resolve the live evidence gap

- Current development passed 238 unit tests. Real installed-Chrome fixtures passed 11/13; both
  failing universality assertions also failed in an isolated archive of committed `f02db9f`.
- A real fresh-tab ChatGPT connection was blocked at readiness and Studio became unresponsive.
  The saved conversation has zero attempts: no typing or send occurred. The manager stopped only
  its own Studio Node process, leaving Chrome/tabs and interrupted evidence intact. This test did
  NOT establish that the new conversation path works against ChatGPT.
- The owner separately observed established ChatGPT conversations failing to fully load responses
  during scrolling. Browser interference and incomplete Studio extraction are distinct hypotheses;
  neither is explained merely by passing synthetic tests. No new authenticated experiment until
  the relevant non-interference test and responsive shutdown path are established.

### The simpler target architecture

1. **Capture stays small and responsive.** Retain L1 raw bytes/sequence/provenance as the durable
   source. Move expensive reconstruction, shape inference and full reports out of the CDP event
   callback if profiling confirms that path is starving the loop. Reuse existing reducers and
   derive; bounded preview lag must not become silent raw loss. A worker/cursor is a mechanism,
   not another server or truth store. Record processing backlog separately from capture coverage.
2. **Read is a first-class task, not a failed Send.** Observe an exact existing conversation without
   typing, clearing, navigating or restarting it. Distinguish newly received history from pre-attach
   unknown history and currently rendered text. A snapshot is not proof that virtualized older
   messages were fully loaded. Preserve source-labelled answer/history blocks and omission markers.
3. **One command vocabulary.** Connect, Read, Send, Check and Finish map to the same runtime from
   UI/API/CLI. Calibration is a batch client, not a second lifecycle/verdict authority. Remove
   duplicated status derivation as interfaces converge; retain compatibility wrappers where needed.
4. **Finish performs safe local work automatically.** Once recording is truly stopped, run existing
   integrity verification and derive in the background. Show separate capture, analysis and
   acceptance outcomes; partial analysis must not erase raw evidence or pass unknown gates.
   Do not require additional user clicks merely to run deterministic offline checks.
5. **Recover observation, never replay effects.** Health/backlog state tells the user whether the
   browser, capture, analysis or agent lane is stalled. Automatic read-only reconnect/replay can
   resume from evidence cursors; send, draft replacement and target switching never auto-replay.
   Explicit dead-owner recovery uses the existing local lease mechanism, not approval documents.
6. **Research is on demand and reusable.** Keep one retained librarian session for primary sources
   and the native Nine-Repo Harvest agent for pinned existing knowledge. Brief by question/scope/
   output, return source-linked findings, and integrate only those eliminating concrete work.
   Availability is not continuous background compute. Use existing session inboxes rather than a
   second research queue or hidden authenticated website automation.

### Model and task steering

- Sol/ChatGPT: system decisions, measured failure diagnosis, integration and evidence reconciliation.
- Claude Sonnet: interaction design, automation control flow and scoped implementation where assigned.
- MiniMax/DeepSeek/MiMo and other free options: bounded discovery/negative-test intelligence when the
  exact route actually works. Catalog listings are not capability proof; do not silently substitute
  paid models or change credentials after a routing failure. No need to spawn every listed model.
- Queue guidance at a safe boundary; read existing final text/artifacts without interrupting active
  work. Preserve native agent context. Idle or failed lanes may resume in their existing session,
  not as duplicates; lifecycle-control failures are transport failures, not successful delegation.

### Dependency-aware execution and proof

Phase A: isolate browser rendering vs Studio CPU stall using generated, unauthenticated large JSON,
SSE and virtualized-history fixtures. Measure response completeness, paint/scroll responsiveness,
event-loop lag and raw byte equality with capture off/on. Test paused-target behavior separately;
do not conflate an official CDP deadlock caveat with the current measured cause.

Phase B: implement only the proven capture-path correction; independently test that HTTP health and
Finish remain responsive while processing a large history response. Preserve complete raw replay.

Phase C: unify command/state presentation, read-only history workflow and automatic offline
finalization. Reuse native Harvest findings after pin/license/seam checks; do not transplant an
unverified donor runtime. Phase D: bounded owner-directed live proof, then expand site coverage.

Each change has one writer and one validation owner. No code lane starts against an unresolved shared
interface, and no live success is inferred from a queued agent message or a source-only finding.

## 17. Reconciliation: agent harness over real AI webapp conversations - 2026-10-23 (revised)

**Status (2026-10-23, revised): Sol source handoff is offline-tested; M1 201/201 remains an earlier synthetic receipt; M2 live follow-up is not accepted; only the candidate chat-index slice of M3 is wired; M4-M5 are not launched; no live exchange and no loaded-server proof.** Parent `bun run test` after that handoff: **1,187 passed, 0 failed, 1 existing TODO, 1,188 total** (`studio-parent-final-before-push.log`). That count covers the pre-typing cancellation fix and nine-tool registration. It is not live ChatGPT acceptance. This section reconciles
sections 12.6, 12.7, 15 and 16 with the 2026-10-23 capability assessment. It adds no new design document
or roster. Controlling order and denominators: `../ARCHITECTURE.md` (milestones M0-M5). Evidence and
gates: `LIVE-TEST.md` section 6. M1 exists as source plus synthetic tests only (see 17.3); it is not
parent-accepted and nothing here is LIVE VERIFIED.

### 17.1 Proposed routes versus source (paths under the capture-studio root)

| Route (section 12.6 name) | In source today | Milestone |
| --- | --- | --- |
| `GET /api/v1/conversation-targets` | yes, `src/capture/conversation-runtime.mjs:147-162`; origin and site only; CDP-down gives 500 | M0 (coded 503), M1 (thread reference) |
| `GET/POST /api/v1/conversations`, `GET /{id}` | yes, `src/studio/conversation-api.mjs:38-66`; **list/get may write** through `load()` recovery (`conversation-runtime.mjs:31-46`) | M1 (pure GET) |
| `POST /{id}/turns` | yes; one turn only (`src/capture/conversation-service.mjs:213`) | M2 |
| `POST /{id}/reconcile`, `POST /{id}/finish` | yes | unchanged |
| bounded transcript Read (new, narrower than 12.6 `turns/{turn}`) | **M1 source (2026-10-23):** `POST /api/v1/conversations/{id}/read` -> `{transcript}`; `runtime.read`; adapter `readTranscript`; helper `src/capture/conversation-thread.mjs`. A POST because it drives a browser observation, keeping GET snapshots purely local | M1 |
| `POST /api/v1/chat-index` | yes, candidate rendered index (`complete:false`); explicit target; not a verified thread binding | bounded M3 slice only |
| `GET /{id}/turns/{turn}`, `GET /{id}/events`, `POST /{id}/cancel` | **no**; the route regex allows only `turns|reconcile|finish` (`conversation-api.mjs:51`) | M2 (turn read, events) and M4 (stop/cancel), only if needed |

M1 deliberately adds one bounded Read instead of the whole 12.6 read surface. Section 16 item 2
("Read is a first-class task, not a failed Send") is the authority for it: observe an exact existing
thread without typing, clearing, navigating or restarting; snapshot text is not proof that virtualized
older messages were loaded, so omission markers are part of the result.

### 17.2 Decisions this assessment recommends (for the parent to confirm)

1. **Thread identity** is the URL path reference of the user's own `/c/<id>` thread, carried in the
   target row, in the stored binding and in the adapter's `check()` (today origin only:
   `src/capture/conversation-browser-adapter.mjs:87-97`, `conversation-service.mjs:33`). Titles are never
   an identity or mapping input.
2. **Do not treat removal of the old one-turn constant as live multi-turn.** The Sol handoff puts the persisted turn-owned reply and a thread-level unknown-delivery fence in source, with no automatic retries. The earlier `ONE_TURN_LIMIT` / per-conversation-fence wording, including `conversation-service.mjs:305-310`, predates that handoff. Live follow-up is not accepted.
3. **Verified fast input** replaces human pacing for conversation sends: the existing bulk insertion
   branch (`src/capture/human.mjs:205`) with composer read-back, never a second insertion. Today
   `typeText` defaults to human pacing (`src/capture/actions.mjs:185`; adapter `:195`) and the
   estimated cost (from `DEFAULT_PACE`, not measured) is about 4 minutes per 2,000 characters against a
   15-minute capture budget (`conversation-runtime.mjs:22`).
4. **Two separate concerns, not one lease:** a role registry (agent -> thread reference, by extending
   `workspace/aion/ops/chrome-relay/role-launcher/ROLES.json`) is not a connection; a **foreground writer
   lease** held only around typing/sending or an unresolved unknown delivery is not the **capture
   lifetime** (today the drive lease spans the whole capture, `conversation-runtime.mjs:249` to `:118`).
5. **Acceptance** is real use, not a ping: a meaningful SITREP request, a fresh reply correlated to that
   turn, a substantive follow-up, and no duplicate on uncertainty (gates RT-4..RT-8). No sandbox ping is
   required first; preflight, the draft check and the single dispatch are the safeguards.

### 17.3 M1 launch status and corrections (2026-10-23)

Source and synthetic tests exist for exact `/c/<uuid>` thread identity (carried target row -> stored
binding -> adapter checks, `BINDING_CHANGED` on same target+origin but another thread, never a title),
the bounded Read, pure `get`/`list` with explicit `recover`, and a coded 503 `BROWSER_UNAVAILABLE`.
Sends, human pacing, `ONE_TURN_LIMIT` and idempotency are unchanged; multi-turn is not enabled. The
compatibility decisions and receipts are listed in `../ARCHITECTURE.md` (M1 launch receipts and
compatibility decisions) and are awaiting parent confirmation.

Two earlier assumptions in this assessment were too restrictive and are corrected:

- **Read does not require an empty composer.** Read preserves a draft that is already present; it
  reports only presence and length, never the text, and does no focus, scroll, typing, clearing,
  navigation or send. (Send still requires an empty composer.)
- **The owner need not launch the browser.** The sign-in to the team workspace is the user's, but the
  local executor may start the dedicated-profile Chrome with the existing Studio launcher
  (`studio launch` / `studio start`), which reuses that profile and must not delete or reset it.

Role registry boundary: the tracked `ROLES.json` keeps non-sensitive identities only; real thread
references live in a local private binding outside Git. Its null URLs mean "unverified in that
registry", not "no team threads exist". Studio workstream identities (Core, UI, QA, Systems) are valid
lane conversations even though they are not among the 13 canonical agents.

### 17.4 Evidence boundaries

- The 168 conversation tests used injected fake adapters; they say nothing about ChatGPT or about the
  running server. The 17:44 UTC live observations (server health 200, no browser on port 9222,
  `conversation-targets` returning 500) are that time only. Later Chrome/login facts are in 17.5.
  The parent 1,187-pass suite does not prove a loaded server.
- The unfinished local conversation snapshot (0 attempts, capture `recording`) matches the earlier
  blocked-readiness attempt described in section 16 (inferred from the state and date, not re-read).
  It is not evidence that a send works.
- ChatGPT session population counts disagree by denominator (27 by site label, 26 by target host,
  15 sidecars absent, 12 stored `capture_rejected`, 0 accepted); see `../ARCHITECTURE.md`. Do not report
  a single accepted total.

### 17.5 Architecture correction: product frame and revised milestones (2026-10-23)

The product is an **agent harness whose sessions are real AI webapp conversations** (ChatGPT first), not
API sessions; the AION team is the first workload, not the boundary. The full visible surface (chat list,
search, projects, workspaces; open, create, resume, switch, rename, archive, delete; model and mode;
attachments, tools, artifacts; stop, edit, regenerate, branch; context, scheduling; recovery) is the
destination. The compact families table, the harness identities and the surface rules live once in
`../ARCHITECTURE.md` and are not repeated here. Command Space ids are catalog vocabulary
([README](../../../../../../../ops/command-space/README.md),
[capability universe](../../../../../../../ops/chrome-relay/harvest/external/reference/capability-universe.csv)):
**a catalog entry is not an implementation**, and evidence, availability, effect class and coverage stay
separate.

Revised milestone labels (replacing the earlier M0-M5 wording in 17.1-17.4 where they differ): **M0**
harness contract + launch/readiness; **M1** exact existing-thread Read; **M2** integrated useful SITREP +
follow-up through the actual bridge from this agent session (durable turn-owned reply, thread-level
unknown fence, verified fast input); **M3** discovery, search, navigation, create, rename, model and
context; **M4** rich surface + team workload (the 13 roles, local private bindings); **M5** scheduling +
recovery. The earlier "M3 SITREP", "M4 13 roles" and "M5 restart" correspond to the new M2, M4 and M5.

Rules this correction adds:

- **Open targets are not the account chat list.** `conversation-targets` lists live tabs; the sidebar is a
  partial rendered index (virtualized), and a full scrape is not a prerequisite for the first useful
  exchange.
- **Default route is the actual UI** through the existing adapter. Observing a private backend endpoint is
  not permission to replay authenticated requests.
- **Read semantics.** A Read returns the messages currently rendered, including ones that predate the connection; earlier *network traffic* was not captured, which is a different fact (`coverage.preAttachHistory` is about network capture, not DOM omission), and unloaded history is reported by `olderHistory` / `newerHistory`. "Read changes no file" means the Read itself; the attached recorder writes its own raw log and autosnapshots independently.
- **Network completion is network-only.** Page readiness is a separate attributed state: exact thread,
  delivered user turn, reply turn after the pre-send boundary, stable idle controls, then a fresh preflight
  before the next action. Quiet text or an observed reply is not readiness.
- **Live facts are time-scoped.** 18:24:48 UTC: the dedicated Studio Chrome (pid 20048) runs with CDP on
  9222 connected (parent verified); the DOM gate says LOGIN REQUIRED (human). The 17:44 and 18:22 UTC
  no-browser facts described those times only. A 503 in source is not M0 until observed from a loaded
  runtime. Ordinary launch and owned server refresh need no extra approval.
- **Identity.** Thread, project, workspace, account scope, role binding and browser attachment are
  distinct; private role-thread URLs stay local and untracked (never in `ROLES.json`).
- **Sol source handoff (offline):** durable thread journal/M2 integration, exact-thread read/connect, candidate chat-index POST, pre-typing cancellation fix, and nine Studio conversation tools via `bun run -- node bin/studio.mjs tools ...` on the same injected runtime, with no automatic retries. Focused evidence: cancellation 87/87 at 19:17:37–19:17:51Z; tools 42/42 at 19:23:26–19:23:41Z. Parent full suite after those changes: **1,187 pass / 0 fail / 1 existing TODO / 1,188 total** (`studio-parent-final-before-push.log`). That run covers the cancellation fix and nine-tool registration. The 1,126-pass and 1,176-pass logs, and the Chat UI 107/107 then 57 counts, predate this handoff. No server refresh or live send. Dedicated Studio Chrome and LOGIN REQUIRED were observed at 18:24:48 UTC; current login and whether the running runtime loaded this source are unverified. Nothing here is LIVE VERIFIED or a live multi-turn acceptance. The original five owner files stay excluded. `vivim-final` is owner-owned and eligible for reuse; deeper UI/sync/slave-profile lanes were cancelled for Claude credit before completion, which is not a completed assessment and not a reuse ban.