# CORE → Windows handoff · Capture Studio · 2026-10-22

**Owner:** AION Capture Studio CORE. **Scope:** short L0/L1 integration handoff; no extra development sprint. **Proof boundary:** preparation and committed source are not proof of an owner-PC execution.

This supplements QA's [Windows integration rounds](https://github.com/owenservera/aion/blob/main/workspace/aion/qa/capture-studio/LOCAL-INTEGRATION-ROUNDS-2026-10-22.md). The actual Windows checkout SHA is the testing authority; QA's earlier a18407def pin is a historical source-inspection reference, not a mandate to reset the owner's local master.

## 1. Windows quick execution

From the Capture Studio folder containing bin/studio.mjs, in PowerShell:

    git rev-parse HEAD
    git status --short
    node --version

    # L0: CLI + isolated temporary localhost Studio API. No Chrome launch.
    node scripts/core-local-handoff.mjs l0

    # L1: synthetic fixture, isolated Chrome/data; runs no provider prompt.
    node scripts/core-local-handoff.mjs l1

Node **>=22** is required; there are no runtime npm dependencies, and Bun/WSL are not required. Chrome or Edge is needed for L1. Do not use Playwright or Puppeteer.

**Runner:** scripts/core-local-handoff.mjs. L0 invokes the real CLI help, version, paths, doctor and isolated session listing; starts only a new Studio server on an ephemeral port and checks GET / and GET /api/status before terminating its own server process. L1 delegates to existing scripts/live-e2e.mjs --keep, which generates a local HTTP fixture with a separate temporary Chrome and data root. It does not touch or close the user's regular Chrome/profile. It uses the existing capture → sessions → verify → derive → search → exports → mirror → local UI/API integration sequence. An interrupted L1 runner can leave a synthetic fixture process; inspect and clean **only that fixture-owned process**, never mass-kill Chrome.

**Local evidence destination:** default %LOCALAPPDATA%\AION\capture-studio\integration-runs\{run-id}\round-L0|round-L1\, or CAPTURE_STUDIO_HOME/integration-runs. Optional --out points to another directory **outside the entire Git repository**. Each round creates:

| File | What it contains |
| --- | --- |
| run.json | Actual source SHA, dirty file count, Node/platform, run timestamps and status |
| steps.jsonl | Step name, observed status, duration, CLI exit/HTTP status where available, evidence ID |
| metrics.json | Counted passes/failures/skips, UI/API HTTP codes or fixture counts; unmeasured resources are null |
| failures.jsonl | Minimal source-owned reproducer IDs, without prompt/body/credentials |
| summary.md | Brief outcome and handoff limits |
| private/ | Original local stdout/stderr, disposable diagnostic home and other machine-only context |
| shareable/ | Metadata-only copies of the five top-level files; **review before sharing**, nothing uploads automatically |

For L1 the actual upstream fixture result lives separately in a temp directory. The exact location appears in private/synthetic-e2e.stdout.txt; it is not automatically copied to GitHub. The runner reports PASS, FAIL or PARTIAL (SKIP or Chrome-missing diagnosis makes a PARTIAL result). Exit 0 can mean PASS **or PARTIAL**; read run.json.status. Exit 1 means FAIL, exit 2 means usage/unsafe destination.

Resource memory/CPU and all actual real-provider sends remain **unmeasured/not attempted** by L0/L1. Never turn null into zero or a source-built script into an executed Windows receipt.

## 2. Exact existing CLI and startup contract

| Task | Command | Runtime meaning |
| --- | --- | --- |
| Health/doctor | node bin/studio.mjs doctor --json | Checks Node, Chrome, CDP, configured writable home, sessions, profiles, learner, config |
| Paths | node bin/studio.mjs paths --json | Returns root, sessions, profiles, families, learner, chromeProfile, exports, config |
| UI-only startup | node bin/studio.mjs serve --no-open --studio-port 7878 | Loopback UI, **no browser launch** |
| First-run startup | node bin/studio.mjs start | Opens/reuses dedicated capture Chrome and Studio UI |
| Chrome-only | node bin/studio.mjs launch | Separate Chrome profile and loopback CDP (default 9222) |
| Targets | node bin/studio.mjs targets --json | Read target list; requires reachable capture Chrome |
| Sessions | node bin/studio.mjs session list --json | Read saved local session metadata |
| Verify evidence | node bin/studio.mjs verify ID --json | Raw hashes/sequence/gap check, exit 4 when invalid |
| Re-derive | node bin/studio.mjs derive ID --full --json | Rebuild derived data from raw, never rewrite source raw |
| Metadata receipt | node bin/studio.mjs receipt ID --json | Derivation/transport diagnostics, **not acceptance proof** |
| Offline chat preview | node bin/studio.mjs chat chatgpt --prompt "Hello" --json | Does not touch Chrome or send |
| **L2 only** send | node bin/studio.mjs chat chatgpt --prompt "Hello" --execute --json | Exactly one intentional real website send; **not run by L0/L1** |

**Data root:** %LOCALAPPDATA%\AION\capture-studio by default; CAPTURE_STUDIO_HOME or --data-dir may override. Default Studio port 7878; default CDP 9222. Local UI at http://127.0.0.1:7878/ has **no token login** in local mode. CAPTURE_STUDIO_ACCESS_MODE=token restores token mode. Host/Origin and loopback checks remain. CAPTURE_STUDIO_CAPTURE_MODE=local-raw preserves locally observed headers/URLs/content, including possible cookies; filtered mode is optional.

**Exit codes (CLI):** 0 success, 1 runtime error, 2 bad usage, 3 not found, 4 integrity/state, 5 environment. In L0 the doctor may report Chrome missing (exit 5); if every other check succeeds, this is **PARTIAL**, not a fabricated full PASS.

## 3. Recorder, derivation and trust boundary

- Source raw records: sessions/ID/raw/*.jsonl; append-only evidence and declared coverage gaps, plus rebuildable indexes.
- Derived protocol: sessions/ID/datasets/events.jsonl, streams, timeline, records, JSON/Markdown exports.
- Rendered evidence: sessions/ID/kv/DOM_* and recorded DOM observations in raw.
- Semantic knowledge: model, entity dataset, graph, hypotheses and KNOWLEDGE_STATUS. NSP contradictions/collisions produce **partial** graph integrity rather than silently merging.
- Integrity: a successful verify means raw hash/sequence accounting worked for that session. It **does not establish** reply completeness, calibrated identity, real-world truth, or learner acceptance. A synthetic fixture result is only synthetic proof.
- No local capture/Chrome data is automatically pushed with the source. Explicit use of an online AI provider is an external browser action; none is performed in L0/L1.

## 4. Actual limitations to preserve in feedback

1. **One turn per conversation:** conversation-service.mjs currently enforces ONE_TURN_LIMIT after typing/sending. This is known product scope, not an unexpected L0/L1 test failure or an invitation to create a new idempotency key.
2. **Unknown delivery:** after possible send, lack of acknowledgement yields needs-reconciliation. Reconcile is read-only; never blindly send again. Keep original tab, send status, conversation ID and local evidence for QA.
3. **Browser actor ownership:** the exact tab and shared lease remain necessary to prevent competing writes/duplicated effects. Do not use local handoff to take control of the owner's normal Chrome.
4. **Local-first UI defaults:** older docs/LIVE-TEST.md sections about mandatory token, redaction and simulated human behavior are obsolete relative to current docs/LOCAL-FIRST.md and current source.
5. **No independent acceptance:** real Windows bootstrap, Chrome/CDP, authorized one-turn provider send, cancellation and recovery, temporal/learner value, resource scaling and Track B integration need L0–L5 empirical receipts. No automatic broad feature expansion based on source-only confidence.
6. **Data eligibility:** a derived entity or graph is not, by itself, accepted learner training material. The clean-data acceptance boundary remains a tracked CORE/L4-L5 integration seam.

## 5. Ownership and iteration contract

QA owns round sequencing, classification and sanitized evidence feedback. A failing case is linked as {run-id}/{round}/{step}, expected → observed → reproducer → impact → owner → source SHA. CORE owns CLI, CDP, capture, replay/derive, server and lease backend. UI owns navigation and recovery presentation. L4/L5 owns temporal/identity/learning evaluation. Systems owns observability/coverage. Value Oracle owns source-linked usefulness.

After a CORE fix, the local team reruns the **same failing case plus one neighboring regression**, not another full, unfocused feature cycle. The goal is a functioning PC-local product, not new security paperwork.
