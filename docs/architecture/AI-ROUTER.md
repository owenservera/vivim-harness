# AI auto router — `src/studio/ai-router.mjs`

What decides, for `pattern: "auto"` on the central orchestrator (`src/studio/ai-orchestrator.mjs`,
built in parallel with this doc), WHICH pattern (single ask, a fallback chain, a review panel +
judge, a council of independent opinions, a race/hedge, a research fan-out, …) and WHICH of the
person's own signed-in AI accounts to use for one task. The orchestrator owns every pattern's actual
execution (sending turns, fan-out/judge/council/critique-revise wiring, relay/chain state); this
module only makes the choice and explains it in plain language. It never opens a browser, calls a
provider, or touches the filesystem on its own — see "Purity" below.

## Why a separate module

`bin/commands/ask.mjs` already has a tiny `--auto N` ranking (fastest+most-reliable-by-success-rate,
from `GET /providers/performance`). This module is the same idea grown up: it classifies the task
first, picks a *pattern* (not just a flat list of N sites), understands constraints like "only one
send" or "answer fast", respects that VIVIM drives every site through ONE shared browser, and
explores under-sampled providers on purpose so their stats actually improve over time. `ask.mjs`'s
existing `--auto` flag is untouched; this is additive, for the orchestrator to call.

## Contract

```js
import { route, explain, learnInput, classifyTask } from './ai-router.mjs';

const decision = route({
  task,                 // free text — the actual question/prompt
  role,                 // optional: 'reviewer' | 'implementer' | 'explainer' | 'copywriter' (ask-prompts.mjs's ROLE_NAMES)
  constraints: {         // all optional
    maxSends,            // hard cap on total sites used
    maxWaitMs,            // tight budget => prefer a race/hedge over a queued chain
    mustInclude,          // site ids that must appear if they're eligible
    exclude,              // site ids that must never appear
    structuredReply,       // true forces the "app-design" class regardless of text
  },
  providers: [{ site, signedIn, tabOpen, stats: { jobs, completed, failed, skipped, uncertain, medianMs, p90Ms } }],
  now,                   // optional epoch ms; defaults to Date.now() once, at the top
});
// => { pattern, sites, options, reason, alternatives }

explain(decision); // one short consumer-plain line, e.g.
// "Asking Claude first — it's been fastest and most reliable for you; Gemini is the backup."
```

`route()` and `classifyTask()` are pure: same inputs, same output, forever. No network, no `fs`,
no browser, no unlogged clock reads. `learnInput()` is the one place that touches the real world,
and only through injected async readers (see below) — it builds `providers[]` so a caller rarely
has to hand-assemble it.

### Output shape

- `pattern` — one of `single`, `fallback`, `judge`, `council`, `fan-out`, `race`.
- `sites` — ordered array of site ids to use, already capped to what the shared browser and
  `constraints.maxSends` allow. Best choice first.
- `options` — pattern-specific knobs for the orchestrator: `chain` (fallback), `panel`/`judgeSite`
  (judge), `synthesize` (council), `parallel` (fan-out), `hedge`/`useFirstReply` (race); plus
  `taskClass`, `estimatedSubmitOverheadMs` (see "Shared browser" below), `explorationPicks`
  (which chosen sites were an exploration pick this time), and `constraintsApplied` (an echo of
  what was actually honored, for debugging/telemetry).
- `reason` — plain language, no jargon, suitable to show a person directly.
- `alternatives` — 0-3 other `{ pattern, sites, reason }` sketches the caller could offer ("for the
  fastest possible answer instead, VIVIM could ask the top 2 at once…").

## Task classification

`classifyTask({ task, role, constraints })` → one of `quick`, `implementation`, `app-design`,
`writing`, `review`, `decision`, `research`.

Priority order, each step short-circuits:
1. `constraints.structuredReply === true` → `app-design` (explicit always wins).
2. `role` maps directly: `reviewer` → `review`, `implementer` → `implementation`,
   `copywriter` → `writing` (same role names `ask-prompts.mjs` uses). `explainer` falls through to
   text heuristics below (an explanation can be a quick question or a long research dive).
3. Free-text regex heuristics, checked in this order: code-review words (`diff`, `pull request`,
   `code review`, …) → `review`; implementation words (`implement`, `fix the bug`, `refactor`, …) →
   `implementation`; app/UI/schema words (`app design`, `wireframe`, `structured json`, …) →
   `app-design`; decision words (`should we`, `trade-offs`, `pros and cons`, …) → `decision`;
   research words (`research`, `comprehensive`, `deep dive`, …) **and** text over 300 characters →
   `research`; copy words (`write the copy`, `rewrite`, `marketing copy`, …) → `writing`.
4. Short text ending in `?` (≤160 chars) → `quick`.
5. Default: long free text (>300 chars) → `research`; everything else → `quick`.

This is a deliberately simple, visible heuristic, not a model call — wrong guesses are easy to spot
and the regexes in the module are the whole story. A caller that already knows the task type should
pass `role` or `constraints.structuredReply` rather than rely on text sniffing.

## Scoring providers

Every **eligible** provider (signed in, not excluded) gets a composite score, best-first:

| Signal | Weight / effect |
|---|---|
| Success rate (`completed / jobs`) | 0.5. Cold start (`jobs === 0`) assumes a cautiously optimistic 0.55 rather than 0 or 1. |
| Latency (median weighted 0.7, p90 weighted 0.3, both lower-is-better, scaled so ~45s typical reply ≈ 0) | 0.3. No latency data → neutral 0.5. |
| Structured-reply track record, for `app-design` tasks only | +0.12 × success rate. **Limitation**: `provider-performance.mjs` folds `compare-jobs` and `personal-app-ai-jobs` (the actual structured-JSON design jobs) into ONE combined bucket per site today, so this router uses that combined rate as its best available proxy. Splitting ai-design stats out in `provider-performance.mjs` would sharpen this; out of scope here. |
| Recent failure | −0.2, decaying linearly over 15 minutes, if `stats.lastErrorAt` (an ISO timestamp — optional, populated by `learnInput()` from `provider-performance.mjs`'s `lastError.at`) is inside that window. |
| Tab not already open | −0.03 (opening a fresh tab costs a little time; not disqualifying). |
| Cold-start default order (`chatgpt, claude, gemini, deepseek, zai, qwen`) | a tiny (0.001-scale) tie-break so otherwise-identical cold providers still sort sensibly instead of by object-insertion order. |
| Deterministic exploration pick | +0.22, see below. |

`signedIn === false` providers are filtered out before scoring and **never** appear in `sites` —
the one hard rule. A provider with `signedIn` omitted is treated as signed in (optimistic default);
the real, authoritative gate against sending to a signed-out account is still `compare-service.mjs`
at actual submit time, so this router's rule is a courtesy, not the enforcement point.

`constraints.mustInclude` moves a requested, eligible site to the very front of the ranked list
(in the order given), ahead of score. A `mustInclude` site that is not signed in (or not present
at all) is dropped with a note in `reason`, never silently promised. `constraints.exclude` removes
sites before scoring entirely.

### Exploration

So an under-sampled provider's stats actually improve over time, a provider with fewer than 5
saved jobs gets a deterministic "explore it this time" bonus roughly 1 time in 10 — deterministic
because it's a plain string hash of `site + task + role` (`djb2`, `% 10 === 0`), not `Math.random()`.
The SAME task text always makes the SAME exploration choice, so a decision stays explainable and
reproducible rather than being a hidden coin flip. `explorationPick(providers, { task, role })` is
exported standalone so a caller (or a test) can check this without re-deriving the scoring math.

## Pattern selection

| Task class | Base pattern | Why |
|---|---|---|
| `quick` (a quick factual question) | `fallback` | Fastest healthy site first; a short ordered chain of backups behind it if the first doesn't come back cleanly — nothing routes twice to the same site, the chain just tries the next one. |
| `implementation` (write a diff) | `fallback` | One real attempt is usually enough for a mechanical diff; one backup. |
| `app-design` (structured JSON / app/UI design) | `fallback` | The single site with the best structured-reply track record, then a cascade — matches "single best + fallback cascade" from the design brief. |
| `writing` (copy) | `single` | Low stakes; one shot, no automatic retry chain. |
| `review` (code review) | `judge` | 2-3 sites review independently (`options.panel`), then the single MOST trusted site of the group judges/merges their findings (`options.judgeSite`) — deliberately the most reliable, not the fastest, since arbitration quality matters more than speed here. |
| `decision` (important decision) | `council` | 3-5 signed-in sites, each asked independently (`options.synthesize: true` tells the orchestrator this needs a synthesis/vote step, not just the first answer). |
| `research` (long research) | `fan-out` | 2-3 sites look into it in parallel (`options.parallel: true`); no single answer is assumed sufficient. |

**Latency override**: if `constraints.maxWaitMs` is set and ≤ 30 seconds, and the task isn't an
important `decision` (speed should never outrank getting several independent opinions on something
that matters), the pattern becomes `race`: the top 2 ranked sites are asked at once and whichever
replies first wins (`options.hedge`, `options.useFirstReply`).

**Step-down when there aren't enough eligible sites** (or `constraints.maxSends` won't allow it):
`council` needs ≥3 or steps down to `judge` (≥2) or `fallback`; `judge`, `fan-out` and `race` need
≥2 or step down to `fallback`; anything that ends up with exactly 1 site is reported as `single`,
not a one-item fallback chain, so the pattern name always matches what's actually happening.

## Shared browser / cap sends

VIVIM drives every provider through ONE shared browser (`compare-service.mjs`'s own design: phase 1
submits to each site sequentially on that one lane; phase 2 then lets every reply stream back
concurrently). So the FIRST site in a pattern costs its own reply time, but EVERY additional site
adds roughly one more sequential submit's wait (`SUBMIT_OVERHEAD_MS = 8000` here, a rough constant,
not measured from real telemetry yet) before all the replies are in flight together. `options.
estimatedSubmitOverheadMs = (sites.length - 1) * 8000` surfaces this so a caller can decide it isn't
worth adding a 4th site. The per-class `ideal` panel sizes above (3 for `quick`/`app-design`/
`research`, 3 for `judge`, 5 for `council`) are already chosen with this in mind; `constraints.
maxSends` is an additional hard ceiling a caller can apply on top.

## Cold start

With zero saved jobs anywhere, every provider is scored on the same neutral baseline (0.55 success
rate assumption, neutral latency), so the only thing that breaks ties is the fixed default order:
`chatgpt, claude, gemini, deepseek, zai, qwen`. The very first few real asks naturally start building
real stats, and the exploration mechanic (above) keeps nudging attention toward whichever account
has the fewest saved jobs so a brand-new install doesn't stay blind to its weaker-known providers.

## `learnInput()` — the one I/O seam

```js
const providers = await learnInput({
  paths,                         // same { root } shape provider-performance.mjs expects
  readPerformance,                 // optional override; defaults to the real provider-performance.mjs
  readTargets: async () => { ... }, // optional: return conversation_targets()'s { targets, sites, signedIn? }
});
const decision = route({ task, providers });
```

It calls the SAME read-only `readProviderPerformance()` (`provider-performance.mjs`) `studio ask
--auto` already uses for `stats`, plus a caller-supplied `readTargets()` (normally the Studio
conversation runtime's own `targets()`, or the already-existing `GET /conversation-targets` route
backed by it) for which sites currently have an open tab (`tabOpen`). **Documented limitation**:
`conversation_targets` reports open tabs, not account sign-in — true sign-in proof only exists the
moment `compare-service.mjs` actually opens/uses a conversation. Until a richer signal exists,
`learnInput()` marks a site `signedIn: true` unless `readTargets()`'s result includes an explicit
`signedIn` map saying otherwise. Everything is injectable so this stays testable fully offline.

## Verification

No test suites (per `docs/session/GOAL.md` rule 6). Verified with `node --check` on the new file and
an offline `node -e`-style script exercising 11 scenarios (cold start, one signed-out, slow
provider, code review, app design, council trigger, maxSends=1, exploration pick, latency-sensitive
race, mustInclude+exclude, all-signed-out-blocked), each backed by a hard assertion (signed-out
sites never appear, the right pattern fires, exploration actually surfaces, blocked never throws).
All 11 passed; see the commit message / session log for the printed decision table.
