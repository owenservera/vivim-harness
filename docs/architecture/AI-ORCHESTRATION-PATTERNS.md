# AI orchestration patterns — VIVIM

Every pattern runs through the same central component, `src/studio/ai-orchestrator.mjs`, via `POST /api/v1/orchestrate` or `studio ask --pattern <name> ...`. Individual runners no longer re-implement create → submit → observe → reconcile → finish. The catalog below is also served by `GET /api/v1/orchestrate`.

## The one shared browser rule (applies to every pattern)

VIVIM drives the user’s own signed-in AI webapps in ONE dedicated Chrome. There is exactly one browser drive-lease, so:

- **Sends are serialized.** create-tab → readiness → type → submit for a step holds the lease; the next step on any site waits. One shared FIFO "browser lane" in the orchestrator enforces this across ALL plans in Studio.
- **Replies are observed concurrently.** Once a question is submitted, its answer streams in its own tab while other steps are being asked or observed (plain stored-conversation reads, no lease). A slow answer never blocks another site from being asked.
- **One tab-turn per site at a time.** A step never starts on a site whose earlier turn (any plan) is still being answered.
- **Never resend.** A step’s key (`<plan id>-<step id>`) is assigned at plan creation and never regenerated. `attempted` is saved strictly before submit; an attempted step is only ever observed or read-only reconciled afterwards. A timeout or unknown effect means "observe again", never "send again".
- **Cancel / race-lost / deadline only stop waiting.** A question already sent stays sent and may still finish in its tab; a question not yet sent is never sent.
- **Restart resumes observe-only.** A plan whose owner process is gone is picked up by the next Studio process: attempted steps are observed (stored conversation + capped read-only reconcile), never re-sent; not-yet-attempted steps may still be asked unless the plan deadline passed.

Cost numbers below are **sends** (provider questions) and **wall time on one shared browser** (roughly the sum of submit overheads plus the slowest reply being waited on; concurrent observation means replies overlap). `n` = number of AIs asked.

## Patterns

| # | Pattern | What it is | Use in VIVIM | Send/receive shape | Cost | Failure / no-resend rules | How the result is chosen | Consumer wording | One browser? | Value |
|---|---------|-----------|--------------|-------------------|------|---------------------------|--------------------------|------------------|--------------|-------|
| 1 | **single** | Ask one AI one question. | Dev work, quick Q&A, anything where one answer is enough. | One send to one site; observe its reply. | 1 send; ~one submit + one reply. | Signed out → skipped, not retried. Timeout → observed only, never resent. | The one answer. | "Asking ChatGPT…" → "Answer ready." | Yes | High |
| 2 | **fanout** | Same question to several AIs; see every answer side by side. | App design, research, consumer Q&A where you want to compare. | n sends serialized (phase 1), then n observes concurrently (phase 2). | n sends; ~sum of submits + slowest reply (replies overlap). | Each site independently: signed out → skipped; timeout → observed only. No cross-site resend. | All answers returned; caller picks. | "Asking ChatGPT, Claude, Z.ai…" → "3 of 3 AIs answered." | Yes | High |
| 3 | **race** | Same question to several AIs; keep the first VALID answer, stop waiting for the rest. | Fast consumer Q&A, "which is right?" speed matters more than completeness. | n sends serialized; first ready+valid wins; others marked stopped-waiting (sent ones may still finish) or skipped (never sent). | n sends max; stops as soon as one valid answer lands. | A sent question cannot be unsent — "cancel" = stop waiting. Losers already sent are marked stopped, never resent. | First valid answer wins. | "Claude answered first." | Yes | High |
| 4 | **fallback cascade** | Ask site 1; only if it can't answer (signed out, stuck) ask site 2, etc. | Reliability-first tasks where one good answer suffices. | Chain: each step waits for all prior steps to finish, proceeds only if none ready. | Up to n sends; usually 1. | A site that can't answer is skipped (never resent); the chain continues to the next. | First ready answer in chain order. | "Qwen couldn't answer, so trying ChatGPT…" → "Answered by ChatGPT because Qwen couldn't." | Yes | High |
| 5 | **hedge** | Ask site 1; if it hasn't answered after a delay, also ask site 2. First good answer wins. | Latency-sensitive questions where a slow first AI shouldn't block. | 1 send; after `hedgeAfterSeconds` (default 90s) a second send is kicked off if the first hasn't replied. | 1–2 sends. | Second is only sent if the first is slow; first good answer wins; the other stops waiting, never resent. | First valid answer. | "ChatGPT is taking a while, so also asking Claude…" → "ChatGPT answered first." | Yes | Medium-high |
| 6 | **council** | Several AIs answer independently, then one chosen AI combines them into a single best answer. | App design, Work, important decisions where you want a settled view. | n answer-sends (concurrent observation), then 1 synthesize send after ≥2 answers ready. | n+1 sends; synthesis waits for members. | Members that fail are skipped; synthesis needs ≥2 ready answers or it degrades to the best single answer. | The synthesis step's answer; notes which members contributed. | "Z.ai combined the answers from ChatGPT and Claude." | Yes | High |
| 7 | **judge / referee** | Several AIs answer, then one AI picks the best and says why. | Code review, decisions, any "which answer is better?" task. | n answer-sends, then 1 judge send; judge picks by number. | n+1 sends. | Judge failure → falls back to first answer that came back, with a plain note. | Judge's chosen answer + its "why". | "Z.ai picked Claude's answer as the best." | Yes | High |
| 8 | **debate** | A vs B rounds: AI A answers, AI B critiques, A revises, repeat. | Contentious design or writing where stress-testing matters. | Alternating sends, each waiting for the previous. | 2×rounds sends. | A round that doesn't finish stops the debate; last good answer stands. | Last revised answer (or the best complete round). | "Claude reviewed it, then ChatGPT improved its answer." | Yes | Medium |
| 9 | **critique-revise / reflexion** | AI 1 answers, AI 2 reviews it, AI 1 revises (1–3 rounds). | Writing, code, anything that benefits from self-correction. | 1 answer + 1 review + up to rounds revises; review can short-circuit ("no changes needed"). | 2–7 sends. | If the reviewer says nothing to change, revision is skipped. | The final revised answer, or the first answer if review found nothing. | "ChatGPT improved its answer after Claude's review." | Yes | Medium-high |
| 10 | **relay / chain / pipeline** | Output of one AI is input to the next; each refines the previous. | App design, writing, structured JSON → review → approve flows. | Sequential sends; step k's prompt includes step k-1's answer (`{{previous}}`). | n sends, strictly sequential. | A stuck middle AI is skipped over (chain waits for ALL earlier stages but uses the latest ready answer); later stages still run. | The last stage's answer. | "Refined by ChatGPT → Claude." | Yes | Medium-high |
| 11 | **map-reduce** | Split work into pieces, ask per piece, merge into one. | Long documents, large codebases, research reports. | 1 split-send + k piece-sends (concurrent) + 1 merge-send. | k+2 sends; pieces observed concurrently. | A failed piece is omitted from the merge with a note, not retried. | The merged answer. | "Checked 6 parts, combined into one answer." | Yes | Medium |
| 12 | **specialist routing by role** | Route to the AI best suited to the role (reviewer → your most critical AI, writer → your clearest AI). | Dev roles via `--role`, app design, copywriting. | 1 send to the chosen specialist. | 1 send. | Same as single; if the specialist is signed out, fallback cascade to the next best. | The specialist's answer. | "Asking Claude (code reviewer)…" | Yes | Medium |
| 13 | **voting / majority / self-consistency** | Same question to several AIs; the answer most of them agree on wins. | Factual questions where consensus signals confidence. | n sends; compare answers, pick the majority cluster. | n sends; all observed concurrently. | No majority → falls back to first answer with a note. | Majority/plurality answer. | "ChatGPT, Claude and Z.ai all agreed." | Yes | Medium |
| 14 | **ensemble merge** | Blend several answers into one without a designated synthesizer AI. | When no single AI is trusted to synthesize. | n sends; merge done by the orchestrator/client (concatenate, dedupe). | n sends. | Failed answers omitted. | Merged client-side answer. | "Combined the answers from ChatGPT and Claude." | Yes | Medium |
| 15 | **verify / cross-check** | AI 1 answers; AI 2 checks it for problems. | Code, facts, anything where a second opinion prevents mistakes. | 1 answer + 1 check-send; check reads answer 1. | 2 sends. | If the checker doesn't finish, answer 1 stands with a note. | Answer 1 + verdict (OK/problems + notes). | "Claude checked ChatGPT's answer and found no problems." | Yes | Medium-high |
| 16 | **tournament / bracket** | Pairwise A vs B; winners advance; final winner. | Ranking options, deciding between several designs. | Bracket of judge-sends; leaves are answers. | 2n−1 sends in a balanced bracket. | A match that doesn't finish → the earlier-round answer advances by default. | Final bracket winner. | "After 3 rounds, Claude's answer won." | Yes | Low-medium |
| 17 | **auto** | VIVIM picks the pattern + the AIs for you, based on the task and saved performance. | You don't want to choose; "just answer this". | The router (`src/studio/ai-router.mjs`) decides pattern + sites + reason; the orchestrator runs it. | Whatever the router chooses (usually 1–3). | Same as the chosen pattern. | The router's plain-language reason is shown with the result. | "Asking ChatGPT first for a quick question — if that doesn't come back cleanly, trying Claude, then Gemini next." | Yes | High (default) |
| 18 | **agent loop / planner** | A web AI acts as the primary agent: it plans, delegates to the other web AIs via the patterns above, reads/edits files, runs approved commands, and checks results. | The north star: one of the user's own web AIs drives multi-step Work without API keys. | The planner sends one structured reply per turn; the engine parses it (tolerant: smart quotes, fences) and appends the decided steps; each step runs through the same one-browser send/receive loop. | As many steps as the planner decides, capped at MAX_STEPS per plan; each ask_ai is one send. | No resend: a sent step is only observed; the planner's next turn decides from observed results, never repeats an uncertain send. | Whatever the final planner step produces. | Plain-language summary from the planner's reply. | Yes | High (north star) |

## Value ranking (rough, one shared browser)

**High:** single, fanout, race, fallback, council, judge, verify, auto, agent loop.  
**Medium-high:** critique-revise, hedge, relay.  
**Medium:** debate, map-reduce, specialist routing, voting, ensemble merge.  
**Low-medium:** tournament.

## Failure & wording rules (consumer grade)

- Never show raw codes (`DRIVE_LEASE_BUSY`, `REPLY_TIMEOUT`, …) to the user. Codes live in `reason`; the user gets plain language (see `failureMessage` in the orchestrator).
- Waits are handled for the user: "Waiting for Claude…", "Your AI browser stayed busy with another conversation. Nothing was sent."
- Never say "retry", "revision", "turn", or "capture" in user messages.
- `studio ask --print-prompt` is the offline dry run: prints the built prompt and exits without posting anything.

## Routes

- `POST /api/v1/orchestrate` `{pattern, question, sites, options}` → `{plan}` (starts + runs the plan; idempotent dedupe on identical active question)
- `GET /api/v1/orchestrate/{planId}` → `{plan}` (progress + result; plain-language events)
- `POST /api/v1/orchestrate/{planId}/cancel` → `{plan}` (stop waiting, no resend)
- `GET /api/v1/orchestrate` → catalog + recent plans

## CLI

```
studio ask <site...> --pattern <name> --question "..." [--wait] [--save]
studio ask --pattern auto --question "..."
studio ask chatgpt claude zai --pattern council --by claude --question "..." --wait
studio ask chatgpt claude qwen --pattern race --question "..." --wait
studio ask chatgpt claude zai --pattern fallback --question "..." --wait
studio ask chatgpt claude --pattern relay --question "..." --wait
studio ask chatgpt claude --pattern critique --rounds 2 --question "..." --wait
studio ask chatgpt claude --pattern verify --question "..." --wait
studio ask chatgpt claude --pattern hedge --hedge-after 60 --question "..." --wait
studio ask chatgpt claude --pattern judge --by claude --question "..." --wait
```

Flags `--by`, `--rounds`, `--hedge-after`, `--deadline-minutes` apply to the named patterns; `--pattern auto` picks sites itself (drop site names). `--wait` polls the SAME plan id (never a second send); re-running the same command while active reattaches. `--save` writes `docs/session/ai-work/<timestamp>-<pattern>-<role>.md`.

## Agent loop (web AI as primary agent)

The orchestrator is built so a *web AI* (ChatGPT/Claude/… in the shared signed-in browser) can act as the primary agent and drive a plan itself, rather than a CLI or a fixed pattern:

- A plan can contain an `agent` (planner) step. Its prompt asks the planner AI to decide what to do next as structured JSON: `{ "finish": boolean, "summary": string, "steps": [ { site, role, prompt, after?, when? } ] }`. The engine parses that reply with the same tolerant extractor used by `src/studio/agent-actions.mjs` (smart quotes straightened, exactly one JSON object accepted from a fenced ```json block or an embedded object, more than one candidate refused rather than guessed), then **appends** the decided steps as fresh, never-attempted steps.
- When the planner sets `finish: true`, no more steps are appended; anything already sent is only observed, never re-sent.
- The internal seam for a later agent-loop module is documented and import-free on the planner side: `createPlan(spec)` → `{ plan }` (persist a plan, do not launch), `launch(plan)` → start the run loop (re-reads `plan.steps` each tick, so appended steps are picked up automatically), `appendStep(plan, { site, role, template, after, when, agent })` → append one step, `cancel(id)` / `settled(id)` → stop waiting / await completion, `planView(plan)` / `stepView(step)` → display shape. `step.agent === true` marks a step as the planner; the engine parses its reply and appends steps when it becomes ready.
- All the existing safety rules carry over unchanged: one shared browser lane serializes sends, one tab-turn per site, stable per-step keys, never resend, cancel/deadline only stop waiting, restart resumes observe-only, and timing feeds `provider-performance`.

A later lane owns the actual agent loop (reading/writing files, running approved commands, calling `createPlan`/`appendStep` for `ask_ai` actions). Nothing here reads the filesystem, runs a command, or sends to a provider.

## Migration plan

`src/studio/compare-service.mjs` (multi-site fan-out, being converted to "fan-out" by another lane — do not edit it until that lane commits) and `src/studio/personal-app-ai-design.mjs` (one site, structured JSON reply → review → approve) become thin strategies over the orchestrator:

1. Another lane finishes compare-service's fan-out conversion and commits.
2. compare-service becomes: `start` builds a `fanout` plan spec via `buildPlanSpec` and delegates to `createOrchestrator`; `get`/`cancel` pass through. Its job file schema stays `vivim.compare/1` for provider-performance compatibility.
3. personal-app-ai-design becomes: a single-step plan (`single`) plus a separate review/approve step that is NOT an AI send (human action), keeping its `vivim.personal-app-ai-job/1` schema.

Do not migrate them in this pass unless trivial and safe; compare-service is owned by another lane. The orchestrator persists plans under `<data-root>/orchestrate-plans/` (`vivim.orchestrate/1`) alongside the existing `compare-jobs/` and `personal-app-ai-job/` directories.
