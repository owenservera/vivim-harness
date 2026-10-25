// Identity resolution: which observations are the same real-world entity?
//
//   keyed     group by the inferred identity key; ordered revisions with field-level diffs.
//   keyless   Fellegi–Sunter style record linkage: per-field agreement weights log2(m/u), where
//             u is estimated from random pairs in the data and m from a prior (or from keyed
//             pairs when a keyed sibling type exists), blocking on the most discriminating
//             field, union-find clustering above a data-derived threshold.
// Works for updates, rerenders (new DOM node, same content), pagination overlaps and sessions.
import { createHash } from 'node:crypto';
import { stableStringify, typedValueKey } from './similarity.mjs';

const isScalar = (v) => v !== null && v !== undefined && typeof v !== 'object';
const sha = (x) => createHash('sha1').update(x).digest('hex').slice(0, 12);
export const usableIdentityKey = (v) => typeof v === 'number' ? Number.isFinite(v)
  : typeof v === 'string' && v.trim().length > 0
    && !['undefined', 'null', 'nan'].includes(v.trim().toLowerCase());

// Order-independent instance signature (content + provenance, never array position).
export function instanceSig(i) { return `${stableStringify(i.obj)}|${i.prov.session ?? ''}|${i.prov.sid ?? ''}|${i.prov.seq ?? ''}|${i.prov.domId ?? ''}|${i.prov.t ?? ''}`; }

// Identity scope: keys only collide within one site (provenance site, else endpoint host).
export function scopeOf(prov) {
  if (prov.site) return String(prov.site);
  const g = String(prov.group ?? '').split(' :: ')[0].replace(/^[A-Z]+ /, '');
  return g ? g.split('/')[0] : '';
}
const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : v);

export function shingles(text, k = 3) {
  const w = String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (w.length < k) return new Set(w.length ? [w.join(' ')] : []);
  const s = new Set();
  for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(' '));
  return s;
}
export function containment(a, b) { if (!a.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / a.size; }

function agree(a, b) {
  if (!isScalar(a) || !isScalar(b)) return a === b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 0.005) ? 1 : 0;
  const x = norm(a), y = norm(b);
  if (x === y) return 1;
  if (typeof x === 'string' && typeof y === 'string' && (x.length > 24 || y.length > 24)) {
    // Long text: shingle overlap tolerates streaming growth and small edits.
    const s1 = shingles(x), s2 = shingles(y);
    return Math.max(containment(s1, s2), containment(s2, s1)) >= 0.8 ? 1 : 0;
  }
  return 0;
}

function diffFields(a, b) { const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]); return [...keys].filter((k) => stableStringify(a?.[k]) !== stableStringify(b?.[k])); }

// clusters: Map<label, instanceIndex[]> (indices into type.instances). Entity ids are derived
// from content (keyed: scope+key; keyless: smallest member signature), so they do not depend on
// observation order. State is FOLDED across revisions so partial updates never lose fields,
// and every revision carries the values it changed (enough to reconstruct past states).
function buildEntities(type, clusters, method, basis, confidences = new Map()) {
  const entities = [];
  for (const [label, idxs] of clusters) {
    const inst = idxs.map((i) => type.instances[i]).sort((x, y) => (x.prov.t ?? 0) - (y.prov.t ?? 0) || (x.prov.seq ?? 0) - (y.prov.seq ?? 0) || (instanceSig(x) < instanceSig(y) ? -1 : 1));
    const revisions = [];
    let state = {}, prev = null;
    for (const i of inst) {
      const changed = prev ? diffFields(prev, i.obj).filter((k) => k in i.obj) : Object.keys(i.obj);
      if (prev && !changed.length) continue; // identical (or subset) re-observation: duplicate, not a revision
      const values = Object.fromEntries(changed.map((k) => [k, i.obj[k]]));
      state = { ...state, ...i.obj };
      revisions.push({ t: i.prov.t ?? null, seq: i.prov.seq ?? null, sid: i.prov.sid, domId: i.prov.domId, session: i.prov.session,
        path: i.prov.path, location: i.prov.location, index: i.prov.index, mapKey: i.prov.mapKey, changed, values });
      prev = { ...state };
    }
    const keyVal = type.key && method === 'key' ? String(inst[0].obj[type.key.field]) : null;
    const scope = scopeOf(inst[0].prov);
    // Keyless ids anchor on the EARLIEST observation (members are sorted by t, seq, signature), so
    // appending later evidence never renames an entity; only genuinely earlier evidence can.
    const first = inst[0];
    const anchorOf = (i) => `${instanceSig(i)}|${i.prov.index ?? ''}|${i.prov.mapKey ?? ''}|${i.prov.snapshot ?? ''}`;
    // Keep existing string-key IDs stable; typed numeric keys must not alias string keys.
    const keyType = method === 'key' ? typeof inst[0].obj[type.key.field] : null;
    const keyAnchor = `${scope}|${keyVal}`;
    const eid = method === 'key' ? `${type.id}:k:${keyType === 'number' ? 'n:' : ''}${sha(keyAnchor)}` : method === 'provisional' ? `${type.id}:p:${sha(`${anchorOf(first)}|${label}`)}` : `${type.id}:e:${sha(anchorOf(first))}`;
    const anchor = { session: first.prov.session ?? null, sid: first.prov.sid ?? null, seq: first.prov.seq ?? null, domId: first.prov.domId ?? null, t: first.prov.t ?? null };
    const conf = method === 'provisional' ? { value: null, basis: 'identity key unavailable' } : confidences.get(label) ?? (method === 'key' ? { value: +Math.min(1, type.key?.score ?? 0.5).toFixed(3), basis: 'identity key score' } : { value: null, basis: 'unscored' });
    const times = inst.map((i) => i.prov.t).filter(Number.isFinite);
    entities.push({ eid, idBasis: method === 'key' ? 'key' : method === 'provisional' ? 'missing-key-observation' : 'first-observation', anchor, type: type.id, typeName: type.name, key: keyVal, keyType, scope, observations: inst.length, duplicates: inst.length - revisions.length, revisions, attrs: state,
      first: times.length ? times.reduce((a, b) => Math.min(a, b)) : null,
      last: times.length ? times.reduce((a, b) => Math.max(a, b)) : null,
      occurrences: inst.map((i) => ({ session: i.prov.session ?? null, sid: i.prov.sid ?? null, seq: i.prov.seq ?? null,
        domId: i.prov.domId ?? null, t: i.prov.t ?? null, path: i.prov.path, location: i.prov.location, index: i.prov.index, mapKey: i.prov.mapKey })),
      method, confidence: conf.value, confidenceBasis: conf.basis });
  }
  entities.sort((a, b) => (a.eid < b.eid ? -1 : 1));
  return { type: type.id, typeName: type.name, method, basis, entities };
}

export function resolveType(type, opts = {}) {
  const inst = type.instances;
  if (type.key && !type.key.weak) {
    const by = new Map();
    const absent = new Map(), repeat = new Map();
    inst.forEach((i, n) => {
      const v = i.obj[type.key.field];
      if (!usableIdentityKey(v)) {
        const sig = [instanceSig(i), i.prov.index ?? null, i.prov.mapKey ?? null, i.prov.snapshot ?? null].join('|');
        const ordinal = repeat.get(sig) ?? 0;
        repeat.set(sig, ordinal + 1);
        absent.set(sig + '|' + ordinal, [n]);
      } else {
        const k = JSON.stringify([scopeOf(i.prov), typeof v, String(v)]);
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(n);
      }
    });
    const valid = buildEntities(type, by, 'key', { field: type.key.field, keyScore: type.key.score, scopedBy: 'site' });
    const provisional = buildEntities(type, absent, 'provisional', { field: type.key.field, reason: 'missing-or-invalid-key' });
    return { ...valid, basis: { ...valid.basis, provisionalCount: provisional.entities.length },
      entities: [...valid.entities, ...provisional.entities].sort((a, b) => a.eid.localeCompare(b.eid)) };
  }
  return linkage(type, opts);
}

// ---------------------------------------------------------------------------------------------
// Keyless linkage v2 (Fellegi–Sunter with multi-level comparisons, Splink-style estimation):
//   levels   text: 3 equal | 2 containment>=0.95 | 1 containment>=0.8 | 0 none
//            other scalars: 1 agree | 0 disagree   (numbers agree within 0.5%)
//   u        per-field level distribution from random pairs (fixed, smoothed)
//   m, p     estimated by EM over blocked candidate pairs
//   blocking union of passes over the 3 most discriminating fields (MinHash keys for long text)
//   cluster  best-first merging under cannot-link (distinct nodes in one snapshot) and a
//            no-chaining rule (every compared cross pair must be non-negative evidence)
// ---------------------------------------------------------------------------------------------
const isLong = (v) => typeof v === 'string' && v.length > 24;
function level(a, b) {
  if (a === undefined || b === undefined || a === null || b === null) return null;
  if (isLong(a) || isLong(b)) {
    const x = norm(a), y = norm(b);
    if (x === y) return 3;
    const s1 = shingles(x), s2 = shingles(y);
    const c = Math.max(containment(s1, s2), containment(s2, s1));
    return c >= 0.95 ? 2 : c >= 0.8 ? 1 : 0;
  }
  return agree(a, b);
}
const levelsOf = (f, inst) => (inst.some((i) => isLong(i.obj[f])) ? 4 : 2);

function hash32(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function minhashKeys(text, k = 3) { return [...shingles(norm(text))].map((sh) => [hash32(sh), sh]).sort((a, b) => a[0] - b[0]).slice(0, k).map((x) => x[1]); }

export function snapshotKey(prov) {
  if (prov.snapshot !== undefined) return String(prov.snapshot);
  if (prov.seq !== undefined && prov.seq !== null) return `${prov.session ?? ''}|${prov.sid ?? ''}|${prov.seq}`;
  return null; // never infer a snapshot from timing: rerenders can be arbitrarily close in time

}

export function linkage(type, { sample = 4000, maxBlock = 400, window = 25, emIters = 25, minPosterior = 0.8 } = {}) {
  if (!Number.isFinite(minPosterior) || minPosterior < 0.5 || minPosterior >= 1) throw new RangeError('minPosterior must be in [0.5, 1)');
  // Canonical order: work on instances sorted by content signature so every estimate, block and
  // tie-break is independent of observation order. Results map back to original indices.
  const perm = type.instances.map((_, i) => i).sort((a, b) => instanceSig(type.instances[a]).localeCompare(instanceSig(type.instances[b])));
  const inst = perm.map((i) => type.instances[i]);
  const n = inst.length;
  const back = (localIdxs) => localIdxs.map((j) => perm[j]);
  const fields = type.fields.filter((f) => ['string', 'integer', 'number', 'boolean'].includes(f.type) && (f.presence ?? 1) >= 0.5).map((f) => f.name);
  if (n < 2 || !fields.length) return buildEntities(type, new Map(inst.map((_, j) => [String(j), back([j])])), 'singleton', {}, new Map(inst.map((_, j) => [String(j), { value: null, basis: 'insufficient comparable observations; identity unscored' }])));
  const L = Object.fromEntries(fields.map((f) => [f, levelsOf(f, inst)]));
  // Term frequencies for exact-equality adjustment (common values carry little evidence).
  const tf = Object.fromEntries(fields.map((f) => { const c = new Map(); let tot = 0; for (const i of inst) { const v = i.obj[f]; if (v === undefined || v === null) continue; const k = typedValueKey(norm(v)); c.set(k, (c.get(k) ?? 0) + 1); tot++; } return [f, { c, tot }]; }));
  const tfOf = (f, v) => { const t = tf[f]; return t.tot ? (t.c.get(typedValueKey(norm(v))) ?? 0) / t.tot : 0; };
  // u: level distribution under non-match, from deterministic pseudo-random pairs.
  const rnd = mulberry(1234);
  const u = {};
  for (const f of fields) {
    const cnt = Array(L[f]).fill(1);
    for (let s2 = 0; s2 < Math.min(sample, n * (n - 1)); s2++) { const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n); if (a === b) continue; const l = level(inst[a].obj[f], inst[b].obj[f]); if (l !== null) cnt[l]++; }
    const tot = cnt.reduce((x, y) => x + y, 0);
    u[f] = cnt.map((c) => c / tot);
  }
  // Multi-pass blocking on the 3 most discriminating fields. Long text: MinHash keys plus a
  // leading-words key (streaming text grows at the end). Oversized blocks use a sorted
  // neighbourhood window instead of being skipped.
  const discr = [...fields].sort((a, b) => u[a][u[a].length - 1] - u[b][u[b].length - 1] || (a < b ? -1 : 1)).slice(0, 3);
  const pairs = new Set();
  const addPair = (a, b) => { if (a !== b) pairs.add(a < b ? `${a}|${b}` : `${b}|${a}`); };
  for (const f of discr) {
    const blocks = new Map();
    inst.forEach((i, idx) => {
      const v = i.obj[f];
      if (v === undefined || v === null) return;
      const keys = isLong(v) ? [...minhashKeys(v, 4), `pre:${String(norm(v)).split(' ').slice(0, 5).join(' ')}`] : [String(norm(v)).slice(0, 16)];
      for (const k of keys) { const bk = JSON.stringify([scopeOf(i.prov), i.prov.session ?? null, f, typeof v, k]); if (!blocks.has(bk)) blocks.set(bk, []); blocks.get(bk).push(idx); }
    });
    for (const idxs of blocks.values()) {
      if (idxs.length <= maxBlock) { for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) addPair(idxs[x], idxs[y]); continue; }
      const other = fields.find((g) => g !== f) ?? f;
      const sorted = idxs.slice().sort((a, b) => { const va = String(norm(inst[a].obj[other] ?? '')), vb = String(norm(inst[b].obj[other] ?? '')); return va < vb ? -1 : va > vb ? 1 : a - b; });
      for (let x = 0; x < sorted.length; x++) for (let y = x + 1; y < Math.min(sorted.length, x + 1 + window); y++) addPair(sorted[x], sorted[y]);
    }
  }
  const cand = [...pairs].sort().map((k) => { const [a, b] = k.split('|').map(Number); return { a, b, g: Object.fromEntries(fields.map((f) => [f, level(inst[a].obj[f], inst[b].obj[f])])) }; });
  // EM for m (per field, per level) and the match prior p, u fixed; exact matches TF-adjusted.
  const m = Object.fromEntries(fields.map((f) => [f, L[f] === 4 ? [0.05, 0.1, 0.25, 0.6] : [0.1, 0.9]]));
  let p = 0.2;
  const top = (f) => L[f] - 1;
  const logBF = (c) => fields.reduce((acc, f) => {
    const l = c.g[f];
    if (l === null) return acc;
    let uu = u[f][l];
    if (l === top(f)) uu = Math.max(uu, Math.min(0.5, tfOf(f, inst[c.a].obj[f])));
    return acc + Math.log2(m[f][l] / uu);
  }, 0);
  for (let it = 0; it < emIters && cand.length; it++) {
    const acc = Object.fromEntries(fields.map((f) => [f, Array(L[f]).fill(0.01)]));
    let gs = 0;
    for (const c of cand) {
      const g = 1 / (1 + Math.pow(2, -(Math.log2(p / (1 - p)) + logBF(c))));
      gs += g;
      for (const f of fields) if (c.g[f] !== null) acc[f][c.g[f]] += g;
    }
    for (const f of fields) { const t = acc[f].reduce((x, y) => x + y, 0); m[f] = acc[f].map((x) => Math.min(0.999, Math.max(0.001, x / t))); }
    p = Math.min(0.95, Math.max(0.001, gs / cand.length));
  }
  for (const c of cand) { c.w = Math.log2(p / (1 - p)) + logBF(c); c.post = 1 / (1 + Math.pow(2, -c.w)); }
  // Constrained best-first clustering (deterministic: canonical indices are content-ordered).
  const snap = inst.map((i) => snapshotKey(i.prov));
  const node = inst.map((i) => i.prov.domId ?? null);
  const sess = inst.map((i) => i.prov.session ?? null);
  const scopes = inst.map((i) => scopeOf(i.prov));
  const cluster = inst.map((_, i) => i);
  const members = new Map(inst.map((_, i) => [i, [i]]));
  const weakest = new Map(inst.map((_, i) => [i, 1]));
  const pairW = new Map(cand.map((c) => [`${c.a}|${c.b}`, c.w]));
  const cannotLink = (A, B) => {
    for (const x of A) for (const y of B) {
      if (snap[x] !== null && snap[x] === snap[y] && (node[x] === null || node[x] !== node[y])) return true;
      if (scopes[x] !== scopes[y] || (sess[x] !== null && sess[y] !== null && sess[x] !== sess[y])) return true;
      // Evaluate previously unblocked cross-pairs too: absence from a block is not agreement.
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      let w = pairW.get(key);
      if (w === undefined) {
        const g = Object.fromEntries(fields.map((f) => [f, level(inst[x].obj[f], inst[y].obj[f])]));
        if (!Object.values(g).some((value) => value !== null && value > 0)) return true;
        w = Math.log2(p / (1 - p)) + logBF({ a: x, b: y, g });
        pairW.set(key, w);
      }
      if (w < 0) return true;
    }
    return false;
  };
  let linked = 0, blocked = 0;
  for (const c of cand.filter((c) => c.post >= minPosterior).sort((x, y) => y.w - x.w || x.a - y.a || x.b - y.b)) {
    const ra = cluster[c.a], rb = cluster[c.b];
    if (ra === rb) continue;
    const A = members.get(ra), B = members.get(rb);
    if (cannotLink(A, B)) { blocked++; continue; }
    for (const x of B) cluster[x] = ra;
    members.set(ra, A.concat(B)); members.delete(rb);
    weakest.set(ra, Math.min(weakest.get(ra), weakest.get(rb), c.post));
    linked++;
  }
  // Confidence: merged clusters -> posterior of their weakest link; singletons -> probability
  // they are NOT a missed match (1 - best posterior to any compared candidate).
  const bestPost = new Map();
  for (const c of cand) { bestPost.set(c.a, Math.max(bestPost.get(c.a) ?? 0, c.post)); bestPost.set(c.b, Math.max(bestPost.get(c.b) ?? 0, c.post)); }
  const clusters = new Map(), confs = new Map();
  for (const [r, idxs] of members) {
    clusters.set(String(r), back(idxs));
    confs.set(String(r), idxs.length > 1 ? { value: +weakest.get(r).toFixed(3), basis: 'uncalibrated posterior of the weakest accepted cluster merge' }
      : bestPost.has(r) ? { value: +(1 - bestPost.get(r)).toFixed(3), basis: 'uncalibrated distinctness estimate against compared candidates only' }
        : { value: null, basis: 'no candidate pair compared; distinctness unscored' });
  }
  return buildEntities(type, clusters, 'linkage', { fields, blockingFields: discr, candidatePairs: cand.length, linked, blockedByConstraints: blocked, minPosterior, matchPrior: +p.toFixed(4), termFrequencyAdjusted: true, u: Object.fromEntries(fields.map((f) => [f, u[f].map((x) => +x.toFixed(3))])), m: Object.fromEntries(fields.map((f) => [f, m[f].map((x) => +x.toFixed(3))])) }, confs);
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function resolveModel(model, opts) { return model.types.map((t) => resolveType(t, opts)); }
