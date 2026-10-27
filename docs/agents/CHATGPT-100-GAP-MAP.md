# ChatGPT 100 — blank-space and missing-capability map

Generated 2026-10-28. Companion to `CHATGPT-100-SOURCE-MAP.md` and `CHATGPT-100-DEPENDENCY-MAP.md`.

## Partial gap closures (2026-10-28)

- **003 identity provenance:** fixed source-level cross-origin identity claim, using the canonical ChatGPT parser. It does not read signed-in account identity or establish browser availability.
- **041 / 098 live reply-text events:** fixed same-length edits past the capped SSE text boundary being suppressed. Wire text remains bounded; full page/structured answer extraction and terminal delivery verification are separate gaps.
- Regression tests added in source but are **not marked executed or live-verified** here. All remaining gaps below are open pending broader read/implementation and actual verification.

## Why this file exists
The source map says **where current behavior lives**. The dependency map asks **what other existing code could affect it**. This third map explains the **blank space between a real ChatGPT user action and an exposed, verifiable harness capability**. A missing entry is not proof the functionality is impossible: it may be unimplemented, implemented but unexposed, not discovered, or only partly observable.

## Gap taxonomy
- **Missing primitive** — no browser action or reader for the required UI.
- **Unexposed primitive** — underlying implementation exists but CLI/native API does not expose it.
- **Missing orchestration** — actions exist but cannot complete a full user workflow or preserve context.
- **Missing evidence** — an action works but cannot be verified from captured structured results.
- **Missing recovery** — timeout, drift, interruption, auth or uncertainty cannot be reconciled safely.
- **Unknown until dependency review** — primary map says “no source” but adjacent modules might implement it.

## The blank spaces

| Scenarios | User capability | Why gap exists / present evidence | Likely ownership to investigate | Required closure evidence |
|---|---|---|---|---|
| 001–010 | Account identity, temporary chat, obstructions | Primary map reports no account reader, temporary-chat or modal control; auth-wall detection is partial | `src/capture/conversation-browser-adapter.mjs`, site profile, Studio capabilities | Read account/auth state; safely detect/dismiss obstruction; temporary chat state verified |
| 011–020 | History search, scroll, archive, navigation | Index can read links but lacks corresponding UI navigation/search controls | chat index, conversation service, browser adapter, `src/capture/human.mjs` | Open exact intended thread, search and navigate with stable thread identity |
| 021–030 | Edit, regenerate, stop, rename, archive | First-turn and follow-up exist; lifecycle UI controls not mapped | conversation runtime, adapter, recipe routes | Actual mutation with before/after thread/turn evidence |
| 031–040 | Newline, model, voice, chips, copy, feedback | Typing/Enter available; discrete control actions not mapped | site selectors, `src/profiles/model-ops.mjs`, Studio commands | Individual named tool per supported control; observable outcome |
| 041–050 | Structured answer extraction | Visible text is read; lists/code/tables/math/citations/images not mapped as structured blocks | `src/shapes/*`, `src/replay/stream-components.mjs`, page agent | Typed content with links, cell values, block provenance and no silent flattening |
| 051–060 | Search, thinking, research | Primary map reports no UI selectors/tool controls for these modes | profile stream-map, model ops, adapter probes | Activate/read mode and record real tool/search/research status |
| 061–070 | Uploads and downloads | No exposed attach/download tool in primary map | `src/studio/agentic-files.mjs`, capture, security | User file attachment and download through existing browser owner with receipts |
| 071–080 | Canvas, artifacts, chart/code controls | No mapped artifact surface; text-only capture is insufficient | shapes, replay, Studio UI, browser adapter | Detect/open/read/operate artifact, preserving type and provenance |
| 081–090 | Projects, shares, settings | No mapped routes; project index state unknown | conversation service, index, Studio commands | Read current state and apply safe requested action with verification |
| 091–100 | Offline, expiry, rate limits, reconciliation, World | Some safeguards exist; banner reader, reload freshness and complete recovery missing | browser ownership, runtime, event feed, store, World service | No wrong-thread send, no silent resend, explicit terminal state and reopened World record |

## Why the gap matters
A CLI response saying “done” is not proof a user action worked. For each scenario, trace **intent → tool → browser effect → observed state → captured evidence → persistent session → recoverable result**. Identify the first missing link. Fix the shared link once rather than adding 100 one-off scripts.

## Gap resolution workflow
For each objective 001–100, maintain:
- **Classification:** supported / partial / unsupported / unknown.
- **Reason:** one of the gap types above, with concrete file and function evidence.
- **Existing reusable code:** exact path/function discovered in dependency review.
- **Smallest fix:** primitive, exposure, orchestration, evidence or recovery.
- **Verification:** source review, focused automated test, or live verified (never conflate).
- **Status:** open / fixed in source / tested / live verified / blocked.

Do not fabricate completion, selectors or browser evidence. Do not implement a second browser controller, Playwright or Puppeteer. Prefer existing Studio owner and agent-friendly named tools.

## Review questions
1. Does “no source” mean genuinely absent, or merely absent from the original map?
2. Why does the feature exist elsewhere in the repo but not in the Studio tool surface?
3. Which missing shared primitive would unlock the most objectives?
4. Can a user complete the action in three or fewer agent-friendly commands?
5. Does a result retain thread identity, evidence and recoverability?
