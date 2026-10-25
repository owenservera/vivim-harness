# Practical model resource map

Snapshot date: **2026-10-25**. Advisory inventory, not runtime configuration. Companion: [`model-resources.json`](model-resources.json). No model smoke calls, quota probes, configuration changes or benchmarks were performed for this inventory.

## Evidence and limits

- **Catalog-listed** means the installed `tools.opencode.models` returned the exact route and variants today. It does not establish access through every agent entrypoint.
- **Returned task** means the parent reported a useful completed task on that specific agent/route. It does not prove unlimited quota, billing truth, latency or comparative quality.
- **Zero catalog price** is metadata, not a guarantee of unlimited service or a verified account balance. Empty costs mean **unspecified**, never zero.
- Rate limits, remaining quotas, balances and provider/account quota sharing are **unknown for every route**. Different model IDs are not independent accounts. Free is not infinite.
- Low/medium/high are listed effort variants, **not proven speed tiers**. Sol has no separately catalogued fast/ultrafast ID in the targeted lookup.

## Primary resources

| Resource / exact dispatch ID | Catalog variants | Price evidence | Task evidence / practical use |
| --- | --- | --- | --- |
| `openai/gpt-6.1-sol` | low, medium, high, xhigh, max | Unspecified in catalog; treat as premium | Parent reports `local-opencode` returned useful work at `#high`. Use medium/high for decisions and integration; cap premium workers at one. This artifact session identifies itself as Sol, but its effort setting is not independently visible, so no confirmed `#low` success is claimed. |
| `huggingface/zai-org/GLM-4.7-Flash` | none listed | Input/output zero | Parent reports `explorer` returned useful work. Prefer bounded read-only extraction; focused mechanical edits only with checks. |
| `huggingface/zai-org/GLM-4.7` | none listed | Input 0.6, output 2.2 USD/million tokens | **Paid non-Flash model**, not a free substitute. Catalog-only here. |
| `cliproxy-grok/grok-4.7` | low, medium, high | Unspecified; OAuth via CLIProxy | Parent reports `general` returned useful work at `#medium`. Independent bounded review perspective, **not** an independent account or free API entitlement. |
| `cliproxy-grok/grok-4.6`, `cliproxy-grok/grok-4.3`, `cliproxy-grok/grok-build-0.1` | low, medium, high | Unspecified; OAuth via CLIProxy | Catalog-only, untested here. Same account/pool independence caveat. |

## OpenRouter zero-price inventory

All eight are catalog-listed active, input/output zero, and **untested in this session**. Treat `openrouter/openrouter/free` as a router, not a pinned underlying model.

| Exact dispatch ID | Variants |
| --- | --- |
| `openrouter/recursive/flint-v1.0:free` | none listed |
| `openrouter/xingchen-agi/xing4.0-29b-a4b:free` | none, thinking |
| `openrouter/nvidia/nemotron-3.5-super-vl:free` | none, thinking |
| `openrouter/liquid/lfm-2.5-2.6b:free` | none listed |
| `openrouter/thinkingmachines/inkling-small:free` | none, minimal, low, medium, high, max |
| `openrouter/cohere/north-mini-code:free` | none, thinking |
| `openrouter/google/gemma-4-26b-a4b-it:free` | none, thinking |
| `openrouter/openrouter/free` | none listed |

## Other inexpensive-to-inventory routes

The JSON preserves exact variants. These are **catalog-only, untested here**:

- Nvidia zero-price: `nvidia/minimaxai/minimax-m3.1-flash`, `nvidia/deepseek-ai/deepseek-v4.1-flash`, `nvidia/z-ai/glm-5.3-flash`.
- OpenCode zero-price: `opencode/mimo-v2.6-flash-free`, `opencode/glm-5.3-flash-free`, `opencode/beam-free`, `opencode/flint-40b-free`, `opencode/deepseek-v4.1-flash-free`, `opencode/nemotron-3.5-super-vl-free`.
- Additional `free` provider IDs have **unspecified prices despite their names**: `free/free/deepseek-v4-flash-free`, `free/free/big-pickle`, `free/free/minimax-m2.5-free`, `free/free/nemotron-3-super-free`, `free/free/qwen3.6-plus-free`. Do not normalize away the repeated `free/` segment.

## Lean dispatch policy (proposal, not an enforced configuration)

1. Maximum **three workers total plus the parent**, with at most **one premium Sol worker**. Initially allow only one worker per free endpoint; conservatively serialize routes sharing a provider/account until quota independence is known.
2. Free routes: bounded read-only extraction first; mechanical edits only with disjoint ownership and focused validation. Sol medium/high: decisions and integration. Grok: independent, bounded review. These are task assignments, not measured model rankings.
3. Freeze shared interfaces before parallel writers. Assign disjoint files; one integration owner. Do not duplicate whole-repository reading or run mass model tests.
4. Retry a transient failure once. Maximum two correction rounds, then escalate or return a blocker rather than looping. Never retry an uncertain external effect automatically.
5. Request concise path/line evidence and continue existing sessions to avoid repeated context loading. Run task-relevant checks, not bulk paid smoke benchmarks.
6. Refresh the catalog daily and **before using a new route**; check exact agent entrypoint with one bounded useful task when authorized. Do not copy stale machine routing IDs blindly. Record failures as well as successful task returns; do not infer remaining quota from either.

## Snapshot provenance

Direct tool discovery used `tools.opencode.models` through Code Mode. Five bounded catalog calls, each with no next page: `{query:"free",limit:60}` (19 entries), `{provider:"openai",query:"gpt-6.1-sol",limit:20}` (1), `{provider:"huggingface",query:"GLM-4.7",limit:20}` (2), `{provider:"cliproxy-grok",query:"grok",limit:20}` (4), `{provider:"nvidia",query:"flash",limit:20}` (3). The companion is a compact projection of all 29 returned entries: exact IDs, active status, variants, input/output prices and evidence labels; release/name/cache metadata omitted. Task-return evidence is explicitly parent-reported, not independently rerun. No credentials or private captures collected.
