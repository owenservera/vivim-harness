// §15 shared library runtime. Browser effects live in the injected adapter, never GET/list.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { listTargets } from '../cdp/discovery.mjs';
import { getAdapter, ADAPTER_IDS } from '../profiles/sites/index.mjs';
import { listSessions } from '../store/session.mjs';
import { createConversationService } from './conversation-service.mjs';
import { createConversationBrowserAdapter } from './conversation-browser-adapter.mjs';
import { acquireDriveLease } from './drive-lease.mjs';
import { parseThread, threadSupported, TRANSCRIPT_LIMITS } from './conversation-thread.mjs';
import { buildCapabilityCapsule } from './conversation-capsule.mjs';
import { captureConversationEvidence } from './conversation-evidence.mjs';
import { readChatIndex } from './chatgpt-chat-index-reader.mjs';

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
    maxDurationMs: 15 * 60 * 1000, maxBytes: 256 * 1024 * 1024, ...dependencies };
  const directory = path.join(paths.root, 'conversations');
  mkdirSync(directory, { recursive: true });
  const entries = new Map(); let closed = false;
  const active = () => { if (closed) throw fail(503, 'RUNTIME_CLOSED'); };
  const THREAD_REF = /^chatgpt-c:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
    if (entries.has(id)) return entries.get(id);
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
    async targets() {
      active();
      const sites = (await Promise.all(ADAPTER_IDS.map(async (id) => { const a = await d.getAdapter(id); return a ? { id, adapter: a.id, url: a.url } : null; }))).filter(Boolean);
      const targets = [];
      const recordings = d.listSessions(paths.sessions).filter((s) => ['recording', 'stopping'].includes(s.status));
      for (const t of await tabs()) {
        if (t.type && t.type !== 'page') continue;
        let url; try { url = new URL(t.url); } catch { continue; }
        if (url.protocol !== 'https:') continue;
        const a = await d.getAdapter(url.href); if (!a || !ADAPTER_IDS.includes(a.id)) continue;
        const recording = recordings.find((s) => s.target?.id === t.id);
        // Identity comes from the URL path only. The tab title is deliberately neither read nor returned.
        const thread = parseThread(a.id, t.url);
        const identity = threadSupported(a.id) ? (thread ? { state: 'bound', reason: null } : { state: 'unverified', reason: 'UNSUPPORTED_PATH' }) : { state: 'unbound', reason: 'SITE_UNSUPPORTED' };
        targets.push({ id: t.id, targetId: t.id, site: a.id, url: url.origin, title: a.id, thread, identity,
          ownedByStudio: false, recorderOwner: recording ? { sessionId: recording.id, kind: recording.conversationOwner ? 'conversation' : 'unknown' } : null, visibility: 'unknown' });
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
    isSessionActive(id) {
      if (!id) return false;
      const finished = (s) => s.finish.captureStopped === true || s.finish.phase === 'done';
      try {
        const memory = new Map([...entries].map(([key, entry]) => [key, entry.service.read()]));
        for (const [key, s] of memory) if (s.sessionId === id && !finished(s)) return true;
        let owned;
        for (const key of ids()) {
          if (memory.has(key)) continue;
          let s; try { s = JSON.parse(readFileSync(path.join(directory, `${key}.conversation.json`), 'utf8')); } catch { return true; }
          if (!s || typeof s !== 'object' || !s.finish || typeof s.finish !== 'object') return true;
          if (finished(s)) continue;
          if (s.sessionId === id) return true;
          if (!s.sessionId) { // attach/save window: the owner id lives only in the recorder's session metadata
            owned ??= d.listSessions(paths.sessions);
            if (owned.some((x) => x.id === id && x.conversationOwner?.conversationId === key)) return true;
          }
        }
        return false;
      } catch { return true; }
    },
    async connect(body = {}) {
      active();
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
      if (thread) for (const priorId of ids()) {
        let prior; try { prior = JSON.parse(readFileSync(path.join(directory, `${priorId}.conversation.json`), 'utf8')); }
        catch { throw fail(409, 'CORRUPT_OR_UNREADABLE_SNAPSHOT'); }
        if (prior.binding?.origin === origin && (!prior.binding.thread || prior.binding.thread.ref === thread.ref)
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
        entry.writer.release(); // The idle fresh tab keeps no driving lease between turns.
        return view(entry);
      } catch (e) {
        const unaccounted = await abortFailedConnect(entry, lease);
        const leaseReleaseError = entry?.leaseReleaseError ?? unaccounted;
        throw Object.assign(outward(e), { conversationId: id,
          ...(leaseReleaseError ? { leaseReleaseError } : {}) });
      }
    },
    async submit(id, body = {}) {
      active();
      if (typeof body.key !== 'string' || !body.key || body.key.length > 200 || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 250000) throw fail(400, 'INVALID_SUBMISSION');
      // Inspect before load/recovery: an idempotent POST on a restarted runtime is a pure read too.
      const stored = peek(id);
      try {
        const replay = stored.service.lookupRequest({ key: body.key, payloadDigest: createHash('sha256').update(body.prompt, 'utf8').digest('hex') });
        if (replay) return view(stored, false, replay);
      } catch (e) { throw outward(e); }
      const entry = load(id);
      const registered = entry.registration.then(async () => {
        if (typeof body.key !== 'string' || !body.key || body.key.length > 200 || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 250000) throw fail(400, 'INVALID_SUBMISSION');
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
        const execution = entry.service.submit(body, { registered: (_, attempt) => resolve(view(entry, false, attempt)), writer: entry.writer });
        entry.work = execution.then(async (attempt) => {
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
      await Promise.all([...entries.values()].filter((e) => !e.recovered).map((entry) => finishEntry(entry)));
    },
  };
}
