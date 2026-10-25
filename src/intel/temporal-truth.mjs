// Capture Studio L4/L5 temporal truth boundary. No raw-log, graph, server or CLI writes.
// Event time describes observations; knowledge time describes availability of a model;
// a retrospective interpretation must never masquerade as a historical belief.
export const TEMPORAL_CONTRACT = 'capture-studio.temporal-truth/1';
export const TEMPORAL_LENSES = Object.freeze(['observed', 'as-known', 'retrospective']);

export class TemporalQueryError extends Error {
  constructor(code, message) { super(message); this.name = 'TemporalQueryError'; this.code = code; }
}
const fail = (code, message) => { throw new TemporalQueryError(code, message); };
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);

// Reject local/unzoned timestamps. Numeric timestamps are epoch milliseconds only.
export function temporalMillis(value, label = 'timestamp') {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    fail('INVALID_TIME', label + ' must be a nonnegative epoch-millisecond integer');
  }
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value))
    fail('INVALID_TIME', label + ' must carry an explicit UTC offset');
  const t = Date.parse(value);
  if (!Number.isSafeInteger(t) || t < 0) fail('INVALID_TIME', label + ' is not a valid instant');
  return t;
}

export function normalizeTemporalQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) fail('INVALID_QUERY', 'A temporal query object is required');
  const lens = query.lens;
  if (!TEMPORAL_LENSES.includes(lens)) fail('INVALID_LENS', 'Choose observed, as-known or retrospective explicitly');
  const eventAsOf = temporalMillis(query.eventAsOf, 'eventAsOf');
  const hasKnowledge = own(query, 'knowledgeAsOf') && query.knowledgeAsOf != null;
  const knowledgeAsOf = hasKnowledge ? temporalMillis(query.knowledgeAsOf, 'knowledgeAsOf') : null;
  const hasRevision = own(query, 'modelRevision') && query.modelRevision != null;
  const modelRevision = hasRevision ? query.modelRevision : null;
  if (hasRevision && (!Number.isSafeInteger(modelRevision) || modelRevision < 0)) fail('INVALID_REVISION', 'modelRevision must be a nonnegative safe integer');
  if (lens === 'observed' && (hasKnowledge || hasRevision)) fail('AMBIGUOUS_LENS', 'Raw observations have no model revision or knowledge-time selector');
  if (lens === 'as-known' && !hasKnowledge) fail('KNOWLEDGE_TIME_REQUIRED', 'As-known requires an explicit knowledgeAsOf');
  if (lens === 'retrospective' && !hasRevision) fail('MODEL_REVISION_REQUIRED', 'Retrospective reconstruction requires a pinned modelRevision');
  return { lens, eventAsOf, knowledgeAsOf, modelRevision };
}

// An L1/L2 locator, not proof of identity, completeness, acceptance or semantic truth.
export function observationBoundary(source, eventAsOf) {
  if (!source || typeof source !== 'object') return { state: 'unavailable', reason: 'NO_SOURCE_REFERENCE', provenance: null };
  const { session, seq, sid = null, t, coverage = 'unknown', gaps = 0, truncated = false, preAttachUnknown = false } = source;
  if (typeof session !== 'string' || !session || !Number.isSafeInteger(seq) || seq < 0)
    return { state: 'unavailable', reason: 'INVALID_SOURCE_REFERENCE', provenance: null };
  // Preserve only locator + fidelity metadata; never echo captured text, tokens or body.
  const provenance = { session, seq, sid: typeof sid === 'string' ? sid : null, observedAt: null };
  if (t == null) return { state: 'unknown-time', reason: 'UNTIMED_EVIDENCE', provenance };
  let observedAt;
  try { observedAt = temporalMillis(t, 'source.t'); }
  catch { return { state: 'unknown-time', reason: 'INVALID_SOURCE_TIME', provenance }; }
  provenance.observedAt = observedAt;
  if (observedAt > eventAsOf) return { state: 'not-yet-observed', reason: 'FUTURE_EVIDENCE', provenance };
  const gapCount = Number.isSafeInteger(gaps) && gaps >= 0 ? gaps : null;
  const complete = coverage === 'complete' && gapCount === 0 && !truncated && !preAttachUnknown;
  return { state: complete ? 'observed' : 'partial', reason: complete ? null : 'COVERAGE_UNVERIFIED',
    provenance, fidelity: { gaps: gapCount, truncated: !!truncated, preAttachUnknown: !!preAttachUnknown } };
}

const savedAt = (snap) => {
  try { return snap?.savedAt == null ? null : temporalMillis(snap.savedAt, 'snapshot.savedAt'); }
  catch { return null; }
};
const revisions = (journal) => {
  if (!journal || typeof journal.versions !== 'function' || typeof journal.at !== 'function')
    fail('JOURNAL_REQUIRED', 'A versioned immutable learner journal is required');
  const all = journal.versions();
  if (!Array.isArray(all) || all.some((r, i) => !Number.isSafeInteger(r) || r < 0 || (i > 0 && r <= all[i - 1])))
    fail('INVALID_JOURNAL', 'Learner revisions must be ordered and unique');
  return all;
};

export function selectTemporalModel(journal, query) {
  const q = normalizeTemporalQuery(query);
  if (q.lens === 'observed') return { status: 'not-applicable', revision: null, savedAt: null, snapshot: null };
  const known = revisions(journal);
  if (q.lens === 'retrospective') {
    if (!known.includes(q.modelRevision)) return { status: 'unavailable', reason: 'REVISION_NOT_FOUND', revision: q.modelRevision };
    const snapshot = journal.at(q.modelRevision); // delegated integrity verification
    if (snapshot?.revision !== q.modelRevision || savedAt(snapshot) === null)
      return { status: 'unavailable', reason: 'REVISION_METADATA_UNVERIFIED', revision: q.modelRevision };
    return { status: 'selected', revision: q.modelRevision, savedAt: savedAt(snapshot), snapshot };
  }
  let lastTime = -1, candidate = null;
  for (const revision of known) {
    const snapshot = journal.at(revision); // validate each historical integrity boundary
    const t = savedAt(snapshot);
    if (snapshot?.revision !== revision || t === null)
      return { status: 'unavailable', reason: 'UNTIMED_MODEL_HISTORY', revision: null };
    if (t < lastTime) return { status: 'unavailable', reason: 'NONMONOTONIC_MODEL_CLOCK', revision: null };
    lastTime = t;
    if (t <= q.knowledgeAsOf) candidate = { revision, savedAt: t, snapshot };
  }
  if (!candidate) return { status: 'unavailable', reason: 'NO_MODEL_KNOWN_AT_TIME', revision: null };
  if (q.modelRevision !== null && q.modelRevision !== candidate.revision)
    return { status: 'unavailable', reason: 'MODEL_REVISION_TIME_CONFLICT', revision: null };
  return { status: 'selected', ...candidate };
}

// An interpreter is supplied by L5 (usually a *detached* ScopedLearner hydrated
// from the pinned journal snapshot). We never write to the journal or raw evidence.
export function temporalPerspective({ query, source, journal, interpret, derivation = null }) {
  const q = normalizeTemporalQuery(query);
  const evidence = observationBoundary(source, q.eventAsOf);
  const selected = q.lens === 'observed' ? { status: 'not-applicable', revision: null, savedAt: null } : selectTemporalModel(journal, q);
  const notYetKnown = q.lens === 'as-known' && evidence.provenance?.observedAt != null &&
    evidence.provenance.observedAt > q.knowledgeAsOf;
  const eligible = (evidence.state === 'observed' || evidence.state === 'partial') && !notYetKnown;
  const mayInterpret = eligible && selected.status === 'selected' && typeof interpret === 'function';
  const prediction = mayInterpret ? interpret(selected.snapshot) : null;
  const metadataValid = !!(derivation && selected.status === 'selected' &&
    derivation.modelRevision === selected.revision && typeof derivation.recipeVersion === 'string' &&
    derivation.recipeVersion.length && typeof derivation.sourceDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(derivation.sourceDigest));
  let historicalDerivation = false;
  if (metadataValid && q.lens === 'as-known') {
    try { historicalDerivation = temporalMillis(derivation.derivedAt, 'derivedAt') <= q.knowledgeAsOf; }
    catch { historicalDerivation = false; }
  }
  return {
    schema: TEMPORAL_CONTRACT, lens: q.lens, eventAsOf: q.eventAsOf, knowledgeAsOf: q.knowledgeAsOf,
    evidence, model: { status: selected.status, revision: selected.revision ?? null,
      savedAt: selected.savedAt ?? null, ...((selected.reason) ? { reason: selected.reason } : {}) },
    interpretation: mayInterpret ? { status: 'recomputed-with-pinned-model', value: prediction } :
      { status: 'unavailable', reason: notYetKnown ? 'EVIDENCE_NOT_YET_KNOWN' : !eligible ? 'NO_OBSERVED_EVIDENCE' : selected.reason ?? 'NO_PINNED_INTERPRETER' },
    historicalBelief: historicalDerivation ? 'derivation-metadata-present-not-independently-verified' : 'not-proven',
    limitations: [
      ...(evidence.state !== 'observed' ? ['source-coverage-not-complete'] : []),
      ...(notYetKnown ? ['evidence-after-knowledge-time'] : []),
      ...(selected.status === 'unavailable' ? ['model-history-unavailable'] : []),
      ...(!historicalDerivation && q.lens === 'as-known' ? ['archived-derivation-not-proven'] : []),
    ],
  };
}

export function compareTemporalRevisions({ journal, before, after, interpret }) {
  if (typeof interpret !== 'function') fail('INTERPRETER_REQUIRED', 'A deterministic pinned-model interpreter is required');
  const all = revisions(journal);
  for (const r of [before, after]) if (!Number.isSafeInteger(r) || !all.includes(r)) fail('REVISION_NOT_FOUND', 'Both learner revisions must exist');
  const first = journal.at(before), second = journal.at(after);
  if (first?.revision !== before || second?.revision !== after) fail('INVALID_JOURNAL', 'Snapshot revision does not match selection');
  return { schema: TEMPORAL_CONTRACT, before: { revision: before, savedAt: savedAt(first), prediction: interpret(first) },
    after: { revision: after, savedAt: savedAt(second), prediction: interpret(second) },
    effect: 'counterfactual-model-comparison-not-observed-historical-belief' };
}
