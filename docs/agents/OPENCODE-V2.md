# OpenCode v2 — practical coordinator guide for VIVIM Harness

Official reference: https://opencode.ai/v2/docs/instructions and https://opencode.ai/v2/docs/agents and https://opencode.ai/v2/docs/permissions . These are **v2** semantics; verify locally installed version before changing config.

## What loads and when
OpenCode v2 automatically loads project-root `AGENTS.md` (plus applicable global/ancestor instructions). It **does not** automatically load every Markdown file linked by AGENTS.md, nor use CLAUDE.md fallback. Each `.opencode/agents/<name>.md` defines a *discoverable agent profile*, not a running subagent. Its Markdown body is that agent's system prompt; its `mode: subagent` enables child session dispatch. Children have **fresh contexts**; parent context is not guaranteed to carry over. A coordinator must pass the exact objective, effect authorization, server identity if verified, and needed file paths. Each child explicitly reads `context.md`; probes read only their assigned catalog entry as extra context.

Loading root AGENTS.md **once** plus this guide **once per coordinator session** avoids repeated bootstrapping. OpenCode detects edits to ambient root instructions before the next model request; for nested instruction updates start a fresh session when needed.

## Switching, launching, steering
- Use the OpenCode agent selector to switch between primary agents (`build` for coding, `plan` for bounded analysis), or mention `@chatgpt-probe` / `@local-opencode` to invoke a subagent. Parent agents can dispatch named subagents through their available subagent tool according to permissions. Do not claim a child launched without a returned child-session receipt.
- Assign **one numbered distinct objective per child**. Send a new steering message to the existing child/task when supported; otherwise wait for a concrete result and dispatch the next item. Do not fork many agents to do identical repo-wide discovery.
- Read-only investigations may overlap. Browser-mutating steps MUST be scheduled through the **one established Studio/effect owner**. Several agents do not imply several CDP/browser actors. Pause conflicting browser tasks until prior durable outcome is known.
- Provide concise context: `objective #NNN`, existing owner/port if verified, allowed read/effect scope, input data constraints and required 1-paragraph receipt. Child loads CLI helper itself. Do not pass shell scripts, recipe source or a success path to an independent probe.
- Once a probe reports an unsupported native action, delegate repair separately to `@local-opencode`; do not let the probe inspect internals or repair its own test.

## Models and permissions
OpenCode v2 agent models can be configured per agent in its Markdown frontmatter with a valid `provider/model-id` (optionally effort suffix supported by that provider). If model is omitted, the child inherits the coordinator's configured model. Set specific models only after `opencode models` or the locally installed model picker confirms availability; do not pin obsolete model IDs or assume plan credits. Change the model using the UI/model selector or agent configuration, **not** by claiming the parent silently changed a running child's model.

V2 uses `permissions` rules; avoid copying legacy v1 `permission` snippets without validating migration. Restrict a tester's edits and direct network/browser bypasses but allow the shell to execute the **native VIVIM CLI only**. Permission policy should be validated against installed v2 before making restrictive blanket shell rules; system prompts alone are behavioral constraints, not a technical sandbox.

## Minimal delegation template
`@chatgpt-probe: Objective 023 from docs/agents/CHATGPT-100-OBJECTIVES.md. Read context.md. Use only native VIVIM CLI to attempt this real ChatGPT objective. Owner/status must be verified; no provider sends or browser mutations unless separately authorized. Report PASS/PARTIAL/BLOCKED/UNSUPPORTED, real outcome, elapsed time, CLI command count and friction. No source inspection or scripts.`

## Anti-ceremony rules
No whole-repository tour, redundant status requests, agent-tree scaffolding, invented queues, new benchmark runner, global context rereads or duplicate docs. One parent coordinator is enough. Begin with a concrete goal, launch only genuinely independent children, steer based on their result, fix proven UX defects in source with focused tests. One source of truth for commands: `context.md`. One source of truth for 100 objectives: `docs/agents/CHATGPT-100-OBJECTIVES.md`.
