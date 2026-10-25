/**
 * Local metadata only; no actuator, transcript bodies, automatic recovery writes or browser retries.
 * All clients for an owner MUST share dataDir + namespace + canonical origin/thread. Conversation,
 * target and capture-session ids are deliberately NOT the thread's exclusion/idempotency scope.
 *
 * reserve -> markTyping(boundary) -> markDispatching must each return successfully BEFORE its
 * corresponding effect. A returned replay is NOT a new effect permit: only the caller that created
 * an admitted reservation may progress it, using its turn revision. reserve returns {admitted,turn};
 * admitted=false always means inspection/reconciliation only. Effect transitions also require the
 * same journal instance that admitted the turn; reopen never resumes typing/submission. This
 * journal does not replace the runtime's live driver lease across the actual browser effects.
 * Every unresolved reservation fences its thread, including after a crash before/after an effect.
 * Interactive admission requires positive delivery + turn-owned reply + versioned adapter
 * readiness (stable reply metadata AND positively observed idle/terminal generation controls).
 * Strict 'network-completion' mode additionally requires network terminal completion. Neither
 * mode admits unknown delivery. A trusted positive no-effects audit may permit a fresh key;
 * 'not found', timeout, notDispatched alone, user assertion or DOM quiet cannot.
 * Readiness is cached evidence, NOT current browser authorization: runtime MUST freshly preflight
 * exact thread, current reply identity/revision/content, generation controls and empty draft after
 * reserve and immediately before typing; re-preflight before dispatch if binding/control state
 * may have changed. Never perform an effect on stale preflight or a replayed/loaded turn.
 *
 * Evidence methods are INTERNAL trusted-adapter inputs, not public user assertion endpoints.
 * An actuator-audit proof must positively establish BOTH typing and dispatch never executed;
 * the journal validates attribution/shape, not the truth of an external proof reference.
 * Delivery, reply revisions, interactive readiness and terminal completion are independent. No
 * completion is inferred from DOM stability; terminal completion requires network evidence.
 * The internal adapter's fixed readiness rule must observe the SAME identity/revision/SHA-256
 * content digest/JS character count in two ordered samples, with current exact-thread controls
 * and observed delivery FIRST; both samples must be strictly after its captured sequence,
 * positively idle/terminal at the latter sample. Two quiet samples or absent Stop alone are NOT
 * the rule. New reply revisions clear readiness; readiness never asserts capture acceptance.
 * Evidence identity/reference fields are opaque durable IDs, never text; capture-local IDs must
 * be capture-qualified by the adapter. One outgoing/reply identity cannot belong to two turns.
 * Files use flushed atomic replacement + final-file fsync, as in conversation-service. Directory
 * fsync is not portable on Windows: no power-loss/host-filesystem losslessness claim is made.
 * Schema v2 persists admissionMode; older/incompatible stores are rejected, never auto-upgraded
 * or silently reopened under a weaker policy. Thread-key/file identity is unchanged by policy.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireDriveLease } from './drive-lease.mjs';

const now = () => new Date().toISOString();
const error = (code) => Object.assign(new Error(code), { code });
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const phases = ['preparing', 'typing', 'dispatching', 'unknown', 'blocked', 'delivered'];
const MAX_TURNS = 1000; // Never evict old request keys to make room for a retry.
const ADMISSION_MODES = ['interactive-ready', 'network-completion'];
export const INTERACTIVE_READINESS_RULE = Object.freeze({ id: 'chatgpt-controls-idle', version: 1 });

export function digestTurnPayload(payload) {
  if (typeof payload !== 'string' || !payload.length) throw error('INVALID_TURN_PAYLOAD');
  return hash(payload);
}

export function canonicalThreadKey({ namespace, origin, thread } = {}) {
  let url;
  try { url = new URL(origin); } catch { throw error('INVALID_THREAD_SCOPE'); }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (typeof namespace !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(namespace)
    || url.protocol !== 'https:' || url.origin !== origin || thread?.kind !== 'chatgpt-c'
    || typeof thread.id !== 'string' || !uuid.test(thread.id) || thread.ref !== `chatgpt-c:${thread.id}`) throw error('INVALID_THREAD_SCOPE');
  return JSON.stringify(['thread-turn-journal-v1', namespace, origin, thread.ref]);
}

const validBoundary = (b) => !!b && id(b.sessionId) && count(b.sequence) && count(b.transcriptCount);
function attributed(e, a) {
  return !!e && !!a.boundary && e.turnId === a.id && e.payloadDigest === a.payloadDigest
    && e.sessionId === a.boundary.sessionId && count(e.sequence) && e.sequence > a.boundary.sequence && id(e.identity);
}
function validDelivery(e, a) {
  return attributed(e, a) && (e.kind === 'outgoing-request' && e.source === 'network' || e.kind === 'new-user-turn' && e.source === 'page');
}
function validReply(e, a, complete = false) {
  return attributed(e, a) && e.kind === (complete ? 'reply-complete' : 'assistant-reply')
    && (e.source === 'network' || !complete && e.source === 'page') && Number.isSafeInteger(e.revision) && e.revision > 0
    && (complete || digest(e.contentDigest) && count(e.chars));
}
const sameReplyMetadata = (a, b) => !!a && !!b && a.identity === b.identity && a.revision === b.revision
  && a.contentDigest === b.contentDigest && a.chars === b.chars;
function validReadiness(e, a, threadKey) {
  const r = a.reply.evidence;
  return attributed(e, a) && e.kind === 'interactive-ready' && e.source === 'adapter'
    && e.rule === INTERACTIVE_READINESS_RULE.id && e.ruleVersion === INTERACTIVE_READINESS_RULE.version
    && e.threadKey === threadKey && e.boundarySequence === a.boundary.sequence
    && a.delivery.state === 'observed' && a.reply.state === 'observed' && sameReplyMetadata(e, r) && e.chars > 0
    && (!a.readiness.evidence || e.sequence >= a.readiness.evidence.sequence)
    && Array.isArray(e.samples) && e.samples.length === 2
    && e.samples.every((sample) => sameReplyMetadata(sample, r) && count(sample.sequence)
      && sample.sequence >= r.sequence && sample.sequence > a.delivery.evidence.sequence)
    && e.samples[0].sequence < e.samples[1].sequence && e.sequence === e.samples[1].sequence
    && e.controls?.observed === true && ['idle', 'terminal'].includes(e.controls.state)
    && e.controls.idleControlPresent === true && e.controls.stopPresent === false && e.controls.composerEnabled === true;
}
function validProof(e, a) {
  return !!e && e.turnId === a.id && e.payloadDigest === a.payloadDigest && e.kind === 'pre-effect-blocked'
    && e.source === 'actuator-audit' && id(e.reference) && e.typing === 'not-executed' && e.dispatch === 'not-executed';
}
function evidenceView(e, withRevision = false, withContent = false) {
  return { turnId: e.turnId, payloadDigest: e.payloadDigest, sessionId: e.sessionId, sequence: e.sequence,
    kind: e.kind, source: e.source, identity: e.identity, ...(withRevision ? { revision: e.revision } : {}),
    ...(withContent ? { contentDigest: e.contentDigest, chars: e.chars } : {}) };
}
function readinessView(e) {
  return { ...evidenceView(e, true, true), boundarySequence: e.boundarySequence, threadKey: e.threadKey,
    rule: e.rule, ruleVersion: e.ruleVersion,
    samples: e.samples.map((sample) => ({ sequence: sample.sequence, identity: sample.identity, revision: sample.revision,
      contentDigest: sample.contentDigest, chars: sample.chars })),
    controls: { observed: e.controls.observed, state: e.controls.state, idleControlPresent: e.controls.idleControlPresent,
      stopPresent: e.controls.stopPresent, composerEnabled: e.controls.composerEnabled } };
}
const resolved = (a, mode) => a.phase === 'blocked' || a.delivery.state === 'observed'
  && a.reply.state === 'observed' && a.readiness.state === 'ready'
  && (mode !== 'network-completion' || a.completion.state === 'complete');

function validTurn(a, threadKey) {
  if (!a || !id(a.id) || !id(a.key) || !id(a.conversationId) || !digest(a.payloadDigest)
    || !Number.isSafeInteger(a.revision) || a.revision < 1 || !phases.includes(a.phase)
    || !date(a.createdAt) || !date(a.updatedAt) || !(a.boundary === null || validBoundary(a.boundary))
    || !['unknown', 'observed'].includes(a.delivery?.state) || !['unknown', 'observed'].includes(a.reply?.state)
    || !['unknown', 'complete'].includes(a.completion?.state) || !['unknown', 'ready'].includes(a.readiness?.state)) return false;
  if ((a.phase === 'delivered') !== (a.delivery.state === 'observed')) return false;
  if (a.delivery.state === 'observed' ? !validDelivery(a.delivery.evidence, a) : a.delivery.evidence !== null) return false;
  if (a.reply.state === 'observed' ? !validReply(a.reply.evidence, a) : a.reply.evidence !== null) return false;
  if (a.completion.state === 'complete' ? !validReply(a.completion.evidence, a, true) : a.completion.evidence !== null) return false;
  if (a.readiness.state === 'ready' ? !validReadiness(a.readiness.evidence, a, threadKey) : a.readiness.evidence !== null) return false;
  if (a.reply.evidence && a.completion.evidence && (a.reply.evidence.identity !== a.completion.evidence.identity || a.reply.evidence.revision !== a.completion.evidence.revision)) return false;
  if (a.phase === 'blocked') {
    if (!validProof(a.preEffect, a) || a.delivery.evidence || a.reply.evidence || a.completion.evidence) return false;
  } else if (a.preEffect !== null) return false;
  if (['typing', 'dispatching', 'delivered'].includes(a.phase) && !a.boundary) return false;
  if (a.phase === 'preparing' && (a.boundary || a.delivery.evidence || a.reply.evidence || a.completion.evidence)) return false;
  if (a.phase === 'typing' && (a.delivery.evidence || a.reply.evidence || a.completion.evidence)) return false;
  return a.reason === null || typeof a.reason === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(a.reason);
}
function validSnapshot(s, threadKey) {
  if (!s || s.version !== 2 || s.threadKey !== threadKey || !ADMISSION_MODES.includes(s.admissionMode)
    || !count(s.revision) || !date(s.createdAt) || !date(s.updatedAt)
    || !Array.isArray(s.turns) || s.turns.length > MAX_TURNS || !s.turns.every((a) => validTurn(a, threadKey))) return false;
  if (new Set(s.turns.map((a) => a.id)).size !== s.turns.length || new Set(s.turns.map((a) => a.key)).size !== s.turns.length) return false;
  for (const identities of [s.turns.flatMap((a) => a.delivery.evidence ? [a.delivery.evidence.identity] : []),
    s.turns.flatMap((a) => a.reply.evidence || a.completion.evidence ? [(a.reply.evidence ?? a.completion.evidence).identity] : [])]) {
    if (new Set(identities).size !== identities.length) return false;
  }
  if (s.turns.reduce((sum, a) => sum + a.revision, 0) !== s.revision) return false;
  // A late reply revision may invalidate an earlier turn after a follow-up was reserved.
  // Every unresolved turn, not merely the latest, fences new reservations/effect transitions.
  return true;
}

export function createThreadTurnJournal({ dataDir, namespace, origin, thread, admissionMode = 'interactive-ready', io = fs } = {}) {
  const threadKey = canonicalThreadKey({ namespace, origin, thread });
  if (!ADMISSION_MODES.includes(admissionMode)) throw error('INVALID_ADMISSION_MODE');
  if (typeof dataDir !== 'string' || !dataDir) throw error('INVALID_JOURNAL_DIRECTORY');
  dataDir = path.resolve(dataDir);
  const name = hash(threadKey), file = path.join(dataDir, `${name}.turn-journal.json`);
  // A private, per-thread root reuses the existing cross-process mkdir/owner-token primitive.
  // Port 1 is only a lock slot here, not a CDP endpoint or the host-global browser driving lease.
  const lockRoot = path.join(dataDir, '.thread-turn-locks', name);
  let poisoned = false;
  const admittedHere = new Set();
  function load() {
    let envelope;
    try { envelope = JSON.parse(io.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') { const at = now(); return { version: 2, threadKey, admissionMode, revision: 0, turns: [], createdAt: at, updatedAt: at }; }
      throw error('CORRUPT_OR_UNREADABLE_JOURNAL');
    }
    if (!envelope || !digest(envelope.checksum) || hash(JSON.stringify(envelope.snapshot) ?? '') !== envelope.checksum
      || !validSnapshot(envelope.snapshot, threadKey)) throw error('CORRUPT_OR_UNREADABLE_JOURNAL');
    if (envelope.snapshot.admissionMode !== admissionMode) throw error('ADMISSION_MODE_MISMATCH');
    return envelope.snapshot;
  }
  function save(snapshot) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      if (!validSnapshot(snapshot, threadKey)) throw error('INVALID_JOURNAL_STATE');
      io.mkdirSync(dataDir, { recursive: true });
      fd = io.openSync(temporary, 'wx', 0o600);
      io.writeFileSync(fd, `${JSON.stringify({ checksum: hash(JSON.stringify(snapshot)), snapshot })}\n`);
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      io.renameSync(temporary, file);
      fd = io.openSync(file, 'r+'); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    } catch {
      poisoned = true;
      throw error('JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED');
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      try { io.unlinkSync(temporary); } catch {}
    }
  }
  function healthy() { if (poisoned) throw error('JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED'); }
  function transaction(fn) {
    healthy();
    let lease;
    try { lease = acquireDriveLease({ root: lockRoot, port: 1, holder: { kind: 'thread-turn-journal', id: name } }); }
    catch (e) { if (e.code === 'DRIVE_LEASE_BUSY') throw error('THREAD_JOURNAL_BUSY'); throw e; }
    try { return fn(load()); }
    finally {
      try { lease.release(); }
      catch { poisoned = true; throw error('JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED'); }
    }
  }
  function update({ turnId, expectedRevision } = {}, fn) {
    return transaction((snapshot) => {
      const a = snapshot.turns.find((a) => a.id === turnId);
      if (!a) throw error('TURN_NOT_FOUND');
      if (a.revision !== expectedRevision) throw error('STALE_REVISION');
      if (fn(a, snapshot) !== false) {
        if (snapshot.revision === Number.MAX_SAFE_INTEGER) throw error('JOURNAL_LIMIT');
        a.revision++; a.updatedAt = now(); snapshot.revision++; snapshot.updatedAt = a.updatedAt;
        save(snapshot);
      }
      return structuredClone(a);
    });
  }
  function original(snapshot, key, payloadDigest) {
    const a = snapshot.turns.find((a) => a.key === key);
    if (a && a.payloadDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT');
    return a;
  }
  const evidencePhase = (a) => {
    if (!['dispatching', 'unknown', 'delivered'].includes(a.phase)) throw error('INVALID_TURN_TRANSITION');
  };
  function checkEvidenceOwner(snapshot, a, e, outgoing = false) {
    if (snapshot.turns.some((other) => other.id !== a.id && (outgoing
      ? other.delivery.evidence?.identity === e.identity
      : (other.reply.evidence ?? other.completion.evidence)?.identity === e.identity))) throw error('EVIDENCE_IDENTITY_ALREADY_OWNED');
  }
  load(); // Fail closed on open; no creation, recovery or phase rewriting.
  return {
    file, threadKey, admissionMode,
    read: () => structuredClone(load()),
    // A last-moment synchronous check, NOT an atomic transaction with a browser/CDP effect.
    assertEffectAllowed({ turnId, expectedRevision, phase } = {}) {
      healthy();
      if (!admittedHere.has(turnId)) throw error('TURN_NOT_ADMITTED_BY_THIS_CLIENT');
      const snapshot = load(), a = snapshot.turns.find((a) => a.id === turnId);
      if (!a || a.revision !== expectedRevision) throw error('STALE_REVISION');
      if (!['typing', 'dispatching'].includes(phase) || a.phase !== phase) throw error('INVALID_TURN_TRANSITION');
      if (snapshot.turns.some((other) => other.id !== turnId && !resolved(other, admissionMode))) throw error('THREAD_FENCED');
      return structuredClone(a);
    },
    reserve({ key, payloadDigest, conversationId } = {}) {
      healthy();
      if (!id(key) || !id(conversationId) || !digest(payloadDigest)) throw error('INVALID_RESERVATION');
      // Existing keys do not acquire a write lease or modify the saved journal.
      const replay = original(load(), key, payloadDigest);
      if (replay) return { admitted: false, turn: structuredClone(replay) };
      const result = transaction((snapshot) => {
        const raced = original(snapshot, key, payloadDigest);
        if (raced) return { admitted: false, turn: structuredClone(raced) };
        if (snapshot.turns.some((a) => !resolved(a, admissionMode))) throw error('THREAD_FENCED');
        if (snapshot.turns.length >= MAX_TURNS || snapshot.revision === Number.MAX_SAFE_INTEGER) throw error('JOURNAL_LIMIT');
        const at = now(), a = { id: randomUUID(), key, conversationId, payloadDigest, revision: 1, phase: 'preparing',
          boundary: null, delivery: { state: 'unknown', evidence: null }, reply: { state: 'unknown', evidence: null },
          completion: { state: 'unknown', evidence: null }, readiness: { state: 'unknown', evidence: null },
          preEffect: null, reason: null, createdAt: at, updatedAt: at };
        snapshot.turns.push(a); snapshot.revision++; snapshot.updatedAt = at;
        save(snapshot); return { admitted: true, turn: structuredClone(a) };
      });
      if (result.admitted) admittedHere.add(result.turn.id);
      return result;
    },
    markTyping(options = {}) {
      if (!admittedHere.has(options.turnId)) throw error('TURN_NOT_ADMITTED_BY_THIS_CLIENT');
      return update(options, (a, snapshot) => {
        if (a.phase !== 'preparing') throw error('INVALID_TURN_TRANSITION');
        if (snapshot.turns.some((other) => other.id !== a.id && !resolved(other, admissionMode))) throw error('THREAD_FENCED');
        if (!validBoundary(options.boundary)) throw error('INVALID_BOUNDARY');
        const b = options.boundary;
        a.boundary = { sessionId: b.sessionId, sequence: b.sequence, transcriptCount: b.transcriptCount };
        a.phase = 'typing';
      });
    },
    markDispatching(options = {}) {
      if (!admittedHere.has(options.turnId)) throw error('TURN_NOT_ADMITTED_BY_THIS_CLIENT');
      return update(options, (a, snapshot) => {
        if (a.phase !== 'typing') throw error('INVALID_TURN_TRANSITION');
        if (snapshot.turns.some((other) => other.id !== a.id && !resolved(other, admissionMode))) throw error('THREAD_FENCED');
        a.phase = 'dispatching';
      });
    },
    markUnknown(options = {}) {
      return update(options, (a) => {
        if (!['preparing', 'typing', 'dispatching', 'unknown'].includes(a.phase)) throw error('INVALID_TURN_TRANSITION');
        if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(options.reason ?? '')) throw error('INVALID_UNCERTAINTY_REASON');
        a.phase = 'unknown'; a.reason = options.reason;
      });
    },
    provePreEffect(options = {}) {
      return update(options, (a) => {
        if (a.phase === 'blocked' || a.delivery.evidence || a.reply.evidence || a.completion.evidence) throw error('INVALID_TURN_TRANSITION');
        const e = options.evidence;
        if (!validProof(e, a)) throw error('INVALID_PRE_EFFECT_EVIDENCE');
        a.preEffect = { turnId: e.turnId, payloadDigest: e.payloadDigest, kind: e.kind, source: e.source,
          reference: e.reference, typing: e.typing, dispatch: e.dispatch };
        a.phase = 'blocked'; a.reason = null;
      });
    },
    observeDelivery(options = {}) {
      return update(options, (a, snapshot) => {
        evidencePhase(a);
        const e = options.evidence;
        if (!validDelivery(e, a)) throw error('INVALID_DELIVERY_EVIDENCE');
        checkEvidenceOwner(snapshot, a, e, true);
        if (a.delivery.evidence) {
          if (a.delivery.evidence.identity !== e.identity) throw error('DELIVERY_IDENTITY_CONFLICT');
          return false;
        }
        a.delivery = { state: 'observed', evidence: evidenceView(e) }; a.phase = 'delivered'; a.reason = null;
        if (a.readiness.state === 'ready' && !validReadiness(a.readiness.evidence, a, threadKey)) a.readiness = { state: 'unknown', evidence: null };
      });
    },
    recordReply(options = {}) {
      return update(options, (a, snapshot) => {
        evidencePhase(a);
        const e = options.evidence;
        if (!validReply(e, a)) throw error('INVALID_REPLY_EVIDENCE');
        checkEvidenceOwner(snapshot, a, e);
        const previous = a.reply.evidence, terminal = a.completion.evidence;
        if (previous && previous.identity !== e.identity || terminal && terminal.identity !== e.identity) throw error('REPLY_IDENTITY_CONFLICT');
        if (previous && previous.revision > e.revision || terminal && terminal.revision !== e.revision) throw error('REPLY_REVISION_CONFLICT');
        if (previous?.revision === e.revision) {
          if (!sameReplyMetadata(previous, e)) throw error('REPLY_REVISION_CONFLICT');
          return false;
        }
        if (previous && e.sequence <= previous.sequence) throw error('REPLY_REVISION_CONFLICT');
        a.reply = { state: 'observed', evidence: evidenceView(e, true, true) };
        a.readiness = { state: 'unknown', evidence: null };
      });
    },
    recordReadiness(options = {}) {
      return update(options, (a) => {
        evidencePhase(a);
        const e = options.evidence;
        if (!validReadiness(e, a, threadKey)) throw error('INVALID_READINESS_EVIDENCE');
        const evidence = readinessView(e);
        if (JSON.stringify(a.readiness.evidence) === JSON.stringify(evidence)) return false;
        a.readiness = { state: 'ready', evidence };
      });
    },
    // Fence-only invalidation: a new capture can disprove cached readiness without pretending its
    // observation came from the old attempt's capture session. This never changes delivery/reply.
    invalidateReadiness(options = {}) {
      return update(options, (a) => {
        if (a.readiness.state === 'unknown') return false;
        a.readiness = { state: 'unknown', evidence: null };
      });
    },
    recordCompletion(options = {}) {
      return update(options, (a, snapshot) => {
        evidencePhase(a);
        const e = options.evidence;
        if (!validReply(e, a, true)) throw error('INVALID_COMPLETION_EVIDENCE');
        checkEvidenceOwner(snapshot, a, e);
        const previous = a.completion.evidence, observed = a.reply.evidence;
        if (previous && previous.identity !== e.identity || observed && observed.identity !== e.identity) throw error('REPLY_IDENTITY_CONFLICT');
        if (previous && previous.revision !== e.revision || observed && observed.revision !== e.revision) throw error('REPLY_REVISION_CONFLICT');
        if (previous) return false;
        a.completion = { state: 'complete', evidence: evidenceView(e, true) };
      });
    },
  };
}
