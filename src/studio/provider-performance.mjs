// Read-only performance view over ALREADY-SAVED provider job files. Never opens a browser, never
// calls a provider, never writes. Bounded to the latest MAX_JOBS files per job kind (by mtime) so a
// large job history can never turn one request into a slow full-directory scan. Every number here
// comes from the SAME plain-language messages compare-service.mjs / personal-app-ai-design.mjs
// already saved for the user, so no second "friendly error" table is maintained here.
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

const MAX_JOBS = 200; // latest N files per job directory, by last-modified time
const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', zai: 'Z.ai', qwen: 'Qwen', deepseek: 'DeepSeek', gemini: 'Gemini' };
const labelOf = (site) => LABELS[site] ?? (typeof site === 'string' && site ? site[0].toUpperCase() + site.slice(1) : 'Unknown');
// Codes that mean "we could not prove what happened", as distinct from a plain failure.
const UNCERTAIN_CODES = new Set(['DELIVERY_UNCONFIRMED', 'TURN_NOT_FOUND', 'CREATION_UNPINNED', 'RESUMED_UNFINISHED', 'REPLY_INTERRUPTED', 'REPLY_TIMEOUT', 'INTERRUPTED']);

async function latestJsonNames(directory) {
  let names;
  try { names = await readdir(directory); } catch { return []; }
  const candidates = names.filter((name) => name.endsWith('.json') && !name.includes('.tmp'));
  const withTimes = await Promise.all(candidates.map(async (name) => {
    try { const s = await stat(path.join(directory, name)); return { name, mtime: s.mtimeMs }; }
    catch { return null; } // Deleted between readdir and stat: not our failure, just skip it.
  }));
  return withTimes.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_JOBS).map((f) => f.name);
}
async function readJsonSafe(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } // Unreadable/corrupt: skip, never throw.
}
function bucket(map, site) {
  if (!map.has(site)) map.set(site, { site, label: labelOf(site), jobs: 0, completed: 0, failed: 0, skipped: 0, uncertain: 0, times: [], lastError: null });
  return map.get(site);
}
// Keep the most RECENT error only (by the job's own updatedAt), so an old failure never hides a fix.
// A message that is itself a bare CODE is not plain language: store null and let the caller de-code it.
function noteError(entry, code, message, at) {
  if (typeof at !== 'string') return;
  const text = typeof message === 'string' ? message.trim() : '';
  const plain = text && !/^[A-Z][A-Z0-9_]{2,79}$/.test(text) ? text : null;
  if (!entry.lastError || !(entry.lastError.at > at)) entry.lastError = { code: code ?? null, message: plain, at };
}
function msBetween(startIso, endIso) {
  const start = Date.parse(startIso ?? ''), end = Date.parse(endIso ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}
// Linear-interpolated percentile over an ascending array: p50 of two samples is their mean, and p90
// of a handful of samples sits between the slowest two instead of snapping to the slowest one.
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * (p / 100);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  const value = lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
  return Math.round(value);
}

// compare-jobs/*.json — src/studio/compare-service.mjs. One entry per provider PER result, since one
// job can ask several providers. result.message/.reason are already the plain-language text shown
// to the user; this module never re-derives its own copy of that wording.
function foldCompareJob(job, map) {
  if (!job || job.schema !== 'vivim.compare/1' || !Array.isArray(job.results)) return;
  for (const result of job.results) {
    const site = result?.site;
    if (typeof site !== 'string' || !site) continue;
    const entry = bucket(map, site);
    entry.jobs++;
    if (result.state === 'ready') {
      entry.completed++;
      // Asked-at → answered-at only. Never the job's createdAt/updatedAt: after the fan-out those
      // include time spent queueing behind other sites, which is not this provider's answer time.
      const ms = msBetween(result.startedAt ?? result.submittedAt, result.answeredAt);
      if (ms !== null) entry.times.push(ms);
    } else if (result.state === 'skipped') {
      entry.skipped++;
      noteError(entry, result.reason ?? 'SIGNED_OUT', result.message, job.updatedAt);
    } else if (result.state === 'failed') {
      entry.failed++;
      if (UNCERTAIN_CODES.has(result.reason)) entry.uncertain++;
      noteError(entry, result.reason, result.message, job.updatedAt);
    }
    // queued/waiting/cancelled: still in flight or stopped early, not a finished observation either way.
  }
}
// personal-app-ai-jobs/*.json — src/studio/personal-app-ai-design.mjs. One site per job.
function foldAiDesignJob(job, map) {
  if (!job || job.schema !== 'vivim.personal-app-ai-job/1' || typeof job.site !== 'string' || !job.site) return;
  const entry = bucket(map, job.site);
  entry.jobs++;
  if (job.state === 'ready-to-review' || job.state === 'applied') {
    entry.completed++;
    const ms = msBetween(job.createdAt, job.updatedAt);
    if (ms !== null) entry.times.push(ms);
  } else if (job.state === 'failed') {
    entry.failed++;
    const code = job.error?.code;
    if (UNCERTAIN_CODES.has(code)) entry.uncertain++;
    noteError(entry, code, job.error?.message, job.updatedAt);
  }
  // queued/asking/waiting-reply/discarded: not a finished observation either way.
}

// orchestrate-plans/*.json — src/studio/ai-orchestrator.mjs. One entry per SENT step (any pattern).
// Time is submit → answer, so waiting in the shared browser queue is not blamed on the provider.
// Steps never sent (not needed, race already won, cancelled) and race losers are not observations.
function foldOrchestratePlan(plan, map) {
  if (!plan || plan.schema !== 'vivim.orchestrate/1' || !Array.isArray(plan.steps)) return;
  for (const step of plan.steps) {
    if (typeof step?.site !== 'string' || !step.site) continue;
    if (step.state === 'ready') {
      const entry = bucket(map, step.site); entry.jobs++; entry.completed++;
      const ms = msBetween(step.submittedAt, step.answeredAt);
      if (ms !== null) entry.times.push(ms);
    } else if (step.state === 'skipped' && step.reason === 'SIGNED_OUT') {
      const entry = bucket(map, step.site); entry.jobs++; entry.skipped++;
      noteError(entry, 'SIGNED_OUT', step.message, plan.updatedAt);
    } else if (step.state === 'failed') {
      const entry = bucket(map, step.site); entry.jobs++; entry.failed++;
      if (UNCERTAIN_CODES.has(step.reason)) entry.uncertain++;
      noteError(entry, step.reason, step.message, plan.updatedAt);
    }
  }
}

// Bounded fan-out: at most `limit` files in flight, so 600 candidate names never mean 600 open
// handles at once on Windows. Results keep input order; a thrown read is impossible (readJsonSafe).
async function mapBounded(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; await fn(items[index], index); }
  });
  await Promise.all(workers);
}

// @serves provider-performance
export async function readProviderPerformance({ paths } = {}) {
  if (!paths?.root || typeof paths.root !== 'string') throw new TypeError('paths.root is required');
  const compareDir = path.join(paths.root, 'compare-jobs');
  const aiDesignDir = path.join(paths.root, 'personal-app-ai-jobs');
  const orchestrateDir = path.join(paths.root, 'orchestrate-plans');
  const [compareNames, aiDesignNames, orchestrateNames] = await Promise.all([latestJsonNames(compareDir), latestJsonNames(aiDesignDir), latestJsonNames(orchestrateDir)]);
  const map = new Map();
  const tasks = [
    ...compareNames.map((name) => [path.join(compareDir, name), foldCompareJob]),
    ...aiDesignNames.map((name) => [path.join(aiDesignDir, name), foldAiDesignJob]),
    ...orchestrateNames.map((name) => [path.join(orchestrateDir, name), foldOrchestratePlan]),
  ];
  // Folded one at a time after each read: the map is shared, so no two folds ever interleave.
  await mapBounded(tasks, 16, async ([file, fold]) => fold(await readJsonSafe(file), map));
  const providers = [...map.values()].map(({ times, ...entry }) => {
    const sorted = [...times].sort((a, b) => a - b);
    return { ...entry, medianMs: percentile(sorted, 50), p90Ms: percentile(sorted, 90) };
  }).sort((a, b) => a.site.localeCompare(b.site));
  return { schema: 'vivim.provider-performance/1', generatedAt: new Date().toISOString(),
    scanned: { compareJobs: compareNames.length, aiDesignJobs: aiDesignNames.length, orchestratePlans: orchestrateNames.length, maxPerKind: MAX_JOBS },
    providers };
}
