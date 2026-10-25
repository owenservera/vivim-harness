/**
 * Bounded local engineering-evidence preservation for one conversation.
 *
 * This module is a READER of the runtime's existing private evidence. It never touches the
 * browser, never mutates the conversation snapshot or the thread journal, never admits/observes
 * a turn, and never grants acceptance. It writes one small, versioned checkpoint file next to
 * the conversation snapshot:
 *
 *   <paths.root>/conversations/<conversationId>.evidence.json
 *
 * A checkpoint preserves EXACT references (paths + sha256 + revisions + native turn ids) to:
 *   - the conversation snapshot revision that was current at preservation time,
 *   - the thread-turn journal revision and its turns (delivery/reply/readiness/completion),
 *   - every capture session referenced by those turns (session.json, raw manifest segments,
 *     dataset pointers/hashes, selected kv evidence pointers/hashes),
 *   - the runtime's own bounded timing observations,
 * plus honest coverage: UI / knowledge / outcome are 'unknown' because the runtime has no
 * observation that would justify anything stronger. Capture completion is never acceptance.
 *
 * Failures (missing files, unreadable hashes, unbound identity, oversized files) are recorded
 * inside the checkpoint. A failed write itself is reported to the caller, which treats it as
 * best-effort lifecycle telemetry. It cannot stop capture, resend anything, or mark a capture
 * finalized.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { canonicalThreadKey } from './thread-turn-journal.mjs';

export const EVIDENCE_SCHEMA = 'aion.conversation-evidence/1';
export const EVIDENCE_VERSION = 1;
export const EVIDENCE_SUFFIX = '.evidence.json';

export const EVIDENCE_LIMITS = Object.freeze({
  maxHashBytes: 8 * 1024 * 1024, // per file; larger files keep size/pointer but no digest
  maxSessions: 16,
  maxDatasets: 24,
  maxKvFiles: 16,
  maxHistory: 16,
  maxTimeline: 200,
});

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const nowIso = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const failure = (stage, code, message) => ({ stage, code: String(code ?? 'EVIDENCE_FAILURE').slice(0, 80), message: String(message ?? '').slice(0, 300) });
const rel = (root, file) => path.relative(root, file).replaceAll('\\', '/');

export function evidenceFileFor(directory, conversationId) {
  if (typeof directory !== 'string' || !directory) throw new Error('EVIDENCE_DIRECTORY_REQUIRED');
  if (!ID_RE.test(conversationId ?? '')) throw new Error('INVALID_CONVERSATION_ID');
  return path.join(directory, `${conversationId}${EVIDENCE_SUFFIX}`);
}

function boundedFile(file, { io, maxHashBytes }) {
  let stat;
  try { stat = io.statSync(file); }
  catch (e) { return { present: false, reason: e?.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE', error: String(e?.code ?? e?.message ?? e) }; }
  if (!stat.isFile()) return { present: false, reason: 'NOT_A_FILE' };
  const out = { present: true, bytes: stat.size, sha256: null };
  if (stat.size > maxHashBytes) { out.reason = 'HASH_SIZE_CAP'; return out; }
  try { out.sha256 = sha256(io.readFileSync(file)); }
  catch (e) { out.reason = 'READ_FAILED'; out.error = String(e?.code ?? e?.message ?? e); }
  return out;
}

function readJsonFile(file, { io, failures, stage }) {
  let raw;
  try { raw = io.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e?.code !== 'ENOENT') failures.push(failure(stage, e?.code ?? 'READ_FAILED', `${rel(path.dirname(path.dirname(file)), file)}: ${e?.message ?? e}`));
    return { state: 'absent', value: null };
  }
  try { return { state: 'present', value: JSON.parse(raw) }; }
  catch (e) {
    failures.push(failure(stage, 'CORRUPT_JSON', `${file}: ${e?.message ?? e}`));
    return { state: 'unreadable', value: null };
  }
}

function within(root, candidate) {
  const a = path.resolve(root), b = path.resolve(candidate);
  return b === a || b.startsWith(a + path.sep);
}

function journalReference({ directory, view, io, maxHashBytes, failures }) {
  const thread = view?.binding?.thread;
  if (!thread || view?.identity?.state !== 'bound') {
    return { state: 'unavailable', reason: view?.identity?.state === 'bound' ? 'NO_BOUND_THREAD' : 'THREAD_IDENTITY_UNVERIFIED' };
  }
  let name;
  try { name = `${sha256(canonicalThreadKey({ namespace: 'local-owner', origin: view.binding.origin, thread }))}.turn-journal.json`; }
  catch (e) {
    failures.push(failure('journal', e?.code ?? 'INVALID_THREAD_SCOPE', e?.message ?? String(e)));
    return { state: 'unavailable', reason: 'INVALID_THREAD_SCOPE' };
  }
  const file = path.join(directory, 'thread-turns', name);
  const pointer = { state: 'referenced', path: rel(directory, file), ...boundedFile(file, { io, maxHashBytes }) };
  return pointer;
}

function collectSessionIds(view, journal) {
  const ids = new Set();
  const accept = (value) => { if (typeof value === 'string' && ID_RE.test(value)) ids.add(value); };
  accept(view?.sessionId);
  for (const turn of journal?.turns ?? []) {
    accept(turn?.boundary?.sessionId);
    accept(turn?.delivery?.evidence?.sessionId);
    accept(turn?.reply?.evidence?.sessionId);
    accept(turn?.completion?.evidence?.sessionId);
    accept(turn?.readiness?.evidence?.sessionId);
  }
  for (const turn of view?.attempts ?? []) {
    accept(turn?.boundary?.sessionId);
    accept(turn?.send?.evidence?.sessionId);
    accept(turn?.reply?.evidence?.sessionId);
    accept(turn?.journal?.boundary?.sessionId);
  }
  return [...ids];
}

const KV_KEYS = ['STATE', 'DOM_TURNS', 'DOM_INSPECT', 'ASSEMBLED', 'KNOWLEDGE_STATUS', 'RECEIPT', 'STREAM_DOM_JOIN', 'STREAM_COMPONENTS'];

function sessionEvidence({ sessionsRoot, sessionId, turnIds, io, limits, failures, root }) {
  const out = { sessionId, pointer: null, present: false };
  if (!sessionsRoot) { out.reason = 'SESSIONS_ROOT_UNAVAILABLE'; return out; }
  const dir = path.join(sessionsRoot, sessionId);
  if (!within(sessionsRoot, dir)) { out.reason = 'INVALID_SESSION_PATH'; failures.push(failure('session', 'INVALID_SESSION_PATH', sessionId)); return out; }
  let stat;
  try { stat = io.statSync(dir); }
  catch (e) { out.reason = e?.code === 'ENOENT' ? 'SESSION_DIRECTORY_MISSING' : 'SESSION_DIRECTORY_UNREADABLE'; return out; }
  if (!stat.isDirectory()) { out.reason = 'NOT_A_DIRECTORY'; return out; }
  out.present = true;
  out.pointer = sessionsRoot ? rel(root, dir).replaceAll('\\', '/') : null;
  out.reason = null;

  const meta = readJsonFile(path.join(dir, 'session.json'), { io, failures, stage: 'session.meta' });
  if (meta.state === 'present') {
    const m = meta.value ?? {};
    out.meta = { id: m.id ?? sessionId, site: m.site ?? null, createdAt: m.createdAt ?? null, endedAt: m.endedAt ?? null,
      status: m.status ?? null, endReason: m.endReason ?? null, target: m.target ? { id: m.target.id ?? null, url: m.target.url ?? null } : null,
      integrity: m.integrity ?? null, conversationOwner: m.conversationOwner ? { conversationId: m.conversationOwner.conversationId ?? null, pid: m.conversationOwner.pid ?? null, port: m.conversationOwner.port ?? null } : null,
      rawRecords: m.stats?.raw?.records ?? null, rawBytes: m.stats?.raw?.bytes ?? null,
      network: m.stats?.network ? { requests: m.stats.network.requests ?? null, streamed: m.stats.network.streamed ?? null, chunks: m.stats.network.chunks ?? null, armFailed: m.stats.network.armFailed ?? null, retrospective: m.stats.network.retrospective ?? null } : null,
      dom: m.stats?.dom ? { batches: m.stats.dom.batches ?? null, mutations: m.stats.dom.mutations ?? null, agentStarts: m.stats.dom.agentStarts ?? null } : null };
    out.metaFile = boundedFile(path.join(dir, 'session.json'), { io, maxHashBytes: limits.maxHashBytes });
  } else out.meta = null;

  const manifest = readJsonFile(path.join(dir, 'raw', 'manifest.json'), { io, failures, stage: 'session.raw' });
  out.raw = { manifest: boundedFile(path.join(dir, 'raw', 'manifest.json'), { io, maxHashBytes: limits.maxHashBytes }),
    segments: Array.isArray(manifest.value?.segments) ? manifest.value.segments.slice(0, 32).map((s) => ({
      file: s.file ?? null, bytes: s.bytes ?? null, records: s.records ?? null, firstSeq: s.firstSeq ?? null, lastSeq: s.lastSeq ?? null,
      sha256: s.sha256 ?? null, present: typeof s.file === 'string' ? (() => { try { return io.statSync(path.join(dir, 'raw', s.file)).isFile(); } catch { return false; } })() : false,
    })) : [], streams: boundedFile(path.join(dir, 'raw', 'streams.json'), { io, maxHashBytes: limits.maxHashBytes }) };

  const datasetDir = path.join(dir, 'datasets');
  let names = [];
  try { names = io.readdirSync(datasetDir).filter((n) => n.endsWith('.jsonl')).sort(); } catch { /* no derived datasets */ }
  out.datasets = names.slice(0, limits.maxDatasets).map((name) => ({
    name: name.slice(0, -'.jsonl'.length),
    path: rel(root, path.join(datasetDir, name)),
    ...boundedFile(path.join(datasetDir, name), { io, maxHashBytes: limits.maxHashBytes }),
  }));
  if (names.length > limits.maxDatasets) out.datasetsOmitted = names.length - limits.maxDatasets;

  const kvDir = path.join(dir, 'kv');
  const wanted = [...KV_KEYS, ...turnIds.map((id) => `CONVERSATION_ATTEMPT_${id}`)];
  out.kv = wanted.slice(0, limits.maxKvFiles).map((key) => {
    const file = path.join(kvDir, `${key}.json`);
    return { key, path: rel(root, file), ...boundedFile(file, { io, maxHashBytes: limits.maxHashBytes }) };
  }).filter((x) => x.present);
  return out;
}

function turnProjection(turn) {
  const j = turn?.journal ?? turn;
  return { id: j?.id ?? turn?.id ?? null, key: j?.key ?? turn?.key ?? null, conversationId: j?.conversationId ?? turn?.conversationId ?? null,
    payloadDigest: j?.payloadDigest ?? turn?.payloadDigest ?? null, revision: j?.revision ?? null, phase: j?.phase ?? turn?.phase ?? null,
    reason: j?.reason ?? turn?.reason ?? null, createdAt: j?.createdAt ?? turn?.createdAt ?? null, updatedAt: j?.updatedAt ?? turn?.updatedAt ?? null,
    boundary: j?.boundary ?? turn?.boundary ?? null,
    delivery: j?.delivery ?? (turn?.send?.evidence ? { state: turn.send.state, evidence: turn.send.evidence } : null) ?? null,
    reply: j?.reply ?? (turn?.reply?.evidence ? { state: 'observed', evidence: turn.reply.evidence } : null) ?? null,
    readiness: j?.readiness ?? turn?.readiness ?? null, completion: j?.completion ?? turn?.completion ?? null };
}

function deriveGaps({ view, journal, journalState, sessions }) {
  const gaps = [];
  const turns = journal?.turns ?? view?.attempts ?? [];
  for (const turn of turns) {
    const t = turnProjection(turn);
    if (t.delivery?.state === 'observed' && !t.reply?.evidence) gaps.push({ code: 'REPLY_NOT_OBSERVED', turnId: t.id, sessionId: t.boundary?.sessionId ?? null });
    if (t.reply?.evidence && t.completion?.state !== 'complete') gaps.push({ code: 'REPLY_COMPLETION_UNKNOWN', turnId: t.id,
      sessionId: t.reply.evidence.sessionId ?? t.boundary?.sessionId ?? null, chars: t.reply.evidence.chars ?? null,
      readiness: t.readiness?.state ?? 'unknown' });
    if (t.readiness?.state === 'ready' && t.completion?.state !== 'complete') gaps.push({ code: 'READINESS_READY_WITH_COMPLETION_UNKNOWN', turnId: t.id,
      readinessSequence: t.readiness.evidence?.sequence ?? null, replySequence: t.reply?.evidence?.sequence ?? null,
      samples: Array.isArray(t.readiness.evidence?.samples) ? t.readiness.evidence.samples.length : null });
    if (t.phase === 'delivered' && t.delivery?.evidence?.sessionId && !sessions.some((s) => s.sessionId === t.delivery.evidence.sessionId && s.present)) {
      gaps.push({ code: 'SESSION_EVIDENCE_MISSING', turnId: t.id, sessionId: t.delivery.evidence.sessionId });
    }
  }
  if (!turns.length && !view?.sessionId) gaps.push({ code: 'NO_CAPTURED_TURN_OR_SESSION' });
  if (journalState !== 'referenced') gaps.push({ code: 'JOURNAL_REFERENCE_UNAVAILABLE', reason: journalState });
  if (view?.capture?.state && !['idle', 'stopped'].includes(view.capture.state)) gaps.push({ code: 'CAPTURE_NOT_IDLE_AT_PRESERVATION', state: view.capture.state });
  return gaps;
}

function coverage({ sessions }) {
  const derived = sessions.flatMap((s) => s.datasets ?? []);
  const knowledge = sessions.flatMap((s) => (s.kv ?? []).filter((k) => k.key === 'KNOWLEDGE_STATUS'));
  return {
    // No runtime observation can justify stronger values here. Local derivation exists only as a
    // pointer; it is not accepted knowledge, not a UI check, and not an outcome/acceptance claim.
    ui: { state: 'unknown', reason: 'NO_UI_OBSERVATION_BOUND_TO_THIS_CHECKPOINT', evidence: null },
    knowledge: { state: 'unknown', reason: 'LOCAL_DERIVATION_IS_NOT_ACCEPTED_KNOWLEDGE',
      evidence: knowledge.length ? { pointers: knowledge.map((k) => ({ path: k.path, sha256: k.sha256, bytes: k.bytes })) } : null },
    outcome: { state: 'unknown', reason: 'CAPTURE_COMPLETION_IS_NOT_ACCEPTANCE', evidence: null },
    reconstruction: { state: derived.length ? 'local-pointers' : 'unavailable', reason: derived.length ? 'DERIVED_DATASETS_PRESENT_LOCALLY' : 'NO_DERIVED_DATASETS',
      evidence: derived.length ? derived.map((d) => ({ name: d.name, path: d.path, sha256: d.sha256, bytes: d.bytes })) : null },
  };
}

function readHistory(file, { io, failures }) {
  let raw;
  try { raw = io.readFileSync(file, 'utf8'); }
  catch (e) { if (e?.code !== 'ENOENT') failures.push(failure('evidence.read', e?.code ?? 'READ_FAILED', e?.message ?? String(e))); return { revision: 0, history: [] }; }
  try {
    const parsed = JSON.parse(raw);
    return { revision: Number.isSafeInteger(parsed?.revision) ? parsed.revision : 0, history: Array.isArray(parsed?.history) ? parsed.history : [],
      fingerprint: typeof parsed?.fingerprint === 'string' ? parsed.fingerprint : null, preservedAt: parsed?.preservedAt ?? null };
  } catch (e) {
    failures.push(failure('evidence.read', 'CORRUPT_EVIDENCE_FILE', e?.message ?? String(e)));
    return { revision: 0, history: [], unreadablePrevious: true };
  }
}

/**
 * Build + write one bounded checkpoint. Best-effort by contract: callers catch write failures.
 * Returns a summary (never the private bodies) so a runtime can expose failure state honestly.
 */
export function captureConversationEvidence({ directory, id, view, journal = null, journalError = null, trigger = 'turn',
  paths = {}, timeline = [], limits = {}, io = fs, now = nowIso } = {}) {
  if (!view || typeof view !== 'object' || view.id !== id) throw Object.assign(new Error('EVIDENCE_VIEW_REQUIRED'), { code: 'EVIDENCE_VIEW_REQUIRED' });
  const file = evidenceFileFor(directory, id);
  const L = { ...EVIDENCE_LIMITS, ...limits };
  const failures = [];
  const root = paths?.root ? path.resolve(paths.root) : path.dirname(directory);
  const sessionsRoot = paths?.sessions ? path.resolve(paths.sessions) : null;
  const at = now();

  const snapshotFile = path.join(directory, `${id}.conversation.json`);
  const snapshot = boundedFile(snapshotFile, { io, maxHashBytes: L.maxHashBytes });
  const journalPointer = journalReference({ directory, view, io, maxHashBytes: L.maxHashBytes, failures });
  if (journalError) failures.push(failure('journal.read', journalError.code ?? 'JOURNAL_UNAVAILABLE', journalError.message ?? ''));
  if (journalPointer.state !== 'referenced') failures.push(failure('journal', 'JOURNAL_REFERENCE_UNAVAILABLE', journalPointer.reason ?? 'unknown'));

  const turnIds = (journal?.turns ?? view.attempts ?? []).map((t) => t?.id).filter((v) => typeof v === 'string');
  const sessionIds = collectSessionIds(view, journal).slice(0, L.maxSessions);
  const sessions = sessionIds.map((sessionId) => sessionEvidence({ sessionsRoot, sessionId, turnIds, io, limits: L, failures, root }));

  const turns = (journal?.turns ?? []).length ? journal.turns.map(turnProjection) : (view.attempts ?? []).map(turnProjection);
  const gaps = deriveGaps({ view, journal, journalState: journalPointer.state, sessions });
  const fingerprint = sha256(JSON.stringify([view.revision ?? null, journal?.revision ?? null, view.state ?? null,
    view.capture?.state ?? null, view.finish?.phase ?? null, turns.map((t) => [t.id, t.revision, t.phase, t.reply?.evidence?.contentDigest ?? null])]));

  const previous = readHistory(file, { io, failures });
  if (previous.unreadablePrevious) failures.push(failure('evidence.read', 'PREVIOUS_CHECKPOINT_UNREADABLE', file));
  if (previous.revision > 0 && previous.fingerprint === fingerprint) {
    return { file, revision: previous.revision, preservedAt: previous.preservedAt, fingerprint, trigger, skipped: true,
      turns: turns.length, sessions: sessions.length, gaps: gaps.map((g) => g.code), failures: failures.length,
      coverage: { ui: 'unknown', knowledge: 'unknown', outcome: 'unknown' } };
  }
  const history = previous.history.slice(-Math.max(0, L.maxHistory - 1));
  const checkpoint = {
    schema: EVIDENCE_SCHEMA, version: EVIDENCE_VERSION,
    conversationId: id, trigger, preservedAt: at, fingerprint,
    scope: 'local private engineering evidence only; no acceptance, no provider-original inference, no UI quality claim',
    conversation: { snapshot: { path: rel(root, snapshotFile), ...snapshot }, revision: view.revision ?? null, state: view.state ?? null,
      site: view.site ?? null, sessionId: view.sessionId ?? null, identity: view.identity ?? null,
      binding: view.binding ? { targetId: view.binding.targetId ?? null, origin: view.binding.origin ?? null,
        ownedByStudio: view.binding.ownedByStudio ?? null, thread: view.binding.thread ?? null } : null,
      capture: view.capture ?? null, finish: view.finish ?? null, diagnostic: view.diagnostic ?? null, uncertainty: view.diagnostic?.uncertainty ?? null,
      writer: view.writer ?? null, limitations: Array.isArray(view.limitations) ? view.limitations.slice(0, 20) : [] },
    journal: { ...journalPointer, revision: journal?.revision ?? null, threadKey: journal?.threadKey ?? null,
      admissionMode: journal?.admissionMode ?? null, createdAt: journal?.createdAt ?? null, updatedAt: journal?.updatedAt ?? null,
      state: journalPointer.state === 'referenced' ? (journal ? 'present' : 'referenced-not-read') : 'unavailable' },
    turns,
    sessions,
    timing: { observedAt: at, conversationCreatedAt: view.createdAt ?? null, conversationUpdatedAt: view.updatedAt ?? null,
      turns: turns.map((t) => ({ turnId: t.id, createdAt: t.createdAt, updatedAt: t.updatedAt,
        deliverySequence: t.delivery?.evidence?.sequence ?? null, replySequence: t.reply?.evidence?.sequence ?? null,
        readinessSequence: t.readiness?.evidence?.sequence ?? null, completionState: t.completion?.state ?? null,
        phase: t.phase, reason: t.reason })),
      sessions: sessions.filter((s) => s.meta).map((s) => ({ sessionId: s.sessionId, createdAt: s.meta.createdAt, endedAt: s.meta.endedAt, status: s.meta.status, endReason: s.meta.endReason })),
      runtime: Array.isArray(timeline) ? timeline.slice(-L.maxTimeline) : [] },
    coverage: coverage({ sessions }),
    gaps,
    failures,
    history: [...history, { at, trigger, conversationRevision: view.revision ?? null, journalRevision: journal?.revision ?? null, fingerprint, turns: turns.length, sessions: sessions.length, gaps: gaps.length, failures: failures.length }],
  };
  if (checkpoint.history.length > L.maxHistory) checkpoint.history = checkpoint.history.slice(-L.maxHistory);

  const revision = previous.revision + 1;
  const body = `${JSON.stringify({ ...checkpoint, revision }, null, 2)}\n`;
  const temporary = `${file}.${sha256(`${at}:${fingerprint}`).slice(0, 8)}.tmp`;
  let fd;
  try {
    io.mkdirSync(directory, { recursive: true });
    fd = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(fd, body);
    try { io.fsyncSync(fd); } catch { /* not portable everywhere; content is still complete */ }
    io.closeSync(fd); fd = undefined;
    io.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd); } catch { /* ignore */ } }
    try { io.unlinkSync(temporary); } catch { /* absent after rename */ }
  }
  return { file, revision, preservedAt: at, fingerprint, trigger, turns: turns.length, sessions: sessions.length,
    gaps: gaps.map((g) => g.code), failures: failures.length,
    coverage: { ui: checkpoint.coverage.ui.state, knowledge: checkpoint.coverage.knowledge.state, outcome: checkpoint.coverage.outcome.state } };
}
