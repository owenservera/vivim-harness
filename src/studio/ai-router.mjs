// Auto router: decides WHICH AI pattern (single ask, a fallback chain, a review panel + judge, a
// council of independent opinions, a race/hedge, a fan-out for research, …) and WHICH of the
// person's own signed-in AI accounts to use for one task. This module is the brain behind
// `pattern: "auto"` on the central orchestrator (src/studio/ai-orchestrator.mjs); it never talks to
// a browser, a provider or the filesystem itself.
//
// Purity contract: `route()` and `classifyTask()` are pure functions of their arguments. No
// network, no fs, no Date.now() side effects beyond the optional `now` input (defaulted once, at
// the top, never re-read). Anything that needs to WATCH the real world (saved job history, which
// browser tabs are open) lives in `learnInput()`, a small async helper that calls injected readers
// and shapes their output into the plain `providers[]` array `route()` expects. See
// docs/architecture/AI-ROUTER.md for the full design write-up, scoring weights and worked examples.
//
// Nothing here duplicates the REAL safety gates. compare-service.mjs still re-checks sign-in before
// ever typing into a page; this router's "never route to signed-out sites" rule is a courtesy (ask
// a useless site) layer, not the enforcement point.

import { readProviderPerformance } from './provider-performance.mjs';

// Cold-start order (no saved history anywhere yet): the four accounts VIVIM ships adapters for
// today plus two more in the compare roster, in a sensible "most people have these" order.
export const DEFAULT_ORDER = Object.freeze(['chatgpt', 'claude', 'gemini', 'deepseek', 'zai', 'qwen']);
const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', zai: 'Z.ai', qwen: 'Qwen', deepseek: 'DeepSeek', gemini: 'Gemini' };
export const labelOf = (site) => LABELS[site] ?? (typeof site === 'string' && site ? site[0].toUpperCase() + site.slice(1) : 'that AI');

export const TASK_CLASSES = Object.freeze(['quick', 'implementation', 'app-design', 'writing', 'review', 'decision', 'research']);
export const PATTERNS = Object.freeze(['single', 'fallback', 'judge', 'council', 'fan-out', 'race']);

// --- classification -------------------------------------------------------------------------
// role (from ask-prompts.mjs's ROLE_NAMES) is the strongest signal when given; free text is a
// best-effort heuristic on top. Neither is "smart"; both are deliberately simple and documented
// so a wrong guess is easy to see and tune.
const ROLE_CLASS = { reviewer: 'review', implementer: 'implementation', copywriter: 'writing' };
const RE = {
  review: /\b(diff|patch|pull request|\bpr\b|code review|review (this|the) code|unified diff)\b/i,
  implementation: /\b(implement|write the code|add a (function|feature|endpoint)|fix the bug|refactor|make the change|write a patch)\b/i,
  appDesign: /\b(app design|ui design|wireframe|screen design|component tree|design the (screen|app|flow|ui)|structured (json|reply)|json shape|schema for)\b/i,
  decision: /\b(should we|which (option|approach|provider|strategy|plan)|go\/no-go|trade-?offs?|pros and cons|strategic decision|decide between)\b/i,
  research: /\b(research|comprehensive|deep dive|survey|literature|exhaustive|in-depth|long report|investigate thoroughly)\b/i,
  writing: /\b(write (a|the) (copy|headline|caption|tagline|message|email|blog)|rewrite|copywriting|marketing copy|plain-language wording)\b/i,
  question: /\?\s*$/,
};

// @serves ai-orchestrator (pattern: "auto")
export function classifyTask({ task = '', role = null, constraints = {} } = {}) {
  const text = String(task ?? '');
  if (constraints?.structuredReply === true) return 'app-design'; // explicit beats every heuristic
  if (role && ROLE_CLASS[role]) return ROLE_CLASS[role];
  if (RE.review.test(text)) return 'review';
  if (RE.implementation.test(text)) return 'implementation';
  if (RE.appDesign.test(text)) return 'app-design';
  if (RE.decision.test(text)) return 'decision';
  if (RE.research.test(text) && text.length > 300) return 'research';
  if (RE.writing.test(text)) return 'writing';
  if (text.length <= 160 && RE.question.test(text.trim())) return 'quick';
  return text.length > 300 ? 'research' : 'quick';
}

// --- scoring ---------------------------------------------------------------------------------
// Weighted blend of: success rate, latency (median weighted more than p90, both lower-is-better),
// a penalty for a still-recent failure, a small nudge for an already-open tab, a tiny deterministic
// tie-break toward the cold-start default order, and an occasional deterministic "go learn about
// this one" exploration bonus for an under-sampled provider. Every weight is a named constant so
// the balance is easy to see and retune; none of it is calibrated against real data yet (see the
// "left for later" note in the doc).
const COLD_START_NEUTRAL = 0.55;   // assumed success rate with zero saved jobs: cautiously optimistic
const WEIGHT_SUCCESS = 0.5;
const WEIGHT_LATENCY = 0.3;
const WEIGHT_STRUCTURED_BONUS = 0.12; // app-design: extra credit for the SAME combined track record (see doc limitation)
const NEUTRAL_LATENCY_SCORE = 0.5;
const LATENCY_SCALE_MS = 45_000;   // latency score reaches 0 around 45s typical reply time
const RECENT_FAILURE_WINDOW_MS = 15 * 60_000; // a failure in the last 15 minutes still stings
const RECENT_FAILURE_PENALTY = 0.2;
const TAB_CLOSED_PENALTY = 0.03;   // opening a fresh tab costs a little time; not disqualifying
const COLD_START_TIEBREAK = 0.001; // just enough to order otherwise-tied cold providers sensibly
const EXPLORE_JOBS_THRESHOLD = 5;  // "under-sampled" = fewer than this many saved jobs
const EXPLORE_RATE = 10;           // 1 in EXPLORE_RATE, deterministically
const EXPLORE_BONUS = 0.22;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// Plain djb2 string hash. No Math.random anywhere in this module: the same (site, task, role)
// always explores or doesn't, so a decision is reproducible and explainable, not a coin flip.
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; }

// Exported standalone so a caller (or the smoke script) can see exploration picks without
// re-deriving the scoring math. Only ever considers providers already allowed to be routed to.
export function explorationPick(providers, { task = '', role = null } = {}) {
  const picks = [];
  for (const p of providers ?? []) {
    if (!p || p.signedIn === false) continue;
    const jobs = Number.isFinite(p.stats?.jobs) ? p.stats.jobs : 0;
    if (jobs >= EXPLORE_JOBS_THRESHOLD) continue;
    if (hashStr(`${p.site}|${task}|${role ?? ''}`) % EXPLORE_RATE === 0) picks.push(p.site);
  }
  return picks;
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function scoreOf(provider, { taskClass, now, explored }) {
  const stats = provider.stats ?? {};
  const jobs = Number.isFinite(stats.jobs) ? stats.jobs : 0;
  const completed = Number.isFinite(stats.completed) ? stats.completed : 0;
  const successRate = jobs > 0 ? completed / jobs : COLD_START_NEUTRAL;
  let score = successRate * WEIGHT_SUCCESS;
  const medianMs = Number.isFinite(stats.medianMs) ? stats.medianMs : null;
  const p90Ms = Number.isFinite(stats.p90Ms) ? stats.p90Ms : null;
  const latencyMs = medianMs != null && p90Ms != null ? medianMs * 0.7 + p90Ms * 0.3 : (medianMs ?? p90Ms);
  score += (latencyMs == null ? NEUTRAL_LATENCY_SCORE : clamp(1 - latencyMs / LATENCY_SCALE_MS, 0, 1)) * WEIGHT_LATENCY;
  const lastErrorAt = typeof stats.lastErrorAt === 'string' ? Date.parse(stats.lastErrorAt) : NaN;
  if (Number.isFinite(lastErrorAt) && jobs > 0) {
    const ageMs = Math.max(0, now - lastErrorAt);
    if (ageMs < RECENT_FAILURE_WINDOW_MS) score -= RECENT_FAILURE_PENALTY * (1 - ageMs / RECENT_FAILURE_WINDOW_MS);
  }
  if (taskClass === 'app-design') score += successRate * WEIGHT_STRUCTURED_BONUS;
  if (!provider.tabOpen) score -= TAB_CLOSED_PENALTY;
  const idx = DEFAULT_ORDER.indexOf(provider.site);
  if (idx >= 0) score += (DEFAULT_ORDER.length - idx) * COLD_START_TIEBREAK;
  if (explored) score += EXPLORE_BONUS;
  return score;
}

function whySite(entry) {
  const stats = entry?.stats ?? {};
  const jobs = Number.isFinite(stats.jobs) ? stats.jobs : 0;
  if (!jobs) return entry?._explored ? "it's under-sampled so far, so VIVIM is trying it to learn how it does" : 'there is no history for it yet, so this is a sensible starting guess';
  const rate = Math.round((stats.completed / jobs) * 100);
  const ms = fmtMs(stats.medianMs);
  return `it has answered ${rate}% of your last ${jobs} asks successfully${ms ? `, typically back in about ${ms}` : ''}`;
}

// Ranks ELIGIBLE providers (already filtered for signed-in / not-excluded) best first. Marks the
// deterministic exploration picks so later steps (reason/alternatives) can mention them honestly.
function rankProviders(eligible, { taskClass, task, role, now }) {
  const explored = new Set(explorationPick(eligible, { task, role }));
  return eligible
    .map((p) => ({ ...p, _explored: explored.has(p.site), _score: scoreOf(p, { taskClass, now, explored: explored.has(p.site) }) }))
    .sort((a, b) => b._score - a._score);
}

// A caller-requested site is moved to the front (in the order given), ahead of the ranked list,
// as long as it is actually eligible; the rest of the ranking is otherwise undisturbed.
function withMustInclude(ranked, mustInclude) {
  const want = (Array.isArray(mustInclude) ? mustInclude : []).filter((site) => ranked.some((p) => p.site === site));
  if (!want.length) return ranked;
  const front = want.map((site) => ranked.find((p) => p.site === site));
  return [...front, ...ranked.filter((p) => !want.includes(p.site))];
}

// --- pattern selection -------------------------------------------------------------------------
// Base pattern + how many sites it ideally wants, per task class. "min" is the fewest signed-in
// providers the pattern actually needs to mean anything; below that it steps down to something
// simpler rather than silently asking fewer providers than the pattern implies.
const PATTERN_SPEC = {
  quick: { base: 'fallback', min: 1, ideal: 3 },          // fastest healthy first, chain behind it
  implementation: { base: 'fallback', min: 1, ideal: 2 }, // one real diff attempt, one backup
  'app-design': { base: 'fallback', min: 1, ideal: 3 },   // best structured-reply site + cascade
  writing: { base: 'single', min: 1, ideal: 1 },          // low stakes, one shot
  review: { base: 'judge', min: 2, ideal: 3 },            // 2-3 findings + the most trusted judges them
  decision: { base: 'council', min: 3, ideal: 5 },        // important: several independent opinions
  research: { base: 'fan-out', min: 2, ideal: 3 },        // long research in parallel
};
const LATENCY_HEDGE_THRESHOLD_MS = 30_000; // constraints.maxWaitMs this tight => hedge, don't queue
// Per compare-service.mjs's own design: phase 1 submits sequentially on the ONE shared browser lane
// before phase 2's replies stream back concurrently. Each extra site therefore adds roughly one
// more submit's worth of wait before every reply is in flight together, not before every reply lands.
const SUBMIT_OVERHEAD_MS = 8_000;

function decidePattern(taskClass, orderedCount, constraints) {
  const spec = PATTERN_SPEC[taskClass] ?? PATTERN_SPEC.quick;
  const capped = (n) => (Number.isFinite(constraints.maxSends) && constraints.maxSends >= 1 ? Math.min(n, constraints.maxSends) : n);
  let pattern = spec.base;
  let count = capped(Math.min(spec.ideal, orderedCount));

  // Latency-sensitive override: speed beats the normal pattern choice, EXCEPT for an important
  // decision — there, getting several independent opinions matters more than shaving off seconds.
  if (Number.isFinite(constraints.maxWaitMs) && constraints.maxWaitMs <= LATENCY_HEDGE_THRESHOLD_MS && taskClass !== 'decision' && orderedCount >= 2) {
    pattern = 'race';
    count = capped(Math.min(2, orderedCount));
  }

  // Step down when there simply aren't (or maxSends won't allow) enough providers for the pattern
  // to mean what it says, instead of running a "council" of one.
  if (pattern === 'council' && count < 3) pattern = count >= 2 ? 'judge' : 'fallback';
  if (pattern === 'judge' && count < 2) pattern = 'fallback';
  if (pattern === 'fan-out' && count < 2) pattern = 'fallback';
  if (pattern === 'race' && count < 2) pattern = 'fallback';
  if (count <= 1) pattern = 'single';
  return { pattern, count: Math.max(1, count) };
}

function buildOptions(pattern, sites, taskClass, constraints, explorationPicks) {
  const options = {
    taskClass,
    estimatedSubmitOverheadMs: Math.max(0, sites.length - 1) * SUBMIT_OVERHEAD_MS,
    explorationPicks,
    constraintsApplied: { maxSends: constraints.maxSends ?? null, maxWaitMs: constraints.maxWaitMs ?? null,
      mustInclude: constraints.mustInclude ?? [], exclude: constraints.exclude ?? [] },
  };
  if (pattern === 'fallback') options.chain = sites;
  if (pattern === 'judge') { options.panel = sites.slice(0, -1); options.judgeSite = sites[sites.length - 1]; }
  if (pattern === 'council') options.synthesize = true;
  if (pattern === 'fan-out') options.parallel = true;
  if (pattern === 'race') { options.hedge = true; options.useFirstReply = true; }
  return options;
}

const CLASS_PHRASE = {
  quick: 'a quick question', implementation: 'a code change', 'app-design': 'an app design',
  writing: 'writing', review: 'a code review', decision: 'an important decision', research: 'research',
};

function reasonFor({ taskClass, pattern, sites, bySite, explorationPicks, dropped }) {
  const L = labelOf;
  const parts = [];
  switch (pattern) {
    case 'single':
      parts.push(`Asking ${L(sites[0])} — ${whySite(bySite.get(sites[0]))}.`); break;
    case 'fallback':
      parts.push(`Asking ${L(sites[0])} first for ${CLASS_PHRASE[taskClass] ?? 'this'} — ${whySite(bySite.get(sites[0]))}.`);
      if (sites.length > 1) parts.push(`If that doesn't come back cleanly, trying ${sites.slice(1).map(L).join(', then ')} next.`);
      break;
    case 'judge': {
      const judgeSite = sites[sites.length - 1], panel = sites.slice(0, -1);
      parts.push(`Asking ${panel.map(L).join(' and ')} to review this independently, then having ${L(judgeSite)} weigh both answers and settle on the best one — ${L(judgeSite)} ${whySite(bySite.get(judgeSite))}.`);
      break;
    }
    case 'council':
      parts.push(`This looks like an important decision, so asking ${sites.map(L).join(', ')} independently for their own take before you decide.`); break;
    case 'fan-out':
      parts.push(`This looks like a bigger research question, so asking ${sites.map(L).join(' and ')} to look into it in parallel.`); break;
    case 'race':
      parts.push(`Speed matters here, so asking ${sites.map(L).join(' and ')} at the same time and using whichever answers first.`); break;
    default:
      parts.push(`Asking ${sites.map(L).join(', ')}.`);
  }
  if (explorationPicks.length) parts.push(`Also trying ${explorationPicks.map(L).join(', ')}, which VIVIM hasn't used much yet, so it keeps learning how it does.`);
  if (dropped.length) parts.push(`Skipped ${dropped.map(L).join(', ')}: not signed in right now.`);
  if (sites.length > 1) parts.push(`Each extra AI adds a bit of submit time on your one shared browser before replies start overlapping, so this stays at ${sites.length}.`);
  return parts.join(' ');
}

function buildAlternatives({ taskClass, pattern, sites, ranked, constraints }) {
  const alts = [];
  const bench = ranked.filter((p) => !sites.includes(p.site)).slice(0, 2).map((p) => p.site);
  if (bench.length) alts.push({ pattern: 'fallback', sites: bench, reason: `Other signed-in options if these don't pan out: ${bench.map(labelOf).join(', ')}.` });
  if (pattern !== 'race' && ranked.length >= 2 && !Number.isFinite(constraints.maxWaitMs)) {
    alts.push({ pattern: 'race', sites: ranked.slice(0, 2).map((p) => p.site), reason: 'For the fastest possible answer instead, VIVIM could ask the top 2 at once and use whichever replies first.' });
  }
  if (pattern !== 'council' && taskClass !== 'decision' && ranked.length >= 3) {
    alts.push({ pattern: 'council', sites: ranked.slice(0, 3).map((p) => p.site), reason: 'For extra confidence, VIVIM could ask 3 AIs independently instead of just one.' });
  }
  return alts;
}

function blockedDecision(taskClass) {
  return { pattern: 'single', sites: [], options: { taskClass, blocked: true },
    reason: 'No AI accounts are signed in right now, so there is nothing to ask yet. Sign in to at least one AI in your VIVIM browser, then try again.',
    alternatives: [] };
}

// --- the decision function --------------------------------------------------------------------
// @serves ai-orchestrator (pattern: "auto")
// Pure: same inputs always produce the same decision. No network, no fs, no browser, no clock
// reads beyond the `now` argument (defaulted once here, never re-read mid-function).
export function route({ task, role = null, constraints = {}, providers, now = Date.now() } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new TypeError('task (non-empty string) is required');
  if (!Array.isArray(providers)) throw new TypeError('providers (array) is required');
  const c = constraints ?? {};
  const excludeSet = new Set(Array.isArray(c.exclude) ? c.exclude : []);

  const taskClass = classifyTask({ task, role, constraints: c });
  const known = providers.filter((p) => p && typeof p.site === 'string' && p.site);
  const eligible = known.filter((p) => p.signedIn !== false && !excludeSet.has(p.site));
  const droppedMustInclude = (Array.isArray(c.mustInclude) ? c.mustInclude : [])
    .filter((site) => !eligible.some((p) => p.site === site) && known.some((p) => p.site === site));

  if (!eligible.length) return blockedDecision(taskClass);

  const ranked = withMustInclude(rankProviders(eligible, { taskClass, task, role, now }), c.mustInclude);
  const bySite = new Map(ranked.map((p) => [p.site, p]));
  const { pattern, count } = decidePattern(taskClass, ranked.length, c);
  const sites = ranked.slice(0, count).map((p) => p.site);
  const explorationPicks = sites.filter((site) => bySite.get(site)?._explored);
  const signedOutRequested = (Array.isArray(c.mustInclude) ? c.mustInclude : []).filter((site) => known.some((p) => p.site === site && p.signedIn === false));

  const options = buildOptions(pattern, sites, taskClass, c, explorationPicks);
  const dropped = [...new Set([...droppedMustInclude, ...signedOutRequested])];
  const reason = reasonFor({ taskClass, pattern, sites, bySite, explorationPicks, dropped });
  const alternatives = buildAlternatives({ taskClass, pattern, sites, ranked, constraints: c });
  return { pattern, sites, options, reason, alternatives };
}

// One short, consumer-plain line summarizing a decision already produced by route().
export function explain(decision) {
  if (!decision || !Array.isArray(decision.sites)) return 'Could not decide who to ask yet.';
  const L = labelOf;
  const { pattern, sites } = decision;
  if (!sites.length) return 'No AI accounts are signed in right now, so VIVIM has nothing to ask.';
  switch (pattern) {
    case 'single': return `Asking ${L(sites[0])}.`;
    case 'fallback': return `Asking ${L(sites[0])} first — it's been fastest and most reliable for you${sites.length > 1 ? `; ${L(sites[1])} is the backup.` : '.'}`;
    case 'judge': { const judge = sites[sites.length - 1], panel = sites.slice(0, -1);
      return `Asking ${panel.map(L).join(' and ')} to review this, then ${L(judge)} judges the two answers.`; }
    case 'council': return `Asking ${sites.map(L).join(', ')} independently since this is an important decision.`;
    case 'fan-out': return `Asking ${sites.map(L).join(' and ')} to research this in parallel.`;
    case 'race': return `Asking ${sites.map(L).join(' and ')} at once — using whichever answers first.`;
    default: return `Asking ${sites.map(L).join(', ')}.`;
  }
}

// --- learnInput: the only part of this module that touches the real world --------------------
// Builds route()'s `providers[]` from the SAME already-saved performance view `studio ask --auto`
// uses (provider-performance.mjs: read-only, bounded, never opens a browser) plus a caller-supplied
// `readTargets()` — normally the Studio conversation runtime's own `targets()` (src/capture/
// conversation-runtime.mjs) or the /conversation-targets HTTP route backed by it — for which sites
// currently have an open tab. Everything here is injectable so it stays testable offline; the
// default `readPerformance` is the real module so a normal caller needs to pass only `paths`.
//
// Known limitation (documented rather than silently papered over): conversation_targets reports
// which sites have an open tab, not whether the account itself is signed in — that proof only
// exists at the moment compare-service.mjs actually tries to open/use a conversation. Until a
// richer signal exists, a site with no contradicting evidence is treated as signed in here (the
// real send-time gate in compare-service.mjs is the actual enforcement point); pass an explicit
// `signedIn` map in readTargets()'s result to override this once one exists.
export async function learnInput({ paths, readPerformance = readProviderPerformance, readTargets = null, now } = {}) {
  if (!paths?.root || typeof paths.root !== 'string') throw new TypeError('paths.root is required');
  const [performance, targetsResult] = await Promise.all([
    readPerformance({ paths }),
    typeof readTargets === 'function' ? readTargets() : Promise.resolve(null),
  ]);
  const perfBySite = new Map((performance?.providers ?? []).map((p) => [p.site, p]));
  const tabOpenSites = new Set((targetsResult?.targets ?? []).map((t) => t?.site).filter(Boolean));
  const explicitSignedIn = targetsResult?.signedIn && typeof targetsResult.signedIn === 'object' ? targetsResult.signedIn : {};
  const sites = new Set([...perfBySite.keys(), ...tabOpenSites, ...DEFAULT_ORDER]);

  return [...sites].map((site) => {
    const perf = perfBySite.get(site);
    const signed = explicitSignedIn[site];
    return {
      site,
      signedIn: typeof signed === 'boolean' ? signed : true,
      tabOpen: tabOpenSites.has(site),
      stats: { jobs: perf?.jobs ?? 0, completed: perf?.completed ?? 0, failed: perf?.failed ?? 0,
        skipped: perf?.skipped ?? 0, uncertain: perf?.uncertain ?? 0, medianMs: perf?.medianMs ?? null,
        p90Ms: perf?.p90Ms ?? null, lastErrorAt: perf?.lastError?.at ?? null },
    };
  });
}
