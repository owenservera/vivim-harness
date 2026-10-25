# Capture Studio — live test runbook (Windows PowerShell)

**Subordinate to [../ARCHITECTURE.md](../ARCHITECTURE.md).** That file is the only governing vision. Gates here measure that vision; they do not redefine it.

> **Current local-first handoff (2026-10-22):** Run [CORE L0/L1 handoff](CORE-LOCAL-HANDOFF-2026-10-22.md) before the older manual examples below. The legacy security notes describing mandatory token login, default credential redaction and human-key pacing no longer match the current local-raw/tokenless source. Use current source and `docs/LOCAL-FIRST.md` for defaults. The CORE handoff runner creates local evidence packets; it does **not** execute on your PC merely because it was committed.
>
> **Agent harness over real ChatGPT conversations (2026-10-23; AION team = first workload):** the dated capability assessment and the real-use acceptance gates RT-0..RT-9 are in [section 6](#6-agent-harness-over-real-chatgpt-conversations-assessment-and-acceptance-gates-2026-10-23). **No gate there is LIVE VERIFIED yet.** Section 6.6 records the revised product frame and milestones.

A real, end-to-end test of the capture studio on a local Windows machine: from environment check
through a live capture, derivation, search, replay mirror, export, integrity verification and the
studio web UI.

Every command below is run from the **capture-studio root** (the folder that contains
`bin/studio.mjs`).

## 1. Prerequisites

| Requirement | Detail |
| --- | --- |
| Node.js | **>= 22** — the built-in `WebSocket` client is required. Verify with `node --version`. |
| Runtime | Use **`node`** for every command in this runbook. The project has **no runtime dependencies** and **no `npm install` step**; `bun` is not required and is not used here. |
| Chrome | Google Chrome (or Edge) for the capture browser. Auto-detected. Override with `$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"`. |
| Shell | PowerShell (Windows PowerShell 5.1 or PowerShell 7+). |
| Disk | The data directory holds raw captures in plain text — size it accordingly. |

### Data directory

Default: `%LOCALAPPDATA%\AION\capture-studio` (verified here as
`C:\Users\<user>\AppData\Local\AION\capture-studio`). Override with the `CAPTURE_STUDIO_HOME`
environment variable or the global `--data-dir` flag. Print the resolved layout with:

```powershell
node bin/studio.mjs paths
```

Layout: `sessions/` (one directory per recording), `profiles/`, `families/`, `learner/`,
`chrome-profile/` (the dedicated capture profile), `exports/`, `config.json`.

## 2. Safety notes

- **Loopback only.** The capture browser binds DevTools to `127.0.0.1`; the studio server refuses
  any non-loopback bind; the replay mirror serves on loopback only. Do not port-forward or expose
  these ports.
- **Authentication.** The studio prints a **tokenized URL**; the token is exchanged for an
  `HttpOnly`, `SameSite=Strict` cookie. Requests must carry that cookie or an `x-studio-token`
  header, and `Host`/`Origin` must be `127.0.0.1:<port>` or `localhost:<port>`. Do not share or
  paste the tokenized URL into issues.
- **Redaction defaults.** Cookie and auth headers are dropped, auth endpoints are recorded
  metadata-only, in-body tokens are masked in place, and every mask is recorded on its chunk. This
  is a default policy, not a guarantee — run `node bin/studio.mjs scan <file>` (exit code 4 when a
  credential is found) on any file you intend to publish.
- **Do not capture authenticated sessions you cannot store.** Raw bytes land unencrypted in the
  data directory. Use a dedicated Chrome profile (`studio launch`) with its own sign-ins, and only
  capture sites you are authorized to use.
- **Private content.** Captures are private transcripts. Do not commit them; the data directory is
  outside the repository by default.

## 3. Step-by-step

> **Automated first pass (run these before the manual steps):**
>
> ```powershell
> node bin/studio.mjs selftest            # preflight: imports, data dir, Chrome, Studio API (add --json)
> node scripts/live-e2e.mjs               # full loop against a local fixture site (add --no-browser to skip Chrome)
> node scripts/human-check.mjs            # typing harness on a local file:// fixture (add --json)
> ```
>
> `selftest` exits 0 when every required check passes; the `cdp-endpoint` check is informational and
> fails when no capture browser is running on the CDP port. `live-e2e` isolates its data directory
> (`CAPTURE_STUDIO_HOME` under the temp folder) and writes `live-e2e-result.json` there.
>
> `human-check` writes a data-only fixture page into the OS temp directory, opens it as a `file://`
> tab, types a sentence into a plain input and into a `contenteditable`, and checks nine properties
> of the typing: one insert per character, the exact text in both fields, one key sequence per
> character, no key gap under 15 ms, `navigator.webdriver === false`, focus present, and a user
> agent without `HeadlessChrome`. It touches no website. Exit 0 = all nine pass, 1 = a check failed,
> 2 = no DevTools endpoint on the port or the module is missing. A failure means the interaction
> layer changed behaviour — do not drive a real site until it passes again; see
> [HUMAN-INTERACTION.md](HUMAN-INTERACTION.md).
>
> Then look at what the driver *would* do, before spending an account on it:
>
> ```powershell
> node bin/studio.mjs drive chatgpt --dry-run     # resolved adapter, target URL, prompt, limits
> node bin/studio.mjs campaign                    # plan only: the nine sites in order, no interaction
> ```
>
> The steps below repeat the same flow by hand against a real site. `drive` and
> `campaign --execute` are the automated equivalents (drive, derive, build the site family) and are
> documented in [HUMAN-INTERACTION.md](HUMAN-INTERACTION.md).

### Step 0 — Environment pre-check

```powershell
node bin/studio.mjs doctor
```

**Expected:** exit code 0 and an `ok` report for `node`, `chrome`, `data-dir`, `sessions`,
`learner`, `config`; a `warn` for `devtools` is normal before the capture browser is running.

```powershell
node bin/studio.mjs doctor --json      # machine-readable form — keep this as the failure receipt
node --test "test/unit/**/*.test.mjs"  # unit tests, no browser needed
```

**Expected (tests):** all tests pass.

**If it fails:** capture the full stderr plus `node bin/studio.mjs doctor --json` output.
`doctor --fix` prints the suggested fix for every non-ok check.

### Step 1 — Launch the capture browser (Chrome + CDP)

```powershell
node bin/studio.mjs launch
node bin/studio.mjs targets
```

**Expected:** a separate Chrome window using its own profile; `targets` lists the tabs that can be
recorded (empty is fine before you open a page). Sign in to the site **inside that window** — the
profile persists between runs.

**If it fails:** capture stderr and `doctor --json` (the `chrome` check prints the detected binary
and the `devtools` check prints the expected endpoint, default `127.0.0.1:9222`).

### Step 2 — Live capture

```powershell
node bin/studio.mjs capture https://example.com --live --tabs all --follow
```

**Expected:** live decoded text/events streamed to stdout, then a result row with the new session
id. The page is reloaded once after attaching so connections opened during load are observed.
Stop early with `--duration <SECONDS>`; `--idle <SECONDS>` and `--timeout <SECONDS>` bound the run.

**If it fails:** capture stderr and `doctor --json`. Re-run with `--json` to separate progress
output from data.

### Step 3 — Derive

```powershell
node bin/studio.mjs derive latest --full
node bin/studio.mjs derive --missing --json
```

**Expected:** datasets, shapes, model, graph and the metadata receipt are rebuilt from the raw log
(`--full` forces every stage instead of reusing incremental artifacts); `--missing` covers every
saved session without a complete receipt.

**If it fails:** capture stderr and `doctor --json`.

### Step 4 — Search the derived corpus

```powershell
node bin/studio.mjs kb search example
node bin/studio.mjs kb search example --site example.com --layers entities,dom --json
```

(`kb` is the alias for `knowledge`; `studio help knowledge search` lists all options.)

**Expected:** a ranked table of hits with their source layer.

**If it fails:** capture stderr and `doctor --json`; confirm the session actually derived in
Step 3 (`node bin/studio.mjs session show latest`).

### Step 5 — Replay mirror

```powershell
node bin/studio.mjs mirror routes latest
node bin/studio.mjs mirror serve latest --port 8787
```

**Expected:** `mirror routes` lists the recorded routes; `mirror serve` binds a loopback HTTP server
and prints the URL. Open the printed URL (or a listed route path) in a browser and confirm the
captured response is replayed. Add `--speed 4`, `--instant` or `--synthesize` to change playback.
Press `Ctrl+C` to stop the server.

**If it fails:** capture stderr and `doctor --json`. Verify the port is free — `--port 0` selects a
free port automatically.

### Step 6 — Export

```powershell
node bin/studio.mjs export dataset latest --dataset events --format jsonl --out events.jsonl
node bin/studio.mjs export transcript latest --out transcript.md
node bin/studio.mjs export schemas latest --out schemas.json
node bin/studio.mjs export report latest --out report.html
```

**Expected:** each command writes its file (default output folder is
`<data-dir>/exports/<session>`; `-` writes to stdout). `export schemas` emits a draft-2020-12 JSON
Schema bundle; `export report` emits a single-file HTML report.

**If it fails:** capture stderr and `doctor --json`.

### Step 7 — Integrity verification

```powershell
node bin/studio.mjs integrity build latest
node bin/studio.mjs integrity verify latest
```

**Expected:** `integrity verify` exits 0 when the directory matches its `MANIFEST.json`; it exits 4
when it does not. `integrity verify ./some-dir --json` verifies any directory, not only a session.

**If it fails:** capture stderr, the exit code and `doctor --json`.

### Step 8 — Studio web UI (`/live/view` and `/platform`)

```powershell
node bin/studio.mjs start
```

**Expected:** the capture browser opens and the studio UI starts; a **tokenized URL** is printed.
Open it in the browser, then visit:

- `http://127.0.0.1:7878/live/view` — the minimal live text viewer (SSE of live-tap events).
- `http://127.0.0.1:7878/platform` — the platform page.

The UI is also reachable through the versioned API (`GET /api/v1/...`), and the optional
`/api/x/*` routes (`/api/x/stats`, `/api/x/registry`, `/api/x/autodetect`, `/api/x/csv`,
`/api/x/bench`, `/api/x/graph/{id}`, `/api/x/dedupe/{id}`, `/api/x/keyphrases/{id}`).

Use `node bin/studio.mjs serve` to run the UI only, without opening the capture browser.

**If it fails:** capture the browser console, stderr and `doctor --json`. Confirm the tokenized URL
was used (the cookie exchange must happen first).

### Step 9 — Read-only analysis commands (optional extra)

```powershell
node bin/studio.mjs detect events.jsonl --json
node bin/studio.mjs scan events.jsonl
node bin/studio.mjs csv events.csv
node bin/studio.mjs dedupe latest --threshold 0.8 --json
node bin/studio.mjs kb graph-stats latest
node bin/studio.mjs kb keyphrases latest --limit 10
node bin/studio.mjs platform stats
node bin/studio.mjs platform registry
```

**Expected:** each command prints its analysis; `scan` exits 4 if a credential is found
(exit 0 otherwise), `detect`/`csv` summarise the input, `dedupe` lists duplicate or near-duplicate
records, `graph-stats` prints PageRank/community statistics, `keyphrases` prints ranked phrases.

**If it fails:** capture stderr and `doctor --json`.

### Step 10 — MCP stdio server (optional extra)

```powershell
node src/mcp/server-stdio.mjs
```

**Expected:** the server logs `stdio server ready` on **stderr** and speaks newline-delimited
JSON-RPC 2.0 on **stdout** (`initialize`, `tools/list`, `tools/call`, `resources/list`,
`resources/read`). Stdout must contain JSON-RPC only — never redirect it to a file that also
receives logs.

## 4. Results checklist

| # | Step | Command | Expected | Result | Failure receipt captured |
| --- | --- | --- | --- | --- | --- |
| 0 | Environment | `studio doctor` | exit 0, node/chrome ok | ☐ pass ☐ fail | ☐ |
| 0b | Unit tests | `node --test "test/unit/**/*.test.mjs"` | all pass | ☐ pass ☐ fail | ☐ |
| 1 | Capture browser | `studio launch` + `studio targets` | Chrome window; tabs listed | ☐ pass ☐ fail | ☐ |
| 2 | Live capture | `studio capture <url> --live --tabs all --follow` | live text + session id | ☐ pass ☐ fail | ☐ |
| 3 | Derive | `studio derive latest --full` | datasets/model/graph/receipt rebuilt | ☐ pass ☐ fail | ☐ |
| 4 | Search | `studio kb search <term>` | ranked hits | ☐ pass ☐ fail | ☐ |
| 5 | Mirror | `studio mirror routes latest` + `mirror serve latest` | routes listed; replay serves in browser | ☐ pass ☐ fail | ☐ |
| 6 | Export | `studio export dataset/report/schemas/transcript` | files written | ☐ pass ☐ fail | ☐ |
| 7 | Integrity | `studio integrity build latest` + `verify latest` | exit 0 | ☐ pass ☐ fail | ☐ |
| 8 | Studio UI | `studio start` → `/live/view`, `/platform` | both pages render | ☐ pass ☐ fail | ☐ |
| 9 | Analysis | `detect`/`scan`/`csv`/`dedupe`/`graph-stats`/`keyphrases`/`platform stats` | each prints analysis | ☐ pass ☐ fail | ☐ |
| 10 | MCP | `node src/mcp/server-stdio.mjs` | `stdio server ready` on stderr | ☐ pass ☐ fail | ☐ |

**For every failed step, attach:** the exact command, the full stderr, the exit code, and
`node bin/studio.mjs doctor --json`.

## 5. Cleanup

```powershell
node bin/studio.mjs session list
node bin/studio.mjs session delete <id> --yes
node bin/studio.mjs session prune --older-than 7d --keep 5 --yes
```

Bulk prune is a dry run without `--yes`. Raw capture bytes stay in the data directory until the
session is deleted.

## 6. Agent harness over real ChatGPT conversations: assessment and acceptance gates (2026-10-23)

**Status (2026-10-23, revised): Sol source handoff is offline-tested; no live exchange.** Sections 6.1-6.3 are the point-in-time assessment (read at HEAD `ea446783`, before the M1
edits); their source line numbers were re-pointed to the post-M1 tree. Section 6.5 records the M1 launch and
section 6.6 the revised product frame and milestones. Nothing in this section is a live result. The durable thread journal, exact-thread read/connect, candidate chat-index POST, pre-typing cancellation fix and nine Studio tools are source plus offline tests, not RT-gate passes. M4-M5 are not launched. M1 is **not
accepted** until the live gates RT-0..RT-3 pass, and M2 is **not accepted** until RT-4..RT-7 pass. Parent `bun run test` **1,187 passed, 0 failed, 1 existing TODO, 1,188 total** (`studio-parent-final-before-push.log`) covers the cancellation fix and nine-tool registration only. It is not loaded-server proof. Source anchors below are relative to the capture-studio root and were
read at repo HEAD `ea446783` on 2026-10-23 (working tree had five unrelated uncommitted files owned
by others; none was touched).

**Goal:** Capture Studio is an agent harness whose sessions are real AI webapp conversations instead of
API sessions; the AION team is the first workload, not the boundary. The first useful exchange: discover
the exact thread, attach, read what is visible, send one meaningful prompt, receive a fresh reply
correlated to that prompt, send a follow-up, and never send a duplicate when delivery is uncertain.

Evidence labels used here: **PRESENT SOURCE** (code exists) · **TESTED SYNTHETIC** (unit or fixture
tests with injected fakes) · **LIVE VERIFIED** (observed against the real site on the owner PC) ·
**MISSING / UNKNOWN**.

### 6.1 Commands run and observed results (read-only; UTC)

All times 2026-10-23 UTC. No attach, capture, send, reconcile or browser action was performed.

| UTC | Command | Observed |
| --- | --- | --- |
| 17:44:39 | `GET http://127.0.0.1:7878/api/v1/health` and `GET /api/status` | 200. Recorder idle; `chrome: null` (no CDP browser; nothing listening on 9222). |
| 17:44:54 | `GET /api/v1/conversation-targets` | **HTTP 500 `{"error":"fetch failed"}`** (browser unreachable is reported as an internal error). |
| 17:44:54 | `GET /api/v1/integrations/tools` | 200; 34 tools, none about conversations. |
| 17:45:21 | `GET /api/v1/sessions` (paged, 107 total) | 27 ChatGPT-site sessions: 25 `complete`, 2 stuck `recording`. URL shape of their targets: 15 `/`, 11 `/c/<uuid>`, 1 blank. Exactly one session carries `conversationOwner`. |
| 17:45:33 | `GET /api/sessions/{id}/acceptance`, `/join`, `/knowledge-status` for those 27 | acceptance `unassessed` 27/27; join `no_dom_turns` 12, `not_derived` 15; knowledge `complete` 15, `legacy-unverified` 12. |
| 17:45:36 | `GET /api/v1/openapi.json`; `GET /chat` | 52 paths, **0** conversation paths; `/chat` serves 200. |
| 17:45:55 | `node --test` on `test/unit/conversation-service`, `conversation-runtime`, `conversation-api`, `send-once`, `chat-ui`, `drive-lease` | **168 tests, 168 pass, 0 fail** (Node v24.22.1; injected adapters, no browser). |
| (file read) | local conversation snapshot directory, state fields only | One unfinished snapshot from 2026-10-22: state `blocked`, 0 attempts, capture `recording`, finish `idle`. |
| (file read) | local campaign state, status fields only | ChatGPT entry `failed` (2026-10-22): the one-shot drive got a 72-character reply containing all 12 expected words, but the gate marked it failed. This was the old drive path, not the conversation runtime. |

**Do not call `GET /api/v1/conversations` or `GET /api/v1/conversations/{id}` as a "harmless read"
on a Studio that restarted with an unfinished snapshot.** `load()` runs recovery and calls `save()`
(`src/capture/conversation-runtime.mjs:31-46`, `src/capture/conversation-service.mjs:128-149`); the
F7 test in `test/unit/conversation-runtime.test.mjs` documents that `load()` can rewrite the file.

### 6.2 Capability by user-flow step

| Step | PRESENT SOURCE | TESTED SYNTHETIC | LIVE VERIFIED | MISSING / UNKNOWN |
| --- | --- | --- | --- | --- |
| Discover exact team targets | `targets()` `src/capture/conversation-runtime.mjs:147-162` | yes | no | Rows hold only origin and site (`title: a.id`, line 138). No conversation id, project or workspace notion anywhere in `src/`. CDP-down gives 500. |
| Connect / attach | `connect` `conversation-runtime.mjs:220-266`; `src/capture/conversation-service.mjs:156-192`; `src/capture/conversation-browser-adapter.mjs:110-150` | yes (F3/F4, owner tests) | **no** | Binding is `{targetId, origin}` only (`conversation-service.mjs:33`, adapter `check()` lines 78-85). A change of thread inside the same tab is not detected. |
| Historical + fresh capture | recorder starts at attach; DOM agent; raw/derived layers | synthetic | old one-shot sessions only | Connections opened before attach are invisible. Join linked 0 of 60 real ChatGPT turns (old extractor); the new extractor is untested on the real page (`ARCHITECTURE.md` section 6). |
| Decode / correlate user and reply turns | `readUserTurns` adapter lines 15-24; `observation` lines 96-109; join `src/intel/join.mjs` | synthetic | no | Reply ownership per turn not built; reply is page text, completion always `unknown` (`conversation-service.mjs:305-310`). |
| Read back into the calling agent | `GET /api/v1/conversations/{id}` returns reply text; legacy `/api/sessions/:id/{turns,dom,events}` in `src/studio/server.mjs:188-262` | UI and API tests | no | Polling only; no transcript, per-turn, events or cancel routes (`src/studio/conversation-api.mjs:51` regex). Event feed binds the server-level recorder, not the conversation recorder (`src/studio/integration-hub.mjs:27`). Replay of an active session returns 409 (`:46`). |
| Compose / submit one real prompt | `submit` `conversation-service.mjs:194-262`; adapter `type`/`submit` lines 196-219 | yes | **no** | `typeText` defaults to human pacing (`src/capture/actions.mjs:185`; adapter line 195). The bulk `insertText` path exists (`src/capture/human.mjs:205`) but is not used here. |
| Observe acceptance / finish / errors | phases and coded reasons in `conversation-service.mjs`; `waitForCompletion` `actions.mjs:708` | yes | no | Network completion unknown; site error banners only checked at readiness. |
| Multi-turn | none | n/a | n/a | Blocked by design: `ONE_TURN_LIMIT` (`conversation-service.mjs:213`). Listed as Core P0 in `workspace/aion/ops/capture-studio-core/CONTINUOUS-QUEUE.md`. |
| Team role mapping | `workspace/aion/ops/chrome-relay/role-launcher/ROLES.json` fields `session_url` / `session_url_status` | n/a | no | 8 roles dated 2026-10-16 (13 core agents now); all URLs null, `UNKNOWN_UNTIL_ACTUAL_SESSION` - i.e. unverified in that registry, **not proof that no real team threads exist**. Not connected to Studio. Privacy boundary: the tracked roster holds non-sensitive identities only; real thread references belong in a local private binding outside Git. Studio workstream identities (Core, UI, QA, Systems) are valid lane conversations although not among the 13 canonical agents. |
| Reconnect / replay / stop | idempotent replay by key (`:198`), restart recovery, `finish` (`:321-344`), lease release (`conversation-runtime.mjs:102-145`) | yes | no | Stale state exists: 2 ChatGPT sessions stuck `recording`, 1 unfinished snapshot. |
| Privacy / persistence / navigation | local data dir; list view strips reply bodies (`conversation-runtime.mjs:63`); `/chat` links to the saved session | yes | n/a | Issue #64 open; local raw capture may retain credentials. All 27 ChatGPT sessions are `unassessed`. |

### 6.3 Gap list (priority order)

*Status after the M1 backend (2026-10-23, source + synthetic tests only): gaps 1, 2, 7, 8 and the
transcript half of 5 have source; 3, 4, 6, 9, 10 and the rest of 5 remain open. Wording below is the
original assessment.*

1. **Thread identity is not part of the binding** (origin-only) — a send could land in another thread.
2. **Targets carry no conversation reference or real title.**
3. **One turn per conversation** (`ONE_TURN_LIMIT`); multi-turn needs turn-owned reply correlation and must keep the no-replay rule for uncertain sends.
4. **Human-paced typing on every prompt.** Estimated from `DEFAULT_PACE` (`human.mjs:19-24`), not measured: about 4 minutes for 2,000 characters and about 40 minutes for 20,000. The conversation budget is 15 minutes (`conversation-runtime.mjs:22`); finishing mid-typing leaves a partial draft.
5. **No transcript / per-turn / events / cancel readback**; the API is not in the OpenAPI document or the tool manifest.
6. **No role-to-thread registry** in Studio.
7. **GET list/get can write** (recovery `save()`).
8. **Wrong error class** for browser-unreachable (500 instead of a coded 503).
9. **Never live verified:** the conversation runtime has completed no real exchange; real-page extractor effect, join 0/60, and Claude reply mapping are open.
10. **Stale recordings and snapshots** need an inspect/recover path.

### 6.4 Real-use acceptance gates (RT-0..RT-9)

These are the gates for calling the goal done. They are separate from the G1-G7 capture-acceptance
gates in `src/capture/acceptance.mjs`. Record a gate only with an observed result and a UTC time.
Receipts hold counts, hashes and masked URL shapes — **never** conversation text, thread URLs,
session ids or tokens. There is **no required sandbox ping first**: the first send is the real
request below, because the guards (preflight, draft check, one dispatch) are what make it safe.

| Gate | Pass condition | Negative / abort condition | Today |
| --- | --- | --- | --- |
| RT-0 Preconditions | The Studio's dedicated-profile Chrome is running and signed in to the team workspace (the sign-in is the user's; the local executor may start the browser with the existing Studio launcher, `studio launch` / `studio start`, which reuses the profile and does not reset it); Studio up; `conversation-targets` returns 200; repo HEAD and server build recorded. | CDP down must return a coded 503, never 500; a server built from a different tree is recorded as UNKNOWN. | MISSING (500 observed) |
| RT-1 Exact target | The intended role thread is selected by conversation reference (not origin) and matches the role registry. | A tab on another thread or an unmatched role must not be selectable. | MISSING |
| RT-2 Attach, no send | Connect to the exact existing `/c/<id>` tab; identity `bound`; session id exists; zero sends. A draft already present does not stop attach or Read (it only blocks a later send). | A non-thread path is `unverified` (no send, no Read); auth wall or binding change gives a coded block and nothing is typed. | SOURCE + TESTED SYNTHETIC (M1); not live |
| RT-3 History readback | Bounded `POST .../read` of the turns currently rendered on the page (including ones that predate the connection) returns the right turn counts (and a hash) without sending; a draft in the composer is preserved and only its presence/length is reported; coverage lists omissions and never claims completeness. | The Read operation itself writes no file, conversation snapshot or raw-log record and does not focus, scroll or change the page (a recorder attached to that page keeps running and may write its own raw log and periodic STATE/SHAPES autosnapshots independently, so compare the conversation snapshot file and the Read's own effects, not every file in the session directory); a thread switch during the Read gives `BINDING_CHANGED` and no data. | SOURCE + TESTED SYNTHETIC (M1); not live |
| RT-4 Real SITREP request | A meaningful SITREP request for that role (not a ping) is typed in full and sent exactly once; response is 202 with a turn id. | A long prompt must not exceed the duration budget or leave a partial draft. | PRESENT SOURCE / TESTED SYNTHETIC (human pacing risk) |
| RT-5 Fresh correlated reply | The reply read back here belongs to this turn (new assistant turn after the pre-send boundary, not stale DOM); completion state is recorded honestly. | Old page text, another stream, or the prompt itself must never be returned as the reply. | PRESENT SOURCE (page text only) |
| RT-6 Follow-up | A second prompt in the same conversation gets its own correlated reply. | The first reply must not satisfy the second turn. | SOURCE journal fence offline; not a live follow-up |
| RT-7 No duplicate on uncertainty | If delivery is uncertain the state becomes `needs-reconciliation`; the same key replays read-only; a new key is refused; read-only reconcile resolves it; the thread shows exactly one copy of the prompt. | No automatic resend by any path. | TESTED SYNTHETIC |
| RT-8 Stop / reconnect | `finish` stops capture and the session verifies; a Studio restart recovers the snapshot without replaying an action; the lease is released. | A failed stop keeps the lease and is reported, not hidden. | TESTED SYNTHETIC |
| RT-9 Privacy and navigation | Raw data stays in the local data directory outside Git; the UI links from the conversation to the saved session; receipts are minimized. | Any private text, URL or id in a repo file fails the gate. | PRESENT SOURCE |

**Ordered path in `ARCHITECTURE.md` (revised 2026-10-23):** M0 harness contract + launch/readiness ->
M1 exact existing-thread Read -> M2 integrated useful SITREP + follow-up through the actual bridge from
this agent session -> M3 discovery, search, navigation, create, rename, model and context -> M4 rich
surface + team workload -> M5 scheduling + recovery. The gates above map as: RT-0 = M0; RT-1..RT-3 = M1;
RT-4..RT-7 = M2; RT-8 = M5; RT-9 throughout (M3 and M4 add their own gates when launched).
The old one-turn constant is not a live multi-turn pass; section 6.6 records the offline journal fence.

**M1 slice record:** M1 left sends, human pacing and the then-current single-turn limit unchanged. Scope: the
thread reference (URL path of the user's own existing `/c/<id>` thread, never an inferred title) in
targets, the stored binding and the adapter check; one bounded source-labelled transcript Read; pure
GET; coded 503 for browser-unreachable. Acceptance: two-thread fixture lists distinct references; a
switch to the other thread blocks type and submit with `BINDING_CHANGED`; CDP down gives 503; a GET on
an unfinished snapshot leaves file bytes unchanged; the existing 168 tests still pass; then live
RT-0..RT-3 with counts only and no send.

**Receipts at true strength.** The 168 tests (and the parent's later 201/201) used injected fake
adapters, which say nothing about ChatGPT. The live facts are time-scoped: at 17:44-18:22 UTC server
health 200, no browser on port 9222 and `conversation-targets` HTTP 500; at 18:24:48 UTC the dedicated
Studio Chrome (pid 20048) is running with CDP 9222 connected (parent verified) and the DOM gate reports
LOGIN REQUIRED. No gate is LIVE VERIFIED. The later parent suite (1,187/0/1, log
`studio-parent-final-before-push.log`) and the focused cancellation 87/87 and tools 42/42 runs are
offline injected-runtime evidence. They do not move any RT gate to LIVE VERIFIED and do not prove the
running server loaded that source. Current login remains unverified. No server refresh or live send
was part of that checkpoint.

**Population denominators (do not quote one accepted total).** Session counts for ChatGPT disagree by
denominator, and `capture_accepted` is 0 under all of them:

| Denominator (2026-10-23, read-only) | Count | Acceptance reading |
| --- | --- | --- |
| API sessions, site label `chatgpt` / `chatgpt.com` | 27 (26 with a ChatGPT target host + 1 blank-target session still `recording`) | acceptance endpoint: `unassessed` 27 of 27 |
| Oracle file inventory, ChatGPT origins | 26 | 15 without acceptance sidecar, 11 `capture_rejected` |
| Sidecar check of the 27 | 27 | 15 absent, 12 stored `capture_rejected` (11 + the blank-target session, by subtraction) |

The API says `unassessed` where the sidecar says `capture_rejected` because `readAcceptance` fails
closed when a stored document no longer binds to current evidence; all 12 stored sidecars lack a
DOM_TURNS digest (`src/capture/acceptance.mjs:351`). Stored verdict and re-verifiable verdict are
different questions; the discrepancy is recorded here, not resolved into one total.

### 6.5 M1 launch status (2026-10-23) and the next runtime gate

**M1 backend is launched as source plus synthetic tests; it is not accepted and not live.** Changed
backend files (capture-studio root): `src/capture/conversation-service.mjs`,
`src/capture/conversation-runtime.mjs`, `src/capture/conversation-browser-adapter.mjs`,
`src/studio/conversation-api.mjs`, and the new helper `src/capture/conversation-thread.mjs`. New tests:
`test/unit/conversation-thread.test.mjs` (29) and `test/unit/conversation-read-api.test.mjs` (4).
`test/unit/conversation-runtime.test.mjs` changed in four places only (existing-tab fixture URL is now a
`/c/<uuid>`; three tests call the explicit `recover` because `get` no longer recovers).

| UTC (2026-10-23) | Command (cwd = capture-studio root) | Result |
| --- | --- | --- |
| 18:08:01 | `node --test` on the two new files before any implementation | red: helper module missing (tests written first) |
| 18:11:58 | same two files after implementation | 33 pass, 0 fail |
| 18:13:38 | six existing focused files (service, runtime, api, send-once, chat-ui, drive-lease) | 168 pass, 0 fail (after the four test edits above) |
| 18:14:05-18:14:59 | `bun run test` (runs `node --test "test/unit/**/*.test.mjs"`; Node v24.22.1, Bun 1.4.2) | 1052 tests, 1051 pass, 0 fail, 1 pre-existing todo |

These are injected-fake results: no browser, no CDP, no network, no real ChatGPT page. The running
Studio process was started before these edits and does not run this code until it is restarted; the
earlier warning about `GET /api/v1/conversations` therefore still applies to it. The page selectors used
by the in-page reader are unverified on the real ChatGPT DOM; coverage reports rendered counts only and
never claims a complete thread. Compatibility decisions awaiting parent confirmation:
`ARCHITECTURE.md` "M1 compatibility decisions".

**M0 is not complete because code is on disk.** The coded 503 counts only when it is observed from a
loaded runtime: the server restarted from the reconciled tree (after the writers are reconciled and the
tests pass) and the live responses recorded. As of 18:22:34 UTC nothing listens on port 9222. Launch only
through the Studio launcher (`bun run studio -- launch`, profile `<data-dir>/chrome-profile`, a real
directory); do not use `scripts/chrome-cdp.ps1` with its default `%LOCALAPPDATA%\chrome-cdp-profile`,
which is a junction here (reported to resolve to the default Chrome profile). A normal Chrome with no
DevTools port cannot be attached.

**Exact next runtime gate (RT-0 then RT-1..RT-3, zero sends).** Restart Studio from the reconciled tree
and record the build. With the dedicated-profile Chrome up (the local executor may start it with
`studio launch`; the sign-in is the user's) and the user's own `/c/<id>` thread open: (a)
`GET /api/v1/conversation-targets` returns 200 and lists that tab with a `thread.ref` and identity
`bound`, titles absent; with Chrome stopped it returns 503 `BROWSER_UNAVAILABLE`. (b) Connect with
`expectedThread` set to that reference; a wrong reference returns 409 `BINDING_CHANGED` and holds no lease.
(c) `POST .../read` returns a bounded transcript whose counts match what the page shows, with `draft`
presence/length and honest coverage; a draft already in the composer is untouched (verify by presence/length
only). (d) Navigate that tab to another thread: Read returns 409 `BINDING_CHANGED` and nothing is returned.
(e) `GET .../conversations/{id}` leaves the conversation snapshot file bytes unchanged (the attached recorder's own autosnapshots are separate and expected). Finish the conversation and
verify the session. Receipts hold counts, hashes and masked references only; no thread URLs, titles or text.

### 6.6 Revised product frame and milestones (2026-10-23)

The product is an agent harness over **real AI webapp conversations** (ChatGPT first); the AION team is
the first workload. The full-surface families, harness identities, surface rules and the revised M0-M5
labels live once in [`ARCHITECTURE.md`](../ARCHITECTURE.md) (section "Agent harness over real AI webapp
conversations") and in `DESIGN-live-drive-studio.md` section 17.5; they are not repeated here. Only what
changes the gates is listed:

- **Read coverage means what the page shows, not what the network recorder saw.** A Read returns the messages currently rendered in the DOM, including ones that predate the connection. `coverage.preAttachHistory = 'not-captured-by-this-read'` describes the *network capture* (traffic before attach was not recorded); it is not an omission from the DOM read. What a Read can miss is history the page has not loaded or rendered, reported by `olderHistory` / `newerHistory`. The Chat UI wording that said anything before connect is not part of the read is wrong and is being corrected by the UI follow-up (not edited here).
- **M0 is harness contract + launch/readiness.** Observed 18:24:48 UTC: dedicated Studio Chrome (pid
  20048) running, CDP 9222 connected (parent verified); **LOGIN REQUIRED** (human). No extra approval is
  needed for the ordinary launcher or owned server refresh. The coded 503 counts only when observed from a
  loaded runtime.
- **Open targets are not the account chat list.** Gate RT-1 selects among open tabs by thread reference;
  the sidebar is a partial rendered index and a full scrape is not required for the first useful exchange.
- **Network completion stays network-only.** For RT-5/RT-6 the next action needs *page readiness*: exact
  thread, delivered user turn, reply turn after the pre-send boundary, stable idle controls, then a fresh
  preflight. Quiet text or an observed reply alone does not pass.
- **RT-4 stays a real SITREP request** (no sandbox ping first), delivered through the actual bridge from this
  agent session ("here"), not a side channel. The default route is the page UI through the existing adapter;
  seeing a private backend endpoint is not permission to replay authenticated requests.
- The Command Space ids are catalog vocabulary, not implementation. Private role-thread URLs stay local and
  are never written to the tracked `ROLES.json`. Offline status after the Sol handoff: full `bun run test` is 1,187 pass, 0 fail, 1 existing todo, 1,188 total (`studio-parent-final-before-push.log`), covering the pre-typing cancellation fix and nine Studio tools (`bun run -- node bin/studio.mjs tools ...`, same injected runtime, no retries). Focused evidence: cancellation 87/87 at 19:17:37–19:17:51Z; tools 42/42 at 19:23:26–19:23:41Z. Earlier 1,126 and 1,176 full-suite logs, and Chat UI 107/107 then 57, predate that handoff. Journal/M2 integration, exact-thread read/connect and the candidate chat-index POST are in source; they are not live. No server refresh or live send. Login was required at 18:24:48 UTC; current login and loaded runtime are unverified. The original five owner files stay excluded. `vivim-final` is owner-owned and eligible for reuse; deeper UI/sync/slave-profile lanes were cancelled for Claude credit before completion (not a completed assessment, not a reuse ban). Nothing is LIVE VERIFIED.