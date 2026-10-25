# QA-NEXT-TESTS — immediate build handoff (NOT VERIFIED)

Sprint 02 read-through continuity added; implementation is **PENDING INDEPENDENT QA**. No tests were executed by the build agent.

Please physically verify:
- Two saved sessions on the same site and same stable keyed `eid` yield one cross-session entity, correct session list, ordered revision history, and latest folded attributes.
- `--at` / API `at` before and between session dates omit future session membership and future values; missing/invalid timestamps do not create historical claims.
- Same key on unrelated sites does not join. Keyless matches remain session-local. Missing or renamed types are not silently merged.
- Partial revisions carry earlier attributes forward; absent field is not interpreted as deletion. Untimed revisions are disclosed and excluded from time-asserted attrs.
- Failed, non-derived and deleted sessions: visible completeness counts and immediate recomputation from remaining sessions.
- CLI `studio continuity <id|latest>`, `--eid`, `--at` and API `/api/sessions/:id/continuity`: output and error handling.
- Large history scans: latency and memory behavior; no hidden scan cap or missing derived knowledge.
- Regression of Sprint 01 C1-C4 and cross-session eids across schema changes. Revisit per-site tenant collisions and unstable representative `type.id`.

Design caveats for QA: join is conservative and exact; types renamed across captures may remain unjoined. No per-site database or temporal deletion/retraction semantics added. The source-only commits preceding this combined checkpoint could not include the rolling QA note atomically; this note covers their combined implementation scope and does not retroactively claim compliance or validation.

Independent QA temporal-graph follow-up: verify undated edges and nodes never appear at an arbitrary past stateAt(t); dated action/rendered hypotheses appear no earlier than evidence time; rejecting an edge now preserves its earlier accepted/hypothesis state. Concurrency with the external QA-owned temporal regression file was preserved. No test suite executed by the build agent.

Studio continuity UX QA: in Sessions inspect Load same-site knowledge, optional as-of datetime, Details/history of a keyed entity, empty/no-model sessions, incomplete-derivation warning and HTML escaping of captured values. No UI or browser checks by implementation agent.

Completeness follow-up: a session with MODEL but no entities dataset must be counted as missing derived knowledge, not silently treated as an empty successful model. Verify unavailable-session counts and no fabricated joined groups.
