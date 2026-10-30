# Active goal (owner directive, 2026-10-29)

## Objective
Build and fully integrate the first functional, local-first VIVIM prototype across Windows, Android, Personal Agent, AI providers and AI-powered app creation. Implementation comes first; use subagents with cost-optimized model routing.

## North star (owner, 2026-10-30)
Assume a future where the **only AI available is the user's own web AI accounts** (ChatGPT, Claude, Gemini, DeepSeek, Z.ai, Qwen in the dedicated browser). VIVIM must then be good enough that a web AI can be the **primary agent**: it plans, delegates subtasks to the other web AIs (fan-out, council, race, fallback, relay, judge, auto-routed), reads and edits local files, runs approved commands, checks results and reports, the way a coding orchestrator works today. Build every orchestration piece so it can be driven by a web-AI planner, not only by a CLI or a human:
- a structured action protocol the web AI writes in its replies (read file, propose edit, run command, ask other AIs, save to Work, finish), parsed tolerantly (smart quotes, fences);
- explicit owner approval gates for effects (file writes, commands, sends to other AIs over a budget), with plain-language summaries;
- workspace scoping, step budgets, resumable loops, no-resend safety and full timing/outcome tracking per AI so routing improves with use.

## Owner specifics (added during the session)
1. **What VIVIM is.** VIVIM is a new kind of harness. It works through the **user's own AI webapp accounts** (ChatGPT, Claude, and later Gemini, z.ai and others) in a dedicated, signed-in Chrome. It uses no API keys. Every feature is built around that.
2. **Consumer grade.** Real people must be able to use it. Copy is plain language, with no internal jargon (revision, turn, capture). There are no raw error codes in the main UI; each failure gets a friendly explanation and a next step. Waits are handled for the user ("Waiting for your AI…"), never surfaced as timeouts.
3. **Refine through real use.** Use the owner's AI accounts and VIVIM itself to advance this code (dogfooding). Each friction hit in real use becomes a fix.
4. **Never freeze.** Root-cause hangs and stalls instead of retrying blindly. Known causes:
   - a stale, Claude-persisted draft of VIVIM's own text;
   - several Studio processes driving one Chrome.

   Fix the cause and prove the fix live.
5. **Build on what works.** Prioritize extending the features that have been proven live over speculative work. Stop work that isn't working (for example the slow emulator) instead of pushing through it.
6. **No tests, just code.** Don't write or run unit-test suites. Short live runtime checks are the evidence.
7. **Never idle.** Keep independent work moving while downloads or subagents run.
8. **Full authority.** Proceed without asking permission. Ask only for things only the owner can do, such as a provider sign-in.
9. **New code file upgrade pass.** Every new full code file in core/risky code gets a complete read-and-upgrade pass by Opus 5.5 (`cliproxy-claude/claude-opus-5-5`) after its writer lane finishes. Tactical new files (scripts, launchers, docs tooling, simple UI glue) get the same pass from `cliproxy-claude/claude-sonnet-5` instead — never Opus. See `AGENTS.md` for core/risky scope and review requirements.
10. **Model routing (owner override, 2026-10-30).** Every subagent runs `opencode/deepseek-v4.1-flash-free`: variant `#high` for implementation, review and synthesis, `#low` for read-only search. No Claude, no Grok, no paid lanes. Free-tier access is entrypoint-dependent: if a lane returns 403 or rate-limits, retry once with `#low`, then report the blocker instead of silently swapping models. This supersedes the earlier Sonnet rule and the Opus reservation in item 9: core/risky new-file review passes now run on the same DeepSeek free lane, so the reviewer is weaker - say so in the report and keep the offline smoke evidence attached.
11. **Scenario-driven continuous build.** Keep six active independent lanes working against unfinished scenarios in `docs/product/USER-SCENARIOS-100.json`. Its three ownership groups define the boundaries within which the six lanes receive explicit non-overlapping write scopes:
    - A — providers and conversation runtime;
    - B — product surfaces (UI, mobile, Android);
    - C — Personal Agent, app builder and platform services.

    Work eligible unfinished P0 scenarios first, then P1 and P2. Reconcile each lane's completed change, commit and observed evidence before refilling it with the next real unfinished scenario. Implementation or offline checks alone never establish live WORKS. Keep one live browser/effect owner across all six lanes and one coordinated scenario/evidence writer. A scenario assignment is not authorization for sends or other unsafe effects; preserve drafts and original uncertain-send keys. Do not fabricate lanes or busywork to fill slots: if dependencies, authorization or exclusive ownership prevent six useful assignments, report the concrete blocker and keep the remaining independent feature work moving.

12. **Features first; privacy and security last.** Defer privacy/security audits and hardening lanes until the feature scenarios are built. Maintain six useful parallel lanes with non-overlapping write scopes under rule 11; do not substitute audit or busywork lanes for unfinished features.

## Done means
Each objective area has a live-observed outcome on the owner's real accounts and devices, recorded with evidence.
