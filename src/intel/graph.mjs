import { foldRevision } from './history.mjs';
import { InvariantViolation, assertInvariant, observeInvariant, NSP_SCHEMA } from '../core/invariants.mjs';
import { stableStringify } from './similarity.mjs';

// Canonical temporal evidence graph.
//
// Three strata, kept separate:
//   observations  immutable references into raw evidence (session, seq, sid, byte span, dom id)
//   entities      semantic nodes with time-indexed versioned state (event-sourced revisions)
//   edges         typed relations (contains, references, rendered_as, caused, same_as, ...)
//                 each with confidence, status (hypothesis | confirmed | rejected) and evidence
// Unknown/evolving schemas are fine: entity state is whatever attributes were observed.
// stateAt(t) replays revisions to reconstruct the semantic state at any moment.
export class TemporalGraph {
  constructor() { this.nodes = new Map(); this.edges = new Map(); this.changes = []; this.types = new Map(); this.invariants = []; this.quarantinedEntities = 0; }

  addType(t) { this.types.set(t.id, { id: t.id, name: t.name, key: t.key?.field ?? null, confidence: t.confidence, fields: t.fields.map((f) => ({ name: f.name, type: f.type, role: f.role, roleConfidence: f.roleConfidence })) }); }

  upsertEntity({ eid, type, typeName, key, attrs = {}, t, evidence, changed, removed = [] }) {
    let n = this.nodes.get(eid);
    // Direct graph clients get the same protection as buildGraph's preflight:
    // do not silently update a node using an incompatible type/typed key.
    const incompatible = n && (
      (n.type != null && type != null && n.type !== type)
      || (n.key != null && key != null
        && (typeof n.key !== typeof key || stableStringify(n.key) !== stableStringify(key))));
    assertInvariant(!incompatible, 'NSP-004', {
      boundary: 'upsert-entity', disposition: 'rejected', reason: 'entity-id-collision',
      entityId: eid, source: { session: evidence?.session, seq: evidence?.seq, sid: evidence?.sid },
    });
    if (!n) n = { eid, type, typeName, key, attrs: {}, history: [], firstT: null, lastT: null };
    const before = n.attrs;
    const removedFields = Array.isArray(removed)
      ? removed.filter((name) => typeof name === 'string' && name.length > 0) : [];
    const nextAttrs = foldRevision({ ...n.attrs }, { values: attrs, removed: removedFields,
      evidence }); // validate first, then publish the newly created node
    n.attrs = nextAttrs;
    if (!this.nodes.has(eid)) this.nodes.set(eid, n);
    if (Number.isFinite(t)) {
      n.firstT = n.firstT === null ? t : Math.min(n.firstT, t);
      n.lastT = n.lastT === null ? t : Math.max(n.lastT, t);
    }
    const rev = { t, changed: changed ?? Object.keys(attrs).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(attrs[k])), values: attrs, ...(removedFields.length ? { removed: removedFields } : {}), evidence };
    n.history.push(rev);
    if (n.history.length > 1 && Number.isFinite(t) && t < n.lastT) {
      // Online callers may ingest late evidence; current attrs must follow event time.
      n.history.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
      n.attrs = n.history.reduce((state, revision) => foldRevision(state, revision), {});
    }
    this.changes.push({ t, eid, revision: n.history.length, changed: rev.changed });
    return n;
  }

  relate({ kind, from, to, confidence, status = 'hypothesis', evidence, t, attrs }) {
    const id = `${kind}:${from}->${to}`;
    const prev = this.edges.get(id);
    const when = Number.isFinite(t) ? t : null;
    const score = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null;
    const startedAt = Number.isFinite(prev?.t) && when !== null ? Math.min(prev.t, when) : prev?.t ?? when;
    const statusHistory = prev?.statusHistory ?? (prev ? [{ t: prev.t ?? null, status: prev.status }] : [{ t: startedAt, status }]);
    if (statusHistory.length && (statusHistory[0].t === null || statusHistory[0].t === prev?.t)) statusHistory[0] = { ...statusHistory[0], t: startedAt };
    const observations = prev?.observations ?? [];
    const observation = { t: when, confidence: score, evidence, ...(attrs ? { attrs } : {}) };
    if (!observations.some((o) => stableStringify(o) === stableStringify(observation))) observations.push(observation);
    const stronger = !prev || (score ?? -1) > (prev.confidence ?? -1);
    const e = { id, kind, from, to, confidence: stronger ? score : prev.confidence,
      status: prev?.status ?? status, statusHistory,
      evidence: stronger ? evidence : prev.evidence, t: startedAt,
      observations, support: observations.length,
      lastT: observations.reduce((latest, o) => o.t === null ? latest : latest === null ? o.t : Math.max(latest, o.t), null),
      ...((stronger ? attrs : prev?.attrs) ? { attrs: stronger ? attrs : prev.attrs } : {}) };
    this.edges.set(id, e);
    return e;
  }

  // Corrections apply at a known time. Never mutate the meaning of an earlier stateAt(t).
  setEdgeStatus(id, status, at = Date.now()) {
    const e = this.edges.get(id);
    if (!e || e.status === status) return e;
    if (!['hypothesis', 'confirmed', 'rejected'].includes(status)) throw new Error('Invalid edge status.');
    const when = Number.isFinite(at) ? at : Date.now();
    e.statusHistory ??= [{ t: e.t ?? null, status: e.status }];
    e.statusHistory.push({ t: Math.max(when, e.t ?? when), status });
    e.status = status;
    return e;
  }

  stateAt(t) {
    const nodes = [];
    for (const n of this.nodes.values()) {
      if (!Number.isFinite(n.firstT) || n.firstT > t) continue;
      const revs = n.history.filter((r) => Number.isFinite(r.t) && r.t <= t).sort((a, b) => a.t - b.t);
      // Materialise the attribute state as of t by folding revision values in order.
      const attrs = revs.reduce((acc, r) => foldRevision(acc, r), {});
      nodes.push({ eid: n.eid, typeName: n.typeName, key: n.key, revision: revs.length, latestChange: revs.at(-1)?.t ?? null, attrs });
    }
    const edges = [];
    for (const e of this.edges.values()) {
      // An undated hypothesis is visible in toJSON(), but is not a fact at an arbitrary past time.
      if (!Number.isFinite(e.t) || e.t > t) continue;
      const statuses = (e.statusHistory ?? [{ t: e.t, status: e.status }])
        .filter((h) => Number.isFinite(h.t) && h.t <= t).sort((a, b) => a.t - b.t);
      const historicalStatus = statuses.at(-1)?.status;
      if (!historicalStatus || historicalStatus === 'rejected') continue;
      const observations = (e.observations ?? []).filter((o) => Number.isFinite(o.t) && o.t <= t).sort((a, b) => a.t - b.t);
      const best = observations.reduce((a, b) => !a || (b.confidence ?? -1) > (a.confidence ?? -1) ? b : a, null);
      edges.push({ ...e, status: historicalStatus, statusHistory: statuses,
        ...(best ? { confidence: best.confidence, evidence: best.evidence, attrs: best.attrs } : {}),
        observations, support: observations.length, lastT: observations.at(-1)?.t ?? e.t });
    }
    return { t, nodes, edges };
  }

  neighbors(eid) { return [...this.edges.values()].filter((e) => e.from === eid || e.to === eid); }

  neighborhood(eid, options = {}) { return graphNeighborhood(this, eid, options); }
  rank(options = {}) { return rankGraphNodes(this, options); }

  toJSON() {
    return { types: [...this.types.values()], nodes: [...this.nodes.values()], edges: [...this.edges.values()],
      invariants: { schema: NSP_SCHEMA, violations: this.invariants },
      stats: { nodes: this.nodes.size, edges: this.edges.size, changes: this.changes.length,
        invariantViolations: this.invariants.length, quarantinedEntities: this.quarantinedEntities,
        byKind: countBy([...this.edges.values()], 'kind'), byStatus: countBy([...this.edges.values()], 'status') } };
  }
}

const countBy = (arr, k) => arr.reduce((a, x) => ((a[x[k]] = (a[x[k]] ?? 0) + 1), a), {});
const nFromHistory = (history) => history.reduce((state, rev) => foldRevision(state, rev), {});

// Build the graph from discovery + identity + correlation outputs.
export function buildGraph({ model, resolutions, renderedHyps = [], actionHyps = [], session }) {
  const g = new TemporalGraph();
  for (const t of model.types) g.addType(t);

  // Preflight ALL entity IDs before materializing any node. Two incompatible
  // entities sharing one EID would otherwise silently overwrite each other.
  // Quarantine both identities, not just whichever was encountered second.
  // The raw observations and unmodified entity dataset stay available.
  const signatures = new Map(), collisions = new Map();
  for (const r of resolutions) for (const e of r.entities) {
    const signature = JSON.stringify([e.type, e.scope, e.method, e.keyType ?? null, e.key]);
    const prior = signatures.get(e.eid);
    if (collisions.has(e.eid)) {
      // Once ambiguous, all subsequent observations of that EID are excluded,
      // even if a later signature happens to match the first one.
      collisions.get(e.eid).add(e);
    } else if (prior && (prior.signature !== signature || e.method !== 'key')) {
      collisions.set(e.eid, new Set([prior.entity, e]));
    } else if (!prior) signatures.set(e.eid, { signature, entity: e });
  }
  for (const [eid, entities] of [...collisions].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
    const first = [...entities][0];
    const receipt = observeInvariant(false, 'NSP-004', {
      boundary: 'build-graph', disposition: 'isolated', reason: 'entity-id-collision',
      entityId: eid, count: entities.size,
      source: { session: first.anchor?.session ?? session?.id,
        sid: first.anchor?.sid, seq: first.anchor?.seq },
    });
    g.invariants.push(receipt);
    g.quarantinedEntities += entities.size;
  }
  const quarantined = new Set(collisions.keys());
  const usable = resolutions.map((r) => ({
    ...r, entities: r.entities.filter((e) => !quarantined.has(e.eid)),
  }));
  const keyIndex = new Map(); // typeId|key -> eid
  for (const r of usable) for (const e of r.entities) {
    let first = true;
    for (const rev of e.revisions) {
      try {
        g.upsertEntity({ eid: e.eid, type: e.type, typeName: e.typeName, key: e.key,
          attrs: rev.values ?? (first ? e.attrs : {}), t: rev.t, changed: rev.changed,
          removed: rev.removed ?? [], evidence: { session: rev.session ?? session?.id, seq: rev.seq,
            sid: rev.sid, domId: rev.domId, t: rev.t } });
        first = false;
      } catch (error) {
        if (!(error instanceof InvariantViolation)) throw error;
        // Reject only this contradictory revision. Preserve valid graph history.
        g.invariants.push(error.receipt);
      }
    }
    if (!e.revisions.length) g.upsertEntity({ eid: e.eid, type: e.type, typeName: e.typeName, key: e.key, attrs: e.attrs, t: e.first });
    // Reconstruct only accepted revisions; never reintroduce a rejected value
    // from the supplied entity's final attrs.
    const node = g.nodes.get(e.eid);
    if (!node) continue;
    node.attrs = nFromHistory(node.history);
    node.confidence = e.confidence; node.confidenceBasis = e.confidenceBasis;
    node.idBasis = e.idBasis; node.anchor = e.anchor;
    if (e.key !== null && e.method === 'key') {
      const key = JSON.stringify([e.type, e.scope, e.keyType ?? typeof e.attrs?.[model.types.find((t) => t.id === e.type)?.key?.field], e.key]);
      const matches = keyIndex.get(key) ?? []; matches.push(e.eid); keyIndex.set(key, matches);
    }
  }
  // Instance-level reference edges from type-level inclusion dependencies.
  for (const rel of model.relationships) {
    if (rel.kind !== 'references') continue;
    const src = usable.find((r) => r.type === rel.from);
    for (const e of src?.entities ?? []) {
      // Reference values may change. Never backdate final-state foreign keys to entity birth.
      const revisions = e.revisions?.length ? e.revisions : [{ t: e.first, values: e.attrs }];
      for (const rv of revisions) {
        const v = rv.values?.[rel.field];
        if (v === undefined || v === null) continue;
        const matches = keyIndex.get(JSON.stringify([rel.to, e.scope, typeof v, String(v)]));
        if (matches?.length !== 1) continue;
        const target = matches[0], targetTime = g.nodes.get(target)?.firstT;
        g.relate({ kind: 'references', from: e.eid, to: target, confidence: rel.confidence,
          evidence: { relationship: rel.id, field: rel.field, session: rv.session ?? session?.id, sid: rv.sid, seq: rv.seq, observedAt: rv.t },
          t: Number.isFinite(rv.t) && Number.isFinite(targetTime) ? Math.max(rv.t, targetTime) : null });
      }
    }
  }
  // Composition at instance level: same observation, nested path.
  for (const rel of model.relationships) {
    if (rel.kind !== 'contains') continue;
    const parent = usable.find((r) => r.type === rel.from), child = usable.find((r) => r.type === rel.to);
    if (!parent || !child) continue;
    const bySeq = new Map();
    for (const e of parent.entities) for (const rv of e.occurrences ?? e.revisions) if (rv.seq !== null && rv.seq !== undefined) {
      const key = JSON.stringify([rv.session ?? '', rv.sid, rv.seq]), entries = bySeq.get(key) ?? [];
      entries.push({ eid: e.eid, location: rv.location }); bySeq.set(key, entries);
    }
    for (const e of child.entities) for (const rv of e.occurrences ?? e.revisions) {
      const candidates = (bySeq.get(JSON.stringify([rv.session ?? '', rv.sid, rv.seq])) ?? [])
        .filter((p) => !p.location || !rv.location || rv.location.startsWith(p.location + '.') || rv.location.startsWith(p.location + '['));
      const unique = [...new Set(candidates.map((p) => p.eid))];
      if (unique.length === 1) g.relate({ kind: 'contains', from: unique[0], to: e.eid, confidence: rel.confidence,
        evidence: { relationship: rel.id, session: rv.session ?? session?.id, sid: rv.sid, seq: rv.seq, location: rv.location }, t: rv.t });
    }
  }
  for (const h of renderedHyps) if (h.to && (!h.from.entity || g.nodes.has(h.from.entity))) g.relate({ kind: 'rendered_as', from: h.from.entity ?? `stream:${h.from.stream}`, to: `dom:${h.to.element}`, confidence: h.score, status: h.status === 'likely' ? 'hypothesis' : h.status, evidence: h.features, t: h.t ?? null });
  for (const h of actionHyps) g.relate({ kind: 'preceded', from: `action:${h.from.actionSeq}`, to: `stream:${h.to.sid}`, confidence: h.score, status: h.status === 'likely' ? 'hypothesis' : h.status, evidence: { ...h.features, scoredRelation: h.relation, score: h.score }, t: h.t ?? null });
  return g;
}

function graphView(graph, at) {
  if (at !== undefined && !Number.isFinite(at)) throw new RangeError('Historical time must be finite');
  if (at !== undefined && typeof graph.stateAt === 'function') return graph.stateAt(at);
  const view = { nodes: graph.nodes instanceof Map ? [...graph.nodes.values()] : graph.nodes ?? [],
    edges: graph.edges instanceof Map ? [...graph.edges.values()] : graph.edges ?? [] };
  if (at === undefined) return view;
  const temporal = new TemporalGraph();
  temporal.nodes = new Map(view.nodes.map((n) => [n.eid, n]));
  temporal.edges = new Map(view.edges.map((e) => [e.id, e]));
  return temporal.stateAt(at);
}

export function graphNeighborhood(graph, eid, { depth = 2, direction = 'both', kinds, minConfidence = 0, maxNodes = 200, at } = {}) {
  if (!['both', 'out', 'in'].includes(direction)) throw new Error('Invalid traversal direction');
  const view = graphView(graph, at), adjacency = new Map();
  const allowed = view.edges.filter((e) => e.status !== 'rejected' && (e.confidence ?? 0) >= minConfidence && (!kinds || kinds.includes(e.kind)));
  for (const edge of allowed) {
    for (const [from, to] of [...(direction !== 'in' ? [[edge.from, edge.to]] : []), ...(direction !== 'out' ? [[edge.to, edge.from]] : [])]) {
      if (!adjacency.has(from)) adjacency.set(from, []); adjacency.get(from).push({ to, edge });
    }
  }
  const cap = Number.isInteger(maxNodes) && maxNodes > 0 ? maxNodes : 200;
  const distances = new Map([[eid, 0]]), queue = [eid], edges = new Map(); let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], distance = distances.get(id); if (distance >= depth) continue;
    for (const next of adjacency.get(id) ?? []) {
      if (!distances.has(next.to)) {
        if (distances.size >= cap) { truncated = true; continue; }
        distances.set(next.to, distance + 1); queue.push(next.to);
      }
      edges.set(next.edge.id, next.edge);
    }
  }
  const nodes = new Map(view.nodes.map((node) => [node.eid, node]));
  return { root: eid, nodes: queue.map((id) => ({ ...(nodes.get(id) ?? { eid: id, external: true }), distance: distances.get(id) })), edges: [...edges.values()], truncated };
}

// Confidence-weighted PageRank, with optional query-biased seeds. Rejected edges never vote.
export function rankGraphNodes(graph, { damping = 0.85, iterations = 60, tolerance = 1e-8, seeds = [], at } = {}) {
  if (!Number.isFinite(damping) || damping <= 0 || damping >= 1) throw new RangeError('damping must be in (0, 1)');
  const view = graphView(graph, at), ids = view.nodes.map((n) => n.eid).sort(), known = new Set(ids);
  if (!ids.length) return [];
  const selected = new Set(seeds.filter((id) => known.has(id)));
  const teleport = new Map(ids.map((id) => [id, selected.size ? (selected.has(id) ? 1 / selected.size : 0) : 1 / ids.length]));
  const outgoing = new Map(ids.map((id) => [id, []])), totals = new Map();
  for (const edge of view.edges) if (edge.status !== 'rejected' && known.has(edge.from) && known.has(edge.to) && edge.confidence > 0) {
    outgoing.get(edge.from).push(edge); totals.set(edge.from, (totals.get(edge.from) ?? 0) + edge.confidence);
  }
  let ranks = new Map(teleport);
  for (let step = 0; step < iterations; step++) {
    let dangling = 0; for (const id of ids) if (!totals.get(id)) dangling += ranks.get(id);
    const next = new Map(ids.map((id) => [id, (1 - damping + damping * dangling) * teleport.get(id)]));
    for (const id of ids) for (const edge of outgoing.get(id)) next.set(edge.to, next.get(edge.to) + damping * ranks.get(id) * edge.confidence / totals.get(id));
    const delta = ids.reduce((sum, id) => sum + Math.abs(next.get(id) - ranks.get(id)), 0); ranks = next;
    if (delta < tolerance) break;
  }
  return ids.map((eid) => ({ eid, score: +ranks.get(eid).toFixed(8) })).sort((a, b) => b.score - a.score || a.eid.localeCompare(b.eid));
}
