// Adapter factory service — the lifecycle owner for learned, data-only webapp adapters.
//
// Wires Capture Studio's existing evidence (derived sessions, live read-only DOM measurement)
// to Agent 14's pure factory module (src/studio/adaptive-adapter-factory.mjs):
//
//   synthesize(sessionIds)          -> candidate (pure; nothing persisted, nothing activated)
//   shadowEvaluate(candidate, ids)  -> held-out shadow receipt (pure)
//   promote(candidate, ids)         -> server-side RE-VERIFICATION, then a versioned save
//   rollback(name, version)         -> VersionedStore pointer move (no re-synthesis)
//   registryProvider()              -> the read-only view the sites registry exposes
//
// Non-negotiable invariants (Agent 14 Round 8 README + Core Issue #68):
//   - A learned adapter is data-only and read-only. It NEVER enters the execution path
//     (getAdapter for drive/send keeps returning handwritten seeds only) and carries
//     send.strategy 'learned-readonly' + authority.sendPermission=false as defense in depth.
//   - Promotion requires the shadow evaluation to be RE-COMPUTED server-side from held-out
//     sessions; a client-supplied receipt alone never promotes anything.
//   - No second registry, no second browser actor, no send grant, no auto-execution.
import { VersionedStore, I1_NAMESPACE_RE, validateExpectedVersion } from '../store/versioned.mjs';
import { synthesizeWebappAdapter, shadowEvaluateAdapter, candidateDigest, FACTORY_SCHEMA } from './adaptive-adapter-factory.mjs';
import { probesFromSession, scopeProbes } from './adapter-probes.mjs';

const bareHost = (value) => {
  let v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split('/')[0].split('?')[0].split('#')[0];
  v = v.split('@').pop();
  v = v.replace(/:\d+$/, '');
  return v.replace(/^www\./, '');
};

const originOf = (url) => {
  try { return new URL(String(url)).origin; } catch { return null; }
};

export class AdapterFactoryError extends Error {
  constructor(code, message) { super(message); this.name = 'AdapterFactoryError'; this.code = code; }
}

function sessionOrigin(session) {
  const url = session?.kv?.get?.('RECEIPT')?.pageUrl ?? session?.meta?.target?.url ?? null;
  return url ? originOf(url) : null;
}

// Build the data-only, read-only adapter object published to the registry's read view.
// Activated features = held-out-CONFIRMED (shadow.coverage) ∩ factory READ_FEATURES ∩
// candidate shadow-ready. composer/send-control/stop-control are write-surface features the
// factory never reports as read features; they can never appear on a learned adapter.
const READ_FEATURES = new Set(['user-turn', 'assistant-turn', 'thread-route', 'citation', 'artifact', 'task-progress', 'stream-component']);
export function learnedAdapterFromCandidate(candidate, shadow) {
  const confirmed = new Set(Array.isArray(shadow?.coverage) ? shadow.coverage : []);
  const activated = [...confirmed].filter((f) => READ_FEATURES.has(f) && candidate.features?.[f]?.selected?.status === 'shadow-ready').sort();
  const sel = (f) => (activated.includes(f) ? candidate.features[f].selected.candidate : null);
  const userTurn = sel('user-turn');
  const assistantTurn = sel('assistant-turn');
  const route = sel('thread-route');
  const stream = sel('stream-component');
  const host = bareHost(candidate.origin);
  return {
    id: candidate.siteId,
    label: `${candidate.siteId} (learned)`,
    hosts: [host],
    url: candidate.origin,
    learned: true,
    readOnly: true,
    // Defense in depth: even if this object ever reached a send path, the strategy is an
    // explicit refusal consumed by src/capture/actions.mjs sendMessage().
    send: { strategy: 'learned-readonly' },
    ...(userTurn ? { userTurn: { selectors: [userTurn] } } : {}),
    ...(assistantTurn ? { assistantTurn: { selectors: [assistantTurn] } } : {}),
    ...(route ? { threadRoute: { pattern: route } } : {}),
    ...(stream ? { streamHints: { urlPatterns: [stream] } } : {}),
    authority: { ...candidate.authority, sendPermission: false, autoExecution: false },
    factory: {
      schema: FACTORY_SCHEMA,
      origin: candidate.origin,
      surface: candidate.surface,
      shadow: { recommendation: shadow?.recommendation ?? null, checked: shadow?.checked ?? 0, positive: shadow?.positive ?? 0, contradicted: shadow?.contradicted ?? 0 },
      readFeatures: activated,
    },
  };
}

export function createAdapterFactory({ learnedStore } = {}) {
  if (!(learnedStore instanceof VersionedStore)) throw new TypeError('learnedStore must be a VersionedStore');

  const collectProbes = (sessions, { siteId, origin, surface }) => {
    const probes = [];
    const sessionOrigins = new Map();
    for (const s of sessions) {
      const o = sessionOrigin(s);
      if (!o) throw new AdapterFactoryError('SESSION_ORIGIN_UNKNOWN', `Session ${s.id} has no usable page URL; derive it first`);
      sessionOrigins.set(s.id, o);
      probes.push(...probesFromSession(s));
    }
    try {
      return scopeProbes(probes, { siteId, origin, surface, sessionOrigins });
    } catch (e) {
      throw new AdapterFactoryError(String(e.message).startsWith('PROBE_ORIGIN_MISMATCH') ? 'PROBE_ORIGIN_MISMATCH' : 'INVALID_PROBES', String(e.message));
    }
  };

  // The I1 learning pipeline owns names `i1-<40 hex>` in the SAME store; the factory never reads,
  // lists or mutates them (and I1 never touches factory site ids). Both go through the one
  // VersionedStore owner (shared lock + expected-version CAS); there is no direct save/rollback here.
  const reserved = (name) => typeof name === 'string' && I1_NAMESPACE_RE.test(name);
  const refuseReserved = (name) => {
    if (reserved(name)) throw new AdapterFactoryError('RESERVED_NAMESPACE', `"${name}" belongs to the I1 learning pipeline namespace`);
  };
  // Read view: unreadable/corrupt/missing heads are "not available" (fail closed); an invalid
  // name still throws STORE_NAME_INVALID so traversal attempts are rejected, not hidden.
  const loadCandidateRecord = (name) => {
    if (reserved(name)) return null;
    try {
      if (!learnedStore.has(name)) return null;
      return learnedStore.load(name);
    } catch (e) {
      if (['STORE_CURRENT_CORRUPT', 'STORE_RECORD_CORRUPT', 'STORE_NO_SUCH_VERSION', 'STORE_NO_SUCH_ITEM'].includes(e?.code)) return null;
      throw e;
    }
  };

  return {
    /** Pure synthesis from saved sessions (+ optional server-produced live probes). Nothing is persisted or activated. */
    synthesize({ siteId, origin, surface = 'chat', sessions = [], priorName = null, liveProbes = [] }) {
      let prior = null;
      let basis = null;
      if (priorName != null) {
        const priorRecord = loadCandidateRecord(priorName);
        prior = priorRecord?.candidate ?? null;
        if (!prior) throw new AdapterFactoryError('PRIOR_NOT_FOUND', `No learned adapter "${priorName}"`);
        basis = { name: priorRecord.name ?? priorName, version: priorRecord.version, priorDigest: candidateDigest(prior) };
      }
      const observations = collectProbes(sessions, { siteId, origin, surface });
      // Live probes are produced server-side (read-only DomObserver measurement) and are already
      // evidence-class-stamped by the producer; only the scope fields are stamped here.
      for (const p of liveProbes) observations.push({ ...p, siteId, origin, surface });
      const candidate = synthesizeWebappAdapter({ siteId, origin, surface, observations, prior });
      // The version this candidate was learned on top of. Promotion over the same name must
      // target exactly this version, so a newer version's learning is never silently discarded.
      if (basis) candidate.basis = basis;
      return {
        candidate,
        evidence: {
          sessions: sessions.map((s) => s.id),
          probeCount: observations.length,
          liveProbes: liveProbes.length,
          liveCandidates: liveProbes.filter((p) => p.feature === 'user-turn' || p.feature === 'assistant-turn' || p.feature === 'thread-route')
            .map((p) => `${p.feature} ${p.candidate}=${p.outcome}`).slice(0, 16),
        },
      };
    },

    /** Pure held-out shadow evaluation. Nothing is persisted or activated. */
    shadowEvaluate({ candidate, sessions = [] }) {
      if (!candidate || candidate.schema !== FACTORY_SCHEMA) throw new AdapterFactoryError('INVALID_CANDIDATE', 'candidate must be an aion.adaptive-webapp-adapter/1 object');
      const observations = collectProbes(sessions, { siteId: candidate.siteId, origin: candidate.origin, surface: candidate.surface });
      return shadowEvaluateAdapter(candidate, observations);
    },

    /**
     * Promotion: re-computes the shadow evaluation server-side from the held-out sessions and
     * only persists when the RECOMPUTED receipt earns a read-only preview. The client receipt
     * is stored for audit but is never trusted for the decision.
     */
    promote({ candidate, sessions = [], clientShadow = null, note = '', expectedVersion } = {}) {
      // Strict, explicit expectation FIRST (before any evidence work): null = first create, integer = must equal CURRENT.
      // A missing/invalid value is refused; the factory never infers the current version.
      validateExpectedVersion(expectedVersion, { allowNull: true });
      if (!candidate || candidate.schema !== FACTORY_SCHEMA) throw new AdapterFactoryError('INVALID_CANDIDATE', 'candidate must be an aion.adaptive-webapp-adapter/1 object');
      refuseReserved(candidate.siteId);
      if (candidate.authority?.sendPermission !== false || candidate.authority?.autoExecution !== false) {
        throw new AdapterFactoryError('AUTHORITY_VIOLATION', 'candidate authority must forbid send and auto-execution');
      }
      // Stale-basis guard: a candidate learned on top of version N of this same name may only
      // replace version N. (CAS alone only proves the caller knows CURRENT, not that the
      // candidate was derived from it.) Candidates synthesized without a prior carry no basis.
      const basis = candidate.basis ?? null;
      if (basis != null) {
        if (typeof basis !== 'object' || typeof basis.name !== 'string' || !Number.isSafeInteger(basis.version)) {
          throw new AdapterFactoryError('BASIS_INVALID', 'candidate.basis must be { name, version } as stamped by synthesize');
        }
        if (basis.name === candidate.siteId && basis.version !== expectedVersion) {
          throw new AdapterFactoryError('STALE_BASIS', `candidate was learned on ${basis.name} v${basis.version}, but promotion targets expectedVersion ${expectedVersion}; re-synthesize with priorName`);
        }
      }
      const recomputed = this.shadowEvaluate({ candidate, sessions });
      if (clientShadow && clientShadow.recommendation && clientShadow.recommendation !== recomputed.recommendation) {
        throw new AdapterFactoryError('SHADOW_MISMATCH', `client receipt said ${clientShadow.recommendation}, server recomputed ${recomputed.recommendation}`);
      }
      if (recomputed.recommendation !== 'candidate-read-only-preview') {
        throw new AdapterFactoryError('PROMOTION_NOT_EARNED', `shadow evaluation is "${recomputed.recommendation}"; only "candidate-read-only-preview" promotes`);
      }
      const adapter = learnedAdapterFromCandidate(candidate, recomputed);
      // The stored digest is recomputed server-side from the content actually saved; a client-held
      // `digest` field is never trusted (it is integrity metadata, not authority).
      const digest = candidateDigest(candidate);
      const claimedDigest = typeof candidate.digest === 'string' ? candidate.digest : null;
      const rec = learnedStore.compareAndSave(candidate.siteId, {
        schema: FACTORY_SCHEMA,
        candidate: { ...candidate, digest },
        candidateDigest: digest,
        digestMatchedClaim: claimedDigest === null ? null : claimedDigest === digest,
        basis,
        lineage: { priorDigest: candidate.lineage?.priorDigest ?? null },
        adapter,
        shadow: recomputed,
        promotedAt: new Date().toISOString(),
      }, {
        expectedVersion,
        changeNote: note || `promoted from shadow receipt (${recomputed.checked} checks, ${recomputed.positive} positive)`,
      });
      return { name: rec.name, version: rec.version, savedAt: rec.savedAt, note: rec.changeNote, adapter, candidateDigest: digest, basis };
    },

    /** Restores a historical version by APPENDING a new version with that content (CURRENT only moves
     *  forward, so a stale expectedVersion can never become valid again). No re-synthesis. */
    rollback(name, version, { expectedVersion } = {}) {
      validateExpectedVersion(expectedVersion, { allowNull: false }); // integer CURRENT required; never inferred
      refuseReserved(name);
      const rec = learnedStore.compareAndRollback(name, version, { expectedVersion });
      return { name: rec.name, version: rec.version, restoredFrom: rec.restoredFrom, savedAt: rec.savedAt, note: rec.changeNote };
    },

    list() {
      return learnedStore.names().filter((name) => !reserved(name)).map((name) => {
        let v = null;
        let versions = [];
        try { v = learnedStore.current(name); versions = learnedStore.versions(name); } catch { /* corrupt head: listed without a pointer */ }
        let summary = null;
        try {
          const rec = learnedStore.load(name);
          summary = {
            siteId: rec.candidate?.siteId ?? name,
            origin: rec.candidate?.origin ?? null,
            surface: rec.candidate?.surface ?? 'chat',
            readFeatures: rec.adapter?.factory?.readFeatures ?? [],
            shadow: rec.shadow ? { recommendation: rec.shadow.recommendation, checked: rec.shadow.checked, positive: rec.shadow.positive, contradicted: rec.shadow.contradicted } : null,
            promotedAt: rec.promotedAt ?? rec.savedAt,
          };
        } catch { summary = null; }
        return { name, currentVersion: v, versions, summary };
      });
    },

    /** The learned adapter currently pointed at, or null. Read view only. */
    loadLearned(name) {
      const rec = loadCandidateRecord(name);
      return rec ? { ...rec.adapter, factory: { ...rec.adapter?.factory, version: rec.version, savedAt: rec.savedAt } } : null;
    },

    /** The full stored record (candidate + shadow receipt + version) for the CURRENT pointer, or null. */
    loadRecord(name) {
      const rec = loadCandidateRecord(name);
      return rec ? { name: rec.name, version: rec.version, savedAt: rec.savedAt, candidate: rec.candidate, shadow: rec.shadow, adapter: rec.adapter,
        candidateDigest: rec.candidateDigest ?? null, basis: rec.basis ?? null, lineage: rec.lineage ?? null } : null;
    },

    /** Read-only registry provider: resolves by learned name or by host. NEVER used by the send/drive path.
     *  Resolutions are LAZY — promotions and rollbacks become visible to the read view immediately. */
    registryProvider() {
      const snapshot = () => {
        const byHost = new Map();
        for (const entry of this.list()) {
          const rec = loadCandidateRecord(entry.name);
          if (!rec?.adapter) continue;
          for (const h of rec.adapter.hosts ?? []) byHost.set(h, rec.adapter);
          byHost.set(entry.name, rec.adapter);
        }
        return byHost;
      };
      return {
        get: async (idOrHost) => {
          const raw = String(idOrHost ?? '').trim().toLowerCase();
          if (!raw) return null;
          const byHost = snapshot();
          const direct = byHost.get(raw);
          if (direct) return direct;
          const host = bareHost(raw);
          return byHost.get(host) ?? null;
        },
        list: async () => {
          const byHost = snapshot();
          return [...byHost.entries()]
            .filter(([k]) => !byHost.get(k) || byHost.get(k).id === k || byHost.get(k).hosts?.[0] === k)
            .map(([, a]) => a)
            .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i);
        },
      };
    },
  };
}
