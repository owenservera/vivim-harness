// Shape inference and suggestion engine.
// Observed values are kept apart from inferred meaning: every suggestion carries its evidence
// and a confidence, and nothing is applied until the user accepts it.
import { createHash } from 'node:crypto';
import { gatherEvidence, detectFamilies, proposeFamilyLink, applyMapping, endpointPattern } from '../families/families.mjs';
import { ruleMatchesEvent } from './extract.mjs';
import { sampleIndices, shapeKey } from '../intel/schema.mjs';
import { OnlineSchemaProfiler } from './profiler.mjs';

const DISCRIMINATORS = ['type', 'event', 'kind', 'op', 'o', 'action', 'method', 'name', 'object'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const URLISH = /^(https?:\/\/|\/[\w-])/;

// templateUrl is a pure function of the url string and is called once per decoded event (and per
// stream per status/report pass); `new URL` + 4 regexes per segment dominated. Bounded memo.
const TEMPLATE_MEMO_MAX = 2048;
const templateMemo = new Map();

export function templateUrl(url) {
  if (typeof url !== 'string') return templateUrlUncached(url);
  let r = templateMemo.get(url);
  if (r === undefined) {
    r = templateUrlUncached(url);
    if (templateMemo.size >= TEMPLATE_MEMO_MAX) templateMemo.clear();
    templateMemo.set(url, r);
  }
  return r;
}

function templateUrlUncached(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').map((s) => {
      if (!s) return s;
      if (UUID.test(s) || /^\d+$/.test(s) || /^[0-9a-f]{12,}$/i.test(s) || (/^[A-Za-z0-9_-]{22,}$/.test(s) && /\d/.test(s))) return '{id}';
      return s;
    });
    return `${u.host}${segs.join('/')}`;
  } catch { return String(url ?? '').split('?')[0]; }
}

const sid8 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 120 ? s.slice(0, 117) + '…' : s; };
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const fieldPath = (name) => /^[A-Za-z_$][\w$]*$/.test(name) ? `$.${name}` : `$[${JSON.stringify(name)}]`;

// Pure per-string flag detection, memoised (same strings recur constantly; bounded).
const FLAG_MEMO_MAX = 8192;
const FLAG_MEMO_STR_MAX = 256;
const flagMemo = new Map();
// Each regex is preceded by a necessary-condition check (length / first character) so the common
// non-matching strings never run it. The checks only ever exclude; results are unchanged.
const POINTER = /^\/[\w/-]*$/;
const MARKDOWN = /(^|\n)(#{1,6} |\* |- |\d+\. |```|\|.*\|)/;
export function computeStringFlags(v) {
  const out = [];
  const c0 = v.charCodeAt(0);
  if (v.length === 36 && UUID.test(v)) out.push('uuid');
  if (v.length >= 10 && c0 >= 48 && c0 <= 57 && ISO.test(v)) out.push('isoTime');
  if ((c0 === 104 || c0 === 47) && URLISH.test(v)) out.push('url');
  if (c0 === 47 && v.length < 80 && POINTER.test(v)) out.push('pointer');
  if (MARKDOWN.test(v)) out.push('markdown');
  return out;
}
function stringFlags(v) {
  if (v.length > FLAG_MEMO_STR_MAX) return computeStringFlags(v);
  let r = flagMemo.get(v);
  if (r === undefined) {
    r = computeStringFlags(v);
    if (flagMemo.size >= FLAG_MEMO_MAX) flagMemo.clear();
    flagMemo.set(v, r);
  }
  return r;
}

class FieldStats {
  constructor() { this.count = 0; this.types = {}; this.distinct = new Set(); this.distinctOverflow = false; this.examples = []; this.strLenMax = 0; this.strLenSum = 0; this.strN = 0; this.numMin = Infinity; this.numMax = -Infinity; this.flags = {}; }
  add(v) {
    this.count++;
    const t = typeOf(v);
    this.types[t] = (this.types[t] ?? 0) + 1;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      if (!this.distinctOverflow) { this.distinct.add(v); if (this.distinct.size > 64) { this.distinctOverflow = true; this.distinct = new Set(); } }
      if (this.examples.length < 3 && !this.examples.includes(short(v))) this.examples.push(short(v));
    }
    if (t === 'string') {
      this.strN++; this.strLenSum += v.length; if (v.length > this.strLenMax) this.strLenMax = v.length;
      for (const f of stringFlags(v)) this.flags[f] = (this.flags[f] ?? 0) + 1;
    }
    if (t === 'number') {
      if (v < this.numMin) this.numMin = v; if (v > this.numMax) this.numMax = v;
      if ((v > 1e9 && v < 4.2e9) || (v > 1e12 && v < 4.2e12)) this.flags.epoch = (this.flags.epoch ?? 0) + 1;
    }
  }
  toJSON() {
    const types = Object.entries(this.types).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const out = { count: this.count, types, examples: this.examples };
    if (!this.distinctOverflow) out.distinct = this.distinct.size;
    if (!this.distinctOverflow && this.distinct.size <= 8 && this.count >= 3) out.enum = [...this.distinct].map(short);
    if (this.strN) { out.avgLen = Math.round(this.strLenSum / this.strN); out.maxLen = this.strLenMax; }
    if (this.numMin !== Infinity) { out.min = this.numMin; out.max = this.numMax; }
    if (Object.keys(this.flags).length) out.flags = this.flags;
    return out;
  }
}

class Group {
  constructor(key, meta) { Object.assign(this, meta); this.key = key; this.count = 0; this.fields = new Map(); this.arrays = new Map(); this.firstT = null; this.lastT = null; this.streams = new Set(); }
  observe(json, t, sid) {
    this.count++; if (this.firstT === null) this.firstT = t; this.lastT = t; if (sid) this.streams.add(sid);
    walk(json, '$', 0, this);
  }
}

function walk(v, path, depth, group) {
  if (depth > 10 || group.fields.size > 600) return;
  let f = group.fields.get(path);
  if (!f) { f = new FieldStats(); group.fields.set(path, f); }
  f.add(v);
  if (Array.isArray(v)) {
    const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length) {
      const a = group.arrays.get(path) ?? { observations: 0, items: 0, sampledItems: 0, keyCounts: new Map() };
      a.observations++; a.items += objs.length;
      const indices = sampleIndices(objs.length, (i) => shapeKey(objs[i]), { head: 30, stride: 20, perShape: 2, maxShapes: 16 });
      a.sampledItems += indices.length;
      for (const i of indices) for (const k of Object.keys(objs[i])) a.keyCounts.set(k, (a.keyCounts.get(k) ?? 0) + 1);
      group.arrays.set(path, a);
    }
    for (const i of sampleIndices(v.length, (i) => shapeKey(v[i]), { head: 30, stride: 20, perShape: 2, maxShapes: 16 })) walk(v[i], `${path}[*]`, depth + 1, group);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) walk(x, /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`, depth + 1, group);
  }
}

function discriminatorOf(ev) {
  if (ev.event && ev.event !== 'message') return { path: 'event', value: ev.event };
  const j = ev.json;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    for (const k of DISCRIMINATORS) if (typeof j[k] === 'string' && j[k].length <= 48) return { path: `$.${k}`, value: j[k] };
  }
  if (Array.isArray(j)) return { path: '$', value: '[array]' };
  return { path: null, value: j === undefined ? `(${ev.type})` : '(object)' };
}

export class ShapeInferencer {
  // Observation (field statistics + schema profiler) is deferred off the CDP callback: observeEvent
  // only resolves the group and enqueues; the heavy walk runs in time-sliced setImmediate batches
  // (sliceMs per turn) so a 64 KB chunk that decodes into ~1000 events no longer blocks the loop for
  // the whole walk. FIFO order is preserved, so every statistic is identical to inline observation.
  // Every read path (groups/assembled/profiler getters, report) drains first. The queue is bounded:
  // above maxPending each new event processes one old event inline (backpressure, nothing dropped).
  // `deferred: false` restores fully inline behaviour.
  constructor(options = {}) {
    this._groups = new Map(); this._assembled = new Map(); this._profiler = new OnlineSchemaProfiler(options); this._epCache = new WeakMap();
    this.deferred = options.deferred !== false;
    this.maxPending = options.maxPending ?? 4096;
    this.sliceMs = options.sliceMs ?? 4;
    this._q = []; this._qi = 0; this._scheduled = false; this.deferredErrors = 0;
  }

  get groups() { this.flush(); return this._groups; }
  set groups(v) { this.flush(); this._groups = v; }
  get assembled() { this.flush(); return this._assembled; }
  set assembled(v) { this.flush(); this._assembled = v; }
  get profiler() { this.flush(); return this._profiler; }
  set profiler(v) { this.flush(); this._profiler = v; }
  get pendingObservations() { return (this._q.length - this._qi) / 3; }

  _applyOne() {
    const q = this._q, i = this._qi;
    const g = q[i], key = q[i + 1], ev = q[i + 2];
    q[i] = q[i + 1] = q[i + 2] = undefined;
    this._qi = i + 3;
    try {
      g.observe(ev.json, ev.t, ev.sid);
      this._profiler.observe(key, ev.json, ev);
    } catch { this.deferredErrors++; }
  }

  _compact() { if (this._qi >= this._q.length) { this._q = []; this._qi = 0; } else if (this._qi > 30000) { this._q = this._q.slice(this._qi); this._qi = 0; } }

  flush() {
    while (this._qi < this._q.length) this._applyOne();
    this._q = []; this._qi = 0;
  }

  _schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    // Deliberately ref'd: an unref'd immediate would not wake an otherwise idle poll phase, so the
    // backlog would crawl at one slice per loop wake. The work is bounded (maxPending) and ends.
    setImmediate(() => this._drainSlice());
  }

  _drainSlice() {
    this._scheduled = false;
    const deadline = performance.now() + this.sliceMs;
    let n = 0;
    while (this._qi < this._q.length) {
      this._applyOne();
      if ((++n & 15) === 0 && performance.now() >= deadline) break;
    }
    this._compact();
    if (this._qi < this._q.length) this._schedule();
  }

  // Endpoint label per stream, cached against the inputs that define it (url/method/kind), so a
  // stream with thousands of events builds the string once. Re-derived whenever an input changes.
  _endpointOf(stream) {
    const method = stream.method, url = stream.url, kind = stream.kind;
    const c = this._epCache.get(stream);
    if (c && c.method === method && c.url === url && c.kind === kind) return c.endpoint;
    const endpoint = `${method ?? (kind === 'ws' ? 'WS' : 'GET')} ${templateUrl(url)}`;
    this._epCache.set(stream, { method, url, kind, endpoint });
    return endpoint;
  }

  observeEvent(ev, stream) {
    if (ev.json === undefined) return;
    const endpoint = stream ? this._endpointOf(stream) : '(unknown)';
    const d = discriminatorOf(ev);
    const key = `${endpoint} :: ${d.value}`;
    let g = this._groups.get(key);
    if (!g) { g = new Group(key, { endpoint, discriminatorPath: d.path, discriminator: d.value, source: ev.type, dir: ev.dir }); this._groups.set(key, g); }
    if (!this.deferred) { g.observe(ev.json, ev.t, ev.sid); this._profiler.observe(key, ev.json, ev); return; }
    this._q.push(g, key, ev);
    if (this._q.length - this._qi > this.maxPending * 3) { this._applyOne(); this._compact(); }
    this._schedule();
  }

  observeAssembled(stream, doc) {
    if (!doc || typeof doc !== 'object') return;
    this.flush();
    const endpoint = `${stream.method ?? 'GET'} ${templateUrl(stream.url)}`;
    const key = `${endpoint} :: (assembled)`;
    let g = this.assembled.get(key);
    if (!g) { g = new Group(key, { endpoint, discriminator: '(assembled document)', source: 'assembled' }); this.assembled.set(key, g); }
    g.observe(doc, stream.endT ?? stream.lastChunkT ?? null, stream.sid);
  }

  // Build the full report: groups (schemas) + ranked, actionable suggestions.
  report(reducer, opts = {}) {
    const { domBlocks } = opts;
    // Per-phase wall time of the last report (instance-only; never part of the returned report).
    const ph = {}; let tp = performance.now();
    const mark = (k) => { const n = performance.now(); ph[k] = (ph[k] ?? 0) + (n - tp); tp = n; };
    const summary = reducer.summary();
    mark('summary');
    for (const s of summary.streams) {
      if (s.deltaRevisions > 1 && (s.status !== 'open')) {
        const st = reducer.streams.get(s.sid);
        if (st && !st._assembledObserved) { this.observeAssembled(st, st._delta.doc); Object.defineProperty(st, '_assembledObserved', { value: true }); }
      }
    }
    mark('assembledObserve');
    const groups = [...this.groups.values(), ...this.assembled.values()].map((g) => ({
      key: g.key, endpoint: g.endpoint, discriminator: g.discriminator, discriminatorPath: g.discriminatorPath, source: g.source, count: g.count, streams: g.streams.size,
      // Labels template away the scheme; preserve every observed origin separately.
      // A mixed-origin group must not be attributed to just the page's origin.
      origins: [...new Set([...g.streams].map((sid) => {
        try { const u = new URL(reducer.streams.get(sid)?.url); return ['http:', 'https:'].includes(u.protocol) ? u.origin : null; }
        catch { return null; }
      }))].sort(),
      fields: Object.fromEntries([...g.fields].slice(0, 200).map(([p, f]) => [p, f.toJSON()])),
      collections: [...g.arrays].map(([p, a]) => ({ path: p, avgItems: +(a.items / a.observations).toFixed(1), sampledItems: a.sampledItems, keys: [...a.keyCounts].sort((x, y) => y[1] - x[1]).slice(0, 20).map(([k, n]) => ({ key: k, presence: +(n / Math.max(1, a.sampledItems)).toFixed(2) })) })),
    }));
    mark('groups');
    const suggestions = suggest(summary, groups, reducer, domBlocks, ph);
    mark('suggest');
    const ctx = { families: opts.families ?? [], profile: opts.profile ?? null, domInspect: opts.domInspect ?? null, domTurns: opts.domTurns ?? null };
    const evidence = gatherEvidence(reducer, { domInspect: ctx.domInspect, domTurns: ctx.domTurns, phases: ph });
    mark('evidence');
    const families = ctx.families.length ? detectFamilies(ctx.families, evidence) : [];
    suggestions.push(...familySuggestions(families, ctx, evidence), ...driftSuggestions(ctx.profile, reducer, evidence));
    mark('families');
    // Corrections persist: apply accepted renames and mark decided suggestions.
    const acc = new Map((ctx.profile?.shapes?.accepted ?? []).map((x) => [x.id, 'accepted']));
    for (const x of ctx.profile?.shapes?.excluded ?? []) acc.set(x.id, 'rejected');
    const renames = ctx.profile?.shapes?.renames ?? {};
    for (const g of suggestions) { if (acc.has(g.id)) g.decided = acc.get(g.id); if (g.kind === 'event_type' && renames[g.evidence?.group]) g.title += ` — named “${renames[g.evidence.group]}”`; }
    for (const g of groups) if (renames[g.key]) g.name = renames[g.key];
    // Calibrated confidence sits NEXT to the raw score (which stays the ranking key): it reflects how
    // often suggestions of this kind and score were actually accepted by the user.
    for (const g of suggestions) g.calibratedConfidence = opts.calibrator ? opts.calibrator.calibrate(`suggestion:${g.kind}`, g.confidence) : g.confidence;
    suggestions.sort((a, b) => (a.decided ? 1 : 0) - (b.decided ? 1 : 0) || b.confidence - a.confidence);
    mark('rank');
    const endpoints = endpointTable(summary.streams);
    const schemaProfiles = this.profiler.report();
    mark('profiler');
    const q = quality(summary, reducer, suggestions, families, ctx, evidence);
    mark('quality');
    this.lastReportPhases = ph;
    return { generatedAt: new Date().toISOString(), endpoints, groups, families, suggestions, schemaProfiles, quality: q };
  }
}

function endpointTable(streams) {
  const m = new Map();
  for (const s of streams) {
    const key = `${s.method ?? (s.kind === 'ws' ? 'WS' : 'GET')} ${templateUrl(s.url)}`;
    const e = m.get(key) ?? { endpoint: key, streams: 0, bytes: 0, events: 0, transports: {}, statuses: {}, mime: new Set(), resourceTypes: new Set(), policies: new Set(), sids: [] };
    e.streams++; e.bytes += s.bytes; e.events += s.events;
    e.transports[s.transport] = (e.transports[s.transport] ?? 0) + 1;
    e.statuses[s.status_code ?? s.status] = (e.statuses[s.status_code ?? s.status] ?? 0) + 1;
    if (s.mime) e.mime.add(s.mime); if (s.resourceType) e.resourceTypes.add(s.resourceType); if (s.policy) e.policies.add(s.policy);
    if (e.sids.length < 50) e.sids.push(s.sid);
    m.set(key, e);
  }
  return [...m.values()].map((e) => ({ ...e, mime: [...e.mime], resourceTypes: [...e.resourceTypes], policies: [...e.policies] })).sort((a, b) => b.bytes - a.bytes);
}

const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function suggest(summary, groups, reducer, domBlocks, ph = null) {
  const out = [];
  const push = (kind, key, title, detail, confidence, evidence, proposal) => out.push({ id: `${kind}-${sid8(key)}`, kind, title, detail, confidence: +confidence.toFixed(2), evidence, proposal });
  // Optional per-section timing (instance phase object); no-op when not requested.
  let tp = performance.now();
  const mk = ph ? (k) => { const n = performance.now(); ph['s.' + k] = (ph['s.' + k] ?? 0) + (n - tp); tp = n; } : () => {};
  const eps = endpointTable(summary.streams);

  // 1. Streaming endpoints.
  for (const e of eps) {
    const streaming = Object.keys(e.transports).filter((t) => ['HTTP_SSE', 'HTTP_NDJSON', 'HTTP_STREAMED', 'EVENT_SOURCE', 'WEBSOCKET'].includes(t));
    if (!streaming.length) continue;
    push('stream_endpoint', e.endpoint, `Streaming endpoint: ${e.endpoint}`, `${streaming.join('/')} · ${e.streams} stream(s), ${e.events} decoded events, ${fmtBytes(e.bytes)} received. Keep raw bytes and decoded events for this endpoint?`, 0.9, { endpoint: e.endpoint, transports: e.transports, streams: e.streams }, { op: 'include_url', pattern: endpointRegex(e.endpoint) });
  }

  // 2. Beacon / telemetry-like endpoints (exclusion candidates).
  for (const e of eps) {
    const avg = e.bytes / Math.max(1, e.streams);
    const allSmallOk = Object.keys(e.statuses).every((c) => ['200', '202', '204'].includes(String(c)));
    if (e.endpoint.startsWith('POST ') && e.streams >= 3 && avg < 256 && allSmallOk && e.events <= e.streams) {
      push('beacon_exclusion', e.endpoint, `Looks like telemetry/beacons: ${e.endpoint}`, `${e.streams} small POSTs (avg ${Math.round(avg)} B response). Exclude from body capture to reduce noise? (metadata stays recorded)`, 0.6, { endpoint: e.endpoint, streams: e.streams, avgBytes: Math.round(avg) }, { op: 'exclude_url', pattern: endpointRegex(e.endpoint) });
    }
  }

  mk('endpoints');
  // 3. Event types, delta streams, fields.
  for (const g of groups) {
    if (g.source === 'assembled') continue;
    const fieldList = Object.entries(g.fields).filter(([p]) => p !== '$' && !p.includes('[*]')).slice(0, 8).map(([p, f]) => `${p.replace(/^\$\./, '')}: ${f.enum ? `enum(${f.enum.join('|')})` : f.types.join('|')}`);
    push('event_type', g.key, `Event type “${g.discriminator}” on ${g.endpoint}`, `${g.count} event(s) across ${g.streams} stream(s). Fields: ${fieldList.join(', ') || '(scalar)'}.`, Math.min(0.95, 0.5 + g.count / 50), { group: g.key, count: g.count }, { op: 'rename_shape', group: g.key, name: suggestName(g) });
    for (const c of g.collections) {
      if (c.avgItems < 2 || c.keys.length < 2) continue;
      const idKey = c.keys.find((k) => /(^|_)id$|Id$|^uuid$|^key$/.test(k.key))?.key;
      push('collection', `${g.key}|${c.path}`, `Collection at ${c.path.replace(/^\$\.?/, '') || '(root)'}: ~${c.avgItems} records × ${c.keys.length} fields`, `In “${g.discriminator}” events of ${g.endpoint}. Fields: ${c.keys.slice(0, 8).map((k) => k.key).join(', ')}${idKey ? `; identity key: ${idKey}` : '; no obvious identity key'}. Save as a record type?`, idKey ? 0.8 : 0.6, { group: g.key, path: c.path, keys: c.keys },
        { op: 'record_rule', rule: { name: suggestName(g, c.path), source: 'event', endpoint: endpointRegex(g.endpoint), discriminatorPath: g.discriminatorPath, discriminator: g.discriminator, itemsPath: c.path + '[*]', key: idKey ? fieldPath(idKey) : null, fields: Object.fromEntries(c.keys.slice(0, 16).map((k) => [k.key, fieldPath(k.key)])) } });
    }
    for (const [p, f] of Object.entries(g.fields)) {
      if (p === '$') continue;
      if (f.flags?.uuid >= f.count * 0.8 && f.distinct !== 1) push('identity_field', `${g.key}|${p}`, `Identifier: ${p}`, `UUID-like values in ${f.count} events of “${g.discriminator}”.`, 0.7, { group: g.key, path: p, examples: f.examples }, null);
      if ((f.flags?.isoTime ?? 0) + (f.flags?.epoch ?? 0) >= f.count * 0.8) push('timestamp_field', `${g.key}|${p}`, `Timestamp: ${p}`, `Time-like values (${f.flags.isoTime ? 'ISO' : 'epoch'}) in “${g.discriminator}”.`, 0.7, { group: g.key, path: p, examples: f.examples }, null);
      if (f.avgLen >= 40 || f.flags?.markdown) push('text_field', `${g.key}|${p}`, `Human text: ${p}`, `Avg ${f.avgLen} chars${f.flags?.markdown ? ', markdown detected' : ''}.`, 0.65, { group: g.key, path: p }, null);
    }
  }

  mk('fields');
  // 4. Delta-encoded streams.
  for (const s of summary.streams) {
    if (s.deltaRevisions < 5) continue;
    push('delta_stream', s.sid, `Streaming content revised ${s.deltaRevisions} times (${s.deltaDialects.join(', ') || 'snapshots'})`, `${s.method ?? ''} ${templateUrl(s.url)} — retain all intermediate revisions, or just the final assembled state? (raw is always kept)`, 0.85, { sid: s.sid, revisions: s.deltaRevisions, dialects: s.deltaDialects }, { op: 'retain_revisions', endpoint: endpointRegex(`${s.method ?? 'GET'} ${templateUrl(s.url)}`), choices: ['all', 'final'] });
  }
  mk('delta');

  // 5. Relationships: *_id values that match identifiers elsewhere.
  const idValues = new Map();
  for (const g of groups) for (const [p, f] of Object.entries(g.fields)) if (/(^|\.|_)id$/i.test(p) && f.examples.length) idValues.set(`${g.key}|${p}`, new Set(f.examples));
  for (const g of groups) for (const [p, f] of Object.entries(g.fields)) {
    if (!/[_.]?(parent|conversation|thread|message|item|owner|ref)_?id$/i.test(p) || /(^|\.)id$/.test(p)) continue;
    for (const [k, vals] of idValues) {
      if (k === `${g.key}|${p}`) continue;
      if (f.examples.some((v) => vals.has(v))) { push('relationship', `${g.key}|${p}|${k}`, `Relationship: ${p} → ${k.split('|')[1]}`, `Values of ${p} (“${g.discriminator}”) match identifiers in ${k.split(' :: ')[1]?.split('|')[0]}. Link as parent/child?`, 0.6, { from: `${g.key}|${p}`, to: k }, null); break; }
    }
  }
  mk('relationship');

  // 6. Raw stream <-> DOM correlation (or honest absence of one).
  const blocks = domBlocks ?? [...(reducer.dom?.blocks?.values() ?? [])];
  const streamTexts = [];
  for (const s of summary.streams) {
    const st = reducer.streams.get(s.sid);
    const texts = st?._delta?.texts?.(40) ?? [];
    const evTexts = (st?._events ?? []).filter((e) => typeof e.text === 'string' && e.text.length >= 40).map((e) => ({ text: e.text }));
    for (const t of [...texts.slice(0, 3), ...evTexts.slice(0, 2)]) streamTexts.push({ sid: s.sid, endpoint: `${s.method ?? ''} ${templateUrl(s.url)}`, text: norm(t.text) });
  }
  mk('domTexts');
  const matchedBlocks = new Set();
  // Each block's normalised text is computed at most once per report (lazily), not once per probe.
  // The first-match order is unchanged: the scan still walks blocks in order and returns the first hit.
  const normBlocks = new Array(blocks.length);
  for (const st of streamTexts) {
    const probe = st.text.slice(0, 120);
    if (probe.length < 30) continue;
    const needle = probe.slice(0, 60);
    let hit = null;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b.text) continue;
      const nt = normBlocks[i] ?? (normBlocks[i] = norm(b.text));
      if (nt.includes(needle)) { hit = b; break; }
    }
    if (hit) { matchedBlocks.add(hit.id); push('correlation', `${st.sid}|${hit.id}`, `Raw stream ↔ rendered block`, `Decoded text from ${st.endpoint} appears in UI block #${hit.id} (${hit.sig}).`, 0.8, { sid: st.sid, domId: hit.id }, null); }
  }
  mk('domMatch');
  for (const b of blocks) {
    if (matchedBlocks.has(b.id) || !b.text || b.text.length < 200 || b.removed) continue;
    push('uncorrelated_ui', `ui|${b.id}`, `UI block #${b.id} has no matching raw event`, `${b.sig} (${b.text.length} chars, ${b.revisions} revisions). Mark correlation unknown? It may come from earlier history, a non-captured transport, or client-side rendering.`, 0.5, { domId: b.id }, null);
    if (out.filter((o) => o.kind === 'uncorrelated_ui').length >= 10) break;
  }

  // 7. User action -> network effect.
  for (const a of reducer.actions ?? []) {
    if (!['click', 'enter', 'submit'].includes(a.kind)) continue;
    const started = summary.streams.filter((s) => s.startedT >= a.t && s.startedT <= a.t + 3000 && s.policy === 'body');
    if (!started.length) continue;
    push('action_effect', `${a.seq}`, `${a.kind} on ${a.target?.label ? `“${a.target.label.slice(0, 40)}”` : a.target?.sig} → ${started.length} request(s)`, started.slice(0, 4).map((s) => `${s.method ?? ''} ${templateUrl(s.url)} (${s.transport})`).join('; '), 0.7, { actionSeq: a.seq, sids: started.map((s) => s.sid) }, null);
  }
  mk('uncorrelatedAndActions');

  // 8. Coverage honesty.
  if (reducer.gaps.length) push('coverage_gap', 'gaps', `${reducer.gaps.length} capture gap(s) recorded`, `Local queue overflow dropped ${reducer.gaps.reduce((a, g) => a + (g.droppedRecords ?? 0), 0)} record(s). Affected streams are marked; consider a faster disk or narrower scope.`, 1, { gaps: reducer.gaps.length }, null);
  const failed = summary.streams.filter((s) => s.armError);
  if (failed.length) push('coverage_arm', 'arm', `Live streaming unavailable for ${failed.length} response(s)`, `Network.streamResourceContent was rejected (${[...new Set(failed.map((s) => s.armError))].slice(0, 2).join('; ')}). Those bodies were captured retrospectively when possible.`, 1, { count: failed.length }, null);

  return out.sort((a, b) => b.confidence - a.confidence);
}

function suggestName(g, path) {
  const base = String(g.discriminator ?? 'event').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'event';
  const tail = path ? path.split(/[.[\]*]+/).filter(Boolean).pop() : '';
  return tail ? `${base}_${tail.toLowerCase()}` : base;
}

export function endpointRegex(endpoint) {
  const p = endpoint.replace(/^[A-Z]+ /, '');
  return p.split('{id}').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/?#]+');
}

function fmtBytes(n) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`; }


// ---------------------------------------------------------------------------------------------
// Families: membership proposals with evidence and an editable field mapping.
// ---------------------------------------------------------------------------------------------
function familySuggestions(detections, ctx, evidence) {
  const out = [];
  const best = detections[0];
  if (!best || best.score < 0.5) return out;
  const fam = ctx.families.find((f) => f.name === best.family);
  const linked = ctx.profile?.family === best.family && (ctx.profile.familyMappings ?? []).length > 0;
  const links = proposeFamilyLink(fam, evidence);
  const chosen = [];
  const seen = new Set();
  for (const l of links) { const k = l.source.kind; if (seen.has(k)) continue; seen.add(k); chosen.push(l); }
  if (!linked) {
    const runnerUp = detections[1] && detections[1].score >= 0.5 ? ` Also plausible: ${detections[1].family} (${Math.round(detections[1].score * 100)}%).` : '';
    out.push({
      id: `family_membership-${sid8(best.family + '|' + (ctx.profile?.name ?? ''))}`, kind: 'family_membership',
      title: `This site looks like the “${best.family}” family`,
      detail: `${fam.description} Evidence: ${best.evidence.map((e) => e.why).join('; ')}.${chosen.length ? ` Proposed mapping from ${chosen.map((c) => c.endpointLabel).join(' and ')} into ${[...new Set(chosen.map((c) => c.entity))].join(', ')} records.` : ' No field mapping could be proposed yet; record more activity.'}${runnerUp}`,
      confidence: +best.score.toFixed(2), evidence: { detection: best, alternatives: detections.slice(1, 3) },
      proposal: { op: 'link_family', family: best.family, mappings: chosen.map((c) => ({ entity: c.entity, source: c.source, fields: c.fields, confidence: c.confidence, missing: c.missing })) },
    });
  } else {
    // Already linked: offer additional evidence sources not yet mapped (e.g. DOM turns).
    const have = new Set((ctx.profile.familyMappings ?? []).map((m) => `${m.entity}|${m.source.kind}|${m.source.endpoint ?? ''}`));
    for (const c of chosen) {
      const k = `${c.entity}|${c.source.kind}|${c.source.endpoint ?? ''}`;
      if (have.has(k)) continue;
      out.push({ id: `family_source-${sid8(k)}`, kind: 'family_source', title: `Add ${c.endpointLabel} as a source of ${best.family} ${c.entity} records`, detail: `Mapped fields: ${Object.entries(c.fields).map(([f, m]) => `${f} ← ${m.path.replace(/^\$\.?/, '')}`).join(', ')}.`, confidence: c.confidence, evidence: { samples: c.samples }, proposal: { op: 'add_family_mapping', mapping: { entity: c.entity, source: c.source, fields: c.fields } } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Drift: accepted rules/mappings that stopped matching what the site now sends.
// ---------------------------------------------------------------------------------------------
function driftSuggestions(profile, reducer, evidence) {
  const out = [];
  if (!profile) return out;
  const streams = [...reducer.streams.values()];
  for (const rule of profile.records ?? []) {
    if (rule.source !== 'event' || !rule.endpoint) continue;
    const re = new RegExp(rule.endpoint);
    const sts = streams.filter((s) => re.test(templateUrl(s.url)));
    if (!sts.length) continue;
    const matched = sts.reduce((a, s) => a + (s._events ?? []).filter((e) => ruleMatchesEvent(rule, e, s)).length, 0);
    const events = sts.reduce((a, s) => a + (s._events ?? []).length, 0);
    if (events >= 3 && matched === 0) out.push({ id: `drift-${sid8('rule|' + rule.name)}`, kind: 'drift', title: `Record rule “${rule.name}” no longer matches`, detail: `${sts.length} stream(s) from its endpoint carried ${events} events, none with ${rule.discriminatorPath ?? 'its selector'} = “${rule.discriminator}”. The site may have changed; review the current event types and re-link.`, confidence: 0.75, evidence: { rule: rule.name, streams: sts.length, events }, proposal: null });
  }
  (profile.familyMappings ?? []).forEach((m, i) => {
    if (m.source.kind !== 'assembled') return;
    const re = new RegExp(m.source.endpoint);
    const docs = evidence.assembled.filter((a) => re.test(templateUrl(a.url)));
    if (!docs.length) return;
    const recs = docs.map((d) => applyMapping(m, d.doc));
    const broken = Object.keys(m.fields).filter((f) => recs.filter((r) => r[f] === undefined || r[f] === null || r[f] === '').length > recs.length / 2);
    const req = broken.filter((f) => ['text', 'role', 'id', 'title'].includes(f));
    if (req.length) out.push({ id: `drift-${sid8('map|' + i + '|' + m.source.endpoint)}`, kind: 'drift', title: `Family mapping lost ${req.join(', ')}`, detail: `In ${docs.length} assembled stream(s), ${req.map((f) => `${f} (${m.fields[f].path})`).join(', ')} resolved to nothing in most records. The site's payload shape probably changed.`, confidence: 0.8, evidence: { mappingIndex: i, broken }, proposal: { op: 'remap_family', index: i } });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Calibration: explicit quality scores with what each one is based on.
// ---------------------------------------------------------------------------------------------
function quality(summary, reducer, suggestions, families, ctx, evidence) {
  const streams = summary.streams;
  const terminal = streams.filter((s) => s.status !== 'open');
  const complete = streams.filter((s) => s.status === 'complete' || s.status === 'closed');
  const withText = suggestions.filter((g) => g.kind === 'correlation').length;
  const uncorrelated = suggestions.filter((g) => g.kind === 'uncorrelated_ui').length;
  const shapeConf = suggestions.filter((g) => ['event_type', 'collection'].includes(g.kind));
  const fam = families[0];
  const mappingConf = ctx.profile?.familyMappings?.length ? Math.min(...ctx.profile.familyMappings.map((m) => m.confidence ?? 0.7)) : null;
  return {
    completeness: { score: terminal.length ? +(complete.length / terminal.length).toFixed(2) : null, basis: `${complete.length}/${terminal.length} finished streams reached a clean end; ${reducer.gaps.length} capture gap(s); ${streams.filter((s) => s.status === 'incomplete_at_stop').length} still open at stop` },
    shapeDetection: { score: shapeConf.length ? +(shapeConf.reduce((a, g) => a + g.confidence, 0) / shapeConf.length).toFixed(2) : null, basis: `${shapeConf.length} event-type/collection shape(s); confidence grows with repeated observations` },
    rawToRendered: { score: withText + uncorrelated ? +(withText / (withText + uncorrelated)).toFixed(2) : null, basis: `${withText} raw↔page correlation(s), ${uncorrelated} large page block(s) without a matching raw event` },
    familyFit: { score: fam ? fam.score : null, basis: fam ? `${fam.family}: ${fam.evidence.length} signal(s)` : 'no family definitions loaded' },
    familyMapping: { score: mappingConf, basis: mappingConf === null ? 'no accepted family mapping' : 'lowest accepted mapping confidence' },
    assumptions: [
      'Streams that started before attach are not observed.',
      'Decoded and assembled content is derived from raw bytes; raw is the source of truth.',
      'Credential-like values are masked in place and the masking is recorded per chunk.',
      'Family membership and field mappings are heuristic until you accept them.',
    ],
  };
}
