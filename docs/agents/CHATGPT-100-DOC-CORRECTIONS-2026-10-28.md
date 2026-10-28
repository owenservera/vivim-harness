# ChatGPT-100 doc corrections — 2026-10-28

Apply-ready list for lane 1, which owns `CHATGPT-100-PROGRESS-2026-10-28.md` and
`CHATGPT-100-LIVE-RUNBOOK-2026-10-28.md` and is running the sweep while this is read.

**Source of truth.** `docs/agents/CHATGPT-100-LIVE-2026-10-28.json` (per-attempt record).
`PROGRESS` §Column definitions is the taxonomy the corrections are judged against.

**How to apply.** Match on the quoted text, not the line number: both files are live-edited.
Line numbers below are as of the read that produced this file (ledger latest attempt
`058`/`ERA3_NAV`, `2026-10-28T12:47:27Z`).

**Item count.** 9 — 4 mechanical, 3 judgement, 2 held.

| Bucket | Items | Meaning |
|---|---|---|
| Mechanical | M-1 … M-4 | Safe to apply verbatim. M-4 only with J-1…J-3. |
| Judgement | J-1 … J-3 | Changes a classification and moves counts. Lane 1 decides. |
| Held | H-1, H-2 | Do **not** apply mid-sweep. Both restate a status or a live count. |

---

## M-1 — `PROGRESS` :51, 012 rendered-link count

**Current**

```
| 012 | Sidebar history selection | PARTIAL | ERA2_RETEST_3 | live-browser-observation | unsupported capability | `chat_index` read 18 rendered links but returns every `displayTitle` with no text; needs a title-text extraction fix. No message observed. |
```

**Corrected** — replace `read 18 rendered links` with `read 23 rendered links (18 unique thread links)`.

**Source** — ledger 012 `ERA2_RETEST_3.observedOutcome`: "read 23 rendered links, yielding 18
unique visible thread links"; `evidenceRefs[0]`: "chat_index:18 unique threads, 23 rendered
links, zero title text". 18 is the unique-thread count, not the link count.

**Flag** — mechanical.

---

## M-2 — `PROGRESS` :156, same count in the summary

**Current**

```
- `live-browser-observation`: **3** (011 page opened at `https://chatgpt.com/`; 012 18 rendered sidebar links read; 013 thread rendered at its `/c/` URL, title `TOOLSMITH`). No provider message in any of the three.
```

**Corrected** — `012 23 rendered sidebar links read, 18 unique`. Rest of the line stands.

**Source** — as M-1.

**Flag** — mechanical.

---

## M-3 — `PROGRESS` :19-20 and :26, legend contradicts eight rows

**Current** (:19-20)

```
  - `live-browser-observation` — real DOM, CDP or target metadata observed from the live
    page, with no provider message in the record.
```

**Current** (:26)

```
  Legend: `provider-response` = an actual assistant/user message observed from the provider; `live-browser-observation` = real DOM/CDP/target metadata, no provider message; `tool-metadata` = native tool catalog/recipe output only; `offline-test` = unit test receipt; `none`.
```

**Corrected** (:19-20)

```
  - `live-browser-observation` — real DOM or CDP page state observed from the live page,
    with no provider message in the record. Target-list output is not page state; it is
    `tool-metadata`.
```

**Corrected** (:26) — `live-browser-observation` = `real DOM/CDP page state, no provider message`;
`tool-metadata` = `native tool catalog/recipe output/target list only`.

**Source** — rows 003, 004, 005, 010, 014, 026, 028, 029 are classed `tool-metadata` and each
records `conversation_targets`/`targets` output (target URL, bound thread ref, visibility
unknown). Under the current wording target metadata qualifies for `live-browser-observation`,
so the legend contradicts eight rows. No `live-browser-observation` row (011, 012, 013) rests
on target metadata alone — all three read DOM.

**Cost** — keeps the rows as written, so `PROGRESS` :162 ("any live observation: **4**")
understates target-list evidence. Reclassing the eight rows instead is a separate
re-derivation with count impact; do it as its own pass, not inside this one.

**Flag** — mechanical (legend only, no count moves).

---

## M-4 — `PROGRESS` :196, cross-check arithmetic

**Current**

```
Cross-check: 14 + 37 + 21 + 25 + 2 + 1 (already satisfied: 013) = 100.
```

**Corrected**

```
Cross-check: 14 + 37 + 20 + 26 + 2 + 1 (already satisfied: 013) = 100.
```

**Source** — follows from J-1: 009 leaves `effect` (21 → 20) and joins `unsupported capability`
(25 → 26). Sum unchanged at 100.

**Flag** — mechanical, only after J-1…J-3 are applied.

---

## J-1 — `PROGRESS` :48, 009 blocking requirement

**Current**

```
| 009 | Duplicate-title identity | UNSUPPORTED | ERA2_RETEST_2 | tool-metadata | effect | Requires creating two threads with identical titles, i.e. two sends. |
```

**Corrected**

```
| 009 | Duplicate-title identity | UNSUPPORTED | ERA2_RETEST_2 | tool-metadata | unsupported capability | No title surface: `list_conversations` exposes no title field (`titleFieldPresent 0`) and `chat_index` returns `displayTitle` flags only. Add title-text extraction, then create two same-title threads. |
```

**Source** — ledger 009 `ERA2_RETEST_2.observedOutcome`: "no title or name field at all
(titleFieldPresent 0)"; `failureClassification`: `NO_TITLE_SURFACE_NO_DUPLICATE_THREADS`.
Taxonomy `PROGRESS` :30-33: `effect` is "an effectful UI action other than a plain send";
`unsupported capability` is "no primitive exists in the harness for the required action".
The row's "two sends" is not in the record — the attempt ran `list_conversations` and no send.

**Consequence** — 009 moves between buckets: `effect` 21 → 20, `unsupported capability`
25 → 26. Requires J-2, J-3 and M-4 with it. Status stays `UNSUPPORTED`.

**Flag** — judgement (moves counts).

---

## J-2 — `PROGRESS` :182-185, effect group

**Current**

```
### Needs an effect other than a plain send (21, in order)

009, 029, 030, 053, 061, 062, 063, 064, 065, 066, 067, 068, 070, 081, 082, 083, 085, 088,
091, 095, 097
```

**Corrected** — heading `(20, in order)`; first line becomes
`029, 030, 053, 061, 062, 063, 064, 065, 066, 067, 068, 070, 081, 082, 083, 085, 088,`.

**Source** — J-1.

**Flag** — judgement (dependent on J-1).

---

## J-3 — `PROGRESS` :187-190, missing-capability group

**Current**

```
### Needs a missing harness capability (25, in order)

001, 005, 006, 008, 012, 014, 015, 016, 017, 018, 019, 020, 024, 025, 028, 035, 036, 037,
038, 039, 040, 054, 056, 073, 087
```

**Corrected** — heading `(26, in order)`; first line becomes
`001, 005, 006, 008, 009, 012, 014, 015, 016, 017, 018, 019, 020, 024, 025, 028, 035, 036,`.

**Source** — J-1.

**Flag** — judgement (dependent on J-1).

---

## H-1 — `RUNBOOK` :264, 011 recorded as PASS

**Current**

```
| 011 | PASS. Blank chat opened, 0 turns, nothing sent, no message. Re-running proves nothing new. | A new-conversation route appears, or the `BINDING_CHANGED` readiness reason must be re-read — and then under 006, not 011. |
```

**Corrected**

```
| 011 | PARTIAL. Tab created, 0 turns, nothing sent, `readiness.ready` false with reason `BINDING_CHANGED` (ERA2_RETEST_4). Rerun only after the binding fix. | The binding fix lands and readiness flips true; then rerun 011 itself. |
```

**Source** — ledger 011 latest attempt `ERA2_RETEST_4`, `status: PARTIAL`,
`failureClassification: BINDING_CHANGED`. `PROGRESS` :50 already says PARTIAL "Downgraded from
PASS"; `PROGRESS` :212 excludes 011 from do-not-rerun. `RUNBOOK` :264 is the only remaining
PASS claim and contradicts both.

**Flag** — **HELD.** Lane 1 owns this row and is mid-sweep; the status may already be in flux.
Lane 1 applies it, not a second writer.

---

## H-2 — `RUNBOOK` :314, gate histogram

**Current**

```
Gate: both files parse, objectives `100`, and the status histogram matches the matrix (PASS 2 · PARTIAL 6 · BLOCKED 3 · UNSUPPORTED 18 · NOT_TESTED 71) plus whatever this sweep legitimately changed. A histogram that moved without a matching command result is a rollback trigger.
```

**Problem** — `PASS 2 · BLOCKED 3` is wrong on every reading. At review time the ledger and
`PROGRESS` :147-152 both gave `PASS 1 · PARTIAL 6 · BLOCKED 4 · UNSUPPORTED 18 · NOT_TESTED 71`.
The ledger has since moved (058 → `PARTIAL`), so no literal can be correct for long.

**Corrected** — replace the parenthesised literal with a recompute rule:

```
Gate: both files parse, objectives `100`, and the status histogram equals the counts derived
from the latest appended attempt per objective. Recompute and compare against `PROGRESS`
§Summary; a histogram that moved without a matching command result is a rollback trigger.
```

```
node -e "const o=require('./docs/agents/CHATGPT-100-LIVE-2026-10-28.json').objectives;const h={};for(const x of o)h[x.status]=(h[x.status]||0)+1;console.log(h)"
```

**Flag** — **HELD.** Live counter; applying a literal now guarantees a second correction at
sweep end.

---

## Withdrawn — do not apply

Two findings from the earlier pass do not survive re-check. Recorded so neither is applied.

- **022 / 023 / 024 evidence class.** Their attempts ran `get_conversation` (stored journal)
  and `conversation_targets`; none observed a provider message in that attempt. `tool-metadata`
  is correct under `PROGRESS` :21 ("stored Studio/CLI state only"). No change.
- **004 / 011 "not runnable under the recorded grant".** 004 needs a navigation grant like
  every other `navigation` row; that is a grant fact, not a doc defect. 011 is now `PARTIAL`
  and correctly off the do-not-rerun list. No change.

---

## Verification receipts

| Check | Command | Result |
|---|---|---|
| Focused tests | `node --test test/unit/chatgpt-new-chat-binding-investigation.test.mjs test/unit/conversation-capsule.test.mjs` | 35 pass, 0 fail |
| CC-07 revert | `git diff -- src/studio/conversation-tools.mjs` | 0 lines |
| Ledger parses, 100 objectives | `node -e "…JSON.parse…"` | ok, 100 |
