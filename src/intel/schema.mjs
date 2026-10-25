// Schema induction for arbitrary JSON-like values, online and bounded.
//
// Approach (after genson / Spark JSON inference, extended):
//   - Each path keeps per-kind statistics; a value never forces a premature decision.
//   - describe() decides late: object vs dynamic-key map, plain object vs tagged union,
//     enum vs free string, and attaches string/number formats.
//   - Every decision carries the statistic it was based on, so uncertainty is inspectable.
// Memory is bounded: distinct-value tracking caps out, variant tracking drops high-cardinality tags.

import { CardinalitySketch } from './statistics.mjs';

const DISTINCT_CAP = 200;
const TAG_MAX_VALUES = 24;
const KEY_CAP = 400;

export const FORMAT_TESTS = {
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  iso_time: (s) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s),
  url: (s) => /^(https?:)?\/\/[^\s]+$/.test(s) || /^\/[\w\-./%?=&#]+$/.test(s) && s.length > 1 && s.includes('/') && !/\s/.test(s) && s.length < 300,
  email: (s) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s),
  pointer: (s) => /^\/[\w~-]+(\/[\w~-]+)*$/.test(s) && s.length < 80,
  token_id: (s) => /^[A-Za-z][A-Za-z0-9]*[_-][A-Za-z0-9_-]{6,}$/.test(s) && !/\s/.test(s),
  hex_id: (s) => /^[0-9a-f]{12,}$/i.test(s),
  numeric_string: (s) => /^-?\d+(\.\d+)?$/.test(s),
  markdown: (s) => s.length > 20 && /(^|\n)(#{1,6} |\* |- |\d+\. |```|\|.*\|)/.test(s),
  multiline: (s) => s.includes('\n'),
};

// Format detection is a pure function of the string, and the same strings recur constantly
// (enum values, repeated keys, the cumulative + window double observation). Bounded memo.
const FORMAT_MEMO_MAX = 8192;
const FORMAT_MEMO_STR_MAX = 256;
const formatMemo = new Map();
// Cheap necessary conditions, checked before the regex. A guard may only ever say "cannot match";
// it never decides a match, so results equal running every test (test/unit/capture-perf.test.mjs
// checks this against the raw FORMAT_TESTS on a corpus). Applies only to the stock tests.
const FORMAT_TEST_SNAPSHOT = { ...FORMAT_TESTS };
const isDigitCode = (c) => c >= 48 && c <= 57;
const FORMAT_GUARDS = {
  uuid: (s) => s.length === 36,
  iso_time: (s) => s.length >= 10 && isDigitCode(s.charCodeAt(0)),
  url: (s) => { const c = s.charCodeAt(0); return c === 104 /* h */ || c === 47 /* / */; },
  email: (s) => s.includes('@'),
  pointer: (s) => s.charCodeAt(0) === 47,
  token_id: (s) => s.length >= 8,
  hex_id: (s) => s.length >= 12,
  numeric_string: (s) => { const c = s.charCodeAt(0); return isDigitCode(c) || c === 45 /* - */; },
};
// [name, test, guard] triples built once (the entries array used to be re-allocated per string).
const FORMAT_PLAN = Object.entries(FORMAT_TESTS).map(([f, test]) => [f, test, test === FORMAT_TEST_SNAPSHOT[f] ? FORMAT_GUARDS[f] : undefined]);
export function computeFormats(s) {
  const out = [];
  for (let i = 0; i < FORMAT_PLAN.length; i++) {
    const plan = FORMAT_PLAN[i];
    if (plan[2] !== undefined && !plan[2](s)) continue;
    if (plan[1](s)) out.push(plan[0]);
  }
  return out;
}
function formatsOf(s) {
  if (s.length > FORMAT_MEMO_STR_MAX) return computeFormats(s);
  let r = formatMemo.get(s);
  if (r === undefined) {
    r = computeFormats(s);
    if (formatMemo.size >= FORMAT_MEMO_MAX) formatMemo.clear();
    formatMemo.set(s, r);
  }
  return r;
}

// Sorted key signature of an object. Objects of one shape arrive in the same key order, so the
// sort + join is memoised on the unsorted key sequence (bounded). Result is identical.
const SIG_MEMO_MAX = 1024;
const sigMemo = new Map();
function sortedSignature(keys) {
  const n = keys.length;
  if (n < 2) return n ? keys[0] : '';
  const raw = keys.join('\u0000');
  const hit = sigMemo.get(raw);
  if (hit !== undefined && hit.keys.length === n) {
    let same = true;
    for (let i = 0; i < n; i++) if (hit.keys[i] !== keys[i]) { same = false; break; } // exact, even if a key contains the separator
    if (same) return hit.sig;
  }
  const sig = keys.slice().sort().join('|');
  if (sigMemo.size >= SIG_MEMO_MAX) sigMemo.clear();
  sigMemo.set(raw, { keys: keys.slice(), sig });
  return sig;
}

// Shape-aware sampling for large arrays: head + deterministic stride over the rest + the first
// occurrences of every distinct shape (sorted key set / kind), so rare variants are never lost.
export function sampleIndices(len, shapeOf, { head = 150, stride = 150, perShape = 3, maxShapes = 64 } = {}) {
  if (len <= head + stride) return Array.from({ length: len }, (_, i) => i);
  const keep = new Set();
  for (let i = 0; i < head; i++) keep.add(i);
  const step = (len - head) / stride;
  for (let k = 0; k < stride; k++) keep.add(head + Math.floor(k * step));
  const seen = new Map();
  for (let i = 0; i < len; i++) {
    const sh = shapeOf(i);
    const c = seen.get(sh) ?? 0;
    if (c < perShape && (seen.size < maxShapes || seen.has(sh))) { keep.add(i); seen.set(sh, c + 1); }
  }
  return [...keep].sort((a, b) => a - b);
}
export const shapeKey = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().join('|') : Array.isArray(v) ? '[]' : typeof v);

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

export class SchemaNode {
  constructor() {
    this.count = 0;
    this.kinds = {};
    this.str = null; this.num = null; this.bool = null;
    this.obj = null; this.arr = null;
  }

  observe(v, depth = 0) {
    this.count++;
    const k = kindOf(v);
    this.kinds[k] = (this.kinds[k] ?? 0) + 1;
    if (depth > 24) return this;
    if (k === 'string') this._str(v);
    else if (k === 'integer' || k === 'number') this._num(v);
    else if (k === 'boolean') { this.bool ??= { t: 0, f: 0 }; v ? this.bool.t++ : this.bool.f++; }
    else if (k === 'array') this._arr(v, depth);
    else if (k === 'object') this._obj(v, depth);
    return this;
  }

  merge(other) { if (!(other instanceof SchemaNode)) throw new TypeError('Expected SchemaNode'); if (other === this) throw new Error('Cannot merge a schema into itself'); mergeInto(this, other); return this; }

  // Plain-JSON sufficient statistics so an online profiler can resume incrementally.
  // Bounded: a distinct-value table whose text exceeds DISTINCT_STATE_CHARS is stored as
  // overflowed (cardinality then comes from the HLL sketch). That only affects long strings,
  // which can never qualify as enums anyway.
  toState() { return nodeToState(this); }
  static fromState(state) { return nodeFromState(state); }

  _str(s) {
    const st = (this.str ??= { n: 0, lenSum: 0, lenMin: Infinity, lenMax: 0, distinct: new Map(), overflow: false, formats: {}, examples: [] });
    st.n++; st.lenSum += s.length; st.lenMin = Math.min(st.lenMin, s.length); st.lenMax = Math.max(st.lenMax, s.length);
    (st.sketch ??= new CardinalitySketch()).add(s);
    if (!st.overflow) { st.distinct.set(s, (st.distinct.get(s) ?? 0) + 1); if (st.distinct.size > DISTINCT_CAP) { st.overflow = true; st.distinct = new Map(); } }
    for (const f of formatsOf(s)) st.formats[f] = (st.formats[f] ?? 0) + 1;
    if (st.examples.length < 3 && !st.examples.includes(s)) st.examples.push(s.length > 120 ? s.slice(0, 117) + '…' : s);
  }

  _num(x) {
    const st = (this.num ??= { n: 0, min: Infinity, max: -Infinity, sum: 0, distinct: new Set(), overflow: false, epochS: 0, epochMs: 0, changes: 0, last: undefined, examples: [] });
    if (!Number.isFinite(x)) { st.nonFinite = (st.nonFinite ?? 0) + 1; return; }
    st.n++; st.min = Math.min(st.min, x); st.max = Math.max(st.max, x); st.sum += x;
    const delta = x - (st.mean ?? 0); st.mean = (st.mean ?? 0) + delta / st.n;
    st.m2 = (st.m2 ?? 0) + delta * (x - st.mean);
    (st.sketch ??= new CardinalitySketch()).add(x);
    if (st.last !== undefined && st.last !== x) st.changes++;
    st.last = x;
    if (!st.overflow) { st.distinct.add(x); if (st.distinct.size > DISTINCT_CAP) { st.overflow = true; st.distinct = new Set(); } }
    if (x > 9.4e8 && x < 4.2e9) st.epochS++;
    if (x > 9.4e11 && x < 4.2e12) st.epochMs++;
    if (st.examples.length < 3 && !st.examples.includes(x)) st.examples.push(x);
  }

  _arr(a, depth) {
    const st = (this.arr ??= { n: 0, lenSum: 0, lenMax: 0, empty: 0, items: new SchemaNode() });
    st.n++; st.lenSum += a.length; st.lenMax = Math.max(st.lenMax, a.length); if (!a.length) st.empty++;
    for (const i of sampleIndices(a.length, (i) => shapeKey(a[i]))) st.items.observe(a[i], depth + 1);
    if (a.length > 300) st.sampled = (st.sampled ?? 0) + 1;
  }

  _obj(o, depth) {
    const st = (this.obj ??= { n: 0, fields: new Map(), keyOverflow: false, keysPerObj: 0, tags: new Map(), fieldSets: new Map() });
    st.n++;
    const keys = Object.keys(o);
    st.keysPerObj += keys.length;
    for (const k of keys) {
      if (!st.fields.has(k)) { if (st.fields.size >= KEY_CAP) { st.keyOverflow = true; continue; } st.fields.set(k, new SchemaNode()); }
      st.fields.get(k).observe(o[k], depth + 1);
    }
    // Tagged-union evidence: for each low-cardinality string field, which field sets co-occur.
    const sig = sortedSignature(keys);
    st.fieldSets.set(sig, (st.fieldSets.get(sig) ?? 0) + 1);
    if (st.fieldSets.size > 500) st.fieldSets = new Map([...st.fieldSets].sort((a, b) => b[1] - a[1]).slice(0, 200));
    for (let ki = 0; ki < keys.length; ki++) {
      const k = keys[ki];
      if (!st.fields.has(k)) continue;
      const v = o[k];
      if (typeof v !== 'string' || v.length > 48) continue;
      let t = st.tags.get(k);
      if (t === null) continue;
      if (!t) { t = new Map(); st.tags.set(k, t); }
      let g = t.get(v);
      if (!g) { if (t.size >= TAG_MAX_VALUES) { st.tags.set(k, null); continue; } g = { n: 0, keys: new Map() }; t.set(v, g); }
      g.n++;
      for (const kk of keys) if (kk !== k && st.fields.has(kk)) g.keys.set(kk, (g.keys.get(kk) ?? 0) + 1);
    }
  }

  // ------------------------------------------------------------------------------------------
  describe(name = '$') {
    const total = this.count || 1;
    const kinds = Object.entries(this.kinds).sort((a, b) => b[1] - a[1]);
    const out = { path: name, count: this.count, kinds: Object.fromEntries(kinds), nullable: !!this.kinds.null };
    const main = kinds.filter(([k]) => k !== 'null');
    out.type = main.length === 0 ? 'null' : main.length === 1 ? main[0][0] : (main.every(([k]) => k === 'integer' || k === 'number') ? 'number' : 'union');
    if (out.type === 'union') out.union = main.map(([k, n]) => ({ kind: k, share: +(n / total).toFixed(3) }));
    if (this.str) out.string = describeString(this.str);
    if (this.num?.n) out.number = describeNumber(this.num);
    if (this.num?.nonFinite) out.nonFiniteNumbers = this.num.nonFinite;
    if (this.bool) out.boolean = { trueShare: +(this.bool.t / (this.bool.t + this.bool.f)).toFixed(3) };
    if (this.arr) out.array = { avgLen: +(this.arr.lenSum / this.arr.n).toFixed(2), maxLen: this.arr.lenMax, emptyShare: +(this.arr.empty / this.arr.n).toFixed(3), items: this.arr.items.describe(`${name}[*]`) };
    if (this.obj) { const od = describeObject(this.obj, name); if (out.type === 'union') out.object = od; else Object.assign(out, od); }
    return out;
  }
}

function describeString(st) {
  const formats = {};
  for (const [f, n] of Object.entries(st.formats)) if (n / st.n >= 0.9) formats[f] = +(n / st.n).toFixed(3);
  const d = { n: st.n, avgLen: +(st.lenSum / st.n).toFixed(1), minLen: st.lenMin, maxLen: st.lenMax, formats, examples: st.examples };
  if (!st.overflow) {
    d.distinct = st.distinct.size;
    d.uniqueness = +(st.distinct.size / st.n).toFixed(3);
    // Enum: few distinct values, each repeated, short.
    const idLike = ['uuid', 'hex_id', 'token_id', 'url', 'iso_time', 'email'].some((f) => formats[f]);
    if (!idLike && st.distinct.size <= 12 && st.n >= Math.max(4, st.distinct.size * 2) && d.avgLen <= 40) d.enum = [...st.distinct].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, share: +(n / st.n).toFixed(3) }));
   } else { d.distinct = `>${DISTINCT_CAP}`; d.estimatedDistinct = Math.min(st.n, Math.max(DISTINCT_CAP + 1, st.sketch?.estimate() ?? DISTINCT_CAP + 1)); d.uniqueness = +(d.estimatedDistinct / st.n).toFixed(3); d.cardinalityEstimated = true; }
  return d;
}

function describeNumber(st) {
  const d = { n: st.n, min: st.min, max: st.max, mean: +((st.mean ?? st.sum / st.n)).toFixed(3), variance: +((st.m2 ?? 0) / Math.max(1, st.n - 1)).toFixed(4), examples: st.examples, changeRate: +(st.changes / Math.max(1, st.n - 1)).toFixed(3) };
  if (!st.overflow) { d.distinct = st.distinct.size; d.uniqueness = +(st.distinct.size / st.n).toFixed(3); } else { d.distinct = `>${DISTINCT_CAP}`; d.estimatedDistinct = Math.min(st.n, Math.max(DISTINCT_CAP + 1, st.sketch?.estimate() ?? DISTINCT_CAP + 1)); d.uniqueness = +(d.estimatedDistinct / st.n).toFixed(3); d.cardinalityEstimated = true; }
  if (st.epochS / st.n >= 0.9) d.format = 'epoch_s'; else if (st.epochMs / st.n >= 0.9) d.format = 'epoch_ms';
  return d;
}

const looksLikeDynamicKey = (k) => /^\d+(\.\d+)*$/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k) || /^[0-9a-f]{16,}$/i.test(k) || /^\d{4}-\d{2}-\d{2}/.test(k) || (/^[A-Za-z0-9_-]{16,}$/.test(k) && /\d/.test(k));

function describeObject(st, name) {
  const n = st.n;
  const keys = [...st.fields.keys()];
  const dynamicShare = keys.length ? keys.filter(looksLikeDynamicKey).length / keys.length : 0;
  const avgKeys = st.keysPerObj / n;
  // Map detection: many distinct keys relative to keys per object, or keys that look like ids.
  const isMap = st.keyOverflow || (keys.length >= 6 && dynamicShare >= 0.8) || (keys.length >= 20 && keys.length > avgKeys * 3);
  if (isMap) {
    const merged = new SchemaNode();
    for (const child of st.fields.values()) mergeInto(merged, child);
    return { type: 'map', map: { distinctKeys: keys.length + (st.keyOverflow ? '+' : ''), dynamicKeyShare: +dynamicShare.toFixed(3), sampleKeys: keys.slice(0, 5), values: merged.describe(`${name}[*]`) }, decision: { map: `keys look dynamic (${Math.round(dynamicShare * 100)}%) or vastly outnumber keys per object` } };
  }
  const fields = {};
  for (const [k, child] of st.fields) {
    const d = child.describe(`${name}.${k}`);
    d.presence = +(child.count / n).toFixed(3);
    d.required = child.count === n;
    fields[k] = d;
  }
  const out = { type: 'object', objects: n, fields };
  const tagged = detectTag(st, n);
  if (tagged) out.tagged = tagged;
  return out;
}

// A field is a discriminator when its values partition objects into groups whose field sets differ.
function detectTag(st, n) {
  let best = null;
  for (const [field, groups] of st.tags) {
    if (!groups || groups.size < 2) continue;
    const covered = [...groups.values()].reduce((a, g) => a + g.n, 0);
    if (covered / n < 0.9) continue;
    const sets = [...groups.entries()].map(([v, g]) => ({ value: v, n: g.n, keys: new Set([...g.keys].filter(([, c]) => c / g.n >= 0.5).map(([k]) => k)) }));
    let simSum = 0, pairs = 0;
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { simSum += jaccard(sets[i].keys, sets[j].keys); pairs++; }
    const avgSim = pairs ? simSum / pairs : 1;
    const score = (1 - avgSim) * Math.min(1, covered / n);
    if (avgSim < 0.75 && (!best || score > best.score)) best = { field, score: +score.toFixed(3), avgFieldSetSimilarity: +avgSim.toFixed(3), variants: sets.sort((a, b) => b.n - a.n).map((s) => ({ value: s.value, share: +(s.n / n).toFixed(3), fields: [...s.keys].sort() })) };
  }
  return best;
}

function mergeInto(target, src) {
  // Merge sufficient statistics; no synthetic observations or double-counted examples.
  target.count += src.count;
  for (const [k, c] of Object.entries(src.kinds)) target.kinds[k] = (target.kinds[k] ?? 0) + c;
  if (src.str) {
    const s = src.str, t = (target.str ??= { n: 0, lenSum: 0, lenMin: Infinity, lenMax: 0, distinct: new Map(), overflow: false, formats: {}, examples: [] });
    t.n += s.n; t.lenSum += s.lenSum; t.lenMin = Math.min(t.lenMin, s.lenMin); t.lenMax = Math.max(t.lenMax, s.lenMax);
    if (s.sketch) (t.sketch ??= new CardinalitySketch()).merge(s.sketch);
    for (const [f, c] of Object.entries(s.formats)) t.formats[f] = (t.formats[f] ?? 0) + c;
    if (!t.overflow && !s.overflow) for (const [v, c] of s.distinct) t.distinct.set(v, (t.distinct.get(v) ?? 0) + c);
    else t.overflow = true;
    if (t.distinct.size > DISTINCT_CAP) t.overflow = true;
    if (t.overflow) t.distinct.clear();
    for (const e of s.examples) if (t.examples.length < 3 && !t.examples.includes(e)) t.examples.push(e);
  }
  if (src.num) {
    const s = src.num, t = (target.num ??= { n: 0, min: Infinity, max: -Infinity, sum: 0, distinct: new Set(), overflow: false, epochS: 0, epochMs: 0, changes: 0, last: undefined, examples: [] });
    const total = t.n + s.n, delta = (s.mean ?? 0) - (t.mean ?? 0);
    t.m2 = (t.m2 ?? 0) + (s.m2 ?? 0) + (total ? delta * delta * t.n * s.n / total : 0);
    t.mean = total ? ((t.mean ?? 0) * t.n + (s.mean ?? 0) * s.n) / total : 0;
    t.n = total; t.min = Math.min(t.min, s.min); t.max = Math.max(t.max, s.max); t.sum += s.sum;
    t.epochS += s.epochS; t.epochMs += s.epochMs; t.changes += s.changes;
    t.nonFinite = (t.nonFinite ?? 0) + (s.nonFinite ?? 0);
    if (s.sketch) (t.sketch ??= new CardinalitySketch()).merge(s.sketch);
    if (!t.overflow && !s.overflow) for (const v of s.distinct) t.distinct.add(v); else t.overflow = true;
    if (t.distinct.size > DISTINCT_CAP) t.overflow = true;
    if (t.overflow) t.distinct.clear();
    for (const e of s.examples) if (t.examples.length < 3 && !t.examples.includes(e)) t.examples.push(e);
  }
  if (src.bool) { const t = (target.bool ??= { t: 0, f: 0 }); t.t += src.bool.t; t.f += src.bool.f; }
  if (src.arr) { const t = (target.arr ??= { n: 0, lenSum: 0, lenMax: 0, empty: 0, items: new SchemaNode() }); t.n += src.arr.n; t.lenSum += src.arr.lenSum; t.lenMax = Math.max(t.lenMax, src.arr.lenMax); t.empty += src.arr.empty; mergeInto(t.items, src.arr.items); }
  if (src.obj) {
    const s = src.obj, t = (target.obj ??= { n: 0, fields: new Map(), keyOverflow: false, keysPerObj: 0, tags: new Map(), fieldSets: new Map() });
    t.n += s.n; t.keysPerObj += s.keysPerObj; t.keyOverflow ||= s.keyOverflow;
    for (const [k, c] of s.fields) {
      if (!t.fields.has(k)) { if (t.fields.size >= KEY_CAP) { t.keyOverflow = true; continue; } t.fields.set(k, new SchemaNode()); }
      mergeInto(t.fields.get(k), c);
    }
    for (const [k, g] of s.tags) {
      if (!t.fields.has(k)) continue;
      if (g === null) { t.tags.set(k, null); continue; }
      if (t.tags.get(k) === null) continue;
      const tg = t.tags.get(k) ?? new Map();
      for (const [v, gg] of g) {
        if (!tg.has(v) && tg.size >= TAG_MAX_VALUES) { t.tags.set(k, null); break; }
        const x = tg.get(v) ?? { n: 0, keys: new Map() }; x.n += gg.n;
        for (const [kk, c] of gg.keys) if (t.fields.has(kk)) x.keys.set(kk, (x.keys.get(kk) ?? 0) + c);
        tg.set(v, x);
      }
      if (t.tags.get(k) !== null) t.tags.set(k, tg);
    }
    for (const [signature, count] of s.fieldSets) t.fieldSets.set(signature, (t.fieldSets.get(signature) ?? 0) + count);
    if (t.fieldSets.size > 500) t.fieldSets = new Map([...t.fieldSets].sort((a, b) => b[1] - a[1]).slice(0, 200));
  }
}

// ---------------------------------------------------------------------------------------------
// State (de)serialisation for SchemaNode. Compact keys; Infinity bounds round-trip via null.
// ---------------------------------------------------------------------------------------------
const DISTINCT_STATE_CHARS = 16384;
const finiteOr = (x, fallback) => (Number.isFinite(x) ? x : fallback);
const sketchToState = (s) => (s ? `${s.precision}:${Buffer.from(s.registers).toString('base64')}` : null);
function sketchFromState(x) {
  if (typeof x !== 'string' || !x.includes(':')) return undefined;
  const i = x.indexOf(':'), precision = Number(x.slice(0, i));
  try { return new CardinalitySketch({ precision, registers: Uint8Array.from(Buffer.from(x.slice(i + 1), 'base64')) }); } catch { return undefined; }
}

function nodeToState(n) {
  const out = { c: n.count, k: { ...n.kinds } };
  if (n.str) {
    const s = n.str;
    let overflow = !!s.overflow, distinct = null;
    if (!overflow) {
      let chars = 0;
      for (const v of s.distinct.keys()) chars += v.length;
      if (chars > DISTINCT_STATE_CHARS) overflow = true; else distinct = [...s.distinct];
    }
    out.s = { n: s.n, ls: s.lenSum, lmin: finiteOr(s.lenMin, null), lmax: s.lenMax, d: distinct, o: overflow, f: { ...s.formats }, e: [...s.examples], sk: sketchToState(s.sketch) };
  }
  if (n.num) {
    const s = n.num;
    out.n = { n: s.n, min: finiteOr(s.min, null), max: finiteOr(s.max, null), sum: s.sum, d: s.overflow ? null : [...s.distinct], o: !!s.overflow,
      es: s.epochS, ems: s.epochMs, ch: s.changes, last: s.last, e: [...s.examples], mean: s.mean, m2: s.m2, nf: s.nonFinite, sk: sketchToState(s.sketch) };
  }
  if (n.bool) out.b = { t: n.bool.t, f: n.bool.f };
  if (n.arr) out.a = { n: n.arr.n, ls: n.arr.lenSum, lmax: n.arr.lenMax, em: n.arr.empty, it: nodeToState(n.arr.items), sa: n.arr.sampled };
  if (n.obj) {
    const o = n.obj;
    out.o = { n: o.n, f: [...o.fields].map(([k, c]) => [k, nodeToState(c)]), ko: !!o.keyOverflow, kpo: o.keysPerObj,
      t: [...o.tags].map(([k, g]) => [k, g === null ? null : [...g].map(([v, x]) => [v, x.n, [...x.keys]])]), fs: [...o.fieldSets] };
  }
  return out;
}

function nodeFromState(st) {
  const n = new SchemaNode();
  if (!st || typeof st !== 'object') return n;
  n.count = st.c ?? 0; n.kinds = { ...(st.k ?? {}) };
  if (st.s) {
    const s = st.s;
    n.str = { n: s.n ?? 0, lenSum: s.ls ?? 0, lenMin: s.lmin ?? Infinity, lenMax: s.lmax ?? 0, distinct: new Map(s.o ? [] : s.d ?? []),
      overflow: !!s.o, formats: { ...(s.f ?? {}) }, examples: [...(s.e ?? [])] };
    const sk = sketchFromState(s.sk); if (sk) n.str.sketch = sk;
  }
  if (st.n) {
    const s = st.n;
    n.num = { n: s.n ?? 0, min: s.min ?? Infinity, max: s.max ?? -Infinity, sum: s.sum ?? 0, distinct: new Set(s.o ? [] : s.d ?? []), overflow: !!s.o,
      epochS: s.es ?? 0, epochMs: s.ems ?? 0, changes: s.ch ?? 0, last: s.last ?? undefined, examples: [...(s.e ?? [])] };
    if (s.mean !== undefined && s.mean !== null) n.num.mean = s.mean;
    if (s.m2 !== undefined && s.m2 !== null) n.num.m2 = s.m2;
    if (s.nf) n.num.nonFinite = s.nf;
    const sk = sketchFromState(s.sk); if (sk) n.num.sketch = sk;
  }
  if (st.b) n.bool = { t: st.b.t ?? 0, f: st.b.f ?? 0 };
  if (st.a) { n.arr = { n: st.a.n ?? 0, lenSum: st.a.ls ?? 0, lenMax: st.a.lmax ?? 0, empty: st.a.em ?? 0, items: nodeFromState(st.a.it) }; if (st.a.sa) n.arr.sampled = st.a.sa; }
  if (st.o) {
    const o = st.o;
    n.obj = { n: o.n ?? 0, fields: new Map((o.f ?? []).map(([k, c]) => [k, nodeFromState(c)])), keyOverflow: !!o.ko, keysPerObj: o.kpo ?? 0,
      tags: new Map((o.t ?? []).map(([k, g]) => [k, g === null ? null : new Map(g.map(([v, cnt, keys]) => [v, { n: cnt, keys: new Map(keys ?? []) }]))])),
      fieldSets: new Map(o.fs ?? []) };
  }
  return n;
}

export function jaccard(a, b) { if (!a.size && !b.size) return 1; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); }

export function induce(values) { const n = new SchemaNode(); for (const v of values) n.observe(v); return n.describe(); }

// ---------------------------------------------------------------------------------------------
// Flattening, similarity and alignment (cross-endpoint / cross-site clustering, drift repair)
// ---------------------------------------------------------------------------------------------
export function flatten(desc, out = []) {
  if (!desc) return out;
  out.push(desc);
  if (desc.fields) for (const f of Object.values(desc.fields)) flatten(f, out);
  if (desc.object?.fields) for (const f of Object.values(desc.object.fields)) flatten(f, out);
  if (desc.array) flatten(desc.array.items, out);
  if (desc.map) flatten(desc.map.values, out);
  return out;
}

export const tokens = (name) => String(name).replace(/\[\*\]/g, '').split(/[.\s]/).pop().replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const SYNONYMS = [
  ['id', 'uuid', 'key', 'identifier', 'sku', 'code', 'ref', 'reference', 'number', 'no', 'num', 'handle', 'slug'], ['title', 'name', 'label', 'headline', 'subject'], ['text', 'content', 'body', 'message', 'value', 'description', 'summary'],
  ['created', 'createdat', 'timestamp', 'time', 'date', 'ts', 'inserted'], ['updated', 'modified', 'changed'], ['url', 'href', 'link', 'uri', 'permalink'],
  ['author', 'user', 'owner', 'by', 'creator', 'sender', 'from'], ['status', 'state', 'stage', 'phase'], ['count', 'total', 'num', 'number', 'amount'],
  ['price', 'cost', 'amount', 'value'], ['role', 'kind', 'type'], ['parent', 'thread', 'conversation', 'container'], ['done', 'completed', 'finished', 'closed'],
  ['assignee', 'owner', 'responsible'], ['due', 'deadline', 'dueat', 'duedate'],
];
const SYN = new Map();
SYNONYMS.forEach((g, i) => g.forEach((w) => { if (!SYN.has(w)) SYN.set(w, new Set()); SYN.get(w).add(i); }));
const synGroups = (toks) => { const s = new Set(); for (const t of toks) for (const g of SYN.get(t) ?? []) s.add(g); return s; };

export function nameSimilarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const ja = jaccard(new Set(ta), new Set(tb));
  if (ja === 1) return 1;
  const joinedA = ta.join(''), joinedB = tb.join('');
  if (joinedA === joinedB) return 0.95;
  const ga = synGroups([...ta, joinedA]), gb = synGroups([...tb, joinedB]);
  const sg = ga.size && gb.size ? jaccard(ga, gb) : 0;
  return Math.max(ja, sg * 0.85);
}

// Profile of a field's value distribution, comparable across sites regardless of naming.
export function valueSignature(d) {
  const f = d.string?.formats ?? {};
  return {
    kind: d.type === 'integer' ? 'number' : d.type,
    format: Object.keys(f)[0] ?? d.number?.format ?? null,
    long: (d.string?.avgLen ?? 0) > 40,
    unique: (d.string?.uniqueness ?? d.number?.uniqueness ?? 0) > 0.9,
    enum: !!d.string?.enum,
    volatile: (d.number?.changeRate ?? 0) > 0.3,
  };
}

export function valueSimilarity(a, b) {
  const sa = valueSignature(a), sb = valueSignature(b);
  let s = 0;
  if (sa.kind === sb.kind) s += 0.4; else if ((sa.kind === 'number' && sb.kind === 'string' && (b.string?.formats?.numeric_string)) || (sb.kind === 'number' && sa.kind === 'string' && a.string?.formats?.numeric_string)) s += 0.25;
  if (sa.format && sa.format === sb.format) s += 0.25; else if (!sa.format && !sb.format) s += 0.1;
  if (sa.long === sb.long) s += 0.1;
  if (sa.unique === sb.unique) s += 0.1;
  if (sa.enum === sb.enum) s += 0.08;
  if (sa.volatile === sb.volatile) s += 0.07;
  return Math.min(1, s);
}

// Align the fields of two object schemas (greedy maximum-weight matching on combined similarity).
export function alignFields(a, b, { minScore = 0.45 } = {}) {
  const fa = Object.entries(a.fields ?? {}), fb = Object.entries(b.fields ?? {});
  const cands = [];
  for (const [na, da] of fa) for (const [nb, db] of fb) {
    const ns = nameSimilarity(na, nb), vs = valueSimilarity(da, db);
    const score = 0.55 * ns + 0.45 * vs;
    if (score >= minScore) cands.push({ a: na, b: nb, score: +score.toFixed(3), name: +ns.toFixed(3), value: +vs.toFixed(3) });
  }
  cands.sort((x, y) => y.score - x.score);
  const usedA = new Set(), usedB = new Set(), pairs = [];
  for (const c of cands) { if (usedA.has(c.a) || usedB.has(c.b)) continue; usedA.add(c.a); usedB.add(c.b); pairs.push(c); }
  return { pairs, unmatchedA: fa.map(([n]) => n).filter((n) => !usedA.has(n)), unmatchedB: fb.map(([n]) => n).filter((n) => !usedB.has(n)) };
}

// Structural similarity between two object schemas in [0,1].
export function schemaSimilarity(a, b) {
  if (!a?.fields || !b?.fields) return 0;
  const { pairs } = alignFields(a, b);
  const na = Object.keys(a.fields).length, nb = Object.keys(b.fields).length;
  const matched = pairs.reduce((s, p) => s + p.score, 0);
  return +(2 * matched / (na + nb)).toFixed(3);
}

// Schema evolution between two descriptions of the "same" object: drift and repair proposals.
export function schemaDiff(oldD, newD) {
  const of = oldD?.fields ?? {}, nf = newD?.fields ?? {};
  const removed = Object.keys(of).filter((k) => !(k in nf));
  const added = Object.keys(nf).filter((k) => !(k in of));
  const typeChanged = Object.keys(of).filter((k) => k in nf && of[k].type !== nf[k].type).map((k) => ({ field: k, from: of[k].type, to: nf[k].type }));
  const presenceDrop = Object.keys(of).filter((k) => k in nf && of[k].presence - nf[k].presence > 0.3).map((k) => ({ field: k, from: of[k].presence, to: nf[k].presence }));
  // Repair: removed field likely renamed to an added field with similar values (and similar name).
  const repairs = [];
  if (removed.length && added.length) {
    const sub = (d, keys) => ({ fields: Object.fromEntries(keys.map((k) => [k, d.fields[k]])) });
    const al = alignFields(sub(oldD, removed), sub(newD, added), { minScore: 0.35 });
    for (const p of al.pairs) repairs.push({ from: p.a, to: p.b, confidence: +(0.4 * p.value + 0.6 * Math.max(p.value * 0.8, p.score)).toFixed(3), basis: { nameSimilarity: p.name, valueSimilarity: p.value } });
  }
  return { removed, added, typeChanged, presenceDrop, repairs, drifted: !!(removed.length || typeChanged.length || presenceDrop.length) };
}
