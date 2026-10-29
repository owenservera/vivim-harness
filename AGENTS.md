# VIVIM Harness — start here

This repository is the runnable VIVIM product. Take initiative: do useful work, verify it, and report what actually happened. OpenCode loads this file; `context.md` supplies native CLI reference.

## Who does what
- **Most work: do it yourself.** Delegate only an independent lane or a real specialist task.
- `@chatgpt-probe` — one real ChatGPT objective at a time; see `docs/agents/CHATGPT-100-OBJECTIVES.md` and `docs/agents/CHATGPT-PROBE-ENVIRONMENT.md`.
- `@local-opencode` — evidence-driven source tracing, minimal repairs, regression tests, handoff for live retest.
- `@git-manager` — staging/commits/pushes when assigned.
- `@marketing-landing` — README and `marketing/` surfaces.
- `docs/agents/OPENCODE-V2.md` — coordination reference.

## Real-world testing and debugging standard
**Observe → Trace → Reproduce → Fix → Regression test → Live retest → Reconcile.** An HTTP 200, file, registry entry or passing fixture is not proof of real provider behavior. Never claim a live PASS without a concrete observed outcome and evidence.

- Reuse the **existing single Studio/Chrome effect owner** on the dedicated VIVIM profile. First inspect native `agent status` and `conversation_targets`; historical ports/paths are references, not live identity proof. Do not automatically launch another Chrome/controller or use ordinary Chrome, Playwright, Puppeteer, raw CDP or computer-use substitutes. If initial setup is genuinely missing, coordinate once; provider sign-in is human-owned.
- Execute **one objective at a time, in catalog order**, respecting exact read-only/effect authorization. A scenario assignment alone is not send authorization. Preserve original keys and journals for uncertain sends; reconcile read-only and never blindly resend.
- Record each attempt **immediately** to the canonical append-only `docs/agents/CHATGPT-100-LIVE-2026-10-28.json` and applicable `CHATGPT-100-INVESTIGATION-2026-10-28.json` via one coordinated writer. Capture objective, tested revision, commands/count, outcome, evidence refs, timing/deadline/timeout, agent/model, authorization, friction, classification and uncertainty. Derive latest status from latest attempt, never erase earlier receipts. Never store raw private conversations/credentials.
- Classify PASS / PARTIAL / BLOCKED / UNSUPPORTED / FEATURE_UNAVAILABLE / NOT_TESTED according to observed evidence. Missing titles may reflect intentional default privacy filtering; blocked preconditions are not automatically bugs. Preserve profile/thread ownership, drafts, and no-resend safeguards.
- A repair agent traces the actual complete CLI → Studio → browser → provider UI → capture/persistence/reconciliation code path, reproduces the live failure shape in tests, fixes the root cause and hands a revision to the single live operator for retest. Keep **source unit pass** and **live provider pass** separate.
- Avoid repeated full sweeps, duplicate browser agents, competing ledger writes and speculative architecture work. Independent read-only analysis may parallelize; one owner performs effects and one writer updates evidence.

## Active goal
Read `docs/session/GOAL.md` first: the owner's current objective and specifics (consumer grade, user's own AI webapp accounts, never freeze, build on what works, no tests, Opus upgrade pass, model routing, 3-lane scenario build from `docs/product/USER-SCENARIOS-100.json`).

**Model routing (owner override):** Use `openai/gpt-6.1-sol` for all implementation lanes, including subagents. Free-tier models failed mid-task; do not route lanes to them. Reserve Opus 5.5 for the whole-new-file core/risky review below, never tactical files. This project-specific directive supersedes older free-tier routing guidance.

## New code file review (owner rule)
Every **new full code file** in **core/risky code** (conversation runtime, browser/CDP ownership, send/no-resend and draft protection, job runners, persistence/CAS, auth/LAN pairing) gets a complete read-and-upgrade pass by **Opus 5.5** (`cliproxy-claude/claude-opus-5-5`) once its writing lane finishes, before the work is reported done. Tactical new files (scripts, launchers, docs tooling, simple UI glue) get the same pass from `openai/gpt-6.1-sol` instead — never Opus.
- The pass reads the whole file plus the callers/contracts it depends on, fixes real bugs (correctness, security, edge cases, consumer UX), simplifies, and preserves public exports used elsewhere.
- Run it only after the file's writer lane has finished; never while another lane is still editing that file.
- It commits its own focused change and reports per file: bugs found (severity), changes made, what was deliberately left.

## Working style
- Report observed commands, responses, resulting source revision and what remains unverified.
- Minimize user commands, repetitive discovery, model/token cost and unnecessary delegation.
- Preserve local changes and existing evidence. Keep normal foreground commands short; use the repo's supported longer-run workflow when needed.

Product CLI: `bin/studio.mjs`. Simplification ledger: `docs/architecture/AGENT-CODE-SIMPLIFICATION-LEDGER.md`.
