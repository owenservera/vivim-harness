# OpenCode v2 — coordinator and delegation quick reference

Official v2 guidance: https://opencode.ai/v2/docs/instructions and https://opencode.ai/v2/docs/agents . Confirm the installed version and supported models locally. This is a **coordinator reference**, not mandatory reading for every child.

## Automatic versus on-demand context
- `AGENTS.md` is auto-discovered at project root alongside applicable global/ancestor rules.
- Project `opencode.json` uses `"instructions": ["context.md"]` to **actually preload** the canonical native CLI helper. Merely linking a Markdown file from AGENTS.md does not preload it. The OpenCode agent system prompt and these configured instructions are combined.
- A `.opencode/agents/name.md` file is a *discoverable profile*, not a running agent. Child contexts are independent: pass the specific objective, observed owner identity/port if verified, authorization boundary and expected output. Do not assume prior parent investigation automatically transfers.
- The 100 objective catalog is deliberately **not autoloaded** for every agent: the probe reads its assigned section only. Developer source files remain out of the probe's context.

## Running several probes
1. Stay in the Harness root and verify installed OpenCode version/model availability, and the running Studio through the native CLI. Do not start competing Studio/Chrome owners.
2. Select distinct objective IDs from `docs/agents/CHATGPT-100-OBJECTIVES.md`; dispatch `@chatgpt-probe` for one goal each, using OpenCode's agent mention or supported Task delegation. Check `opencode agent list` if unsure whether profiles were discovered.
3. Parallelize only non-conflicting read-only work. Explicitly serialize navigation and mutations on the sole existing browser-effect owner; ambiguous effects block conflicting lanes until reconciled.
4. Each child reports measured real-user outcome, elapsed time and CLI command count. Steer/reuse child session when available; otherwise dispatch a new bounded task. No batch scenario runner or scripts to rescue inaccessible actions.
5. Send demonstrated CLI gaps to `@local-opencode` after measuring the initial failure. No test agent source inspection.

## Switching and model assignment
- Switch selectable primary agents with the OpenCode agent selector (Build versus Plan). Named subagents can be invoked with an `@` mention or delegated by the primary agent when permissions allow.
- Each agent's frontmatter may include `model: provider/model-id#effort` if the installed v2 model identifier supports that suffix. Leave it absent to inherit the invoking model; do not hardcode unavailable IDs. Verify locally with `opencode models`.
- To steer a running task, use OpenCode session/task controls when available; model selection for subsequent work must be verified on the target agent/session rather than assumed to propagate silently.
- v2 agent frontmatter uses `permissions` entries with action/resource/effect. Avoid v1 `permission` snippets. A descriptive system prompt does not by itself enforce a shell sandbox.

## Minimal coordinator invocation
`@chatgpt-probe: Objective 023 from docs/agents/CHATGPT-100-OBJECTIVES.md. Operate only native VIVIM CLI against the verified existing owner. No mutations without explicit scope. Report real outcome, evidence, command count, elapsed time, friction and blocker. No scripts or source inspection.`

Do not re-read all context, create extra agent hierarchies, invent work queues, generate duplicate docs, or do repo archaeology unless a specific defect requires it.
