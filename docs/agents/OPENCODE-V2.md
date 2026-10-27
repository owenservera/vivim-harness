# OpenCode v2 — coordinator and delegation quick reference

Official guidance: https://opencode.ai/v2/docs/instructions and https://opencode.ai/v2/docs/agents. Check the installed version and available models when needed.

## Automatic versus on-demand context
- OpenCode discovers applicable `AGENTS.md` files. Project `opencode.json` also loads `context.md` through its `instructions` array.
- `.opencode/agents/name.md` defines a discoverable profile. A child session has its own context, so pass the objective, relevant evidence, and any verified runtime identity.
- The objective catalog is `docs/agents/CHATGPT-100-OBJECTIVES.md`.

## Running several probes
1. Select objectives and delegate to `@chatgpt-probe` when independent evaluation is useful.
2. Capture the initial result before troubleshooting or repairing a gap. Delegate implementation to `@local-opencode` when useful.
3. Run independent read-only work in parallel; coordinate browser effects through the existing Studio owner and reconcile uncertain effects under their original keys.
4. Report actual outcomes, evidence, elapsed time, command count, and friction.

## Switching and model assignment
- Switch primary agents with the agent selector; invoke named subagents with an `@` mention or task delegation.
- Agent frontmatter may specify `model: provider/model-id#variant`; without it, a subagent inherits the invoking model. Check available IDs with `opencode models` when selecting one.
- Use session/task controls to steer ongoing work. V2 `permissions` use ordered action/resource/effect entries; a prompt is not a shell sandbox.

## Minimal coordinator invocation
`@chatgpt-probe: Evaluate objective 023 with the native VIVIM CLI. Report the observed outcome, evidence, command count, elapsed time, and friction.`
