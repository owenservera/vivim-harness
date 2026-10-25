# Capture Studio — Step-back Assessment, Adjustments and Prioritized Worklog

## Current navigation — 2026-10-21 (source-first Opus sprints)

**Current Opus launch:** [Fast Build Sprint protocol](../../../../../../ops/capture-studio-build-sprints/LAUNCH.md) and [Sprint 01 — Trustworthy Continuity](../../../../../../ops/capture-studio-build-sprints/SPRINT-01.md). Follow the relative links or locate `workspace/aion/ops/capture-studio-build-sprints/` from repository root.

**Freshness / supersession:** This file preserves valuable *historical assessments, baseline metrics, work items W1–W18 and proposed sequencing* recorded against earlier source revisions. Its phrases “next run starts with W1 → W2 → W3”, priority ordering, required Opus-run tests, scorecard-before-commit and preselected algorithms **are no longer directives for Opus**. They are reference hypotheses/acceptance needs for independent QA. Opus reads current source first, investigates broad cross-layer leverage, chooses its own implementation sequence and does not create/execute physical tests. Keep underlying dated evidence; never promote earlier measured results to claims about current `main` without independent retesting.

**Sprint 01 changelog (2026-10-21, PENDING INDEPENDENT QA):** `7614d9a` C1 full-evidence corpus and event-sourced family records (`CorpusCollector`, `familyRecordsFromEvent`, kv `CORPUS_STATS`); `c4a4c54` C2 earliest-observation keyless ids, site-scoped graph keys, session-scoped `contains`, action edges always `preceded`; `8c1f5ee` C3 W7 in part: model/entities/hypotheses/graph persisted by `derive`, `studio model`, API routes; `8218e6c` C4 suggestion calibration loop. Decision and spec: `ops/capture-studio-build-sprints/DECISION.md`, `SPEC.md`.

**Context cleanup scope:** Annotations supersede stale operational guidance without deleting historical rationale, scores, or source references. QA remains separately owned by ChatGPT.

**Date:** 2026-10-21 · **Trigger:** Algorithmic Excellence Directive · **Baseline commit:** `fe1ebf3` · **Companion:** [ARCHITECTURE.md](ARCHITECTURE.md) (architecture and capability matrix)

This is a one-time planning run. It contains no new capability claims. The measured numbers come from `eval/results/baseline-2026-10-21.json` (synthetic ground truth; held-out fixtures were not tuned on).

## Owner-directed execution split — 2026-10-21 (supersedes conflicting testing instructions below)

**Capture Studio only. Current owner directive overrides the prior worklog's developer-run-test requirements.**

- **Immediate pre-commit test-thought dump (mandatory, no extra work).** Before **each implementation commit**, Opus writes or overwrites the single flat file [`QA-NEXT-TESTS.md`](QA-NEXT-TESTS.md) with what it **immediately** thinks ChatGPT should test for *that commit*: changed areas; likely failure modes; affected boundaries; and a few concrete input/expected-behavior examples where obvious. This is a quick direct brain dump from existing working context — **no extra verification, research, analysis/reasoning stage, code-graph traversal, test execution, benchmark run, or test code creation for the dump**. If nothing salient comes to mind, say so in one line. Stage the updated Markdown **in that same implementation commit**, not in a separate preliminary commit. Replace the file each time; Git history preserves previous handoffs. No claims of passing tests or proven defects. ChatGPT independently determines, designs, and executes the actual tests.
- **Claude Opus — uninterrupted implementation owner.** Build and improve the code through deep reasoning, internal-world-model simulations, virtual code/graph traversal, dependency and call-path inspection, and mental execution. **Do not create physical test files, run unit/integration/E2E test suites, execute benchmark harnesses, run independent test campaigns, or spend implementation cycles physically validating speculative cases.** Treat internal simulations as predictions, **never as executed tests or acceptance proof**. Do not make claims like “tests pass” without an actual external QA receipt.
- **ChatGPT — independent real-testing owner.** Read the latest committed source; physically run actual tests, adversarial experiments, differential/randomized cases, integration and performance checks where runtime is available; own reproducible inputs, outcomes, evidence, regression criteria, independent acceptance and follow-up verification. Real Windows/Chrome-only checks require an authorized local runner; ChatGPT assesses returned raw receipts and does not claim local execution. The testing owner may maintain test code/artifacts independently; Opus should not duplicate them.
- **Nonstop development — owner-controlled stop only.** Opus **does not pause or wait for QA, milestone acceptance, defect triage, status responses, code review, test results, or agent handoffs**. After committing and pushing each safe increment (with its immediate QA thought dump), continue directly to the next highest-value implementation work. ChatGPT testing, findings and acceptance run **asynchronously relative to Opus's work process** when invoked; Opus incorporates feedback as it arrives without halting its broader development effort. **Only an explicit owner stop/pause directive stops ordinary development.** This does not authorize unsafe/destructive operations; existing repository rules still require holding the specifically risky operation when a concrete cascading deletion, irreversible data loss, credential exposure, destructive dependency change, or similar serious hazard is identified. Continue unrelated safe work in that case. GitHub issues and commits do not automatically wake either agent; uninterrupted execution depends on its actual active runtime/session, not a promise of background operation.
- **Milestone cadence.** Opus develops continuously through significant integration milestones. ChatGPT performs comprehensive external testing at: **A: schema + identity + learning**, **B: capture + streaming + storage + replay**, **C: CLI/localhost integration + behavior and reconstruction**. Earlier independent feedback is reserved for high-impact boundary risks, particularly identity-to-learning/persistence corruption and pre-disk credential exposure.
- **Release/acceptance boundary.** Opus can mark implementation **code-complete/pending independent QA** and commit/push ordinary safe implementation changes without test-run claims. A feature is **verified/accepted** only after ChatGPT's real test evidence (plus local host receipts where necessary). Test failures return to Opus as concise reproductions, inputs, observed/expected behavior, blast radius, and the affected commit. Opus independently decides fixes using virtual analysis.
- **No redundant ceremony.** Existing W1–W18 scope, technical objectives and source-of-truth worklog remain in effect. References below to “tests pass” or “scorecards committed” become **external QA acceptance obligations**, not Opus's physical testing workload. Do not rewrite past execution history or silently claim an unexecuted check.
- **GitHub delivery.** GitHub issue(s)/commit(s) carry the implementation↔QA handoff. GitHub writes do not autonomously wake either agent; the owner relays the relevant issue/commit between conversations when necessary.

## 1. Measured baseline

| Metric | Dev | Held-out | Reading |
| --- | --- | --- | --- |
| Record-type discovery precision / recall | 1.00 / 0.80 | 0.94 / 1.00 | Strong |
| Field type accuracy | 1.00 | 1.00 | Strong, but the fixtures are easy for types |
| **Identity-key accuracy** | **0.50** | **0.50** | **Dominant weakness** |
| Field role accuracy (learned / deterministic baseline) | 0.82 / 0.82 | 0.73 / 0.70 | Learner barely beats rules; no feedback measured yet |
| Tagged-union discriminator | n/a | 1.00 | Good on one fixture |
| Relationship precision / recall | 0 / 0 | 0.67 / 0.67 | Collapses whenever keys are wrong |
| Role confidence ECE | 0.13 | 0.11 | Miscalibrated (overconfident) |
| Keyless rerender linkage F1 | — | **0.00** | A long text field was chosen as the "key", so linkage never ran |
| Entity counts | — | ticks 60 vs 5, orders 23 vs 6 | Same root cause: wrong keys |
| Raw→rendered correlation, top-1 | 1.00 | 1.00 | Fixtures are too easy (no near-duplicates) |
| Drift rename repair / cross-site alignment | — | 1.00 / 1.00 | Good on small fixtures; untested at scale |
| Discovery latency | 20–4,500 ms per 1k samples | | Small-sample outliers; needs a size sweep |

### Root-cause analysis of the key failure

`inferKey` rewards *uniqueness per observation*. When a stream carries revisions of a few entities, volatile fields (`ts`, `revenue`, `total`, `at`) are unique per observation and win. The true keys (`symbol`, `row_key`, `service`, `order_ref`) repeat by design.

The correct signal is the inverse: **a key is a field whose value partitions observations into groups that are internally coherent (their stable attributes agree) and externally distinct.** That is functional-dependency and revision-stability evidence, plus a penalty on fields the role model classes as measure, timestamp or text. This one fix should lift keys, relationships, entity counts and linkage together. It is the highest-leverage item in the plan.

## 2. Code-review findings (directive §3), with verdicts

| # | Finding | Verdict | Planned fix |
| --- | --- | --- | --- |
| R1 | The graph stores revision metadata but not historical attribute values, so past state can't be reconstructed | **Confirmed.** `upsertEntity` writes full attrs only on the first revision; `stateAt` returns membership only | Event-sourced revisions carrying the changed field values; checkpoint every N revisions; `stateAt(t)` materializes attributes and edges |
| R2 | Credentials can be split across network chunk boundaries | **Confirmed** (documented limitation in `redact.mjs`) | Per-stream carry-over scanner with a 4 KB overlap window. Masks spanning chunks are applied to the next chunk's prefix and recorded on both chunks; the previous chunk is already written, so its span is listed as a "late mask" and also applied on replay and export |
| R3 | Instance overrides lack entropy/calibrated fields, and the override key uses `typeKey`, which is unstable across sessions | **Confirmed** | Return the full prediction shape; key overrides by a structural fingerprint (type signature + field path), not the session-local group |
| R4 | Single-field blocking and union-find chain merges | **Confirmed** | Multi-pass blocking (union of several blocking keys); pairwise scores retained; cluster-level coherence check (split clusters whose internal minimum link score is below threshold, a correlation-clustering repair); temporal constraint (two observations at the same instant in the same stream can't be one entity unless identical) |
| R5 | Order-dependent type merging; bounded sampling drops rare structures | **Confirmed.** `mergeTypes` is greedy and first-come; `slice(0,500)` and `VAL_CAP` keep only the head | Order-independent merging (compute all pairwise similarities, then average-linkage agglomeration with a threshold). Reservoir sampling plus a rare-structure reservoir keyed by field-set signature, so every distinct shape keeps at least k exemplars |
| R6 | Overconfident causal attribution | **Partly confirmed.** The threshold exists, but timing dominates the features | Require mechanism evidence (CDP initiator stack/URL, request issued by the page target in the action's task window) for "causal"; otherwise cap at "temporal"; calibrate on fixtures with deliberate decoys |
| R7 | Incomplete graph edge and version semantics | **Confirmed.** Edges have no validity interval or history | Edges get `validFrom`/`validTo`, a status history and evidence lists; the `same_as` merge is reversible |
| R8 | v2 modules aren't wired into `derive` | **Confirmed** | `derive` runs corpus → discover → resolve → correlate → graph and persists `MODEL`, `GRAPH`, `HYPOTHESES` and `QUESTIONS` |
| R9 | No adversarial tests for v2 | **Confirmed** (only `schema.mjs` has tests) | Per-module adversarial unit tests (list in §4) |

Additional finding from the step back:

- **R10.** Correlation and identity fixtures are too clean, which inflates scores. Add near-duplicate messages, repeated boilerplate, partial renders, and one-to-many and many-to-one renderings.

## 3. Selected adjustments to direction

1. **Evaluation is the steering wheel, and it gets stricter first.** Freeze the current fixtures as `dev`/`heldout v1`. Add `heldout v2` (adversarial: near-duplicates, contradictions, interrupted streams, large sizes) before tuning. Every algorithm change lands with before/after scorecards in `eval/results/`.
2. **Dependencies become a measured decision, not a principle.** Keep Node/ESM as the runtime. Candidates to benchmark against, not adopt by default:
   - **Schema inference:** GenSON and quicktype, as reference baselines in a dev-only harness.
   - **Record linkage:** Splink (Python, dev-only comparison via exported CSV) and a JS Fellegi–Sunter with EM.
   - **Graph:** Graphology, if graph queries outgrow plain Maps.
   - **Validation:** Ajv, for emitting and checking JSON Schema from induced schemas. This is the most likely runtime dependency because it's mature and small.
   - **Text similarity:** a BM25/TF-IDF implementation in-tree; optional local embeddings later.

   Python stays dev/eval-only unless a benchmark shows a runtime win.
3. **Relevance intelligence is a new first-class layer** (directive §1.E). Every field, entity, stream and DOM block gets three independent scores: human relevance, machine relevance and reconstruction necessity. Each score has its features and confidence. This **organizes and prioritizes; it never discards evidence**.
4. **Behavioural intelligence is a new layer** (directive §1.G): state-transition graphs and process mining over the action→request→state timeline.
5. **Security stays proportionate.** It keeps loopback-only DevTools, the token-cookie studio, the credential policy and the chunk-boundary fix (R2). No new identity systems, policy engines or interception. Existing protections are already at the right weight.
6. **The UI waits for the engine.** It's integrated only after items P1–P3 are measured, to avoid building screens on top of known-wrong keys.

## 4. Prioritized worklog

Each item is done only when its tests pass, its scorecard delta is committed, and the change is pushed. Priority order follows directive §6.

### P0 — Correctness of what exists (highest leverage first)

| ID | Work | Acceptance |
| --- | --- | --- |
| W1 | **Key inference rewrite:** partition coherence + functional dependency + revision stability + role penalties; optional compound keys (two fields) when no single field qualifies | Key accuracy ≥ 0.9 dev **and** held-out v1; tick/order entity counts exact |
| W2 | **Order-independent type merging** (pairwise + average linkage) + **reservoir and rare-shape sampling** | Shuffled-input test gives an identical model; a rare variant (1 in 2,000) is still discovered |
| W3 | **Identity v2:** multi-pass blocking, EM-estimated m/u, cluster-coherence splitting, temporal constraints, duplicate vs revision classification | Keyless rerender F1 ≥ 0.9; adversarial near-duplicate F1 reported; no chain merges in a dedicated test |
| W4 | **Chunk-boundary credential scanning** (R2) | A JWT split across 2 and 3 chunks never appears unmasked in raw, events, exports or derived data |
| W5 | **Learner fixes** (R3) + end-to-end learning eval (`eval/learning.mjs`): improvement after N corrections, contamination check, revert, promotion | Corrections on site A improve family-scoped site B; unrelated site C unchanged (byte-identical predictions); revert restores the baseline |
| W6 | **Causal attribution with mechanism evidence** (R6) + decoy fixtures | No "causal" label without mechanism evidence; decoy false-causal rate reported |

### P1 — Make the full pipeline operational on recorded sessions

| ID | Work | Acceptance |
| --- | --- | --- |
| W7 | Wire v2 into `derive` (R8): persist MODEL, GRAPH, HYPOTHESES and QUESTIONS; expose via CLI (`studio model`, `studio graph`, `studio questions`) and API | The E2E universality sessions produce models whose keys and relationships match the fixture ground truth |
| W8 | **Temporal graph v2** (R1, R7): attribute-level event sourcing, checkpoints, edge validity intervals, `stateAt(t)` with full attributes, field-level diffs, retractions | Property test: replaying to any t equals the independently computed state; stream corrections and retractions handled |

### P2 — Strengthen the hardest algorithm families

| ID | Work | Acceptance |
| --- | --- | --- |
| W9 | Schema: maximum-weight bipartite field alignment (Hungarian) replacing greedy; probabilistic matcher combining name, value-distribution (KS/Jaccard of values) and structure; change-point detection on schema presence over time | Alignment accuracy on held-out v2 cross-site pairs; drift detected within N events of a change |
| W10 | Correlation v2: evidence fusion (log-odds sum of text, structure, timing and value features), global assignment via Hungarian with one-to-many allowance, tree similarity for DOM subtrees, conflict-aware ranking | Top-1 and likely-precision on adversarial correlation fixtures; ambiguity flagged rather than guessed |
| W11 | **Relevance layer** (new): 3-dimension multi-label classifier (features: role, entropy, rendered-or-not, action linkage, protocol position, change rate), with calibration and per-user adaptive weights | Labelled held-out set; per-dimension F1 and ECE reported; nothing dropped from storage |
| W12 | **Benchmark harness against established tools:** GenSON/quicktype (schema), Splink (linkage), Ajv (schema validation); a scorecard per family | `eval/results/comparison-*.md` with retain/replace decisions per family |

### P3 — Adaptive learning and behaviour

| ID | Work | Acceptance |
| --- | --- | --- |
| W13 | Selective prediction (abstain below calibrated threshold → becomes an active-learning question); concept-drift detection on role distributions; contamination detection (a correction whose effect on other scopes exceeds bounds) | Abstention trades coverage for accuracy measurably; drift alarms on held-out drift fixtures |
| W14 | **Behavioural layer** (new): UI-state abstraction (DOM structure + URL + key entity states), state-transition graph, process mining over sessions (directly-follows graph, frequent paths), pre/post-conditions of actions, probabilistic transitions | The multi-page workflow fixture yields the correct step graph; a missing transition is reported as unobserved |
| W15 | Reconstruction validation: coverage estimation, graph consistency checks, fidelity score per entity and screen, observed vs inferred vs unavailable labels | A fidelity report per session; inferred items never presented as observed |

### P4 — Integration and acceptance

| ID | Work | Acceptance |
| --- | --- | --- |
| W16 | UI: model and graph explorer, hypotheses (confirm/reject → learner), questions, relevance views, time travel with full state, families library, fidelity panel | Each action changes stored learning/profile state and the next derive output (E2E) |
| W17 | Windows: PowerShell launcher, first-run flow, README; real Chrome run; chatgpt.com field run per EXPERIMENTS.md | Receipts in the capability matrix (REAL WEBSITE / WINDOWS rows) |
| W18 | Optional level-3 semantic assist (local or external LLM) behind a provider interface, off by default | Measured naming/role gain on held-out data; works fully with it disabled |

## 5. Sequencing and checkpoints

- **Next run starts with W1 → W2 → W3.** All three are blocked by nothing and share the eval harness. Then W4–W6 in parallel-safe order, then W7–W8.
- **Checkpoint A** (after W1–W6): the scorecard shows key ≥ 0.9, linkage F1 ≥ 0.9, a learning-improvement delta and zero contamination.
- **Checkpoint B** (after W7–W8): the full pipeline runs on recorded E2E sessions; time-travel state is verified.
- **Checkpoint C** (after W9–W15): comparative scorecards committed with retain/replace decisions.
- Then UI and Windows acceptance (W16–W18).

## 6. Risks and open questions

- **Synthetic-fixture overfitting.** Mitigated by held-out v2 and, later, real sessions. The real-site distribution is still unknown.
- **Key inference on low-repetition data** (one observation per entity) can't use revision stability. It falls back to role + uniqueness and must say "weak" honestly.
- **Splink and other Python comparisons** need a Python runtime in the dev environment only. That's acceptable; it isn't shipped.
- **chatgpt.com transport and DOM** remain unobserved by this tool. W17 is the only way to retire that risk.
