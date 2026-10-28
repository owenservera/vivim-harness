# ChatGPT 100 — remote repair directive

Date: 2026-10-28. **Assignment: implement and test shared fixes, not a browser campaign.** The local operator owns the live browser and the parent owns integration and git coordination. This is a snapshot; consult the active [JSON ledger](CHATGPT-100-LIVE-2026-10-28.json) for the latest appended attempts. The [Markdown live ledger](CHATGPT-100-LIVE-2026-10-28.md), [objective catalog](CHATGPT-100-OBJECTIVES.md), [environment](CHATGPT-PROBE-ENVIRONMENT.md), and [source reconciliation](CHATGPT-100-RECONCILED-STATUS.md) supply context. Source-level support is not a live pass.

## Live evidence snapshot

The JSON records these latest statuses when this directive was written:

| Objective | Status | Observed limitation |
|---|---|---|
| 001 | UNSUPPORTED | Account identity and authentication remain unknown; no discoverable account reader. |
| 002 | UNSUPPORTED | Candidate links did not establish signed-in state or a login requirement. |
| 003 | BLOCKED | Root target had no exact thread ID; visibility unknown; read-only scope excluded navigation. |
| 004 | PARTIAL | ChatGPT target found, but unrelated tabs not demonstrated; broader targets call without explicit data directory refused profile verification. |
| 005 | PASS | Qualified: guarded targets with explicit data directory matched Studio target; parent separately reported verified launch. No explicit verified flag in that output, OS window handle, or live account/sign-in proof. |
| 006 | UNSUPPORTED | Rendered links did not demonstrate composer readiness or loading state. |
| 007 | UNSUPPORTED | Root target metadata did not establish generation or completion. |
| 008 | UNSUPPORTED | Index exposed no Temporary Chat state; absence is not off. |
| 009 | UNSUPPORTED | Index returned candidate paths but `displayTitle` contained flags without title text; duplicate titles not established or ruled out. |
| 010 | UNSUPPORTED | No composer/modal/challenge state observed; obstruction remains unknown. |
| 011 | PARTIAL | `create_conversation` created an unbound NEW_CHAT target without a send, but reported blocked readiness / `BINDING_CHANGED`; creation and subsequent target metadata disagreed on ownership. Blank usable composer was not proven. |
| 012 | UNSUPPORTED | Index again omitted title text and sidebar identity; no approved disposable target title was established. |

The JSON is the active, append-only evidence record and takes precedence over this snapshot if the probe advances. The Markdown ledger currently contains detail for 001, not a complete parallel record. Preserve existing statuses until a new live attempt verifies a change; do not overwrite history or claim 100 objectives complete. Historical runtime values are not proof of current state. Login is a human step; no live sign-in is proven here.

## Prioritized independent work packages

Coordinate shared integration files with the parent before editing; suggested scopes are starting points, not exclusive ownership guarantees. Deliver small reviewable patches and focused unit-test receipts. The local operator alone performs live acceptance.

1. **Read-only session inspection (001, 002, 006–008, 010).** Investigate `src/capture/actions.mjs`, browser adapter, ChatGPT profile and Studio tool exposure. Reuse existing partial auth/readiness/streaming primitives where suitable; provide discoverable native read-only observations for account/auth, loading/composer readiness, generation state, Temporary Chat, and modal/challenge obstruction. Explicit unknown/ambiguous outcomes are required; never infer signed-in from links, idle from absence of a stop control, or a mode from missing evidence. Avoid credentials and unnecessary identifiers. **Unit acceptance:** fixtures for positive, negative, hidden, conflicting and unknown states, plus CLI/tool exposure and no browser effects. **Live acceptance:** operator observes each relevant state using native CLI on an appropriately prepared page; a fixture cannot prove provider UI behavior or terminal generation.
2. **Index titles and identity (009, 012).** Investigate `src/capture/chatgpt-chat-index*.mjs` and its Studio response boundary to find why title text is absent. Return bounded, explicitly untrusted visible text when permitted, with truncation/omission indicators and candidate identity; do not equate title with binding or imply complete history. Distinguish sidebar provenance where actually observable. **Unit acceptance:** missing/hidden titles, duplicates with distinct native paths, bounds, truncation, and serialization. **Live acceptance:** operator uses approved disposable titles and confirms actual title matching and distinct paths; navigation or selection requires separate scope and evidence.
3. **New-chat binding lifecycle (011).** Investigate `create_conversation` → `conversation-runtime.connect` and target ownership reporting. Reproduce `BINDING_CHANGED` and the `ownedByStudio` disagreement in isolated tests; identify the actual cause rather than treating the observation as a proven diagnosis. Preserve legitimate drift detection and exact target/thread fences. **Unit acceptance:** fresh unbound NEW_CHAT, consistent ownership provenance, real binding change still blocked, and no send during creation. **Live acceptance:** separately authorized operator creates a disposable tab through the existing owner, confirms blank composer/readiness and consistent ownership without sending; leave partial if any proof is missing.
4. **Profile-context usability (004–005).** Investigate CLI help/config context for `targets` and `doctor`: explicit `--data-dir C:\VIVIM` selected the intended context in 005, whereas omission used a different default or failed verification. Improve diagnostics/documentation or safe explicit context handling, not identity inference. **Unit acceptance:** intended versus default context, mismatch refusal, and helpful remediation; no guard bypass. **Live acceptance:** operator verifies current runtime first and repeats guarded target discovery with explicit current data directory; unrelated tabs require an appropriate authorized precondition.
5. **Exact target and evidence preconditions (003–004).** Treat missing exact thread and unknown visibility as blocked preconditions, not generic feature success. **Unit acceptance:** root, exact thread, cross-origin, stale target and unknown visibility cases remain distinct. **Live acceptance:** operator supplies an approved exact thread and any unrelated tabs needed, with navigation separately authorized and no private content in receipts.

For wider backlog, use the reconciled source map and objective IDs to choose later work, not inferred live statuses. Keep navigation, lifecycle effects, rich extraction, uploads, settings and recovery separately scoped. Do not replace existing owner or duplicate an already exposed primitive.

## Safety and verification contract

- Remote work must not mutate the local runtime, Chrome profile, account, private data, or browser; no restart, second owner, direct CDP/API, Playwright/Puppeteer, or remote browser access. Do not weaken profile, binding, effect authorization, or thread-drift guards. Never include credentials, private conversations, raw captures, or personal identifiers in artifacts.
- Only the local operator may run a live re-probe, using `node bin/studio.mjs` and approved helper files, one assigned objective at a time, with scoped authorization for each effect. No automated browser batch campaign. Budget **60 seconds per probe**, record actual elapsed time, timeout/enforcement limitations, invocation count, commands, outcome, friction, uncertainty and safe evidence references. If a precondition or deadline cannot be met, report it rather than inventing success.
- For uncertain sends, retain the original operation identity, key and journal; reconcile read-only. Never send again with a new key or blindly retry. No effect is authorized merely by this directive.
- Synthetic/unit tests establish code behavior only. A live PASS requires actual native provider evidence for the specific objective and appropriate preconditions. Distinguish account feature unavailable from harness unsupported, blocked, and unknown; never fabricate evidence.
- The active local probe owns the JSON ledger: append attempts only, derive status from the latest attempt, and preserve prior evidence. Remote implementers must not edit the live ledger or promote statuses. Local operator records any subsequent live result.

## Routing, handoff, and ownership

Requested routing: **Terra low** for reading/probing, **Terra medium/high** for simple code, **Sol** for advanced work; select only catalog-verified available variants. Local probe rules and single-owner safety apply regardless of model. Remote team owns code and focused local unit tests in its authorized work area; report exact commands, results, failures/skips, changed paths, commit IDs if commits are authorized, and remaining live acceptance steps. Parent reviews/integrates and handles any commit/push for this directive; no permission to push another repository or branch is implied. Local operator owns browser validation and ledger updates.
