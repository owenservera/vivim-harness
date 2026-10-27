# Agent Recipe Runtime V1 — implemented command/API contract

**Repository:** `owenservera/vivim-harness`, `main`.
**Scope:** concrete recipe discovery, typed static planning, native server execution through the existing harness API, and durable status/reconciliation. **Not** a replacement for CDP, recorder, journal, world store or provider adapter registry.

## Actual commands

The following names are registered by `bin/commands/recipes.mjs` and `bin/studio.mjs`.

```powershell
node bin/studio.mjs agent capabilities --json
node bin/studio.mjs recipe list --json
node bin/studio.mjs recipe list --family conversation --json
node bin/studio.mjs recipe show conversation.continue --json
node bin/studio.mjs recipe plan conversation.continue --input turn.json --json
node bin/studio.mjs agent status --json
```

Read-only discovery/planning do not require a running Studio or open a browser. `agent status` reads the already-running Studio health endpoint and reports account state as unverified.

For the shortest live follow-up workflow, use **`conversation.ask`** instead of manually
looking up `expectedRevision`. Its private `ask.json` is just:

```json
{ "conversation": "EXACT_BOUND_CONVERSATION_ID", "key": "unique-agent-turn-001",
  "prompt": "Summarize the next steps." }
```

```powershell
node bin/studio.mjs recipe run conversation.ask --input ask.json --execute --authorize-send --json
```

This recipe obtains the current revision **from the same Studio runtime owner** and supplies the
native confirmation only after both effect authorizations. It never bypasses thread identity,
journal fencing or the one-send policy. The original key must be preserved across timeouts.

For an existing, exact native ChatGPT conversation (not a new tab), `turn.json` contains the **actual** required tool arguments:

```json
{
  "conversation": "EXACT_CONVERSATION_ID",
  "key": "agent-task-unique-turn-001",
  "prompt": "Continue this conversation with a brief summary.",
  "confirm": true,
  "expectedRevision": 1
}
```

The agent obtains `conversation` and `expectedRevision` from real `conversation.inspect`/native state, never guesses them. Before issuing a send, it checks the thread binding, journal and effect authorization. Then:

```powershell
node bin/studio.mjs recipe run conversation.continue --input turn.json --execute --authorize-send --json
node bin/studio.mjs recipe status EXACT_RUN_ID --json
node bin/studio.mjs recipe reconcile EXACT_RUN_ID --json
```

One CLI command performs a recipe action; follow-up status/reconciliation commands are used only as needed. The send command requires the original keyed intent plus two explicit authorizations; it does **not** retry on HTTP timeout. A missing/unknown effect leaves the run open and preserves the original key. The output is metadata-only unless `--include-content` is explicitly requested.

For a zero-send provider-target read:

```powershell
node bin/studio.mjs recipe run provider.targets --json
```

For effectful recipes other than provider sends, supply a caller-owned stable `--operation ID` to deduplicate the user action. For send recipes, `input.key` is the stable operation ID. Reusing the same operation with different arguments is rejected, not silently treated as a prior success.

## Native API (running same-owner Studio only)

All routes reuse `src/studio/integration-hub.mjs` and the same token/loopback/Host/Origin protections.
Read-only `recipe run` calls dispatch through the **existing validated native tool**
without allocating a durable harness-run slot. Effectful runs retain the existing
harness run store, original operation identity and no-resend journal fence.
Default read results preserve actionable IDs/states/coverage while redacting private
prompt, reply and title/body fields. Use `--include-content` deliberately if needed.

| Method | Route | Meaning |
|---|---|---|
| GET | `/api/v1/agent/capabilities` | capability contract, no account-probing |
| GET | `/api/v1/recipes?family=conversation` | catalogue |
| POST | `/api/v1/recipes/choose` | advisory intent match; text supplied in private body, not URL |
| GET | `/api/v1/recipes/{recipe}` | single recipe declaration |
| POST | `/api/v1/recipes/{recipe}/plan` | pure typed validation |
| POST | `/api/v1/recipes/{recipe}/run` | existing harness run + single native tool step |
| GET | `/api/v1/recipes/runs/{run}` | persisted run state |
| POST | `/api/v1/recipes/runs/{run}/reconcile` | read-only uncertain-step/journal evidence |
| POST | `/api/v1/recipes/runs/{run}/finish` | explicit stored run closure |

`recipe_plan`, `recipe_run`, `recipe_reconcile`, etc. are also registered in the integration hub tool manifest. They are MCP-style tools, **not** a full MCP transport. External agents may use the existing integration hub; no alternate server is created.

Request body for `/run`:

```json
{
  "input": { "conversation": "EXACT_CONVERSATION_ID", "key": "agent-task-unique-turn-001",
    "prompt": "Continue this conversation.", "confirm": true, "expectedRevision": 1 },
  "execute": true,
  "authorizeSend": true,
  "includeContent": false
}
```

Read-only recipes may omit both effect authorizations. A returned `tool-completed-outcome-unverified` means the step entered the existing runtime, **not** that the answer, capture acceptance, multi-turn continuity or user goal is proven. Inspect the native conversation and capture evidence before treating the task as complete. No output from `plan` proves an account is logged in.

## Families and limits

Registered family taxonomy: bootstrap, provider, conversation, capture, world, knowledge, recovery, diagnostics, verification.

**Currently executable V1 declarations (ten):** provider.targets, provider.chat-index, conversation.list, conversation.inspect, conversation.read, conversation.connect-existing, conversation.ask, conversation.continue, conversation.finish, recovery.reconcile-turn.

Some other families have no executable recipe yet. They are reserved taxonomy, **not** claimed capabilities. World routes and the fresh multi-provider UI path remain present elsewhere in the repository, but are **not** automatically elevated to this recipe surface.

Each declaration is constrained to one tool in the existing nine-tool conversation registry. This deliberate V1 restriction prevents a generic recipe file from gaining arbitrary shell privileges, undocumented sends or a second browser actor. Compose multi-step families later by explicitly checked native tool step graphs and stable event guards, not by evaluating untrusted scripts.

## Durable evidence and uncertainty

Native `harnessApi.create/step/get/finish/reconcileStep` is the only run authority. Recipe command code does not create a new storage scheme. Only metadata and cryptographic argument digests go into the durable harness run ledger. The agent's local JSON input file may contain private prompts; do not commit it.
A durable `recipe finish --status succeeded` for an actual provider send now requires
native proof from its exact turn: observed delivery, ready reply, ready journal,
non-null capture session and finished capture. An HTTP step receipt alone is insufficient.
The recipe can still be interrupted or failed without inventing a successful provider result. Provider sends should be authorized and performed only against a deliberately selected real native conversation.

Duplicate-operation check happens synchronously adjacent to native run creation in the same Studio process. This prevents duplicate runs within that single-owner event loop; it does **not** guarantee cross-process deduplication if two independently running Studio servers share a data directory. Such setups remain unsupported. A failed preflight must never be interpreted as proof that an earlier unknown send did not occur.

If a tool call failed after dispatch: use `recipe status` and `recipe reconcile` on the **original run**. Do not generate a new key, invent a new run or attempt automatic replay.

## Verification contract

Relevant offline focused tests are:

```powershell
node --test test/unit/recipe-catalog.test.mjs test/unit/recipe-plan.test.mjs test/unit/recipe-service.test.mjs
node scripts/architecture-inventory.mjs --check
```

Test files were authored remotely without execution on the owner's Windows machine. Static JavaScript parse checks may be reported separately, never as Node test passes. A true provider acceptance claim requires real browser effects, native thread identity, observed send, attributable reply, finished capture, persisted record and a clear source receipt.
