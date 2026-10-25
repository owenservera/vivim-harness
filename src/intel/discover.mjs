// Generic model discovery for a website never seen before.
//
// Input: an observation corpus — samples { value, source: { kind, group, endpoint, sid, seq, t, domId } }.
// Output: a candidate data model — record types (schema, key, field roles), relationships
// (composition, references, dangling references), merged types, family alignments — every item
// with confidence and the evidence it rests on. Nothing here knows any specific website.
import { createHash } from 'node:crypto';
import { SchemaNode, schemaSimilarity, alignFields, nameSimilarity, tokens, sampleIndices, shapeKey } from './schema.mjs';
import { ScopedLearner, argmax } from './learn.mjs';
import { shingles, containment } from './identity.mjs';
import { stableStringify, typedValueKey } from './similarity.mjs';

const h = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const VAL_CAP = 5000;

// ---------------------------------------------------------------------------------------------
// 1. Locate record-bearing positions and gather instances (objects) with provenance.
//    Positions: group roots, array items, dynamic-map values. Paths use [*] for both.
// ---------------------------------------------------------------------------------------------
function looksDynamicKeys(o) {
  const ks = Object.keys(o);
  return ks.length >= 3 && ks.filter((k) => /^\d+(\.\d+)*$/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k) || /^[0-9a-f]{16,}$/i.test(k) || (/^[A-Za-z0-9_-]{16,}$/.test(k) && /\d/.test(k))).length / ks.length >= 0.8;
}

function collectInstances(value, path, out, prov, depth = 0) {
  if (depth > 12) return;
  if (Array.isArray(value)) { for (const i of sampleIndices(value.length, (i) => shapeKey(value[i]), { head: 400, stride: 400 })) collectInstances(value[i], `${path}[*]`, out, { ...prov, index: i, location: `${prov.location ?? path}[${i}]` }, depth + 1); return; }
  if (!isObj(value)) return;
  if (looksDynamicKeys(value)) { const ents = Object.entries(value); for (const i of sampleIndices(ents.length, (i) => shapeKey(ents[i][1]), { head: 400, stride: 400 })) collectInstances(ents[i][1], `${path}[*]`, out, { ...prov, mapKey: ents[i][0], location: `${prov.location ?? path}[${JSON.stringify(ents[i][0])}]` }, depth + 1); return; }
  const list = out.get(path) ?? [];
  const provenance = { ...prov, path, location: prov.location ?? path };
  if (list.length < VAL_CAP) list.push({ obj: value, prov: provenance });
  else {
    // Past the cap (deterministic): a new shape is always kept; otherwise a stride replacement
    // keeps the sample spread over the whole stream instead of only its head.
    list._seen = (list._seen ?? VAL_CAP) + 1;
    list._shapes ??= new Set(list.map((x) => shapeKey(x.obj)));
    const sh = shapeKey(value);
    if (!list._shapes.has(sh)) { list._shapes.add(sh); list.push({ obj: value, prov: provenance }); }
    else if (list._seen % 7 === 0) { const j = (list._seen * 7919) % VAL_CAP; if (shapeKey(list[j].obj) === sh) list[j] = { obj: value, prov: provenance }; }
  }
  out.set(path, list);
  for (const [k, v] of Object.entries(value)) if (v && typeof v === 'object') collectInstances(v, `${path}.${k}`, out, { ...prov, location: `${prov.location ?? path}[${JSON.stringify(k)}]` }, depth + 1);
}

// Envelope: a small wrapper whose meaning is "there is a payload inside" (type + data, v, o/p).
function isEnvelope(schema) {
  const f = schema.fields ?? {};
  const names = Object.keys(f);
  if (names.length > 4) return false;
  const objectChildren = names.filter((n) => f[n].type === 'object' || f[n].type === 'map' || f[n].type === 'array');
  const scalars = names.filter((n) => !objectChildren.includes(n));
  return objectChildren.length === 1 && scalars.every((n) => f[n].string?.enum || f[n].type === 'integer' || /^(type|event|kind|op|o|p|v|seq|id|version|channel|topic)$/.test(n));
}

// ---------------------------------------------------------------------------------------------
// 2. Discovery
// ---------------------------------------------------------------------------------------------
export function discoverModel(corpus, { learner = new ScopedLearner(), ctx = {}, families = [], patchGroups = new Set() } = {}) {
  const t0 = Date.now();
  const groups = new Map();
  for (const s of corpus) { const g = s.source.group; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }

  const candidates = [];
  for (const [group, samples] of groups) {
    if (patchGroups.has(group)) continue; // patch streams are protocol; their assembled docs are the data
    const positions = new Map();
    for (const s of samples) collectInstances(s.value, '$', positions, s.source);
    for (const [p, inst] of positions) {
      const schemaNode = new SchemaNode();
      for (const i of inst) schemaNode.observe(i.obj);
      const schema = schemaNode.describe(p);
      if (schema.type !== 'object') continue;
      const nFields = Object.keys(schema.fields).length;
      if (nFields < 2 || inst.length < 2) continue;
      if (isEnvelope(schema) && p === '$') continue;
      candidates.push({ group, path: p, schema, instances: inst, source: samples[0].source });
    }
  }

  // Field roles + key inference per candidate.
  const types = candidates.map((c) => buildType(c, learner, ctx));
  // Drop candidates that are just a projection of a parent type's single nested object
  // (e.g. "$.author" with 2 fields inside a message) unless they repeat (arrays/maps) or carry a key.
  const kept = types.filter((t) => t.path.endsWith('[*]') || t.path === '$' || t.key || t.fields.length >= 4);

  // 3. Merge the same entity type observed in several groups/positions (order-independent),
  //    then decide primary vs foreign keys on the merged types.
  const merged = mergeTypes(kept, learner, ctx);
  resolveForeignKeys(merged);
  markWeakEntities(merged);
  uniqueNames(merged);

  // 4. Relationships.
  const relationships = [...composition(merged), ...references(merged)];

  // 5. Family priors as soft semantic labels.
  for (const t of merged) t.familyMatches = familyMatches(t, families);

  // 6. Unknown/opaque groups surface explicitly instead of disappearing.
  const modelled = new Set(merged.flatMap((t) => t.groups));
  const unmodelled = [...groups.keys()].filter((g) => !modelled.has(g) && !patchGroups.has(g)).map((g) => ({ group: g, samples: groups.get(g).length, reason: 'no repeated multi-field object found (scalar, opaque or single-shot payload)' }));

  return { types: merged, relationships, unmodelled, patchGroups: [...patchGroups], stats: { samples: corpus.length, groups: groups.size, candidates: candidates.length, types: merged.length, ms: Date.now() - t0 } };
}

function buildType(c, learner, ctx) {
  const { schema, instances } = c;
  const typeKey = `${c.group}|${c.path}`;
  const fields = Object.entries(schema.fields).map(([name, d]) => {
    const pr = learner.predict(name, d, { ...ctx, typeKey, inArray: c.path.endsWith('[*]') });
    return { name, path: `$.${name}`, type: d.type, nullable: d.nullable, presence: d.presence, formats: Object.keys(d.string?.formats ?? {}).concat(d.number?.format ? [d.number.format] : []), enum: d.string?.enum?.map((e) => e.value), role: pr.role, roleConfidence: +pr.confidence.toFixed(3), roleEntropy: +pr.entropy.toFixed(3), roleSource: pr.source, dist: pr.dist, schema: d };
  });
  const key = inferKey(fields, instances);
  for (const f of fields) if (key && f.name === key.field && f.role !== 'id') { f.roleNote = `chosen as identity (role model said ${f.role})`; }
  const name = suggestName(c, fields);
  const support = instances.length;
  const consistency = fields.reduce((a, f) => a + (f.presence ?? 1), 0) / Math.max(1, fields.length);
  const roleCertainty = fields.reduce((a, f) => a + f.roleConfidence, 0) / Math.max(1, fields.length);
  const confidence = +(0.3 * Math.min(1, Math.log2(1 + support) / 5) + 0.25 * (key ? key.score : 0.3) + 0.25 * consistency + 0.2 * roleCertainty).toFixed(3);
  return {
    id: `type-${h(typeKey)}`, name, groups: [c.group], paths: [{ group: c.group, path: c.path }], path: c.path, source: c.source, schema, fields, key, support,
    confidence, confidenceBasis: { support, keyScore: key?.score ?? null, consistency: +consistency.toFixed(3), roleCertainty: +roleCertainty.toFixed(3) },
    tagged: schema.tagged ?? null, instances,
  };
}

// Identity key inference.
// A key partitions observations into groups that are (a) unique within any single observation
// (no snapshot lists the same entity twice), (b) recurring across observations while the rest
// of the object changes (revision stability), and (c) shaped like an identifier. Volatile
// measures, timestamps and prose are unique per observation too, so uniqueness alone is
// evidence of nothing; the role model and value shape separate them.
const CODE_LIKE = /^[A-Za-z0-9][A-Za-z0-9_.:\-/#]{0,63}$/;

function valueShape(f, vals) {
  if (f.formats.some((x) => ['uuid', 'hex_id', 'token_id'].includes(x))) return 1;
  if (f.type === 'number') return 0; // non-integer numbers are measures, not identities
  if (f.type === 'integer') return 0.55;
  const strs = vals.filter((v) => typeof v === 'string');
  if (!strs.length) return 0;
  const code = strs.filter((v) => CODE_LIKE.test(v)).length / strs.length;
  const avgLen = strs.reduce((a, v) => a + v.length, 0) / strs.length;
  if (f.formats.some((x) => ['iso_time', 'url', 'markdown', 'multiline'].includes(x))) return 0.05;
  return +(0.75 * code + (avgLen <= 40 ? 0.15 : 0) - (avgLen > 60 ? 0.3 : 0)).toFixed(3);
}

export function inferKey(fields, instances) {
  const N = instances.length;
  const parentOf = (i) => `${i.prov.sid ?? ''}|${i.prov.seq ?? ''}|${i.prov.t ?? ''}|${i.prov.session ?? ''}`;
  const parents = new Map();
  instances.forEach((i, n) => { const p = parentOf(i); if (!parents.has(p)) parents.set(p, []); parents.get(p).push(n); });
  const cands = [];
  // Long-text content fields: within one entity they evolve (grow/edit), they are not replaced.
  const contentFields = fields.filter((f) => f.type === 'string' && (f.schema?.string?.avgLen ?? 0) >= 40 && ((f.dist?.text ?? 0) >= 0.3 || (f.schema?.string?.avgLen ?? 0) >= 60)).map((f) => f.name);
  for (const f of fields) {
    if (!['string', 'integer', 'number'].includes(f.type)) continue;
    if (contentFields.includes(f.name)) continue;
    const vals = instances.map((i) => i.obj[f.name]);
    const present = vals.filter((v) => v !== undefined && v !== null && v !== '');
    if (present.length < Math.max(2, N * 0.9)) continue;
    const groups = new Map();
    instances.forEach((i, n) => { const v = i.obj[f.name]; if (v === undefined || v === null || v === '') return; const k = typedValueKey(v); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); });
    const G = groups.size;
    // (a) uniqueness inside each observation that holds several instances
    let multi = 0, uniqueIn = 0;
    // Identical repeated embeddings of one object (denormalised references) are not violations.
    for (const idxs of parents.values()) {
      if (idxs.length < 2) continue;
      multi++;
      const byVal = new Map();
      for (const n of idxs) { const k = typedValueKey(instances[n].obj[f.name]); if (!byVal.has(k)) byVal.set(k, new Set()); byVal.get(k).add(stableStringify(instances[n].obj)); }
      if ([...byVal.values()].every((states) => states.size === 1)) uniqueIn++;
    }
    const intraUnique = multi ? uniqueIn / multi : 1;
    // (b) revision stability: groups that recur with a changed object
    let recurring = 0, recurringChanged = 0;
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;
      recurring++;
      if (new Set(idxs.map((n) => stableStringify(instances[n].obj))).size > 1) recurringChanged++;
    }
    const stability = recurring ? recurringChanged / recurring : 0;
    if (G === 1 && !(N >= 2 && stability > 0)) continue; // constant field, unless one entity evolving
    let partition;
    if (G === N) partition = 0.55;                                  // one observation per value
    else if (G === 1) partition = 0.5 + 0.2 * stability;            // a single evolving entity
    else partition = 0.55 + 0.45 * Math.max(stability, recurring / G * 0.5);
    const shape = valueShape(f, present);
    const d = f.dist ?? {};
    const idish = (d.id ?? 0) + 0.6 * (d.reference ?? 0) + 0.35 * (d.title ?? 0);
    const antiKey = (d.measure ?? 0) + (d.timestamp ?? 0) + (d.text ?? 0) + 0.5 * (d.count ?? 0) + 0.5 * (d.flag ?? 0) + 0.3 * (d.url ?? 0) + (f.enum ? 0.3 * (d.category ?? 0) : 0);
    const enumLike = f.enum && G <= 3 && G < N ? 0.12 : 0;
    const coherence = contentCoherence(groups, instances, contentFields);
    const incoherent = coherence === null ? 0 : 0.35 * Math.max(0, 1 - coherence / 0.5);
    const score = +(0.28 * Math.min(1, idish) + 0.22 * shape + 0.25 * partition + 0.15 * intraUnique + 0.1 * (f.presence ?? 1) - 0.35 * Math.min(1, antiKey) - enumLike - incoherent - (intraUnique < 1 ? 0.25 : 0)).toFixed(3);
    cands.push({ field: f.name, score, basis: { groups: G, observations: N, partition: +partition.toFixed(3), revisionStability: +stability.toFixed(3), intraObservationUnique: +intraUnique.toFixed(3), shape, idRoleEvidence: +Math.min(1, idish).toFixed(3), antiKeyEvidence: +Math.min(1, antiKey).toFixed(3), contentCoherence: coherence } });
  }
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return null;
  const margin = cands[1] ? +(best.score - cands[1].score).toFixed(3) : best.score;
  const out = { ...best, margin, alternatives: cands.slice(1, 3).map((c) => ({ field: c.field, score: c.score })) };
  if (best.score < 0.45) out.weak = true;
  return out;
}

// Share of consecutive same-group observations whose content is a continuation of the previous
// one (equal, or shingle containment >= 0.5 either way). null when nothing to compare.
function contentCoherence(groups, instances, contentFields) {
  if (!contentFields.length) return null;
  let pairs = 0, cont = 0;
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const ord = idxs.slice().sort((a, b) => (instances[a].prov.t ?? 0) - (instances[b].prov.t ?? 0) || a - b);
    for (let k = 1; k < ord.length && k < 50; k++) {
      for (const cf of contentFields) {
        const x = instances[ord[k - 1]].obj[cf], y = instances[ord[k]].obj[cf];
        if (typeof x !== 'string' || typeof y !== 'string') continue;
        pairs++;
        if (x === y) { cont++; continue; }
        const a = shingles(x), b = shingles(y);
        if (Math.max(containment(a, b), containment(b, a)) >= 0.5) cont++;
      }
    }
  }
  return pairs ? +(cont / pairs).toFixed(3) : null;
}

// Primary vs foreign key. A chosen key whose values are contained in ANOTHER type's key values
// references that type. Under mutual containment the direction is decided by evidence
// (revision stability of the owning type, field named after the other type, key strength).
// All decisions are computed first and applied together, so input order cannot matter.
function resolveForeignKeys(types) {
  const vals = new Map(types.map((t) => [t, t.key && !t.key.weak ? new Set(t.instances.map((i) => i.obj[t.key.field]).filter((v) => v !== undefined && v !== null).map(typedValueKey)) : null]));
  const contained = (a, b) => { const A = vals.get(a), B = vals.get(b); if (!A || !B || !A.size) return false; let i = 0; for (const v of A) if (B.has(v)) i++; return i / A.size >= 0.8; };
  const primaryLikelihood = (t, other) => {
    const k = t.key, toks = tokens(k.field), own = tokens(t.name), oth = tokens(other.name);
    const bare = /^(id|uuid|guid|key|_id|pk)$/i.test(k.field);
    const compoundRef = !bare && toks.length > 1 && /^(id|uuid|guid|key|ref|no|number)$/.test(toks[toks.length - 1]);
    return (k.basis?.revisionStability ?? 0) + (bare ? 0.4 : 0) - (compoundRef ? 0.3 : 0) + (toks.some((x) => own.includes(x)) ? 0.3 : 0) - (toks.some((x) => oth.includes(x)) && !toks.some((x) => own.includes(x)) ? 0.6 : 0) + 0.3 * (k.score ?? 0);
  };
  const demote = new Map();
  const sorted = [...types].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const t of sorted) {
    for (const u of sorted) {
      if (t === u || !contained(t, u)) continue;
      const mutual = contained(u, t);
      if (mutual) { const pt = primaryLikelihood(t, u), pu = primaryLikelihood(u, t); if (pt > pu || (pt === pu && t.id < u.id)) continue; }
      if (!demote.has(t)) demote.set(t, u);
    }
  }
  for (const [t, target] of demote) {
    const alt = (t.key.alternatives ?? []).find((a) => a.score >= 0.45);
    const note = `values of ${t.key.field} are keys of ${target.name}: foreign key, not identity`;
    t.key = alt ? { field: alt.field, score: alt.score, basis: { reason: 'foreign-key demotion', demoted: t.key.field }, alternatives: [{ field: t.key.field, score: t.key.score, note }] } : { ...t.key, weak: true, weakReason: note };
  }
}

function uniqueNames(types) {
  const seen = new Map();
  for (const t of [...types].sort((a, b) => (a.path === '$') - (b.path === '$') || b.support - a.support)) {
    const n = seen.get(t.name) ?? 0;
    seen.set(t.name, n + 1);
    if (n) t.name = t.path === '$' ? `${t.name}_record` : `${t.name}_${n + 1}`;
  }
}

// Weak entities: rows nested under a keyed parent whose own "key" carries no revision evidence
// are identified by (parent, position), not by a field of their own.
function markWeakEntities(types) {
  for (const t of types) {
    if (!t.key || t.key.weak || !t.path.endsWith('[*]')) continue;
    const b = t.key.basis;
    if (b.groups !== b.observations || b.revisionStability > 0) continue;
    const parent = types.find((p) => p !== t && p.groups[0] === t.groups[0] && t.path.startsWith(p.path) && p.path !== t.path && p.key && !p.key.weak && p.key.basis.revisionStability > 0);
    if (parent) t.key = { ...t.key, weak: true, weakReason: `no revision evidence; identified within parent ${parent.name} by position` };
  }
}

function singular(w) { return w.replace(/ies$/, 'y').replace(/(ss|us)$/, '$1').replace(/([^s])s$/, '$1'); }

const WRAPPERS = /^(data|items|results|nodes|node|edges|list|payload|response|records|rows|entries|hits|docs|collection|v)$/i;
const CONTENTISH = /^(content|value|body|meta|metadata|attributes|attrs|props|properties|details|info)$/i;
function suggestName(c, fields) {
  const segs = c.path.split(/[.[\]*]+/).filter(Boolean).filter((s) => s !== '$');
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (WRAPPERS.test(seg)) continue;
    if (CONTENTISH.test(seg)) { const parent = segs.slice(0, i).reverse().find((x) => !WRAPPERS.test(x) && !CONTENTISH.test(x)); return parent ? `${singular(tokens(parent).join('_'))}_${seg.toLowerCase()}` : seg.toLowerCase(); }
    return singular(tokens(seg).join('_') || seg);
  }
  const disc = String(c.group).split(' :: ')[1];
  if (disc && !/^\(|^\[/.test(disc) && disc !== 'message') return singular(tokens(disc).join('_') || disc);
  const ep = String(c.group).split(' :: ')[0].replace(/^[A-Z]+ /, '').split('/').filter((x) => x && x !== '{id}' && !x.includes('.') && !/^(api|v\d+|backend|graphql)$/i.test(x));
  if (ep.length) return singular(tokens(ep[ep.length - 1]).join('_'));
  const t = fields.find((f) => f.role === 'category' && f.enum?.length === 1);
  return t ? String(t.enum[0]) : 'record';
}

// ---------------------------------------------------------------------------------------------
// Merge types that are the same entity seen in different places (e.g. list endpoint + detail
// endpoint, page 1 + page 2, history + live stream).
// ---------------------------------------------------------------------------------------------
function keyValues(t) { if (!t.key) return new Set(); return new Set(t.instances.map((i) => i.obj[t.key.field]).filter((v) => v !== undefined && v !== null).map(typedValueKey)); }

function mergeEvidence(o, t) {
  const sim = schemaSimilarity(o.schema, t.schema);
  const kv = keyValues(o), tv = keyValues(t);
  let overlap = 0; for (const v of tv) if (kv.has(v)) overlap++;
  const keyOverlap = tv.size && kv.size ? overlap / Math.min(tv.size, kv.size) : 0;
  const sameKeyName = !!(o.key && t.key && nameSimilarity(o.key.field, t.key.field) > 0.8);
  const ok = (sim >= 0.8 && (sameKeyName || (!o.key && !t.key))) || (sim >= 0.55 && keyOverlap >= 0.3);
  return { ok, score: sim + keyOverlap, schemaSimilarity: sim, keyOverlap: +keyOverlap.toFixed(3) };
}

// Order-independent average-linkage agglomeration: inputs are sorted by a content-derived id,
// all pairwise evidence is computed up front, and the best eligible pair (by average evidence
// over cluster members, ties by id) merges first. The result does not depend on input order.
function mergeTypes(types, learner, ctx) {
  const items = [...types].sort((a, b) => (a.id < b.id ? -1 : 1));
  const ev = new Map();
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) ev.set(`${i}|${j}`, mergeEvidence(items[i], items[j]));
  const get = (i, j) => ev.get(i < j ? `${i}|${j}` : `${j}|${i}`);
  let clusters = items.map((_, i) => [i]);
  for (;;) {
    let best = null;
    for (let a = 0; a < clusters.length; a++) for (let b = a + 1; b < clusters.length; b++) {
      const pairs = []; for (const i of clusters[a]) for (const j of clusters[b]) pairs.push(get(i, j));
      if (!pairs.every((p) => p.ok)) continue; // complete-linkage eligibility: no chaining
      const avg = pairs.reduce((s, p) => s + p.score, 0) / pairs.length;
      if (!best || avg > best.avg + 1e-12) best = { a, b, avg };
    }
    if (!best) break;
    clusters[best.a] = [...clusters[best.a], ...clusters[best.b]].sort((x, y) => x - y);
    clusters.splice(best.b, 1);
  }
  return clusters.map((idxs) => {
    // Representative: the member with the most support (ties by id) carries the identity.
    const members = idxs.map((i) => items[i]).sort((x, y) => y.support - x.support || (x.id < y.id ? -1 : 1));
    const target = { ...members[0], mergedFrom: [] };
    for (const t of members.slice(1)) {
      const why = mergeEvidence(members[0], t);
      target.groups = [...new Set([...target.groups, ...t.groups])].sort();
      target.paths = [...target.paths, ...t.paths];
      target.instances = target.instances.concat(t.instances).slice(0, VAL_CAP);
      target.support += t.support;
      target.mergedFrom.push({ id: t.id, group: t.groups[0], path: t.path, schemaSimilarity: why.schemaSimilarity, keyOverlap: why.keyOverlap });
      const have = new Set(target.fields.map((f) => f.name));
      for (const f of t.fields) if (!have.has(f.name)) target.fields.push({ ...f, presence: (f.presence ?? 1) * t.support / target.support });
      target.confidence = +Math.min(1, target.confidence + 0.05).toFixed(3);
    }
    if (members.length > 1) {
      // Refresh every field's distribution and presence, not just new field names.
      const allInstances = members.flatMap((member) => member.instances);
      target.instances = sampleIndices(allInstances.length,
        (i) => `${allInstances[i].prov.group}|${shapeKey(allInstances[i].obj)}`,
        { head: 2000, stride: 2000, perShape: 3, maxShapes: 128 }).map((i) => allInstances[i]);
      const schemaNode = new SchemaNode();
      for (const member of members) for (const instance of member.instances) schemaNode.observe(instance.obj);
      const schema = schemaNode.describe(target.path);
      if (schema.type === 'object') {
        const rebuilt = buildType({ group: target.groups[0], path: target.path, source: target.source, schema, instances: target.instances }, learner, ctx);
        target.schema = schema; target.fields = rebuilt.fields; target.key = rebuilt.key;
        target.tagged = rebuilt.tagged; target.confidence = rebuilt.confidence;
        target.confidenceBasis = { ...rebuilt.confidenceBasis, mergedTypes: members.length, totalSupport: target.support, sampledInstances: target.instances.length };
      } else target.confidenceBasis = { ...target.confidenceBasis, mergedSchemaUnresolved: schema.type };
    }
    return target;
  });
}

// ---------------------------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------------------------
function composition(types) {
  const rels = [];
  for (const child of types) for (const parent of types) {
    if (child === parent) continue;
    for (const cp of child.paths) for (const pp of parent.paths) {
      if (cp.group !== pp.group || !cp.path.startsWith(pp.path + '.') && !cp.path.startsWith(pp.path + '[')) continue;
      const rest = cp.path.slice(pp.path.length);
      if ((rest.match(/\[\*\]/g) ?? []).length > 1) continue;
      rels.push({ id: `rel-${h(parent.id + child.id + 'contains')}`, kind: 'contains', from: parent.id, to: child.id, via: rest, cardinality: rest.includes('[*]') ? 'many' : 'one', confidence: 0.9, evidence: { group: cp.group, parentPath: pp.path, childPath: cp.path }, status: 'hypothesis' });
    }
  }
  return dedupeRels(rels);
}

// Inclusion dependencies: A.f values contained in B.key values => A.f references B.
function references(types) {
  const rels = [];
  const keyed = types.filter((t) => t.key && !t.key.weak).map((t) => ({ t, vals: keyValues(t) })).filter((x) => x.vals.size >= 1);
  for (const a of types) {
    for (const f of a.fields) {
      if (a.key && !a.key.weak && f.name === a.key.field) continue;
      if (!['string', 'integer', 'number'].includes(f.type)) continue;
      const vals = new Set(a.instances.map((i) => i.obj[f.name]).filter((v) => v !== undefined && v !== null && v !== '').map(typedValueKey));
      if (!vals.size) continue;
      let matched = false;
      for (const b of keyed) {
        if (b.t === a && f.role !== 'reference') continue;
        let inter = 0; for (const v of vals) if (b.vals.has(v)) inter++;
        const containment = inter / vals.size;
        if (containment < 0.8 || inter < 1) continue;
        const nameHint = tokens(f.name).some((tk) => tokens(b.t.name).includes(tk) || nameSimilarity(tk, b.t.name) > 0.8) ? 0.15 : 0;
        const idLike = (f.dist?.reference ?? 0) + (f.dist?.id ?? 0);
        const support = Math.min(1, Math.log2(1 + inter) / 4);
        // A coincidentally shared small integer domain is not enough to infer a reference.
        if (!nameHint && idLike < 0.4 && inter < 3) continue;
        const confidence = +Math.min(1, 0.45 * containment + 0.2 * support + 0.2 * idLike + nameHint).toFixed(3);
        if (confidence < 0.5) continue;
        matched = true;
        const owners = new Map(), targets = new Map(); let completeOwners = !!(a.key && !a.key.weak);
        if (completeOwners) for (const instance of a.instances) {
          const value = instance.obj[f.name], owner = instance.obj[a.key.field];
          if (value === undefined || value === null || value === '') continue;
          if (owner === undefined || owner === null || owner === '') { completeOwners = false; continue; }
          const vk = typedValueKey(value), ok = typedValueKey(owner);
          if (!owners.has(vk)) owners.set(vk, new Set()); owners.get(vk).add(ok);
          if (!targets.has(ok)) targets.set(ok, new Set()); targets.get(ok).add(vk);
        }
        const oneToOne = completeOwners && owners.size > 0 && [...owners.values(), ...targets.values()].every((set) => set.size === 1);
        rels.push({ id: `rel-${h(a.id + f.name + b.t.id)}`, kind: 'references', from: a.id, field: f.name, to: b.t.id, toField: b.t.key.field, cardinality: oneToOne ? 'one-to-one-observed' : 'many-to-one', confidence, evidence: { containment: +containment.toFixed(3), targetCoverage: +(inter / b.vals.size).toFixed(3), sharedValues: inter, distinctValues: vals.size, nameHint: !!nameHint }, status: 'hypothesis' });
      }
      const idNamed = /(_id|Id|_uuid|Uuid|_ref|Ref|_key)$/.test(f.name), idFormat = f.formats.some((x) => ['uuid', 'hex_id', 'token_id'].includes(x));
      if (!matched && (idNamed || (idFormat && f.role === 'reference')) && f.roleConfidence > 0.4) {
        rels.push({ id: `rel-${h(a.id + f.name + 'dangling')}`, kind: 'references_unobserved', from: a.id, field: f.name, to: null, confidence: +(0.5 * f.roleConfidence).toFixed(3), evidence: { distinctValues: vals.size, reason: 'identifier-like field with no observed target entity' }, status: 'hypothesis' });
      }
    }
  }
  return dedupeRels(rels);
}

function dedupeRels(rels) { const m = new Map(); for (const r of rels) if (!m.has(r.id) || m.get(r.id).confidence < r.confidence) m.set(r.id, r); return [...m.values()]; }

// Family entities as soft priors: how well does a discovered type align with each family entity?
function familyMatches(t, families) {
  const out = [];
  for (const fam of families) for (const [ename, espec] of Object.entries(fam.entities ?? {})) {
    const pseudo = { fields: Object.fromEntries(Object.entries(espec.fields ?? {}).map(([fname, fs]) => [fname, pseudoField(fs)])) };
    if (!Object.keys(pseudo.fields).length) continue;
    // Align on flattened leaf names too (message.author.role -> role), using family name hints.
    const flat = flatLeaves(t);
    const al = alignFields(pseudo, { fields: flat }, { minScore: 0.5 });
    const req = Object.entries(espec.fields ?? {}).filter(([, fs]) => fs.required).map(([n]) => n);
    const hit = new Set(al.pairs.map((p) => p.a));
    const reqCover = req.length ? req.filter((r) => hit.has(r)).length / req.length : 0.5;
    const score = +(0.6 * reqCover + 0.4 * (al.pairs.reduce((a, p) => a + p.score, 0) / Math.max(1, Object.keys(pseudo.fields).length))).toFixed(3);
    if (score >= 0.35) out.push({ family: fam.name, entity: ename, score, mapping: Object.fromEntries(al.pairs.map((p) => [p.a, p.b])) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

function flatLeaves(t) {
  const out = {};
  const walk = (d, prefix, depth) => {
    for (const [k, f] of Object.entries(d.fields ?? {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (f.type === 'object' && depth < 3) walk(f, p, depth + 1);
      else if (f.type === 'array' && f.array?.items?.type === 'string') out[p] = { ...f.array.items, type: 'string' };
      else if (f.type === 'map' && f.map?.values?.type === 'object' && depth < 3) walk(f.map.values, `${p}[*]`, depth + 1);
      else out[p] = f;
    }
  };
  walk(t.schema, '', 0);
  return out;
}

function pseudoField(fs) {
  const d = { type: fs.type === 'id' || fs.type === 'enum' || fs.type === 'text' || fs.type === 'url' || fs.type === 'time' ? 'string' : fs.type === 'number' ? 'number' : 'string' };
  d.string = { formats: fs.type === 'id' ? { uuid: 1 } : fs.type === 'url' ? { url: 1 } : fs.type === 'time' ? { iso_time: 1 } : {}, avgLen: fs.type === 'text' ? 200 : 12, uniqueness: fs.type === 'id' ? 1 : 0.5, ...(fs.type === 'enum' ? { enum: [{}] } : {}) };
  return d;
}

// Compact view for UI/API (drops instances).
export function modelSummary(m) {
  return { ...m, types: m.types.map(({ instances, schema, ...t }) => ({ ...t, fields: t.fields.map(({ schema: _s, dist, ...f }) => ({ ...f, alternatives: Object.entries(dist ?? {}).sort((a, b) => b[1] - a[1]).slice(1, 3).map(([r, p]) => ({ role: r, p: +p.toFixed(3) })) })), sampleKeys: t.key ? [...new Set(instances.map((i) => i.obj[t.key.field]))].slice(0, 5) : [] })) };
}
