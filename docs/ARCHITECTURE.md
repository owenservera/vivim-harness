# Capture Studio — Architecture

Module map and data flow of the code as it exists in this tree. Companion documents:
[README.md](../README.md) (usage, CLI, API, data layout) and the root
[ARCHITECTURE.md](../ARCHITECTURE.md) (design principles, capability matrix, roadmap).

## 1. Module map

### `src/config.mjs` — paths, settings, provenance
`defaultDataDir()`, `dataPaths()`, `ensureDataDirs()`, `SETTINGS_SCHEMA`, `parseSetting()`,
`loadUserConfig()`, `saveUserConfig()`, `resolveSettings()` (flags > env > file > default),
`EXPORT_FORMATS`, `EXIT` (stable exit codes), `collectorSourceSha()` (sha256 of `src/`, recorded in
every session as provenance).

### `src/cdp/` — DevTools transport
- `client.mjs` — `CdpConnection`, `CdpSession`, `ResilientCdpConnection`, `connectWithRetry()`,
  `CdpError`/`CdpTimeoutError`, `assertLoopbackUrl()`.
- `discovery.mjs` — `browserVersion()`, `listTargets()`, `listAllTargets()`, `isReachable()`,
  `browserWsUrl()`, `pickTarget()`, `pickTargets()`, `waitForReachable()`, `waitForTarget()`,
  `targetStillPresent()`, `targetSummary()`, `discoveryProbe()`.

### `src/chrome/launch.mjs` — the capture browser
`findChrome()`, `chromeCandidates()`, `chromeInstalls()`, `launchChrome()` (separate profile,
loopback-only DevTools), `ensureChrome()`, `chromeStatus()`.

### `src/capture/` — L1/L3 observation
- `recorder.mjs` — `Recorder`: one run anchored on one user-selected tab. Wires CDP →
  `NetworkRecorder` + `DomObserver` → `RawLog`, mirrors every persisted record through the
  `StreamReducer` so the live view and a later replay cannot disagree. Handles multi-target
  tagging (`p` primary, `tN` tabs/popups, `wN` workers, `cN` auto-attached children), pause/resume,
  byte quota, reconnect with explicit coverage notes, `verify()` on stop.
- `network.mjs` — `NetworkRecorder`: CDP `Network.*` observation, stream arming
  (`streamResourceContent`), WebSocket handshake/frames, EventSource messages, per-request policy.
- `dom.mjs` — `DomObserver`: injects the isolated-world agent, collects content blocks, turns,
  accessibility snapshot, `highlight()`/`clearHighlight()`.
- `page-agent.js` — the in-page agent (isolated world): mutation batching, text blocks, user
  actions (click / submit / enter / input-length / scroll / toggle). Never reads typed values.
- `redact.mjs` — credential policy: `redactHeaders()`, `redactUrl()`, `isSensitiveUrl()`,
  `scrubSecrets()`, `scrubText()`.
- `targets.mjs` — `followDecision()`, `hostOf()`, `sameSiteHost()`, `isInternalUrl()`,
  `FOLLOWABLE_WORKER_TYPES`.
- `live-tap.mjs` — `LiveTap`, `createLiveTap()`, `LIVE_TAP_EVENTS`, `kindMatcher()`: live decoded
  text/event tap over a recorder.

### `src/store/` — durable, append-only storage
- `raw-log.mjs` — `RawLog`, `RAW_FORMAT`, `segmentName()`, `indexName()`. Segmented append-only
  JSONL with a sha256 manifest, a sparse seek index, a per-stream locator, and a bounded in-memory
  queue. On disk lag, records are **dropped and a `gap` record is written** describing the exact
  seq range, affected streams and byte counts — loss is always declared, never silent.
- `session.mjs` — `Session`, `Dataset`, `KeyValueStore`, `listSessions()`, `resolveSessionDir()`,
  `newSessionId()`. The storage triad: `raw/` (source of truth), `datasets/` (JSONL), `kv/`
  (named values), plus `session.json`. `Session.verify()` checks hashes, torn lines and sequence
  continuity against the manifest.
- `raw-index.mjs` — `buildRawIndex()`, `loadRawIndex()`, `iterateRaw()`,
  `iterateStreamRecords()`, `rawStats()`, `readStreamIndex()`, `readManifest()`, `segmentFiles()`.
  The index is strictly derived and always rebuildable.
- `compact.mjs` — `compactRaw()`, `compactSession()`, `estimateCompaction()`, `dirBytes()`.
- `versioned.mjs` — `VersionedStore`: every save writes a new immutable `vNNNN.json`; `CURRENT`
  names the active version; rollback moves the pointer.
- `integrity.mjs` — `FORMAT` (`aion-integrity/1`), `canonicalJson()`, `sha256Hex()`,
  `buildManifest()`, `verifyManifest()`, `exportSnapshot()`, `importSnapshot()`: the SHA-256
  directory manifest behind `studio integrity build` / `integrity verify`.

### `src/decode/` — L2 protocol decoding
- `decoders.mjs` — `SseDecoder`, `NdjsonDecoder`, `ChunkedJsonDecoder`, `JsonSeqDecoder`,
  `LengthPrefixedDecoder`, `GrpcFrameDecoder`, `WholeBodyDecoder`, `AutoDecoder`, `LineSplitter`,
  `JsonStreamScanner`, `parseJsonSafe()`, `parseHttpHeaderBlock()`, `extractStrings()`,
  `classifyMime()`, `decoderForKind()`, `pickDecoder()`, `pickAutoDecoder()`, `sniff()`,
  `sniffEnvelope()`, `unwrapNestedJson()`, `decodeTextFrame()`, `decodeWsPayload()`,
  `WsFrameDecoder`.
- `delta.mjs` — `DeltaAssembler`, `detectDialect()`, `applyMergePatch()`, `parsePointer()`,
  `parseDotted()`, `getPointer()`, `reconstruct()`. Assembles incremental documents (JSON Patch,
  path ops, typed events) into the document a user actually saw.
- `csv.mjs` — `parseCsv()`, `sniffDelimiter()`, `headerLikelihood()`, `coerceCell()`,
  `csvToObjects()`, `CsvDecoder`: delimited-text decoding and column typing (the backend of
  `studio csv`).

### `src/replay/` — offline reconstruction
- `reducer.mjs` — `StreamReducer`, `transportOf()`, `transportDetailOf()`, `isStreaming()`,
  `STREAMING_TRANSPORTS`. **One reducer for live and offline use**: raw L1 records → per-stream
  state and decoded L2 events, with duplicate, out-of-order, sequence-skip, stall and gap
  detection.
- `derive.mjs` — `derive()`, `buildReceipt()`, `streamBytes()`, `stateAt()`,
  `reconstructStream()`, `streamText()`, `search()`, `fidelityBreakdown()`. Rebuilds every derived
  artifact from raw: datasets, shapes, family records, assembled documents, the receipt and the
  knowledge layer.
- `derive-all.mjs` — `deriveAll()`, `loadArtifacts()`, `searchSession()`: the staged full
  derivation (all artifacts, incremental or forced) and the artifact/search loaders behind
  `POST /api/v1/sessions/{id}/derive-all`, `GET .../artifacts`, `GET /api/v1/search` and
  `studio knowledge search`. Loaded on demand as the `derive` capability.

### `src/shapes/` — v1 shape inference
- `infer.mjs` — `ShapeInferencer` (endpoints, collections, drift, quality), `templateUrl()`,
  `endpointRegex()`.
- `extract.mjs` — `ruleMatchesEvent()`, `extractRecords()`, `extractFromAssembled()`,
  `compileSelector()`, `select()`, `coerce()`: profile record rules → concrete records.
- `profiler.mjs` — `OnlineSchemaProfiler`, `toJsonSchema()`.

### `src/families/families.mjs` — provider families
`FamilyStore` (versioned), `gatherEvidence()`, `detectFamilies()`, `proposeMapping()`,
`applyMapping()`, `proposeFamilyLink()`, `familyRecordsFromEvent()`, `extractFamilyRecords()`,
`endpointPattern()`, `signalNames()`. A family is a reusable semantic data model (e.g. `ai-chat`
message) that many sites map into; families are priors, not classification gates.

### `src/profiles/` — site profiles
- `profiles.mjs` — `DEFAULT_PROFILE`, `normalizeProfile()`, `ProfileStore` (with
  `selectFor(url)`), `hostMatchScore()`, `siteOf()`, `inScope()`, `profileDiff()`.
- `manage.mjs` — `ProfileStore` management helpers: `summarizeProfile()`, `lintProfile()`,
  `parseAssignment()`, `applyAssignments()`, `unsetPaths()`, `editHosts()`, `buildProfile()`,
  `validateImport()`, `profileUsage()`, `explainMatch()`.
- `apply.mjs` — `applySuggestion()`: accept/reject an inferred suggestion into a new version.
- `model-ops.mjs` — `applyModelOp()`: semantic model operations (`rename_field`, `set_identity`,
  `merge_records`, …).
- `migrations.mjs` — `createMigrationChain()`, `migrations`: the deterministic versioned profile
  migration chain (`schemaVersion` 1 → 2).

### `src/security/` — credential and PII detection
- `patterns.mjs` — `luhn()`, `ibanMod97()`, `shannonEntropy()`, `PATTERNS`, `detectSecrets()`,
  `scrub()`, `registerPatterns()`: the credential/PII pattern library behind `studio scan`
  (exit 4 when a secret is found).

### `src/plugins/` — extension registry
- `registry.mjs` — `DEFAULT_KINDS` (`formats`, `codecs`, `secretPatterns`, `migrations`,
  `transforms`), `createRegistry()`, `registry`: a zero-dependency, fixed-kind plugin registry.

### `src/intel/` — intelligence engine
- `corpus.mjs` — `buildCorpus()`, `CorpusCollector`, `discriminatorOf()`: session → discovery
  corpus with provenance.
- `schema.mjs` — `SchemaNode`, `induce()`, `sampleIndices()`, `alignFields()`, `schemaSimilarity()`,
  `schemaDiff()`, `nameSimilarity()`, `valueSimilarity()`, `jaccard()`, `flatten()`, `tokens()`.
- `discover.mjs` — `discoverModel()`, `inferKey()`, `modelSummary()`: record-type induction, key
  inference, relationships, per-type confidence.
- `identity.mjs` — `resolveType()`, `resolveModel()`, `linkage()`, `instanceSig()`, `scopeOf()`,
  `snapshotKey()`, `shingles()`, `containment()`: keyed grouping and keyless linkage.
- `correlate.mjs` — `correlateActions()`, `correlateRendered()`, `reconcileFinal()`.
- `graph.mjs` — `TemporalGraph`, `buildGraph()`, `graphNeighborhood()`, `rankGraphNodes()`.
- `history.mjs` — `RevisionAccumulator`, `foldRevision()`, `summarizeRevisions()`.
- `learn.mjs` — `ScopedLearner`, `RoleModel`, `Calibrator`, `fieldFeatures()`, `priorDescription()`,
  `activeQuestions()`, `SCOPES`, `ROLES`, `softmax()`, `entropy()`.
- `learner-journal.mjs` — `LearnerJournal`, `LearnerWriteConflict`, `diffLearnerStates()`:
  durable, integrity-checked, optimistic-concurrency learner state.
- `priors.mjs` — `ROLES`, `PRIOR_FIELDS`, `PRIOR_ROLES`: the cross-convention prior corpus.
- `search.mjs` — `CorpusSearchIndex`, `indexCorpus()`, `rankCorpus()` (re-exported by `corpus.mjs`).
- `similarity.mjs` — `diceSimilarity()`, `compareRecords()`, `normalizeText()`, `textTokens()`,
  `typedValueKey()`, `stableStringify()`.
- `statistics.mjs` — `CardinalitySketch`, `wilsonInterval()`.
- `continuity.mjs` — `buildSiteContinuity()`, `siteFromSession()`, `originFromSession()`,
  `continuityTime()`: cross-session continuity without automatic type-drift merges.
- `rank.mjs` — `trigrams()`, `damerauLevenshtein()`, `expandTerm()`, `simhash()`, `hamming()`,
  `minhash()`, `jaccardFromMinhash()`, `lshClusters()`, `tfidfVectors()`, `cosine()`, `rake()`:
  fuzzy matching, near-duplicate detection and keyword extraction.
- `graph-analytics.mjs` — `pagerank()`, `betweenness()`, `components()`, `communities()`,
  `topK()`, `graphAnalytics()`: the metrics behind `knowledge graph-stats` and
  `export graph-ranked`.
- `autodetect.mjs` — `detectContent()`, `detectBatch()`: shape detection for arbitrary documents
  or streams (the backend of `studio detect`).
- `platform.mjs` — `sessionTexts()`, `sessionGraph()`, `dedupeSession()`, `analyzeSessionGraph()`,
  `keyphrasesSession()`, `detectAndScan()`, `csvAnalyze()`, `platformStats()`, `registrySnapshot()`:
  the read-only analysis layer behind the `detect`/`scan`/`csv`/`dedupe`/`platform` commands and
  the `/api/x/*` routes.
- `bench.mjs` — `runBench()`: the self-benchmark behind `GET /api/x/bench`.

### `src/export/` — artifacts
- `export.mjs` — `exportDataset()`, `exportTranscript()`, `exportKnowledge()`, `exportGraph()`,
  `exportReport()`, `exportBundle()`, `datasetCatalog()`, `VIRTUAL_DATASETS` (derived views:
  `model-types`, `model-relationships`, `suggestions`, `dom-blocks`, `dom-turns`, `assembled`,
  `graph-nodes`, `graph-edges`, `hypotheses-rendered`, `hypotheses-actions`, `receipt`),
  `DATASET_FORMATS`, `TRANSCRIPT_FORMATS`, `KNOWLEDGE_FORMATS`, `GRAPH_FORMATS`.
- `schemas.mjs` — `sessionSchemas()`, `schemaForType()`, `exportSchemas()` (draft-2020-12 JSON
  Schema bundle).
- `graph-ranked.mjs` — `exportGraphRanked()`: confidence-weighted PageRank over graph nodes.
- `capabilities.mjs` — `exportCapability()`: loads an optional backend on demand.

### `src/mirror/` — replay mirror
`catalog.mjs` (`loadCatalog()`, `routeTableOf()`, `templatePath()`, `openSession()`),
`match.mjs` (`findMatch()`, `scoreExchange()`, `pathScore()`, `queryScore()`, `bodyScore()`),
`template.mjs` (`substitutionPairs()`, `messagePairs()`, `substituteParts()`, `substituteText()`),
`replay.mjs` (`createClock()`, `buildHttpPlan()`, `sendHttpPlan()`, `buildWsScript()`),
`synthesize.mjs` (`synthesizeUnits()`, `renderUnit()`, `sseBlock()`), `ws.mjs` (`FrameParser`,
`WsConnection`, `encodeFrame()`, `acceptUpgrade()`).

- `index.mjs` — the mirror entry point: `startMirror()`, `buildRouteTable()`, and re-exports of
  `loadCatalog`, `findMatch`, `parseIncoming`, `scoreExchange`, `synthesizeUnits`, `learnDeltas`.
  `bin/lib/capabilities.mjs` loads it on demand as the `mirror` capability.

### `src/studio/` — the local web UI and API
- `server.mjs` — `startStudio()`: loopback-only HTTP server, token → HttpOnly cookie exchange,
  Host/Origin checks, the legacy `/api/*` UI routes, and the recorder/session/profile surface.
- `integration-hub.mjs` — `createIntegrationHub()`: the versioned `/api/v1` route table, SSE feed,
  webhooks, the MCP-style tool manifest and the OpenAPI 3.1 document.
- `capabilities.mjs` — `registerCapabilities()`, `LIVE_EVENTS`: optional backends (full
  derivation, mirror, live tap) loaded on demand; missing ones answer HTTP 501.
- `event-feed.mjs` — `EventFeed`, `EVENT_TYPES`: resumable SSE with `Last-Event-ID` cursors.
- `webhooks.mjs` — `Webhooks`: loopback-only, signed, one-attempt, metadata-only delivery.
- `http.mjs` — `problem()`, `json()`, `integer()`, `text()`, `object()`, `storageName()`,
  `timestamp()`, `page()`, `datasetPage()`: request validation and pagination.
- `ui/index.html`, `ui/live.html`, `ui/live.mjs` — the studio UI and the minimal live viewer.
- `platform-x.mjs` — `handlePlatformX()`: the optional `/api/x/*` routes — `/api/x/stats`,
  `/api/x/registry`, `/api/x/autodetect`, `/api/x/csv`, `/api/x/bench`, and the per-session
  `/api/x/graph/{id}`, `/api/x/dedupe/{id}`, `/api/x/keyphrases/{id}`.
- `ui/platform.html`, `ui/platform.mjs` — the `/platform` page of the studio UI.

### `bin/` — the CLI
- `studio.mjs` — entry point: parse → resolve → run → stable exit codes.
- `lib/args.mjs` — strict zero-dependency argument parser (`parseArgv()`, `leadingWords()`,
  `closest()`).
- `lib/registry.mjs` — command registry, groups and aliases, help rendering, shell completion
  (`define()`, `defineGroup()`, `resolveCommand()`, `renderRootHelp()`, `completionScript()`).
- `lib/context.mjs` — `buildContext()`: resolved paths and settings, lazily built stores, session
  reference resolution (`latest`, `latest~N`, `latest:<site>`, id prefixes), profile selection,
  `ensureDerived()`.
- `lib/ui.mjs` — human and `--json` output, tables, error formatting (`createOutput()`,
  `reportError()`, `usageError()`, `notFound()`, `envError()`).
- `lib/capabilities.mjs` — `capability()`: keeps optional engines out of the startup import graph.
- `lib/query.mjs`, `lib/util.mjs` — query parsing and shared helpers.
- `commands/` — `system.mjs`, `capture.mjs`, `sessions.mjs`, `replay.mjs`, `mirror.mjs`,
  `export.mjs`, `knowledge.mjs`, `learn.mjs`, `profiles.mjs`, `platform.mjs`.

### `src/mcp/` — the stdio MCP server
- `server-stdio.mjs` — `createServer()`, `serveStdio()`: the newline-delimited JSON-RPC 2.0 stdio
  transport (`tools/list`, `tools/call`, `resources/list`, `resources/read`). Run it with
  `node src/mcp/server-stdio.mjs`; stdout carries JSON-RPC only, logs go to stderr.
- `jsonrpc.mjs` — `ErrorCode`, `RpcError`, `rpcResult()`, `rpcError()`, `parseMessage()`,
  `serialize()`.
- `resources.mjs` — `resourceUri()`, `listCaptureResources()`, `readCaptureResource()`: the
  `capture-studio://sessions/...` resource tree.
- `runtime.mjs` — `createRuntime()`, `callRoute()`, `listTools()`, `callTool()`: the in-process
  bridge to the studio integration hub.

## 2. Data flow

```
Chrome (dedicated profile, DevTools on 127.0.0.1 only)
  │  CDP flatten sessions: page + child targets (tN / wN / cN)
  ▼
CAPTURE ─ src/capture/
  NetworkRecorder (L1: chunks, WS frames, EventSource)   DomObserver (L3: blocks, turns, actions)
  redact.mjs (credential policy)                         targets.mjs (follow decisions)
  │                                                        │
  └──────────────────┬─────────────────────────────────────┘
                     ▼  one append per record
RAW LOG ─ src/store/raw-log.mjs
  in-memory queue → segmented JSONL + sha256 manifest + seek index + stream locator
  queue overflow ⇒ records dropped AND a `gap` record written for that exact seq range
                     │
                     ▼  session.records() / session.streamRecords()
DECODE ─ src/decode/
  decoders.mjs  (SSE / NDJSON / JSON-seq / chunked / length-prefixed / gRPC / WS)
  delta.mjs     (JSON-Patch, path ops, typed events → assembled document)
                     │
                     ▼  StreamReducer.ingest(record)
REDUCER ─ src/replay/reducer.mjs
  per-stream state + decoded L2 events; duplicates, out-of-order, sequence skips, stalls, gaps
  used identically live (recorder) and offline (derive/replay) — they cannot disagree
                     │
        ┌────────────┴─────────────┐
        ▼                          ▼
LIVE (studio UI, SSE)      DERIVE ─ src/replay/derive.mjs
  shapes.report() live      events / streams / timeline / records-<rule> / family-* datasets
                            ASSEMBLED, DOM_BLOCKS, RECEIPT (metadata-only), fidelity breakdown
                                     │
                                     ▼
INTEL ─ src/intel/
  corpus → schema induction → discoverModel → resolveModel (identity/linkage)
         → correlateActions / correlateRendered → buildGraph (TemporalGraph)
  MODEL · GRAPH · HYPOTHESES · entities dataset · KNOWLEDGE_STATUS
  learner: ScopedLearner (scopes instance>page>site>family>global) + Calibrator
                                     │
        ┌────────────┬───────────────┼─────────────────┬──────────────────┐
        ▼            ▼               ▼                 ▼                  ▼
STUDIO API      CLI             EXPORTS            MIRROR            LEARNER
 src/studio/   bin/studio.mjs   src/export/      src/mirror/        src/intel/learn.mjs
 /api/v1 +     derive, replay,  dataset,          route catalog,     proposals → review →
 legacy /api/  knowledge,       transcript,       template,         corrections → revert,
               learn, export    knowledge,        replay,           rollback (immutable
                               report, bundle,   synthesize,        revisions)
                               schemas           ws
```

### Layer boundaries

| Boundary | Rule |
| --- | --- |
| raw → decode | The reducer only ever consumes `session.records()`; raw bytes are never mutated. |
| decode → reducer | One `StreamReducer` implementation is shared by the live recorder and offline replay. |
| derive → intel | The knowledge layer is isolated: a failure is recorded (`MODEL.error` / `MODEL.stage`) and never invalidates the datasets written before it. Raw is never touched; everything is recomputable. |
| intel → surfaces | The studio API, the CLI, the exports and the mirror read the same stored artifacts — there is no second truth store. |

### What is stored where

| Artifact | Location | Rebuildable |
| --- | --- | --- |
| Raw records, manifest, seek index, stream locator | `sessions/<id>/raw/` | raw is the source of truth; the index and locator are derived |
| Decoded events, streams, timeline, rule records, family records | `sessions/<id>/datasets/*.jsonl` | yes — `derive` |
| Shapes, assembled documents, DOM blocks/turns, receipt, model, graph, hypotheses | `sessions/<id>/kv/` | yes — `derive` |
| Site profiles | `profiles/<name>/vNNNN.json` + `CURRENT` | versioned; rollback restores a pointer |
| Provider families | `families/<name>/vNNNN.json` + `CURRENT` | versioned |
| Learner state | `learner/learner.json` + `learner/history/` | immutable revisions; rollback is a new revision |

## 3. Optional backends

The optional engines are still loaded on demand (`bin/lib/capabilities.mjs`,
`src/studio/capabilities.mjs`), so a build that lacks one answers HTTP 501
`CAPABILITY_UNAVAILABLE` instead of failing. In the current tree both optional backends are
present:

| Capability | Module | Loaded for |
| --- | --- | --- |
| `derive` | `src/replay/derive-all.mjs` | `studio derive --full`/`derive-all`, `studio knowledge search`, `studio export schemas`, `POST /api/v1/sessions/{id}/derive-all`, `GET .../artifacts`, `.../schemas`, `.../graph/ranked`, `.../timelines`, `GET /api/v1/search` |
| `mirror` | `src/mirror/index.mjs` | `studio mirror serve`, `studio mirror routes`, all `/api/v1/mirrors*` routes |

The in-tree derivation path (`src/replay/derive.mjs`) remains the default used by
`record --derive`, by `POST /api/v1/sessions/{id}/derive` and by `POST /api/record/stop`.
