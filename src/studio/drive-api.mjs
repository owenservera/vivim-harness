// Job metadata only: prompts, replies and raw driver events never enter this API's history.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { driveSite } from '../capture/actions.mjs';
import { runCampaign, siteOrder, defaultPrompt, expectedAnswer, replyMatchesExpectation } from '../capture/campaign.mjs';
import { getAdapter } from '../profiles/sites/index.mjs';
import { json, problem, object } from './http.mjs';

const now = () => new Date().toISOString();
const terminal = (j) => !['queued', 'running'].includes(j.state);
function read(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }

export function driveVerdict(result = {}, prompt = result.prompt) {
  if (result.blocked || result.status === 'blocked') return 'blocked';
  if (result.status === 'unverified') return 'unverified';
  if (result.status === 'verified' || result.verified === true) return 'verified';
  if (result.status === 'planned' || result.status === 'not-run') return 'not-run';
  if (result.ok || result.status === 'ok') {
    const expected = expectedAnswer(prompt);
    return expected && replyMatchesExpectation(result.reply, expected).ok ? 'verified' : 'unverified';
  }
  return 'failed';
}

export function createDriveApi({ dataDir, port = 9222, drive = driveSite, campaign = runCampaign } = {}) {
  const file = path.join(dataDir, 'drive-jobs.json');
  let jobs = read(file, []);
  if (!Array.isArray(jobs)) jobs = [];
  jobs = jobs.slice(0, 50);
  for (const job of jobs) if (!terminal(job)) {
    job.state = 'cancelled'; job.finishedAt = now(); job.error = 'Studio restarted; interrupted jobs are never retried';
    for (const p of job.progress ?? []) if (['pending', 'running'].includes(p.state)) p.state = 'skipped';
  }
  let active = null, closed = false;
  const save = () => {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(jobs.slice(0, 50), null, 2)}\n`);
    renameSync(tmp, file);
  };
  const snapshot = (j) => structuredClone(j);
  const find = (id) => { const j = jobs.find((j) => j.id === id); if (!j) throw problem(404, 'Drive job not found'); return j; };
  const safeReason = (value, prompt, reply) => {
    let s = String(value ?? '').replaceAll(prompt, '[prompt omitted]');
    if (typeof reply === 'string' && reply) s = s.replaceAll(reply, '[reply omitted]');
    s = s.replace(/https?:\/\/\S+/gi, '[URL omitted]').replace(/\b(?:bearer\s+\S+|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi, '[credential omitted]');
    return s.slice(0, 500);
  };
  async function sites() {
    const state = read(path.join(dataDir, 'campaign-state.json'), {}).sites ?? {};
    return { defaultPrompt, verdictMeaning: 'Verified means calibration reply matched; capture acceptance is not checked', cancellationMode: 'after-current-site', sites: await Promise.all(siteOrder.map(async (id) => {
      const adapter = await getAdapter(id), last = state[id];
      // Display-only compatibility with old persisted campaign status. Never use a
      // reason string as evidence to upgrade a newly returned live failure.
      const legacyMatch = last?.status === 'failed' && /\ball \d+ expected words in order\b/i.test(last.reason ?? '');
      return { id, adapter: adapter?.id ?? null, url: adapter?.url ?? null,
        last: last ? { status: legacyMatch ? 'verified' : driveVerdict(last), reason: legacyMatch ? 'Reply matched, capture not checked' : safeReason(last.reason, last.prompt || defaultPrompt, last.reply), at: last.at ?? null, sessionId: last.sessionId ?? null } : null };
    })) };
  }
  async function validate(body) {
    object(body);
    if (!['drive', 'campaign'].includes(body.mode)) throw problem(400, 'mode must be drive or campaign');
    if (!Array.isArray(body.sites) || !body.sites.length || body.sites.length > siteOrder.length || body.sites.some((s) => typeof s !== 'string')) throw problem(400, 'sites must be a nonempty array');
    if (body.mode === 'drive' && body.sites.length !== 1) throw problem(400, 'drive requires exactly one site');
    for (const key of ['dryRun', 'confirm']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw problem(400, `${key} must be boolean`);
    const dryRun = body.dryRun ?? true;
    if (!dryRun && body.confirm !== true) throw problem(400, 'confirm=true is required for a live send');
    if (body.prompt !== undefined && (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 250000)) throw problem(400, 'prompt must contain 1–250000 characters');
    for (const key of ['timeout', 'cooldown']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < (key === 'timeout' ? 1 : 0) || body[key] > 86400)) throw problem(400, `${key} must be an integer in seconds (maximum 86400)`);
    const targets = [];
    for (const site of [...new Set(body.sites)]) {
      if (siteOrder.includes(site)) { targets.push({ site, adapter: await getAdapter(site) }); continue; }
      let url;
      try { url = new URL(site); } catch { throw problem(400, 'Unknown site'); }
      if (body.mode !== 'drive' ||
          !(['https:', 'http:'].includes(url.protocol)) ||
          (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
          url.username || url.password)
        throw problem(400, 'Use a known site, HTTPS URL, or local HTTP testing URL');
      const adapter = await getAdapter(url.href);
      targets.push({ site: url.href, adapter: { ...(adapter ?? { id: 'generic', hosts: [url.hostname] }), url: url.href } });
    }
    return { targets, dryRun, prompt: body.prompt ?? defaultPrompt, timeoutMs: body.timeout === undefined ? undefined : body.timeout * 1000, cooldownMs: body.cooldown === undefined ? undefined : body.cooldown * 1000 };
  }
  async function run(job, options, controller) {
    try {
      if (controller.signal.aborted) return;
      job.state = 'running'; job.startedAt = now(); save();
      for (let i = 0; i < options.targets.length; i++) {
        if (controller.signal.aborted) break;
        const { site, adapter } = options.targets[i], p = job.progress[i];
        p.state = 'running'; save();
        let result;
        if (job.dryRun) result = { status: 'planned', reason: 'Plan only; no browser opened' };
        else if (job.mode === 'campaign') {
          // One campaign site per call preserves its derivation/resume behavior while allowing
          // cancellation between sites; pacing is abortable here rather than inside campaign.
          const out = await campaign({ sites: [site], prompt: options.prompt, port, dataDir, execute: !job.dryRun,
            cooldownMs: 0, perSiteTimeoutMs: options.timeoutMs,
            drive: (args) => { controller.signal.throwIfAborted(); return drive(args); },
            onEvent: (ev) => { if (ev.type === 'site.start') { p.state = 'running'; } },
          });
          result = out.sites?.[0] ?? { status: 'failed', reason: 'Campaign returned no site result' };
        }
        else if (!adapter) result = { status: 'blocked', reason: 'No adapter installed' };
        // Cancellation is a between-sites request, not interruption of an active
        // send/recorder cleanup and not a promise to stop provider generation.
        else result = await drive({ adapter, prompt: options.prompt, port, dataDir, record: true, timeoutMs: options.timeoutMs });
        const verdict = driveVerdict(result, options.prompt);
        p.state = result.status === 'skipped' ? 'skipped' : ['failed', 'blocked'].includes(verdict) ? 'failed' : 'done';
        p.verdict = ['not-run'].includes(verdict) || result.status === 'skipped' ? null : verdict;
        p.reason = safeReason(result.reason ?? (job.dryRun ? 'Plan only' : verdict), options.prompt, result.reply);
        p.sessionId = result.sessionId ?? null; p.replyChars = String(result.reply ?? '').length;
        save();
        if (controller.signal.aborted) break;
        if (!job.dryRun && job.mode === 'campaign' && i + 1 < options.targets.length) {
          const ms = options.cooldownMs === undefined ? 45000 + Math.random() * 45000 : options.cooldownMs * (0.6 + Math.random() * 0.4);
          await delay(ms, undefined, { signal: controller.signal });
        }
      }
      job.state = controller.signal.aborted ? 'cancelled' : job.progress.some((p) => p.state === 'failed') ? 'failed' : 'done';
    } catch (e) {
      job.state = controller.signal.aborted ? 'cancelled' : 'failed';
      // A lease conflict means another client already owns the browser. Say who, because the fix is
      // to finish that work, not to retry this job.
      job.error = controller.signal.aborted ? null
        : e?.code === 'DRIVE_LEASE_BUSY'
          ? 'The capture browser is in use by ' + (e.holder?.kind === 'conversation' ? 'a Chat conversation' : 'another job')
            + '. Finish it there, then start this run again. Nothing was sent.'
          : 'Drive job failed; no automatic retry was attempted';
    } finally {
      if (controller.signal.aborted) job.state = 'cancelled';
      for (const p of job.progress) if (['pending', 'running'].includes(p.state)) { p.state = 'skipped'; p.reason = 'Job stopped before completion'; }
      job.finishedAt = now();
      try { save(); } finally { if (active?.job === job) active = null; }
    }
  }
  return {
    async handle(req, res, url, body = {}) {
      if (!url.pathname.startsWith('/api/v1/drive/')) return false;
      const parts = url.pathname.slice('/api/v1/drive/'.length).split('/');
      const [resource, id, action] = parts;
      const allowed = resource === 'sites' && parts.length === 1 ? ['GET']
        : resource === 'jobs' && parts.length === 1 ? ['GET', 'POST']
        : resource === 'jobs' && parts.length === 2 ? ['GET']
        : resource === 'jobs' && parts.length === 3 && action === 'cancel' ? ['POST'] : null;
      if (!allowed) { json(res, 404, { error: 'Unknown drive endpoint' }); return true; }
      if (!allowed.includes(req.method)) { res.setHeader('allow', allowed.join(', ')); json(res, 405, { error: 'Method not allowed' }); return true; }
      if (resource === 'sites') json(res, 200, await sites());
      else if (id) {
        const job = find(id);
        if (action === 'cancel' && !terminal(job)) {
          active?.controller.abort();
          // Keep the running state/lock until the driver has actually cleaned up.
          if (job.state === 'queued') { job.state = 'cancelled'; job.finishedAt = now(); }
          save();
        }
        json(res, 200, { job: snapshot(job) });
      } else if (req.method === 'GET') json(res, 200, { jobs: jobs.slice(0, 20).map(snapshot) });
      else {
        if (closed) throw problem(503, 'Studio is closing');
        const options = await validate(body);
        if (active) { json(res, 409, { error: 'A drive job is already active', activeJobId: active.job.id }); return true; }
        const job = { id: randomUUID(), mode: body.mode, sites: options.targets.map((t) => t.site), dryRun: options.dryRun,
          state: 'queued', cancellationMode: 'after-current-site', createdAt: now(), startedAt: null, finishedAt: null,
          progress: options.targets.map((t) => ({ site: t.site, state: 'pending', verdict: null, reason: null, sessionId: null, replyChars: 0 })), error: null };
        const controller = new AbortController();
        jobs.unshift(job); jobs = jobs.slice(0, 50);
        try { save(); } catch (e) { jobs.shift(); throw e; }
        active = { job, controller, promise: null };
        json(res, 202, { job: snapshot(job) });
        active.promise = new Promise((resolve) => setImmediate(resolve)).then(() => run(job, options, controller));
        active.promise.catch(() => {}); // persistence failure must not become an unhandled rejection
      }
      return true;
    },
    async close() { closed = true; const running = active; running?.controller.abort(); await running?.promise; },
  };
}
