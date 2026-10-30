// Central multi-AI orchestrator: ONE engine that every multi-site flow can use instead of each job
// runner re-implementing create → submit → observe → reconcile → finish. Plans are built by the pure
// builders in ./orchestrator-patterns.mjs (single, fan-out, race, fallback, hedge, council, judge,
// relay, critique-revise, verify) and run here through the ONE shared conversation runtime.
//
// Safety contract (same as compare-service.mjs, enforced in one place):
//  - One stable key per step: `<plan id>-<step id>`, assigned when the plan is created and never
//    regenerated. The rendered prompt is persisted BEFORE `attempted` is saved, and `attempted` is
//    saved (strictly — a failed write means nothing is sent) BEFORE submit. A step that is attempted
//    is only ever observed or reconciled read-only afterwards; it is never submitted again.
//  - One shared browser: a process-wide FIFO "browser lane" serializes every lease-holding phase
//    (create tab → readiness → type → submit) across ALL plans in this Studio. The lane is released as
//    soon as the runtime acknowledges the submit (or after fenceMs if that never settles), so reply
//    observation — plain stored-conversation reads — runs concurrently for every step.
//  - One tab-turn per site at a time: a step never starts on a site whose earlier turn (any plan in
//    this process) is still being answered.
//  - "Cancel", "race lost" and "deadline" only STOP WAITING. A question already sent stays sent and
//    may still finish in its tab; a question not yet sent is never sent.
//  - Restart: a plan whose owner process is gone is resumed. Attempted steps are observed only
//    (stored conversation + capped read-only reconcile); never-attempted steps may still be asked
//    (nothing was ever typed for them) unless the plan's deadline has passed.
//  - Never freeze: every wait sleeps on an unref'd timer and every runtime call is time-bounded.
//  - Plain language: user-facing messages never contain raw codes; codes stay in `reason`.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { executeConversationTool } from './conversation-tools.mjs';
import { problem } from './http.mjs';
import { SITE_LABELS, PATTERNS, PATTERN_NAMES, PATTERN_CHOICES, STEP_ROLES, MAX_STEPS, buildPlanSpec, describeResult, parsePlannerReply } from './orchestrator-patterns.mjs';

export { PATTERNS, PATTERN_NAMES, PATTERN_CHOICES, STEP_ROLES } from './orchestrator-patterns.mjs';
const SCHEMA = 'vivim.orchestrate/1';
const ID = /^orc-[a-f0-9]{24}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['ready', 'failed', 'skipped', 'stopped', 'cancelled']);
const BUSY = new Set(['DRIVE_LEASE_BUSY', 'THREAD_JOURNAL_BUSY', 'PREFIX_WRITER_BUSY', 'WRITER_WINDOW_BUSY']);
const MAX_KEPT = 60, MAX_EVENTS = 80;
const MAX_EMBED = 8000, MAX_PROMPT = 40000; // other AIs' answers embedded in a follow-up prompt
const LIVE_OWNERS = new Set(); // tokens of orchestrators alive in THIS process (PID-reuse guard)
const DEFAULT_TIMING = Object.freeze({
  pollMs: 2500, tickMs: 1000,
  busyMs: 180000,       // how long a busy browser is waited out (same key, backoff)
  replyMs: 600000,      // patience for one reply (also capped by the plan deadline)
  resumeMs: 180000,     // patience for a reply observed only after a VIVIM restart
  operationMs: 300000,  // ceiling for one awaited runtime call (the call itself keeps running)
  probeMs: 15000,       // ceiling for the browser target listing
  reconcileMs: 10000, maxReconciles: 8,
  fenceMs: 600000,      // how long the browser lane stays fenced behind a submit that never settles
  heartbeatMs: 60000, staleMs: 900000,
});

// ---------------------------------------------------------------------------------------------
// Process-wide scheduler. Shared by every orchestrator instance (and available to other runners)
// so two plans can never type into the one shared browser at the same time.
const LANE = { tail: Promise.resolve(), holders: 0, waiting: 0 };
export function acquireBrowserLane() {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const previous = LANE.tail;
  LANE.tail = previous.then(() => gate);
  LANE.waiting++;
  return previous.then(() => {
    LANE.waiting--; LANE.holders++;
    let released = false;
    return () => { if (!released) { released = true; LANE.holders--; open(); } };
  });
}
const SITE_TURNS = new Map(); // site -> number of turns in flight (0 or 1 in practice)
export const schedulerState = () => ({ laneHeld: LANE.holders > 0, laneWaiting: LANE.waiting,
  sitesBusy: [...SITE_TURNS.entries()].filter(([, n]) => n > 0).map(([site]) => site) });

// ---- auto routing seam ---------------------------------------------------------------------
// src/studio/ai-router.mjs (owned by its own lane) decides pattern + sites + plain-language reason.
// Loaded lazily and tolerantly: if it is missing or broken, Studio still boots and every explicit
// pattern keeps working; only `pattern: "auto"` reports that the chooser is unavailable.
let routerModule;
async function loadRouter() {
  if (routerModule !== undefined) return routerModule;
  try { routerModule = await import('./ai-router.mjs'); } catch (e) {
    console.warn('orchestrator: automatic pattern chooser unavailable', e?.code ?? e?.message);
    routerModule = null;
  }
  return routerModule;
}
// Router names → builder names. The router says "fan-out"; the engine's builder is "fanout".
const ROUTER_PATTERN = Object.freeze({ 'fan-out': 'fanout', fanout: 'fanout', single: 'single', fallback: 'fallback', race: 'race', judge: 'judge', council: 'council' });


// ---------------------------------------------------------------------------------------------
const coded = (code) => Object.assign(new Error(code), { code });
const codeOf = (e) => typeof e?.code === 'string' && CODE.test(e.code) ? e.code : 'ORCHESTRATE_FAILED';
const authBlocked = (value) => value?.signedIn === false || value?.authWall === true || value?.authWall?.present === true
  || /AUTH_WALL|SIGN_IN_REQUIRED|SIGNED_OUT|LOGIN_REQUIRED/.test(String(value?.reason ?? value?.readiness?.reason ?? value?.code ?? ''));
const turnFor = (stored, key) => (Array.isArray(stored?.turns) ? stored.turns : stored?.turn ? [stored.turn] : []).find((turn) => turn?.key === key);
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};
const clip = (text, max) => text.length <= max ? text : text.slice(0, max) + '\n…(shortened)';
const iso = () => new Date().toISOString();
const msBetween = (a, b) => { const x = Date.parse(a ?? ''), y = Date.parse(b ?? ''); return Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null; };
function looseJson(text) {
  const t = String(text ?? '').replace(/[\u201c\u201d]/g, '"').trim();
  const start = t.search(/[[{]/), end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function failureMessage(code, label) {
  if (BUSY.has(code)) return `Your AI browser stayed busy with another conversation. Nothing was sent to ${label}.`;
  switch (code) {
    case 'REPLY_TIMEOUT': return `${label} is taking longer than expected. Nothing was sent twice. Check its tab for the answer.`;
    case 'RESUMED_UNFINISHED': return `VIVIM restarted while ${label} was answering. Nothing was sent twice. Check its tab for the full answer.`;
    case 'BROWSER_UNAVAILABLE': return 'Open your VIVIM AI browser, then try again.';
    case 'CONNECT_TIMEOUT': return `Could not open ${label} in time. Nothing was sent. Check that your VIVIM AI browser is open.`;
    case 'REPLY_INTERRUPTED': return `${label} stopped before finishing its answer. Nothing was repeated. Check its tab.`;
    case 'SAVE_FAILED': return `Could not save progress, so nothing was sent to ${label}. Check that your PC has free disk space.`;
    case 'TURN_NOT_FOUND': case 'DELIVERY_UNCONFIRMED': case 'CREATION_UNPINNED':
      return `Could not confirm that ${label} received your question, so nothing was repeated. Check its tab before asking again.`;
    default:
      if (/DRAFT|TYPING/.test(code)) return `Check the ${label} tab for unsent text. Clear it before trying again.`;
      return `Could not finish with ${label}. Nothing was repeated. Check its tab.`;
  }
}
const validPlan = (plan, id) => plan?.schema === SCHEMA && plan.id === id && typeof plan.question === 'string' && typeof plan.state === 'string'
  && Array.isArray(plan.steps) && plan.steps.length >= 1 && plan.steps.every((s) => Object.hasOwn(SITE_LABELS, s?.site) && s.key === id + '-' + s.id && typeof s.state === 'string');

export function createOrchestrator({ paths, conversations, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }), timing = {}, onEvent = null } = {}) {
  if (!paths?.root || !path.isAbsolute(paths.root) || !conversations) throw new TypeError('Paths and shared conversation runtime required');
  const t = { ...DEFAULT_TIMING, ...timing };
  const directory = path.join(paths.root, 'orchestrate-plans');
  mkdirSync(directory, { recursive: true });
  const token = randomBytes(8).toString('hex');
  LIVE_OWNERS.add(token);
  const plans = new Map(), running = new Map(), lastSaved = new Map(), signals = new Map(), cleanups = new Map();
  let closed = false;
  const tool = (name, args = {}) => executeConversationTool(conversations, name, args);
  const fileOf = (id) => path.join(directory, id + '.json');
  const ours = (plan) => plan.ownerPid === process.pid && plan.ownerToken === token;
  const byId = (plan, id) => plan.steps.find((s) => s.id === id);
  const done = (step) => TERMINAL.has(step.state);

  // ---- persistence --------------------------------------------------------------------------
  function save(plan) { // strict: callers that must not proceed on a failed write use this
    if (closed) throw coded('SAVE_FAILED');
    plan.updatedAt = iso();
    const file = fileOf(plan.id), tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(plan, null, 1)); renameSync(tmp, file);
    lastSaved.set(plan.id, Date.now());
  }
  function persist(plan) { if (closed) return; try { save(plan); } catch (e) { console.warn('orchestrator: could not save plan', plan.id, e?.code ?? e?.message); } }
  const loadFromDisk = (id) => { try { const plan = JSON.parse(readFileSync(fileOf(id), 'utf8')); return validPlan(plan, id) ? plan : null; } catch { return null; } };

  // ---- progress -----------------------------------------------------------------------------
  function notify(plan) { const s = signals.get(plan.id); if (s) { signals.delete(plan.id); s(); } }
  const changed = (plan, ms) => new Promise((resolve) => { signals.set(plan.id, resolve); sleep(ms).then(resolve); });
  function event(plan, text, step = null) {
    if (!text) return;
    plan.events.push({ at: iso(), text, ...(step ? { step: step.id, site: step.site } : {}) });
    if (plan.events.length > MAX_EVENTS) plan.events.splice(0, plan.events.length - MAX_EVENTS);
    try { onEvent?.({ planId: plan.id, text, step: step?.id ?? null }); } catch { /* observer errors never stop a plan */ }
  }
  // Every step state change goes through here: never overwrite a finished step (a race, cancel or
  // deadline may have finished it while an await was in flight).
  function update(plan, step, patch, { say = null, strict = false } = {}) {
    if (done(step) && !patch.force) return false;
    const { force, ...rest } = patch;
    Object.assign(step, rest);
    if (strict) { save(plan); if (say) event(plan, say, step); } // no "Sent" event unless the save landed
    else { if (say) event(plan, say, step); persist(plan); }
    notify(plan);
    return true;
  }
  const finish = (plan, step, state, reason, message) => update(plan, step, { state, reason, message, endedAt: iso() }, { say: message });

  // ---- bounded runtime calls ----------------------------------------------------------------
  async function bounded(promise, ms = t.operationMs) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(coded('CONNECT_TIMEOUT')), ms); timer.unref?.(); })]);
    } finally { clearTimeout(timer); }
  }
  const halted = (plan, step) => closed || !ACTIVE.has(plan.state) || done(step);
  async function busy(plan, step, fn) {
    const deadline = Date.now() + t.busyMs, before = step.message; let delay = Math.min(2000, t.pollMs), waited = false;
    for (;;) {
      // A busy-browser refusal means nothing was typed, so stopping the retry is always safe; the key
      // is never reused for another submit (a later restart only observes it).
      if (halted(plan, step)) throw Object.assign(new Error('halted'), { halted: true });
      try {
        const out = await fn();
        if (waited) update(plan, step, { message: before });
        return out;
      } catch (e) {
        if (!BUSY.has(codeOf(e)) || Date.now() >= deadline) throw e;
        if (!waited) update(plan, step, { message: 'Waiting for your AI browser…' });
        waited = true;
        await sleep(delay); delay = Math.min(Math.ceil(delay * 1.6), 15000);
      }
    }
  }
  async function signedOut(site) { // only explicit auth-wall evidence skips; the runtime's readiness stays authoritative
    let discovery;
    try { discovery = await bounded(tool('conversation_targets'), t.probeMs); }
    catch (e) { if (codeOf(e) === 'BROWSER_UNAVAILABLE') throw e; return false; }
    const entries = [...(discovery?.sites ?? []), ...(discovery?.targets ?? [])].filter((item) => (item?.site?.id ?? item?.site ?? item?.id) === site);
    return entries.length > 0 && entries.every(authBlocked);
  }
  function skipSignedOut(plan, step) {
    finish(plan, step, 'skipped', 'SIGNED_OUT', `${step.label} isn't signed in on your PC. Sign in to ${step.label} in your VIVIM browser.`);
  }

  // ---- prompts ------------------------------------------------------------------------------
  // Rendered once, single pass (an answer that itself contains "{{question}}" is never expanded).
  function render(plan, step) {
    const deps = step.after.map((id) => byId(plan, id)).filter((s) => s.state === 'ready' && s.valid);
    const candidates = [];
    const prompt = step.template.replace(/\{\{(question|previous|answers|answer:s\d{1,2})\}\}/g, (_, slot) => {
      if (slot === 'question') return plan.question;
      if (slot === 'previous') return clip(deps.at(-1)?.answer ?? '(no answer)', MAX_EMBED);
      if (slot === 'answers') {
        const per = Math.max(1500, Math.min(MAX_EMBED, Math.floor(MAX_PROMPT / Math.max(1, deps.length))));
        return deps.map((s, i) => { candidates.push(s.id); return `Answer ${i + 1}:\n${clip(s.answer, per)}`; }).join('\n\n');
      }
      const ref = byId(plan, slot.slice(7));
      return clip(ref?.state === 'ready' ? ref.answer : '(no answer)', MAX_EMBED);
    });
    return { prompt: clip(prompt, MAX_PROMPT + 12000), candidates };
  }
  const isValid = (plan, text) => !!text.trim() && (plan.options.expect !== 'json' || looseJson(text) !== null);

  // ---- eligibility --------------------------------------------------------------------------
  function decide(plan, step) {
    if (plan.winner && plan.firstWins.includes(step.id)) return { skip: 'NOT_NEEDED', message: `Not asked — ${byId(plan, plan.winner).label} already answered.` };
    const w = step.when ?? {};
    if (w.hedge) {
      const target = byId(plan, w.hedge.step);
      if (target.state === 'ready' && target.valid) return { skip: 'NOT_NEEDED', message: `Not asked — ${target.label} answered in time.` };
      if (done(target)) return 'go';
      if (target.submittedAt && Date.now() - Date.parse(target.submittedAt) >= w.hedge.afterMs) return 'go';
      return 'wait';
    }
    const deps = step.after.map((id) => byId(plan, id));
    if (deps.some((d) => !done(d))) return 'wait';
    const ready = deps.filter((d) => d.state === 'ready' && d.valid);
    if (w.noneReady && ready.length) return { skip: 'NOT_NEEDED', message: `Not needed — ${ready[0].label} already answered.` };
    if (w.minReady && ready.length < w.minReady) return { skip: 'NOT_ENOUGH', message: `Not asked — not enough answers came back for ${step.label} to work with.` };
    if (w.skipIf) {
      const ref = byId(plan, w.skipIf.step);
      if (ref?.state === 'ready' && new RegExp(w.skipIf.match, 'i').test(ref.answer)) return { skip: 'NOT_NEEDED', message: `Not needed — ${ref.label} found nothing to change.` };
    }
    return 'go';
  }
  const startText = (step) => ({ answer: `Asking ${step.label}…`, synthesize: `Asking ${step.label} to combine the answers…`,
    judge: `Asking ${step.label} to pick the best answer…`, improve: `Asking ${step.label} to improve the answer…`,
    critique: `Asking ${step.label} to review the answer…`, revise: `Asking ${step.label} to improve its answer…`,
    verify: `Asking ${step.label} to double-check the answer…` }[step.role] ?? `Asking ${step.label}…`);

  // ---- race ---------------------------------------------------------------------------------
  function maybeWin(plan, step) {
    if (plan.winner || !plan.firstWins.includes(step.id) || step.state !== 'ready' || !step.valid) return;
    plan.winner = step.id;
    for (const other of plan.steps) {
      if (other === step || !plan.firstWins.includes(other.id) || done(other)) continue;
      if (other.attempted) finish(plan, other, 'stopped', 'RACE_LOST', `Stopped waiting — ${step.label} answered first. ${other.label} may still finish in its tab; nothing will be repeated.`);
      else finish(plan, other, 'skipped', 'NOT_NEEDED', `Not asked — ${step.label} already answered.`);
    }
  }

  // ---- one step -----------------------------------------------------------------------------
  async function acquireSite(plan, step) {
    let said = false;
    while ((SITE_TURNS.get(step.site) ?? 0) > 0) {
      if (halted(plan, step)) return null;
      if (!said) { said = true; update(plan, step, { message: `Waiting for ${step.label} to finish its other answer…` }); }
      await sleep(Math.min(t.pollMs, 1000));
    }
    if (halted(plan, step)) return null;
    SITE_TURNS.set(step.site, 1);
    let released = false;
    return () => { if (!released) { released = true; SITE_TURNS.set(step.site, 0); } };
  }

  async function runStep(plan, step, resumed) {
    const ctx = { pending: null, outcome: null, read: null };
    let releaseSite = null, releaseLane = null;
    try {
      if (!step.attempted) {
        if (!step.startedAt) step.startedAt = iso();
        update(plan, step, { state: 'waiting', message: startText(step) }, { say: startText(step) });
        releaseSite = await acquireSite(plan, step);
        if (!releaseSite) return;
        if (await signedOut(step.site)) { skipSignedOut(plan, step); return; }
        if (halted(plan, step)) return;
        if (LANE.holders || LANE.waiting) update(plan, step, { message: `Waiting for your AI browser to finish sending your other questions…` });
        releaseLane = await acquireBrowserLane();
        if (halted(plan, step)) return;
        update(plan, step, { state: 'asking', message: startText(step) });
        if (step.conversationId) { // a tab opened by an earlier VIVIM run that never sent anything
          const stale = step.conversationId; step.conversationId = null;
          bounded(tool('finish_conversation', { conversation: stale, closeTab: true }), t.probeMs).catch(() => {});
        }
        // A fresh tab sends nothing. A create that outlives its bound is closed when it lands.
        const created = await busy(plan, step, () => {
          const call = tool('create_conversation', { site: step.site });
          return bounded(call).catch((error) => {
            if (codeOf(error) === 'CONNECT_TIMEOUT') call.then((late) => late?.id && tool('finish_conversation', { conversation: late.id, closeTab: true }), () => {}).catch(() => {});
            throw error;
          });
        });
        update(plan, step, { conversationId: created.id, force: done(step) }); // record even if halted, so cleanup closes it
        if (halted(plan, step)) return;
        if (authBlocked(created)) { skipSignedOut(plan, step); return; }
        ctx.read = () => bounded(tool('get_conversation', { conversation: step.conversationId }));
        const stored = await ctx.read();
        if (authBlocked(stored)) { skipSignedOut(plan, step); return; }
        if (halted(plan, step)) return;
        // Render, persist the exact prompt, then persist `attempted` — strict: a failed write sends nothing.
        // No await between the last halt check and the strict save, so a race/cancel cannot slip in.
        if (step.prompt === null) { const r = render(plan, step); step.prompt = r.prompt; step.candidates = r.candidates; }
        try { update(plan, step, { attempted: true, submittedAt: iso(), state: 'sent', message: `Waiting for ${step.label}…` }, { strict: true, say: `Sent to ${step.label}. Waiting for its answer…` }); }
        catch { step.attempted = false; step.submittedAt = null; throw coded('SAVE_FAILED'); }
        ctx.pending = busy(plan, step, async () => {
          const latest = await ctx.read();
          if (turnFor(latest, step.key)) return;
          return tool('submit_conversation_turn', { conversation: step.conversationId, key: step.key, prompt: step.prompt, confirm: true, expectedRevision: latest.revision });
        }).then(() => ({ done: true }), (error) => ({ error }));
        ctx.pending.then((value) => { ctx.outcome = value; });
        // Hand the browser to the next queued send as soon as this one is acknowledged (or fenced out).
        const lane = releaseLane; releaseLane = null;
        Promise.race([ctx.pending, sleep(t.fenceMs)]).finally(lane);
      } else {
        if (!step.conversationId) throw coded('DELIVERY_UNCONFIRMED');
        releaseSite = await acquireSite(plan, step) ?? (() => {});
        ctx.read = () => bounded(tool('get_conversation', { conversation: step.conversationId }));
        update(plan, step, { state: 'sent', message: `Waiting for ${step.label}…` }, { say: resumed ? `Checking on ${step.label}’s answer after the restart…` : null });
      }
      await observe(plan, step, resumed && !ctx.pending, ctx);
    } catch (error) {
      if (error?.halted || closed) return;
      if (authBlocked(error)) { skipSignedOut(plan, step); return; }
      const reason = codeOf(error);
      finish(plan, step, 'failed', reason, failureMessage(reason, step.label));
    } finally {
      releaseLane?.();
      if (!closed) {
        // Cleanup runs in the background so a stuck submit never holds up the plan's result.
        const work = (async () => {
          if (ctx.pending && !ctx.outcome) await Promise.race([ctx.pending, sleep(t.fenceMs)]);
          if (step.conversationId && !closed) {
            await bounded(tool('finish_conversation', { conversation: step.conversationId,
              closeTab: !step.attempted && step.reason !== 'SIGNED_OUT' }), t.probeMs).catch(() => {});
          }
        })().finally(() => releaseSite?.());
        const list = cleanups.get(plan.id) ?? []; list.push(work); cleanups.set(plan.id, list);
      } else releaseSite?.();
      notify(plan);
    }
  }

  // Observe only — never resends. Uncertain or unwatched turns get a capped read-only reconcile.
  async function observe(plan, step, resumed, ctx) {
    // A resumed observation gets its own short patience even past the plan deadline: the answer may
    // already be saved, and reading it is free. A live one is capped by the plan deadline.
    const deadline = resumed ? Date.now() + t.resumeMs : Math.min(Date.now() + t.replyMs, Date.parse(plan.deadlineAt) || Infinity);
    let lastReconcile = Date.now(), reconciles = 0, misses = 0;
    for (;;) {
      if (halted(plan, step)) return;
      if (Date.now() >= deadline) throw coded(resumed ? 'RESUMED_UNFINISHED' : 'REPLY_TIMEOUT');
      const settledBefore = ctx.outcome;
      let stored;
      try { stored = await ctx.read(); misses = 0; } catch (error) { if (++misses > 10) throw error; await sleep(t.pollMs); continue; }
      if (halted(plan, step)) return;
      const turn = turnFor(stored, step.key);
      if (!turn) {
        if (settledBefore) throw settledBefore.error ?? coded('TURN_NOT_FOUND'); // refused before typing: never resend
        if (!ctx.pending) throw coded('TURN_NOT_FOUND');
        await sleep(t.pollMs); continue;
      }
      const answer = typeof turn.reply?.text === 'string' ? turn.reply.text : '';
      if (turn.id !== step.turnId || answer !== step.answer) {
        const first = !step.answer && answer;
        update(plan, step, { turnId: turn.id, answer, ...(answer ? { state: 'answering', message: `${step.label} is answering…` } : {}) }, { say: first ? `${step.label} is answering…` : null });
      } else if (Date.now() - (lastSaved.get(plan.id) ?? 0) >= t.heartbeatMs) persist(plan);
      if (turn.reply?.state === 'ready') {
        const valid = isValid(plan, answer);
        update(plan, step, { state: 'ready', valid, reason: valid ? null : 'INVALID_ANSWER', answeredAt: iso(), endedAt: iso(),
          message: valid ? 'Answer ready' : `${step.label} answered, but not in the expected form.` }, { say: valid ? `${step.label} answered.` : `${step.label} answered, but not in the expected form.` });
        maybeWin(plan, step);
          // A planner (agent) step decides what comes next: parse its reply and append steps, or
          // finish the plan. Its own reply was already sent — nothing is ever re-sent.
          if (step.agent) handlePlannerDecision(plan, step);
          return;
      }
      if (turn.phase === 'blocked' || turn.reply?.state === 'interrupted') throw coded(CODE.test(turn.reason ?? '') ? turn.reason : 'REPLY_INTERRUPTED');
      const uncertain = turn.send?.state === 'uncertain' || ['uncertain', 'needs-reconciliation'].includes(turn.phase) || stored.state === 'needs-reconciliation';
      const unwatched = turn.reply?.state === 'unknown' && turn.send?.state === 'observed';
      if ((uncertain || unwatched || resumed) && (!ctx.pending || ctx.outcome) && reconciles < t.maxReconciles && Date.now() - lastReconcile >= t.reconcileMs) {
        reconciles++; lastReconcile = Date.now();
        await bounded(tool('reconcile_conversation', { conversation: step.conversationId, expectedRevision: stored.revision, turnId: turn.id }), t.operationMs).catch(() => {});
      } else if (uncertain && reconciles >= t.maxReconciles && Date.now() - lastReconcile >= t.reconcileMs) {
        throw coded(CODE.test(turn.reason ?? '') ? turn.reason : 'DELIVERY_UNCONFIRMED');
      }
      await sleep(t.pollMs);
    }
  }

  // ---- result -------------------------------------------------------------------------------
  function choose(plan) {
    const rule = plan.choose, good = (id) => { const s = byId(plan, id); return s?.state === 'ready' && s.valid ? s : null; };
    const earliest = (ids) => ids.map(good).filter(Boolean).sort((a, b) => String(a.answeredAt).localeCompare(String(b.answeredAt)))[0] ?? null;
    const from = (s) => s ? { step: s.id, site: s.site, label: s.label } : null;
    let picked = null, notes = null, summary = null;
    if (rule.rule === 'all') {
      const answers = rule.steps.map(good).filter(Boolean).map((s) => ({ step: s.id, site: s.site, label: s.label, answer: s.answer }));
      return { answer: null, from: null, answers, notes: null, summary: describeResult(plan, null) };
    }
    if (rule.rule === 'first') picked = plan.winner ? good(plan.winner) : (plan.pattern === 'fallback' ? rule.steps.map(good).find(Boolean) ?? null : earliest(rule.steps));
    if (rule.rule === 'prefer') picked = rule.order.map(good).find(Boolean) ?? earliest(rule.fallback ?? []);
    if (rule.rule === 'judge') {
      const judge = good(rule.judge);
      const n = judge ? Number(/WINNER\s*:\s*\**\s*(\d+)/i.exec(judge.answer)?.[1]) : NaN;
      picked = Number.isInteger(n) && judge.candidates?.[n - 1] ? good(judge.candidates[n - 1]) : null;
      if (picked) { notes = /WHY\s*:\s*([\s\S]+)/i.exec(judge.answer)?.[1]?.trim() ?? null; summary = `${judge.label} picked ${picked.label}’s answer as the best.`; }
      else { picked = earliest(rule.fallback); if (picked) summary = judge ? `${judge.label}’s choice couldn’t be read, so this is the first answer that came back (from ${picked.label}).` : `No verdict came back, so this is the first answer that came back (from ${picked.label}).`; }
    }
    if (rule.rule === 'verify') {
      picked = good(rule.answer);
      const check = good(rule.check);
      if (picked && check) {
        const verdict = /VERDICT\s*:\s*\**\s*(OK|PROBLEMS)/i.exec(check.answer)?.[1]?.toUpperCase() ?? null;
        notes = /NOTES\s*:\s*([\s\S]+)/i.exec(check.answer)?.[1]?.trim() ?? check.answer.trim();
        summary = verdict === 'OK' ? `${check.label} checked ${picked.label}’s answer and found no problems.`
          : verdict === 'PROBLEMS' ? `${check.label} checked ${picked.label}’s answer and found problems — see the notes.` : `${check.label} checked ${picked.label}’s answer — see the notes.`;
      } else if (picked) summary = `Answer from ${picked.label}; the double-check didn’t finish.`;
    }
    return { answer: picked?.answer ?? null, from: from(picked), answers: null, notes, summary: summary ?? describeResult(plan, picked) };
  }
  function finalize(plan) {
    const result = choose(plan);
    const has = result.answer || result.answers?.length;
    const problems = plan.steps.some((s) => s.state === 'failed' || (s.state === 'skipped' && s.reason === 'SIGNED_OUT') || (s.state === 'ready' && !s.valid));
    plan.result = has ? result : { ...result, summary: 'No answer came back. Nothing was sent twice. Check your AI tabs, then try again.' };
    plan.state = !has ? 'failed' : problems || (plan.choose.rule === 'all' && result.answers.length < plan.choose.steps.length) ? 'partial' : 'complete';
    event(plan, plan.result.summary);
    persist(plan);
  }

  // ---- plan loop ----------------------------------------------------------------------------
  // Sent steps that are being observed carry their own deadline (see observe); everything else stops now.
  function expire(plan, inflight) {
    for (const step of plan.steps) {
      if (done(step) || (step.attempted && inflight.has(step.id))) continue;
      if (step.attempted) finish(plan, step, 'stopped', 'DEADLINE', `Stopped waiting for ${step.label} — it took too long. Nothing was sent twice; its answer may still appear in its tab.`);
      else finish(plan, step, 'skipped', 'DEADLINE', `Not asked — ran out of time.`);
    }
  }
  async function runPlan(plan, resumed) {
    const inflight = new Map();
    try {
      if (!ACTIVE.has(plan.state)) return;
      plan.state = 'running'; persist(plan);
      for (;;) {
        if (closed || !ACTIVE.has(plan.state)) break;
        for (const step of plan.steps) { // already-sent steps: observe only, first
          if (step.attempted && !done(step) && !inflight.has(step.id)) inflight.set(step.id, runStep(plan, step, resumed));
        }
        if (Date.now() >= (Date.parse(plan.deadlineAt) || Infinity)) expire(plan, inflight);
        for (const step of plan.steps) {
          if (done(step) || inflight.has(step.id)) continue;
          if (plan.finishRequested && !step.attempted) { finish(plan, step, 'skipped', 'NOT_NEEDED', `Not asked — the planner finished the plan.`); continue; }
          const verdict = decide(plan, step);
          if (verdict === 'wait') continue;
          if (verdict.skip) { finish(plan, step, 'skipped', verdict.skip, verdict.message); continue; }
          inflight.set(step.id, runStep(plan, step, resumed));
        }
        if (plan.steps.every(done)) break;
        if (Date.now() - (lastSaved.get(plan.id) ?? 0) >= t.heartbeatMs) persist(plan);
        await changed(plan, t.tickMs);
      }
      if (closed) return;
      if (plan.state !== 'cancelled') finalize(plan);
    } finally {
      if (!closed) {
        await Promise.allSettled([...inflight.values()]);
        await Promise.allSettled(cleanups.get(plan.id) ?? []);
        cleanups.delete(plan.id);
        prune();
      }
    }
  }
  function launch(plan, resumed = false) {
    if (running.has(plan.id)) return;
    const work = runPlan(plan, resumed).catch((e) => console.warn('orchestrator: plan stopped unexpectedly', plan.id, e?.code ?? e?.message));
    running.set(plan.id, work);
    work.finally(() => running.delete(plan.id));
  }
  function prune() {
    const finished = [...plans.values()].filter((p) => !ACTIVE.has(p.state) && !running.has(p.id)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const plan of finished.slice(MAX_KEPT)) {
      plans.delete(plan.id); lastSaved.delete(plan.id);
      try { rmSync(fileOf(plan.id), { force: true }); } catch { /* best effort */ }
    }
  }
  const abandoned = (plan) => {
    if (plan.ownerPid === process.pid) return !LIVE_OWNERS.has(plan.ownerToken);
    if (!pidAlive(plan.ownerPid)) return true;
    return Date.now() - (Date.parse(plan.updatedAt) || 0) > t.staleMs;
  };

  // ---- views --------------------------------------------------------------------------------
  const stepView = (s) => ({ id: s.id, site: s.site, label: s.label, role: s.role, state: s.state, message: s.message,
    answer: s.answer, valid: s.valid, conversationId: s.conversationId, startedAt: s.startedAt, submittedAt: s.submittedAt, answeredAt: s.answeredAt,
    queuedMs: msBetween(s.startedAt, s.submittedAt), answerMs: msBetween(s.submittedAt, s.answeredAt) });
  const view = (plan) => ({ id: plan.id, pattern: plan.pattern, requestedPattern: plan.requestedPattern ?? plan.pattern,
    title: PATTERNS[plan.requestedPattern === 'auto' ? 'auto' : plan.pattern]?.title ?? plan.pattern, question: plan.question,
    sites: plan.sites, options: plan.options, state: plan.state, message: plan.events.at(-1)?.text ?? '',
    createdAt: plan.createdAt, updatedAt: plan.updatedAt, deadlineAt: plan.deadlineAt,
    routing: plan.routing ?? null, result: plan.result ?? null, events: plan.events, steps: plan.steps.map(stepView) });

  // ---- startup: resume abandoned plans ------------------------------------------------------
  for (const file of readdirSync(directory)) {
    const tmp = /^orc-[a-f0-9]{24}\.json\.(\d+)\.tmp$/.exec(file);
    if (tmp) { if (!pidAlive(Number(tmp[1]))) try { rmSync(path.join(directory, file), { force: true }); } catch { /* best effort */ } continue; }
    const id = file.replace(/\.json$/, '');
    if (!ID.test(id) || file !== id + '.json') continue;
    const plan = loadFromDisk(id); // unreadable files stay on disk for support and are never replayed
    if (!plan) continue;
    plans.set(plan.id, plan);
    if (ACTIVE.has(plan.state) && abandoned(plan)) {
      plan.ownerPid = process.pid; plan.ownerToken = token;
      event(plan, 'VIVIM restarted — picking up where it left off. Nothing already sent will be sent again.');
      persist(plan); launch(plan, true);
    }
  }
  prune();

  function need(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw problem(400, 'That isn’t a valid question id.', 'ORCHESTRATE_INVALID');
    let plan = plans.get(id);
    if (!plan || !ours(plan)) { const disk = loadFromDisk(id); if (disk) { plans.set(id, disk); plan = disk; } }
    if (!plan) throw problem(404, 'That question wasn’t found. It may have been cleared.', 'ORCHESTRATE_NOT_FOUND');
    return plan;
  }

  // ---- auto: ask the router what to do, then run the ordinary builder --------------------------
  async function resolveAuto(input) {
    const router = await loadRouter();
    if (!router || typeof router.route !== 'function' || typeof router.learnInput !== 'function') {
      throw problem(503, 'Choosing automatically isn’t available in this build. Pick a way to ask instead — for example "council" or "race".', 'ORCHESTRATE_ROUTER_UNAVAILABLE');
    }
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question || question.length > 10000) throw problem(400, 'Write a question under 10,000 characters.', 'ORCHESTRATE_INVALID');
    const options = input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options : {};
    // History (read-only, saved job files) + which sites have a tab open right now. No browser send.
    const providers = await router.learnInput({ paths, readTargets: async () => {
      let discovery = null;
      try { discovery = await bounded(tool('conversation_targets'), t.probeMs); } catch { /* no browser: history only */ }
      const targets = [], signedIn = {};
      for (const item of [...(discovery?.sites ?? []), ...(discovery?.targets ?? [])]) {
        const site = typeof item?.site === 'string' ? item.site : item?.site?.id ?? item?.id;
        if (!site) continue;
        targets.push({ site });
        if (authBlocked(item)) signedIn[site] = false;
      }
      return { targets, signedIn };
    } });
    const decision = router.route({ task: question, role: options.role ?? null, constraints: options.constraints ?? {}, providers });
    const plain = typeof router.explain === 'function' ? router.explain(decision) : decision.reason;
    if (!Array.isArray(decision?.sites) || !decision.sites.length) {
      throw problem(409, decision?.reason || 'No AI accounts are signed in right now, so there is nothing to ask yet. Sign in to an AI in your VIVIM browser, then try again.', 'ORCHESTRATE_NO_PROVIDERS');
    }
    const pattern = ROUTER_PATTERN[decision.pattern];
    if (!pattern) throw problem(503, 'The automatic choice asked for a way of asking this build doesn’t have. Pick one instead.', 'ORCHESTRATE_ROUTER_UNAVAILABLE');
    const sites = decision.sites.filter((site) => Object.hasOwn(SITE_LABELS, site));
    if (!sites.length) throw problem(409, 'The automatic choice picked an AI this build can’t ask yet. Pick one instead.', 'ORCHESTRATE_NO_PROVIDERS');
    // A judge needs to know who judges; the router names it in options.judgeSite.
    const mapped = pattern === 'judge' ? { ...options, by: decision.options?.judgeSite ?? sites.at(-1) } : options;
    return { pattern, sites, options: mapped,
      routing: { requested: 'auto', chosen: decision.pattern, reason: decision.reason ?? null, plain: plain ?? null, alternatives: decision.alternatives ?? [] } };
  }

  // ---- internal agent-loop API ------------------------------------------------------
  // createPlan / launch / appendStep / cancel / settled are the clean internal seam a web-AI
  // planner (the agent loop, built by a later lane) uses to drive plans. createPlan persists a
  // plan but does NOT launch it, so the planner can append the initial agent step first if it
  // wants full control. launch() starts the run loop; the loop re-reads plan.steps each tick, so
  // steps appended by the planner are picked up automatically. cancel/settled behave the same as
  // the public HTTP entry points. view/stepView turn an internal plan or step into the display
  // shape returned over HTTP.
  function createPlan(input, { routing = null } = {}) {
    const spec = buildPlanSpec(input); // throws ORCHESTRATE_INVALID for a bad pattern/question (no 'auto')
    const id = 'orc-' + randomBytes(12).toString('hex'), now = Date.now();
    const plan = { schema: SCHEMA, id, ownerPid: process.pid, ownerToken: token, fingerprint: null,
      pattern: spec.pattern, requestedPattern: spec.pattern, routing, question: spec.question,
      sites: spec.sites, options: spec.options, firstWins: spec.firstWins, choose: spec.choose, winner: null, result: null,
      state: 'queued', createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + spec.options.deadlineMinutes * 60000).toISOString(),
      events: [], finishRequested: false, steps: spec.steps.map((s) => ({ ...s, key: id + '-' + s.id, prompt: null, candidates: null, attempted: false, state: 'pending',
        answer: '', valid: null, message: 'Waiting to start…', reason: null, conversationId: null, turnId: null,
        startedAt: null, submittedAt: null, answeredAt: null, endedAt: null })) };
    event(plan, `${PATTERNS[spec.pattern].title}: ${spec.sites.map((s) => SITE_LABELS[s]).join(', ')}.`);
    try { save(plan); } catch { throw problem(503, 'Could not save your plan. Check that your PC has free disk space, then try again.', 'ORCHESTRATE_SAVE_FAILED'); }
    plans.set(id, plan);
    return { plan };
  }
  function launch(plan, resumed = false) {
    if (running.has(plan.id)) return;
    const work = runPlan(plan, resumed).catch((e) => console.warn('orchestrator: plan stopped unexpectedly', plan.id, e?.code ?? e?.message));
    running.set(plan.id, work);
    work.finally(() => running.delete(plan.id));
  }
  function appendStep(plan, { site, role, template, after = [], when = null, agent = false } = {}) {
    if (plan.steps.length >= MAX_STEPS) throw Object.assign(new Error('That plan already has the maximum number of steps.'), { code: 'ORCHESTRATE_INVALID', status: 400 });
    if (!Object.hasOwn(SITE_LABELS, site)) throw Object.assign(new Error(`Unknown AI site "${site}".`), { code: 'ORCHESTRATE_INVALID', status: 400 });
    if (typeof role !== 'string' || !STEP_ROLES.includes(role)) throw Object.assign(new Error(`Unknown step role "${role}".`), { code: 'ORCHESTRATE_INVALID', status: 400 });
    if (typeof template !== 'string' || !template.trim()) throw Object.assign(new Error('A step needs a prompt.'), { code: 'ORCHESTRATE_INVALID', status: 400 });
    const stepId = 's' + (plan.steps.length + 1);
    const step = { id: stepId, site, label: SITE_LABELS[site], role, template: template.trim(), after: [...after], when, agent,
      key: plan.id + '-' + stepId, prompt: null, candidates: null, attempted: false, state: 'pending',
      answer: '', valid: null, message: 'Waiting to start…', reason: null,
      conversationId: null, turnId: null, startedAt: null, submittedAt: null, answeredAt: null, endedAt: null };
    plan.steps.push(step);
    save(plan);
    notify(plan);
    return step;
  }
  // A planner (agent) step just answered. Parse its reply (tolerant: smart quotes, fences, loose
  // JSON — same style as src/studio/agent-actions.mjs) and append the steps it decided, or mark
  // the plan finished when the planner says so. Never resends: the planner step itself was already
  // sent; anything it decides is appended as fresh, never-attempted steps.
  function handlePlannerDecision(plan, step) {
    if (closed) return;
    let decision;
    try { decision = parsePlannerReply(step.answer ?? ''); } catch { decision = null; }
    if (!decision) {
      plan.finishRequested = true;
      event(plan, `${step.label}’s reply couldn’t be read as a plan, so nothing more will be sent.`, step);
      return;
    }
    if (decision.summary) event(plan, decision.summary, step);
    if (decision.finish) { plan.finishRequested = true; return; }
    for (const s of decision.steps) {
      try { appendStep(plan, { site: s.site, role: s.role, template: s.prompt, after: s.after, when: s.when, agent: false }); }
      catch (e) { /* one undecidable step doesn't stop the others */ }
    }
  }

  return {
    patterns: () => PATTERN_CHOICES.map((name) => ({ name, ...PATTERNS[name] })),
    async start(input = {}) {
      const wantsAuto = input?.pattern === 'auto';
      let planInput, spec, routing = null;
      try {
        if (wantsAuto) {
          const resolved = await resolveAuto(input);
          routing = resolved.routing;
          planInput = { pattern: resolved.pattern, question: input.question, sites: resolved.sites, options: resolved.options };
          spec = buildPlanSpec(planInput);
        } else {
          planInput = input;
          spec = buildPlanSpec(planInput);
        }
      } catch (e) {
        if (e?.status) throw e;
        if (e?.code === 'ORCHESTRATE_INVALID') throw problem(400, e.message, e.code);
        throw e;
      }
      // A double tap or a lost response never means a second provider send.
      const fingerprint = JSON.stringify([wantsAuto ? 'auto' : spec.pattern, spec.question, spec.sites, spec.options]);
      const existing = [...plans.values()].find((p) => ACTIVE.has(p.state) && p.fingerprint === fingerprint);
      if (existing) return { plan: view(existing) };
      const id = 'orc-' + randomBytes(12).toString('hex'), now = Date.now();
      const { plan } = createPlan(planInput, { routing });
      plan.requestedPattern = wantsAuto ? 'auto' : spec.pattern;
      if (routing) event(plan, routing.plain || routing.reason || 'Choosing how to ask automatically…');
      persist(plan);
      plans.set(plan.id, plan);
      launch(plan);
      prune();
      return { plan: view(plan) };
    },
    get: (id) => ({ plan: view(need(id)) }),
    list: () => ({ patterns: PATTERN_CHOICES.map((name) => ({ name, ...PATTERNS[name] })),
      plans: [...plans.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20)
        .map((p) => ({ id: p.id, pattern: p.pattern, requestedPattern: p.requestedPattern, question: p.question.slice(0, 200),
          state: p.state, sites: p.sites, createdAt: p.createdAt, updatedAt: p.updatedAt })) }),
    cancel(id) {
      const plan = need(id);
      if (ACTIVE.has(plan.state)) {
        if (!ours(plan)) throw problem(409, 'This question is running in another VIVIM window. Stop it there.', 'ORCHESTRATE_OWNED_ELSEWHERE');
        plan.state = 'cancelled';
        for (const step of plan.steps) {
          if (done(step)) continue;
          if (step.attempted) finish(plan, step, 'stopped', 'CANCELLED', `Stopped waiting for ${step.label}. The question was already sent and may still finish in its tab; nothing will be repeated.`);
          else finish(plan, step, 'cancelled', 'CANCELLED', `Not asked — you stopped this question.`);
        }
        const answered = plan.steps.filter((s) => s.state === 'ready' && s.valid);
        plan.result = { ...choose(plan), summary: answered.length ? `Stopped. ${answered.map((s) => s.label).join(', ')} had already answered.` : 'Stopped. Nothing more will be sent.' };
        event(plan, plan.result.summary);
        persist(plan); notify(plan);
      }
      return { plan: view(plan) };
    },
    settled: (id) => running.get(id) ?? Promise.resolve(),
    // ---- internal agent-loop seam (documented for the later agent-loop lane) ----
    // createPlan(spec)                      -> { plan }   persist a plan from a spec; does NOT launch
    // launch(plan)                          -> void       start the run loop (picks up appended steps)
    // appendStep(plan, {site, role, template, after, when, agent}) -> step  append a step to a plan
    // planView(plan) / stepView(step)       -> display shape for HTTP/CLI
    createPlan,
    launch,
    appendStep,
    planView: view,
    stepView: stepView,
    // Studio shutdown (or a simulated crash in an offline check): stop driving without touching state,
    // so the next process resumes these plans observe-only for anything already sent.
    close() {
      closed = true; LIVE_OWNERS.delete(token);
      for (const plan of plans.values()) notify(plan);
    },
  };
}
