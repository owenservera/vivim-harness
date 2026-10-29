// Read-only performance view over ALREADY-SAVED provider job files. Never opens a browser, never
// calls a provider, never writes. Bounded to the latest MAX_JOBS files per job kind (by mtime) so a
// large job history can never turn one request into a slow full-directory scan. Every number here
// comes from the SAME plain-language messages compare-service.mjs / personal-app-ai-design.mjs
// already saved for the user, so no second "friendly error" table is maintained here.
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

const MAX_JOBS = 200; // latest N files per job directory, by last-modified time
const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', zai: 'Z.ai', qwen: 'Qwen' };
const labelOf = (site) => LABELS[site] ?? (typeof site === 'string' && site ? site[0].toUpperCase() + site.slice(1) : 'Unknown');
// Codes that mean "we could not prove what happened", as distinct from a plain failure.
const UNCERTAIN_CODES = new Set(['DELIVERY_UNCONFIRMED', 'TURN_NOT_FOUND', 'CREATION_UNPINNED', 'RESUMED_UNFINISHED', 'REPLY_INTERRUPTED']);

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
function noteError(entry, code, message, at) {
  if (typeof at !== 'string') return;
  if (!entry.lastError || !(entry.lastError.at > at)) entry.lastError = { code: code ?? null, message: message || null, at };
}
function msBetween(startIso, endIso) {
  const start = Date.parse(startIso ?? ''), end = Date.parse(endIso ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return Math.round(sortedAsc[idx]);
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
      const ms = msBetween(result.startedAt ?? job.createdAt, result.answeredAt ?? job.updatedAt);
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

// @serves provider-performance
export async function readProviderPerformance({ paths } = {}) {
  if (!paths?.root || typeof paths.root !== 'string') throw new TypeError('paths.root is required');
  const compareDir = path.join(paths.root, 'compare-jobs');
  const aiDesignDir = path.join(paths.root, 'personal-app-ai-jobs');
  const [compareNames, aiDesignNames] = await Promise.all([latestJsonNames(compareDir), latestJsonNames(aiDesignDir)]);
  const map = new Map();
  await Promise.all([
    ...compareNames.map(async (name) => foldCompareJob(await readJsonSafe(path.join(compareDir, name)), map)),
    ...aiDesignNames.map(async (name) => foldAiDesignJob(await readJsonSafe(path.join(aiDesignDir, name)), map)),
  ]);
  const providers = [...map.values()].map(({ times, ...entry }) => ({ ...entry,
    medianMs: percentile([...times].sort((a, b) => a - b), 50), p90Ms: percentile([...times].sort((a, b) => a - b), 90) }))
    .sort((a, b) => a.site.localeCompare(b.site));
  return { schema: 'vivim.provider-performance/1', generatedAt: new Date().toISOString(),
    scanned: { compareJobs: compareNames.length, aiDesignJobs: aiDesignNames.length, maxPerKind: MAX_JOBS },
    providers };
}
