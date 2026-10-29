// "Design with my AI": a background job that asks the user's OWN account on any signed-in AI website
// (ChatGPT, Claude, Z.ai, Qwen, DeepSeek or Gemini — through the ONE existing in-process conversation
// runtime) to propose screens for a personal app, then hands the compiled preview to the user.
// Consumer rules baked in:
//  - one stable idempotency key per job (derived from the job id); a new key is NEVER generated, so a
//    timeout / 504 / unknown effect can never become a second provider send;
//  - after any uncertain outcome the runner reads the STORED conversation (and may ask the runtime for
//    its read-only reconcile); it re-submits only with the SAME key and only when the stored state proves
//    no turn with that key exists;
//  - a busy browser (drive lease) is waited out with backoff, never surfaced as an error to the user;
//  - nothing auto-applies: approve() is the user's explicit click and goes through the existing
//    provider-reply apply path (stored digest + current version + 'user-confirmed').
// This module opens no browser/CDP driver of its own: every effect goes through the shared conversation
// tool executor (create_conversation / submit_conversation_turn / get_conversation / reconcile / finish).
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { problem } from './http.mjs';
import { executeConversationTool } from './conversation-tools.mjs';
import { createProviderReplyBuilder } from './personal-app-provider-reply.mjs';
import { PERSONAL_APP_CHANGE_SCHEMA, PERSONAL_APP_KINDS, isPersonalAppId } from './personal-app-blueprint.mjs';
import { CREATE_SITES } from './conversation-api.mjs';

export const AI_DESIGN_JOB_SCHEMA = 'vivim.personal-app-ai-job/1';
// Any AI website the owner is signed in to in the shared Chrome (same list the conversation runtime
// accepts for a fresh conversation). Reused, not duplicated, so a newly signed-in site needs no edit here.
export const AI_DESIGN_SITES = CREATE_SITES;
const SITE_LABEL = { chatgpt: 'ChatGPT', claude: 'Claude', zai: 'Z.ai', qwen: 'Qwen', deepseek: 'DeepSeek', gemini: 'Gemini' };
const SITE_LIST_TEXT = CREATE_SITES.map(site => SITE_LABEL[site] ?? site).join(', ');
const JOB_ID = /^aid-[a-f0-9]{24}$/;
const ACTIVE = new Set(['queued', 'asking', 'waiting-reply']);
const TERMINAL = new Set(['ready-to-review', 'applied', 'discarded', 'failed']);
const BUSY_CODES = new Set(['DRIVE_LEASE_BUSY', 'THREAD_JOURNAL_BUSY', 'PREFIX_WRITER_BUSY', 'WRITER_WINDOW_BUSY']);
const NO_RETRY = /^(INVALID_|CONFIRM_REQUIRED|IDEMPOTENCY_CONFLICT|CONVERSATION_(FINISHED|NOT_WRITABLE|NOT_FOUND|OWNED_BY_ANOTHER_RUNTIME)|THREAD_(FENCED|IDENTITY_UNVERIFIED)|PREFIX_|CREATION_UNCERTAIN|LEGACY_|RUNTIME_CLOSED)/;
const MAX_KEPT_JOBS = 40;
const DEFAULT_TIMING = Object.freeze({
  pollMs: 2500,              // stored-conversation poll interval
  leaseBudgetMs: 180000,     // how long a busy browser is waited out (same key, backoff)
  submitCeilingMs: 300000,   // an in-process submit this slow is observed by polling instead of awaited
  replyTimeoutMs: 600000,    // total patience for the provider reply
  reconcileEveryMs: 10000,   // read-only nudge cadence for an uncertain/unobserved turn
  maxReconciles: 8, maxCreateTries: 3, maxSubmitTries: 3,
});

const codeOf = error => {
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)) return error.code;
  if (typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message)) return error.message;
  return 'AI_DESIGN_FAILED';
};
const isBusy = error => BUSY_CODES.has(codeOf(error));

// What a person sees. The technical code always travels alongside for support.
function friendly(code, site) {
  const ai = SITE_LABEL[site] ?? 'your AI';
  if (BUSY_CODES.has(code)) return 'Your AI browser stayed busy with something else for a few minutes. Nothing was sent. Please try again in a moment.';
  switch (code) {
    case 'CONNECT_TIMEOUT': return 'Could not open ' + ai + ' in time. Check that you are signed in, then try again. Nothing was sent.';
    case 'BROWSER_UNAVAILABLE': return 'The AI browser is not running. Open Chat and connect your browser, then try again.';
    case 'REPLY_TIMEOUT': return ai + ' is taking longer than expected. Nothing was sent twice. Try again later or check the chat in your browser.';
    case 'REPLY_INTERRUPTED': return ai + ' stopped before finishing its answer. Try again.';
    case 'INTERRUPTED': return 'VIVIM restarted before this request finished. Please start it again.';
    case 'TURN_NOT_FOUND': return 'Could not confirm that ' + ai + ' received the request. Nothing was repeated. Please try again.';
    case 'PERSONAL_APP_VERSION_CONFLICT': return 'Your app changed while your AI was thinking, so these screens no longer fit. Ask again to get fresh ideas.';
    case 'PERSONAL_APP_SCREEN_EXISTS': return ai + ' suggested a screen your app already has. Ask again, or describe something different.';
    case 'PERSONAL_APP_LIMIT': return 'Your app already has the maximum number of screens.';
    case 'PROVIDER_REPLY_AMBIGUOUS': case 'PROVIDER_REPLY_EMPTY': case 'PERSONAL_APP_INVALID':
      return ai + ' answered, but not in a form VIVIM can safely use. Nothing was changed. Try again.';
    case 'CREATION_UNPINNED': case 'DELIVERY_UNCONFIRMED': case 'TYPING_UNCONFIRMED':
      return 'Could not confirm that ' + ai + ' received the request, so nothing was repeated. Check the ' + ai + ' tab, clear any unsent text, then try again.';
    case 'DRAFT_PRESENT': case 'DRAFT_OR_BINDING_NOT_READY': return 'The ' + ai + ' tab was not ready (it may have unsent text). Nothing was sent. Clear it and try again.';
    default: return 'Your AI could not finish this request. Nothing was changed. Please try again.';
  }
}

const readableLine = value => typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim() : '';

const clip = (value, max) => { const line = readableLine(value); return line.length > max ? line.slice(0, max - 1) + '…' : line; };

// ONE plain line on purpose: rich chat composers (ProseMirror/Lexical) turn newlines, "- ", "1.", "#"
// and ``` into list/heading/code-block structure, so the typed text no longer reads back exactly and the
// send is refused as TYPING_UNCONFIRMED. Humanized typing is also slow, so the prompt stays short.
export function buildAiDesignPrompt({ app, request }) {
  const screens = app.screens.map(s => clip(s.label, 40) + ' (' + s.kind + ')').join(', ');
  const wish = request ? clip(request, 500) : 'Nothing specific, suggest the most useful 1 to 3 extra screens.';
  const shape = JSON.stringify({ schema: PERSONAL_APP_CHANGE_SCHEMA, appId: app.id, baseVersion: app.version,
    operations: [{ type: 'add-screen', kind: 'notes', label: 'Study Notes' }] });
  return 'You are helping design a small personal mobile app called "' + clip(app.title, 80).replace(/"/g, "'") + '". Purpose: ' +
    clip(app.intent, 300).replace(/"/g, "'") + ' It already has these screens: ' + screens + '. The owner wants: ' + wish +
    ' Put your entire reply inside one fenced code block: a line with three backtick characters then the word json, then one JSON object, then a line with three backtick characters, nothing else before or after the fence. ' +
    'Inside that JSON use only plain straight double-quote characters for all keys and string values, never curly or typographic quotes, and use exactly the keys schema, appId, baseVersion and operations. ' +
    'Propose 1 to 4 NEW screens and never repeat an existing one. Each operation is {"type":"add-screen","kind":"<kind>","label":"<name>"} where kind is exactly one of ' +
    PERSONAL_APP_KINDS.map(k => '"' + k + '"').join(', ') + ' and label is a short plain-text name of 1 to 64 characters. ' +
    'Copy schema, appId and baseVersion exactly. Exact shape: ' + shape;
}

export function createAiDesignJobs({ apps, conversations, providerReply, paths, clock = () => new Date().toISOString(),
  sleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }), timing = {} } = {}) {
  if (!apps || typeof apps.get !== 'function') throw new TypeError('personal app service required');
  if (!conversations || typeof conversations.get !== 'function' || typeof conversations.submit !== 'function') {
    throw new TypeError('conversation runtime required');
  }
  if (!paths?.root || !path.isAbsolute(paths.root)) throw new TypeError('Absolute paths.root is required');
  const t = { ...DEFAULT_TIMING, ...timing };
  const reply = providerReply ?? createProviderReplyBuilder({ apps,
    readStoredConversation: id => executeConversationTool(conversations, 'get_conversation', { conversation: id }) });
  const directory = path.join(paths.root, 'personal-app-ai-jobs');
  mkdirSync(directory, { recursive: true });
  const jobs = new Map();       // id -> job (authoritative in-process copy)
  const running = new Map();    // id -> promise of the background runner
  const approving = new Set();
  const tool = (name, args) => executeConversationTool(conversations, name, args);

  const fileOf = id => path.join(directory, id + '.json');
  function save(job) {
    job.updatedAt = clock();
    const target = fileOf(job.id), tmp = target + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(job, null, 1));
    renameSync(tmp, target);
  }
  function loadFromDisk(id) {
    try {
      const job = JSON.parse(readFileSync(fileOf(id), 'utf8'));
      return job && job.schema === AI_DESIGN_JOB_SCHEMA && job.id === id ? job : null;
    } catch { return null; }
  }
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

  // What the client may see: never the idempotency key, the prompt or the owner pid.
  const publicJob = job => ({ id: job.id, appId: job.appId, site: job.site, siteLabel: SITE_LABEL[job.site],
    request: job.request, state: job.state, waitingOn: job.waitingOn ?? null, baseVersion: job.baseVersion,
    createdAt: job.createdAt, updatedAt: job.updatedAt, conversationId: job.conversationId ?? null,
    turnId: job.turnId ?? null, replyDigest: job.replyDigest ?? null, preview: job.preview ?? null,
    applied: job.applied ?? null, error: job.error ?? null });

  const setState = (job, state, extra = {}) => {
    // An awaited provider read/send may finish after Discard. It must not resurrect that job.
    if (job.state === 'discarded' && state !== 'discarded') return;
    Object.assign(job, { state }, extra); save(job);
  };
  const cancelled = job => job.state === 'discarded';
  const stop = () => Object.assign(new Error('AI_DESIGN_CANCELLED'), { code: 'AI_DESIGN_CANCELLED', cancelled: true });

  // Runs fn; while the browser is busy waits (same inputs, backoff) up to the lease budget.
  async function waitOutBusy(job, fn) {
    const started = Date.now(); let delay = 2000;
    for (;;) {
      if (cancelled(job)) throw stop();
      try {
        const out = await fn();
        if (job.waitingOn) { job.waitingOn = null; save(job); }
        return out;
      } catch (error) {
        if (!isBusy(error) || Date.now() - started > t.leaseBudgetMs) throw error;
        if (job.waitingOn !== 'browser') { job.waitingOn = 'browser'; save(job); }
        await sleep(delay); delay = Math.min(Math.round(delay * 1.6), 15000);
      }
    }
  }
  const readStored = job => tool('get_conversation', { conversation: job.conversationId });
  const turnByKey = (stored, key) => (Array.isArray(stored?.turns) ? stored.turns : []).find(turn => turn?.key === key) ?? null;

  // Opening a fresh tab sends nothing to the provider, so a failed attempt may be repeated.
  async function ensureConversation(job, resumed) {
    if (job.conversationId) return;
    if (resumed) throw Object.assign(new Error('INTERRUPTED'), { code: 'INTERRUPTED' });
    setState(job, 'asking');
    for (let attempt = 1; ; attempt++) {
      try {
        const created = await waitOutBusy(job, () => tool('create_conversation', { site: job.site }));
        job.conversationId = created.id; job.revision = created.revision; save(job);
        return;
      } catch (error) {
        const retryable = ['CONNECT_TIMEOUT', 'BROWSER_UNAVAILABLE'].includes(codeOf(error)) || error?.status >= 500;
        if (cancelled(job) || !retryable || attempt >= t.maxCreateTries) throw error;
        job.waitingOn = 'browser'; save(job);
        await sleep(3000 * attempt);
      }
    }
  }

  // Returns { inFlight } — inFlight means a submit may still be running, so the poller must not resend.
  async function ensureSubmitted(job, resumed) {
    setState(job, 'asking');
    const prompt = job.prompt; // Frozen at start: the same key must always carry byte-identical text.
    for (let attempt = 1; ; attempt++) {
      if (cancelled(job)) throw stop();
      const stored = await readStored(job);
      const existing = turnByKey(stored, job.key);
      if (existing) { job.turnId = existing.id; setState(job, 'waiting-reply', { waitingOn: null }); return { inFlight: false }; }
      if (resumed) throw Object.assign(new Error('INTERRUPTED'), { code: 'INTERRUPTED' });
      // Stored state proves no turn with this key exists: the SAME key is (re)submitted.
      // A first turn only resolves after the provider thread is pinned, which can take a minute or more
      // (the HTTP route reports that as a 504 although the turn goes on). So the submit is raced against
      // a watcher of the STORED conversation: once a turn with our key is visible we stop waiting on the
      // submit call and just follow the stored state. The submit keeps running; its failure surfaces there.
      let outcome;
      const submitting = waitOutBusy(job, () => tool('submit_conversation_turn', {
        conversation: job.conversationId, key: job.key, prompt, confirm: true, expectedRevision: stored.revision }))
        .then(() => ({ done: true }), error => ({ error }));
      let watching = true;
      const watcher = (async () => {
        const started = Date.now();
        while (watching && Date.now() - started < t.submitCeilingMs) {
          await sleep(t.pollMs);
          if (!watching) break;
          const seen = turnByKey(await readStored(job).catch(() => null), job.key);
          if (seen) return { seen };
        }
        return watching ? { slow: true } : { idle: true };
      })();
      try { outcome = await Promise.race([submitting, watcher]); } finally { watching = false; }
      if (outcome.seen || outcome.slow) {
        if (outcome.seen) job.turnId = outcome.seen.id;
        setState(job, 'waiting-reply', { waitingOn: null });
        let failure = null;
        submitting.then(settled => { failure = settled.error ?? null; });
        return { inFlight: true, failure: () => failure };
      }
      if (outcome.done) { setState(job, 'waiting-reply', { waitingOn: null }); return { inFlight: false }; }
      // Any error: stored truth decides. A turn that exists is polled, never resent.
      const after = turnByKey(await readStored(job).catch(() => null), job.key);
      if (after) { job.turnId = after.id; setState(job, 'waiting-reply', { waitingOn: null }); return { inFlight: false }; }
      const code = codeOf(outcome.error);
      if (cancelled(job) || NO_RETRY.test(code) || attempt >= t.maxSubmitTries) throw outcome.error;
      await sleep(4000 * attempt);
    }
  }

  async function waitForReply(job, { inFlight, failure } = {}) {
    const deadline = Date.now() + t.replyTimeoutMs;
    let reconciles = 0, lastReconcile = Date.now(), tolerated = 0;
    for (;;) {
      if (cancelled(job)) throw stop();
      if (Date.now() > deadline) throw Object.assign(new Error('REPLY_TIMEOUT'), { code: 'REPLY_TIMEOUT' });
      let stored;
      try { stored = await readStored(job); tolerated = 0; }
      catch (error) { if (++tolerated > 5) throw error; await sleep(t.pollMs); continue; }
      const turn = turnByKey(stored, job.key);
      if (!turn) {
        const failed = failure?.();
        if (failed) throw failed; // the in-flight submit ended without ever registering a turn
        if (!inFlight) throw Object.assign(new Error('TURN_NOT_FOUND'), { code: 'TURN_NOT_FOUND' });
        await sleep(t.pollMs); continue;
      }
      if (job.turnId !== turn.id) { job.turnId = turn.id; save(job); }
      const state = turn.reply?.state;
      if (state === 'ready') return turn;
      if (state === 'interrupted') throw Object.assign(new Error('REPLY_INTERRUPTED'), { code: 'REPLY_INTERRUPTED' });
      if (turn.phase === 'blocked') throw Object.assign(new Error(turn.reason ?? 'TURN_BLOCKED'), { code: /^[A-Z][A-Z0-9_]{1,79}$/.test(turn.reason ?? '') ? turn.reason : 'TURN_BLOCKED' });
      // Uncertain delivery or a reply watcher that is not running: ask the runtime for its READ-ONLY
      // reconcile (it can never insert or submit). Never a resend.
      const uncertain = turn.send?.state === 'uncertain' || ['uncertain', 'needs-reconciliation'].includes(turn.phase) || stored.state === 'needs-reconciliation';
      const unwatched = state === 'unknown' && turn.send?.state === 'observed';
      if ((uncertain || unwatched) && reconciles < t.maxReconciles && Date.now() - lastReconcile >= t.reconcileEveryMs) {
        reconciles++; lastReconcile = Date.now();
        try { await tool('reconcile_conversation', { conversation: job.conversationId, expectedRevision: stored.revision, turnId: turn.id }); }
        catch { /* observed again on the next poll; reconcile failure never triggers a send */ }
      }
      // Read-only checks are exhausted and delivery is still unproven: say so instead of waiting out the clock.
      if (uncertain && reconciles >= t.maxReconciles && Date.now() - lastReconcile >= t.reconcileEveryMs) {
        const reason = /^[A-Z][A-Z0-9_]{1,79}$/.test(turn.reason ?? '') ? turn.reason : 'DELIVERY_UNCONFIRMED';
        throw Object.assign(new Error(reason), { code: reason });
      }
      await sleep(t.pollMs);
    }
  }

  async function compile(job) {
    const preview = await reply.preview({ id: job.appId, conversation: job.conversationId, turnId: job.turnId });
    if (cancelled(job)) throw stop();
    setState(job, 'ready-to-review', { waitingOn: null, error: null, replyDigest: preview.provenance.replyDigest,
      preview: { baseVersion: preview.baseVersion, diff: preview.diff.map(({ type, key, label, kind }) => ({ type, key, label, kind })),
        qualification: preview.qualification } });
  }

  async function execute(job, resumed) {
    try {
      await ensureConversation(job, resumed);
      if (cancelled(job)) throw stop();
      const mode = await ensureSubmitted(job, resumed);
      if (cancelled(job)) throw stop();
      await waitForReply(job, mode);
      await compile(job);
      // Best effort: free the capture and the Studio-owned tab. The stored reply stays readable.
      await tool('finish_conversation', { conversation: job.conversationId, closeTab: true }).catch(() => {});
    } catch (error) {
      if (error?.cancelled || cancelled(job)) return;
      const code = codeOf(error);
      setState(job, 'failed', { waitingOn: null, error: { code, message: friendly(code, job.site) } });
    } finally { running.delete(job.id); }
  }
  function launch(job, resumed = false) {
    if (running.has(job.id)) return;
    running.set(job.id, execute(job, resumed));
  }

  function pruneOld() {
    const done = [...jobs.values()].filter(job => TERMINAL.has(job.state) && job.state !== 'ready-to-review')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const job of done.slice(MAX_KEPT_JOBS)) { jobs.delete(job.id); try { rmSync(fileOf(job.id), { force: true }); } catch { /* best effort */ } }
  }

  // Page refresh / restart: reload saved jobs. A job whose owner process died is resumed by polling the
  // STORED conversation with the same key; it is never resent.
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const job = loadFromDisk(name.slice(0, -5));
    if (!job) continue;
    jobs.set(job.id, job);
    if (ACTIVE.has(job.state) && job.ownerPid !== process.pid && !alive(job.ownerPid)) {
      job.ownerPid = process.pid; save(job);
      setImmediate(() => launch(job, true));
    }
  }

  function need(jobId) {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw problem(400, 'Invalid design job id', 'AI_DESIGN_INVALID');
    const job = jobs.get(jobId) ?? loadFromDisk(jobId);
    if (!job) throw problem(404, 'Design job not found', 'AI_DESIGN_NOT_FOUND');
    if (!jobs.has(jobId)) jobs.set(jobId, job);
    return job;
  }

  function start({ id, site, request } = {}) {
    if (!isPersonalAppId(id)) throw problem(400, 'Invalid personal app ID', 'PERSONAL_APP_INVALID');
    if (!AI_DESIGN_SITES.includes(site)) throw problem(400, 'Choose one of your signed-in AIs: ' + SITE_LIST_TEXT, 'AI_DESIGN_INVALID');
    let wish = null;
    if (request !== undefined && request !== null && request !== '') {
      if (typeof request !== 'string' || request.length > 500) throw problem(400, 'Keep your wish under 500 characters', 'AI_DESIGN_INVALID');
      wish = readableLine(request) || null;
    }
    const app = apps.get(id); // 404 when the app does not exist
    // One live job per app: a double tap never means a second provider send.
    const live = [...jobs.values()].find(job => job.appId === id && ACTIVE.has(job.state));
    if (live) return { job: publicJob(live), reused: true };
    const jobId = 'aid-' + randomBytes(12).toString('hex');
    const job = { schema: AI_DESIGN_JOB_SCHEMA, id: jobId, appId: id, site, request: wish, state: 'queued', waitingOn: null,
      baseVersion: app.version, key: 'vivim-ai-design-' + jobId, prompt: buildAiDesignPrompt({ app, request: wish }),
      ownerPid: process.pid, createdAt: clock(), updatedAt: clock(),
      conversationId: null, turnId: null, replyDigest: null, preview: null, applied: null, error: null };
    jobs.set(jobId, job); save(job); pruneOld();
    launch(job);
    return { job: publicJob(job), reused: false };
  }

  const get = jobId => ({ job: publicJob(need(jobId)) });
  const latestFor = appId => {
    if (!isPersonalAppId(appId)) throw problem(400, 'Invalid personal app ID', 'PERSONAL_APP_INVALID');
    const mine = [...jobs.values()].filter(job => job.appId === appId && job.state !== 'discarded')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { job: mine[0] ? publicJob(mine[0]) : null };
  };

  // The user's explicit click. Reuses the provider-reply apply path: stored digest, current version, approval.
  async function approve({ jobId } = {}) {
    const job = need(jobId);
    if (job.state === 'applied') return { job: publicJob(job), app: apps.get(job.appId), replayed: true };
    if (job.state !== 'ready-to-review') throw problem(409, 'This design is not ready to add yet', 'AI_DESIGN_NOT_READY');
    if (approving.has(job.id)) throw problem(409, 'Already adding these screens', 'AI_DESIGN_BUSY');
    approving.add(job.id);
    try {
      const current = apps.get(job.appId);
      let result;
      try {
        result = await reply.apply({ id: job.appId, conversation: job.conversationId, turnId: job.turnId,
          replyDigest: job.replyDigest, expectedVersion: current.version, approval: 'user-confirmed' });
      } catch (error) {
        const code = codeOf(error);
        if (['PERSONAL_APP_VERSION_CONFLICT', 'PERSONAL_APP_SCREEN_EXISTS', 'PERSONAL_APP_LIMIT', 'PROVIDER_REPLY_CHANGED'].includes(code)) {
          setState(job, 'failed', { error: { code, message: friendly(code, job.site) } });
        }
        throw error;
      }
      setState(job, 'applied', { applied: { version: result.app.version,
        screens: result.applied.map(({ key, label, kind }) => ({ key, label, kind })) } });
      return { job: publicJob(job), app: result.app, replayed: false };
    } finally { approving.delete(job.id); }
  }

  function discard({ jobId } = {}) {
    const job = need(jobId);
    if (approving.has(job.id)) throw problem(409, 'Already adding these screens; wait for the result', 'AI_DESIGN_BUSY');
    if (job.state === 'applied') throw problem(409, 'These screens were already added', 'AI_DESIGN_APPLIED');
    if (job.state !== 'discarded') setState(job, 'discarded', { waitingOn: null });
    return { job: publicJob(job) };
  }

  return { start, get, latestFor, approve, discard,
    // Test/diagnostic seam: resolves when the background runner of a job has settled.
    settled: jobId => running.get(jobId) ?? Promise.resolve() };
}
