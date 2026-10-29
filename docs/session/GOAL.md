# Active goal (owner directive, 2026-10-29)

## Objective
Build and fully integrate the first functional, local-first VIVIM prototype across Windows, Android, Personal Agent, AI providers and AI-powered app creation. Implementation comes first; use subagents with cost-optimized model routing.

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
9. **Opus 5.5 upgrade pass.** Every new full code file gets a complete read-and-upgrade pass by Opus 5.5 (`cliproxy-claude/claude-opus-5-5`) after its writer lane finishes. See `AGENTS.md`.
10. **Model routing (updated by owner).** Use `openai/gpt-6.1-sol` for all subagent implementation work; Opus 5.5 for the new-file review/upgrade pass. (Free-tier models hit usage limits mid-task — don't route lanes to them.)
11. **Scenario-driven continuous build.** `docs/product/USER-SCENARIOS-100.json` holds 100 user scenarios, a file map and a 3-lane process. Lanes have non-overlapping write scopes:
    - A — providers and conversation runtime;
    - B — product surfaces (UI, mobile, Android);
    - C — Personal Agent, app builder and platform services.

    Work the P0 backlog in each lane and update each scenario's status with evidence as it changes.

12. **Features first; privacy and security last.** Defer privacy/security audits and hardening lanes until the feature scenarios are built. Up to 6 parallel lanes with non-overlapping write scopes.

## Done means
Each objective area has a live-observed outcome on the owner's real accounts and devices, recorded with evidence.
