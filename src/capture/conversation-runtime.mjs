// §15 shared library runtime. Browser effects live in the injected adapter, never GET/list.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { listTargets } from '../cdp/discovery.mjs';
import { getAdapter, ADAPTER_IDS } from '../profiles/sites/index.mjs';
import { listSessions } from '../store/session.mjs';
import { createConversationService, validConversationSnapshot } from './conversation-service.mjs';
import { createConversationBrowserAdapter } from './conversation-browser-adapter.mjs';
import { isPrefixCode, prefixId, preimageDigest, resolvePromptTier, checkPrefixPage, comparePrefixRead, comparePrefixReads,
  prefixGuardSource, sha256Hex, PREFIX_ORIGINS, validPrefixRecord } from './conversation-prefix.mjs';
import { acquireDriveLease } from './drive-lease.mjs';
import { parseThread, threadSupported, THREAD_REF_PATTERN, TRANSCRIPT_LIMITS } from './conversation-thread.mjs';
import { buildCapabilityCapsule } from './conversation-capsule.mjs';
import { captureConversationEvidence } from './conversation-evidence.mjs';
import { readChatIndex } from './chatgpt-chat-index-reader.mjs';
import { ownedFreshTargetIds } from './conversation-ownership.mjs';

const fail = (status, code) => Object.assign(new Error(code), { status, code });
function outward(e) {
  if (e.status) return e;
  return Object.assign(e, { status: /INVALID_|CONFIRM_REQUIRED/.test(e.code ?? '') ? 400 : 409 });
}
// Accounting shape for a lease release that could not be proven complete: the directory may still
// be occupied, so callers keep reporting it instead of silently claiming a free host.
const leaseFailure = (e) => ({ code: /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'LEASE_RELEASE_FAILED',
  at: new Date().toISOString(), message: String(e?.message ?? e).slice(0, 300) });

export function createConversationRuntime({ paths, profileStore, familyStore, port = 9222, dependencies = {} } = {}) {
  const d = { listTargets, getAdapter, createAdapter: createConversationBrowserAdapter, acquireLease: acquireDriveLease,
    listSessions, readChatIndex, captureEvidence: captureConversationEvidence,
    ownerIsAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } },
    maxDurationMs: 15 * 60 * 1000, maxBytes: 256 * 1024 * 1024, sleep, prefixStabilityMs: 1500, ...dependencies };
  const directory = path.join(paths.root, 'conversations');
  mkdirSync(directory, { recursive: true });
  const entries = new Map(); let closed = false;
  const active = () => { if (closed) throw fail(503, 'RUNTIME_CLOSED'); };
  // Denylist refs are per-site thread refs; the exact-prefix bind path below stays ChatGPT-only (its own `chatgpt-c:` check).
  const THREAD_REF = THREAD_REF_PATTERN;
  const CHATGPT_THREAD_REF = /^chatgpt-c:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  async function collectThreadDenylist(site) {
    const refs = new Set();
    const accept = (ref) => { if (THREAD_REF.test(ref ?? '')) refs.add(ref); };
    if (threadSupported(site)) for (const t of await tabs()) accept(parseThread(site, t.url)?.ref);
    for (const priorId of ids()) {
      let prior; try { prior = JSON.parse(readFileSync(path.join(directory, `${priorId}.conversation.json`), 'utf8')); }
      catch { throw fail(409, 'CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
      accept(prior?.binding?.thread?.ref);
    }
    return [...refs];
  }
  function scheduleBudget(entry) {
    if (entry.timer || entry.recovered) return;
    entry.timer = setTimeout(() => {
      entry.service.recordCapture({ limitReason: 'duration-budget' }).then(() => finishEntry(entry)).catch(() => {});
    }, d.maxDurationMs); entry.timer.unref?.();
  }
  // An unreachable DevTools endpoint is an environment condition, not an internal error.
  const tabs = async () => { try { return await d.listTargets({ port }); } catch { throw fail(503, 'BROWSER_UNAVAILABLE'); } };
  const validId = (id) => /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id ?? '');
  const ids = () => readdirSync(directory).filter((n) => n.endsWith('.conversation.json')).map((n) => n.slice(0, -'.conversation.json'.length));
  function load(id) {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id ?? '')) throw fail(400, 'INVALID_CONVERSATION_ID');
    if (entries.has(id)) return entries.get(id);
    if (!ids().includes(id)) throw fail(404, 'CONVERSATION_NOT_FOUND');
    // No browser/recorder reattachment on restart. Owner metadata repairs the attach/save window
    // without making an interrupted capture appear finalized or replaying any action.
    const owned = d.listSessions(paths.sessions).filter((s) => s.conversationOwner?.conversationId === id);
    let header; try { header = JSON.parse(readFileSync(path.join(directory, `${id}.conversation.json`), 'utf8')); }
    catch { throw fail(409, 'CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
    const pid = owned[0]?.conversationOwner?.pid ?? header?.owner?.pid;
    const readOnly = Number.isInteger(pid) && pid > 0 && d.ownerIsAlive(pid);
    const adapter = { async reconcile() { return null; }, async stop() { throw fail(409, 'RECOVERED_CAPTURE_INCOMPLETE'); } };
    const service = createConversationService({ dataDir: directory, id, adapter, recover: !readOnly, context: { restarted: true, recoveredSessionId: owned[0]?.id } });
    const entry = { service, adapter, recovered: true, readOnly, registration: Promise.resolve(), work: Promise.resolve(), lease: null, leaseReleaseError: null };
    entry.writer = writerWindow(entry);
    entries.set(id, entry); return entry;
  }
  // Pure snapshot read: never recovers, saves, attaches or touches the browser. Recovery is the
  // separate explicit mutation (`recover`, or any mutating call such as reconcile/finish/submit).
  function peek(id) {
    if (!validId(id)) throw fail(400, 'INVALID_CONVERSATION_ID');
    if (entries.has(id)) {
      let disk; try { disk = JSON.parse(readFileSync(path.join(directory, `${id}.conversation.json`), 'utf8')); }
      catch { throw fail(409, 'CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
      if (disk?.prefix !== undefined && !validPrefixRecord(disk.prefix)) throw fail(409, 'PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT');
      return entries.get(id);
    }
    if (!ids().includes(id)) throw fail(404, 'CONVERSATION_NOT_FOUND');
    let header; try { header = JSON.parse(readFileSync(path.join(directory, `${id}.conversation.json`), 'utf8')); }
    catch { throw fail(409, 'CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
    let service; try { service = createConversationService({ dataDir: directory, id, adapter: {}, recover: false }); }
    catch (e) { throw fail(409, e.code ?? 'CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
    const pid = header?.owner?.pid;
    return { service, adapter: {}, recovered: false, readOnly: true, pure: true, ownerAlive: Number.isInteger(pid) && pid > 0 && d.ownerIsAlive(pid) };
  }
  // Bounded local evidence telemetry. These are OBSERVATIONS only: no browser effect, no snapshot
  // write, no journal mutation, no acceptance. A failed evidence write is reported on the entry so
  // the view can say so; it can never stop capture, resend, or make an unfinished capture complete.
  function noteEvidence(entry, event, data = {}) {
    entry.evidenceTimeline ??= [];
    entry.evidenceTimeline.push({ at: new Date().toISOString(), event, ...data });
    if (entry.evidenceTimeline.length > 200) entry.evidenceTimeline.splice(0, entry.evidenceTimeline.length - 200);
  }
  function preserveEvidence(entry, trigger) {
    const run = async () => {
      const at = new Date().toISOString();
      try {
        const snapshot = entry.service.read();
        let journal = null, journalError = null;
        try { journal = entry.service.journalSnapshot(); }
        catch (e) { journalError = { code: e?.code ?? 'JOURNAL_UNAVAILABLE', message: String(e?.message ?? e).slice(0, 300) }; }
        const out = await d.captureEvidence({ directory, id: entry.service.id, view: snapshot, journal, journalError,
          trigger, paths, timeline: entry.evidenceTimeline ?? [] });
        entry.evidence = { state: 'preserved', revision: out.revision, at: out.preservedAt ?? at, trigger,
          file: out.file, skipped: out.skipped === true, turns: out.turns, sessions: out.sessions,
          gaps: out.gaps ?? [], failures: out.failures ?? 0 };
      } catch (e) {
        entry.evidence = { state: 'failed', code: /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'EVIDENCE_WRITE_FAILED',
          message: String(e?.message ?? e).slice(0, 300), at, trigger };
      }
    };
    entry.evidenceWork = (entry.evidenceWork ?? Promise.resolve()).then(run, run);
    return entry.evidenceWork;
  }
  function view(entry, summary = false, selectedTurn) {
    const s = entry.service.read(), a = selectedTurn ?? s.attempts.at(-1);
    const pending = !!entry.pure && !s.finish.requested && s.state !== 'disconnected' && !entry.ownerAlive;
    const reply = { ...(a?.reply ?? s.reply) }; if (summary) delete reply.text;
    const turnView = (turn) => {
      const r = { ...turn.reply }; if (summary) delete r.text;
      return { id: turn.id, key: turn.key, conversationId: turn.journal?.conversationId ?? s.id, payloadDigest: turn.payloadDigest,
        phase: turn.phase, reason: turn.reason ?? null, boundary: turn.boundary, baseline: turn.baseline ?? null, cursor: turn.cursor ?? null,
        sessionId: turn.journal?.boundary?.sessionId ?? turn.send?.evidence?.sessionId ?? null, send: structuredClone(turn.send), reply: r,
        readiness: turn.journal?.readiness ?? turn.readiness ?? { state: 'unknown', evidence: null },
        completion: turn.journal?.completion ?? turn.completion ?? { state: 'unknown', evidence: null } };
    };
    const capture = { ...s.capture, bytesWritten: entry.recovered || entry.pure ? s.capture.bytesWritten ?? 0 : entry.adapter.bytesWritten ?? 0 };
    capture.limitReason = entry.adapter.limitReason ?? capture.limitReason;
    if (!entry.recovered && entry.adapter.active === false && capture.state === 'recording') capture.state = 'incomplete';
    if (entry.recovered && !entry.readOnly && capture.state === 'recording') capture.state = 'incomplete';
    return { id: s.id, revision: s.revision, state: s.state, site: s.site, binding: s.binding, sessionId: s.sessionId,
      ...(s.prefix ? { prefix: structuredClone(s.prefix) } : {}),
      turn: a ? turnView(a) : null, turns: s.attempts.map(turnView),
      identity: s.identity, recovery: { pending },
      readiness: s.readiness,
      // writer.active is honest occupancy accounting: true while this conversation holds the
      // window OR while its last release could not be proven complete (the lease directory may
      // still be occupied). releaseError carries the unproven-release code until a later enter()
      // proves a fresh window or a later release succeeds.
      writer: { active: !!(entry.lease || entry.leaseReleaseError), releaseError: entry.leaseReleaseError ?? null },
      diagnostic: { finishPhase: s.finish.phase, finishError: s.finish.error ?? null, uncertainty: s.uncertainty },
      // Additive local evidence summary. null means no checkpoint was attempted yet; failed means the
      // last best-effort write did not land (the capture lifecycle itself is unaffected).
      evidence: entry.evidence ?? null,
      reply, capture, limitations: [...s.limitations, ...(entry.recovered ? ['Recovered snapshot only; interrupted capture ownership requires reconciliation, never automatic replay'] : []),
        ...(pending ? ['Stored snapshot read without recovery; the owning process is gone, so its state is stale until an explicit reconcile, finish or recover'] : [])] };
  }
  function observeReply(entry, attempt = entry.service.read().attempts.at(-1)) {
    if (!attempt || entry.finishing || entry.recovered) return;
    entry.replyWorks ??= new Map();
    if (entry.replyWorks.has(attempt.id)) return entry.replyWorks.get(attempt.id);
    const work = (async () => {
      await entry.service.recordReply({ turnId: attempt.id, state: 'waiting' });
      let writes = Promise.resolve(), ended = false;
      const publish = (update) => {
        if (ended || entry.finishing || update.turnId !== attempt.id) return Promise.resolve();
        writes = writes.then(async () => {
          const saved = await entry.service.recordReply(update);
          if (update.state === 'ready' || update.state === 'interrupted' || update.state === 'unknown') {
            // Only a confirmed stop makes capture idle (a next turn may then arm a fresh one); a failed stop
            // is recorded as incomplete and blocks the next turn instead of pretending it was finalized.
            let stopped = true;
            noteEvidence(entry, 'reply-terminal', { turnId: attempt.id, state: update.state,
              chars: typeof update.text === 'string' ? update.text.length : null,
              sequence: update.evidence?.sequence ?? null, identity: update.evidence?.identity ?? null,
              readiness: update.readiness?.rule ?? null });
            await entry.adapter.stopTurnCapture?.().catch(() => { stopped = false; });
            await entry.service.recordCapture({ state: stopped ? 'idle' : 'incomplete' }).catch(() => {});
            noteEvidence(entry, 'turn-capture-stopped', { turnId: attempt.id, state: stopped ? 'idle' : 'incomplete' });
            await preserveEvidence(entry, 'turn');
          }
          return saved;
        }); return writes;
      };
      try {
        const result = await entry.adapter.readReply(publish, { turnId: attempt.id, payloadDigest: attempt.payloadDigest,
          boundary: attempt.boundary, threadKey: attempt.journal?.threadKey ?? entry.service.threadKey() });
        await writes; ended = true;
        await entry.service.recordReply(entry.finishing ? { turnId: attempt.id, state: 'interrupted' } : { ...result, turnId: attempt.id });
      } catch {
        ended = true; await writes.catch(() => {});
        await entry.service.recordReply({ turnId: attempt.id, state: entry.finishing ? 'interrupted' : 'unknown' });
      }
    })();
    entry.replyWorks.set(attempt.id, work); work.finally(() => { work.settled = true; }).catch(() => {});
    return work;
  }
  async function finishEntry(entry, body = {}) {
    if (entry.readOnly) {
      if (!entry.service.read().finish.requested) throw fail(409, 'CONVERSATION_OWNED_BY_ANOTHER_RUNTIME');
      return view(entry);
    }
    if (body.closeTab !== undefined && typeof body.closeTab !== 'boolean') throw fail(400, 'INVALID_CLOSE_TAB');
    if (entry.finishing) return entry.finishing;
    entry.service.stopSubmission(); // Synchronous latch, including a type operation already in flight.
    entry.finishing = (async () => {
      clearTimeout(entry.timer); entry.adapter.stopWaiting?.();
      await entry.work.catch(() => {});
      await Promise.all([...(entry.replyWorks?.values() ?? [])].map((work) => work.catch(() => {})));
      await entry.service.finish(body);
      await entry.service.recordCapture({ state: 'incomplete', integrity: entry.adapter.integrity ?? null,
        bytesWritten: entry.adapter.bytesWritten ?? 0, limitReason: entry.adapter.limitReason ?? entry.service.read().capture.limitReason });
      // A failed stop leaves resources/lease owned. Do not pretend a later close/restart fixed it.
      if (entry.service.read().finish.captureStopped || entry.service.read().finish.phase === 'done') entry.writer?.release();
      noteEvidence(entry, 'finish', { phase: entry.service.read().finish.phase, requested: entry.service.read().finish.requested });
      // Preserve the finalized local evidence AFTER capture/finish are recorded, and never let this
      // write affect the returned lifecycle truth.
      await preserveEvidence(entry, 'finish');
      return view(entry);
    })();
    return entry.finishing;
  }
  // Failed-connect cleanup. Order matters: (1) the adapter finalizes any half-created session as
  // incomplete and closes only a Studio-created tab with an exact id; (2) only then is the lease
  // released, in every path (a failed connect never keeps the host's single driving lease);
  // (3) anything left behind is written to the snapshot so the user is told. Never throws.
  async function abortFailedConnect(entry, lease) {
    let unaccounted = null;
    try {
      if (!entry) return;
      clearTimeout(entry.timer);
      let out = { captureFinalized: true, tab: 'none' };
      if (typeof entry.adapter.abortConnect === 'function') {
        try { out = await entry.adapter.abortConnect(); } catch { out = { captureFinalized: false, tab: 'kept' }; }
      } else if (entry.adapter.mayOwnResources) out = { captureFinalized: false, tab: 'kept' };
      const notes = [];
      if (out?.tab === 'kept') notes.push('A browser tab opened by Studio for this failed connection could not be confirmed closed and was left open; close it manually');
      else if (out?.tab === 'unconfirmed') notes.push('Studio asked the browser for a new tab but could not confirm it; a blank tab may have been left open - close it manually');
      if (out?.captureFinalized === false) notes.push('Capture could not be finalized after the failed connection; the session is incomplete');
      try { if (entry.service.read().sessionId) await entry.service.recordCapture({ state: 'incomplete', bytesWritten: entry.adapter.bytesWritten ?? 0 }); } catch {}
      for (const note of notes) { try { await entry.service.addLimitation(note); } catch {} }
    } finally {
      // Same accounting as the writer window: a release that cannot be proven is recorded on the
      // entry when one exists, or returned for the caller to attach to the connect error.
      if (entry && entry.lease === lease) entry.writer?.release();
      else try { lease?.release(); } catch (e) { unaccounted = leaseFailure(e); }
    }
    return unaccounted;
  }
  // Short foreground writer window (the documented target model for the drive lease). The host's
  // single driving lease is held only while this conversation can actually drive the page: from
  // just before a turn's typing through delivery observation, and for as long as an unresolved
  // unknown delivery or partial draft exists. A next submit on the same live conversation finds
  // the window already open (enter() refuses) and the journal fence rejects it; a fenced submit
  // that DID open a window — e.g. a fresh conversation sharing the fenced thread — keeps it until
  // reconcile/finish resolves the fence. Passive capture, Read, chat-index and reconcile stay
  // lease-free. enter() returns false when a window is already open — an earlier unresolved turn
  // owns it — and release() drops the handle even if the lease file no longer proves ownership,
  // because the turn journal, not this handle, fences duplicate sends. A RESTARTED runtime never
  // admits new sends (CONVERSATION_NOT_WRITABLE), holds no lease for loaded snapshots, and the
  // next real window open anywhere on the host reclaims a crashed holder's stale lease by the
  // dead-pid proof in drive-lease.
  function writerWindow(entry) {
    return {
      enter() {
        if (entry.lease) return false;
        entry.lease = d.acquireLease({ port, root: d.leaseRoot, holder: { kind: 'conversation-writer', id: entry.service.id } });
        entry.leaseReleaseError = null; // A freshly proven window supersedes any earlier unproven release.
        return true;
      },
      release() {
        const lease = entry.lease; entry.lease = null;
        if (!lease) return;
        try { lease.release(); entry.leaseReleaseError = null; }
        catch (e) {
          // Release failure is ACCOUNTED, never retried here: ownership is unconfirmable
          // (LEASE_OWNER_UNKNOWN), was taken over (LEASE_OWNER_CHANGED) or deletion failed, so the
          // directory may still be occupied. The view keeps reporting an active writer with the
          // code until a later enter() proves a fresh window; a subsequent enter() that hits
          // DRIVE_LEASE_BUSY surfaces the holder instead of wedging silently. The turn journal,
          // not this handle, fences duplicate sends.
          entry.leaseReleaseError = leaseFailure(e);
        }
      },
    };
  }
  // Adoption and activation use the same host lease as browser effects. All snapshot scans,
  // replays and writes happen inside it; neither operation writes the thread journal.
  async function prefixLease(fn) {
    let lease;
    try { lease = d.acquireLease({ port, root: d.leaseRoot, holder: { kind: 'observed-prefix', id: randomUUID() } }); }
    catch (e) { if (e.code === 'DRIVE_LEASE_BUSY') throw fail(409, 'PREFIX_WRITER_BUSY'); throw outward(e); }
    let result, failure;
    try { result = await fn(); } catch (e) { failure = e; }
    try { lease.release(); } catch (e) {
      const detail = leaseFailure(e);
      if (failure) failure.leaseReleaseError = detail;
      else failure = Object.assign(fail(409, 'PREFIX_WRITER_BUSY'), { leaseReleaseError: detail });
    }
    if (failure) throw outward(failure);
    return result;
  }
  function prefixSnapshots(sourceId) {
    return ids().map((id) => {
      let value;
      try { value = JSON.parse(readFileSync(path.join(directory, `${id}.conversation.json`), 'utf8')); }
      catch { throw fail(409, id === sourceId ? 'PREFIX_SOURCE_CORRUPT' : 'PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
      if (!validConversationSnapshot(value, id)) throw fail(409, id === sourceId ? 'PREFIX_SOURCE_CORRUPT' : 'PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT');
      if (value.prefix && (preimageDigest(value.prefix) !== value.prefix.preimageDigest
        || prefixId({ ...value.prefix.source, threadRef: value.prefix.thread.ref, promptDigest: value.prefix.prompt.digest }) !== value.prefix.prefixId)) {
        throw fail(409, value.prefix.state === 'pending' ? 'PREFIX_PENDING_UNRESOLVED' : 'PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT');
      }
      return value;
    });
  }
  function prefixSourceEvidence(records, request, targetId, origin) {
    const source = records.find((s) => s.id === request.conversationId);
    if (!source) throw fail(409, 'PREFIX_SOURCE_MISSING');
    const matches = source.attempts.filter((a) => a.id === request.attemptId);
    if (matches.length !== 1) throw fail(409, 'PREFIX_SOURCE_ATTEMPT_MISSING');
    const attempt = matches[0];
    if (attempt.creation !== true) throw fail(409, 'PREFIX_SOURCE_ATTEMPT_NOT_CREATION');
    if (source.attempts.length !== 1) throw fail(409, 'PREFIX_SOURCE_ATTEMPTS_AMBIGUOUS');
    if (!/^[a-f0-9]{64}$/.test(attempt.payloadDigest ?? '')) throw fail(409, 'PREFIX_SOURCE_DIGEST_INVALID');
    if (attempt.phase !== 'uncertain' || attempt.journal || attempt.send?.state !== 'uncertain') throw fail(409, 'PREFIX_SOURCE_STATE_UNEXPECTED');
    if (!validId(source.sessionId) || source.binding?.targetId !== targetId || source.binding?.origin !== origin || source.binding?.thread || source.site !== 'chatgpt') throw fail(409, 'PREFIX_SESSION_OWNER_MISMATCH');
    let session;
    try { session = JSON.parse(readFileSync(path.join(paths.sessions, source.sessionId, 'session.json'), 'utf8')); }
    catch (e) { throw fail(409, e.code === 'ENOENT' ? 'PREFIX_SOURCE_MISSING' : 'PREFIX_SESSION_METADATA_INVALID'); }
    if (session?.id !== source.sessionId || session.conversationOwner?.conversationId !== source.id) throw fail(409, 'PREFIX_SESSION_OWNER_MISMATCH');
    if (['recording', 'stopping'].includes(session.status)) throw fail(409, 'PREFIX_SESSION_STILL_RECORDING');
    if (!['complete', 'complete_with_integrity_warnings', 'incomplete'].includes(session.status) || !Number.isFinite(Date.parse(session.endedAt))
      || typeof session.endReason !== 'string' || !session.endReason || !session.integrity || typeof session.integrity !== 'object') throw fail(409, 'PREFIX_SESSION_METADATA_INVALID');
    let kv = null;
    try { kv = JSON.parse(readFileSync(path.join(paths.sessions, source.sessionId, 'kv', `CONVERSATION_ATTEMPT_${request.attemptId}.json`), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw fail(409, 'PREFIX_SOURCE_KV_MISMATCH'); }
    if (kv && (kv.payloadDigest !== attempt.payloadDigest || kv.boundary?.sessionId !== source.sessionId
      || kv.boundary?.sequence !== attempt.boundary?.sequence || kv.boundary?.transcriptCount !== attempt.boundary?.transcriptCount
      || typeof kv.prompt !== 'string' || sha256Hex(kv.prompt) !== attempt.payloadDigest || kv.creation !== true || kv.turnId !== attempt.id)) throw fail(409, 'PREFIX_SOURCE_KV_MISMATCH');
    return { source, attempt, session, kv, corroboration: session.status === 'incomplete' ? 'terminal-incomplete' : 'terminal-complete' };
  }
  function prefixThreadFence(records, threadRef, sourceId, currentId = null) {
    for (const s of records) {
      if (s.id === currentId) continue;
      if (Array.isArray(s.threadDenylist) && s.threadDenylist.includes(threadRef)) throw fail(409, 'PREFIX_THREAD_DENYLISTED');
      if (s.id !== sourceId && (s.binding?.thread?.ref === threadRef || s.prefix?.thread?.ref === threadRef)) throw fail(409, 'PREFIX_THREAD_BOUND_ELSEWHERE');
    }
  }
  function checkPrefixRequest(body, sourceField = 'source') {
    const source = body[sourceField];
    if (body.site !== 'chatgpt' || typeof body.targetId !== 'string' || !body.targetId || body.targetId.length > 256
      || !CHATGPT_THREAD_REF.test(body.expectedThread ?? '') || !source || typeof source !== 'object' || Array.isArray(source)
      || !validId(source.conversationId) || !validId(source.attemptId)
      || body.promptAttestation !== undefined && (typeof body.promptAttestation !== 'string' || body.promptAttestation.length > 250000)) throw fail(400, 'INVALID_PREFIX_REQUEST');
    if (sourceField === 'prefixSource' && !/^[a-f0-9]{64}$/.test(source.payloadDigest ?? '')) throw fail(400, 'INVALID_PREFIX_REQUEST');
  }
  function prefixMatch(records, request, expectedThread, targetId, attestation) {
    const found = records.filter((s) => s.prefix?.source.conversationId === request.conversationId && s.prefix?.source.attemptId === request.attemptId);
    if (found.length > 1) throw fail(409, 'PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT');
    if (!found.length) return null;
    const p = found[0].prefix;
    if (p.thread.ref !== expectedThread) throw fail(409, 'PREFIX_SOURCE_ALREADY_ADOPTED');
    if (p.target.targetId !== targetId || request.payloadDigest && request.payloadDigest !== p.prompt.digest
      || attestation !== undefined && sha256Hex(attestation) !== p.prompt.digest) throw fail(409, 'PREFIX_IDEMPOTENCY_CONFLICT');
    if (p.state === 'invalidated') throw fail(409, 'PREFIX_INVALIDATED');
    return found[0];
  }
  async function prefixRead(adapter, targetId, origin, threadRef) {
    try {
      const page = await adapter.readPrefixEvidence({ targetId, origin, expectedThread: threadRef });
      checkPrefixPage(page); return page;
    } catch (e) { throw fail(409, isPrefixCode(e.code) ? e.code : e.code === 'TARGET_RECORDER_BUSY' ? 'PREFIX_SESSION_STILL_RECORDING' : 'PREFIX_PAGE_UNREADABLE'); }
  }
  const readStamp = (page) => ({ at: new Date().toISOString(), assistantDigest: sha256Hex(page.messages[1].text), controls: 'idle' });
  async function verifyPrefixReads(adapter, { targetId, origin, threadRef }, saved = null) {
    const first = await prefixRead(adapter, targetId, origin, threadRef);
    if (saved && comparePrefixRead(saved, first)) throw fail(409, 'PREFIX_PENDING_UNRESOLVED');
    await d.sleep(d.prefixStabilityMs);
    let second;
    try { second = await prefixRead(adapter, targetId, origin, threadRef); }
    catch (e) { if (['PREFIX_TARGET_URL_UNSUPPORTED', 'PREFIX_TARGET_NOT_FOUND', 'PREFIX_THREAD_ID_MISMATCH', 'PREFIX_TARGET_ORIGIN_MISMATCH'].includes(e.code)) throw fail(409, 'PREFIX_TARGET_CHANGED'); throw e; }
    const changed = comparePrefixReads(first, second);
    if (changed) throw fail(409, changed);
    if (saved && comparePrefixRead(saved, second)) throw fail(409, 'PREFIX_PENDING_UNRESOLVED');
    return { first, second, reads: [readStamp(first), readStamp(second)] };
  }
  async function bindPrefix(body) {
    active(); checkPrefixRequest(body);
    return prefixLease(async () => {
      const records = prefixSnapshots(body.source.conversationId);
      const previous = prefixMatch(records, body.source, body.expectedThread, body.targetId, body.promptAttestation);
      if (previous?.prefix.state === 'active') return view(peek(previous.id));
      const siteAdapter = await d.getAdapter(body.site);
      if (!siteAdapter?.url) throw fail(409, 'PREFIX_TARGET_ORIGIN_MISMATCH');
      let targets; try { targets = await tabs(); } catch { throw fail(409, 'PREFIX_TARGET_NOT_FOUND'); }
      const target = targets.find((t) => t.id === body.targetId);
      if (!target) throw fail(409, 'PREFIX_TARGET_NOT_FOUND');
      if (target.type !== 'page') throw fail(409, 'PREFIX_TARGET_NOT_PAGE');
      let origin; try { origin = new URL(target.url).origin; } catch { throw fail(409, 'PREFIX_TARGET_ORIGIN_MISMATCH'); }
      if (!PREFIX_ORIGINS.includes(origin) || origin !== new URL(siteAdapter.url).origin) throw fail(409, 'PREFIX_TARGET_ORIGIN_MISMATCH');
      const source = prefixSourceEvidence(records, body.source, body.targetId, origin);
      prefixThreadFence(records, body.expectedThread, source.source.id, previous?.id);
      const id = previous?.id ?? randomUUID();
      const existing = entries.get(id);
      const adapter = existing?.adapter ?? d.createAdapter({ paths, profileStore, familyStore, port, siteAdapter, targetId: body.targetId,
        freshTab: false, conversationId: id, ownerToken: null, maxBytes: d.maxBytes });
      let retained = !!existing;
      try {
        const sampled = await verifyPrefixReads(adapter, { targetId: body.targetId, origin, threadRef: body.expectedThread }, previous?.prefix);
        const prompt = resolvePromptTier({ digest: source.attempt.payloadDigest, kv: source.kv, pageUserText: sampled.first.messages[0].text,
          attestation: body.promptAttestation ?? null, corroboration: source.corroboration });
        if (previous) return view(peek(id));
        const [user, assistant] = sampled.first.messages;
        const prefix = { kind: 'observed-prefix', schema: 1, state: 'pending',
          prefixId: prefixId({ ...body.source, threadRef: body.expectedThread, promptDigest: prompt.digest }),
          source: { ...body.source, sessionId: source.source.sessionId, phase: 'uncertain', journalless: true },
          thread: sampled.first.thread, target: { targetId: body.targetId, origin }, prompt,
          userMessage: { id: user.id, index: 0, digest: sha256Hex(user.text), chars: user.text.length },
          assistant: { id: assistant.id, index: 1, digest: sha256Hex(assistant.text), chars: assistant.text.length, completion: 'observed-complete' },
          sendActor: 'unknown', dispatch: 'unknown', account: 'unknown', arrival: 'page-observed',
          capture: { sessionId: source.source.sessionId, status: source.session.status, endReason: source.session.endReason,
            integrityOk: source.session.integrity.ok === true, corroboration: source.corroboration },
          reads: sampled.reads, observedAt: new Date().toISOString(), adoptedAt: null };
        prefix.preimageDigest = preimageDigest(prefix);
        const service = createConversationService({ dataDir: directory, id, adapter, io: d.io, recover: false,
          context: { site: body.site, owner: { pid: process.pid, token: null, port } } });
        const entry = { service, adapter, lease: null, registration: Promise.resolve(), work: Promise.resolve(), recovered: false, leaseReleaseError: null };
        entry.writer = writerWindow(entry);
        try { await service.stagePrefix(prefix); } catch (e) { if (e.code === 'PERSISTENCE_FAILED_REOPEN_REQUIRED') throw fail(409, 'PREFIX_PERSISTENCE_FAILED_REOPEN_REQUIRED'); throw e; }
        entries.set(id, entry); retained = true;
        return view(entry);
      } finally { if (!retained) await adapter.closePrefixReader?.().catch(() => {}); }
    });
  }
  async function connectPrefix(body) {
    active(); checkPrefixRequest(body, 'prefixSource');
    if (body.freshTab === true) throw fail(400, 'INVALID_TARGET_SELECTION');
    return prefixLease(async () => {
      const records = prefixSnapshots(body.prefixSource.conversationId);
      const stored = prefixMatch(records, body.prefixSource, body.expectedThread, body.targetId);
      if (!stored) throw fail(409, 'LEGACY_ATTEMPT_REQUIRES_RECONCILIATION');
      const p = stored.prefix;
      if (p.state === 'active') return view(peek(stored.id));
      if (stored.state !== 'disconnected' || stored.binding || stored.finish.requested || stored.attempts.length) throw fail(409, 'PREFIX_PENDING_UNRESOLVED');
      const source = prefixSourceEvidence(records, body.prefixSource, body.targetId, p.target.origin);
      if (!prefixGuardSource({ prefixSource: body.prefixSource, sourceSnapshot: source.source, prefixRecords: [stored], origin: p.target.origin, threadRef: body.expectedThread })) throw fail(409, 'LEGACY_ATTEMPT_REQUIRES_RECONCILIATION');
      prefixThreadFence(records, p.thread.ref, source.source.id, stored.id);
      for (const other of records) {
        if (other.id === source.source.id || other.id === stored.id) continue;
        if (other.binding?.origin === p.target.origin && (!other.binding.thread || other.binding.thread.ref === p.thread.ref)
          && other.attempts.some((a) => !a.journal && (a.phase !== 'blocked' || a.typingStartedAt))) throw fail(409, 'LEGACY_ATTEMPT_REQUIRES_RECONCILIATION');
      }
      let entry = entries.get(stored.id);
      if (entry && (entry.service.read().revision !== stored.revision || entry.service.read().prefix?.state !== 'pending')) throw fail(409, 'PREFIX_PENDING_UNRESOLVED');
      if (!entry && Number.isInteger(stored.owner?.pid) && d.ownerIsAlive(stored.owner.pid)) throw fail(409, 'PREFIX_WRITER_BUSY');
      const siteAdapter = await d.getAdapter(body.site);
      if (!siteAdapter?.url || new URL(siteAdapter.url).origin !== p.target.origin) throw fail(409, 'PREFIX_TARGET_ORIGIN_MISMATCH');
      if (!entry) {
        const adapter = d.createAdapter({ paths, profileStore, familyStore, port, siteAdapter, targetId: body.targetId,
          freshTab: false, conversationId: stored.id, ownerToken: null, maxBytes: d.maxBytes });
        const service = createConversationService({ dataDir: directory, id: stored.id, adapter, io: d.io, recover: false });
        entry = { service, adapter, lease: null, registration: Promise.resolve(), work: Promise.resolve(), recovered: false, leaseReleaseError: null };
        entry.writer = writerWindow(entry);
        await service.claimPrefixOwner({ pid: process.pid, token: null, port });
        entries.set(stored.id, entry);
      }
      try {
        const attached = await entry.service.connect({ targetId: p.target.targetId, origin: p.target.origin, ownedByStudio: false,
          thread: p.thread, identity: { state: 'bound', reason: null }, expectedRevision: entry.service.read().revision });
        if (!attached.readiness?.ready) throw fail(409, 'PREFIX_INVALIDATED');
        const page = await prefixRead(entry.adapter, p.target.targetId, p.target.origin, p.thread.ref);
        if (comparePrefixRead(p, page)) throw fail(409, 'PREFIX_INVALIDATED');
        await entry.service.activatePrefix({ prefixId: p.prefixId, reads: [...p.reads, readStamp(page)] });
        return view(entry);
      } catch (e) {
        try { await entry.service.invalidatePrefix('PREFIX_INVALIDATED'); } catch { /* poisoned state remains non-sendable */ }
        await entry.adapter.closePrefixReader?.().catch(() => {});
        throw fail(409, 'PREFIX_INVALIDATED');
      }
    });
  }
  return {
    // Read-only journal snapshot through the owning service (pure snapshot when the conversation
    // is not open). Used by the Round 7 uncertain-step reconciliation; never mutates anything.
    journalSnapshot(id) {
      active();
      const entry = entries.has(id) ? entries.get(id) : peek(id);
      return entry.service.journalSnapshot();
    },
    async chatIndex(body) {
      active();
      // Explicit observation only: the reader owns/detaches its own CDP session. No conversation,
      // recorder, drive lease, journal or target binding is created by this operation.
      return d.readChatIndex(body, { port, listTargets: d.listTargets,
        ...(d.openIndexSession ? { openSession: d.openIndexSession } : {}),
        ...(d.evaluateIndex ? { evaluate: d.evaluateIndex } : {}) });
    },
    // @serves 004,014
    async targets() {
      active();
      const sites = (await Promise.all(ADAPTER_IDS.map(async (id) => { const a = await d.getAdapter(id); return a ? { id, adapter: a.id, url: a.url } : null; }))).filter(Boolean);
      const targets = [];
      const discovered = await tabs();
      const ownedTargetIds = ownedFreshTargetIds(entries.values(), discovered);
      // Target discovery needs recording ownership metadata, never raw capture sizes.
      // A newly reopened browser with no AI tabs needs no session-disk scan at all.
      const recordings = discovered.some(t => String(t.url ?? '').startsWith('https:'))
        ? d.listSessions(paths.sessions, { includeRawBytes: false }).filter((s) => ['recording', 'stopping'].includes(s.status)) : [];
      for (const t of discovered) {
        if (t.type && t.type !== 'page') continue;
        let url; try { url = new URL(t.url); } catch { continue; }
        if (url.protocol !== 'https:') continue;
        const a = await d.getAdapter(url.href); if (!a || !ADAPTER_IDS.includes(a.id)) continue;
        const recording = recordings.find((s) => s.target?.id === t.id);
        // Identity comes from the URL path only. The tab title is deliberately neither read nor returned.
        const thread = parseThread(a.id, t.url);
        const identity = threadSupported(a.id) ? (thread ? { state: 'bound', reason: null } : { state: 'unverified', reason: 'UNSUPPORTED_PATH' }) : { state: 'unbound', reason: 'SITE_UNSUPPORTED' };
        targets.push({ id: t.id, targetId: t.id, site: a.id, url: url.origin, title: a.id, thread, identity,
          ownedByStudio: ownedTargetIds.has(t.id), recorderOwner: recording ? { sessionId: recording.id, kind: recording.conversationOwner ? 'conversation' : 'unknown' } : null, visibility: 'unknown' });
      }
      return { sites, targets };
    },
    async list() { return [...new Set([...ids(), ...entries.keys()])].map((id) => view(peek(id), true)).sort((a, b) => b.id.localeCompare(a.id)); },
    async get(id) { return view(peek(id)); },
    // The explicit recovery mutation (what list/get no longer do). Same seam reconcile/finish/submit already use.
    async recover(id) { active(); return view(load(id)); },
    // Zero-send Read of the live conversation's current visible transcript. Never writes the snapshot,
    // never loads/recovers, never types or sends. Recovered or foreign-owned snapshots have no live page.
    async read(id, body = {}) {
      active();
      if (!validId(id)) throw fail(400, 'INVALID_CONVERSATION_ID');
      const unknown = Object.keys(body ?? {}).filter((k) => !['maxMessages', 'maxChars'].includes(k));
      const L = TRANSCRIPT_LIMITS, count = (v, spec) => v === undefined ? spec.default : v;
      const maxMessages = count(body.maxMessages, L.maxMessages), maxChars = count(body.maxChars, L.maxChars);
      if (unknown.length || !Number.isSafeInteger(maxMessages) || maxMessages < L.maxMessages.min || maxMessages > L.maxMessages.max
        || !Number.isSafeInteger(maxChars) || maxChars < L.maxChars.min || maxChars > L.maxChars.max) throw fail(400, 'INVALID_READ');
      const entry = entries.get(id);
      if (!entry) { if (!ids().includes(id)) throw fail(404, 'CONVERSATION_NOT_FOUND'); throw fail(409, 'READ_REQUIRES_LIVE_CONVERSATION'); }
      if (entry.recovered || entry.readOnly) throw fail(409, 'READ_REQUIRES_LIVE_CONVERSATION');
      const s = entry.service.read();
      if (s.finish.requested || entry.finishing) throw fail(409, 'CONVERSATION_FINISHED');
      if (s.identity?.state === 'unverified') throw fail(409, 'THREAD_IDENTITY_UNVERIFIED');
      if (typeof entry.adapter.readTranscript !== 'function') throw fail(501, 'READ_UNAVAILABLE');
      let out;
      try { out = await entry.adapter.readTranscript({ maxMessages, maxChars, perMessageCap: Math.min(L.perMessageCap, maxChars) }); }
      catch (e) { throw e?.status ? e : fail(409, /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'READ_FAILED'); }
      const now = entry.service.read();
      if (!out?.transcript || out.binding?.targetId !== now.binding?.targetId || out.binding?.origin !== now.binding?.origin
        || (out.binding?.thread?.ref ?? null) !== (now.binding?.thread?.ref ?? null)) throw fail(409, 'BINDING_CHANGED');
      return { conversationId: id, revision: now.revision, readAt: new Date().toISOString(),
        binding: { targetId: now.binding.targetId, origin: now.binding.origin, thread: now.binding.thread?.ref ?? null }, identity: now.identity, ...out.transcript };
    },
    // Pure read: never loads/recovers an entry, never writes a snapshot, never throws. Anything that
    // cannot be proven finished (corrupt/unreadable snapshot or directory) counts as active so no
    // caller can steal or replay a session that may still be owned.
    isSessionActive(id, request = {}) {
      if (!id) return false;
      // This id is used for one direct metadata read below, never a directory scan.
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) return true;
      const finished = (s) => s.finish.captureStopped === true || s.finish.phase === 'done';
      try {
        // A World request checks many sessions. Read each ownership journal once for
        // that request, not once per session (and again for each search page).
        if (!request.sessionActivity) {
          const snapshot = { sessions: new Set(), pendingOwners: new Set(), uncertain: false };
          const memory = new Map([...entries].map(([key, entry]) => [key, entry.service.read()]));
          for (const key of new Set([...memory.keys(), ...ids()])) {
            let s;
            try { s = memory.get(key) ?? JSON.parse(readFileSync(path.join(directory, `${key}.conversation.json`), 'utf8')); }
            catch { snapshot.uncertain = true; break; }
            if (!s || typeof s !== 'object' || !s.finish || typeof s.finish !== 'object') { snapshot.uncertain = true; break; }
            if (finished(s)) continue;
            if (s.sessionId) snapshot.sessions.add(s.sessionId);
            else snapshot.pendingOwners.add(key);
          }
          request.sessionActivity = snapshot;
        }
        const snapshot = request.sessionActivity;
        if (snapshot.uncertain || snapshot.sessions.has(id)) return true;
        if (snapshot.pendingOwners.size) {
          const owned = JSON.parse(readFileSync(path.join(paths.sessions, id, 'session.json'), 'utf8'));
          if (snapshot.pendingOwners.has(owned.conversationOwner?.conversationId)) return true;
        }
        return false;
      } catch { return true; }
    },
    async bindObservedPrefix(body = {}) { return bindPrefix(body); },
    // @serves 003,011,093
    async connect(body = {}) {
      active();
      if (body.prefixSource !== undefined) return connectPrefix(body);
      if (!ADAPTER_IDS.includes(body.site) || body.freshTab !== undefined && typeof body.freshTab !== 'boolean'
        || body.targetId !== undefined && (typeof body.targetId !== 'string' || !body.targetId)
        || body.expectedThread !== undefined && (typeof body.expectedThread !== 'string' || !body.expectedThread || body.expectedThread.length > 200)) throw fail(400, 'INVALID_CONNECT');
      const freshTab = body.freshTab ?? !body.targetId;
      if (freshTab && body.targetId || !freshTab && !body.targetId) throw fail(400, 'INVALID_TARGET_SELECTION');
      if (freshTab && body.expectedThread !== undefined) throw fail(400, 'INVALID_CONNECT');
      const siteAdapter = await d.getAdapter(body.site);
      if (!siteAdapter?.url) throw fail(400, 'SITE_ADAPTER_UNAVAILABLE');
      let origin = new URL(siteAdapter.url).origin;
      // Fresh Studio-owned tab = unbound NEW_CHAT until a new /c UUID is pinned. Existing home,
      // project or other non-/c tabs stay unverified and can never send.
      let thread = null, identity = { state: 'unverified', reason: 'SITE_UNSUPPORTED' }, threadDenylist;
      if (freshTab) {
        identity = { state: 'unbound', reason: 'NEW_CHAT' };
        threadDenylist = await collectThreadDenylist(body.site);
      } else {
        const target = (await tabs()).find((t) => t.id === body.targetId);
        if (!target) throw fail(404, 'TARGET_NOT_FOUND');
        const matched = await d.getAdapter(target.url);
        if (matched?.id !== body.site || new URL(target.url).protocol !== 'https:') throw fail(409, 'TARGET_SITE_MISMATCH');
        origin = new URL(target.url).origin;
        if (threadSupported(body.site)) {
          thread = parseThread(body.site, target.url);
          identity = thread ? { state: 'bound', reason: null } : { state: 'unverified', reason: 'UNSUPPORTED_PATH' };
        }
        if (body.expectedThread !== undefined) {
          if (!thread) throw fail(409, 'THREAD_IDENTITY_UNVERIFIED');
          if (thread.ref !== body.expectedThread) throw fail(409, 'BINDING_CHANGED');
        }
      }
      // Historic one-turn snapshots without durable thread admission cannot be bypassed by a new record.
      // The fence needs attribution: the thread recorded in the snapshot, or the thread named by the
      // capture session it points at. An attempt with neither names no thread and has no journal to
      // reconcile against, so it must not lock every thread on the origin forever.
      const priorThreadRef = (prior) => {
        if (prior.binding?.thread?.ref) return prior.binding.thread.ref;
        if (!validId(prior.sessionId)) return null;
        try {
          const url = JSON.parse(readFileSync(path.join(paths.sessions, prior.sessionId, 'session.json'), 'utf8'))?.target?.url;
          return typeof url === 'string' ? parseThread(prior.site ?? 'chatgpt', url)?.ref ?? null : null;
        } catch { return null; }
      };
      if (thread) for (const priorId of ids()) {
        let prior; try { prior = JSON.parse(readFileSync(path.join(directory, `${priorId}.conversation.json`), 'utf8')); }
        catch { throw fail(409, 'CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
        if (prior.binding?.origin === origin && priorThreadRef(prior) === thread.ref
          && prior.attempts?.some((a) => !a.journal && (a.phase !== 'blocked' || a.typingStartedAt))) throw fail(409, 'LEGACY_ATTEMPT_REQUIRES_RECONCILIATION');
        if (prior.binding?.origin === origin && prior.binding.thread?.ref === thread.ref && prior.attempts?.some((a) => a.journal)) peek(priorId).service.read();
      }
      const id = randomUUID();
      // Foreground driving windows on the host's single driving lease: (1) a fresh Studio-owned
      // tab drives the browser during connect (tab creation + navigation) and releases the lease
      // once the idle tab exists; (2) typing/dispatching drives the page inside the per-turn
      // writer window, which stays open until delivery is observed or the turn's outcome is
      // unresolved (writerWindow). An existing-tab attach arms read-only observation only (idle
      // page attach, deferred capture) and takes no lease.
      const lease = freshTab ? d.acquireLease({ port, root: d.leaseRoot, holder: { kind: 'conversation', id } }) : null;
      let entry;
      try {
        const adapter = d.createAdapter({ paths, profileStore, familyStore, port, siteAdapter, targetId: body.targetId,
          freshTab, conversationId: id, ownerToken: lease?.token ?? null, maxBytes: d.maxBytes });
        const service = createConversationService({ dataDir: directory, id, adapter, io: d.io,
          context: { site: body.site, owner: { pid: process.pid, token: lease?.token ?? null, port }, capture: { endsAt: new Date(Date.now() + d.maxDurationMs).toISOString(), maxBytes: d.maxBytes, bytesWritten: 0, limitReason: null } } });
        entry = { service, adapter, lease, registration: Promise.resolve(), work: Promise.resolve(), recovered: false, leaseReleaseError: null };
        entry.writer = writerWindow(entry);
        entries.set(id, entry);
        await service.connect({ targetId: body.targetId ?? `pending-${id}`, origin, ownedByStudio: freshTab, thread, identity, ...(freshTab ? { threadDenylist } : {}), expectedRevision: service.read().revision });
        // Ephemeral provenance is set only by this runtime's fresh connect, after the
        // adapter bound Chrome's returned exact target ID. Recovery cannot reconstruct it.
        const connected = service.read();
        if (freshTab && connected.binding?.ownedByStudio === true
          && connected.binding.targetId !== `pending-${id}` && connected.binding.origin === origin) {
          entry.freshTargetProvenance = { targetId: connected.binding.targetId, origin };
        }
        entry.writer.release(); // The idle fresh tab keeps no driving lease between turns.
        return view(entry);
      } catch (e) {
        const unaccounted = await abortFailedConnect(entry, lease);
        const leaseReleaseError = entry?.leaseReleaseError ?? unaccounted;
        throw Object.assign(outward(e), { conversationId: id,
          ...(leaseReleaseError ? { leaseReleaseError } : {}) });
      }
    },
    // @serves 021,022,023,098
    async submit(id, body = {}) {
      active();
      if (typeof body.key !== 'string' || !body.key || body.key.length > 200 || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 250000) throw fail(400, 'INVALID_SUBMISSION');
      // Inspect before load/recovery: an idempotent POST on a restarted runtime is a pure read too.
      const stored = peek(id);
      try {
        const replay = stored.service.lookupRequest({ key: body.key, payloadDigest: createHash('sha256').update(body.prompt, 'utf8').digest('hex') });
        if (replay) return view(stored, false, replay);
      } catch (e) { throw outward(e); }
      const prefixState = stored.service.read().prefix?.state;
      if (prefixState === 'pending') throw fail(409, 'PREFIX_NOT_ACTIVE');
      if (prefixState === 'invalidated') throw fail(409, 'PREFIX_INVALIDATED');
      const entry = load(id);
      const registered = entry.registration.then(async () => {
        const s = entry.service.read(), original = s.attempts.find((a) => a.key === body.key);
        // Idempotent replay is a pure read and is honoured even when the conversation is finished,
        // restart-recovered or owned by another runtime: it never dispatches and never writes.
        if (original) {
          if (original.payloadDigest !== createHash('sha256').update(body.prompt, 'utf8').digest('hex')) throw fail(409, 'IDEMPOTENCY_CONFLICT');
          return view(entry, false, original);
        }
        if (s.finish.requested || entry.finishing) throw fail(409, 'CONVERSATION_FINISHED');
        if (entry.recovered) throw fail(409, 'CONVERSATION_NOT_WRITABLE');
        // A completed previous turn may still be stopping its own capture; the next turn starts only after that
        // work settled (never two captures at once). An unresolved previous turn is not waited for: the thread
        // journal fences it (THREAD_FENCED) and the uncertain-send lock stays.
        const prior = s.attempts.at(-1);
        if (prior?.send.state === 'observed' && prior.journal?.readiness?.state === 'ready') await entry.work.catch(() => {});
        scheduleBudget(entry); // The duration clock starts at explicit send, not at idle connect.
        let resolve, reject;
        const ack = new Promise((yes, no) => { resolve = yes; reject = no; });
        const execution = entry.service.submit(body, { registered: (_, attempt) => { if (!s.prefix) resolve(view(entry, false, attempt)); }, writer: entry.writer });
        entry.work = execution.then(async (attempt) => {
          if (s.prefix) resolve(view(entry, false, attempt));
          // Reply attribution starts only after a bound, observed delivery. A creation send that
          // never pinned does not reach send.state observed, so it does not read a reply.
          try {
            if (attempt.send.state === 'observed') noteEvidence(entry, 'turn-observed', { turnId: attempt.id,
              sessionId: attempt.send.evidence?.sessionId ?? null, sequence: attempt.send.evidence?.sequence ?? null,
              source: attempt.send.evidence?.kind ?? null });
            if (attempt.send.state === 'observed' && !entry.finishing && entry.service.read().attempts.some((a) => a.id === attempt.id)) await observeReply(entry, attempt);
          } finally {
            if (!entry.finishing) {
              await entry.adapter.stopTurnCapture?.().catch(() => {});
              await preserveEvidence(entry, 'turn');
            }
          }
        }).catch(async (e) => {
          await entry.adapter.stopTurnCapture?.().catch(() => {});
          reject(outward(e));
        });
        execution.catch((e) => reject(outward(e)));
        return ack;
      });
      entry.registration = registered.then(() => {}, () => {});
      return registered;
    },
    async reconcile(id, body = {}) {
      const entry = load(id);
      if (entry.readOnly) throw fail(409, 'CONVERSATION_OWNED_BY_ANOTHER_RUNTIME');
      if (entry.finishing) await entry.finishing;
      try {
        await entry.service.reconcile(body, { writer: entry.writer });
        const attempt = body.turnId ? entry.service.read().attempts.find((a) => a.id === body.turnId) : entry.service.read().attempts.at(-1);
        if (attempt?.send.state === 'observed') {
          // Explicit reconciliation may restart a completed read-only observer for this exact turn.
          if (entry.replyWorks?.get(attempt.id)?.settled) entry.replyWorks.delete(attempt.id);
          observeReply(entry, attempt);
        }
        return view(entry);
      } catch (e) { throw outward(e); }
    },
    async finish(id, body = {}) { try { return await finishEntry(load(id), body); } catch (e) { throw outward(e); } },
    // Page-local capability capsule: what this conversation can do NOW per the runtime's own
    // evidence. Advisory only; every gate is re-checked at effect time by the same runtime.
    async capsule(id) {
      const entry = peek(id);
      const snapshot = view(entry, true);
      const profile = snapshot.site ? await d.getAdapter(snapshot.site) : null;
      return buildCapabilityCapsule({ view: snapshot, profile: profile && profile.id === snapshot.site ? profile : null });
    },
    async close() {
      closed = true;
      // Every live entry is finalized on close, lease or not: an idle connected conversation may
      // hold no driving lease between turns, but its recorder still needs an explicit stop.
      await Promise.all([...entries.values()].filter((e) => !e.recovered).map((entry) =>
        entry.service.read().prefix?.state === 'pending' && entry.service.read().state === 'disconnected'
          ? entry.adapter.closePrefixReader?.() : finishEntry(entry)));
    },
  };
}
