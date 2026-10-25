# Native response-shape atlas — ChatGPT vs Claude (side-by-side)

**Version 1 · 2026-10-24.** Companion to the machine-readable `atlas.json` (`aion.shape-atlas/1`,
regenerate with `node scripts/shape-atlas.mjs --sessions <home>/sessions --out docs/shape-atlas`).
Per-provider contracts: [chatgpt.md](chatgpt.md) · [claude.md](claude.md).

The three evidence columns are never conflated: **(A)** AION saved-source/coded observations,
**(B)** official product documentation, **(C)** provider model-API references as research
vocabulary only. No row in this atlas is a live harness acceptance.

## Side-by-side core axes

| Axis | ChatGPT WEB | Claude WEB |
| --- | --- | --- |
| Durable thread identity | `/c/<uuid>` parsed by source (`chatgpt-c:<uuid>`) — SOURCE+SYNTHETIC | none integrated — org metadata observed historically — SOURCE leads, live UNKNOWN |
| Reply stream | path-ops over SSE on `/backend-api/f/conversation` — SOURCE, map `chatgpt-path-ops` — SYNTHETIC fixture 8 payloads | Connect/protobuf `StreamTimeline` — SOURCE leads; field `1.1.5.9` hypothesis — **no verified reconstruction** |
| Typed parts | DOM enum rich (heading/list/table/code/quote/image/file/citation/equation — SOURCE); stream build currently message/paragraph — SYNTHETIC | typed-events map — SYNTHETIC fixture 13 payloads; real-traffic part build UNKNOWN |
| Reasoning display | PRODUCT (model/mode-dependent summaries) | PRODUCT (thinking indicator + expandable summaries) |
| Citations/research | PRODUCT; historical reference fields SOURCE | PRODUCT |
| Editable outputs | writing/code blocks — PRODUCT | Artifacts with versions — PRODUCT |
| Agentic surfaces | Work tasks — PRODUCT | Cowork tasks — PRODUCT |
| Projects/context | PRODUCT (files, memory, connectors) | PRODUCT (project knowledge, connectors) |
| Guest access | 403 from datacenter (sandbox REAL receipt) | login wall (sandbox REAL receipt) |
| Freshness/acceptance | pre-send baseline enforced in G1/G2 — SOURCE+SYNTHETIC+real-Chrome fixture | same gates apply; no real reply corpus yet |

## Sandbox live receipts (REAL, 2026-10-24 — dispatch-only, no model reply)

| Provider | Observed | Refused at |
| --- | --- | --- |
| duck.ai (guest) | dispatch landed: user turn rendered, `?chatID=<uuid>` assigned; consent gate once | provider generation ("temporarily unavailable", anonymous code 02f8) |
| chat.z.ai | composer found via measured selector; typed + sent via real composer | site "Network error"; page wedges CDP `Runtime.evaluate` |
| huggingface.co/chat | composer found, text typed via CDP input pipeline | site send control never enabled (framework state); no dispatch |

Full machine receipts incl. per-session endpoint/transport/maps: `atlas.json` → `sandbox`.
Failure-path sessions are real, derived captures with honest `capture_incomplete` verdicts —
valuable raw evidence, never verified semantic outputs.

## Implementable-now contracts (what a coding agent can pick up)

1. `aion.web-observation/1` — `src/shapes/observation.mjs` + `GET /api/v1/sessions/{session}/observation`: loss-aware projection (unknown parts preserved with loss markers; identity only from the supported parser; five distinct completion facts).
2. `aion.capability-capsule/1` — `src/capture/conversation-capsule.mjs` + `GET /api/v1/conversations/{id}/capsule`: page-local supported/unavailable/unverified with observed reasons; never a bypass.
3. Durable harness runs — `src/capture/harness-runs.mjs` + `/api/v1/harness/runs*` + `studio run …`: idempotent keyed steps over the same runtime owner.
4. Freshness gates — `src/capture/acceptance.mjs` v1.1.0: pre-send baseline cursor (Core #68 closed at the source level).
5. Provider contract expansion path: add per-provider `stream-map` entries + measured selectors; the projection/capsule/atlas pick them up without schema changes.

## Explicit gaps (also enforced as negative tests)

- Unknown native parts must survive projection (`test/unit/observation.test.mjs` E00).
- Guest query-param identities are never durable (`observation.test.mjs` E03, duck-ai case).
- Unverified sites read unavailable-with-reason, never fake success (`conversation-capsule.test.mjs` E08).
- Historical text can never satisfy freshness (`acceptance-baseline.test.mjs`).
- No Claude reply reconstruction, no authenticated ChatGPT/Claude fresh observation, no artifact/task parse — all listed in `atlas.json.gaps`.
