# Capture Studio

Local, read-only capture studio for websites you are authorized to use. It attaches to a tab in a
**dedicated Chrome profile** over the Chrome DevTools Protocol, records what the browser actually
received (raw bytes, decoded protocol events, rendered DOM, your actions) into an append-only log on
your own disk, and then derives datasets, a data model, a temporal evidence graph and a metadata
receipt from that log.

It can also drive an AI chat site for you — type one prompt, send it, read the reply back and record
the exchange — but only when you ask for it (`studio drive`, `studio campaign --execute`). Capture
alone never touches the page.

Capture Studio itself writes evidence to your **local data directory outside the Git repository**. Its web server listens on localhost and does not include a cloud synchronization or telemetry service. Explicitly sending a prompt to an online AI provider is still a network action, and pushing the source repository to GitHub is separate from local evidence storage. Local raw mode can retain cookies/tokens in recorded evidence; keep the data directory off Git.

- Design principles, capability matrix and roadmap: [`ARCHITECTURE.md`](ARCHITECTURE.md) (root) and
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (module map and data flow).
- Review findings and worklog: [`ASSESSMENT-AND-WORKLOG.md`](ASSESSMENT-AND-WORKLOG.md).
- Single-PC defaults and de-securitization decisions: [`docs/LOCAL-FIRST.md`](docs/LOCAL-FIRST.md).
- **Current Windows CORE L0/L1 handoff and diagnostics:** [`docs/CORE-LOCAL-HANDOFF-2026-10-22.md`](docs/CORE-LOCAL-HANDOFF-2026-10-22.md) and `node scripts/core-local-handoff.mjs l0|l1`.
- Live-test runbook on Windows PowerShell: [`docs/LIVE-TEST.md`](docs/LIVE-TEST.md).
- The interaction layer (pacing, measured CDP key-event rules, the typing harness):
  [`docs/HUMAN-INTERACTION.md`](docs/HUMAN-INTERACTION.md).
- CDP realism research (browser parameters and what a page can observe):
  [`docs/research/CDP-REALISM.md`](docs/research/CDP-REALISM.md).

## What it is

### Chat: one explicit turn

Open **Chat** at `/chat` in the local Studio browser. No login token is needed in default local mode; an optional token mode is available. Connect a known
site/tab, confirm a single send, poll its source-labelled reply, then **Finish capture**. A ready
page-fallback reply retains network completion **unknown**, and capture remains **incomplete**,
not verified or accepted. Uncertain sends are never
automatically retried; preserve the tab and use read-only reconciliation.

The CLI uses the same conversation runtime without requiring a running Studio server:

```powershell
bun bin/studio.mjs chat chatgpt --prompt 'Hello'                 # offline preview; no browser access
bun bin/studio.mjs chat chatgpt --prompt 'Hello' --execute --json # one actual send
```

`--execute` explicitly authorizes a website send that may consume account quota/history.
Prompts must be nonempty and at most 250,000 characters (the local HTTP request body also has a separate size limit). `--target ID` binds an existing tab;
`--fresh` requests a Studio-owned tab. `--timeout 120` bounds local polling (1–900 seconds),
not website generation. The one-shot CLI always finishes recording and leaves tabs open;
it prints structured conversation/reply/capture evidence, not an unsupported acceptance claim.
It does not offer a persistent CLI recorder or resend command. Use Studio history and read-only
reconciliation for recovery; do not rerun an uncertain prompt to repair missing evidence.

Authenticated JSON endpoints: `GET /api/v1/conversation-targets`, `GET|POST /api/v1/conversations`,
`GET /api/v1/conversations/{id}`, and `POST` to `{id}/turns`, `{id}/reconcile`, `{id}/finish`.
Turns require `{key,prompt,confirm:true,expectedRevision}`; reconcile requires `{expectedRevision}`.
Finish accepts `{closeTab?:boolean}`; the runtime refuses unsafe tab closure. Private content remains local.

Three capture layers, kept separate on disk and recomputable from each other:

| Layer | What it is | Where it lands |
| --- | --- | --- |
| **L1 raw** | Byte-exact chunks, WebSocket frames, DOM batches, actions, gaps | `sessions/<id>/raw/*.jsonl` |
| **L2 events** | Decoded protocol envelopes (SSE, NDJSON, JSON, WebSocket, delta patches) | `sessions/<id>/datasets/events.jsonl` |
| **L3 rendered** | Visible text blocks, conversation turns, accessibility snapshot | `sessions/<id>/kv/DOM_*` |

Design rules that are enforced in code:

- **Read-only by default.** Capture uses CDP `Network.*` plus an isolated-world DOM agent. It never
  intercepts with `Fetch` and never stores typed form values. Page interaction is a separate,
  opt-in layer (`src/capture/actions.mjs`) that types with real key events and runs only for
  `studio drive` and `campaign --execute`; a plain `record` or `capture` never touches the page.
- **Honest coverage.** Gaps, pauses, masked spans, metadata-only streams and pre-attach blind spots
  are declared in the log and in the receipt, never hidden.
- **High-fidelity local default.** `CAPTURE_STUDIO_CAPTURE_MODE=local-raw` preserves captured headers, request/response bodies, URLs and matching lifecycle metadata on your PC. This intentionally can include credentials in locally stored evidence. Set `CAPTURE_STUDIO_CAPTURE_MODE=filtered` to use the optional redaction and metadata-only rules. Both modes expose capture gaps honestly.
- **Raw is immutable.** Every derived artifact can be rebuilt from the raw log with `derive`.

## Requirements

- **Node.js >= 22** (the built-in `WebSocket` client is required). No `npm install` step — there are
  no runtime dependencies.
- **Google Chrome** (or Edge) for the capture browser. Auto-detected; override with `CHROME_PATH`.
- Windows, macOS or Linux. The tool is Windows-first but platform-neutral in code.

## Quick start

```powershell
cd <capture-studio>

node bin/studio.mjs doctor          # check Node, Chrome, DevTools, data folder, learner, profiles
node bin/studio.mjs start           # open the capture browser + local Studio UI (no token by default)
```

`start` launches a **separate Chrome profile** (its own window, its own sign-ins) with DevTools
bound to loopback only, then starts the local studio web UI. Sign in to the sites you want to
capture inside that window — the profile persists between runs.

Then, in another terminal:

```powershell
node bin/studio.mjs targets                       # list tabs that can be recorded
node bin/studio.mjs record --target claude.ai --duration 60
node bin/studio.mjs sessions                      # list saved recordings
node bin/studio.mjs receipt latest                # metadata-only receipt, safe to paste into an issue
node bin/studio.mjs shapes latest                 # profile suggestions inferred from the session
```

One-shot capture of a URL (opens a tab, records until the network goes quiet, derives, exports):

```powershell
node bin/studio.mjs capture https://example.com --export report,transcript
```

### Useful flags

| Flag | Meaning |
| --- | --- |
| `--data-dir <DIR>` | Where sessions, profiles and learner state live. Env: `CAPTURE_STUDIO_HOME`. |
| `--port <N>` | Chrome DevTools port. Env: `CAPTURE_STUDIO_CDP_PORT`, default `9222`. |
| `--json` | Machine-readable JSON on stdout; progress and errors go to stderr. |
| `--quiet` / `-q` | Suppress progress and decoration. |
| `--no-color` | Disable colored output (`NO_COLOR` is honored). |
| `--verbose` / `-v` | Show stack traces on errors. |
| `-h`, `--help` | Help for the command. `-V`, `--version` prints version + collector source hash. |

Persistent defaults live in `<data-dir>/config.json` and are resolved
**flags > environment > config file > defaults** (`studio config show` prints the effective values
and where each one comes from). Settings: `cdpPort`, `studioPort`, `exportFormat`, `defaultProfile`,
`maxMb`, `color`, `json`, `autoDerive`.

Exit codes are stable: `0` ok · `1` error · `2` usage · `3` not found · `4` integrity/state conflict ·
`5` environment (Chrome/Node) or a capability that is not in this build.

Session references accepted anywhere a session is expected: a full id, a unique id prefix or
suffix, `latest`, `latest~2` (third newest), `latest:claude.ai` (newest for that site).

## CLI command overview

`studio help` prints the live list; `studio help <command>` prints options and examples;
`studio commands --json` dumps every command machine-readably. Grouped by area:

### Get started
| Command | Purpose |
| --- | --- |
| `help [command]` | Command list, or options and examples for one command. |
| `doctor [--fix]` | Check Node, Chrome, DevTools, data folder, sessions, profiles, learner, config. |
| `start` | Open the capture browser and the studio UI (first-run friendly). |
| `serve` | Run the studio UI only. |

### Capture
| Command | Purpose |
| --- | --- |
| `launch [--url URL]` | Open the dedicated capture browser (loopback DevTools only). |
| `targets [--filter TEXT]` | List tabs in the capture browser that can be recorded. |
| `record [--target TAB] [--duration S] [--live --tabs all --follow]` | Record from the terminal; Ctrl+C stops, saves and derives. |
| `capture <url...>` | One shot: open the page, record until idle, derive and export. |

### Sessions
| Command | Purpose |
| --- | --- |
| `session list` (`sessions`) | List saved recordings, newest first. |
| `session show` | Everything about one session at a glance. |
| `session stats` · `session reindex` · `session compact` | Stream statistics, rebuild the raw seek index, compact the raw log. |
| `session datasets` · `session streams` · `session timeline` · `session events` | Inspect what was derived. |
| `session delete <id...> --yes` · `session prune --older-than 30d [--keep N] --yes` | Delete sessions (bulk prune is a dry run without `--yes`). |
| `verify [id]` | Integrity check: hashes, sequence accounting, declared gaps. |
| `receipt [id]` | Metadata-only lab receipt. |
| `shapes [id]` | Profile suggestions inferred from a session. |

### Replay and derive
| Command | Purpose |
| --- | --- |
| `derive [id] [--all\|--missing]` | Rebuild datasets, shapes, knowledge and the receipt from raw. |
| `replay [id] [--stream SID \| --at TIME \| --bytes]` | Replay a stream with its original timing, or time-travel to a moment. |
| `mirror serve [id]` · `mirror routes [id]` | Serve a saved session as a local HTTP mirror, or list its routes. |

### Export
| Command | Purpose |
| --- | --- |
| `export dataset [id] --dataset NAME [--format F] [--out FILE]` | One dataset as JSON, NDJSON, CSV, TSV, Markdown or HTML. |
| `export transcript` · `export knowledge` · `export graph` | Readable transcript, model+entities+graph artifact, graph in JSON/DOT/Mermaid/GraphML. |
| `export report` · `export bundle` · `export schemas` · `export graph-ranked` | Single-file HTML report, portable folder, JSON Schema bundle, confidence-ranked graph. |
| `export formats` | Which formats each export supports. |

### Knowledge
| Command | Purpose |
| --- | --- |
| `knowledge status` · `knowledge sites` | Derivation state per session; sites and origins you have captured. |
| `knowledge types` (`model`) | The discovered data model: types, keys, fields, relationships. |
| `knowledge entities` · `knowledge entity <eid>` | Keyed entities; one entity with revision history and neighbours. |
| `knowledge graph` · `knowledge at --t TIME` | Temporal evidence graph, and its state at a moment. |
| `knowledge hypotheses` | Rendered-as and action-to-stream correlation hypotheses. |
| `knowledge query <term…>` | Filter entities across sessions (`type=Message role=assistant text~hello observations>3`). |
| `knowledge search <text…>` | Ranked search over the derived session corpus. |
| `knowledge schema <type>` | Observed schema for one type. |
| `knowledge continuity` | Join safely keyed entities across sessions of the same origin. |

### Driving a live site
| Command | Purpose |
| --- | --- |
| `drive <site\|url> [--prompt TEXT] [--timeout S] [--no-record] [--dry-run]` | Send one prompt to a live site, record the exchange, read the reply back. |
| `library build <host\|site> [--min N]` | Inspect saved sessions; publish a versioned family only from current G1–G7 `capture_accepted`, fully derived, exact-origin shapes. Unassessed evidence remains saved but withheld. |
| `library show <host\|site\|id>` · `library list` | Inspect one consolidated family, or list every family. |
| `campaign [ids...] [--execute] [--prompt TEXT] [--limit N] [--cooldown S] [--timeout S] [--no-resume]` | Walk the known sites in order, one at a time: plan only unless `--execute`, then drive, derive and build each family. |

### Learning
| Command | Purpose |
| --- | --- |
| `learn status` · `learn corrections` · `learn proposals` · `learn audit` | Learner revision, scoped models, what it has been taught, pending proposals, audit trail. |
| `learn calibration` · `learn versions` · `learn promotions` | Per-kind calibration and ECE, immutable revisions, cross-site promotion candidates. |
| `learn roles` · `learn predict` | The role/scope vocabulary; what role the learner would assign to a field and why. |
| `learn propose` · `learn teach` · `learn review` | Propose a correction for review, apply one immediately, accept/reject a proposal. |
| `learn revert` · `learn rollback` | Undo an accepted correction; restore an earlier learner revision. |

### Profiles and families
| Command | Purpose |
| --- | --- |
| `profile list` · `profile show` · `profile versions` · `profile diff` | Inspect site profiles, their version history and what changed. |
| `profile rollback` · `profile apply` | Make an earlier version current; accept/reject an inferred suggestion into a new version. |
| `profile new` · `profile clone` · `profile set` · `profile hosts` | Author and edit a profile. |
| `profile match <url>` · `profile lint` | Which profile a URL would use and why; check profiles for invalid or risky settings. |
| `profile export` · `profile import` · `profile op` | Portable JSON profile files; apply a semantic model operation. |
| `family list` · `family show` · `family new` · `family records` · `family detect` | Provider families: shared data models many sites map into. |

### Platform and analysis
| Command | Purpose |
| --- | --- |
| `detect <file\|->` | Detect the shape of a saved document or stream and summarise it. |
| `scan <file\|->` | Scan text for credentials (exit 4 when any are found); `--pii` also reports personal data. |
| `csv <file\|->` | Analyse delimited text: columns, types and row statistics. |
| `dedupe <session>` | Find duplicate or near-duplicate records in a saved session. |
| `knowledge graph-stats` | Graph statistics, top PageRank nodes and community summary. |
| `knowledge keyphrases` | Extract key phrases from a saved session. |
| `integrity build <dir\|session>` | Write a SHA-256 `MANIFEST.json` for a directory. |
| `integrity verify <dir\|session>` | Verify a directory against its manifest (exit 4 when it does not match). |
| `platform stats` · `platform registry` | Platform capability/usage statistics; a snapshot of the local platform registry. |

### System
| Command | Purpose |
| --- | --- |
| `version` | Version and collector source hash. |
| `paths` | Print the data folder layout. |
| `config show` · `config get/set/unset` · `config path` | Persistent defaults in `<data-dir>/config.json`. |
| `completion <bash\|zsh\|pwsh>` | Print a shell completion script. |
| `commands` | List every command (machine-readable with `--json`). |

## Driving live AI sites

`drive` and `campaign` are the opt-in interaction layer. They use the same CDP connection and the
same recorder as capture, so what they send and receive lands in the same session format.

- **`drive <site|url>`** sends **one** prompt into a tab of its own, records the exchange unless
  `--no-record`, waits until the reply stops changing and prints it. The drive opens a fresh tab on
  the site, activates it, and closes it again when the drive ends, so your browser keeps only the
  tabs you opened. A tab that is not the active one is hidden, and Chrome drops synthetic key input
  for a hidden tab, which is why the tab is created fresh instead of reused. A plain `https://` URL
  works without a site adapter: the generic heuristics in `src/capture/actions.mjs` find the
  composer, the send control and the reply. A login wall stops the command before anything is typed.
  The default prompt is a fixed 12-word calibration sentence (`alpha bravo charlie …`), so a
  captured transcript can be checked word for word. `--dry-run` prints the resolved adapter and
  target and types nothing.
- **`campaign`** walks the nine known sites in order — `chatgpt`, `claude`, `gemini`, `deepseek`,
  `zai`, `qwen`, `lmarena`, `minimax`, `kimi` — one at a time, and for each one drives it, derives
  the session and builds the site family. **The default is plan-only**: adapters and target URLs
  are resolved and printed, and nothing is opened, typed into or sent. `--execute` is required to
  interact. Progress is remembered in `<data-dir>/campaign-state.json`, so a second run skips sites
  that already completed unless you pass `--no-resume`.

```powershell
node bin/studio.mjs drive chatgpt --dry-run
node bin/studio.mjs drive claude --prompt "Summarize this page in one sentence" --timeout 90
node bin/studio.mjs drive https://example.ai/ --no-record

node bin/studio.mjs campaign                       # plan only, prints the order and targets
node bin/studio.mjs campaign --limit 2 --json
node bin/studio.mjs campaign chatgpt claude --execute --timeout 90 --cooldown 75

node bin/studio.mjs library build chatgpt.com
node bin/studio.mjs library build openai --min 3 --json
node bin/studio.mjs library show chatgpt.com
node bin/studio.mjs library list
```

**The browser window may have to be brought to the foreground.** A drive creates and activates its
own tab, but a browser window that is behind another window reports every page as hidden, and
`Page.bringToFront` only switches tabs inside the browser. Bring the window forward from the OS
first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-chrome.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-chrome.ps1 -Title chatgpt
```

`-ProcessId` and `-Title` choose which Chrome window; it restores and raises it and exits `0` when
the window is in front, `1` when it is not or none was found. The measured evidence is in
[`docs/HUMAN-INTERACTION.md`](docs/HUMAN-INTERACTION.md).

**Human pacing.** Every character is a real `keyDown` + `char` + `keyUp` triple with 35–110 ms
between keys, longer pauses at word and sentence boundaries, a periodic "thinking" pause, one
deliberate typo that is noticed and corrected in longer texts, and a 0.7–1.9 s hold before sending.
Between two sites the campaign waits 45–90 s by default. The exact parameters and the measured CDP
rules behind them are in [`docs/HUMAN-INTERACTION.md`](docs/HUMAN-INTERACTION.md).

**Honest limits.**

- One browser, one site at a time. Sites are driven serially; there is no concurrency anywhere.
- A site may block on quota or a captcha: that site times out and is recorded as failed, and the
  campaign continues with the next one.
- An account may be rate-limited. One prompt per site per run is deliberate — do not loop the
  campaign to "get more data".
- A blocked site (login wall, missing adapter) is recorded and skipped, not retried.
- The interaction layer types and sends. It dismisses a cookie banner only with the least
  permissive option and never accepts tracking consent on your behalf; it never opens a cookie
  "settings" link, never answers an age or login prompt, and never solves a challenge. Those are
  reported and stop that site's drive.

## Studio web UI and the `/api/v1` API

`studio start` / `studio serve` runs a local web UI on `127.0.0.1:7878` (override with
`--studio-port` or `CAPTURE_STUDIO_PORT`). **Default:** `CAPTURE_STUDIO_ACCESS_MODE=local` opens `http://127.0.0.1:7878/` with no token, cookie exchange or recurring login prompt.
**Optional:** `CAPTURE_STUDIO_ACCESS_MODE=token` prints a one-time startup URL and exchanges it for an `HttpOnly`, `SameSite=Strict` cookie; clients can also supply `x-studio-token`. Both modes keep localhost-only binding and standard `Host` / `Origin` checks. No LAN listener is exposed.

`GET /api/v1/openapi.json` returns an OpenAPI 3.1 description of the versioned routes.

### Route families

| Family | Routes |
| --- | --- |
| Health / capability | `GET /health`, `GET /integrations`, `GET /openapi.json`, `GET /integrations/tools`, `POST /integrations/tools/call` |
| Sessions | `GET /sessions`, `GET /sessions/{id}`, `GET /sessions/{id}/datasets`, `GET /sessions/{id}/datasets/{dataset}`, `GET /sessions/{id}/receipt`, `POST /sessions/{id}/derive` |
| Replay | `GET /sessions/{id}/replay/records`, `.../replay/state`, `.../replay/streams/{sid}`, `.../replay/events` |
| Knowledge | `GET /sessions/{id}/knowledge`, `.../knowledge/entities`, `.../knowledge/entities/{eid}`, `.../knowledge/graph`, `.../knowledge/neighbors/{eid}`, `.../knowledge/continuity` |
| Learning | `GET /learning`, `POST /learning/predict`, `GET /learning/{proposals,corrections,audit,versions,promotions}`, `POST /learning/proposals`, `POST /learning/proposals/{id}/review`, `POST /learning/corrections/{id}/revert`, `POST /learning/rollback`, `POST /learning/calibration`, `GET /sessions/{id}/learning/questions` |
| Event stream | `GET /events` — resumable SSE (supports `Last-Event-ID` / `after` cursors, heartbeat, gap reset) |
| Live capture | `GET /live` — SSE of live-tap events; `GET /live/view` — minimal live text viewer |
| Webhooks | `GET /integrations/webhooks`, `POST /integrations/webhooks`, `GET /integrations/webhooks/{id}/deliveries`, `DELETE /integrations/webhooks/{id}` |
| Optional capabilities | `POST /sessions/{id}/derive-all`, `GET /sessions/{id}/{artifacts,schemas,graph/ranked,timelines}`, `GET /search`, `GET/POST/DELETE /mirrors…` |

Notes on the optional capabilities:

- **Optional means optional.** Each backend module is imported on demand. If the module or the
  required export is not in the build, the endpoint answers **HTTP 501 `CAPABILITY_UNAVAILABLE`**
  and everything else keeps working. In the current tree all three optional backends are present:
  the live-tap backend (`src/capture/live-tap.mjs`), the full-derivation backend
  (`src/replay/derive-all.mjs`) and the mirror entry point (`src/mirror/index.mjs`), so
  `derive-all`, `artifacts`, `schemas`, `graph/ranked`, `timelines`, `search` and the mirror
  routes are served. The default derivation path (`src/replay/derive.mjs`) is still what
  `record --derive`, the studio's `POST …/derive` and `POST /api/record/stop` use.
- **Tools endpoint.** `GET /integrations/tools` publishes an MCP-style manifest (JSON input
  schemas plus read-only/destructive annotations); `POST /integrations/tools/call` invokes a
  declared tool. It is a manifest and invocation adapter, not a full MCP transport.
- **Mirrors** are process-local, literal-loopback-only and capped at 8 concurrent instances. Studio
  authentication protects the *management* endpoints; the mirror backend itself serves captured
  replay data on the port it returns.
- **Webhooks** are loopback-only, process-lifetime subscriptions (max 16) with one delivery attempt
  and metadata-only payloads by default. Including captured preview data requires an explicit
  opt-in.

### Legacy UI routes

The studio UI also uses unversioned `/api/*` routes implemented in `src/studio/server.mjs`
(`/api/status`, `/api/targets`, `/api/chrome/launch`, `/api/record/start`, `/api/record/stop`,
`/api/live/*`, `/api/sessions/*`, `/api/search`, `/api/profiles/*`, `/api/families/*`,
`/api/preview`). They are not part of the versioned contract and are not described in the OpenAPI
document.

### MCP stdio server

A real MCP server ships in the tree: `node src/mcp/server-stdio.mjs` speaks newline-delimited
JSON-RPC 2.0 on stdin/stdout (`initialize`, `tools/list`, `tools/call`, `resources/list`,
`resources/read`; protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`). stdout carries
JSON-RPC only — logs go to stderr. Resources are exposed as `capture-studio://sessions/...`.
It talks to the same in-process integration hub as the web UI.

## Data directory layout

Default location: `%LOCALAPPDATA%\AION\capture-studio` on Windows,
`~/Library/Application Support/AION/capture-studio` on macOS,
`${XDG_DATA_HOME:-~/.local/share}/aion-capture-studio` elsewhere. Override with
`CAPTURE_STUDIO_HOME` or `--data-dir`. `studio paths` prints the resolved paths.

```
<data-dir>/
  config.json              persistent defaults (see `studio config`)
  sessions/                one directory per recording
  profiles/                site profiles, versioned
  families/                provider families, versioned
  learner/                 adaptive-learner state and revision history
  chrome-profile/          the dedicated Chrome profile used for capture
  exports/                 default output folder for `--export`
```

`campaign` adds one file next to them: `campaign-state.json`, written atomically after every site,
holding the site, status, session id, family id, signature and the first 2000 characters of the
reply for each site that finished. Delete it to start a campaign from scratch, or use
`--no-resume`.

### One session

```
sessions/<session-id>/
  session.json             run metadata, status, transport and integrity summary
  raw/                     L1: append-only source of truth
    manifest.json          segments with byte counts, seq ranges and sha256
    NNNNNN.jsonl           append-only records, one JSON object per line
    NNNNNN.idx.jsonl       sparse seek index ({s: seq, o: byteOffset, t: wallTime})
    streams.json           per-stream locator (first/last seq, counts, bytes, segments)
  datasets/                L2: derived, append-only JSONL, always rebuildable
    events.jsonl           decoded protocol events
    streams.jsonl          observed streams and requests
    timeline.jsonl         actions, navigations, lifecycle and gaps over time
    records-<rule>.jsonl   records extracted by a profile record rule
    family-<family>-<entity>.jsonl  canonical records for a provider family
    entities.jsonl         resolved entities from the knowledge layer
  kv/                      L3 and derived state, named JSON values
    INPUT  PROFILE_SNAPSHOT  STATE  SHAPES  ASSEMBLED  RECEIPT
    DOM_BLOCKS  DOM_TURNS  DOM_INSPECT  CORPUS_STATS
    MODEL  GRAPH  HYPOTHESES  KNOWLEDGE_STATUS
```

The raw seek index and the stream locator are **derived data**: they can always be rebuilt
(`studio session reindex`) and their absence never blocks a read.

### Versioned stores

`profiles/<name>/` and `families/<name>/` each hold `v0001.json`, `v0002.json`, … — every save is a
new immutable version — plus a `CURRENT` file naming the active one. Rollback just moves the
pointer; history is kept.

A family record built by `library build` (or by `campaign`) is the consolidated view of one site:
`members` (the session ids that went into it), `hosts`, `coverage` (sessions, derived sessions,
transports, stream count), a normalised `shapes` array and a `signature`. The signature hashes only
the normalised shape set, and every collection is sorted, so rebuilding from the same sessions
produces the same signature.

### Learner state

`learner/learner.json` holds the current state with an integrity digest; `learner/history/rev-*.json`
holds every past revision; `learner/.learner-write-lock/` is the exclusive write lock. Writes use
optimistic concurrency: a caller supplies the revision it expects, and a mismatch is rejected
rather than silently overwritten.

## Running the tests

```powershell
node bin/studio.mjs selftest              # preflight: imports, data dir, Chrome, Studio API
node --test "test/unit/**/*.test.mjs"     # unit tests (no browser)
node --test "test/e2e/**/*.test.mjs"      # e2e tests (need Chrome)
node scripts/live-e2e.mjs                 # full loop against a local fixture site
node scripts/human-check.mjs              # typing harness against a local file:// fixture
node eval/run.mjs                         # intelligence evaluation
```

The e2e suite needs a Chrome binary; set `CHROME_PATH` if it is not auto-detected.

`scripts/live-e2e.mjs` uses a local fixture site (`scripts/fixture-site.mjs`) and its own isolated
data directory, so it never touches a real website. `scripts/human-check.mjs` opens a data-only
`file://` fixture written to the OS temp directory, types a sentence into a plain input and into a
`contenteditable`, and asserts nine properties of the typing; it needs a Chrome with DevTools on the
port and touches no website either. How to read its receipt, and what a failure means, is in
[`docs/HUMAN-INTERACTION.md`](docs/HUMAN-INTERACTION.md).

### Probing a site read-only

Before writing a site adapter, capture the DOM and transport facts of that site instead of guessing:

```powershell
node scripts/probe-site.mjs chatgpt
node scripts/probe-site.mjs claude --reload --wait 8
node scripts/probe-site.mjs https://example.ai/ --out docs/research/probe --keep-open
```

`scripts/probe-site.mjs <site|url>` never types, sends, clicks or dispatches input events. It reuses
an existing tab for the host, writes exactly one JSON file per site (default
`docs/research/probe/`), and closes only a tab it opened unless `--keep-open` is passed. Flags:
`--port N`, `--out DIR`, `--wait S`, `--keep-open`, `--reload`. Exit `0` success, `3` unreachable or
login-walled, `5` no CDP endpoint. The committed files under
[`docs/research/probe/`](docs/research/probe) are the evidence the site adapters were written from.
