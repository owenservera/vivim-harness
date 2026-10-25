#!/usr/bin/env node
// Categorization scoreboard (READ-ONLY).
//
// Replays every saved session's raw log IN MEMORY through the product's own modules and reports how
// well Studio categorizes streams on its own: framing, stream role coverage and stability, delta
// dialect state, stream-map coverage, family verdict, learner state, and session accounting.
//
// It reports NUMBERS, not grades: no thresholds, no pass/fail. Run it before and after a change and
// diff the two outputs with --compare.
//
// Usage:
//   node scripts/categorization-scoreboard.mjs [--data-dir DIR] [--sessions id,id] [--limit N]
//                                              [--out FILE] [--compare BEFORE.json]
//
// Guarantees:
//   * Never writes into the data directory. Sessions are NOT opened through store/session.mjs
//     (its constructor creates kv/). Raw segments are read with store/raw-index.mjs iterateRaw;
//     session.json, kv/RECEIPT.json, kv/KNOWLEDGE_STATUS.json, kv/MODEL.json and the learner store
//     are read with readFileSync. Nothing is derived, no browser, no network.
//   * Write evidence is METADATA ONLY. Each touched session folder is snapshotted before and after
//     (relative path, kind, size, mtime) and the differences are counted, never hashed. So
//     safety.writeCheck.method = "stat" means "file metadata unchanged", NOT "content hash
//     verified". Unlike fidelity-survey a change does not abort the run: a live recorder or derive
//     may write the same folders while the scoreboard reads them, and an aborted run would be
//     useless as a baseline. Nothing here ever writes under the data directory.
//   * Refuses a data directory that is the repository checkout (or inside one), and refuses an
//     --out file inside the data directory.
//   * The report is shareable: counts, ratios and bounded enum labels only. No message text, no URL
//     paths, no query strings, no titles, no session folder names, no file names. Every label is
//     resolved against a fixed vocabulary below and anything outside it is reported as "other", so
//     a free-text field or a wire-supplied protocol name can never reach the report. A session is
//     identified by a 10-char sha1 prefix of its folder name ("ref"), an endpoint by a 10-char sha1
//     prefix of its url template. Hosts appear as the registrable host only.
//   * Sessions still 'recording' are counted in the session accounting but skipped by every stream
//     measure (their raw log is still growing).
//   * Each session is isolated in try/catch. A bad session becomes status "error" with a bounded
//     class label.
//
// Learner store (verified against src/config.mjs and src/intel/learn.mjs + learner-journal.mjs):
//   the persisted learner is <data-dir>/learner/learner.json -- dataPaths().learner plus
//   LearnerJournal(<dir>).learner.json, holding { version, revision, parentRevision, savedAt,
//   models, globalLearned, overrides, corrections, proposals, audit, nextCorrectionId, calibrator,
//   integrity }. The many *priors* the CLI prints come from the built-in prior table held in
//   memory (ScopedLearner.global), NOT from that file, so "store absent" never means "no priors".
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultDataDir, dataPaths, TOOL_ROOT } from '../src/config.mjs';
import { iterateRaw } from '../src/store/raw-index.mjs';
import { StreamReducer, STREAMING_TRANSPORTS } from '../src/replay/reducer.mjs';
import { STREAM_ROLES as CLASSIFIER_ROLES, CONFIDENCE_LEVELS } from '../src/replay/stream-role.mjs';
import { detectStreamMap, applyStreamMap, DEFAULT_STREAM_MAPS } from '../src/profiles/stream-map.mjs';
import { templateUrl } from '../src/shapes/infer.mjs';
import {
  snapshotSessionDirs, diffSnapshots, assertNotRepoCheckout, isInside, errorClassOf, UsageError, GuardError,
} from './fidelity-survey.mjs';

export const SCOREBOARD_SCHEMA = 'capture-studio.categorization-scoreboard/1';
export const EVENT_CAP = 20000;
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
// A session that is still being written has no stable raw log: counted, never measured.
export const SKIP_STATUSES = Object.freeze(['recording']);
const OTHER = 'other';
// Public suffixes with two labels, so the registrable host keeps three.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'ne.jp', 'or.jp', 'com.au', 'net.au', 'co.nz',
  'co.in', 'com.cn', 'com.br', 'com.mx', 'co.za', 'com.tr', 'com.sg', 'co.kr', 'com.hk', 'com.tw',
]);
export const FAMILY_BUCKETS = ['0', '(0,0.25)', '[0.25,0.5)', '[0.5,0.75)', '[0.75,1]'];

// ---------------------------------------------------------------------------------------------
// Bounded label vocabularies. Every emitted label comes from one of these; a raw field value is
// never echoed, so a role/family/status that holds private text becomes "other", not that text.
// ---------------------------------------------------------------------------------------------
// Stream roles are the classifier's own vocabulary (src/replay/stream-role.mjs). This is the only role
// vocabulary the report will name; anything else shows up in the distribution as "other".
// 'unknown' is a VALID classifier answer but NOT a specific role: it never counts as role coverage.
export const STREAM_ROLES = CLASSIFIER_ROLES;
export const SPECIFIC_ROLES = Object.freeze(CLASSIFIER_ROLES.filter((r) => r !== 'unknown'));
export const ROLE_MODES = Object.freeze(['replay', 'off']);
export const ROLE_CONFIDENCE_SCALE = 'ordinal heuristic (none|low|medium|high); not a probability, not calibrated';
export const SESSION_STATUSES = Object.freeze([
  'complete', 'recording', 'failed', 'paused', 'canceled', 'stopped', 'aborted', 'error', 'unknown',
]);
// Dialect names the delta assembler can detect and apply today (src/decode/delta.mjs detectDialect
// and DeltaAssembler.apply). A name outside this set is not guessed at.
export const KNOWN_DIALECTS = Object.freeze([
  'path-ops', 'typed-events', 'json-merge-patch', 'json-patch', 'dotted-set', 'ot-ops',
  'array-splice', 'put-merge',
]);
const TRANSPORT_LABELS = new Set([...STREAMING_TRANSPORTS, 'HTTP']);
const DETAIL_LABELS = new Set([
  ...TRANSPORT_LABELS, 'HTTP_SSE', 'HTTP_NDJSON', 'HTTP_JSON_SEQ', 'HTTP_CHUNKED_JSON',
  'HTTP_LENGTH_PREFIXED', 'GRPC', 'EVENT_SOURCE',
]);
const FAMILY_LABELS = new Set(listBuiltinFamilies());
const MAP_LABELS = new Set(DEFAULT_STREAM_MAPS.map((m) => m.id));
const ERROR_LABELS = new Set([
  'SyntaxError', 'TypeError', 'RangeError', 'ReferenceError', 'Error', 'SESSION_JSON_MISSING',
  'SESSION_JSON_INVALID', 'SESSION_DIR_MISSING', 'ENOENT', 'EACCES', 'EPERM', 'EISDIR',
]);

function listBuiltinFamilies() {
  try {
    return readdirSync(path.join(TOOL_ROOT, 'families')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
  } catch { return []; }
}

export const framingLabel = (v) => {
  const s = String(v ?? '');
  if (DETAIL_LABELS.has(s)) return s;
  // transportDetailOf() appends the app protocol: WEBSOCKET_<A-Z0-9_>. Bounded, never echoed raw.
  return /^WEBSOCKET(?:_[A-Z0-9_]{1,32})?$/.test(s) ? s : OTHER;
};
export const roleLabel = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return STREAM_ROLES.includes(s) ? s : OTHER;
};
export const statusLabel = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return SESSION_STATUSES.includes(s) ? s : OTHER;
};
export const familyLabel = (v) => {
  const s = String(v ?? '');
  return FAMILY_LABELS.has(s) ? s : OTHER;
};
export const mapLabel = (v) => {
  const s = String(v ?? '');
  return MAP_LABELS.has(s) ? s : OTHER;
};
const errorLabel = (e) => {
  const c = errorClassOf(e);
  return ERROR_LABELS.has(c) ? c : 'Error';
};

// Session identity in the report: a hash, never the folder name (which can carry a site slug).
export function sessionRef(id) {
  return createHash('sha1').update(String(id)).digest('hex').slice(0, 10);
}

const USAGE = [
  'Usage: node scripts/categorization-scoreboard.mjs [--data-dir DIR] [--sessions id,id] [--limit N] [--out FILE] [--compare BEFORE.json]',
  '  --data-dir DIR       data directory to read (default: the configured one); never written',
  '  --sessions id,id     measure only these session folders (default: every folder)',
  '  --limit N            keep the N newest sessions (name order)',
  '  --out FILE           write the JSON report to FILE (refused inside the data directory); default: stdout',
  '  --compare FILE       compare against an earlier JSON report and print per-measure deltas',
  '  --no-roles           pre-role baseline mode: do not classify stream roles (role_field_present=false)',
  '',
].join('\n');

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const ratio = (a, b) => (b > 0 ? r3(a / b) : null);
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] ?? 0) + n; };
const addInto = (total, counts) => { for (const [k, v] of Object.entries(counts ?? {})) total[k] = (total[k] ?? 0) + v; };

// ---------------------------------------------------------------------------------------------
// Content-free identity helpers
// ---------------------------------------------------------------------------------------------
// Registrable host only: no subdomain, no port, no path. Literal addresses are not printed.
export function registrableHost(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return null;
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h.includes(':')) return 'ip-literal';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return 'ip-literal';
  const parts = h.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_LABEL_SUFFIXES.has(lastTwo) && parts.length >= 3 ? parts.slice(-3).join('.') : lastTwo;
}

export function hostOf(meta) {
  try { return registrableHost(new URL(meta?.target?.url).hostname); } catch { return null; }
}

// Endpoint identity across sessions: sha1 prefix of "<METHOD> <url template>". Never the template.
const URL_PLACEHOLDER = '[unparsed-url]';

export function endpointHash(method, url) {
  let tmpl;
  try { tmpl = templateUrl(url); } catch { tmpl = URL_PLACEHOLDER; }
  if (typeof tmpl !== 'string' || tmpl === '') tmpl = URL_PLACEHOLDER;
  return createHash('sha1').update(`${method ?? 'GET'} ${tmpl}`).digest('hex').slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Field readers (defensive: role comes from summary({ includeStreamRoles }), dialectState may not exist)
// ---------------------------------------------------------------------------------------------
function hasEvidenceValue(v) {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// One stream summary row -> role facts. role_field_present is derived from fieldPresent.
//   hasRole     the row carries a non-empty role value (including 'unknown')
//   specific    the role is one of SPECIFIC_ROLES: the only thing that counts as role coverage
//   truncated   the stream's events were bounded (eventsOnlyOnDisk > 0): its role was decided on a
//               partial window and is NOT counted as coverage
//   confidence  the classifier's ordinal level (bounded enum), never a probability
export function roleOfStream(st) {
  const fieldPresent = Object.prototype.hasOwnProperty.call(st ?? {}, 'role');
  const raw = st?.role;
  const role = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  const conf = String(st?.roleConfidence ?? '');
  // roleCoverage comes from the classifier (additive, absent on older rows): what the verdict examined.
  const cov = st?.roleCoverage !== null && typeof st?.roleCoverage === 'object' ? st.roleCoverage : null;
  const withheldRole = cov && SPECIFIC_ROLES.includes(cov.withheldRole) ? cov.withheldRole : null;
  const lower = role === null ? null : role.toLowerCase();
  return {
    fieldPresent, role, hasRole: role !== null, hasEvidence: hasEvidenceValue(st?.roleEvidence),
    specific: lower !== null && SPECIFIC_ROLES.includes(lower),
    truncated: Number(st?.eventsOnlyOnDisk) > 0,
    omittedEvents: Number(st?.eventsOnlyOnDisk) > 0 ? Math.floor(Number(st.eventsOnlyOnDisk)) : 0,
    confidence: CONFIDENCE_LEVELS.includes(conf) ? conf : 'none',
    hasCoverage: cov !== null,
    // true / false when the classifier said so, null when the row has no coverage (never assumed)
    fullyInspected: cov ? cov.fullyInspected === true : null,
    inspectionCut: cov ? cov.inspectionCut === true : null,
    withheldRole,
    // a candidate specific role exists: either emitted, or withheld for incomplete inspection
    rawSpecific: lower !== null && (SPECIFIC_ROLES.includes(lower) || (lower === 'unknown' && withheldRole !== null)),
    classifierTruncatedEvidence: Array.isArray(st?.roleEvidence) && st.roleEvidence.some((e) => e && e.feature === 'inspection_truncated'),
  };
}

// Disposition of one stream for role coverage: exactly one of these.
//   specific   a specific role the classifier emitted. It emits one only when the part of the stream
//              that could contradict it was examined (coverage.fullyInspected), so this is the
//              "fully inspected specific" count         (counts as coverage)
//   withheld   the classifier had a specific candidate but withheld it because an inspection cap hid
//              content that could contradict it           (NOT coverage; the candidate is reported
//              separately as raw specific)
//   unknown    the classifier answered unknown / a non-vocabulary value (NOT coverage)
//   truncated  the reducer holds only part of the stream's events (NOT coverage)
//   absent     no role field (role pass off, or an old summary)
export const ROLE_DISPOSITIONS = Object.freeze(['specific', 'withheld', 'unknown', 'truncated', 'absent']);
export function roleDisposition(r) {
  if (!r.hasRole) return 'absent';
  if (r.truncated) return 'truncated';
  if (r.role.toLowerCase() === 'unknown' && r.withheldRole !== null) return 'withheld';
  return r.specific ? 'specific' : 'unknown';
}

// Origin context of ONE stream, computed from that stream's own URL host against ITS OWN session's target
// host. It is never an attribute of an origin: the same registrable host is "same-host" in one session
// and "different-registrable" in another. Hostnames are compared, never reported.
export const ORIGIN_CLASSES = Object.freeze(['same-host', 'same-registrable', 'different-registrable', 'no-target-context', 'no-stream-url']);
export function originContextOf(streamUrl, targetUrl) {
  let sh = null; let th = null;
  try { sh = new URL(streamUrl).hostname.toLowerCase() || null; } catch { sh = null; }
  try { th = new URL(targetUrl).hostname.toLowerCase() || null; } catch { th = null; }
  if (!sh) return 'no-stream-url';
  if (!th) return 'no-target-context';
  if (sh === th) return 'same-host';
  return registrableHost(sh) === registrableHost(th) ? 'same-registrable' : 'different-registrable';
}

// Dialect state: prefer the summary field when a later lane provides it, else derive from the
// existing deltaDialects / deltaUnapplied fields (the same inputs fidelity-survey uses for its
// dialectFailures) and label the fallback.
//
// The five states mean, in this order of precedence:
//   known-delta    a dialect NAME from KNOWN_DIALECTS was detected: the encoding is understood
//   unknown-delta  JSON was treated as incremental but could not be classified or applied
//                  (deltaUnapplied > 0) or carries a dialect name outside the vocabulary
//   snapshot       the snapshot dialect was named
//   static         at least one JSON payload was recognized and there is NO delta evidence: a plain
//                  JSON document, not an incremental encoding. This is a positive claim and needs
//                  JSON evidence
//   opaque         nothing recognized: heartbeats, keepalive frames, undecoded chunks, metadata-only
//                  requests. A recognized framing frame is never counted as "static" without JSON
//                  evidence, and zero events is never counted as "static" either
export const DIALECT_STATES = Object.freeze(['static', 'snapshot', 'known-delta', 'unknown-delta', 'opaque']);

export function dialectStateOf(st, events = []) {
  const field = st?.dialectState;
  if (typeof field === 'string' && DIALECT_STATES.includes(field)) return { state: field, source: 'field' };
  const dialects = Array.isArray(st?.deltaDialects) ? st.deltaDialects : [];
  const unapplied = Number(st?.deltaUnapplied ?? 0);
  if (dialects.some((d) => KNOWN_DIALECTS.includes(d))) return { state: 'known-delta', source: 'fallback' };
  if (unapplied > 0) return { state: 'unknown-delta', source: 'fallback' };
  if (dialects.includes('snapshot')) return { state: 'snapshot', source: 'fallback' };
  if (dialects.length > 0) return { state: 'unknown-delta', source: 'fallback' };
  const hasJson = events.some((e) => e && e.json !== undefined);
  return { state: hasJson ? 'static' : 'opaque', source: 'fallback' };
}

function readJsonIfPresent(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function readSessionMeta(dir) {
  const p = path.join(dir, 'session.json');
  if (!existsSync(p)) { const e = new Error('session.json missing'); e.code = 'SESSION_JSON_MISSING'; throw e; }
  const meta = JSON.parse(readFileSync(p, 'utf8'));
  if (!meta || typeof meta !== 'object') { const e = new Error('session.json not an object'); e.code = 'SESSION_JSON_INVALID'; throw e; }
  return meta;
}

// Derived knowledge on disk: the knowledge/model artifacts derive writes into kv/.
export function derivedKnowledgeOf(dir) {
  const kv = path.join(dir, 'kv');
  const model = existsSync(path.join(kv, 'MODEL.json'));
  const knowledgeStatus = existsSync(path.join(kv, 'KNOWLEDGE_STATUS.json'));
  const shapes = existsSync(path.join(kv, 'SHAPES.json'));
  return { present: model || knowledgeStatus, model, knowledgeStatus, shapes };
}

export function familyBucket(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score <= 0) return FAMILY_BUCKETS[0];
  if (score < 0.25) return FAMILY_BUCKETS[1];
  if (score < 0.5) return FAMILY_BUCKETS[2];
  if (score < 0.75) return FAMILY_BUCKETS[3];
  return FAMILY_BUCKETS[4];
}

// Family verdict: the persisted receipt wins; the shapes report is the fallback. Labels are enum
// names from the family store, sanitized like every other label.
export function readFamilyVerdict(dir) {
  const kv = path.join(dir, 'kv');
  const receipt = readJsonIfPresent(path.join(kv, 'RECEIPT.json'));
  const rf = receipt?.family;
  if (rf && typeof rf === 'object' && typeof rf.best === 'string' && rf.best !== '') {
    const score = typeof rf.score === 'number' && Number.isFinite(rf.score) ? r2(rf.score) : null;
    return { verdict: familyLabel(rf.best), score, bucket: familyBucket(score), source: 'receipt' };
  }
  const shapes = readJsonIfPresent(path.join(kv, 'SHAPES.json'));
  const first = Array.isArray(shapes?.families) ? shapes.families[0] : null;
  if (first && typeof first.family === 'string' && first.family !== '') {
    const score = typeof first.score === 'number' && Number.isFinite(first.score) ? r2(first.score) : null;
    return { verdict: familyLabel(first.family), score, bucket: familyBucket(score), source: 'shapes' };
  }
  return null;
}

// Learner store (read only, counts only). Verified against src/config.mjs dataPaths().learner and
// src/intel/learn.mjs ScopedLearner + src/intel/learner-journal.mjs:
//   <data-dir>/learner/learner.json  -> journal snapshot { version, revision, parentRevision,
//   savedAt, models, globalLearned, overrides, corrections, proposals, audit, nextCorrectionId,
//   calibrator, integrity }
// The CLI's large "priors" number is the built-in prior table held in memory (ScopedLearner.global),
// not this file, so `store.stateFile` is the only evidence of persisted learning.
export function readLearnerState(dataRoot) {
  const dir = dataPaths(dataRoot).learner;
  const file = path.join(dir, 'learner.json');
  const base = {
    store: { configuredDirPresent: existsSync(dir), stateFilePresent: false, unreadable: false },
    // The CLI's priors are the built-in table constructed in memory, never this file.
    priorsSource: 'builtin-in-memory',
    revision: 0,
    corrections: 0, correctionsActive: 0, correctionsReverted: 0,
    proposals: 0, proposalsPending: 0,
    audit: 0, models: 0, globalLearned: 0, overrides: 0,
    calibrationKinds: 0, calibrationSamples: 0,
  };
  if (!existsSync(file)) return base;
  const snap = readJsonIfPresent(file);
  if (!snap || typeof snap !== 'object') {
    return { ...base, store: { ...base.store, stateFilePresent: true, unreadable: true } };
  }
  const bins = snap.calibrator?.bins && typeof snap.calibrator.bins === 'object' ? snap.calibrator.bins : {};
  const kinds = Object.keys(bins);
  let samples = 0;
  for (const list of Object.values(bins)) {
    for (const b of Array.isArray(list) ? list : []) samples += Number.isFinite(b?.n) ? b.n : 0;
  }
  const corrections = Array.isArray(snap.corrections) ? snap.corrections : [];
  const proposals = Array.isArray(snap.proposals) ? snap.proposals : [];
  return {
    store: { configuredDirPresent: true, stateFilePresent: true, unreadable: false },
    priorsSource: 'builtin-in-memory',
    revision: Number.isSafeInteger(snap.revision) ? snap.revision : 0,
    corrections: corrections.length,
    correctionsActive: corrections.filter((c) => !c?.reverted && c?.status !== 'rejected').length,
    correctionsReverted: corrections.filter((c) => c?.reverted).length,
    proposals: proposals.length,
    proposalsPending: proposals.filter((p) => p?.status === 'proposed').length,
    audit: Array.isArray(snap.audit) ? snap.audit.length : 0,
    models: snap.models && typeof snap.models === 'object' ? Object.keys(snap.models).length : 0,
    globalLearned: Array.isArray(snap.globalLearned) ? snap.globalLearned.length : 0,
    overrides: snap.overrides && typeof snap.overrides === 'object' ? Object.keys(snap.overrides).length : 0,
    calibrationKinds: kinds.length,
    calibrationSamples: samples,
  };
}

// ---------------------------------------------------------------------------------------------
// Per-session measurement
// ---------------------------------------------------------------------------------------------
function emptyRoleBucket() {
  return {
    // labeled = SPECIFIC role on a complete event window; unlabeled = everything else (unknown,
    // truncated, absent). distribution covers specific + unknown labels of complete windows.
    fieldPresent: false, labeled: 0, labeledWithEvidence: 0, unlabeled: 0,
    labeledBytes: 0, bytesWithEvidence: 0, distribution: {}, distributionBytes: {},
    dispositions: {}, dispositionBytes: {}, confidence: {}, eventsOmitted: 0,
    // Coverage honesty (all counts / bytes):
    //   rawSpecific*            a specific candidate existed (emitted OR withheld for incomplete inspection)
    //   fullyInspectedSpecific* a specific role emitted with coverage.fullyInspected === true
    //   inspectionCutUnknown*   unknown, and the classifier says an inspection cap / omission was involved
    //   specificWithIrrelevantCap emitted specific whose evidence still reports a cap that cannot touch it
    //   coverageUnavailable     rows with a role but no coverage object (never counted as fully inspected)
    rawSpecific: 0, rawSpecificBytes: 0, fullyInspectedSpecific: 0, fullyInspectedSpecificBytes: 0,
    inspectionCutUnknown: 0, inspectionCutUnknownBytes: 0, specificWithIrrelevantCap: 0, specificWithIrrelevantCapBytes: 0,
    coverageUnavailable: 0, byOriginClass: {},
    // binary streams by what could be said about their structure: 'structural-complete' / 'structural-incomplete'
    // (decoder feature snapshots; incomplete = a frame was corrupt, partial, oversize or over a budget) or
    // 'opaque' (binary / undecoded / unsupported contract, no JSON). None of these is a role; all stay unknown.
    binaryKinds: {}, binaryKindBytes: {},
  };
}

const emptyClassTab = () => ({
  streams: 0, bytes: 0, fullyInspectedSpecific: 0, fullyInspectedSpecificBytes: 0, rawSpecific: 0, rawSpecificBytes: 0,
  unknown: 0, unknownBytes: 0, inspectionCut: 0, inspectionCutBytes: 0,
});

// roles: 'replay' (default) asks the reducer for includeStreamRoles on the in-memory replay;
// 'off' is the deliberate pre-role baseline (no role fields, role_field_present=false). Persisted
// kv/STREAM_ROLES is never read: stale or missing artifacts cannot leak into a measurement.
export async function measureSession(dir, id, { eventCap = EVENT_CAP, roles = 'replay' } = {}) {
  const meta = readSessionMeta(dir);
  const sessionStatus = typeof meta.status === 'string' && meta.status !== '' ? statusLabel(meta.status) : 'unknown';
  const derived = derivedKnowledgeOf(dir);
  const family = readFamilyVerdict(dir);
  const entry = {
    ref: sessionRef(id),
    status: 'ok',
    sessionStatus,
    siteHost: hostOf(meta),
    derivedKnowledge: derived.present,
    family,
  };
  // The accounting entry stays true even for a skipped session, but carries no stream measures.
  if (SKIP_STATUSES.includes(sessionStatus)) {
    entry.status = 'skipped';
    entry.skipReason = 'session_in_progress';
    return { entry, endpointRoles: [] };
  }
  Object.assign(entry, {
    rawRecords: 0,
    corruptRecords: 0,
    streams: 0,
    streamBytes: 0,
    framing: { transport: {}, transportDetail: {} },
    framingBytes: { transport: {}, transportDetail: {} },
    role: emptyRoleBucket(),
    dialectState: { field: 0, fallback: 0, counts: {}, bytes: {} },
    streamMap: { mapId: null, mapIds: [], mappedStreams: 0, unmappedEvents: 0, errorSignals: 0 },
  });

  const reducer = new StreamReducer({ deltaDialect: 'auto', keepEvents: true, maxEventsPerStream: eventCap });
  for await (const rec of iterateRaw(path.join(dir, 'raw'), { useIndex: false })) {
    if (!rec || typeof rec !== 'object' || rec.k === 'corrupt') { entry.corruptRecords++; continue; }
    entry.rawRecords++;
    reducer.ingest(rec);
  }
  const summary = reducer.summary({ includeStreamRoles: roles !== 'off' });
  const mapIds = new Set();
  const endpointRoles = [];

  for (const st of summary.streams) {
    const events = reducer.eventsOf(st.sid);
    const bytes = Number(st.bytes ?? 0);
    entry.streams++;
    entry.streamBytes += bytes;
    bump(entry.framing.transport, framingLabel(st.transport));
    bump(entry.framing.transportDetail, framingLabel(st.transportDetail ?? st.transport));
    bump(entry.framingBytes.transport, framingLabel(st.transport), bytes);
    bump(entry.framingBytes.transportDetail, framingLabel(st.transportDetail ?? st.transport), bytes);

    const r = roleOfStream(st);
    if (r.fieldPresent) entry.role.fieldPresent = true;
    const disposition = roleDisposition(r);
    bump(entry.role.dispositions, disposition);
    bump(entry.role.dispositionBytes, disposition, bytes);
    entry.role.eventsOmitted += r.omittedEvents;
    if (disposition === 'specific' || disposition === 'unknown') {
      const label = roleLabel(r.role);
      bump(entry.role.distribution, label, 1);
      bump(entry.role.distributionBytes, label, bytes);
    }
    const fullySpecific = disposition === 'specific' && r.fullyInspected === true;
    if (disposition === 'specific') {
      entry.role.labeled++;
      entry.role.labeledBytes += bytes;
      bump(entry.role.confidence, r.confidence);
      if (r.hasEvidence) { entry.role.labeledWithEvidence++; entry.role.bytesWithEvidence += bytes; }
      if (fullySpecific) { entry.role.fullyInspectedSpecific++; entry.role.fullyInspectedSpecificBytes += bytes; }
      if (r.classifierTruncatedEvidence) { entry.role.specificWithIrrelevantCap++; entry.role.specificWithIrrelevantCapBytes += bytes; }
    } else {
      entry.role.unlabeled++;
    }
    if (r.hasRole && !r.hasCoverage) entry.role.coverageUnavailable++;
    // binary structure coverage (never a role): structural-complete / structural-incomplete / opaque
    const bcov = st.roleCoverage?.binary;
    const binaryKey = bcov?.kind === 'structural' ? (bcov.complete === true ? 'structural-complete' : 'structural-incomplete') : bcov?.kind === 'opaque' ? 'opaque' : null;
    if (binaryKey) { bump(entry.role.binaryKinds, binaryKey, 1); bump(entry.role.binaryKindBytes, binaryKey, bytes); }
    if (r.rawSpecific) { entry.role.rawSpecific++; entry.role.rawSpecificBytes += bytes; }
    const cut = r.hasRole && r.role.toLowerCase() === 'unknown' && r.inspectionCut === true;
    if (cut) { entry.role.inspectionCutUnknown++; entry.role.inspectionCutUnknownBytes += bytes; }
    // origin context: this stream's own host against THIS session's target (never an inherited label)
    const originClass = originContextOf(st.url, meta?.target?.url);
    const ot = (entry.role.byOriginClass[originClass] ??= emptyClassTab());
    ot.streams++; ot.bytes += bytes;
    if (fullySpecific) { ot.fullyInspectedSpecific++; ot.fullyInspectedSpecificBytes += bytes; }
    if (r.rawSpecific) { ot.rawSpecific++; ot.rawSpecificBytes += bytes; }
    if (disposition === 'unknown' && !cut) { ot.unknown++; ot.unknownBytes += bytes; }
    if (cut || disposition === 'truncated') { ot.inspectionCut++; ot.inspectionCutBytes += bytes; }
    if (typeof st.url === 'string' && st.url !== '') {
      // Only a specific role on a complete window is a label for stability; unknown / withheld /
      // truncated / absent are excluded as "missing role", never compared as if they were a role.
      endpointRoles.push({
        endpoint: endpointHash(st.method, st.url), role: disposition === 'specific' ? roleLabel(r.role) : null,
        bytes, fullySpecific, rawSpecific: r.rawSpecific,
      });
    }

    const ds = dialectStateOf(st, events);
    if (ds.source === 'field') entry.dialectState.field++;
    else entry.dialectState.fallback++;
    bump(entry.dialectState.counts, ds.state);
    bump(entry.dialectState.bytes, ds.state, bytes);

    if (st.kind === 'ws' || events.length === 0) continue; // websocket streams are not stream-mapped (as in derive)
    const det = detectStreamMap(events);
    if (det.map) {
      const applied = applyStreamMap(det.map, events);
      mapIds.add(mapLabel(det.map.id));
      entry.streamMap.mappedStreams++;
      entry.streamMap.unmappedEvents += applied.unmapped.length;
      // Error signals only fire on a real error envelope; a stream that succeeded yields none.
      entry.streamMap.errorSignals += (applied.signals ?? []).filter((s) => s?.kind === 'error').length;
    } else {
      entry.streamMap.unmappedEvents += events.length;
    }
  }
  const ids = [...mapIds].sort();
  entry.streamMap.mapId = ids.length === 1 ? ids[0] : null;
  entry.streamMap.mapIds = ids;
  return { entry, endpointRoles };
}

function errorEntry(id, e) {
  return { ref: sessionRef(id), status: 'error', sessionStatus: null, siteHost: null, errorClass: errorLabel(e) };
}

// ---------------------------------------------------------------------------------------------
// Role stability: endpoints (template hash + method) seen in 2+ sessions.
// ---------------------------------------------------------------------------------------------
export function roleStability(perSessionEndpoints) {
  // perSessionEndpoints: [{ session, endpoints: [{ endpoint, role }] }]
  const byEndpoint = new Map(); // endpoint -> Map(session -> Set(role|null))
  for (const { session, endpoints } of perSessionEndpoints) {
    for (const { endpoint, role } of endpoints) {
      let m = byEndpoint.get(endpoint);
      if (!m) { m = new Map(); byEndpoint.set(endpoint, m); }
      let roles = m.get(session);
      if (!roles) { roles = new Set(); m.set(session, roles); }
      roles.add(role);
    }
  }
  let multi = 0, comparable = 0, stable = 0, excludedMissingRole = 0, excludedUnstableWithin = 0;
  for (const sessions of byEndpoint.values()) {
    if (sessions.size < 2) continue;
    multi++;
    const all = [...sessions.values()];
    if (all.some((set) => set.has(null))) { excludedMissingRole++; continue; }
    if (all.some((set) => set.size > 1)) { excludedUnstableWithin++; continue; }
    comparable++;
    const labels = new Set(all.map((set) => [...set][0]));
    if (labels.size === 1) stable++;
  }
  return {
    endpointsMultiSession: multi,
    endpointsComparable: comparable,
    endpointsStable: stable,
    stabilityShare: ratio(stable, comparable),
    endpointsExcludedMissingRole: excludedMissingRole,
    endpointsExcludedUnstableWithinSession: excludedUnstableWithin,
  };
}

// ---------------------------------------------------------------------------------------------
// Endpoint-deduplicated role coverage. A handful of endpoints fetched over and over can carry most of
// the bytes (one endpoint held 78% of the unknown bytes in a real survey), so byte or stream shares alone
// say little about how many DISTINCT endpoints are understood. Units here are endpoints (method + url
// template hash), not streams:
//   all     every observation of the endpoint was a fully inspected specific role
//   some    at least one, but not every, observation was
//   none    no observation was
// perSessionEndpoints: [{ session, endpoints: [{ endpoint, bytes, fullySpecific, rawSpecific }] }]
// ---------------------------------------------------------------------------------------------
export function endpointCoverage(perSessionEndpoints) {
  const byEndpoint = new Map();
  let units = 0; let unitsWithSpecific = 0; let totalBytes = 0;
  for (const { endpoints } of perSessionEndpoints) {
    const perSession = new Map();
    for (const e of endpoints) {
      const t = byEndpoint.get(e.endpoint) ?? { obs: 0, full: 0, raw: 0, bytes: 0 };
      t.obs++; t.bytes += e.bytes ?? 0; totalBytes += e.bytes ?? 0;
      if (e.fullySpecific) t.full++;
      if (e.rawSpecific) t.raw++;
      byEndpoint.set(e.endpoint, t);
      const u = perSession.get(e.endpoint) ?? { full: false };
      if (e.fullySpecific) u.full = true;
      perSession.set(e.endpoint, u);
    }
    for (const u of perSession.values()) { units++; if (u.full) unitsWithSpecific++; }
  }
  let all = 0; let some = 0; let none = 0; let rawAny = 0; let topBytes = 0; let topObs = 0;
  for (const t of byEndpoint.values()) {
    if (t.full === t.obs) all++; else if (t.full > 0) some++; else none++;
    if (t.raw > 0) rawAny++;
    topBytes = Math.max(topBytes, t.bytes); topObs = Math.max(topObs, t.obs);
  }
  const totalObs = [...byEndpoint.values()].reduce((a, t) => a + t.obs, 0);
  return {
    distinctEndpoints: byEndpoint.size,
    endpointsAllFullyInspectedSpecific: all, endpointsSomeFullyInspectedSpecific: some, endpointsNoFullyInspectedSpecific: none,
    endpointsWithRawSpecificCandidate: rawAny,
    shareAllFullyInspectedSpecific: ratio(all, byEndpoint.size),
    shareAnyFullyInspectedSpecific: ratio(all + some, byEndpoint.size),
    sessionEndpointUnits: units, sessionEndpointUnitsWithFullyInspectedSpecific: unitsWithSpecific,
    shareUnitsWithFullyInspectedSpecific: ratio(unitsWithSpecific, units),
    // how concentrated the observations are in one endpoint (bytes and streams), so a reader sees why the
    // byte share and the endpoint share differ
    topEndpointByteShare: ratio(topBytes, totalBytes),
    topEndpointStreamShare: ratio(topObs, totalObs),
  };
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------
export function aggregate(entries, stability, learner, { roleFieldPresent, roleMode = 'replay', endpointCoverage: epCov = null }) {
  const ok = entries.filter((e) => e.status === 'ok');
  const byStatus = {};
  for (const e of entries) bump(byStatus, e.sessionStatus ?? e.status);
  const framing = { streams: { transport: {}, transportDetail: {} }, bytes: { transport: {}, transportDetail: {} } };
  const role = {
    mode: roleMode,
    field_present: roleFieldPresent === true,
    confidenceScale: ROLE_CONFIDENCE_SCALE,
    // streamsLabeled = SPECIFIC role on a complete event window; unknown / truncated / absent are not.
    streams: 0, streamsLabeled: 0, streamsWithRoleEvidence: 0, streamsWithoutRole: 0,
    streamsUnknown: 0, streamsTruncated: 0, streamsAbsent: 0,
    bytes: 0, labeledBytes: 0, bytesWithRoleEvidence: 0, unknownBytes: 0, truncatedBytes: 0, absentBytes: 0,
    eventsOmitted: 0,
    // raw specific = a specific candidate existed (emitted or withheld); fullyInspected = emitted with the
    // contradicting part examined. Their gap is what incomplete inspection costs. unknown is never coverage.
    streamsRawSpecific: 0, rawSpecificBytes: 0, streamsFullyInspectedSpecific: 0, fullyInspectedSpecificBytes: 0,
    streamsWithheld: 0, withheldBytes: 0, streamsInspectionCutUnknown: 0, inspectionCutUnknownBytes: 0,
    streamsSpecificWithIrrelevantCap: 0, specificWithIrrelevantCapBytes: 0, streamsCoverageUnavailable: 0,
    byOriginClass: {}, binaryKinds: {}, binaryKindBytes: {},
    distribution: {}, distributionBytes: {}, confidence: {},
  };
  const dialect = { sourceFieldSessions: 0, sourceFallbackSessions: 0, counts: {}, bytes: {} };
  const maps = { sessionsWithMap: 0, sessionsWithoutMap: 0, byMapId: {}, mappedStreams: 0, unmappedEvents: 0, errorSignals: 0 };
  const family = { sessionsWithVerdict: 0, verdicts: {}, buckets: {} };
  for (const e of ok) {
    for (const k of ['transport', 'transportDetail']) {
      addInto(framing.streams[k], e.framing[k]);
      addInto(framing.bytes[k], e.framingBytes[k]);
    }
    role.streams += e.streams;
    role.streamsLabeled += e.role.labeled;
    role.streamsWithRoleEvidence += e.role.labeledWithEvidence;
    role.streamsWithoutRole += e.role.unlabeled;
    role.bytes += e.streamBytes;
    role.labeledBytes += e.role.labeledBytes;
    role.bytesWithRoleEvidence += e.role.bytesWithEvidence;
    addInto(role.distribution, e.role.distribution);
    addInto(role.distributionBytes, e.role.distributionBytes);
    addInto(role.confidence, e.role.confidence);
    role.eventsOmitted += e.role.eventsOmitted ?? 0;
    const d = e.role.dispositions ?? {}; const db = e.role.dispositionBytes ?? {};
    role.streamsUnknown += d.unknown ?? 0; role.streamsTruncated += d.truncated ?? 0; role.streamsAbsent += d.absent ?? 0;
    role.unknownBytes += db.unknown ?? 0; role.truncatedBytes += db.truncated ?? 0; role.absentBytes += db.absent ?? 0;
    role.streamsWithheld += d.withheld ?? 0; role.withheldBytes += db.withheld ?? 0;
    role.streamsRawSpecific += e.role.rawSpecific ?? 0; role.rawSpecificBytes += e.role.rawSpecificBytes ?? 0;
    role.streamsFullyInspectedSpecific += e.role.fullyInspectedSpecific ?? 0; role.fullyInspectedSpecificBytes += e.role.fullyInspectedSpecificBytes ?? 0;
    role.streamsInspectionCutUnknown += e.role.inspectionCutUnknown ?? 0; role.inspectionCutUnknownBytes += e.role.inspectionCutUnknownBytes ?? 0;
    role.streamsSpecificWithIrrelevantCap += e.role.specificWithIrrelevantCap ?? 0; role.specificWithIrrelevantCapBytes += e.role.specificWithIrrelevantCapBytes ?? 0;
    role.streamsCoverageUnavailable += e.role.coverageUnavailable ?? 0;
    addInto(role.binaryKinds, e.role.binaryKinds); addInto(role.binaryKindBytes, e.role.binaryKindBytes);
    for (const [cls, tab] of Object.entries(e.role.byOriginClass ?? {})) {
      const into = (role.byOriginClass[ORIGIN_CLASSES.includes(cls) ? cls : 'other'] ??= emptyClassTab());
      for (const [k, v] of Object.entries(tab)) into[k] = (into[k] ?? 0) + (Number.isFinite(v) ? v : 0);
    }
    if (e.dialectState.field > 0) dialect.sourceFieldSessions++;
    else dialect.sourceFallbackSessions++;
    addInto(dialect.counts, e.dialectState.counts);
    addInto(dialect.bytes, e.dialectState.bytes);
    if (e.streamMap.mapId) maps.sessionsWithMap++; else maps.sessionsWithoutMap++;
    for (const id of e.streamMap.mapIds) bump(maps.byMapId, id);
    maps.mappedStreams += e.streamMap.mappedStreams;
    maps.unmappedEvents += e.streamMap.unmappedEvents;
    maps.errorSignals += e.streamMap.errorSignals;
    if (e.family) {
      family.sessionsWithVerdict++;
      bump(family.verdicts, e.family.verdict);
      if (e.family.bucket) bump(family.buckets, e.family.bucket);
    }
  }
  return {
    sessions: {
      total: entries.length,
      measurable: ok.length,
      skipped: entries.filter((e) => e.status === 'skipped').length,
      errors: entries.filter((e) => e.status === 'error').length,
      bySessionStatus: byStatus,
      withDerivedKnowledge: entries.filter((e) => e.derivedKnowledge === true).length,
      withoutDerivedKnowledge: entries.filter((e) => e.status !== 'error' && e.derivedKnowledge === false).length,
    },
    measures: {
      framing,
      role: {
        ...role,
        streamShare: ratio(role.streamsWithRoleEvidence, role.streams),
        labeledStreamShare: ratio(role.streamsLabeled, role.streams),
        byteShare: ratio(role.bytesWithRoleEvidence, role.bytes),
        labeledByteShare: ratio(role.labeledBytes, role.bytes),
        unknownStreamShare: ratio(role.streamsUnknown, role.streams),
        truncatedStreamShare: ratio(role.streamsTruncated, role.streams),
        rawSpecificStreamShare: ratio(role.streamsRawSpecific, role.streams),
        rawSpecificByteShare: ratio(role.rawSpecificBytes, role.bytes),
        fullyInspectedSpecificStreamShare: ratio(role.streamsFullyInspectedSpecific, role.streams),
        fullyInspectedSpecificByteShare: ratio(role.fullyInspectedSpecificBytes, role.bytes),
        withheldStreamShare: ratio(role.streamsWithheld, role.streams),
        endpointCoverage: epCov,
      },
      roleStability: stability,
      dialectState: dialect,
      streamMap: maps,
      family,
      learner,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------
function listSessionIds(sessionsDir) {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(sessionsDir, e.name, 'session.json')))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export async function runScoreboard({
  dataDir = defaultDataDir(), sessions = null, limit = null, out = null, eventCap = EVENT_CAP,
  roles = 'replay', _testHookAfterRead = null,
} = {}) {
  if (!ROLE_MODES.includes(roles)) throw new UsageError(`roles must be one of ${ROLE_MODES.join('|')}`);
  const root = path.resolve(dataDir);
  if (out !== null && isInside(path.resolve(out), root)) throw new UsageError('refusing --out inside the data directory');
  assertNotRepoCheckout(root);
  if (!existsSync(root)) throw new GuardError('data directory does not exist (the scoreboard never creates it)');
  const sessionsDir = dataPaths(root).sessions;
  let ids;
  if (Array.isArray(sessions) && sessions.length) {
    for (const id of sessions) if (!SESSION_ID_RE.test(id)) throw new UsageError('invalid session id');
    ids = sessions;
  } else {
    ids = listSessionIds(sessionsDir);
    if (limit) ids = ids.slice(0, limit);
  }
  const targets = ids.map((id) => ({ id, dir: path.join(sessionsDir, id) }));
  const before = snapshotSessionDirs(targets);
  const entries = [];
  const perSessionEndpoints = [];
  let roleFieldPresent = false;
  for (const t of targets) {
    try {
      if (!existsSync(t.dir)) throw Object.assign(new Error('session folder missing'), { code: 'SESSION_DIR_MISSING' });
      const { entry, endpointRoles } = await measureSession(t.dir, t.id, { eventCap, roles });
      if (entry.role?.fieldPresent) roleFieldPresent = true;
      entries.push(entry);
      if (entry.status === 'ok') perSessionEndpoints.push({ session: t.id, endpoints: endpointRoles });
    } catch (e) {
      entries.push(errorEntry(t.id, e));
    }
  }
  if (_testHookAfterRead) _testHookAfterRead(root);
  const after = snapshotSessionDirs(targets);
  const changes = diffSnapshots(before, after);
  const stability = roleStability(perSessionEndpoints);
  const learner = readLearnerState(root);
  const changeCounts = { added: 0, removed: 0, modified: 0 };
  for (const c of changes) changeCounts[c.change]++;
  const report = {
    schema: SCOREBOARD_SCHEMA,
    generatedAt: new Date().toISOString(),
    selection: { sessionCount: entries.length, explicit: Array.isArray(sessions) && sessions.length > 0, limit: limit ?? null },
    safety: {
      readOnly: true,
      // Metadata only: no file content was hashed, so this is "stat unchanged", not a content proof.
      writeCheck: {
        method: 'stat',
        contentHashVerified: false,
        sessionFoldersSnapshotted: targets.length,
        entriesSnapshotted: before.size,
        added: changeCounts.added,
        removed: changeCounts.removed,
        modified: changeCounts.modified,
        metadataUnchanged: changes.length === 0,
      },
      // External writers (a live recorder, a concurrent derive) can change these folders; the
      // scoreboard itself opens no session store and writes nothing under the data directory.
      externalChanges: changes.length,
      note: 'stat only: unchanged metadata is not a content hash; no session id, folder or file name is reported',
    },
    aggregate: aggregate(entries, stability, learner, { roleFieldPresent, roleMode: roles, endpointCoverage: endpointCoverage(perSessionEndpoints) }),
    sessions: entries,
  };
  return { report, changes };
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------
export function flattenNumbers(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) out[p] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) flattenNumbers(v, p, out);
  }
  return out;
}

export function compareReports(before, after) {
  const b = flattenNumbers(before?.aggregate ?? {});
  const a = flattenNumbers(after?.aggregate ?? {});
  const paths = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const deltas = [];
  for (const p of paths) {
    const from = b[p] ?? null;
    const to = a[p] ?? null;
    const delta = from !== null && to !== null ? r3(to - from) : null;
    if (from === to) continue;
    deltas.push({ path: p, before: from, after: to, delta });
  }
  return { comparedPaths: paths.length, changed: deltas.length, deltas };
}

export function renderComparison(cmp) {
  const lines = [`comparison: ${cmp.changed} of ${cmp.comparedPaths} numeric measures changed`];
  for (const d of cmp.deltas) {
    const sign = d.delta === null ? '' : d.delta > 0 ? '+' : '';
    lines.push(`  ${d.path}: ${d.before} -> ${d.after} (${sign}${d.delta})`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Text summary (numbers and enum labels only)
// ---------------------------------------------------------------------------------------------
const kv = (obj) => Object.entries(obj ?? {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(', ') || '-';

export function renderSummary(report) {
  const a = report.aggregate;
  const m = a.measures;
  const lines = [
    `sessions: ${a.sessions.total} (measured ${a.sessions.measurable}, recording-skipped ${a.sessions.skipped}, error ${a.sessions.errors}); derived knowledge ${a.sessions.withDerivedKnowledge}/${a.sessions.total}`,
    `session status: ${kv(a.sessions.bySessionStatus)}`,
    `framing (streams): ${kv(m.framing.streams.transportDetail)}`,
    `framing (bytes): ${kv(m.framing.bytes.transportDetail)}`,
    `role: mode=${m.role.mode}; field_present=${m.role.field_present}; SPECIFIC role ${m.role.streamsLabeled}/${m.role.streams} streams (${m.role.labeledStreamShare}), with evidence ${m.role.streamsWithRoleEvidence} (${m.role.streamShare}); bytes ${m.role.labeledBytes}/${m.role.bytes} (${m.role.labeledByteShare}); unknown (not coverage) ${m.role.streamsUnknown} streams/${m.role.unknownBytes} bytes; truncated (not coverage) ${m.role.streamsTruncated} streams/${m.role.truncatedBytes} bytes, ${m.role.eventsOmitted} events omitted; absent ${m.role.streamsAbsent}; distribution ${kv(m.role.distribution)}; confidence (${m.role.confidenceScale}) ${kv(m.role.confidence)}`,
    `role coverage honesty: raw specific candidates ${m.role.streamsRawSpecific}/${m.role.streams} streams (${m.role.rawSpecificStreamShare}), ${m.role.rawSpecificBytes} bytes; fully inspected specific ${m.role.streamsFullyInspectedSpecific} (${m.role.fullyInspectedSpecificStreamShare}), ${m.role.fullyInspectedSpecificBytes} bytes; withheld for incomplete inspection ${m.role.streamsWithheld} streams/${m.role.withheldBytes} bytes; unknown with an inspection cut ${m.role.streamsInspectionCutUnknown} streams/${m.role.inspectionCutUnknownBytes} bytes; specific with an irrelevant cap ${m.role.streamsSpecificWithIrrelevantCap}; coverage unavailable ${m.role.streamsCoverageUnavailable}`,
    ...(m.role.endpointCoverage ? [`role by endpoint (deduplicated): ${m.role.endpointCoverage.endpointsAllFullyInspectedSpecific} all + ${m.role.endpointCoverage.endpointsSomeFullyInspectedSpecific} some of ${m.role.endpointCoverage.distinctEndpoints} distinct endpoints have a fully inspected specific role (any ${m.role.endpointCoverage.shareAnyFullyInspectedSpecific}); session-endpoint units ${m.role.endpointCoverage.sessionEndpointUnitsWithFullyInspectedSpecific}/${m.role.endpointCoverage.sessionEndpointUnits}; top endpoint holds ${m.role.endpointCoverage.topEndpointByteShare} of bytes, ${m.role.endpointCoverage.topEndpointStreamShare} of streams`] : []),
    `origin context per stream (own host vs own session target): ${Object.entries(m.role.byOriginClass ?? {}).map(([k, t]) => `${k}=${t.streams} streams/${t.bytes} bytes (fully inspected specific ${t.fullyInspectedSpecific}, unknown ${t.unknown}, cut ${t.inspectionCut})`).join('; ') || '-'}`,
    `role stability: ${m.roleStability.endpointsStable}/${m.roleStability.endpointsComparable} comparable multi-session endpoints stable (ratio ${m.roleStability.stabilityShare}; ${m.roleStability.endpointsMultiSession} seen in 2+ sessions)`,
    `dialect state: ${kv(m.dialectState.counts)}; sessions using summary field ${m.dialectState.sourceFieldSessions}, fallback ${m.dialectState.sourceFallbackSessions}`,
    `stream maps: ${m.streamMap.sessionsWithMap} sessions matched (${kv(m.streamMap.byMapId)}); unmapped events ${m.streamMap.unmappedEvents}; error signals ${m.streamMap.errorSignals}`,
    `family: ${m.family.sessionsWithVerdict} sessions with a verdict; ${kv(m.family.verdicts)}`,
    `learner: store dir=${m.learner.store.configuredDirPresent}, state_file=${m.learner.store.stateFilePresent}, revision ${m.learner.revision}; corrections ${m.learner.correctionsActive} active/${m.learner.correctionsReverted} reverted; proposals ${m.learner.proposalsPending} pending; audit ${m.learner.audit}; models ${m.learner.models}; calibration kinds ${m.learner.calibrationKinds}, samples ${m.learner.calibrationSamples}; priors ${m.learner.priorsSource}`,
    `writes: none by the scoreboard; stat check on ${report.safety.writeCheck.entriesSnapshotted} entries: ${report.safety.writeCheck.metadataUnchanged ? 'metadata unchanged' : `${report.safety.writeCheck.added} added, ${report.safety.writeCheck.removed} removed, ${report.safety.writeCheck.modified} modified by an external writer`} (no content hash verified)`,
  ];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const o = { dataDir: null, sessions: null, limit: null, out: null, compare: null, roles: 'replay', help: false };
  const need = (flag, v) => {
    if (v === undefined || v === '') throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    if (a.startsWith('--') && a.includes('=')) { inline = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (a) {
      case '--data-dir': o.dataDir = need(a, val()); break;
      case '--sessions': o.sessions = need(a, val()).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--limit': {
        const n = Number(need(a, val()));
        if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit expects a positive integer');
        o.limit = n;
        break;
      }
      case '--out': o.out = need(a, val()); break;
      case '--compare': o.compare = need(a, val()); break;
      case '--no-roles': o.roles = 'off'; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (o.sessions && o.limit) throw new UsageError('--sessions and --limit are mutually exclusive');
  return o;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { stderr.write(`${e.message}\n${USAGE}`); return EXIT_USAGE; }
  if (args.help) { stdout.write(USAGE); return EXIT_OK; }
  let result;
  try {
    result = await runScoreboard({
      dataDir: args.dataDir ? path.resolve(args.dataDir) : defaultDataDir(),
      sessions: args.sessions, limit: args.limit, out: args.out, roles: args.roles,
    });
  } catch (e) {
    if (e instanceof UsageError) { stderr.write(`categorization-scoreboard: ${e.message}\n${USAGE}`); return EXIT_USAGE; }
    stderr.write(`categorization-scoreboard: ${e.message}\n`);
    return EXIT_ERROR;
  }
  let comparison = null;
  if (args.compare) {
    const prior = readJsonIfPresent(args.compare);
    if (!prior || typeof prior !== 'object') {
      stderr.write('categorization-scoreboard: cannot read --compare report\n');
      return EXIT_ERROR;
    }
    comparison = compareReports(prior, result.report);
  }
  const json = `${JSON.stringify(comparison ? { ...result.report, comparison } : result.report, null, 2)}\n`;
  if (args.out) {
    try { writeFileSync(args.out, json); }
    catch (e) { stderr.write(`categorization-scoreboard: cannot write --out (${errorClassOf(e)})\n`); return EXIT_ERROR; }
  } else {
    stdout.write(json);
  }
  stderr.write(renderSummary(result.report));
  if (comparison) stderr.write(renderComparison(comparison));
  return EXIT_OK;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
