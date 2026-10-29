// Compare through the ONE conversation runtime. Never construct a browser or repeat an uncertain send.
//  - One stable key per provider (job id + site). It is never replaced, so a timeout or unknown effect
//    can only be observed again, never resent. `attempted` is saved BEFORE submit.
//  - After a restart a job is only ever observed (stored conversation + capped read-only reconcile).
//  - All jobs and providers share one sequential lane; the runtime's drive lease is the real fence.
//  - Never freeze: every wait sleeps on an unref'd timer, every runtime call is time-bounded, and the
//    read-only reconcile (it inspects the browser on the conversation's serial queue) is reserved for
//    genuinely uncertain or unwatched turns, never for a reply that is still streaming normally.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { executeConversationTool } from './conversation-tools.mjs';
import { problem } from './http.mjs';

const SCHEMA = 'vivim.compare/1';
// Every site here must also be accepted by conversation-api.mjs's 'create' fresh-conversation gate
// (src/studio/conversation-api.mjs) and have a working adapter in src/profiles/sites. Owner's four
// signed-in accounts (2026-10-30): ChatGPT, Claude, Z.ai, Qwen.
const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', zai: 'Z.ai', qwen: 'Qwen' };
export const COMPARE_SITES = Object.keys(LABELS);
const MAX_SITES = COMPARE_SITES.length;
const ID = /^cmp-[a-f0-9]{24}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const ACTIVE = new Set(['queued', 'running']);
const DONE = new Set(['ready', 'skipped', 'failed', 'cancelled']);
const BUSY = new Set(['DRIVE_LEASE_BUSY', 'THREAD_JOURNAL_BUSY', 'PREFIX_WRITER_BUSY', 'WRITER_WINDOW_BUSY']);
const MAX_KEPT = 40;
const LIVE_OWNERS = new Set(); // Tokens of compare managers alive in THIS process (PID-reuse guard).
const DEFAULT_TIMING = Object.freeze({
  pollMs: 2500,          // stored-conversation poll interval
  busyMs: 180000,        // how long a busy browser is waited out (same key, backoff)
  replyMs: 600000,       // total patience for a provider reply
  resumeMs: 120000,      // patience for a reply observed only after a VIVIM restart
  operationMs: 300000,   // ceiling for one awaited runtime call (the call itself keeps running)
  probeMs: 15000,        // ceiling for the browser target listing
  reconcileMs: 10000, maxReconciles: 8,
  fenceMs: 600000,       // how long the shared lane stays fenced behind a submit that never settles
  heartbeatMs: 60000, staleMs: 900000, // a running job last saved this long ago by a live pid is stale
});

const coded = code => Object.assign(new Error(code), { code });
const codeOf = e => typeof e?.code === 'string' && CODE.test(e.code) ? e.code : 'COMPARE_FAILED';
const authBlocked = value => value?.signedIn === false || value?.authWall === true || value?.authWall?.present === true
  || /AUTH_WALL|SIGN_IN_REQUIRED|SIGNED_OUT|LOGIN_REQUIRED/.test(String(value?.reason ?? value?.readiness?.reason ?? value?.code ?? ''));
const turnFor = (stored, key) => (Array.isArray(stored?.turns) ? stored.turns : stored?.turn ? [stored.turn] : []).find(turn => turn?.key === key);
const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};
const validJob = (job, id) => job?.schema === SCHEMA && job.id === id && typeof job.question === 'string' && typeof job.state === 'string'
  && Array.isArray(job.results) && job.results.length >= 1 && job.results.length <= MAX_SITES
  && job.results.every(r => Object.hasOwn(LABELS, r?.site) && r.key === id + '-' + r.site && typeof r.state === 'string');

function message(code, site) {
  const label = LABELS[site];
  if (BUSY.has(code)) return 'Your AI browser stayed busy with another conversation. Nothing was sent to ' + label + '. Try again when it finishes.';
  switch (code) {
    case 'REPLY_TIMEOUT': return label + ' is taking longer than expected. Nothing was sent twice. Check its tab before starting another question.';
    case 'RESUMED_UNFINISHED': return 'VIVIM restarted while ' + label + ' was answering. Nothing was sent twice. Check its tab for the full answer.';
    case 'INTERRUPTED': return 'VIVIM restarted before sending this question to ' + label + '. Start a new comparison when you are ready.';
    case 'BROWSER_UNAVAILABLE': return 'Open your VIVIM AI browser, then try again.';
    case 'CONNECT_TIMEOUT': return 'Could not open ' + label + ' in time. Nothing was sent. Check that your VIVIM AI browser is open, then try again.';
    case 'REPLY_INTERRUPTED': return label + ' stopped before finishing its answer. Nothing was repeated. Check its tab.';
    case 'TURN_NOT_FOUND': case 'DELIVERY_UNCONFIRMED': case 'CREATION_UNPINNED':
      return 'Could not confirm that ' + label + ' received your question, so nothing was repeated. Check its tab before asking again.';
    default:
      if (/DRAFT|TYPING/.test(code)) return 'Check the ' + label + ' tab for unsent text. Clear it before trying again.';
      return 'Could not finish with ' + label + '. Nothing was repeated. Check its tab, or choose the other provider.';
  }
}

export function createCompareJobs({ paths, conversations, sleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }), timing = {} } = {}) {
  if (!paths?.root || !path.isAbsolute(paths.root) || !conversations) throw new TypeError('Paths and shared conversation runtime required');
  const t = { ...DEFAULT_TIMING, ...timing };
  const directory = path.join(paths.root, 'compare-jobs');
  mkdirSync(directory, { recursive: true });
  const token = randomBytes(8).toString('hex');
  LIVE_OWNERS.add(token);
  const jobs = new Map(), running = new Map(), lastSaved = new Map();
  let queue = Promise.resolve(); // All jobs AND providers share one sequential browser lane.
  const tool = (name, args = {}) => executeConversationTool(conversations, name, args);
  const fileOf = id => path.join(directory, id + '.json');
  const ours = job => job.ownerPid === process.pid && job.ownerToken === token;

  // Strict save: used where a failed write must stop the next step (start, before submit).
  function save(job) {
    job.updatedAt = new Date().toISOString();
    const file = fileOf(job.id), tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(job, null, 1)); renameSync(tmp, file);
    lastSaved.set(job.id, Date.now());
  }
  // Runner save: a transient write failure (antivirus lock, full disk) must never strand a job in
  // memory as "running"; the next save retries with the full in-memory state.
  function persist(job) { try { save(job); } catch (e) { console.warn('compare: could not save job', job.id, e?.code ?? e?.message); } }
  const heartbeat = job => { if (Date.now() - (lastSaved.get(job.id) ?? 0) >= t.heartbeatMs) persist(job); };
  const loadFromDisk = id => { try { const job = JSON.parse(readFileSync(fileOf(id), 'utf8')); return validJob(job, id) ? job : null; } catch { return null; } };

  const view = job => ({ id: job.id, question: job.question, sites: job.sites, state: job.state,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    results: job.results.map(({ key, attempted, reason, ...result }) => result) });
  const checkCancel = job => { if (job.state === 'cancelled') throw Object.assign(new Error('Cancelled'), { cancelled: true }); };

  // Bound waits without cancelling the underlying operation: a late submit is STILL an effect.
  async function bounded(promise, ms = t.operationMs) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(coded('CONNECT_TIMEOUT')), ms); timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  }
  async function busy(job, result, fn) {
    const deadline = Date.now() + t.busyMs, before = result.message; let delay = Math.min(2000, t.pollMs), waited = false;
    for (;;) {
      checkCancel(job);
      try {
        const out = await fn();
        if (waited) { result.message = before; persist(job); }
        return out;
      } catch (e) {
        if (!BUSY.has(codeOf(e)) || Date.now() >= deadline) throw e;
        waited = true; result.message = 'Waiting for your AI browser…'; persist(job);
        await sleep(delay); delay = Math.min(Math.ceil(delay * 1.6), 15000);
      }
    }
  }
  // Metadata is not proof of sign-in. Only explicit auth-wall evidence skips here; the fresh
  // conversation's guarded readiness stays authoritative before typing.
  async function signedOut(site) {
    let discovery;
    try { discovery = await bounded(tool('conversation_targets'), t.probeMs); }
    catch (e) { if (codeOf(e) === 'BROWSER_UNAVAILABLE') throw e; return false; }
    const entries = [...(discovery?.sites ?? []), ...(discovery?.targets ?? [])].filter(item => (item?.site?.id ?? item?.site ?? item?.id) === site);
    return entries.length > 0 && entries.every(authBlocked);
  }
  function skip(job, result) {
    const others = job.sites.filter(site => site !== result.site).map(site => LABELS[site]);
    result.state = 'skipped';
    result.message = LABELS[result.site] + " isn't signed in on your PC. Sign in to " + LABELS[result.site] + ' in your VIVIM browser'
      + (others.length ? ', or choose ' + others.join(' or ') + '.' : '.');
    persist(job);
  }
  // A fresh tab sends nothing. A create that outlives its bound is finished when it lands, so no
  // orphaned Studio-owned tab keeps a capture or lease.
  async function create(job, result) {
    return busy(job, result, () => {
      const call = tool('create_conversation', { site: result.site });
      return bounded(call).catch(error => {
        if (codeOf(error) === 'CONNECT_TIMEOUT') call.then(late => late?.id && tool('finish_conversation', { conversation: late.id, closeTab: true }), () => {}).catch(() => {});
        throw error;
      });
    });
  }

  async function provider(job, result, resumed) {
    const label = LABELS[result.site];
    let pending = null, outcome = null;
    try {
      checkCancel(job);
      result.state = 'waiting'; result.message = 'Waiting for ' + label + '…';
      if (!result.startedAt) result.startedAt = new Date().toISOString(); // asked-at, set once, never moved by a retry/resume.
      persist(job);
      if (!result.attempted && await signedOut(result.site)) { skip(job, result); return; }
      if (!result.conversationId) {
        if (resumed) throw coded('INTERRUPTED');
        const created = await create(job, result);
        result.conversationId = created.id; persist(job);
        checkCancel(job);
        if (authBlocked(created)) { skip(job, result); return; }
      }
      const read = () => bounded(tool('get_conversation', { conversation: result.conversationId }));
      let stored = await read();
      if (!result.attempted && authBlocked(stored)) { skip(job, result); return; }
      if (!turnFor(stored, result.key)) {
        // The runtime records a keyed turn before typing. No turn after a restart (or after an earlier
        // attempt) therefore means nothing was typed; it is reported, never resent.
        if (resumed || result.attempted) throw coded('INTERRUPTED');
        result.attempted = true; save(job); // Strict: a failed write means we do NOT send.
        pending = busy(job, result, async () => {
          const latest = await read();
          if (turnFor(latest, result.key)) return;
          return tool('submit_conversation_turn', { conversation: result.conversationId, key: result.key,
            prompt: job.question, confirm: true, expectedRevision: latest.revision });
        }).then(() => ({ done: true }), error => ({ error }));
        pending.then(value => { outcome = value; });
        // Poll concurrently; never let a slow submit block stored-state observation.
      }
      const deadline = Date.now() + (resumed ? t.resumeMs : t.replyMs);
      let lastReconcile = Date.now(), reconciles = 0, misses = 0;
      for (;;) {
        checkCancel(job);
        if (Date.now() >= deadline) throw coded(resumed ? 'RESUMED_UNFINISHED' : 'REPLY_TIMEOUT');
        const settledBefore = outcome; // Only an outcome known BEFORE this read may end the wait.
        try { stored = await read(); misses = 0; }
        catch (error) { if (++misses > 10) throw error; await sleep(t.pollMs); continue; }
        checkCancel(job);
        const turn = turnFor(stored, result.key);
        if (!turn) {
          // The submit settled and no keyed turn exists: the runtime refused before typing. Never resend.
          if (settledBefore) throw settledBefore.error ?? coded('TURN_NOT_FOUND');
          if (!pending) throw coded('TURN_NOT_FOUND');
          await sleep(t.pollMs); continue;
        }
        const answer = typeof turn.reply?.text === 'string' ? turn.reply.text : '';
        if (turn.id !== result.turnId || answer !== result.answer) {
          result.turnId = turn.id; result.answer = answer;
          if (answer) result.message = label + ' is answering…';
          persist(job);
        } else heartbeat(job);
        if (turn.reply?.state === 'ready') { result.state = 'ready'; result.message = 'Answer ready'; result.answeredAt = new Date().toISOString(); persist(job); return; }
        if (turn.phase === 'blocked' || turn.reply?.state === 'interrupted') throw coded(CODE.test(turn.reason ?? '') ? turn.reason : 'REPLY_INTERRUPTED');
        const uncertain = turn.send?.state === 'uncertain' || ['uncertain', 'needs-reconciliation'].includes(turn.phase) || stored.state === 'needs-reconciliation';
        const unwatched = turn.reply?.state === 'unknown' && turn.send?.state === 'observed';
        if ((uncertain || unwatched || resumed) && (!pending || outcome) && reconciles < t.maxReconciles && Date.now() - lastReconcile >= t.reconcileMs) {
          reconciles++; lastReconcile = Date.now();
          await bounded(tool('reconcile_conversation', { conversation: result.conversationId,
            expectedRevision: stored.revision, turnId: turn.id })).catch(() => {}); // Never a resend.
        } else if (uncertain && reconciles >= t.maxReconciles && Date.now() - lastReconcile >= t.reconcileMs) {
          throw coded(CODE.test(turn.reason ?? '') ? turn.reason : 'DELIVERY_UNCONFIRMED');
        }
        // 504 / CONNECT_TIMEOUT / effect-unknown: POLL, never submit again.
        await sleep(t.pollMs);
      }
    } catch (error) {
      if (error?.cancelled || job.state === 'cancelled') return;
      if (authBlocked(error)) { skip(job, result); return; }
      result.state = 'failed'; result.reason = codeOf(error); result.message = message(result.reason, result.site); persist(job);
    } finally {
      if (pending && !outcome) {
        // Keep the public job responsive while the runtime call is still running. The shared lane stays
        // fenced behind that effect (bounded by fenceMs; the runtime's drive lease still guards the browser).
        if (job.state !== 'cancelled') {
          job.state = job.results.some(r => r.state === 'ready') ? 'partial' : 'failed';
          for (const next of job.results) if (next.state === 'queued') {
            next.state = 'skipped'; next.message = 'Waiting for the earlier provider to release your browser. Nothing was sent here. Check its tab before starting another comparison.';
          }
          persist(job);
        }
        await Promise.race([pending, sleep(t.fenceMs)]);
      }
      // Close an untouched Studio tab; keep one that holds a sent question or a sign-in page.
      if (result.conversationId) await bounded(tool('finish_conversation', { conversation: result.conversationId,
        closeTab: !result.attempted && result.state !== 'skipped' })).catch(() => {});
    }
  }
  async function execute(job, resumed) {
    try {
      if (job.state === 'cancelled') return;
      job.state = 'running'; persist(job);
      for (const result of job.results) {
        if (!ACTIVE.has(job.state)) break;
        if (DONE.has(result.state)) continue;
        await provider(job, result, resumed);
      }
    } finally {
      if (job.state !== 'cancelled') {
        for (const result of job.results) if (!DONE.has(result.state)) { result.state = 'failed'; result.message = message('COMPARE_FAILED', result.site); }
        job.state = job.results.every(r => r.state === 'ready') ? 'complete' : job.results.some(r => r.state === 'ready') ? 'partial' : 'failed';
        persist(job);
      }
      prune();
    }
  }
  function launch(job, resumed = false) {
    if (running.has(job.id)) return;
    const work = queue.then(() => execute(job, resumed));
    queue = work.catch(() => {});
    running.set(job.id, work);
    work.finally(() => running.delete(job.id)).catch(() => {});
  }
  function prune() {
    const done = [...jobs.values()].filter(job => !ACTIVE.has(job.state) && !running.has(job.id))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const job of done.slice(MAX_KEPT)) {
      jobs.delete(job.id); lastSaved.delete(job.id);
      try { rmSync(fileOf(job.id), { force: true }); } catch { /* best effort */ }
    }
  }
  // A running job is resumed (observe-only) when its owner is gone: a dead pid, a reused pid of this
  // process that no live manager claims, or a live pid that has not saved for staleMs.
  const abandoned = job => {
    if (job.ownerPid === process.pid) return !LIVE_OWNERS.has(job.ownerToken);
    if (!pidAlive(job.ownerPid)) return true;
    return Date.now() - (Date.parse(job.updatedAt) || 0) > t.staleMs;
  };

  for (const file of readdirSync(directory)) {
    const tmp = /^cmp-[a-f0-9]{24}\.json\.(\d+)\.tmp$/.exec(file);
    if (tmp) { if (!pidAlive(Number(tmp[1]))) try { rmSync(path.join(directory, file), { force: true }); } catch { /* best effort */ } continue; }
    const id = file.replace(/\.json$/, '');
    if (!ID.test(id) || file !== id + '.json') continue;
    const job = loadFromDisk(id); // Unreadable files stay on disk for support and are never replayed.
    if (!job) continue;
    jobs.set(job.id, job);
    if (ACTIVE.has(job.state) && abandoned(job)) {
      job.ownerPid = process.pid; job.ownerToken = token; persist(job); launch(job, true);
    }
  }
  prune();

  function need(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw problem(400, 'Invalid comparison', 'COMPARE_INVALID');
    let job = jobs.get(id);
    // A job owned by another VIVIM process is only ever read from its saved file.
    if (!job || !ours(job)) { const disk = loadFromDisk(id); if (disk) { jobs.set(id, disk); job = disk; } }
    if (!job) throw problem(404, 'Comparison not found', 'COMPARE_NOT_FOUND');
    return job;
  }
  return {
    start({ question, sites = ['chatgpt', 'claude'] } = {}) {
      const text = typeof question === 'string' ? question.trim() : '';
      if (!text || text.length > 10000) throw problem(400, 'Write a question under 10,000 characters', 'COMPARE_INVALID');
      if (!Array.isArray(sites) || !sites.length || sites.length > MAX_SITES || sites.some(site => !Object.hasOwn(LABELS, site)) || new Set(sites).size !== sites.length) throw problem(400, 'Choose one or more of: ' + COMPARE_SITES.map(site => LABELS[site]).join(', '), 'COMPARE_INVALID');
      // A double tap or a lost response never means a second provider send.
      const existing = [...jobs.values()].find(job => ACTIVE.has(job.state) && job.question === text && JSON.stringify(job.sites) === JSON.stringify(sites));
      if (existing) return { job: view(existing) };
      const id = 'cmp-' + randomBytes(12).toString('hex'), behind = running.size > 0;
      const job = { schema: SCHEMA, id, ownerPid: process.pid, ownerToken: token, question: text, sites: [...sites],
        state: 'queued', createdAt: new Date().toISOString(), results: sites.map(site => ({ site, label: LABELS[site],
          key: id + '-' + site, attempted: false, state: 'queued', answer: '',
          message: behind ? 'Waiting for your earlier comparison to finish…' : 'Waiting for ' + LABELS[site] + '…', conversationId: null, turnId: null,
          startedAt: null, answeredAt: null })) };
      try { save(job); } catch { throw problem(503, 'Could not save your comparison. Check that your PC has free disk space, then try again.', 'COMPARE_SAVE_FAILED'); }
      jobs.set(id, job); launch(job); prune();
      return { job: view(job) };
    },
    get: id => ({ job: view(need(id)) }),
    cancel(id) {
      const job = need(id);
      if (ACTIVE.has(job.state)) {
        if (!ours(job)) throw problem(409, 'This comparison is running in another VIVIM window. Stop it there.', 'COMPARE_OWNED_ELSEWHERE');
        job.state = 'cancelled';
        for (const result of job.results) if (['queued', 'waiting'].includes(result.state)) { result.state = 'cancelled'; result.message = 'Stopped waiting. A question already sent may still finish in your browser. Nothing will be repeated.'; }
        persist(job);
      }
      return { job: view(job) };
    },
    settled: id => running.get(id) ?? Promise.resolve(),
  };
}
