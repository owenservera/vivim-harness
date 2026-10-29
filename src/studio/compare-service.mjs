// Compare through the ONE conversation runtime. Never construct a browser or repeat an uncertain send.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { executeConversationTool } from './conversation-tools.mjs';
import { problem } from './http.mjs';

const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude' };
const ID = /^cmp-[a-f0-9]{24}$/;
const ACTIVE = new Set(['queued', 'running']);
const BUSY = new Set(['DRIVE_LEASE_BUSY', 'THREAD_JOURNAL_BUSY', 'PREFIX_WRITER_BUSY', 'WRITER_WINDOW_BUSY']);
const codeOf = e => e?.code ?? 'COMPARE_FAILED';
const authBlocked = value => value?.signedIn === false || value?.authWall === true || value?.authWall?.present === true
  || /AUTH_WALL|SIGN_IN_REQUIRED|SIGNED_OUT|LOGIN_REQUIRED/.test(String(value?.reason ?? value?.readiness?.reason ?? value?.code ?? ''));
const turnFor = (stored, key) => (stored?.turns ?? (stored?.turn ? [stored.turn] : [])).find(turn => turn.key === key);

export function createCompareJobs({ paths, conversations, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timing = {} } = {}) {
  if (!paths?.root || !path.isAbsolute(paths.root) || !conversations) throw new TypeError('Paths and shared conversation runtime required');
  const t = { pollMs: 2500, busyMs: 180000, replyMs: 600000, operationMs: 300000, reconcileMs: 10000, ...timing };
  const directory = path.join(paths.root, 'compare-jobs');
  mkdirSync(directory, { recursive: true });
  const jobs = new Map(), running = new Map();
  let queue = Promise.resolve(); // All jobs AND providers share one sequential browser lane.
  const tool = (name, args = {}) => executeConversationTool(conversations, name, args);
  const save = job => {
    job.updatedAt = new Date().toISOString();
    const file = path.join(directory, job.id + '.json'), tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(job, null, 1)); renameSync(tmp, file);
  };
  const view = job => ({ id: job.id, question: job.question, sites: job.sites, state: job.state,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    results: job.results.map(({ key, attempted, ...result }) => result) });
  const checkCancel = job => { if (job.state === 'cancelled') throw Object.assign(new Error('Cancelled'), { cancelled: true }); };
  const message = (code, site) => {
    const label = LABELS[site];
    if (BUSY.has(code)) return 'Your AI browser is still busy. Try again after your other conversation finishes.';
    if (code === 'REPLY_TIMEOUT') return label + ' is taking longer than expected. Nothing was sent twice. Check its tab before starting another question.';
    if (code === 'INTERRUPTED') return 'VIVIM restarted before sending this question. Start a new comparison when you are ready.';
    if (code === 'BROWSER_UNAVAILABLE') return 'Open your VIVIM AI browser, then try again.';
    if (/DRAFT|TYPING/.test(code)) return 'Check the ' + label + ' tab for unsent text. Clear it before trying again.';
    return 'Could not finish with ' + label + '. Nothing was repeated. Check its tab, or choose the other provider.';
  };
  async function busy(job, result, fn) {
    const deadline = Date.now() + t.busyMs; let delay = Math.min(2000, t.pollMs);
    for (;;) {
      checkCancel(job);
      try { return await fn(); }
      catch (e) {
        if (!BUSY.has(codeOf(e)) || Date.now() >= deadline) throw e;
        result.message = 'Waiting for your AI browser…'; save(job);
        await sleep(delay); delay = Math.min(Math.ceil(delay * 1.6), 15000);
      }
    }
  }
  // Bound waits without cancelling the underlying operation: a late submit is STILL an effect.
  async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Waiting'), { code: 'CONNECT_TIMEOUT' })), t.operationMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function availability(site) {
    const discovery = await tool('conversation_targets');
    const entries = [...(discovery.sites ?? []), ...(discovery.targets ?? [])].filter(item => (item.site?.id ?? item.site ?? item.id) === site);
    // Metadata is not proof of sign-in. Only explicit auth-wall evidence blocks here;
    // the fresh conversation's guarded readiness remains authoritative before typing.
    return entries.length && entries.every(authBlocked);
  }
  function skip(job, result) {
    result.state = 'skipped';
    result.message = LABELS[result.site] + " isn't signed in on your PC. Sign in in your VIVIM browser, or choose " + LABELS[result.site === 'claude' ? 'chatgpt' : 'claude'] + '.';
    save(job);
  }
  async function provider(job, result, resumed) {
    let pending = null, pendingSettled = false;
    try {
      checkCancel(job);
      result.state = 'waiting'; result.message = 'Waiting for ' + LABELS[result.site] + '…'; save(job);
      if (!result.attempted && await availability(result.site)) { skip(job, result); return; }
      if (!result.conversationId) {
        if (resumed) throw Object.assign(new Error('Interrupted'), { code: 'INTERRUPTED' });
        const created = await busy(job, result, () => bounded(tool('create_conversation', { site: result.site })));
        result.conversationId = created.id; save(job);
        checkCancel(job);
        if (authBlocked(created)) { skip(job, result); return; }
      }
      const read = () => tool('get_conversation', { conversation: result.conversationId });
      let stored = await read();
      if (!result.attempted && authBlocked(stored)) { skip(job, result); return; }
      if (!turnFor(stored, result.key) && !result.attempted) {
        if (resumed) throw Object.assign(new Error('Interrupted'), { code: 'INTERRUPTED' });
        // Persist BEFORE calling submit. Restart and ANY ambiguous failure can only poll this key.
        result.attempted = true; save(job);
        pending = busy(job, result, async () => {
          stored = await read();
          if (turnFor(stored, result.key)) return;
          return tool('submit_conversation_turn', { conversation: result.conversationId, key: result.key,
            prompt: job.question, confirm: true, expectedRevision: stored.revision });
        }).then(() => { pendingSettled = true; return { done: true }; }, error => { pendingSettled = true; return { error }; });
        // Poll concurrently; never let a slow submit block stored-state observation.
      }
      const deadline = Date.now() + t.replyMs;
      let lastReconcile = Date.now(), submitOutcome = null;
      pending?.then(value => { submitOutcome = value; });
      while (Date.now() < deadline) {
        checkCancel(job);
        try { stored = await bounded(read()); }
        catch { await sleep(t.pollMs); continue; }
        checkCancel(job);
        const turn = turnFor(stored, result.key);
        if (turn) {
          result.turnId = turn.id;
          result.answer = typeof turn.reply?.text === 'string' ? turn.reply.text : '';
          save(job);
          if (turn.reply?.state === 'ready') { result.state = 'ready'; result.message = 'Answer ready'; save(job); return; }
          if (turn.phase === 'blocked' || turn.reply?.state === 'interrupted') throw Object.assign(new Error('Stopped'), { code: turn.reason ?? 'REPLY_INTERRUPTED' });
          if (Date.now() - lastReconcile >= t.reconcileMs && (['unknown', 'waiting'].includes(turn.reply?.state)
            || turn.send?.state === 'uncertain' || stored.state === 'needs-reconciliation')) {
            lastReconcile = Date.now();
            await bounded(tool('reconcile_conversation', { conversation: result.conversationId,
              expectedRevision: stored.revision, turnId: turn.id })).catch(() => {});
          }
        } else if (submitOutcome?.error && (BUSY.has(codeOf(submitOutcome.error)) || authBlocked(submitOutcome.error)
          || (submitOutcome.error.status >= 400 && submitOutcome.error.status < 500 && submitOutcome.error.status !== 408))) throw submitOutcome.error;
        // 504 / CONNECT_TIMEOUT / effect-unknown, including no turn yet: POLL, never submit again.
        await sleep(t.pollMs);
      }
      throw Object.assign(new Error('Still waiting'), { code: 'REPLY_TIMEOUT' });
    } catch (error) {
      if (error.cancelled) return;
      if (authBlocked(error)) { skip(job, result); return; }
      result.state = 'failed'; result.message = message(codeOf(error), result.site); save(job);
    } finally {
      // Awaiting a still-running effect is necessary before driving the next provider. A timed-out
      // job stops the whole queue rather than racing that operation in the same browser.
      if (pending && !pendingSettled) {
        // Keep the public job responsive even if the original runtime call never settles.
        // The private queue remains fenced until that effect ends; never race another provider.
        if (job.state !== 'cancelled') {
          job.state = job.results.some(r => r.state === 'ready') ? 'partial' : 'failed';
          for (const next of job.results) if (next.state === 'queued') {
            next.state = 'skipped'; next.message = 'Waiting for the earlier provider to release your browser. Nothing was sent here. Check its tab before starting another comparison.';
          }
          save(job);
        }
        await pending;
      }
      if (result.conversationId) await bounded(tool('finish_conversation', { conversation: result.conversationId, closeTab: false })).catch(() => {});
    }
  }
  async function execute(job, resumed) {
    if (job.state === 'cancelled') return;
    job.state = 'running'; save(job);
    for (const result of job.results) {
      if (!ACTIVE.has(job.state)) break;
      if (['ready', 'skipped', 'failed'].includes(result.state)) continue;
      await provider(job, result, resumed);
    }
    if (job.state !== 'cancelled') {
      job.state = job.results.every(r => r.state === 'ready') ? 'complete' : job.results.some(r => r.state === 'ready') ? 'partial' : 'failed';
      save(job);
    }
  }
  function launch(job, resumed = false) {
    const work = queue.then(() => execute(job, resumed));
    queue = work.catch(() => {});
    running.set(job.id, work);
    work.finally(() => running.delete(job.id)).catch(() => {});
  }
  for (const file of readdirSync(directory)) {
    if (!ID.test(file.replace(/\.json$/, ''))) continue;
    try {
      const job = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
      if (job.schema !== 'vivim.compare/1' || file !== job.id + '.json') continue;
      jobs.set(job.id, job);
      if (ACTIVE.has(job.state)) {
        let alive = true;
        try { process.kill(job.ownerPid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (!alive) { job.ownerPid = process.pid; save(job); launch(job, true); }
      }
    } catch { /* retain unreadable files for support, never replay them */ }
  }
  function need(id) {
    if (!ID.test(id ?? '')) throw problem(400, 'Invalid comparison', 'COMPARE_INVALID');
    const job = jobs.get(id);
    if (!job) throw problem(404, 'Comparison not found', 'COMPARE_NOT_FOUND');
    return job;
  }
  return {
    start({ question, sites = ['chatgpt', 'claude'] } = {}) {
      if (typeof question !== 'string' || !question.trim() || question.length > 10000) throw problem(400, 'Write a question under 10,000 characters', 'COMPARE_INVALID');
      if (!Array.isArray(sites) || !sites.length || sites.length > 2 || sites.some(site => !Object.hasOwn(LABELS, site)) || new Set(sites).size !== sites.length) throw problem(400, 'Choose ChatGPT, Claude, or both', 'COMPARE_INVALID');
      const existing = [...jobs.values()].find(job => ACTIVE.has(job.state) && job.question === question.trim() && JSON.stringify(job.sites) === JSON.stringify(sites));
      if (existing) return { job: view(existing) };
      const id = 'cmp-' + randomBytes(12).toString('hex');
      const job = { schema: 'vivim.compare/1', id, ownerPid: process.pid, question: question.trim(), sites: [...sites],
        state: 'queued', createdAt: new Date().toISOString(), results: sites.map(site => ({ site, label: LABELS[site],
          key: id + '-' + site, attempted: false, state: 'queued', answer: '', message: 'Waiting for ' + LABELS[site] + '…', conversationId: null, turnId: null })) };
      jobs.set(id, job); save(job); launch(job); return { job: view(job) };
    },
    get: id => ({ job: view(need(id)) }),
    cancel(id) {
      const job = need(id);
      if (ACTIVE.has(job.state)) { job.state = 'cancelled';
        for (const result of job.results) if (['queued', 'waiting'].includes(result.state)) { result.state = 'cancelled'; result.message = 'Stopped waiting. A question already sent may still finish in your browser. Nothing will be repeated.'; }
        save(job);
      }
      return { job: view(job) };
    },
    settled: id => running.get(id) ?? Promise.resolve(),
  };
}
