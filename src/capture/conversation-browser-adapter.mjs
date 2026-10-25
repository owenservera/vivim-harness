// Real browser seam; runtime tests inject an adapter instead. No network/body decoder here.
import { createHash } from 'node:crypto';
import { browserWsUrl, listTargets } from '../cdp/discovery.mjs';
import { CdpConnection } from '../cdp/client.mjs';
import { listSessions } from '../store/session.mjs';
import { Recorder } from './recorder.mjs';
import { evaluate, findComposer, focusComposer, typeText, sendMessage, sendState, readTranscript, waitForCompletion, detectAuthWall, detectSiteFailure } from './actions.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseThread, sameThread, transcriptExpression, turnObservationExpression, boundTranscript, TRANSCRIPT_LIMITS } from './conversation-thread.mjs';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const problem = (code) => Object.assign(new Error(code), { code, status: 409 });
const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const readTurnPage = (page, adapter) => evaluate(page, turnObservationExpression(adapter));

// Pre-send per-turn cursor: what already exists on the page (count, role split, ordered ids, content
// digest) and the prior stream cursor (raw-log sequence). Metadata only; never message bodies.
export function turnCursor(messages, streamSequence) {
  const list = Array.isArray(messages) ? messages : [];
  const count = (role) => list.filter((m) => m?.role === role).length;
  return { messageCount: list.length, userCount: count('user'), assistantCount: count('assistant'),
    // JSON tuples delimit each field unambiguously; ids may contain colons/newlines.
    // Null and missing ids remain distinct from an actual string "undefined".
    idsDigest: digest(JSON.stringify(list.map((m) => [m?.role ?? null, m?.id ?? null]))),
    contentDigest: digest(JSON.stringify(list.map((m) => [m?.role ?? null, m?.id ?? null, digest(String(m?.text ?? ''))]))),
    streamSequence };
}

// Specific user-authored nodes, not generic markdown/sidebar text. Keep duplicate text: two
// identical prompts are two turns. Require the entire old prefix unchanged before attributing one.
export async function readUserTurns(page) {
  return evaluate(page, `(() => {
    const sels = '[data-message-author-role="user"],[data-content-search-unit-key$="user"],[data-chatgpt-search-unit-key$="user"],[data-testid="user-message"]';
    const nodes = [...document.querySelectorAll(sels)].filter(el => {
      const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1;
    });
    return nodes.filter(el => !nodes.some(other => other !== el && other.contains(el)))
      .map(el => String(el.innerText ?? el.textContent ?? '').replace(/\\r\\n/g, '\\n'));
  })()`);
}

export function createConversationBrowserAdapter({ paths, profileStore, familyStore, port, siteAdapter, targetId,
  freshTab, conversationId, ownerToken, maxBytes = 0, dependencies = {} } = {}) {
  // replySettleMs/replySettlePolls: interactive-ready needs the SAME reply content observed across
  // a real quiet window with positively idle controls. Two fast identical samples are not enough:
  // a table/code block can render its header first, look idle between chunks, then add rows several
  // hundred ms later. This only lengthens OBSERVATION; it never sends, retries or grants acceptance.
  const d = { listTargets, listSessions, Recorder, CdpConnection, browserWsUrl, fetch: globalThis.fetch, evaluate, findComposer, focusComposer,
    typeText, sendMessage, sendState, readTranscript, waitForCompletion, readUserTurns, detectAuthWall, detectSiteFailure,
    readTurnPage, sleep, now: () => Date.now(), replyPollMs: 250, replyTimeoutMs: 120000, replySettleMs: 2000, replySettlePolls: 2,
    readinessTimeoutMs: 20000, readinessPollMs: 200, checkAgainTimeoutMs: 3000, fetchTimeoutMs: 10000, connectGraceMs: 2000, ...dependencies };
  let recorder, binding, pending, stopResult, tap, idlePage, idleConn, connectHooks;
  const attempts = new Map();
  let mayOwnResources = false;
  let submissionStopped = false, connectAborted = false, finalized = false, createdTargetId = null, tabRequested = false;
  const waiting = new AbortController();
  // Hard bound for a step that may never settle (a fake or a wedged CDP/HTTP call). The timer is a
  // real timer on purpose: the race, not the callee's cooperation, guarantees the caller proceeds.
  function bounded(run, ms, code) {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(problem(code)); }, ms); });
    return Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout]).finally(() => clearTimeout(timer));
  }
  const httpFetch = (url, init) => bounded((signal) => d.fetch(url, { ...init, signal }), d.fetchTimeoutMs, 'BROWSER_HTTP_TIMEOUT');
  async function closeCreatedTab(targetId) {
    const response = await httpFetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`);
    if (!response.ok) throw problem('TAB_CLOSE_UNCONFIRMED');
  }
  // A bound thread must match from both sources: the DevTools target URL and the page's own location.
  const threadMatches = (url) => !binding.thread || sameThread(parseThread(siteAdapter.id, url), binding.thread);
  const livePage = () => recorder?.page ?? idlePage;
  async function pageThreadMatches() {
    if (!binding.thread) return true;
    return threadMatches(`${binding.origin}${await d.evaluate(livePage(), 'location.pathname')}`);
  }
  // Idle connect attaches a page for exact-target checks only. Network.enable, the DOM
  // MutationObserver and the capture clocks stay off until armCapture() on an explicit send.
  async function openIdlePage(targetId) {
    if (idlePage) return idlePage;
    if (typeof d.attachIdlePage === 'function') { idlePage = await d.attachIdlePage(targetId); return idlePage; }
    if (d.evaluate !== evaluate || d.findComposer !== findComposer) {
      idlePage = { send: async (method, params) => { d.tracePage?.(method, params); return {}; } };
      return idlePage;
    }
    if (d.CdpConnection && d.browserWsUrl) {
      const ws = await d.browserWsUrl({ port });
      idleConn = await d.CdpConnection.connect(ws, { requestTimeoutMs: 30_000 });
      idlePage = await idleConn.attach(targetId);
      return idlePage;
    }
    idlePage = { send: async (method, params) => d.tracePage?.(method, params) ?? {} };
    return idlePage;
  }
  async function creationLocation() {
    const page = livePage();
    const target = (await d.listTargets({ port })).find((t) => t.id === binding.targetId);
    if (!target) throw problem('TARGET_DISAPPEARED');
    let parsed; try { parsed = new URL(target.url); } catch { throw problem('BINDING_CHANGED'); }
    if (parsed.origin !== binding.origin) throw problem('BINDING_CHANGED');
    const pathname = String(await d.evaluate(page, 'location.pathname') ?? '');
    if (await d.evaluate(page, 'location.origin') !== binding.origin) throw problem('BINDING_CHANGED');
    return { targetThread: parseThread(siteAdapter.id, target.url), pageThread: parseThread(siteAdapter.id, `${binding.origin}${pathname}`), targetPath: parsed.pathname, pathname };
  }
  function requireRecording() {
    if (!recorder?.page || recorder.state !== 'recording') throw problem('CAPTURE_NOT_ACTIVE');
  }
  async function readiness(end) {
    const blocked = (reason, draft = { present: null, chars: null }) => ({ ready: false, reason, draft });
    do {
      const target = (await d.listTargets({ port })).find((t) => t.id === binding.targetId);
      if (!target) return blocked('TARGET_DISAPPEARED');
      let actual; try { actual = new URL(target.url).origin; } catch { return blocked('BINDING_CHANGED'); }
      if (actual !== binding.origin) {
        if (!(freshTab && target.url === 'about:blank')) return blocked('BINDING_CHANGED');
      } else {
        const pageOrigin = await d.evaluate(livePage(), 'location.origin');
        if (pageOrigin !== binding.origin) {
          if (!(freshTab && pageOrigin === 'null')) return blocked('BINDING_CHANGED');
        } else if (!threadMatches(target.url) || !(await pageThreadMatches())) {
          return blocked('BINDING_CHANGED');
        } else if (freshTab && !binding.thread) {
          const loc = await creationLocation();
          if (loc.targetThread || loc.pageThread) return blocked('PREEXISTING_THREAD');
          if (loc.targetPath !== loc.pathname) return blocked('BINDING_CHANGED');
          const composer = await d.findComposer(livePage(), siteAdapter);
          const auth = await d.detectAuthWall(livePage(), siteAdapter);
          if (auth.blocked) return blocked('AUTH_WALL');
          const gate = await d.detectSiteFailure(livePage(), siteAdapter);
          if (gate.failed) return blocked('SITE_GATE');
          if (composer.found) {
            const state = await d.sendState(livePage(), siteAdapter);
            const page = await d.readTurnPage(livePage(), siteAdapter);
            if (!state.evalOk) { /* keep polling */ }
            else if (parseThread(siteAdapter.id, `${binding.origin}${page?.pathname ?? ''}`)) return blocked('PREEXISTING_THREAD');
            else if (state.draftChars > 0 || page?.draft?.chars > 0) return blocked('DRAFT_PRESENT', { present: true, chars: state.draftChars });
            else if (idleControls(page?.controls)) return { ready: true, draft: { present: false, chars: 0 }, reason: null, creation: { threadless: true } };
          }
        } else {
          const composer = await d.findComposer(livePage(), siteAdapter);
          const auth = await d.detectAuthWall(livePage(), siteAdapter);
          if (auth.blocked) return blocked('AUTH_WALL');
          const gate = await d.detectSiteFailure(livePage(), siteAdapter);
          if (gate.failed) return blocked('SITE_GATE');
          if (composer.found) {
            const state = await d.sendState(livePage(), siteAdapter);
            if (state.evalOk) {
              const draft = { present: state.draftChars > 0, chars: state.draftChars };
              return draft.present ? blocked('DRAFT_PRESENT', draft) : { ready: true, draft, reason: null };
            }
          }
        }
      }
      if (Date.now() >= end) break;
      await d.sleep(d.readinessPollMs);
    } while (Date.now() <= end);
    return blocked('READINESS_TIMEOUT');
  }
  async function check() {
    if (!livePage()) throw problem('CAPTURE_NOT_ACTIVE');
    const targets = await d.listTargets({ port });
    const target = targets.find((t) => t.id === binding.targetId);
    if (!target || new URL(target.url).origin !== binding.origin || !threadMatches(target.url)) throw problem('BINDING_CHANGED');
    if (await d.evaluate(livePage(), 'location.origin') !== binding.origin) throw problem('BINDING_CHANGED');
    if (!(await pageThreadMatches())) throw problem('BINDING_CHANGED');
    return { ...binding };
  }
  async function pageState() {
    await check();
    requireRecording();
    const page = await d.readTurnPage(recorder.page, siteAdapter);
    await check();
    if (!page || page.origin !== binding.origin || !threadMatches(`${page.origin}${page.pathname}`) || !Array.isArray(page.messages)) throw problem('BINDING_CHANGED');
    if (page.messages.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string'
      || typeof m.id !== 'string' || !m.id || m.id.length > 200) || new Set(page.messages.map((m) => m.id)).size !== page.messages.length) throw problem('MESSAGE_IDENTITY_UNAVAILABLE');
    return page;
  }
  const idleControls = (c) => c?.observed === true && ['idle', 'terminal'].includes(c.state)
    && c.idleControlPresent === true && c.stopPresent === false && c.composerEnabled === true;
  const samePrefix = (page, saved) => saved.baseline.every((m, i) => page.messages[i]?.id === m.id
    && page.messages[i]?.role === m.role && page.messages[i]?.text === m.text);
  const persist = (record) => recorder.recordConversationObservation({ ...record, binding: structuredClone(binding) });
  async function observation(args) {
    const page = await pageState(), saved = attempts.get(args.turnId);
    if (!saved || saved.payloadDigest !== args.payloadDigest || !samePrefix(page, saved)) return null;
    const user = page.messages[saved.baseline.length];
    if (!user || user.role !== 'user' || saved.baseline.some((m) => m.id === user.id) || user.text !== saved.prompt.replace(/\r\n/g, '\n')
      || page.messages.slice(saved.baseline.length + 1).some((m) => m.role === 'user')) return null;
    if (saved.outgoing) return { binding: structuredClone(binding), evidence: saved.outgoing };
    const sequence = persist({ source: 'page', kind: 'new-user-turn', identity: user.id, turnId: saved.turnId,
      payloadDigest: saved.payloadDigest, text: user.text, baselineSequence: saved.boundary.sequence });
    saved.outgoing = { turnId: saved.turnId, payloadDigest: saved.payloadDigest, sessionId: recorder.session.id,
      sequence, kind: 'new-user-turn', source: 'page', identity: user.id };
    return { binding: structuredClone(binding), evidence: saved.outgoing };
  }
  function sampleReply(saved, message, controls) {
    const contentDigest = digest(message.text), prior = saved.reply;
    if (prior && prior.identity !== message.id) throw problem('REPLY_IDENTITY_CHANGED');
    const revision = prior ? prior.revision + (prior.contentDigest !== contentDigest ? 1 : 0) : 1;
    const metadata = { identity: message.id, revision, contentDigest, chars: message.text.length };
    const sequence = persist({ source: 'page', kind: 'reply-sample', turnId: saved.turnId, payloadDigest: saved.payloadDigest,
      ...metadata, text: message.text, controls });
    const evidence = { turnId: saved.turnId, payloadDigest: saved.payloadDigest, sessionId: recorder.session.id,
      sequence, kind: 'assistant-reply', source: 'page', ...metadata };
    if (!prior || prior.contentDigest !== contentDigest) saved.samples = [];
    saved.reply = { ...evidence, text: message.text };
    saved.samples.push({ sequence, ...metadata }); saved.samples = saved.samples.slice(-2);
    return { turnId: saved.turnId, binding: structuredClone(binding), state: 'streaming', text: message.text, evidence };
  }
  function auditReplies(page) {
    const updates = [];
    for (const saved of attempts.values()) {
      if (!saved.reply || saved.reply.sessionId !== recorder?.session?.id) continue;
      const message = page.messages.find((m) => m.id === saved.reply.identity && m.role === 'assistant');
      if (!message) throw problem('PRIOR_REPLY_UNAVAILABLE');
      if (digest(message.text) !== saved.reply.contentDigest) updates.push(sampleReply(saved, message, page.controls));
    }
    return updates;
  }
  async function effectPreflight(saved, beforeEffect, empty) {
    if (!binding.thread) throw problem('THREAD_IDENTITY_UNVERIFIED');
    const page = await pageState(), priorReplies = auditReplies(page);
    if (priorReplies.length) throw Object.assign(problem('PRIOR_REPLY_CHANGED'), { priorReplies });
    if (!idleControls(page.controls)) throw problem('GENERATION_CONTROLS_UNAVAILABLE_OR_BUSY');
    // An empty rich-text (ProseMirror) composer reports a lone trailing line break, not ''.
    const trailing = (t) => String(t).replace(/\r\n/g, '\n').replace(/\n$/, '');
    if (typeof page.draft?.text !== 'string' || trailing(page.draft.text) !== (empty ? '' : trailing(saved.prompt))) throw problem('COMPOSER_READBACK_MISMATCH');
    if (!empty && !samePrefix(page, saved)) throw problem('TURN_BOUNDARY_CHANGED');
    if (submissionStopped) throw problem('SUBMISSION_STOPPED');
    beforeEffect?.(page); // Fresh persisted thread+reply fence check is LAST, after asynchronous page inspection.
  }
  async function connectSteps(initial, hooks, startedAt) {
    const aborted = () => { if (connectAborted) throw problem('CONNECT_ABORTED'); };
    binding = { ...initial };
    if (freshTab) {
      mayOwnResources = true; tabRequested = true; // An acknowledgement can be lost even if Chrome created the tab.
      const response = await httpFetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      if (!response.ok) throw problem('TAB_OPEN_FAILED');
      const target = await bounded(() => response.json(), d.fetchTimeoutMs, 'BROWSER_HTTP_TIMEOUT');
      if (!target.id) throw problem('TAB_OPEN_UNCONFIRMED');
      createdTargetId = target.id;
      if (connectAborted) { await closeCreatedTab(target.id).catch(() => {}); aborted(); }
      binding.targetId = target.id; hooks.bind(binding);
    } else {
      const target = (await d.listTargets({ port })).find((t) => t.id === targetId);
      aborted();
      if (!target || new URL(target.url).origin !== binding.origin || !threadMatches(target.url)) throw problem('BINDING_CHANGED');
      // Never replace/stop an unknown recorder, including an interrupted recorder with no proof
      // of finalization. Only the selected exact target is guarded; unrelated captures continue.
      if (d.listSessions(paths.sessions).some((s) => s.target?.id === targetId && ['recording', 'stopping'].includes(s.status))) throw problem('TARGET_RECORDER_BUSY');
    }
    let profile = siteAdapter.id;
    try { profileStore.load(profile); } catch { profile = 'generic'; profileStore.load(profile); }
    connectHooks = hooks;
    captureProfile = profile;
    mayOwnResources = freshTab; // A Studio tab may need closing. The recorder is not armed yet.
    await openIdlePage(binding.targetId);
    if (connectAborted) { if (freshTab && createdTargetId) await closeCreatedTab(createdTargetId).catch(() => {}); aborted(); }
    if (freshTab) {
      await livePage().send('Page.navigate', { url: siteAdapter.url });
      // Navigation/composer readiness is checked on submit, not guessed from a navigate ACK.
    }
    aborted();
    const ready = await readiness(startedAt + d.readinessTimeoutMs);
    aborted();
    return { binding: { ...binding }, sessionId: null, deferredCapture: true, readiness: ready };
  }
  let captureProfile = siteAdapter.id;
  async function armCapture() {
    if (recorder?.state === 'recording' && recorder.session?.id) return recorder.session.id;
    if (finalized) throw problem('CAPTURE_NOT_ACTIVE');
    mayOwnResources = true;
    recorder = new d.Recorder({ sessionsDir: paths.sessions, profileStore, familyStore, port, tabs: 'one', follow: false,
      reconnect: false, maxSessionBytes: maxBytes });
    recorder.on('warn', () => {}); // Never leak transport/URL/content errors into shared summaries.
    const mine = recorder;
    const run = recorder.start({ target: binding.targetId, exactTarget: true, profile: captureProfile, label: siteAdapter.id, follow: false,
      owner: { conversationId, pid: process.pid, token: ownerToken, port },
      onSessionCreated: (session) => connectHooks.ownSession(session.id) });
    run.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(problem('CONNECT_TIMEOUT')), d.readinessTimeoutMs + d.connectGraceMs); });
    try { await Promise.race([run, timeout]); }
    finally { clearTimeout(timer); }
    tap = mine.tap({ decode: false, text: false }); // Full turn capture: network bodies, DOM observer, raw log. Not a second driver.
    return recorder.session.id;
  }
  // Shared by finish (stop) and failed-connect cleanup. Idempotent once finalized.
  async function stopRecorder(reason) {
    if (!recorder?.session) return null;
    if (recorder.state === 'idle' && stopResult) return stopResult;
    if (['recording', 'stopping', 'stop_failed'].includes(recorder.state) || recorder._stopPromise) {
      stopResult = await recorder.stop({ reason });
      if (!stopResult) throw problem('CAPTURE_STOP_UNCONFIRMED');
    } else {
      clearInterval(recorder.persistTimer); clearInterval(recorder.statusTimer);
      recorder.conn?.close(); await recorder.session.raw.close();
      recorder.session.meta.status = 'incomplete'; recorder.session.meta.endReason = 'conversation_attachment_failed'; recorder.session.saveMeta();
      stopResult = { verify: null };
    }
    tap?.close(); tap = null;
    return stopResult;
  }
  async function stopCapture() {
    if (finalized) return;
    waiting.abort();
    if (!recorder?.session) { finalized = true; return; }
    await stopRecorder('conversation_finish');
    mayOwnResources = false; finalized = true;
  }
  async function stopTurnCapture() {
    if (!recorder?.session) return stopResult ?? null;
    const stopped = await stopRecorder('conversation_turn');
    recorder = null; // Next explicit send arms a new full capture. pause() is not the off switch.
    return stopped;
  }
  return {
    get mayOwnResources() { return mayOwnResources; },
    get sessionId() { return recorder?.session?.id ?? null; },
    get integrity() { return stopResult?.verify ?? null; },
    get active() { return recorder?.state === 'recording' || recorder?.state === 'stopping'; },
    get limitReason() { return recorder?._quotaHit ? 'byte-budget' : null; },
    get bytesWritten() { return recorder?.session?.raw?.stats?.bytes ?? 0; },
    // Total connect time is bounded by readinessTimeoutMs + a small grace. A hung step fails closed
    // with CONNECT_TIMEOUT; whatever it creates late is cleaned up by the continuation itself.
    async connect(initial, hooks) {
      connectAborted = false;
      const startedAt = Date.now(), run = connectSteps(initial, hooks, startedAt); let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { connectAborted = true; reject(problem('CONNECT_TIMEOUT')); }, d.readinessTimeoutMs + d.connectGraceMs); });
      run.catch(() => {});
      try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
    },
    armCapture,
    async stopTurnCapture() { return stopTurnCapture(); },
    async pinThread(thread, denylist = []) {
      if (!thread?.ref || !Array.isArray(denylist) || denylist.includes(thread.ref)) return null;
      const loc = await creationLocation();
      if (!loc.targetThread || !loc.pageThread || loc.targetThread.ref !== loc.pageThread.ref || loc.targetThread.ref !== thread.ref) return null;
      binding.thread = { kind: 'chatgpt-c', id: loc.targetThread.id, ref: loc.targetThread.ref };
      return structuredClone(binding);
    },
    adoptTurn(fromId, toId) {
      const saved = attempts.get(fromId);
      if (!saved || attempts.has(toId)) throw problem('TURN_NOT_FOUND');
      saved.turnId = toId; attempts.delete(fromId); attempts.set(toId, saved);
      recorder?.session?.kv?.set?.(`CONVERSATION_ATTEMPT_${toId}`, saved);
    },
    // The pre-send freshness cursor for acceptance G1/G2: user/assistant turn counts from the
    // SAME page-agent full-DOM scan that later produces DOM_TURNS, sampled before anything is
    // typed. Unmeasurable (agent down, page gone) is reported as null, never guessed as 0.
    async sampleTurnBaseline() {
      try {
        const turns = await recorder.domTurns();
        const count = (role) => turns.filter((t) => t?.role === role).length;
        return { userTurns: count('user'), assistantTurns: count('assistant'), sampledAt: new Date().toISOString() };
      } catch { return null; }
    },
    async preflight(_, { priorTurns = [], readOnly = false } = {}) {
      // Read-only "Check again" with no armed capture (deferred first turn, or between turns): inspect the
      // idle page only. No recorder is armed, nothing is typed or sent, and no turn baseline is taken.
      if (readOnly && !recorder?.page) {
        if (!livePage()) throw problem('CAPTURE_NOT_ACTIVE');
        const result = await readiness(Date.now() + d.checkAgainTimeoutMs);
        return { binding: { ...binding }, ready: result.ready, reason: result.reason, draft: result.draft,
          boundary: { sequence: 0, transcriptCount: 0 }, readOnly: true, ...(result.creation ? { creation: result.creation } : {}) };
      }
      await check();
      if (!binding.thread) {
        if (!freshTab) throw problem('THREAD_IDENTITY_UNVERIFIED');
        requireRecording();
        const loc = await creationLocation();
        if (loc.targetThread || loc.pageThread) throw Object.assign(problem('PREEXISTING_THREAD'), { notDispatched: true, notTyped: true });
        if (loc.targetPath !== loc.pathname) throw problem('BINDING_CHANGED');
        const composer = await d.findComposer(recorder.page, siteAdapter);
        if ((await d.detectAuthWall(recorder.page, siteAdapter)).blocked) throw problem('AUTH_WALL');
        if ((await d.detectSiteFailure(recorder.page, siteAdapter)).failed) throw problem('SITE_GATE');
        if (!composer.found) throw problem('COMPOSER_UNAVAILABLE');
        const state = await d.sendState(recorder.page, siteAdapter);
        if (!state.evalOk) throw problem('COMPOSER_UNREADABLE');
        const page = await d.readTurnPage(recorder.page, siteAdapter);
        if (parseThread(siteAdapter.id, `${binding.origin}${page?.pathname ?? ''}`)) throw Object.assign(problem('PREEXISTING_THREAD'), { notDispatched: true, notTyped: true });
        if (!idleControls(page?.controls)) throw problem('GENERATION_CONTROLS_UNAVAILABLE_OR_BUSY');
        if (state.draftChars !== 0 || page?.draft?.chars !== 0) throw problem('DRAFT_PRESENT');
        const boundary = { sessionId: recorder.session.id, sequence: recorder.session.raw.seq, transcriptCount: 0 };
        pending = { baseline: [], boundary, creation: true };
        // A just-created page has no rendered turns; the scan is still taken from the same store
        // so the cursor semantics match every other path.
        return { binding: { ...binding }, draft: { present: false, chars: 0 }, boundary, controls: page.controls, priorReplies: [], ready: true, creation: { threadless: true },
          baseline: { userTurns: 0, assistantTurns: 0, sampledAt: new Date().toISOString() }, cursor: turnCursor([], boundary.sequence) };
      }
      requireRecording();
      const composer = await d.findComposer(recorder.page, siteAdapter);
      if ((await d.detectAuthWall(recorder.page, siteAdapter)).blocked) throw problem('AUTH_WALL');
      if ((await d.detectSiteFailure(recorder.page, siteAdapter)).failed) throw problem('SITE_GATE');
      if (!composer.found) throw problem('COMPOSER_UNAVAILABLE');
      const state = await d.sendState(recorder.page, siteAdapter);
      if (!state.evalOk) throw problem('COMPOSER_UNREADABLE');
      const page = await pageState(), priorReplies = auditReplies(page);
      const invalidatedTurnIds = priorTurns.filter((t) => t.reply.state === 'observed' && (!attempts.has(t.id) || attempts.get(t.id)?.reply?.sessionId !== recorder.session.id)).filter((t) => {
        const r = t.reply.evidence, message = page.messages.find((m) => m.id === r.identity && m.role === 'assistant');
        return !message || digest(message.text) !== r.contentDigest || message.text.length !== r.chars;
      }).map((t) => t.id);
      if (invalidatedTurnIds.length) {
        persist({ source: 'page', kind: 'prior-reply-invalidated', turnIds: invalidatedTurnIds });
        throw Object.assign(problem('PRIOR_REPLY_CHANGED'), { invalidatedTurnIds });
      }
      // Every earlier turn this thread delivered by a page-visible user message must still be on the page:
      // an edited/branched/regenerated history is a different thread state, so this turn is blocked pre-effect.
      const missing = priorTurns.filter((t) => t.delivery?.state === 'observed' && t.delivery.evidence?.kind === 'new-user-turn'
        && !page.messages.some((m) => m.id === t.delivery.evidence.identity && m.role === 'user')).map((t) => t.id);
      if (missing.length) {
        persist({ source: 'page', kind: 'prior-turn-missing', turnIds: missing });
        throw problem('THREAD_CHANGED_BETWEEN_TURNS');
      }
      const boundary = { sessionId: recorder.session.id, sequence: recorder.session.raw.seq, transcriptCount: page.messages.length };
      pending = { baseline: structuredClone(page.messages), boundary };
      return { binding: { ...binding }, draft: { present: page.draft?.chars > 0, chars: page.draft?.chars }, boundary,
        controls: page.controls, priorReplies, ready: idleControls(page.controls) && !priorReplies.length,
        baseline: await this.sampleTurnBaseline(), cursor: turnCursor(page.messages, boundary.sequence) };
    },
    async type({ prompt, turnId, beforeEffect }) {
      await check();
      requireRecording();
      if (!binding.thread) {
        if (!freshTab || !pending?.creation) throw problem('THREAD_IDENTITY_UNVERIFIED');
        const guard = async () => {
          const loc = await creationLocation();
          if (loc.targetThread || loc.pageThread) throw Object.assign(problem('PREEXISTING_THREAD'), { notDispatched: true, notTyped: true });
        };
        await guard();
        await recorder.page.send('Page.bringToFront', {});
        const focus = await d.focusComposer(recorder.page, siteAdapter);
        if (!focus.ok) throw problem('COMPOSER_NOT_FOCUSED');
        const state = await d.sendState(recorder.page, siteAdapter);
        if (!state.evalOk || state.draftChars !== 0) throw problem('DRAFT_PRESENT');
        const saved = { ...pending, turnId, prompt, payloadDigest: digest(prompt), samples: [], creation: true };
        attempts.set(turnId, saved);
        recorder.session.kv.set(`CONVERSATION_ATTEMPT_${turnId}`, saved);
        const typed = await d.typeText(recorder.page, prompt, { human: false, beforeInsert: async () => { await guard(); beforeEffect?.(); } });
        await check();
        const after = await d.readTurnPage(recorder.page, siteAdapter);
        if (parseThread(siteAdapter.id, `${binding.origin}${after?.pathname ?? ''}`)) throw problem('PREEXISTING_THREAD');
        if (!typed.ok || typed.typed?.replace(/\r\n/g, '\n') !== prompt.replace(/\r\n/g, '\n')
          || after?.draft?.text !== prompt.replace(/\r\n/g, '\n')) throw problem('TYPING_UNCONFIRMED');
        return;
      }
      if (!pending) throw problem('THREAD_IDENTITY_UNVERIFIED');
      await recorder.page.send('Page.bringToFront', {}); // Exact bound target only.
      const focus = await d.focusComposer(recorder.page, siteAdapter);
      if (!focus.ok) throw problem('COMPOSER_NOT_FOCUSED');
      const state = await d.sendState(recorder.page, siteAdapter);
      if (!state.evalOk || state.draftChars !== 0) throw problem('DRAFT_PRESENT');
      const saved = { ...pending, turnId, prompt, payloadDigest: digest(prompt), samples: [] };
      attempts.set(turnId, saved);
      recorder.session.kv.set(`CONVERSATION_ATTEMPT_${turnId}`, saved); // Protected local capture storage only.
      const typed = await d.typeText(recorder.page, prompt, { human: false,
        beforeInsert: () => effectPreflight(saved, beforeEffect, true) });
      await check();
      const after = await pageState();
      if (!typed.ok || typed.typed?.replace(/\r\n/g, '\n') !== prompt.replace(/\r\n/g, '\n')
        || after.draft?.text !== prompt.replace(/\r\n/g, '\n')) throw problem('TYPING_UNCONFIRMED');
    },
    async submit(args) {
      await check();
      requireRecording();
      const saved = attempts.get(args.turnId);
      if (!saved || saved.payloadDigest !== args.payloadDigest) throw problem('TURN_NOT_FOUND');
      if (submissionStopped) throw Object.assign(problem('SUBMISSION_STOPPED'), { notDispatched: true });
      if (!binding.thread && saved.creation) {
        const guard = async () => {
          const loc = await creationLocation();
          if (loc.targetThread || loc.pageThread) throw Object.assign(problem('PREEXISTING_THREAD'), { notDispatched: true });
        };
        const result = await d.sendMessage(recorder.page, siteAdapter, { canDispatch: () => !submissionStopped,
          beforeDispatch: async () => { await guard(); args.beforeEffect?.(); } });
        if (result?.dispatched === false) {
          if (submissionStopped) throw Object.assign(problem('SUBMISSION_STOPPED'), { notDispatched: true });
          if (result.sendStatus === 'not-attempted' && result.uncertain === false) throw Object.assign(problem('SEND_NOT_DISPATCHED'), { notDispatched: true });
        }
        // The CDP target URL and the page's own location move to /c/<id> at slightly different
        // moments after the provider navigates. Read-only bounded wait for them to agree.
        let loc = await creationLocation();
        for (const deadline = Date.now() + 12000;
          !(loc.targetThread && loc.pageThread && loc.targetThread.ref === loc.pageThread.ref) && Date.now() < deadline;) {
          await d.sleep(250); loc = await creationLocation();
        }
        return { creation: true, dispatched: true, targetThread: loc.targetThread, pageThread: loc.pageThread, binding: structuredClone(binding) };
      }
      const result = await d.sendMessage(recorder.page, siteAdapter, { canDispatch: () => !submissionStopped,
        beforeDispatch: () => effectPreflight(saved, args.beforeEffect, false) });
      if (result?.dispatched === false) {
        if (submissionStopped) throw Object.assign(problem('SUBMISSION_STOPPED'), { notDispatched: true });
        // Proven not dispatched = sendMessage's own preflight/button/latch refusal. Anything else
        // (dispatched undefined/true, dispatch errors, missing fields) stays ambiguous -> observation.
        if (result.sendStatus === 'not-attempted' && result.uncertain === false) throw Object.assign(problem('SEND_NOT_DISPATCHED'), { notDispatched: true });
      }
      return observation(args);
    },
    reconcile: observation,
    async readReply(onUpdate, args = {}) {
      const saved = attempts.get(args.turnId);
      if (!saved?.outgoing || saved.payloadDigest !== args.payloadDigest) throw problem('ATTRIBUTABLE_DELIVERY_REQUIRED');
      const end = Date.now() + d.replyTimeoutMs;
      // Interactive-ready requires content stability over wall-clock time, not merely two adjacent
      // polls: a late table body or code block must not be cut off by an early idle control.
      saved.stable = null;
      while (!waiting.signal.aborted && Date.now() < end) {
        const page = await pageState(), index = page.messages.findIndex((m) => m.id === saved.outgoing.identity && m.role === 'user');
        // The turn's own user message must sit directly after the pre-send baseline, and everything before it must be
        // unchanged: an earlier reply regenerated/edited, or history rewritten, mid-wait is never attributed to this turn.
        if (!samePrefix(page, saved) || (index >= 0 && index !== saved.baseline.length)) throw problem('TURN_BOUNDARY_CHANGED');
        const candidate = index < 0 ? null : page.messages[index + 1];
        if (candidate?.role === 'assistant' && !saved.baseline.some((m) => m.id === candidate.id)) {
          const update = sampleReply(saved, candidate, page.controls);
          const stamp = d.now(), contentDigest = update.evidence.contentDigest;
          const idle = idleControls(page.controls);
          if (!idle) saved.stable = null;
          else if (saved.stable?.digest !== contentDigest) saved.stable = { digest: contentDigest, since: stamp, polls: 1 };
          else saved.stable.polls++;
          const quietFor = saved.stable ? stamp - saved.stable.since : 0;
          const settled = saved.samples.length >= 2 && saved.stable?.polls >= d.replySettlePolls
            && quietFor >= d.replySettleMs;
          if (settled && idle && candidate.text.length > 0) {
            update.state = 'ready';
            update.readiness = { ...update.evidence, kind: 'interactive-ready', source: 'adapter', rule: 'chatgpt-controls-idle', ruleVersion: 1,
              threadKey: args.threadKey, boundarySequence: saved.boundary.sequence, samples: structuredClone(saved.samples), controls: page.controls };
          }
          await onUpdate?.(update);
          if (update.state === 'ready') return update;
        } else saved.stable = null;
        await d.sleep(d.replyPollMs);
      }
      return { turnId: saved.turnId, state: waiting.signal.aborted ? 'interrupted' : 'unknown', text: saved.reply?.text ?? '' };
    },
    // Zero-send Read of the currently rendered transcript. Observation only: no focus, scroll, typing,
    // draft change, navigation, send or raw-log write. The binding is verified before and after, and the
    // page's own location is part of the evaluated result, so a thread switch mid-read discards it.
    async readTranscript({ maxMessages = TRANSCRIPT_LIMITS.maxMessages.default, maxChars = TRANSCRIPT_LIMITS.maxChars.default, perMessageCap = TRANSCRIPT_LIMITS.perMessageCap } = {}) {
      await check();
      const result = await d.evaluate(livePage(), transcriptExpression({ composerSelectors: siteAdapter.composer?.selectors ?? [], perMessageCap: Math.min(perMessageCap, maxChars) }));
      const after = await check();
      if (!result || typeof result !== 'object' || !Array.isArray(result.messages)) throw problem('READ_FAILED');
      if (binding.thread && !threadMatches(`${binding.origin}${String(result?.pathname ?? '')}`)) throw problem('BINDING_CHANGED');
      if (result?.origin !== undefined && result.origin !== binding.origin) throw problem('BINDING_CHANGED');
      return { binding: after, transcript: boundTranscript(result, { maxMessages, maxChars, perMessageCap: Math.min(perMessageCap, maxChars) }) };
    },
    stopWaiting() { submissionStopped = true; waiting.abort(); },
    async stop() { await stopCapture(); },
    // Failed-connect cleanup: finalize any half-created session as incomplete, then close ONLY the
    // tab this Studio created (freshTab + exact id reported by Chrome). An owner/selected tab is never touched.
    async abortConnect() {
      connectAborted = true; submissionStopped = true;
      const out = { captureFinalized: true, tab: 'none', targetId: createdTargetId };
      if (recorder?.session) { try { await stopCapture(); } catch { out.captureFinalized = false; } }
      else mayOwnResources = false; // No session was ever created: no capture-side resource to finalize.
      if (freshTab) {
        if (!createdTargetId) out.tab = tabRequested ? 'unconfirmed' : 'none';
        else { try { await closeCreatedTab(createdTargetId); out.tab = 'closed'; } catch { out.tab = 'kept'; } }
      }
      return out;
    },
    async closeTab(b) {
      if (!b.ownedByStudio || b.targetId !== binding.targetId || b.origin !== binding.origin) throw problem('TAB_NOT_OWNED');
      await closeCreatedTab(b.targetId);
    },  };
}
