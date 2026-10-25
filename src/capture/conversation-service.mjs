/**
 * Lifecycle foundation. Browser implementation and cross-process lease are runtime responsibilities.
 * One service instance owns one conversation; callers MUST NOT open the same snapshot twice.
 * A shared browser/CLI lease is required before live use. Cancellation is deliberately deferred.
 *
 * Injected adapter contract (all async; no retries, fallback sends or implicit navigation):
 * connect(binding) -> { binding, sessionId }; attaches/arms capture on that exact target only.
 * preflight(binding) -> { binding, draft:{present,chars}, boundary:{sequence,transcriptCount}, baseline?:{userTurns,assistantTurns,sampledAt} };
 *   read-only, current composer/binding check immediately before type; never clears a draft.
 * type({binding,turnId,prompt}) -> void; types once, never submits or clears existing content.
 * submit({binding,turnId,payloadDigest}) -> observation|null; ONE send action, never types.
 * reconcile({binding,turnId,payloadDigest,boundary}) -> observation|null; strictly read-only.
 * stop({binding,sessionId}) -> void; resolves only after capture stop/flush succeeds.
 * closeTab(binding) -> void; closes precisely the Studio-owned bound target.
 *
 * Observation: { binding, evidence:{turnId,payloadDigest,sessionId,sequence,kind,source} }.
 * kind='outgoing-request'/'new-user-turn'; source='network'/'page' respectively. Evidence must
 * be attributable to THIS attempt, with sequence > persisted pre-typing boundary; timestamps,
 * old DOM, user assertions and arbitrary response-stream text are not submission evidence.
 * The adapter is a trusted evidence boundary, not a user-supplied observation API. A real adapter
 * must prove this correlation from durable capture records, not manufacture it from timing.
 * The attempt journal has no prompt/reply bodies; recordReply stores protected local reply data.
 * This is not reply assembly or acceptance. Runtime list/history must strip reply bodies.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sameThread, validThread, validIdentity } from './conversation-thread.mjs';
import { createThreadTurnJournal } from './thread-turn-journal.mjs';

const now = () => new Date().toISOString();
const error = (code) => Object.assign(new Error(code), { code });
// A bound thread is part of the binding: same target and origin on another thread is NOT the same binding.
const exactBinding = (a, b) => a?.targetId === b?.targetId && a?.origin === b?.origin && sameThread(a?.thread, b?.thread);
const phases = ['preparing', 'dispatching', 'observed', 'uncertain', 'needs-reconciliation', 'blocked'];
// Pre-send acceptance-freshness cursor supplied by the adapter preflight (acceptance G1/G2).
// Persisted verbatim per attempt; malformed shapes persist as null so evaluation stays honest.
const validBaseline = (b) => !!b && typeof b === 'object'
  && Number.isSafeInteger(b.userTurns) && b.userTurns >= 0
  && Number.isSafeInteger(b.assistantTurns) && b.assistantTurns >= 0;
const baselineOf = (b) => validBaseline(b)
  ? { userTurns: b.userTurns, assistantTurns: b.assistantTurns, ...(typeof b.sampledAt === 'string' ? { sampledAt: b.sampledAt } : {}) }
  : null;

// Pre-send per-turn cursor from the adapter preflight (count/role split/ordered-id digest/content digest of what
// already exists on the page, plus the prior stream cursor). Metadata only. Malformed or absent persists as null.
const hex64 = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const cursorOf = (c) => !!c && typeof c === 'object' && count(c.messageCount) && count(c.userCount) && count(c.assistantCount)
  && c.userCount + c.assistantCount <= c.messageCount && hex64(c.idsDigest) && hex64(c.contentDigest) && count(c.streamSequence)
  ? { messageCount: c.messageCount, userCount: c.userCount, assistantCount: c.assistantCount, idsDigest: c.idsDigest, contentDigest: c.contentDigest, streamSequence: c.streamSequence }
  : null;
// A delivered turn adds its user message; a recorded reply adds its assistant message. The next turn's page can never
// hold fewer messages than that, or history was removed/rewritten between turns.
const expectedFloor = (a) => a.cursor ? a.cursor.messageCount + (a.send?.state === 'observed' ? 1 : 0) + (a.reply?.state === 'ready' ? 1 : 0) : 0;

function validSnapshot(s, id) {
  if (!s || s.version !== 1 || s.id !== id || !Number.isSafeInteger(s.revision) || s.revision < 0
    || !['disconnected', 'attaching', 'ready', 'busy', 'blocked', 'needs-reconciliation', 'finalizing', 'closed'].includes(s.state)
    || !Array.isArray(s.attempts) || s.attempts.length > 1000 || !Array.isArray(s.assertions)
    || !s.finish || typeof s.finish.requested !== 'boolean'
    || !['idle', 'stopping', 'stopped', 'closing', 'done', 'failed', 'interrupted'].includes(s.finish.phase)
    || s.finish.requested !== (s.finish.phase !== 'idle')
    || !(s.sessionId === null || typeof s.sessionId === 'string' && s.sessionId.length > 0)
    || !(s.uncertainty === null || typeof s.uncertainty === 'string')
    || !Number.isFinite(Date.parse(s.createdAt)) || !Number.isFinite(Date.parse(s.updatedAt))) return false;
  if (s.binding && (typeof s.binding.targetId !== 'string' || !s.binding.targetId || typeof s.binding.origin !== 'string' || typeof s.binding.ownedByStudio !== 'boolean')) return false;
  if (s.binding && !validThread(s.binding.thread)) return false;
  // Absent identity is a legacy snapshot (handled on load); a present one must be consistent with the binding.
  if (s.identity !== undefined && !validIdentity(s.identity, s.binding?.thread)) return false;
  if (s.binding) {
    try { const url = new URL(s.binding.origin); if (url.origin !== s.binding.origin || url.protocol !== 'https:') return false; } catch { return false; }
  }
  if (s.state !== 'disconnected' && !s.binding) return false;
  // Old saved snapshots may contain several attempts from earlier releases; never promote multiple observed sends.
  if (s.attempts.filter((a) => a?.send?.state === 'observed').length > 1 && s.attempts.some((a) => a.journal?.id !== a.id)) return false;
  return s.attempts.every((a) => typeof a.key === 'string' && a.key.length > 0 && typeof a.id === 'string'
    && /^[a-f0-9]{64}$/.test(a.payloadDigest) && phases.includes(a.phase)
    && Number.isFinite(Date.parse(a.createdAt)) && Number.isFinite(Date.parse(a.updatedAt))
    && ['not-attempted', 'submitting', 'observed', 'uncertain'].includes(a.send?.state)
    && (a.boundary === null || Number.isSafeInteger(a.boundary?.sequence) && a.boundary.sequence >= 0 && Number.isSafeInteger(a.boundary?.transcriptCount) && a.boundary.transcriptCount >= 0));
}

export function createConversationService({ dataDir, id = randomUUID(), adapter, io = fs, context = {}, recover = true } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id)) throw error('INVALID_CONVERSATION_ID');
  if (!adapter) throw error('ADAPTER_REQUIRED');
  const file = path.join(dataDir, `${id}.conversation.json`);
  let snapshot, existed = false;
  try { const raw = io.readFileSync(file, 'utf8'); existed = true; snapshot = JSON.parse(raw); }
  catch (e) { if (e.code !== 'ENOENT') throw error('CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
  if (existed && !validSnapshot(snapshot, id)) throw error('CORRUPT_OR_UNREADABLE_SNAPSHOT');
  // JSON null is existing corrupt state, not a missing file.
  if (snapshot === null) throw error('CORRUPT_OR_UNREADABLE_SNAPSHOT');
  snapshot ??= { version: 1, id, revision: 0, state: 'disconnected', binding: null, sessionId: null,
    attempts: [], assertions: [], uncertainty: null, finish: { requested: false, phase: 'idle', error: null }, createdAt: now(), updatedAt: now() };
  // A snapshot written before thread identity existed is never silently trusted for a send.
  snapshot.identity ??= existed && snapshot.binding ? { state: 'unverified', reason: 'LEGACY_SNAPSHOT' } : { state: 'unbound', reason: 'NOT_CONNECTED' };
  snapshot.site ??= context.site ?? null;
  snapshot.owner ??= context.owner ?? null;
  snapshot.reply ??= { state: 'unknown', source: 'page', text: '', chars: 0, completion: 'unknown' };
  snapshot.capture ??= { state: 'incomplete', integrity: null, ...context.capture };
  snapshot.limitations ??= ['Page observations are not network completion or full capture acceptance', 'Cancellation is deferred'];
  snapshot.readiness ??= { ready: false, draft: { present: null, chars: null }, reason: 'NOT_CHECKED' };
  let poisoned = false, chain = Promise.resolve(), finishPromise = null;
  let submissionStopped = false;
  let journal;
  const threadJournal = () => {
    if (!snapshot.binding?.thread || snapshot.identity.state !== 'bound') throw error('THREAD_IDENTITY_UNVERIFIED');
    return journal ??= createThreadTurnJournal({ dataDir: path.join(dataDir, 'thread-turns'), namespace: 'local-owner',
      origin: snapshot.binding.origin, thread: snapshot.binding.thread, io });
  };
  function journalTurn(a) {
    const turn = threadJournal().read().turns.find((t) => t.id === a.id);
    if (!turn) throw error('THREAD_JOURNAL_MISSING');
    return turn;
  }
  const view = () => {
    const s = structuredClone(snapshot);
    if (s.binding?.thread && s.identity.state === 'bound') {
      const turns = threadJournal().read().turns;
      for (const a of s.attempts) {
        const turn = turns.find((t) => t.id === a.id);
        if (a.journal && (!turn || turn.key !== a.key || turn.payloadDigest !== a.payloadDigest)) throw error('THREAD_JOURNAL_MISSING_OR_MISMATCHED');
        if (turn) { a.journal = turn; a.readiness = turn.readiness; a.completion = turn.completion; }
      }
    }
    s.reply = structuredClone(s.attempts.at(-1)?.reply ?? s.reply);
    return s;
  };
  const serial = (fn) => { const result = chain.then(() => { if (poisoned) throw error('PERSISTENCE_FAILED_REOPEN_REQUIRED'); return fn(); }); chain = result.catch(() => {}); return result; };
  // Flush the entire replacement before rename, then sync the named final file explicitly.
  // Directory fsync is not portable on Windows; cross-process/durable-host guarantees are not claimed.
  function save() {
    snapshot.revision++; snapshot.updatedAt = now();
    const tmp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      io.mkdirSync(dataDir, { recursive: true });
      fd = io.openSync(tmp, 'wx', 0o600);
      io.writeFileSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`);
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      io.renameSync(tmp, file);
      fd = io.openSync(file, 'r+'); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    } catch {
      poisoned = true;
      throw error('PERSISTENCE_FAILED_REOPEN_REQUIRED');
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      try { io.unlinkSync(tmp); } catch {}
    }
  }
  function revision(expected) { if (expected !== snapshot.revision) throw error('STALE_REVISION'); }
  function writable() { if (snapshot.finish.requested) throw error('CONVERSATION_FINISHED'); }
  function updateAttempt(a, phase, send) { a.phase = phase; a.send.state = send; a.updatedAt = now(); }
  function observe(a, observation) {
    const e = observation?.evidence;
    if (!a || !a.boundary || !exactBinding(snapshot.binding, observation?.binding)
      || e?.turnId !== a.id || e?.payloadDigest !== a.payloadDigest || e?.sessionId !== snapshot.sessionId
      || !Number.isSafeInteger(e?.sequence) || e.sequence <= a.boundary.sequence
      || !(e.kind === 'outgoing-request' && e.source === 'network' || e.kind === 'new-user-turn' && e.source === 'page')) return false;
    // A preparing attempt never dispatched; unrelated records cannot turn it into a send.
    if (!['dispatching', 'uncertain', 'observed'].includes(a.phase)) return false;
    try { a.journal = threadJournal().observeDelivery({ turnId: a.id, expectedRevision: journalTurn(a).revision, evidence: e }); }
    catch { return false; }
    updateAttempt(a, 'observed', 'observed');
    a.send.observationSource = e.source;
    a.send.evidence = { sessionId: e.sessionId, sequence: e.sequence, kind: e.kind, identity: e.identity };
    snapshot.uncertainty = null;
    if (!snapshot.finish.requested) snapshot.state = 'ready';
    return true;
  }
  function applyReply(reply) {
    const a = snapshot.attempts.find((a) => a.id === reply.turnId);
    if (!a) throw error('TURN_NOT_FOUND');
    const e = reply.evidence, text = String(reply.text ?? '');
    if (e) {
      if (!exactBinding(snapshot.binding, reply.binding) || e.contentDigest !== createHash('sha256').update(text).digest('hex') || e.chars !== text.length) throw error('INVALID_REPLY_EVIDENCE');
      a.journal = threadJournal().recordReply({ turnId: a.id, expectedRevision: journalTurn(a).revision, evidence: e });
      if (reply.readiness) a.journal = threadJournal().recordReadiness({ turnId: a.id, expectedRevision: a.journal.revision, evidence: reply.readiness });
      a.reply = { state: a.journal.readiness.state === 'ready' ? 'ready' : 'streaming', source: e.source, text, chars: text.length,
        evidence: structuredClone(e), completion: a.journal.completion.state };
    } else {
      a.reply = { ...a.reply, state: ['waiting', 'interrupted', 'unknown'].includes(reply.state) ? reply.state : 'unknown',
        text: a.reply.text ?? '', source: 'page', completion: 'unknown' };
    }
    if (snapshot.attempts.at(-1)?.id === a.id) snapshot.reply = structuredClone(a.reply);
  }
  function applyPriorReplies(updates = []) { for (const update of updates) applyReply(update); }
  function blockPreEffect(a) {
    a.journal = threadJournal().provePreEffect({ turnId: a.id, expectedRevision: journalTurn(a).revision,
      evidence: { turnId: a.id, payloadDigest: a.payloadDigest, kind: 'pre-effect-blocked', source: 'actuator-audit',
        reference: `service-preflight:${a.id}`, typing: 'not-executed', dispatch: 'not-executed' } });
  }
  function unknown(a, reason) {
    a.journal = threadJournal().markUnknown({ turnId: a.id, expectedRevision: journalTurn(a).revision, reason });
  }
  function replayRequest(key, payloadDigest) {
    const local = view().attempts.find((a) => a.key === key);
    const prior = local ?? (snapshot.binding?.thread && snapshot.identity.state === 'bound'
      ? threadJournal().read().turns.find((a) => a.key === key) : null);
    if (!prior) return null;
    if (prior.payloadDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT');
    return local ?? { ...prior, journal: prior, phase: prior.phase === 'delivered' ? 'observed' : prior.phase,
      send: { state: prior.delivery.state === 'observed' ? 'observed' : prior.phase === 'blocked' ? 'not-attempted' : 'uncertain', evidence: prior.delivery.evidence },
      reply: { ...prior.reply, text: '', completion: prior.completion.state } };
  }
  function invalidatePrior(ids = []) {
    for (const id of ids) {
      const turn = threadJournal().read().turns.find((t) => t.id === id);
      if (turn) threadJournal().invalidateReadiness({ turnId: id, expectedRevision: turn.revision });
    }
  }
  async function ensureCapture() {
    if (typeof adapter.armCapture !== 'function') return;
    const sessionId = await adapter.armCapture();
    if (typeof sessionId !== 'string' || !sessionId) throw error('CAPTURE_NOT_ACTIVE');
    if (snapshot.sessionId !== sessionId) { snapshot.sessionId = sessionId; snapshot.capture.state = 'recording'; save(); }
  }
  const creatingNow = () => snapshot.identity?.state === 'unbound' && snapshot.identity?.reason === 'NEW_CHAT' && !snapshot.binding?.thread && snapshot.binding?.ownedByStudio === true;
  const deniedRef = (ref) => !Array.isArray(snapshot.threadDenylist) || snapshot.threadDenylist.includes(ref);
  function effectPermit(a, phase, page) {
    const turns = threadJournal().read().turns;
    if (page) for (const prior of turns) {
      if (prior.id === a.id || prior.reply.state !== 'observed') continue;
      const r = prior.reply.evidence, message = page.messages?.find((m) => m.id === r.identity && m.role === 'assistant');
      if (!message || createHash('sha256').update(message.text).digest('hex') !== r.contentDigest || message.text.length !== r.chars) {
        invalidatePrior([prior.id]); throw error('THREAD_FENCED');
      }
    }
    return threadJournal().assertEffectAllowed({ turnId: a.id, expectedRevision: a.journal.revision, phase });
  }
  const interrupted = snapshot.attempts.at(-1);
  let recovered = false;
  if (recover && context.restarted && !snapshot.finish.requested && snapshot.state !== 'disconnected') {
    snapshot.state = 'needs-reconciliation'; snapshot.capture.state = 'incomplete';
    snapshot.uncertainty ??= 'runtime-restarted'; recovered = true;
  }
  if (recover && !snapshot.sessionId && context.recoveredSessionId) {
    snapshot.sessionId = context.recoveredSessionId; snapshot.capture.state = 'incomplete';
    snapshot.uncertainty = 'attachment-interrupted'; snapshot.state = 'needs-reconciliation'; recovered = true;
  }
  if (recover && interrupted?.phase === 'preparing') {
    updateAttempt(interrupted, 'needs-reconciliation', 'not-attempted');
    snapshot.uncertainty = 'partial-draft-possible'; snapshot.state = 'needs-reconciliation'; recovered = true;
  } else if (recover && interrupted?.phase === 'dispatching') {
    updateAttempt(interrupted, 'uncertain', 'uncertain');
    snapshot.uncertainty = 'send-acknowledgement-lost'; snapshot.state = 'needs-reconciliation'; recovered = true;
  }
  if (recover && ['stopping', 'stopped', 'closing'].includes(snapshot.finish.phase)) {
    snapshot.finish.phase = 'interrupted'; snapshot.finish.error = 'Finalization interrupted; no automatic stop or close replay';
    snapshot.state = 'needs-reconciliation'; recovered = true;
  } else if (recover && snapshot.state === 'attaching') {
    snapshot.state = 'needs-reconciliation'; snapshot.uncertainty = 'attachment-interrupted'; recovered = true;
  }
  if (recovered) save();

  async function submitCreation({ key, prompt, payloadDigest, registered, writer }) {
    if (snapshot.attempts.length !== 0) throw error('CREATION_UNCERTAIN');
    const attempt = { id: randomUUID(), key, payloadDigest, phase: 'preparing', createdAt: now(), updatedAt: now(), creation: true,
      boundary: null, send: { state: 'not-attempted', observationSource: null }, reply: { state: 'unknown', source: 'page', text: '', completion: 'unknown' }, evidence: { state: 'recording' } };
    const finish = () => { save(); const viewAttempt = view().attempts.find((a) => a.key === key); registered?.(view(), viewAttempt); return viewAttempt; };
    const prove = () => {
      delete attempt.typingStartedAt;
      attempt.preEffect = { turnId: attempt.id, payloadDigest, kind: 'pre-effect-blocked', source: 'actuator-audit',
        reference: `service-preflight:${attempt.id}`, typing: 'not-executed', dispatch: 'not-executed' };
      attempt.reason = 'PREEXISTING_THREAD';
      snapshot.readiness = { ready: false, draft: { present: null, chars: null }, reason: 'PREEXISTING_THREAD' };
      snapshot.state = 'blocked'; snapshot.uncertainty = null;
      updateAttempt(attempt, 'blocked', 'not-attempted');
      writer?.release?.(); // Proven pre-effect (PREEXISTING_THREAD / not typed / not dispatched): the window closes.
    };
    const uncertain = (reason) => {
      attempt.preEffect = null; attempt.reason = reason;
      snapshot.readiness = { ready: false, draft: { present: null, chars: null }, reason };
      snapshot.uncertainty = reason; snapshot.state = 'needs-reconciliation';
      updateAttempt(attempt, 'uncertain', 'uncertain');
    };
    await ensureCapture();
    let preflight;
    try { preflight = await adapter.preflight(structuredClone(snapshot.binding), { priorTurns: [] }); }
    catch (e) {
      if (e?.code !== 'PREEXISTING_THREAD') throw error(/^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'PREFLIGHT_FAILED');
      snapshot.attempts.push(attempt); prove(); return finish();
    }
    const threadless = preflight?.creation?.threadless === true && !preflight?.targetThread && !preflight?.pageThread;
    const controls = preflight?.controls;
    const idle = controls?.observed === true && ['idle', 'terminal'].includes(controls.state) && controls.idleControlPresent === true && controls.stopPresent === false && controls.composerEnabled === true;
    const draftOk = preflight?.draft?.present === false && preflight?.draft?.chars === 0 && preflight?.ready === true;
    const boundaryOk = Number.isSafeInteger(preflight?.boundary?.sequence) && preflight.boundary.sequence >= 0 && Number.isSafeInteger(preflight?.boundary?.transcriptCount) && preflight.boundary.transcriptCount >= 0;
    if (preflight?.targetThread || preflight?.pageThread) { snapshot.attempts.push(attempt); prove(); return finish(); }
    if (!threadless || !idle || !draftOk || !boundaryOk || !exactBinding(snapshot.binding, preflight?.binding)) throw error('THREAD_IDENTITY_UNVERIFIED');
    attempt.boundary = { sequence: preflight.boundary.sequence, transcriptCount: preflight.boundary.transcriptCount };
    attempt.baseline = baselineOf(preflight.baseline); attempt.cursor = cursorOf(preflight.cursor);
    snapshot.attempts.push(attempt); snapshot.state = 'busy'; save();
    const stopEarly = () => {
      if (!submissionStopped) return false;
      if (!attempt.typingStartedAt) { prove(); attempt.reason = 'SUBMISSION_STOPPED'; return true; }
      uncertain(attempt.typingStartedAt ? 'partial-draft-possible' : 'CREATION_UNPINNED'); return true;
    };
    if (stopEarly()) return finish();
    attempt.typingStartedAt = now(); save();
    try {
      await adapter.type({ binding: structuredClone(snapshot.binding), turnId: attempt.id, prompt, creation: true,
        beforeEffect: () => { if (submissionStopped) throw Object.assign(error('SUBMISSION_STOPPED'), { notTyped: true }); } });
    } catch (e) {
      if ((e?.code === 'PREEXISTING_THREAD' || e?.code === 'SUBMISSION_STOPPED') && e.notTyped === true) { prove(); if (e.code === 'SUBMISSION_STOPPED') attempt.reason = 'SUBMISSION_STOPPED'; return finish(); }
      console.error('[conv] creation type-step failed:', e?.code, e?.message); uncertain('CREATION_UNPINNED'); return finish();
    }
    if (stopEarly()) return finish();
    updateAttempt(attempt, 'dispatching', 'submitting'); save();
    let report;
    try {
      report = await adapter.submit({ binding: structuredClone(snapshot.binding), turnId: attempt.id, payloadDigest, creation: true,
        beforeEffect: () => { if (submissionStopped) throw Object.assign(error('SUBMISSION_STOPPED'), { notDispatched: true }); } });
    } catch (e) {
      if (e?.notDispatched === true && e?.code === 'PREEXISTING_THREAD' && !attempt.typingStartedAt) { prove(); return finish(); }
      console.error('[conv] creation submit-step failed:', e?.code, e?.message); uncertain('CREATION_UNPINNED'); return finish();
    }
    const target = report?.targetThread, page = report?.pageThread;
    const same = target && page && validThread(target) && target.ref === page.ref && target.id === page.id;
    if (report?.creation !== true || report?.dispatched !== true || !same || deniedRef(target.ref)) { console.error('[conv] creation report invalid:', JSON.stringify({c:report?.creation,d:report?.dispatched,same:!!same,t:target?.ref,p:page?.ref})); uncertain('CREATION_UNPINNED'); return finish(); }
    try {
      const pinned = typeof adapter.pinThread === 'function' ? await adapter.pinThread(target, snapshot.threadDenylist) : null;
      if (!pinned?.thread || pinned.thread.ref !== target.ref) { uncertain('CREATION_UNPINNED'); return finish(); }
      snapshot.binding = { ...snapshot.binding, thread: pinned.thread };
      snapshot.identity = { state: 'bound', reason: null }; save();
      const reservation = threadJournal().reserve({ key, payloadDigest, conversationId: id });
      if (!reservation.admitted) throw error('THREAD_FENCED');
      if (typeof adapter.adoptTurn === 'function') adapter.adoptTurn(attempt.id, reservation.turn.id);
      attempt.id = reservation.turn.id; attempt.journal = reservation.turn; save();
      attempt.journal = threadJournal().markTyping({ turnId: attempt.id, expectedRevision: attempt.journal.revision,
        boundary: { ...attempt.boundary, sessionId: snapshot.sessionId } });
      attempt.journal = threadJournal().markDispatching({ turnId: attempt.id, expectedRevision: attempt.journal.revision });
      const observation = await adapter.reconcile({ binding: structuredClone(snapshot.binding), turnId: attempt.id, payloadDigest, boundary: structuredClone(attempt.boundary) });
      if (observe(attempt, observation)) writer?.release?.();
      else { unknown(attempt, 'ACK_LOST'); updateAttempt(attempt, 'uncertain', 'uncertain'); snapshot.uncertainty = 'send-acknowledgement-lost'; snapshot.state = 'needs-reconciliation'; }
    } catch (e) {
      if (e?.code === 'PERSISTENCE_FAILED_REOPEN_REQUIRED' || e?.code === 'JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED') throw e;
      console.error('[conv] creation pin/reconcile failed:', e?.code, e?.message); uncertain('CREATION_UNPINNED');
    }
    return finish();
  }

  return {
    id, file,
    threadKey: () => threadJournal().threadKey,
    // Read-only journal snapshot for reconciliation surfaces (Round 7 seam). The journal's
    // own read() is already a structured clone; no recovery, no mutation, no admission change.
    journalSnapshot: () => threadJournal().read(),
    lookupRequest: ({ key, payloadDigest }) => replayRequest(key, payloadDigest),
    // Local snapshots only, with no browser/adapter calls. A clone prevents caller mutation.
    read: () => view(),
    stopSubmission() { submissionStopped = true; },
    connect({ targetId, origin, ownedByStudio = false, thread = null, identity, threadDenylist, expectedRevision } = {}) {
      return serial(async () => {
        writable(); revision(expectedRevision);
        if (snapshot.state !== 'disconnected') throw error('ALREADY_CONNECTED');
        let parsed; try { parsed = new URL(origin); } catch { throw error('INVALID_BINDING'); }
        if (typeof targetId !== 'string' || !targetId || parsed.origin !== origin || parsed.protocol !== 'https:' || typeof ownedByStudio !== 'boolean') throw error('INVALID_BINDING');
        // The runtime decides identity from the live target URL; the service only stores and enforces it.
        const resolved = identity ?? (thread ? { state: 'bound', reason: null } : { state: 'unbound', reason: 'NOT_PROVIDED' });
        if (!validThread(thread) || !validIdentity(resolved, thread)) throw error('INVALID_BINDING');
        if (threadDenylist !== undefined && !Array.isArray(threadDenylist)) throw error('INVALID_BINDING');
        const threadRef = /^chatgpt-c:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        snapshot.binding = { targetId, origin, ownedByStudio, ...(thread ? { thread } : {}) };
        snapshot.identity = { state: resolved.state, reason: resolved.reason ?? null };
        if (Array.isArray(threadDenylist)) snapshot.threadDenylist = [...new Set(threadDenylist.filter((ref) => threadRef.test(ref)))];
        snapshot.state = 'attaching'; save();
        let attached;
        try { attached = await adapter.connect(structuredClone(snapshot.binding), {
          bind(binding) {
            if (binding.origin !== origin || binding.ownedByStudio !== ownedByStudio || typeof binding.targetId !== 'string' || !binding.targetId || !sameThread(binding.thread, thread)) throw error('INVALID_ATTACHMENT');
            snapshot.binding = structuredClone(binding); save();
          },
          ownSession(sessionId) {
            if (typeof sessionId !== 'string' || !sessionId) throw error('INVALID_ATTACHMENT');
            snapshot.sessionId = sessionId; snapshot.capture.state = 'recording'; save();
          },
        }); }
        catch (e) {
          // Keep only a coded reason (never transport/URL/content text) so the failure is diagnosable.
          snapshot.readiness = { ready: false, draft: { present: null, chars: null }, reason: /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'ATTACH_FAILED' };
          snapshot.state = 'needs-reconciliation'; snapshot.uncertainty = 'attachment-failed'; save(); throw error('ATTACHMENT_FAILED');
        }
        const deferred = attached?.deferredCapture === true && attached.sessionId == null;
        if (!exactBinding(snapshot.binding, attached?.binding) || attached.binding.ownedByStudio !== ownedByStudio || (!deferred && (typeof attached?.sessionId !== 'string' || !attached.sessionId))) {
          snapshot.state = 'needs-reconciliation'; snapshot.uncertainty = 'attachment-binding-mismatch'; save(); throw error('INVALID_ATTACHMENT');
        }
        if (deferred) { snapshot.sessionId = null; snapshot.capture.state = 'idle'; }
        else { snapshot.sessionId = attached.sessionId; snapshot.capture.state = 'recording'; }
        const creating = snapshot.identity.state === 'unbound' && snapshot.identity.reason === 'NEW_CHAT' && !snapshot.binding.thread;
        const creationReady = creating && attached.readiness?.ready === true && attached.readiness?.creation?.threadless === true
          && attached.readiness.draft?.present === false && attached.readiness.draft?.chars === 0;
        if (creating) {
          snapshot.readiness = creationReady ? { ready: true, draft: { present: false, chars: 0 }, reason: null }
            : { ready: false, draft: { present: attached.readiness?.draft?.present ?? null, chars: attached.readiness?.draft?.chars ?? null },
              reason: /^[A-Z][A-Z0-9_]{0,79}$/.test(attached.readiness?.reason ?? '') ? attached.readiness.reason : 'NOT_CHECKED' };
        } else {
          snapshot.readiness = attached.readiness ?? { ready: true, draft: { present: false, chars: 0 }, reason: null };
          // An unverified thread is never ready for a send, whatever the page looks like.
          if (snapshot.identity.state !== 'bound' && snapshot.readiness.ready) snapshot.readiness = { ...snapshot.readiness, ready: false, reason: 'THREAD_IDENTITY_UNVERIFIED' };
        }
        snapshot.state = snapshot.readiness.ready ? 'ready' : 'blocked'; save(); return view();
      });
    },
    submit({ key, prompt, expectedRevision, confirm } = {}, { registered, writer } = {}) {
      let acquired = false; // True only while the writer window THIS call opened is still held.
      return serial(async () => {
        if (typeof key !== 'string' || !key || key.length > 200 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 250000) throw error('INVALID_SUBMISSION');
        const payloadDigest = createHash('sha256').update(prompt, 'utf8').digest('hex');
        const original = snapshot.attempts.find((a) => a.key === key);
        // Same key replays the original turn read-only, even after finish/restart; only NEW sends need a writable conversation.
        if (original) { if (original.payloadDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT'); const replay = view().attempts.find((a) => a.id === original.id); registered?.(view(), replay); return replay; }
        if (snapshot.binding?.thread && snapshot.identity.state === 'bound') {
          const prior = threadJournal().read().turns.find((a) => a.key === key);
          if (prior) {
            if (prior.payloadDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT');
            const replay = { ...prior, journal: prior, phase: prior.phase === 'delivered' ? 'observed' : prior.phase,
              send: { state: prior.delivery.state === 'observed' ? 'observed' : prior.phase === 'blocked' ? 'not-attempted' : 'uncertain', evidence: prior.delivery.evidence },
              reply: { ...prior.reply, text: '', completion: prior.completion.state } };
            registered?.(view(), replay); return structuredClone(replay);
          }
        }
        writable();
        revision(expectedRevision);
        if (confirm !== true) throw error('CONFIRM_REQUIRED');
        // Short foreground writer window: opened before any browser-facing work of this turn and
        // held until its delivery is observed, the turn proves no effect, or — for unresolved
        // outcomes (unknown delivery, partial draft) — until reconcile/finish resolves it.
        // Idempotent replays above never enter the window. Passive capture continues lease-free.
        acquired = writer?.enter?.() ?? false;
        if (creatingNow()) return submitCreation({ key, prompt, payloadDigest, registered, writer });
        // Fail closed before any browser action: an unverified thread (legacy snapshot or an existing tab whose
        // path is not a supported thread) can browse and finish, never send.
        if (snapshot.identity.state !== 'bound' || !snapshot.binding?.thread) throw error('THREAD_IDENTITY_UNVERIFIED');
        // A new idempotency key is NOT authorization to repeat a potentially
        // dispatched action. Unknown delivery and partial draft remain blocked
        // even if a later read-only reconciliation sees no matching page turn.
        // A proven pre-typing rejection ('blocked' without typing) remains
        // eligible for one fresh attempt after the user clears the draft.
        if (snapshot.attempts.some((a) => !a.journal)) throw error('LEGACY_ATTEMPT_REQUIRES_RECONCILIATION');
        // Cheap early look at the same fence reserve() enforces: a send that is going to be fenced must not arm a new
        // capture first (the journal remains the authority; this only avoids an orphan recording).
        if (threadJournal().read().turns.some((a) => !(a.phase === 'blocked' || a.delivery.state === 'observed' && a.reply.state === 'observed' && a.readiness.state === 'ready'))) throw error('THREAD_FENCED');
        // Next turn only after the previous turn's capture was cleanly stopped (never reuse an unfinalized capture).
        if (snapshot.attempts.some((a) => a.send.state === 'observed') && snapshot.capture.state === 'incomplete') throw error('PRIOR_TURN_CAPTURE_NOT_FINALIZED');
        await ensureCapture();
        const reservation = threadJournal().reserve({ key, payloadDigest, conversationId: id });
        if (!reservation.admitted) throw error('THREAD_FENCED');
        const attempt = { id: reservation.turn.id, key, payloadDigest, phase: 'preparing', createdAt: now(), updatedAt: now(), journal: reservation.turn,
          boundary: null, send: { state: 'not-attempted', observationSource: null }, reply: { state: 'unknown', source: 'page', text: '', completion: 'unknown' }, evidence: { state: 'recording' } };
        snapshot.attempts.push(attempt); snapshot.state = 'busy'; save();
        registered?.(view(), attempt);
        const stopped = () => {
          if (!submissionStopped) return false;
          const turn = journalTurn(attempt);
          // This service is the admitting actuator owner. A preparing journal plus our own
          // not-started typing/dispatch audit proves no browser effect was ever invoked. Never
          // apply this proof after typing intent (including partial/ack-lost insertion) began.
          const preEffect = turn.conversationId === id && turn.phase === 'preparing'
            && !attempt.typingStartedAt && attempt.phase === 'preparing' && attempt.send.state === 'not-attempted';
          if (preEffect) {
            blockPreEffect(attempt); snapshot.state = 'blocked'; snapshot.uncertainty = null;
            attempt.reason = 'SUBMISSION_STOPPED'; updateAttempt(attempt, 'blocked', 'not-attempted'); save();
            writer?.release?.(); // Proven no effect: this turn's window closes with the attempt.
            return true;
          }
          snapshot.state = 'needs-reconciliation'; snapshot.uncertainty = attempt.typingStartedAt ? 'partial-draft-possible' : null;
          attempt.reason = 'SUBMISSION_STOPPED'; updateAttempt(attempt, 'needs-reconciliation', 'not-attempted'); save(); return true;
        };
        if (stopped()) return view().attempts.find((a) => a.id === attempt.id);
        let preflight;
        try { preflight = await adapter.preflight(structuredClone(snapshot.binding), { priorTurns: threadJournal().read().turns.filter((a) => a.id !== attempt.id) }); }
        catch (e) {
          invalidatePrior(e.invalidatedTurnIds);
          applyPriorReplies(e.priorReplies); blockPreEffect(attempt);
          attempt.reason = /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code ?? '') ? e.code : 'PREFLIGHT_FAILED';
          snapshot.readiness = { ready: false, draft: { present: null, chars: null }, reason: attempt.reason };
          snapshot.state = 'blocked'; updateAttempt(attempt, 'blocked', 'not-attempted'); save(); throw error('PREFLIGHT_FAILED');
        }
        applyPriorReplies(preflight?.priorReplies);
        snapshot.readiness = { ready: preflight?.draft?.present === false && preflight?.draft?.chars === 0,
          draft: { present: preflight?.draft?.present ?? null, chars: preflight?.draft?.chars ?? null }, reason: null };
        if (preflight?.ready === false || !exactBinding(snapshot.binding, preflight?.binding) || preflight?.draft?.present !== false || preflight?.draft?.chars !== 0
          || !Number.isSafeInteger(preflight?.boundary?.sequence) || preflight.boundary.sequence < 0
          || !Number.isSafeInteger(preflight?.boundary?.transcriptCount) || preflight.boundary.transcriptCount < 0) {
          attempt.reason = exactBinding(snapshot.binding, preflight?.binding) && preflight?.draft?.present ? 'DRAFT_PRESENT' : 'DRAFT_OR_BINDING_NOT_READY';
          snapshot.readiness.ready = false; snapshot.readiness.reason = attempt.reason; blockPreEffect(attempt);
          snapshot.state = 'blocked'; updateAttempt(attempt, 'blocked', 'not-attempted'); save(); throw error('DRAFT_OR_BINDING_NOT_READY');
        }
        if (stopped()) return view().attempts.find((a) => a.id === attempt.id);
        // Per-turn freshness cursor. History must not have shrunk since the last delivered turn.
        const cursor = cursorOf(preflight.cursor);
        const floor = Math.max(0, ...snapshot.attempts.filter((a) => a.id !== attempt.id).map(expectedFloor));
        if (cursor && cursor.messageCount < floor) {
          attempt.reason = 'THREAD_CHANGED_BETWEEN_TURNS'; blockPreEffect(attempt);
          snapshot.readiness = { ready: false, draft: { present: false, chars: 0 }, reason: attempt.reason };
          snapshot.state = 'blocked'; updateAttempt(attempt, 'blocked', 'not-attempted'); save(); throw error('THREAD_CHANGED_BETWEEN_TURNS');
        }
        attempt.boundary = { sequence: preflight.boundary.sequence, transcriptCount: preflight.boundary.transcriptCount };
        attempt.baseline = baselineOf(preflight.baseline); attempt.cursor = cursor; save();
        attempt.journal = threadJournal().markTyping({ turnId: attempt.id, expectedRevision: journalTurn(attempt).revision,
          boundary: { ...attempt.boundary, sessionId: snapshot.sessionId } });
        attempt.typingStartedAt = now(); save();
        try { await adapter.type({ binding: structuredClone(snapshot.binding), turnId: attempt.id, prompt,
          beforeEffect: (page) => effectPermit(attempt, 'typing', page) }); }
        catch (e) { console.error('[conv] followup type-step failed:', e?.code, e?.message); applyPriorReplies(e.priorReplies); unknown(attempt, 'TYPING_INTERRUPTED'); snapshot.state = 'needs-reconciliation'; snapshot.uncertainty = 'partial-draft-possible'; updateAttempt(attempt, 'needs-reconciliation', 'not-attempted'); save(); throw error('TYPING_INTERRUPTED'); }
        if (stopped()) return view().attempts.find((a) => a.id === attempt.id);
        updateAttempt(attempt, 'dispatching', 'submitting'); save();
        attempt.journal = threadJournal().markDispatching({ turnId: attempt.id, expectedRevision: journalTurn(attempt).revision });
        let observation;
        try { observation = await adapter.submit({ binding: structuredClone(snapshot.binding), turnId: attempt.id, payloadDigest,
          beforeEffect: (page) => effectPermit(attempt, 'dispatching', page) }); }
        catch (e) {
          console.error('[conv] followup submit-step failed:', e?.code, e?.message);
          applyPriorReplies(e.priorReplies);
          if (e.notDispatched === true && /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code ?? '')) {
            // Adapter proved nothing was dispatched (stop latch or sendMessage refusal): never 'uncertain'.
            snapshot.state = 'needs-reconciliation'; snapshot.uncertainty = 'partial-draft-possible'; attempt.reason = e.code;
            unknown(attempt, 'DISPATCH_NOT_CONFIRMED'); updateAttempt(attempt, 'needs-reconciliation', 'not-attempted'); save(); return view().attempts.find((a) => a.id === attempt.id);
          }
          /* Unknown effect: never retry, even if the transport claims the send failed. */
        }
        if (observe(attempt, observation)) writer?.release?.(); // Delivery observed: the effect window closes; reply observation stays read-only.
        else {
          unknown(attempt, 'ACK_LOST');
          updateAttempt(attempt, 'uncertain', 'uncertain'); snapshot.uncertainty = 'send-acknowledgement-lost'; snapshot.state = 'needs-reconciliation';
        }
        save(); return view().attempts.find((a) => a.id === attempt.id);
      }).catch((e) => {
        // A pre-effect failure releases only a window this call opened; an already-open window
        // belongs to an earlier unresolved turn and stays with it. Effect-bearing uncertainty
        // (typing interrupted, journal fence, poisoned persistence) keeps the window open until
        // reconcile or finish resolves it — the documented unknown-delivery hold.
        if (acquired && !['TYPING_INTERRUPTED', 'THREAD_FENCED', 'PERSISTENCE_FAILED_REOPEN_REQUIRED', 'JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED'].includes(e?.code)) writer?.release?.();
        throw e;
      });
    },
    reconcile({ expectedRevision, assertion, turnId } = {}, { writer } = {}) {
      return serial(async () => {
        revision(expectedRevision);
        if (assertion !== undefined) {
          if (typeof assertion !== 'boolean') throw error('INVALID_ASSERTION');
          snapshot.assertions.push({ provenance: 'user-asserted', sent: assertion, at: now() });
          snapshot.assertions = snapshot.assertions.slice(-20);
        }
        const attempt = turnId ? snapshot.attempts.find((a) => a.id === turnId) : snapshot.attempts.at(-1);
        if (turnId && !attempt) throw error('TURN_NOT_FOUND');
        // Capture is deferred until the first explicit send, so a connected idle conversation has no
        // session yet. It is still inspectable read-only (no type, no send, no capture arm) — but never
        // when a failed/interrupted attachment left an uncertainty that only a human may clear.
        const deferredIdle = !snapshot.sessionId && !snapshot.finish.requested && ['ready', 'blocked'].includes(snapshot.state)
          && !snapshot.uncertainty && snapshot.capture.state === 'idle';
        // A previous turn that completed safely (delivered, reply finalized and ready) is not an
        // unresolved observation: an unscoped "Check again" refreshes readiness for the NEXT turn.
        const settled = (a) => a?.send?.state === 'observed' && a.reply?.state === 'ready' && a.journal?.readiness?.state === 'ready';
        if (!snapshot.sessionId && !deferredIdle) { save(); return view(); }
        // A pre-typing rejection is not a send attempt. "Check again" only refreshes current
        // readiness; the original blocked key remains blocked/idempotent, and a new key is needed.
        if (!snapshot.finish.requested && (!attempt || attempt.phase === 'blocked' && !attempt.typingStartedAt
          || !turnId && !snapshot.uncertainty && settled(attempt))) {
          save(); // Fail closed before the read-only browser inspection, as on the observation path.
          let preflight;
          try { preflight = await adapter.preflight(structuredClone(snapshot.binding), { readOnly: true }); }
          catch (e) {
            snapshot.readiness = { ready: false, draft: { present: null, chars: null },
              reason: /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code ?? '') ? e.code : 'PREFLIGHT_FAILED' };
            snapshot.state = 'blocked'; save(); return view();
          }
          const bound = exactBinding(snapshot.binding, preflight?.binding);
          const validDraft = typeof preflight?.draft?.present === 'boolean' && Number.isSafeInteger(preflight?.draft?.chars)
            && preflight.draft.chars >= 0 && preflight.draft.present === (preflight.draft.chars > 0);
          const validBoundary = Number.isSafeInteger(preflight?.boundary?.sequence) && preflight.boundary.sequence >= 0
            && Number.isSafeInteger(preflight?.boundary?.transcriptCount) && preflight.boundary.transcriptCount >= 0;
          const unverified = snapshot.identity.state === 'unverified';
          // The adapter may refuse readiness itself (auth wall, site gate, composer unavailable...) with a coded reason.
          const refused = preflight?.ready === false;
          const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(preflight?.reason ?? '') ? preflight.reason : null;
          const ready = bound && validDraft && validBoundary && !preflight.draft.present && !unverified && !refused;
          snapshot.readiness = { ready, draft: validDraft ? { present: preflight.draft.present, chars: preflight.draft.chars } : { present: null, chars: null },
            reason: ready ? null : !bound ? 'BINDING_CHANGED' : refused && code ? code : !validDraft || !validBoundary ? 'DRAFT_OR_BINDING_NOT_READY' : unverified && !preflight.draft.present ? 'THREAD_IDENTITY_UNVERIFIED' : 'DRAFT_PRESENT' };
          snapshot.state = ready ? 'ready' : 'blocked'; save(); return view();
        }
        if (!attempt) { save(); return view(); }
        // Persist assertion/inspection intent before asking the trusted read-only adapter.
        save();
        let observation;
        try { observation = await adapter.reconcile({ binding: structuredClone(snapshot.binding), turnId: attempt.id, payloadDigest: attempt.payloadDigest, boundary: structuredClone(attempt.boundary) }); }
        catch { throw error('RECONCILIATION_UNAVAILABLE'); }
        // Reconciliation is read-only; when it resolves a previously uncertain delivery, the
        // writer window this conversation held for that unresolved turn closes.
        if (observe(attempt, observation)) writer?.release?.();
        save(); return view();
      });
    },
    recordReply(reply) {
      return serial(() => {
        applyReply(reply);
        save(); return view();
      });
    },
    addLimitation(text) {
      return serial(() => {
        const value = String(text ?? '').slice(0, 300);
        if (value && !snapshot.limitations.includes(value)) { snapshot.limitations = [...snapshot.limitations, value].slice(-20); save(); }
        return view();
      });
    },
    recordCapture(capture) {
      return serial(() => { snapshot.capture = { ...snapshot.capture, ...capture }; save(); return view(); });
    },
    finish({ closeTab = false } = {}) {
      submissionStopped = true;
      if (finishPromise) return finishPromise;
      finishPromise = serial(async () => {
        if (snapshot.finish.requested) return view(); // Restart: no replay of stop/close.
        snapshot.finish = { requested: true, phase: 'stopping', error: null }; snapshot.state = 'finalizing'; save();
        if (snapshot.sessionId) {
          try { await adapter.stop({ binding: structuredClone(snapshot.binding), sessionId: snapshot.sessionId }); }
          catch { snapshot.finish.phase = 'failed'; snapshot.finish.error = 'CAPTURE_STOP_FAILED'; snapshot.capture.state = 'incomplete'; snapshot.state = 'needs-reconciliation'; save(); return view(); }
        }
        snapshot.finish.phase = 'stopped';
        snapshot.finish.captureStopped = true;
        snapshot.capture.state = 'incomplete';
        for (const a of snapshot.attempts) a.evidence.state = 'incomplete';
        save();
        if (closeTab === true && snapshot.binding?.ownedByStudio && !snapshot.uncertainty && snapshot.sessionId) {
          snapshot.finish.phase = 'closing'; save();
          try { await adapter.closeTab(structuredClone(snapshot.binding)); }
          catch { snapshot.finish.phase = 'failed'; snapshot.finish.error = 'TAB_CLOSE_UNCONFIRMED'; snapshot.state = 'needs-reconciliation'; save(); return view(); }
        }
        snapshot.finish.phase = 'done'; snapshot.state = 'closed'; save(); return view();
      });
      return finishPromise;
    },
  };
}
