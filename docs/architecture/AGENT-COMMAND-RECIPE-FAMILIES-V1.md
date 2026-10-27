# Agent-friendly command structure and recipe families — V1

**Date:** 2026-10-27. **Status:** source-grounded design, not an implemented recipe executor.
**Canonical implementation destination:** `main` of `owenservera/vivim-harness`. No new Git branches. Reuse the existing Studio runtime, browser owner, registries and durable run store.

## Source audit

| Existing surface | Source | Observed contract | Gap for an agent |
| --- | --- | --- | --- |
| CLI definition | `bin/lib/registry.mjs`, `bin/lib/args.mjs` | Registered names, groups, flags, help, aliases, `--json` | Does not declare preconditions, effects, completion proof, recovery decision |
| Native agent tools | `src/studio/conversation-tools.mjs` | Nine schema-defined conversation operations with effect annotations | Tool names alone do not describe when to call them |
| Agent client | `bin/commands/tools.mjs`, `src/studio/tool-client.mjs` | One-attempt transport to already-running Studio owner; no automatic retries | No intent-to-tool selector or multi-step receipts |
| Harness execution | `src/studio/harness-api.mjs`, `src/capture/harness-runs.mjs` | Durable run/step keys, uncertain-effect fences, reconciliation | High per-step command burden, missing recipe-level eligibility |
| Native runtime | `src/capture/conversation-runtime.mjs` | Connect/submit/read/reconcile/finish, capture and journal ownership | Different operations exposed by CLI vs tools |
| CLI user tasks | `bin/commands/chat.mjs`, `drive.mjs`, `run.mjs` | Multiple overlapping one-shot and durable paths | Inconsistent usage semantics and operator decision burden |
| Provider/capture | `src/profiles/sites/index.mjs`, `src/cdp/discovery.mjs` | Seed adapters; target discovery, browser observations | Registered adapter != signed-in account or verified send capability |

**Critical distinction:** the native `connect_conversation` tool explicitly accepts *existing exact ChatGPT /c/ UUID threads*; the internal runtime and one-shot CLI expose different combinations of fresh-tab and other-provider behavior. A recipe planner **must** declare exact transport compatibility, not automatically assume parity.

## Product rule

One user-level task = **at most three user commands**, ideally **one**. Internal validated steps may be numerous but must be orchestrated automatically through the existing owner. Sign-in/consent is a clearly reported human interaction, not an invisible CLI command. No speculative fallback to other browser drivers.

## One canonical command hierarchy (proposed, NOT YET IMPLEMENTED)

| Command | Effect | Returns |
| --- | --- | --- |
| `studio agent status --json` | observation only | running owner, browser identity (if proven), storage, active run IDs |
| `studio agent capabilities --json` | observation only | typed available/degraded/unavailable capabilities and reasons |
| `studio recipe list [--family NAME] --json` | observation only | family/id/version, eligibility |
| `studio recipe show FAMILY.NAME --json` | observation only | required inputs, effects, steps, gates, outputs |
| `studio recipe plan FAMILY.NAME --input FILE --json` | no browser effect | fully resolved plan, owner, budget, approvals, blocked reason |
| `studio recipe run FAMILY.NAME --input FILE --json` | recipe-dependent; authorization required | run ID, durable step receipts, result/evidence tier |
| `studio recipe status RUN_ID --json` | observation only | state, last verified step, pending actions |
| `studio recipe reconcile RUN_ID --json` | read-only reconciliation | journal-linked verdict, original key, no resend |
| `studio recipe explain ERROR_CODE --json` | observation only | specific cause, safe actions, escalation |

Add native HTTP/MCP counterparts to **the existing integration hub**, generated from the same recipe registry. No parallel parser or new execution engine. Prefer registered `CONVERSATION_TOOLS` plus the existing harness run store; API-only abilities must be marked `transport=api`, CLI-only ones `transport=cli`.

## Recipe family taxonomy

| Family | Example recipes | Effect policy / success gate |
| --- | --- | --- |
| `bootstrap` | `inspect`, `doctor`, `safe-start` | read-only default; detect owner and runtime, never silently restart active browser |
| `provider` | `targets`, `capabilities`, `thread-index` | read-only; distinguish adapter-known vs account-confirmed vs target-bound |
| `conversation` | `find`, `connect-existing`, `new`, `ask`, `continue`, `read`, `finish`, `recover` | explicit authorization for sends; exact identity, keyed journal and readiness gates |
| `capture` | `observe`, `capture-url`, `verify`, `replay` | browser-read + local write; source integrity and coverage |
| `world` | `return`, `organize`, `find`, `take`, `export`, `import` | local world routes; custody, revision, source provenance |
| `knowledge` | `derive`, `search`, `link`, `explain` | source evidence must exist; derivative is rebuildable |
| `recovery` | `inspect-uncertain`, `reconcile-turn`, `resume-safe`, `release-writer` | no automatic resend, safe-state gate |
| `diagnostics` | `health`, `trace`, `inspect-session`, `acceptance` | read-only diagnostics; separate state from acceptance |
| `verification` | `smoke`, `live-pilot`, `live-100`, `regression` | distinguish mocked, offline, real-saved, live-provider proof |

## Minimum machine-readable recipe schema

Every recipe is versioned and declarative:

```json
{
  "id": "conversation.continue",
  "version": 1,
  "intent": "Continue an exact, already-bound native conversation",
  "inputSchema": { "type": "object", "required": ["conversationId", "prompt"] },
  "requires": ["runtime.running", "conversation.exact-thread", "conversation.writable"],
  "transport": ["studio-tool"],
  "effects": ["provider-send", "local-write"],
  "authorization": ["provider-send"],
  "steps": [
    { "tool": "get_conversation", "purpose": "read latest revision and identity" },
    { "tool": "submit_conversation_turn", "purpose": "one keyed, explicitly confirmed send" },
    { "tool": "get_conversation", "purpose": "read observed delivery/reply" },
    { "tool": "finish_conversation", "purpose": "save and release existing capture" }
  ],
  "success": ["send.observed", "reply.ready", "capture.persisted"],
  "onUnknownEffect": "halt-and-reconcile",
  "maxUserCommands": 1
}
```

This illustrative schema is not valid as a machine executable contract until every input binding, event guard, tool argument, and evidence expression is typed. A registry compiler must reject unresolved symbols and unsupported transports. In particular a recipe cannot turn `connect_conversation` into a fresh-tab provider operation.

## State machine and dispatch rules

`DISCOVER -> ELIGIBLE -> PLANNED -> AUTHORIZED -> EXECUTING -> VERIFYING -> SUCCEEDED`

Alternatives: `INELIGIBLE` (missing capability); `AWAITING_USER` (login/consent); `BLOCKED` (guard or writer); `UNCERTAIN` (unknown effect, no retry); `FAILED` (confirmed failure); `INTERRUPTED` (capture saved if possible).

- Each effectful step gets a **durable key before dispatch**, coupled to exact arguments and native conversation journal identity.
- Read-only tools can be retried only under the existing proven-not-dispatched rule.
- A timeout or browser disconnect after a send is **not** proof of failure or permission to resend.
- The planner must preflight site/origin/thread, current revision, writer ownership, auth state when actually observable, allowed effect classes and output contracts.
- At every stage, emit `status`, `evidenceTier`, `nextSafeAction`, `retryAllowed`, `reasonCode`, `runId` and `sourceRefs` where known. Unknown values remain null/unknown, not inferred.
- Logs and reports are metadata-only by default; never print prompt bodies, replies, auth tokens or provider cookies incidentally.

## Agent decision examples

**User: "Find my Harbor chat."** Prefer `conversation.find` read-only; require an exact linked result before `connect-existing`. Search result/title is not identity proof.

**User: "Ask ChatGPT about Cedar."** Plan `conversation.new` or `conversation.ask`; confirm browser owner and provider identity; obtain send effect scope; dispatch once; wait for attributable observed result and save; on uncertain, halt.

**User: "What happened to the last send?"** Choose `recovery.inspect-uncertain` then `recovery.reconcile-turn` with the original key; do not rerun `conversation.ask`.

**User: "Organize and export this answer."** Compose `world.organize` + `world.export` under a single user-visible recipe with provenance/expected-version checks.

## Delivery sequence on main (five increments)

1. **Declarative registry** (pure, no effects): `src/recipes/catalog.mjs`, minimal typed recipe metadata; unit tests enforcing unique IDs, effect taxonomy, available tool names and no phantom transports.
2. **Read-only CLI discovery**: `studio recipe list/show/plan` and `studio agent capabilities`, `--json` stable outputs. All derive from the existing command/tool registry where possible.
3. **Single-owner run binding**: use existing running Studio `tools call` / harness runs, not a newly created CDP session. Durable intent before effects.
4. **Safe canonical recipes**: provider.targets, conversation.read, conversation.continue, capture.verify, recovery.reconcile-turn, world.find/export; all have measured failure receipts.
5. **Live acceptance**: actual local provider + multi-turn tests, 100-case coverage, Windows and Linux native parity; report real evidence separately from offline unit pass counts.

## Compatibility and open questions for implementation

- The live-100 implementation from draft PR #10 is on a branch, not in main at the time of this design. Do **not** claim its commands exist on main.
- Some recipe families depend on native world routes rather than the nine conversation tools; the planner must declare exact API/tool bindings and eligibility.
- Need a source-backed review of the running server's ownership guard before exposing fresh-tab/new-thread recipe execution remotely.
- No automated authorization of provider sends from a recipe's mere presence; caller must supply effect-scoped authorization.
- No Playwright or Puppeteer.

**Acceptance:** An agent should be able to discover, plan, run, inspect and safely recover any supported recipe using at most one user-facing command per requested action, without understanding CDP internals or guessing the next tool. When unsupported, the answer is a stable reason code and the smallest safe next action, never another ad hoc driver.
