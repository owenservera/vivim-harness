// Agent 14 — generic, pure, evidence-weighted adapter candidate compiler.
// Does not run CDP, execute DOM selectors, invoke a sender, or modify the current profile.
// Existing Capture Studio capture/intelligence components produce the observations.
import { createHash } from 'node:crypto';
export const FACTORY_SCHEMA = 'aion.adaptive-webapp-adapter/1';

// Canonical (sorted-key) JSON so a JSON round-trip through a client cannot change the digest.
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v ?? null);
// Content digest of a candidate: everything the factory derived from evidence. Server-side
// stamps added after synthesis (`digest` itself, `basis`) are excluded.
export function candidateDigest(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new TypeError('INVALID_CANDIDATE');
  const { digest: _d, basis: _b, ...content } = candidate;
  return createHash('sha256').update(canonical(content)).digest('hex');
}

const FEATURES = Object.freeze([
  'composer', 'send-control', 'user-turn', 'assistant-turn', 'stop-control',
  'thread-route', 'citation', 'artifact', 'task-progress', 'stream-component',
]);
const FEATURE_SET = new Set(FEATURES);
const TYPES = new Set(['selector', 'route', 'stream-map']);
const OUTCOMES = new Set(['present', 'absent', 'unknown']);
const CARRIERS = new Set(['dom', 'a11y', 'network', 'correlated']);
const SOURCES = new Set(['SAVED_REAL_CAPTURE', 'SANDBOX_REAL_BROWSER', 'WINDOWS_LIVE_ACCEPTED', 'SYNTHETIC_TEST']);
const READ_FEATURES = new Set(['user-turn', 'assistant-turn', 'thread-route', 'citation', 'artifact', 'task-progress', 'stream-component']);
const evidenceKey = (o) => `${o.captureId}:${o.sequence}`;
const isString = (s, n = 256) => typeof s === 'string' && !!s.length && s.length <= n && !/[\x00-\x1f\x7f]/.test(s);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function safeOrigin(origin) {
  if (!isString(origin, 512)) throw new TypeError('INVALID_ORIGIN');
  let u;
  try { u = new URL(origin); } catch { throw new TypeError('INVALID_ORIGIN'); }
  if (u.protocol !== 'https:' || u.origin !== origin) throw new TypeError('INVALID_ORIGIN');
  return origin;
}
function observationValid(o, siteId, origin, surface) {
  if (!o || typeof o !== 'object' || o.siteId !== siteId || o.origin !== origin || o.surface !== surface
    || !FEATURE_SET.has(o.feature) || !TYPES.has(o.type) || !OUTCOMES.has(o.outcome)
    || !CARRIERS.has(o.carrier) || !SOURCES.has(o.evidenceClass)
    || !isString(o.candidate, 320) || !isString(o.captureId, 128)
    || !Number.isSafeInteger(o.sequence) || o.sequence < 0
    || (o.outcome === 'absent' && o.coverage !== 'complete')) return false;
  // A producer may report absence only with a complete bounded probe; otherwise unknown.
  if (o.type === 'selector' && !['dom', 'a11y'].includes(o.carrier)) return false;
  if (o.type === 'stream-map' && !['network', 'correlated'].includes(o.carrier)) return false;
  return true;
}
function ruleType(feature) {
  if (feature === 'thread-route') return 'route';
  if (feature === 'stream-component') return 'stream-map';
  return 'selector';
}
function groupEvidence(samples) {
  const byCapture = new Map();
  for (const o of samples) {
    const prior = byCapture.get(o.captureId);
    // A capture can provide at most one vote; contradictory probes count as unknown.
    if (!prior) byCapture.set(o.captureId, { outcome: o.outcome, refs: [evidenceKey(o)], source: o.evidenceClass });
    else {
      const next = prior.outcome === o.outcome ? prior.outcome : 'unknown';
      prior.outcome = next;
      prior.refs.push(evidenceKey(o));
      if (prior.source !== o.evidenceClass) prior.source = 'MIXED';
    }
  }
  return [...byCapture.values()];
}
function scoreCandidate(group, baseline) {
  const votes = groupEvidence(group.samples);
  const pos = votes.filter(x => x.outcome === 'present');
  const neg = votes.filter(x => x.outcome === 'absent');
  const unk = votes.length - pos.length - neg.length;
  const realPositive = pos.filter(x => x.source !== 'SYNTHETIC_TEST' && x.source !== 'MIXED').length;
  const rate = (pos.length + neg.length) ? pos.length / (pos.length + neg.length) : 0;
  const confidence = +((pos.length + 1) / (pos.length + neg.length + 2)).toFixed(4);
  const eligible = pos.length >= 3 && realPositive >= 2 && neg.length === 0;
  return {
    type: group.type, candidate: group.candidate, feature: group.feature,
    provenance: { sessions: votes.length, positive: pos.length, contradicted: neg.length, unknown: unk,
      realPositive, refs: [...new Set(votes.flatMap(x => x.refs))].sort(compare).slice(0, 40), refsTruncated: votes.flatMap(x => x.refs).length > 40 },
    confidence, agreement: +rate.toFixed(4),
    status: eligible ? 'shadow-ready' : pos.length ? 'provisional' : 'unverified',
    retainedPrior: baseline === group.candidate,
  };
}

// observations are pre-normalized, source-qualified probes from existing CDP/DOM/network + intel.
// The returned declarative spec is NOT a permitted browser-action dispatch or proof of acceptance.
export function synthesizeWebappAdapter({ siteId, origin, surface = 'chat', observations = [], prior = null } = {}) {
  if (!isString(siteId, 80) || !/^[a-z0-9][a-z0-9-]*$/.test(siteId) || !isString(surface, 60))
    throw new TypeError('INVALID_ADAPTER_SCOPE');
  safeOrigin(origin);
  if (!Array.isArray(observations) || observations.length > 25000) throw new TypeError('INVALID_OBSERVATIONS');
  if (prior && (prior.schema !== FACTORY_SCHEMA || prior.siteId !== siteId || prior.origin !== origin || prior.surface !== surface))
    throw new TypeError('PRIOR_SCOPE_MISMATCH');
  const groups = new Map();
  for (const observation of observations) {
    if (!observationValid(observation, siteId, origin, surface) || observation.type !== ruleType(observation.feature))
      throw new TypeError('INVALID_OBSERVATION');
    const key = JSON.stringify([observation.feature, observation.type, observation.candidate]);
    if (!groups.has(key)) groups.set(key, { feature: observation.feature, type: observation.type, candidate: observation.candidate, samples: [] });
    groups.get(key).samples.push(observation);
  }
  const features = {};
  const drift = [];
  for (const feature of FEATURES) {
    const old = prior?.features?.[feature]?.selected?.candidate ?? null;
    const ranked = [...groups.values()].filter(x => x.feature === feature)
      .map(x => scoreCandidate(x, old))
      .sort((a, b) => (b.provenance.realPositive - a.provenance.realPositive)
        || (b.provenance.positive - a.provenance.positive)
        || (a.provenance.contradicted - b.provenance.contradicted)
        || (b.confidence - a.confidence) || compare(a.candidate, b.candidate));
    const best = ranked.find(x => x.status === 'shadow-ready') ?? ranked.find(x => x.provenance.positive > 0) ?? null;
    const previousPresent = old && ranked.find(x => x.candidate === old);
    const previousContradicted = !!(previousPresent && previousPresent.provenance.contradicted > 0);
    // Fail closed on drift: a prior rule that fresh evidence contradicts is never carried forward
    // with its old (possibly shadow-ready) status. Without a supported replacement the feature
    // becomes unselected and the retired rule is recorded instead of silently inherited.
    const inheritable = !best && !previousContradicted && !!prior?.features?.[feature]?.selected;
    const selected = best ?? (inheritable ? prior.features[feature].selected : null);
    if (previousContradicted)
      drift.push({ feature, previousCandidate: old, reason: 'PREVIOUS_CANDIDATE_NEGATIVE_OBSERVATION', evidence: previousPresent.provenance.refs });
    if (old && best && best.candidate !== old)
      drift.push({ feature, previousCandidate: old, proposedCandidate: best.candidate, reason: 'PROPOSED_REPLACEMENT_REQUIRES_SHADOW_VALIDATION' });
    if (previousContradicted && !best)
      drift.push({ feature, previousCandidate: old, reason: 'PREVIOUS_CANDIDATE_RETIRED_NO_REPLACEMENT' });
    features[feature] = { selected, proposals: ranked.slice(0, 8), inherited: inheritable,
      ...(previousContradicted && !best ? { retired: { candidate: old, reason: 'CONTRADICTED_BY_FRESH_EVIDENCE' } } : {}) };
  }
  const covers = Object.fromEntries(Object.entries(features).map(([k,v]) => [k, v.selected?.status ?? 'unverified']));
  const uniqueCaptures = [...new Set(observations.map(o => o.captureId))].sort(compare);
  const candidate = {
    schema: FACTORY_SCHEMA, siteId, origin, surface, kind: 'data-only-adapter-candidate',
    evidence: { observations: observations.length, captures: uniqueCaptures.length, captureRefs: uniqueCaptures.slice(0, 80),
      capturesTruncated: uniqueCaptures.length > 80 },
    features, coverage: covers, drift,
    // Version lineage: which exact prior content this candidate was learned on top of.
    // Recomputed from the prior's content, never taken from its own (claimable) digest field.
    lineage: { priorDigest: prior ? candidateDigest(prior) : null },
    // Preserve the single Studio actor and require its journal/lease/effect-policy.
    authority: { browser: 'existing-capture-studio-only', sendPermission: false, autoExecution: false },
  };
  candidate.digest = candidateDigest(candidate);
  return candidate;
}

// Evaluate on held-out source-qualified probes, not the training observations.
// NO candidate is automatically activated here; compatible snapshot tests inform the existing
// VersionedStore and rollout controller's decision.
export function shadowEvaluateAdapter(candidate, heldout = []) {
  if (!candidate || candidate.schema !== FACTORY_SCHEMA || !Array.isArray(heldout))
    throw new TypeError('INVALID_SHADOW_INPUT');
  const checks = [];
  for (const [feature, slot] of Object.entries(candidate.features)) {
    const rule = slot.selected;
    if (!rule) continue;
    const samples = heldout.filter(o => o.feature === feature && o.candidate === rule.candidate);
    for (const o of samples) {
      if (!observationValid(o, candidate.siteId, candidate.origin, candidate.surface)) throw new TypeError('INVALID_SHADOW_OBSERVATION');
      checks.push({ feature, captureId: o.captureId, passed: o.outcome === 'present', unknown: o.outcome === 'unknown', ref: evidenceKey(o) });
    }
  }
  const confirmed = checks.filter(x => x.passed);
  const failed = checks.filter(x => !x.passed && !x.unknown);
  const observedFeatures = [...new Set(confirmed.map(x => x.feature))];
  const readyReadFeatures = observedFeatures.filter(x => READ_FEATURES.has(x)
    && candidate.features[x].selected.status === 'shadow-ready');
  return {
    schema: 'aion.adapter-shadow-evaluation/1', checked: checks.length, positive: confirmed.length,
    contradicted: failed.length, unknown: checks.length - confirmed.length - failed.length,
    coverage: observedFeatures.sort(compare), failures: failed,
    // A rollout controller may use this to promote a version to a read-only preview;
    // it must still verify actual target binding and provenance, and cannot grant send.
    recommendation: failed.length > 0 ? 'quarantine' : readyReadFeatures.length ? 'candidate-read-only-preview' : 'collect-more-evidence',
    publishExecuted: false, sendPermission: false, checks,
  };
}