// Cross-session continuity: a derived, read-through knowledge view over saved session entities.
// No second mutable truth store: deleting/rederiving a session changes this view automatically.
// Only explicitly keyed identities within the same proven site/type scope are joined.
// Keyless and scope-unknown entities remain session-local to avoid false merges.
import { Session, listSessions } from '../store/session.mjs';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { siteOf } from '../profiles/profiles.mjs';
import { foldRevision, summarizeRevisions } from './history.mjs';

export function siteFromSession(meta = {}) {
  try {
    const host = new URL(meta.target?.url).hostname.toLowerCase();
    return host ? siteOf(host) : '';
  } catch { return ''; } // A free-form session label is not a trustworthy site identity.
}

// Registrable site is a discovery grouping, not proof of a shared account/tenant.
// Exact origin is a narrower, observable boundary for automatic keyed joins.
export function originFromSession(meta = {}) {
  try {
    const url = new URL(meta.target?.url);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname
      ? url.origin : '';
  } catch { return ''; }
}

export function continuityTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d{10,13}$/.test(value)) {
    const n = Number(value);
    return value.length === 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const byTime = (a, b) => (a.t ?? Infinity) - (b.t ?? Infinity)
  || (a.sessionCreatedAt ?? 0) - (b.sessionCreatedAt ?? 0)
  || a.session.localeCompare(b.session)
  || (a.seq ?? 0) - (b.seq ?? 0)
  || String(a.sid ?? '').localeCompare(String(b.sid ?? ''));

function recordRevisions(entity, sessionId, sessionCreatedAt) {
  const source = Array.isArray(entity.revisions) && entity.revisions.length
    ? entity.revisions
    : [{ t: entity.last ?? entity.first ?? null, seq: null, sid: null,
        changed: Object.keys(entity.attrs ?? {}), values: entity.attrs ?? {},
        provenanceBasis: 'session-final-state-only' }];
  return source.map((r) => ({
    session: sessionId,
    sessionCreatedAt,
    sid: r.sid ?? null,
    seq: r.seq ?? null,
    domId: r.domId ?? null,
    t: continuityTime(r.t),
    changed: r.changed ?? Object.keys(r.values ?? {}),
    values: r.values ?? {},
    ...(Array.isArray(r.removed) && r.removed.length ? { removed: r.removed } : {}),
    provenanceBasis: r.provenanceBasis ?? (r.values === undefined ? 'revision-values-unavailable' : 'recorded-revision'),
  }));
}

function safeJoin(entity, site, origin, keyField) {
  // The keyed resolver stringifies inferred key values. A missing field can therefore
  // appear as the literal "undefined" (or "null") and must never establish a
  // cross-session identity. Conservatively isolate ambiguous literal keys too.
  const key = entity.key;
  const usableKey = (typeof key === 'string' || typeof key === 'number')
    && String(key).trim().length > 0
    && !['undefined', 'null', 'nan'].includes(String(key).trim().toLowerCase());
  return entity.method === 'key' && usableKey && !!origin && !!keyField
    && entity.scope === site && !!entity.type && !!entity.eid;
}

// A review-only indication, never an inferred identity merge or probability.
// Require a shared origin, exact key and key-field semantics, distinct sessions,
// and materially overlapping structural fields before even surfacing a hint.
function reviewTypeDrift(records, stats) {
  const groups = new Map();
  for (const r of records) {
    // Matching display text does not make numeric and textual identities equal.
    const k = JSON.stringify([r.origin, r.keyField, r.keyType, String(r.key)]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const hints = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.id.localeCompare(b.id));
    // Bound comparisons per repeated key; disclose omitted variants, not fake completeness.
    const sampled = group.slice(0, 32);
    if (group.length > sampled.length) stats.typeDriftVariantsOmitted += group.length - sampled.length;
    for (let i = 0; i < sampled.length; i++) for (let j = i + 1; j < sampled.length; j++) {
      const a = sampled[i], b = sampled[j];
      if (a.type === b.type || a.sessions.some((s) => b.sessions.includes(s))) continue;
      const fieldsA = new Set(a.fields), fieldsB = new Set(b.fields);
      const overlapCount = [...fieldsA].filter((f) => fieldsB.has(f)).length;
      const union = new Set([...fieldsA, ...fieldsB]).size;
      const overlap = union ? overlapCount / union : 0;
      const sameName = a.typeName && b.typeName && a.typeName.toLowerCase() === b.typeName.toLowerCase();
      if (!(overlap >= 0.6 && overlapCount >= 2) && !(sameName && overlapCount >= 1)) continue;
      hints.push({
        kind: 'possible-type-drift', status: 'unconfirmed', identityMerged: false,
        origin: a.origin, key: a.key, keyField: a.keyField,
        structuralFieldOverlap: +overlap.toFixed(3),
        evidenceBasis: 'same-origin keyed structural similarity across disjoint saved sessions',
        candidates: [a, b].map(({ fields, ...member }) => member),
      });
    }
  }
  hints.sort((a, b) => b.structuralFieldOverlap - a.structuralFieldOverlap
    || a.origin.localeCompare(b.origin)
    || String(a.key).localeCompare(String(b.key))
    || a.candidates[0].id.localeCompare(b.candidates[0].id));
  stats.typeDriftHintsTotal = hints.length;
  stats.typeDriftHintsReturned = Math.min(hints.length, 25);
  stats.typeDriftHintsTruncated = Math.max(0, hints.length - 25);
  return hints.slice(0, 25);
}

// The default is intentionally complete for the selected site: any optional limit applies to
// displayed entities only, not the scan. scan/report sizes are disclosed in stats.
export async function buildSiteContinuity(sessionsDir, {
  site, origin = null, eid = null, asOf = null, limit = 50, includeHistory = false,
} = {}) {
  if (typeof site !== 'string' || !site.trim()) throw new Error('A verified site scope is required.');
  const requestedAt = asOf === null || asOf === undefined ? null : continuityTime(asOf);
  if (asOf !== null && asOf !== undefined && requestedAt === null) throw new Error('Invalid as-of timestamp.');
  const maxReturn = Number.isInteger(Number(limit)) && Number(limit) >= 1
    ? Math.min(Number(limit), 1000) : 50;
  // Public read surfaces supply the chosen session origin: never expose a
  // different hosted subdomain just because both share a registrable site.
  // Omitting origin is an explicit internal site-wide analytical view only.
  const sessions = listSessions(sessionsDir).filter((m) => siteFromSession(m) === site
    && (origin === null || originFromSession(m) === origin));
  const stats = {
    site, origin, sessionsDiscovered: sessions.length, sessionsWithDerivedKnowledge: 0,
    sessionsWithoutKnowledge: [], sessionsWithDerivationError: [],
    sourceEntities: 0, keylessOrUnsafeIsolated: 0, untimedRevisions: 0,
    missingRevisionValues: 0, joinedEntities: 0, entitiesTotal: 0, returned: 0, truncated: 0,
    typeDriftHintsTotal: 0, typeDriftHintsReturned: 0,
    typeDriftHintsTruncated: 0, typeDriftVariantsOmitted: 0,
    sessionsSuccessfulEmpty: [], sessionsIncompleteKnowledge: [],
    sessionsLegacyUnverified: [], legacyEidCollisions: 0,
  };
  const groups = new Map();
  for (const meta of sessions) {
    const session = Session.open(sessionsDir, meta.id);
    const model = session.kv.get('MODEL', null);
    const outcome = session.kv.get('KNOWLEDGE_STATUS', null);
    const state = outcome?.status ?? 'legacy';
    const incomplete = (reason) => {
      stats.sessionsIncompleteKnowledge.push({ session: meta.id, reason });
      // Preserve the pre-existing UI's incomplete-session warning without
      // forcing a frontend edit across the separate UI ownership boundary.
      stats.sessionsWithoutKnowledge.push(meta.id);
    };
    if (state === 'failed' || model?.error) {
      stats.sessionsWithDerivationError.push({ session: meta.id, stage: outcome?.stage ?? model?.stage ?? null });
      continue;
    }
    if (outcome && state !== 'complete') {
      incomplete('derivation-' + String(state));
      continue;
    }
    if (!model) {
      if (outcome) incomplete('missing-model');
      else stats.sessionsWithoutKnowledge.push(meta.id);
      continue;
    }
    const dataset = session.dataset('entities');
    const present = existsSync(dataset.file);
    if (!present && !(state === 'complete' && outcome.entityCount === 0)) {
      if (outcome) incomplete('missing-entities-dataset');
      else stats.sessionsWithoutKnowledge.push(meta.id);
      continue;
    }
    // Stage a session before adding it to the joined knowledge view. A torn or
    // truncated dataset must not leak a misleading partial identity/history.
    const sessionEntities = [];
    try {
      // The generic dataset iterator skips invalid JSON. Continuity must instead reject
      // the entire session, including valid rows preceding a torn/corrupt write.
      if (present) {
        const input = createReadStream(dataset.file, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!line.trim()) continue;
            const entity = JSON.parse(line);
            if (!entity || typeof entity.eid !== 'string' || !entity.eid) throw new Error('invalid-entity-row');
            sessionEntities.push(entity);
          }
        } finally { lines.close(); input.destroy(); }
      }
    } catch {
      incomplete('unreadable-entities-dataset');
      continue;
    }
    if (state === 'complete' &&
        (!Number.isSafeInteger(outcome.entityCount) || outcome.entityCount < 0
          || outcome.entityCount !== sessionEntities.length)) {
      incomplete('entity-count-mismatch');
      continue;
    }
    if (!outcome) stats.sessionsLegacyUnverified.push(meta.id);
    if (!sessionEntities.length) stats.sessionsSuccessfulEmpty.push(meta.id);
    stats.sessionsWithDerivedKnowledge++;
    const createdAt = continuityTime(meta.createdAt);
    const origin = originFromSession(meta);
    const types = new Map((model.types ?? []).map((t) => [t.id, t]));
    const eidCounts = new Map();
    for (const e of sessionEntities) eidCounts.set(e.eid, (eidCounts.get(e.eid) ?? 0) + 1);
    const eidOccurrences = new Map();
    for (const e of sessionEntities) {
      stats.sourceEntities++;
      const occurrence = (eidOccurrences.get(e.eid) ?? 0) + 1;
      eidOccurrences.set(e.eid, occurrence);
      const legacyCollision = eidCounts.get(e.eid) > 1;
      if (legacyCollision) stats.legacyEidCollisions++;
      const typeInfo = types.get(e.type);
      const keyField = typeInfo?.key?.field ?? null;
      const joinable = !legacyCollision && safeJoin(e, site, origin, keyField);
      if (!joinable) stats.keylessOrUnsafeIsolated++;
      // Isolate legacy collision rows even inside a single stored session.
      // Join on the key value itself when present: old and new EID hash formats differ,
      // so the EID must not partition otherwise-identical keyed entities.
      // Older entities without persisted keyType belong to their own
      // compatibility cohort, not the number/string cohorts.
      const keyType = e.keyType === 'number' || e.keyType === 'string'
        ? e.keyType : 'legacy-untyped';
      const groupKey = joinable
        ? JSON.stringify(['key', site, origin, e.type, keyField, keyType, String(e.key)])
        : JSON.stringify(['session', meta.id, e.eid, occurrence]);
      let item = groups.get(groupKey);
      if (!item) {
        item = {
          // Stable origin-qualified public ID prevents colliding site-level EIDs across hosts.
          // The raw EID remains available and accepted by the existing eid filter.
          id: joinable ? origin + '::' + e.eid
            : meta.id + '::' + e.eid + (legacyCollision ? '::legacy-' + occurrence : ''),
          eid: e.eid, type: e.type ?? null, typeName: e.typeName ?? null,
          scope: e.scope ?? null, origin: joinable ? origin : null,
          key: e.key ?? null, keyField: joinable ? keyField : null,
          keyType,
          fieldNames: new Set(), identityBasis: joinable ? 'exact-site-type-key'
            : legacyCollision ? 'session-local-legacy-collision'
              : e.method === 'provisional' ? 'provisional-missing-key' : 'session-local',
          confidence: e.confidence ?? null, sessionIds: [], observationCount: 0, history: [],
        };
        groups.set(groupKey, item);
      }
      item.sessionIds.push(meta.id);
      for (const field of typeInfo?.fields ?? []) if (field.name) item.fieldNames.add(field.name);
      item.observationCount += e.observations ?? 0;
      item.history.push(...recordRevisions(e, meta.id, createdAt));
    }
  }
  const entries = [], driftRecords = [];
  for (const item of groups.values()) {
    item.history.sort(byTime);
    const revisions = requestedAt === null ? item.history
      : item.history.filter((r) => r.t !== null && r.t <= requestedAt);
    if (!revisions.length) continue;
    // Entity details are a frequent UI/API request. Preserve full scan,
    // completeness counts and drift hints but avoid folding unrelated histories.
    const materialize = !eid || eid === item.id || eid === item.eid;
    const attrs = {};
    for (const rv of revisions) {
      if (rv.t === null) { stats.untimedRevisions++; continue; }
      if (rv.provenanceBasis === 'revision-values-unavailable') stats.missingRevisionValues++;
      if (materialize) foldRevision(attrs, rv);
    }
    const visibleSessionIds = [...new Set(revisions.map((rv) => rv.session))].sort();
    const times = revisions.map((rv) => rv.t).filter((t) => t !== null);
    const result = {
      id: item.id, eid: item.eid, type: item.type, typeName: item.typeName,
      scope: item.scope, origin: item.origin, key: item.key,
      keyField: item.keyField, keyType: item.keyType,
      identityBasis: item.identityBasis,
      confidence: visibleSessionIds.length > 1 ? null : item.confidence,
      confidenceBasis: visibleSessionIds.length > 1 ? 'cross-session confidence not calibrated'
        : item.identityBasis === 'provisional-missing-key' ? 'missing inferred identity key; unscored' : 'single-session resolver estimate',
      sessions: visibleSessionIds, sessionCount: visibleSessionIds.length,
      observations: requestedAt === null ? item.observationCount : null, revisions: revisions.length,
      timedRevisions: times.length, untimedRevisions: revisions.length - times.length,
      firstT: times.length ? times[0] : null, lastT: times.length ? times[times.length - 1] : null,
      attrs,
      activity: summarizeRevisions(revisions),
      ...(includeHistory && materialize ? { history: revisions.map(({ sessionCreatedAt, ...r }) => r) } : {}),
    };
    entries.push(result);
    if (item.identityBasis === 'exact-site-type-key') {
      if (visibleSessionIds.length > 1) stats.joinedEntities++;
      const source = revisions.find((r) => r.seq !== null || r.domId !== null) ?? revisions[0];
      driftRecords.push({
        id: result.id, eid: result.eid, type: result.type, typeName: result.typeName,
        origin: item.origin, key: result.key, keyField: item.keyField,
        keyType: item.keyType,
        sessions: visibleSessionIds, fields: [...item.fieldNames].sort(),
        evidence: { session: source.session, seq: source.seq, sid: source.sid,
          domId: source.domId, t: source.t },
      });
    }
  }
  entries.sort((a, b) => b.sessionCount - a.sessionCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  stats.entitiesTotal = entries.length;
  const typeDriftHints = reviewTypeDrift(driftRecords, stats);
  const matched = eid ? entries.filter((e) => e.id === eid || e.eid === eid) : entries;
  const returned = matched.slice(0, maxReturn);
  stats.returned = returned.length;
  stats.truncated = matched.length - returned.length;
  return {
    site, origin, asOf: requestedAt, entities: returned, typeDriftHints, stats,
    limitations: [
      'Automatic joins require an exact origin, site, type, key field and typed key value; this does not prove tenant equality inside one origin.',
      'Legacy untyped key rows remain a distinct compatibility cohort until rederived; their numeric-vs-string identity cannot be proven.',
      'User-facing continuity views are scoped to the selected recording origin; an omitted origin requests a broader internal site-wide audit.',
      'Possible type-drift hints are unconfirmed structural comparisons, not identity matches or calibrated probabilities; they never change joined entities.',
      'Keyless and missing/ambiguous keyed observations remain separate across sessions; missing observations are not deletions.',
      'Historical state uses saved revision values and explicit removed-field operations; an absent field without a removal event is not a deletion.',
      'Missing or untimed evidence cannot establish an as-of state; capture currently does not infer retractions.',
      'No copied knowledge index is stored; results recompute from extant derived session data.',
      'Reading all saved sessions has cost proportional to their derived entity and revision count.',
      'Legacy sessions without outcome markers are included only when an entities dataset is readable; their derivation completeness remains unverified.',
      'Incomplete, corrupt and count-mismatched entity datasets are excluded rather than silently contributing partial entity history.',
      'Cross-session identity confidence is uncalibrated; a matching hashed key is conservative evidence, not external confirmation.',
    ],
  };
}
