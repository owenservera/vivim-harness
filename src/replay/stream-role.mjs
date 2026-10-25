// Stream role classifier: what is this response/stream FOR (chat reply, history load, config, ...).
// Pure and offline: no I/O, no clock, no randomness, never mutates its input. Not wired into the
// reducer, derive or any transport label (a later lane integrates it).
//
//   classifyStreamRole(stream, opts?) -> { role, confidence, evidence }
//
// INPUT (all optional; each is exactly what the product already produces):
//   stream = {
//     summary:   one row of StreamReducer.summary().streams (mime, resourceType, method, status_code,
//                kind, bytes, chunks, frames, events, esMessages, heartbeats, status, coverage, ...)
//     events:    StreamReducer.eventsOf(sid), the decoded L2 events ({ json, jsonNested, heartbeat,
//                type, dir, ... }). Only structure is read; payload values are never copied out.
//     assembled: StreamReducer.assembled(sid) -> { doc, revisions, blocks, ... }
//     map:       applyStreamMap(map, events) result, or a STREAM_COMPONENTS stream entry
//                ({ components: [{ component, text | textLength }], stats })
//   }
//   A bare summary row (no events/assembled/map/summary key) is also accepted.
//
// OUTPUT
//   role        one of STREAM_ROLES. 'unknown' is the default and the answer to any ambiguity.
//   confidence  'none' (unknown only) | 'low' | 'medium' | 'high'. A HEURISTIC ordinal: it counts how
//               many kinds of structural signal are present. The kinds are all derived from the same
//               events (a stream map and the delta assembler read the very same payloads), so they are
//               NOT statistically independent and the level is not calibrated or a probability.
//   evidence    [{ feature, count }] in EVIDENCE_FEATURES order. feature is an enum name, count a
//               positive integer. No payload text, keys, ids, URLs or credential bytes appear here.
//
// PRINCIPLES
//   * Value types and structure decide the role. URL, endpoint and key names are never evidence by
//     themselves; neither are chunk count, framing (SSE/NDJSON/WS) or a null/absent error key.
//   * Masking, redaction counts and credential-SHAPED strings (JWT-like, opaque, starred) are capture
//     policy or incidental values, not endpoint purpose. They are weak hints at most: auth needs a
//     typed token-exchange response structure.
//   * Incremental text proves only that text grows (editor, log, notification, chat). chat-reply also
//     needs chat-specific structure: a mapped message component or a typed assistant role frame.
//   * A specific role needs score >= 2 (see each detector). Score-1 hints are reported as
//     weak_evidence_only and the role stays unknown. Two different roles at score >= 2 conflict:
//     unknown.
//   * Inspection is bounded (opts, and the reducer's event window). inspection_truncated is reported
//     whenever any cap was hit. A specific role whose verdict could be contradicted by the unexamined part
//     (omitted / skipped events, growth or structure scan cuts; the 500-record pool only for non-content
//     roles) is WITHHELD: role unknown, evidence withheld_for_incomplete_inspection, the candidate kept in
//     result.coverage.withheldRole. result.coverage separates the causes (see baseCoverage below).

// Bump when classification behaviour changes: persisted STREAM_ROLES artifacts carry it, and a consumer
// that finds an older (or missing) version must re-derive instead of reusing the artifact.
import { PROTO_FEATURES_SCHEMA, PROTO_FEATURES_VERSION } from '../decode/proto-features.mjs';

// v2: a specific role is WITHHELD (role unknown, coverage.withheldRole set) when an inspection cap or
//     omitted events could have hidden contradictory content; results carry a `coverage` object.
// v3: coverage.binary consumes the decoder's compact ev.protoFeatures snapshots (contract constants shared
//     with src/decode/proto-features.mjs): structural / opaque, complete or not. Never a role.
export const STREAM_ROLE_CLASSIFIER_VERSION = 3;
export const STREAM_ROLES_SCHEMA = 'capture-studio.stream-roles/3';
export const STREAM_ROLES_CONFIDENCE_SCALE = 'heuristic-ordinal (none|low|medium|high); uncalibrated, not a probability; signals derive from the same events and are not independent';

export const STREAM_ROLES = Object.freeze(['chat-reply', 'history-load', 'config', 'telemetry', 'push-presence', 'asset', 'auth', 'unknown']);
export const CONFIDENCE_LEVELS = Object.freeze(['none', 'low', 'medium', 'high']);
export const EVIDENCE_FEATURES = Object.freeze([
  // verdict / coverage markers
  'empty_stream', 'no_structural_evidence', 'weak_evidence_only', 'conflicting_role_evidence', 'incomplete_capture', 'inspection_truncated', 'withheld_for_incomplete_inspection',
  // shared context
  'json_events', 'heartbeat_events',
  // reply: text growth, then chat-specific structure
  'delta_growth_targets', 'delta_growth_steps', 'mapped_text_components', 'assembled_text_blocks',
  'mapped_message_components', 'assistant_role_frames',
  // history
  'message_entries', 'message_roles_distinct',
  // config
  'descriptor_array_entries', 'boolean_leaves',
  // telemetry
  'numeric_leaves', 'timestamp_values', 'repeated_record_shape',
  // presence
  'small_flat_payloads',
  // auth: structure first, then weak hints
  'token_exchange_structure', 'token_exchange_request', 'credential_shaped_values', 'masked_credential_values', 'masked_credential_spans',
  // asset
  'asset_media_type', 'asset_resource_type', 'non_json_body',
  // binary structure (decoder feature snapshots): context only, never a role
  'binary_structural_frames', 'binary_incomplete_frames',
]);

// ---- options: validated and clamped --------------------------------------------------------------
// Anything that is not a finite number (NaN, +-Infinity, strings, objects) falls back to the default.
// Budgets are clamped into a sane range. Growth thresholds can only be TIGHTENED: a caller cannot
// lower them below the defaults and thereby force text-growth (and confidence) out of weak data.
const OPTION_SPECS = Object.freeze({
  maxEvents: [5000, 1, 100000],        // events examined per stream (the first N, in order)
  maxNodes: [2000, 50, 100000],        // JSON nodes visited per document, per pass
  minGrowthSteps: [3, 3, 1000],        // appends to one target before it counts as text growth
  minGrowthDistinct: [3, 3, 1000],     // ...of at least this many distinct pieces
  minGrowthChars: [6, 6, 100000],
  smallDocBytes: [8192, 256, 65536],   // an auth response is a small document
});

export function resolveClassifierOptions(opts) {
  const src = opts !== null && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const out = {};
  for (const [k, [def, lo, hi]] of Object.entries(OPTION_SPECS)) {
    const v = src[k];
    // Non-finite, zero and negative values are rejected (default), not clamped to the minimum.
    out[k] = typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(hi, Math.max(lo, Math.floor(v))) : def;
  }
  return Object.freeze(out);
}

const CHAT_ROLES = new Set(['user', 'assistant', 'system', 'tool', 'human', 'ai', 'model', 'bot']);
const ASSISTANT_ROLES = new Set(['assistant', 'model', 'ai', 'bot']);
const INDEX_KEYS = ['index', 'output_index', 'content_index', 'block_index', 'candidate_index', 'choice_index'];
const ASSET_MIME = /^(?:image|audio|video|font)\/|^text\/(?:css|javascript|html)$|^application\/(?:javascript|x-javascript|ecmascript|wasm|font-[\w-]+|x-font-[\w-]+|vnd\.ms-fontobject)$/;
const ASSET_RESOURCE_TYPES = new Set(['Image', 'Stylesheet', 'Script', 'Font', 'Media', 'Manifest', 'TextTrack']);
const INCOMPLETE_STATUS = new Set(['failed', 'canceled', 'incomplete_at_stop']);
const JWT_SHAPED = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const OPAQUE_SECRET = /^[A-Za-z0-9_\-+/=]{40,}$/;
const TOKEN_VALUE = /^[A-Za-z0-9._~+/=-]{20,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const NUMERIC_TEXT = /^\s*-?\d+(?:\.\d+)?\s*$/;
// Token-exchange response slots. Key names are only HALF of the test: the value must also have the
// right type (credential-shaped string / plausible expiry integer) and both slots must be present.
const TOKEN_SLOT_KEYS = new Set(['accesstoken', 'idtoken', 'refreshtoken', 'sessiontoken', 'authtoken', 'token']);
const EXPIRY_SLOT_KEYS = new Set(['expiresin', 'expiresat', 'expires', 'expiry', 'exp']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTimestampNumber = (v) => typeof v === 'number' && Number.isFinite(v) && ((v >= 1e9 && v <= 4.2e9) || (v >= 1e12 && v <= 4.2e12));
const isExpiryNumber = (v) => Number.isInteger(v) && ((v >= 30 && v <= 3.2e7) || isTimestampNumber(v));
const isOpaqueSecret = (s) => OPAQUE_SECRET.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !UUID.test(s);
const starCount = (s) => s.match(/\*/g)?.length ?? 0;
const isMasked = (s) => s.length >= 8 && starCount(s) >= 8 && starCount(s) / s.length >= 0.5;
const slotKey = (k) => String(k).toLowerCase().replace(/[_-]/g, '');

// Bounded traversal: every walker spends from a budget and records when a bound hid something.
const mkBudget = (n) => ({ n, hit: false });
const spend = (b) => { if (b.n <= 0) { b.hit = true; return false; } b.n--; return true; };

// ---- input normalisation ------------------------------------------------------------------------
function normalize(stream) {
  const s = isObj(stream) ? stream : {};
  const wrapped = Array.isArray(s.events) || 'summary' in s || 'assembled' in s || 'map' in s;
  return {
    summary: wrapped ? (isObj(s.summary) ? s.summary : {}) : s,
    events: wrapped && Array.isArray(s.events) ? s.events : [],
    assembled: wrapped && isObj(s.assembled) ? s.assembled : null,
    map: wrapped && isObj(s.map) ? s.map : null,
  };
}

// Same choice the reducer makes for delta reconstruction: an unwrapped nested document wins.
const jsonOf = (ev) => (ev?.jsonNested?.json !== undefined ? ev.jsonNested.json : ev?.json);

// Decoded JSON documents in order. Heartbeats carry no content and are only counted.
function collectDocs(events, o) {
  const docs = [];
  let heartbeats = 0;
  let channelEvents = 0;
  const examined = events.slice(0, o.maxEvents);
  for (const ev of examined) {
    if (!isObj(ev)) continue;
    if (ev.dir !== undefined || ev.type === 'eventsource') channelEvents++;
    if (ev.heartbeat === true) { heartbeats++; continue; }
    const j = jsonOf(ev);
    if (j && typeof j === 'object') docs.push(j);
  }
  return { docs, heartbeats, channelEvents, skippedEvents: events.length - examined.length };
}

// ---- incremental text (proves growth, NOT that it is a chat reply) -----------------------------
function createGrowth() {
  const targets = new Map();   // target -> { n, distinct:Set, chars }
  const lastText = new Map();  // target -> last full string seen (cumulative snapshots)
  const state = { lastPath: null, truncatedDocs: 0 };
  const step = (target, piece) => {
    if (typeof piece !== 'string' || piece.length === 0 || NUMERIC_TEXT.test(piece)) return;
    let t = targets.get(target);
    if (!t) targets.set(target, t = { n: 0, distinct: new Set(), chars: 0 });
    t.n++; t.chars += piece.length;
    if (t.distinct.size < 64) t.distinct.add(piece);
  };
  const cumulative = (target, value) => {
    if (typeof value !== 'string') return;
    const prev = lastText.get(target);
    if (typeof prev === 'string' && prev.length > 0 && value.length > prev.length && value.startsWith(prev)) step(target, value.slice(prev.length));
    lastText.set(target, value);
  };
  return { targets, step, cumulative, state };
}

function expandPatch(json) {
  if (isObj(json) && json.o === 'patch' && Array.isArray(json.v)) return json.v;
  return [json];
}

// String leaves under a `delta` key (typed events, chat-completions choices[].delta, ...).
// CAP CHECKS ARE THEMSELVES BOUNDED. A cap is a statement "there is an unseen tail"; deciding that never
// reads the tail. A non-empty unseen tail is conservatively a cut: false uncertainty beats an unbounded scan
// (the tail could hold a delta, a string snapshot or a container, and looking would defeat maxNodes).
// Scalars hold nothing, so a scalar leaf below a depth cap is not a cut (no scan is needed to know that).
const holdsContainer = (v) => v !== null && typeof v === 'object';

// At most `limit` own entries are materialised, in insertion order; `more` says an unseen entry exists
// (one extra key is looked at, never the rest). No Object.entries()/keys()/values() over the whole object.
function boundedEntries(obj, limit) {
  const entries = [];
  let more = false;
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    if (entries.length >= limit) { more = true; break; }
    entries.push([k, obj[k]]);
  }
  return { entries, more };
}

function walkDelta(node, path, depth, idx, g, b) {
  if (!spend(b)) return;
  if (!holdsContainer(node)) return;
  if (depth > 5) { b.hit = true; return; }
  if (Array.isArray(node)) {
    if (node.length > 32) b.hit = true;
    node.slice(0, 32).forEach((x, i) => walkDelta(x, `${path}[${i}]`, depth + 1, idx, g, b));
    return;
  }
  const { entries, more } = boundedEntries(node, 40);
  if (more) b.hit = true;
  for (const [k, v] of entries) {
    if (k === 'delta') {
      if (typeof v === 'string') g.step(`${idx}|${path}.delta`, v);
      else if (isObj(v)) {
        const de = boundedEntries(v, 20);
        if (de.more) b.hit = true;
        for (const [dk, dv] of de.entries) if (dk !== 'type' && typeof dv === 'string') g.step(`${idx}|${path}.delta.${dk}`, dv);
      }
    } else if (v && typeof v === 'object') walkDelta(v, `${path}.${k}`, depth + 1, idx, g, b);
  }
}

// Leaves of a plain document, for cumulative-snapshot detection.
function snapshotLeaves(node, path, depth, g, b) {
  if (!spend(b)) return;
  if (typeof node !== 'string' && !holdsContainer(node)) return; // numbers / booleans / null never grow
  if (depth > 6) { b.hit = true; return; }
  if (typeof node === 'string') { g.cumulative(`leaf|${path}`, node); return; }
  if (Array.isArray(node)) {
    if (node.length > 32) b.hit = true;
    node.slice(0, 32).forEach((x, i) => snapshotLeaves(x, `${path}[${i}]`, depth + 1, g, b));
    return;
  }
  if (isObj(node)) {
    const { entries, more } = boundedEntries(node, 40);
    if (more) b.hit = true;
    for (const [k, v] of entries) snapshotLeaves(v, `${path}.${k}`, depth + 1, g, b);
  }
}

function feedGrowth(g, json, maxNodes) {
  const b = mkBudget(maxNodes);
  for (const u of expandPatch(json)) {
    if (Array.isArray(u)) { // RFC 6902 operations: only a string that extends the previous value is growth
      if (u.length > 50) b.hit = true;
      for (const op of u.slice(0, 50)) if (isObj(op) && typeof op.path === 'string' && (op.op === 'add' || op.op === 'replace')) g.cumulative(`jp|${op.path}`, op.value);
      continue;
    }
    if (!isObj(u)) continue;
    if ('p' in u || 'o' in u || ('v' in u && !('type' in u))) { // path-op: { p, o, v } or a bare { v } continuation
      const path = typeof u.p === 'string' ? u.p : g.state.lastPath;
      if (typeof u.p === 'string') g.state.lastPath = u.p;
      const mode = u.o === undefined ? 'append' : u.o;
      if (path != null && typeof u.v === 'string') {
        if (mode === 'append') g.step(`po|${path}`, u.v);
        else if (mode === 'replace' || mode === 'set' || mode === 'add') g.cumulative(`po|${path}`, u.v);
      }
      continue;
    }
    const idx = INDEX_KEYS.filter((k) => Number.isInteger(u[k])).map((k) => u[k]).join('.');
    walkDelta(u, '', 0, idx, g, b);
    snapshotLeaves(u, '', 0, g, b);
  }
  if (b.hit) g.state.truncatedDocs++;
}

function growthSummary(g, o) {
  let targets = 0; let steps = 0;
  for (const t of g.targets.values()) {
    if (t.n >= o.minGrowthSteps && t.distinct.size >= o.minGrowthDistinct && t.chars >= o.minGrowthChars) { targets++; steps += t.n; }
  }
  return { targets, steps };
}

function mappedTextComponents(map) {
  if (!map) return 0;
  const comps = Array.isArray(map.components) ? map.components : [];
  if (isObj(map.stats) && Number.isFinite(map.stats.mapped) && map.stats.mapped < 2) return 0;
  return comps.filter((c) => isObj(c) && c.component !== 'message' && (Number.isFinite(c.textLength) ? c.textLength : (typeof c.text === 'string' ? c.text.length : 0)) > 0).length;
}

// An ACTUAL mapped reply: the map opened a message container AND built text under it. A map that only
// matched a terminal / finalize event ([DONE], message_stop, ...) has no components and gives 0.
function mappedMessageComponents(map) {
  if (!map || mappedTextComponents(map) === 0) return 0;
  return (Array.isArray(map.components) ? map.components : []).filter((c) => isObj(c) && c.component === 'message').length;
}

function assembledTextBlocks(assembled) {
  if (!assembled || !(assembled.revisions >= 3) || !Array.isArray(assembled.blocks)) return 0;
  return assembled.blocks.filter((b) => isObj(b) && typeof b.text === 'string' && b.text.length > 0).length;
}

function growthFacts(docs, assembled, map, o) {
  const g = createGrowth();
  for (const d of docs) feedGrowth(g, d, o.maxNodes);
  const { targets, steps } = growthSummary(g, o);
  const mapped = mappedTextComponents(map);
  const blocks = assembledTextBlocks(assembled);
  return { targets, steps, mapped, blocks, incremental: targets > 0 || mapped > 0 || blocks > 0, truncatedDocs: g.state.truncatedDocs };
}

// ---- structure of the decoded JSON ---------------------------------------------------------------
function textual(v, d = 0) {
  if (d > 3) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.slice(0, 20).some((x) => textual(x, d + 1));
  if (isObj(v)) return textual(v.text, d + 1) || textual(v.content, d + 1) || textual(v.parts, d + 1) || textual(v.value, d + 1);
  return false;
}

const roleValueOf = (node) => {
  const raw = typeof node.role === 'string' ? node.role : (isObj(node.author) && typeof node.author.role === 'string' ? node.author.role : null);
  return raw === null ? null : raw.toLowerCase();
};

// A message-like entry has a chat role VALUE and non-empty textual content. Returns the role or null.
function messageRole(o) {
  if (!isObj(o)) return null;
  const node = isObj(o.message) && !('role' in o) ? o.message : o;
  const role = roleValueOf(node);
  if (role === null || !CHAT_ROLES.has(role)) return null;
  return textual(node.content) || textual(node.text) || textual(node.parts) ? role : null;
}

// A typed assistant frame: an assistant-ish role VALUE next to a content slot (which may still be
// empty: message_start, the first chat-completions chunk). A model-list entry has no content slot.
function isAssistantFrame(node) {
  const role = roleValueOf(node);
  return role !== null && ASSISTANT_ROLES.has(role) && ('content' in node || 'parts' in node || 'text' in node);
}

const scalarKind = (v) => (typeof v === 'string' ? 's' : typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : v === null ? 'z' : 'o');
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
// Record shape signature over at most 60 keys (a wider record just gets a '+' marker): bounded per record.
const signature = (rec) => {
  const { entries, more } = boundedEntries(rec, 60);
  return entries.map(([k, v]) => `${k}:${scalarKind(v)}`).sort().join(',') + (more ? '|+' : '');
};

function createStats() {
  return {
    booleans: 0, numbers: 0, strings: 0, longStrings: 0, ts: 0, jwt: 0, opaque: 0, masked: 0,
    msg: { count: 0, roles: new Set() },
    descriptorEntries: 0, assistantFrames: 0,
  };
}

function scalarStats(st, v) {
  if (typeof v === 'boolean') st.booleans++;
  else if (typeof v === 'number') { st.numbers++; if (isTimestampNumber(v)) st.ts++; }
  else if (typeof v === 'string') {
    st.strings++;
    if (v.length > 80) st.longStrings++;
    if (ISO_TIME.test(v)) st.ts++;
    if (JWT_SHAPED.test(v)) st.jwt++;
    else if (isMasked(v)) st.masked++;
    else if (isOpaqueSecret(v)) st.opaque++;
  }
}

function noteContainer(st, members) {
  const roles = members.map(messageRole).filter((r) => r !== null);
  if (roles.length > st.msg.count) st.msg = { count: roles.length, roles: new Set(roles) };
  return roles.length;
}

function descriptorArray(items) {
  if (items.length < 3 || !items.every(isObj)) return false;
  const sigs = new Map();
  for (const it of items) sigs.set(signature(it), (sigs.get(signature(it)) ?? 0) + 1);
  if (Math.max(...sigs.values()) / items.length < 0.8) return false;
  const vals = (it) => boundedEntries(it, 60).entries.map((e) => e[1]);
  return items.every((it) => vals(it).filter(isScalar).length >= 2) && items.some((it) => vals(it).some((v) => typeof v === 'string'));
}

function scan(node, depth, st, b) {
  if (!spend(b)) return;
  if (depth > 8) { b.hit = true; return; }
  if (Array.isArray(node)) {
    if (node.length > 500) b.hit = true;
    const members = node.slice(0, 500);
    const msgs = noteContainer(st, members);
    if (msgs === 0 && descriptorArray(members)) st.descriptorEntries += members.length;
    for (const x of members) scan(x, depth + 1, st, b);
  } else if (isObj(node)) {
    if (isAssistantFrame(node)) st.assistantFrames++;
    const { entries, more } = boundedEntries(node, 200);
    if (more) b.hit = true;
    const vals = entries.map((e) => e[1]);
    if (vals.length >= 2) noteContainer(st, vals);
    for (const x of vals) scan(x, depth + 1, st, b);
  } else scalarStats(st, node);
}

// Typed token-exchange response: a credential-shaped string in a token slot AND an expiry integer in
// an expiry slot, in the same object (top level, or one `data` wrapper). Neither alone is enough.
function tokenExchangeIn(obj) {
  if (!isObj(obj)) return false;
  let token = false; let expiry = false;
  for (const [k, v] of boundedEntries(obj, 40).entries) {
    const key = slotKey(k);
    if (TOKEN_SLOT_KEYS.has(key) && typeof v === 'string' && (JWT_SHAPED.test(v) || isMasked(v) || TOKEN_VALUE.test(v))) token = true;
    if (EXPIRY_SLOT_KEYS.has(key) && isExpiryNumber(v)) expiry = true;
  }
  return token && expiry;
}
const tokenExchange = (doc) => tokenExchangeIn(doc) || (isObj(doc) && tokenExchangeIn(doc.data));

// Records for telemetry: the largest array of >=3 objects (depth <= 2) or the document itself.
// Bounded: only the first 200 members decide whether an array holds records, at most 501 are returned (one
// more than the pool holds, so an overflow is still visible as recordPoolCapped), and objects are read through
// boundedEntries. Nothing here walks an unbounded tail.
function recordsOf(doc) {
  const pick = (arr) => {
    if (arr.length < 3 || !arr.slice(0, 200).every(isObj)) return null;
    return arr.slice(0, 501);
  };
  const better = (p, best) => p && (!best || p.length > best.length);
  if (Array.isArray(doc)) return pick(doc) ?? [];
  if (!isObj(doc)) return [];
  let best = null;
  for (const [, v] of boundedEntries(doc, 200).entries) {
    if (Array.isArray(v)) { const p = pick(v); if (better(p, best)) best = p; }
    else if (isObj(v)) for (const [, w] of boundedEntries(v, 200).entries) if (Array.isArray(w)) { const p = pick(w); if (better(p, best)) best = p; }
  }
  return best ?? [doc];
}

function analyze(docs, assembledDoc, o) {
  const st = createStats();
  const records = [];
  let truncatedDocs = 0;          // documents whose structure scan was cut (nodes / depth / array / key caps)
  let recordPoolCapped = false;   // more than 500 telemetry/config records: only record-based detectors care
  let exchanges = 0;
  for (const d of docs) {
    const b = mkBudget(o.maxNodes);
    scan(d, 0, st, b);
    if (b.hit) truncatedDocs++;
    if (tokenExchange(d)) exchanges++;
    for (const r of recordsOf(d)) { if (records.length < 500) records.push(r); else recordPoolCapped = true; }
  }
  // The assembled document is derived from the same events; scanning both would double-count.
  if (!docs.length && assembledDoc && typeof assembledDoc === 'object') {
    const b = mkBudget(o.maxNodes);
    scan(assembledDoc, 0, st, b);
    if (b.hit) truncatedDocs++;
  }
  // Telemetry record statistics (flat scalars of each record plus one nesting level).
  const sigs = new Map();
  const rs = { numbers: 0, strings: 0, booleans: 0, longStrings: 0, tsRecords: 0, tsValues: 0 };
  for (const r of records) {
    const part = createStats();
    scan(r, 0, part, mkBudget(200));
    rs.numbers += part.numbers; rs.strings += part.strings; rs.booleans += part.booleans; rs.longStrings += part.longStrings;
    rs.tsValues += part.ts; if (part.ts > 0) rs.tsRecords++;
    const s = signature(r);
    sigs.set(s, (sigs.get(s) ?? 0) + 1);
  }
  const dominant = sigs.size ? Math.max(...sigs.values()) : 0;
  return { st, records: records.length, rs, dominant, exchanges, truncatedDocs, structureDocsCut: truncatedDocs, recordPoolCapped };
}

// ---- small flat state frames (push-presence) -----------------------------------------------------
function isSmallFlat(doc) {
  if (!isObj(doc)) return false;
  const { entries, more } = boundedEntries(doc, 7);
  const vals = entries.map((e) => e[1]);
  if (more || vals.length === 0 || vals.length > 6) return false;
  return vals.every((v) => v === null || typeof v === 'boolean' || (typeof v === 'number' && !isTimestampNumber(v)) || (typeof v === 'string' && v.length <= 48 && !ISO_TIME.test(v)));
}

// Public helper for later integration, counts only (never content).
//   incrementalText   text provably grows (delta / cumulative snapshot / mapped text / assembler blocks).
//                     This alone is NOT a chat reply: editors, logs and notifications grow too.
//   chatCorroborated  a mapped message component with text, or a typed assistant role frame.
//   strong            incrementalText && chatCorroborated (what chat-reply requires).
//   kinds             how many of {incremental text, mapped message, assistant frame} are present (0-3).
//                     They are derived from the same events: a heuristic tally, not independent proof.
export function streamingEvidence(stream, opts = {}) {
  const o = resolveClassifierOptions(opts);
  const { events, assembled, map } = normalize(stream);
  const { docs } = collectDocs(events, o);
  const f = growthFacts(docs, assembled, map, o);
  const a = analyze(docs, null, o);
  const mappedMessage = mappedMessageComponents(map);
  const frames = a.st.assistantFrames;
  return {
    growthTargets: f.targets, growthSteps: f.steps, mappedTextComponents: f.mapped, assembledTextBlocks: f.blocks,
    mappedMessageComponents: mappedMessage, assistantRoleFrames: frames,
    incrementalText: f.incremental, chatCorroborated: mappedMessage > 0 || frames > 0,
    kinds: [f.incremental, mappedMessage > 0, frames > 0].filter(Boolean).length,
    strong: f.incremental && (mappedMessage > 0 || frames > 0),
    truncated: events.length > o.maxEvents || f.truncatedDocs > 0 || a.truncatedDocs > 0 || a.recordPoolCapped,
  };
}

// ---- detectors: each returns { role, score, features } or null ---------------------------------------
const feat = (feature, count) => ({ feature, count });

function detectReply(f, a, mappedMessage) {
  if (!f.incremental) return null;
  const frames = a.st.assistantFrames;
  const features = [
    feat('delta_growth_targets', f.targets), feat('delta_growth_steps', f.steps),
    feat('mapped_text_components', f.mapped), feat('assembled_text_blocks', f.blocks),
    feat('mapped_message_components', mappedMessage), feat('assistant_role_frames', frames),
  ];
  // Incremental text without chat-specific structure is only a weak hint (editor, log, notification).
  if (mappedMessage === 0 && frames === 0) return { role: 'chat-reply', score: 1, features };
  return { role: 'chat-reply', score: mappedMessage > 0 && frames > 0 ? 3 : 2, features };
}

function detectHistory(a) {
  const { count, roles } = a.st.msg;
  if (count < 2) return null;
  return { role: 'history-load', score: roles.size >= 2 ? 3 : 2, features: [feat('message_entries', count), feat('message_roles_distinct', roles.size)] };
}

function telemetryFacts(a) {
  const { rs, records, dominant } = a;
  const scalars = rs.numbers + rs.strings + rs.booleans;
  const repeated = records >= 3 && dominant / records >= 0.6;
  const numeric = scalars > 0 && rs.numbers / scalars >= 0.4 && rs.longStrings === 0;
  const timed = records > 0 && rs.tsRecords / records >= 0.5;
  return { repeated, numeric, timed };
}

function detectTelemetry(a) {
  const t = telemetryFacts(a);
  if (!t.repeated || !t.numeric) return null;
  return { role: 'telemetry', score: t.timed ? 2 : 1, features: [
    feat('repeated_record_shape', a.dominant), feat('numeric_leaves', a.rs.numbers), feat('timestamp_values', a.rs.tsValues),
  ] };
}

function detectConfig(a, ctx) {
  const { st } = a;
  if (ctx.jsonEvents < 1 || ctx.jsonEvents > 2 || ctx.heartbeats > 0 || ctx.channel) return null;
  const scalars = st.booleans + st.numbers + st.strings;
  const boolDense = st.booleans >= 3 && scalars > 0 && st.booleans / scalars >= 0.3;
  const descriptors = st.descriptorEntries >= 3;
  if (!boolDense && !descriptors) return null;
  return { role: 'config', score: (boolDense ? 2 : 0) + (descriptors ? 1 : 0), features: [
    feat('descriptor_array_entries', st.descriptorEntries), feat('boolean_leaves', st.booleans),
  ] };
}

// Auth needs a typed token-exchange response (credential-shaped token in a token slot + an expiry
// integer in an expiry slot), a successful response when the status is known and a plausible method
// when it is known. Credential-shaped values, masking and redaction counts are weak hints only: with
// no exchange structure they stay at score 1 (unknown). Credential contents are never decoded or emitted.
function detectAuth(a, ctx, summary, o) {
  const { st } = a;
  const redactions = Number(summary.redactions) > 0 ? Math.floor(Number(summary.redactions)) : 0;
  const hints = [feat('credential_shaped_values', st.jwt + st.opaque), feat('masked_credential_values', st.masked), feat('masked_credential_spans', redactions)];
  const hasHint = st.jwt + st.opaque + st.masked + redactions > 0;
  const status = Number(summary.status_code);
  const statusKnown = Number.isFinite(status) && status > 0;
  const statusOk = !statusKnown || (status >= 200 && status < 300);
  const method = typeof summary.method === 'string' ? summary.method.toUpperCase() : null;
  const methodOk = method === null || method === 'POST' || method === 'GET';
  const smallDoc = !Number.isFinite(summary.bytes) || summary.bytes <= o.smallDocBytes;
  const structural = a.exchanges > 0 && ctx.jsonEvents >= 1 && ctx.jsonEvents <= 3 && !ctx.channel && smallDoc && statusOk && methodOk;
  if (structural) {
    const requestSeen = method === 'POST' && statusKnown;
    return { role: 'auth', score: requestSeen ? 3 : 2, features: [feat('token_exchange_structure', a.exchanges), feat('token_exchange_request', requestSeen ? 1 : 0), ...hints] };
  }
  return hasHint ? { role: 'auth', score: 1, features: hints } : null;
}

function detectPresence(a, ctx, smallFlat) {
  if (!ctx.channel || ctx.heartbeats < 2 || smallFlat < 3) return null;
  if (a.st.ts > 0 || a.st.longStrings > 0) return null;
  return { role: 'push-presence', score: 2, features: [feat('small_flat_payloads', smallFlat), feat('heartbeat_events', ctx.heartbeats)] };
}

function detectAsset(summary, ctx) {
  if (ctx.jsonEvents > 0 || ctx.channel) return null;
  const mime = String(summary.mime ?? '').toLowerCase().split(';')[0].trim();
  const mimeHit = ASSET_MIME.test(mime);
  const typeHit = ASSET_RESOURCE_TYPES.has(summary.resourceType);
  if (!mimeHit && !typeHit) return null;
  const body = Math.max(1, Math.floor(Number(summary.chunks) || 0));
  return { role: 'asset', score: mimeHit && typeHit ? 3 : mimeHit ? 2 : 1, features: [
    feat('asset_media_type', mimeHit ? 1 : 0), feat('asset_resource_type', typeHit ? 1 : 0), feat('non_json_body', body),
  ] };
}

// ---- verdict -----------------------------------------------------------------------------------
const orderOf = new Map(EVIDENCE_FEATURES.map((f, i) => [f, i]));
function finish(features) {
  const merged = new Map();
  for (const { feature, count } of features) {
    const n = Math.floor(Number(count));
    if (n > 0) merged.set(feature, Math.max(merged.get(feature) ?? 0, n));
  }
  return [...merged].map(([feature, count]) => ({ feature, count })).sort((a, b) => orderOf.get(a.feature) - orderOf.get(b.feature));
}

function incompleteCapture(summary) {
  return INCOMPLETE_STATUS.has(summary.status)
    || (typeof summary.coverage === 'string' && summary.coverage !== 'observed_from_request_start')
    || Number(summary.eventsOnlyOnDisk) > 0
    || summary.truncatedAtBytes !== undefined;
}

const LEVEL_BY_SCORE = { 2: 'medium', 3: 'high' };
const stepDown = (level) => (level === 'high' ? 'medium' : level === 'medium' ? 'low' : level);

// kv STREAM_ROLES document, built from summary rows that already carry role fields, i.e. the streams of
// StreamReducer.summary({ includeStreamRoles: true }). Pure and deterministic (no clock). Keyed by sid
// only: no join id, message id or DOM link is inferred here. `unknown` rows are kept and explicit.
export function buildStreamRoles(rows, { eventWindow = null } = {}) {
  const list = Array.isArray(rows) ? rows.filter((r) => isObj(r) && r.sid !== undefined) : [];
  if (!list.length) return { schema: STREAM_ROLES_SCHEMA, status: 'no_streams' };
  const byRole = Object.fromEntries(STREAM_ROLES.map((r) => [r, 0]));
  let withheld = 0; let inspectionCut = 0;
  const streams = list.map((r) => {
    const role = STREAM_ROLES.includes(r.role) ? r.role : 'unknown';
    byRole[role]++;
    const roleCoverage = cleanCoverage(r.roleCoverage);
    if (roleCoverage?.withheldRole) withheld++;
    if (roleCoverage?.inspectionCut) inspectionCut++;
    return {
      sid: r.sid,
      role,
      roleConfidence: CONFIDENCE_LEVELS.includes(r.roleConfidence) ? r.roleConfidence : 'none',
      roleEvidence: Array.isArray(r.roleEvidence) ? r.roleEvidence.map((e) => ({ feature: e.feature, count: e.count })) : [],
      roleCoverage,
      eventsOmitted: Number(r.eventsOnlyOnDisk) > 0 ? Number(r.eventsOnlyOnDisk) : 0,
    };
  });
  return {
    schema: STREAM_ROLES_SCHEMA,
    classifier: { id: 'stream-role', version: STREAM_ROLE_CLASSIFIER_VERSION, coverageVersion: COVERAGE_VERSION, options: { ...resolveClassifierOptions() } },
    confidenceScale: STREAM_ROLES_CONFIDENCE_SCALE,
    inputs: { eventWindow, source: 'reducer events + assembled + built-in stream maps', identity: 'sid only; no join ids inferred' },
    streams,
    totals: { streams: streams.length, byRole, unknown: byRole.unknown, withheld, inspectionCut },
  };
}

// One-line receipt entry for a STREAM_ROLES document. "withheld" streams are listed under unknown; the
// suffix says how many of those had a specific role withheld for incomplete inspection.
export function describeStreamRoles(doc) {
  if (!doc || !doc.totals) return doc?.status ?? 'error';
  const parts = STREAM_ROLES.filter((r) => doc.totals.byRole[r] > 0).map((r) => `${doc.totals.byRole[r]} ${r}`);
  const w = Number(doc.totals.withheld) > 0 ? ` (${doc.totals.withheld} specific role withheld: incomplete inspection)` : '';
  return `${doc.totals.streams} streams: ${parts.join(', ')}${w}`;
}

// ---- coverage: what the verdict actually looked at -------------------------------------------------------
// Additive result field. Counts, booleans and enums only. It separates five different things that the
// single `inspection_truncated` evidence count lumps together:
//   eventsReducerOmitted    events the reducer no longer holds (bounded window / keepEvents:false)
//   eventsClassifierSkipped events beyond opts.maxEvents
//   growthDocsCut           documents where a text-growth walker hit a node / depth / array / key cap
//   structureDocsCut        documents where the structure scan (frames, containers, records) hit a cap
//   recordPoolCapped        more than 500 records pooled (only record-based, non-content roles care)
// plus where the evidence came from (source), the stream-map window and assembler use, and an opaque
// binary-structure tally (no decoding here: the protobuf feature contract belongs to the decoder lane).
export const COVERAGE_VERSION = 1;
const COVERAGE_SOURCES = ['events', 'assembled-only', 'summary-only'];
const OPAQUE_DECODERS = new Set(['binary', 'raw', 'protobuf', 'grpc', 'length-prefixed']);
const CONTENT_ROLES = new Set(['chat-reply', 'history-load']);
const nn = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

const BINARY_FRAME_KEYS = ['analyzed', 'corrupt', 'budget', 'incomplete', 'invalid', 'oversize', 'beyondCap'];

// Binary structure coverage from the decoder's compact snapshots (ev.protoFeatures). A snapshot is SUPPORTED
// only when BOTH its schema string and its integer version equal the shared contract constants; anything else
// (an older/newer version, a schema/version that disagree, a malformed object) is UNSUPPORTED and is never
// interpreted: it can only make the stream "opaque". Snapshots are cumulative, so the last supported one
// describes the stream. None of this is a role: it only says how much binary structure was actually analyzed.
//   kind      'structural' = at least one frame was analyzed; 'opaque' = binary but nothing analyzable
//             (undecodable, corrupt, incomplete, unsupported contract, or a binary decoder with no features)
//   complete  true only when every record was analyzed, no budget/size/frame cap was hit and nothing was
//             unsupported; null when there is no binary evidence at all. completeProof is never claimed.
function binaryCoverage(events, docs, summary) {
  let supported = 0; let unsupported = 0; let last = null;
  const versions = new Set();
  for (const e of events) {
    const pf = isObj(e) ? e.protoFeatures : null;
    if (!isObj(pf)) continue;
    if (Number.isInteger(pf.version) && pf.version >= 0 && versions.size < 4) versions.add(pf.version);
    if (pf.schema === PROTO_FEATURES_SCHEMA && pf.version === PROTO_FEATURES_VERSION && isObj(pf.cumulative) && isObj(pf.integrity)) { supported++; last = pf; }
    else unsupported++;
  }
  const frames = Object.fromEntries(BINARY_FRAME_KEYS.map((k) => [k, nn(last?.cumulative?.[k])]));
  const decoderOpaque = !docs.length && OPAQUE_DECODERS.has(summary.decoder);
  let kind = null;
  if (supported > 0) kind = frames.analyzed > 0 ? 'structural' : 'opaque';
  else if (unsupported > 0 || decoderOpaque) kind = 'opaque';
  const notAnalyzed = BINARY_FRAME_KEYS.filter((k) => k !== 'analyzed').reduce((n, k) => n + frames[k], 0);
  const inspectionTruncated = last?.integrity?.inspectionTruncated === true;
  const complete = kind === null ? null : (supported > 0 && unsupported === 0 && notAnalyzed === 0 && !inspectionTruncated && last.integrity.incomplete !== true);
  return { featureEvents: supported, unsupportedEvents: unsupported, versions: [...versions].sort((x, y) => x - y), kind, complete, frames, inspectionTruncated };
}

function baseCoverage({ summary, events, docs, assembled, map, skippedEvents, growthDocsCut, structureDocsCut, recordPoolCapped, incomplete }) {
  const total = Number(summary.events);
  const assembledUsed = !!(assembled && assembled.revisions > 0);
  return {
    version: COVERAGE_VERSION,
    source: events.length > 0 ? 'events' : assembledUsed ? 'assembled-only' : 'summary-only',
    eventsTotal: Number.isFinite(total) && total >= 0 ? Math.floor(total) : null,
    eventsRetained: events.length,
    eventsReducerOmitted: nn(Number(summary.eventsOnlyOnDisk)),
    eventsClassifierSkipped: nn(skippedEvents),
    growthDocsCut: nn(growthDocsCut),
    structureDocsCut: nn(structureDocsCut),
    recordPoolCapped: recordPoolCapped === true,
    mapUsed: !!map,
    mapWindowEvents: map && isObj(map.stats) && Number.isFinite(map.stats.events) ? nn(map.stats.events) : null,
    assembledUsed,
    captureIncomplete: incomplete === true,
    binary: binaryCoverage(events, docs, summary),
    inspectionCut: false,
    fullyInspected: true,
    withheldRole: null,
  };
}

// Any cut that could hide content the verdict depends on. A cap is "relevant" unless the detector that
// would care cannot compete with the winner: the 500-record pool only feeds record-based (non-content)
// detectors, so it does not undermine a chat-reply / history-load verdict. Growth and structure caps are
// treated conservatively as relevant to every role (a skipped region could hold a reply, a message
// container or an assistant frame).
function anyContentCut(c) {
  return c.eventsReducerOmitted > 0 || c.eventsClassifierSkipped > 0 || c.growthDocsCut > 0 || c.structureDocsCut > 0;
}
const relevantCut = (c, role) => anyContentCut(c) || (c.recordPoolCapped && !CONTENT_ROLES.has(role));

// Whitelisting copy used by persisted artifacts and the scoreboard: unknown fields never pass through.
export function cleanCoverage(c) {
  if (!isObj(c)) return null;
  const b = isObj(c.binary) ? c.binary : {};
  return {
    version: Number.isInteger(c.version) ? c.version : COVERAGE_VERSION,
    source: COVERAGE_SOURCES.includes(c.source) ? c.source : 'summary-only',
    eventsTotal: Number.isFinite(c.eventsTotal) ? nn(c.eventsTotal) : null,
    eventsRetained: nn(c.eventsRetained),
    eventsReducerOmitted: nn(c.eventsReducerOmitted),
    eventsClassifierSkipped: nn(c.eventsClassifierSkipped),
    growthDocsCut: nn(c.growthDocsCut),
    structureDocsCut: nn(c.structureDocsCut),
    recordPoolCapped: c.recordPoolCapped === true,
    mapUsed: c.mapUsed === true,
    mapWindowEvents: Number.isFinite(c.mapWindowEvents) ? nn(c.mapWindowEvents) : null,
    assembledUsed: c.assembledUsed === true,
    captureIncomplete: c.captureIncomplete === true,
    binary: {
      featureEvents: nn(b.featureEvents),
      unsupportedEvents: nn(b.unsupportedEvents),
      versions: Array.isArray(b.versions) ? b.versions.filter((v) => Number.isInteger(v) && v >= 0).slice(0, 4) : [],
      kind: b.kind === 'structural' || b.kind === 'opaque' ? b.kind : null,
      complete: b.complete === true ? true : b.complete === false ? false : null,
      frames: Object.fromEntries(BINARY_FRAME_KEYS.map((k) => [k, nn(isObj(b.frames) ? b.frames[k] : 0)])),
      inspectionTruncated: b.inspectionTruncated === true,
    },
    inspectionCut: c.inspectionCut === true,
    fullyInspected: c.fullyInspected === true,
    withheldRole: SPECIFIC_ROLE_SET.has(c.withheldRole) ? c.withheldRole : null,
  };
}
const SPECIFIC_ROLE_SET = new Set(STREAM_ROLES.filter((r) => r !== 'unknown'));

export function classifyStreamRole(stream, opts = {}) {
  const o = resolveClassifierOptions(opts);
  const { summary, events, assembled, map } = normalize(stream);
  const incomplete = incompleteCapture(summary);
  const { docs, heartbeats: eventHeartbeats, channelEvents, skippedEvents } = collectDocs(events, o);
  const heartbeats = events.length === 0 ? Math.floor(Number(summary.heartbeats) || 0) : eventHeartbeats;
  const ctx = {
    jsonEvents: docs.length,
    heartbeats,
    // A push channel is a socket / EventSource / SSE framing. Chunk count (HTTP_STREAMED) is not one.
    channel: summary.kind === 'ws' || Number(summary.esMessages) > 0 || channelEvents > 0 || summary.decoder === 'sse',
  };

  const counts = ['bytes', 'chunks', 'frames', 'events', 'esMessages'].reduce((n, k) => n + (Number(summary[k]) > 0 ? Number(summary[k]) : 0), 0);
  const hasContentSignal = events.length > 0 || (assembled?.revisions > 0) || mappedTextComponents(map) > 0;
  if (counts === 0 && !hasContentSignal) {
    const coverage = baseCoverage({ summary, events, docs, assembled, map, skippedEvents, growthDocsCut: 0, structureDocsCut: 0, recordPoolCapped: false, incomplete });
    return { role: 'unknown', confidence: 'none', evidence: finish([feat('empty_stream', 1), ...(incomplete ? [feat('incomplete_capture', 1)] : [])]), coverage };
  }

  const growth = growthFacts(docs, assembled, map, o);
  const a = analyze(docs, assembled?.doc, o);
  const smallFlat = docs.filter(isSmallFlat).length;
  const telemetry = detectTelemetry(a);
  const candidates = [
    detectReply(growth, a, mappedMessageComponents(map)),
    detectHistory(a),
    // Time-series records are dynamic data: they take precedence over the static-config reading.
    telemetry,
    telemetry && telemetry.score >= 2 ? null : detectConfig(a, ctx),
    detectAuth(a, ctx, summary, o),
    detectPresence(a, ctx, smallFlat),
    detectAsset(summary, ctx),
  ].filter(Boolean);

  // Replies and history reloads legitimately contain credential-like or flat-looking values: when a
  // content role is established, the incidental detectors never compete with it.
  const content = candidates.filter((c) => (c.role === 'chat-reply' || c.role === 'history-load') && c.score >= 2);
  const qualified = (content.length ? content : candidates.filter((c) => c.score >= 2)).sort((x, y) => y.score - x.score);
  const coverage = baseCoverage({
    summary, events, docs, assembled, map, skippedEvents,
    growthDocsCut: growth.truncatedDocs, structureDocsCut: a.structureDocsCut, recordPoolCapped: a.recordPoolCapped, incomplete,
  });
  // `inspection_truncated` = a CLASSIFIER cap was hit somewhere (not role-specific). Events the reducer no
  // longer holds are a separate cause: incomplete_capture + coverage.eventsReducerOmitted.
  const classifierCut = skippedEvents > 0 || growth.truncatedDocs > 0 || a.structureDocsCut > 0 || a.recordPoolCapped;
  const truncated = anyContentCut(coverage) || coverage.recordPoolCapped; // any cut at all, for the unknown cases
  const flags = [
    ...(incomplete ? [feat('incomplete_capture', 1)] : []),
    ...(classifierCut ? [feat('inspection_truncated', skippedEvents + Math.max(growth.truncatedDocs, a.structureDocsCut, a.recordPoolCapped ? 1 : 0) || 1)] : []),
  ];
  // Binary structure is CONTEXT, never a role: counts of analyzed vs not-analyzed protobuf frames. An opaque or
  // incompletely analyzed binary stream stays unknown and is reported as an inspection cut.
  const bin = coverage.binary;
  const binaryNotAnalyzed = BINARY_FRAME_KEYS.filter((k) => k !== 'analyzed').reduce((n, k) => n + bin.frames[k], 0) + bin.unsupportedEvents;
  const binaryFeats = bin.kind === null ? [] : [feat('binary_structural_frames', bin.frames.analyzed), feat('binary_incomplete_frames', binaryNotAnalyzed)];
  const binaryCut = bin.kind !== null && bin.complete === false;
  const base = [...(ctx.jsonEvents > 0 ? [feat('json_events', ctx.jsonEvents)] : []), ...binaryFeats];

  if (qualified.length === 0) {
    const weak = candidates.filter((c) => c.score >= 1);
    coverage.inspectionCut = truncated || binaryCut; coverage.fullyInspected = !(truncated || binaryCut);
    return { role: 'unknown', confidence: 'none', evidence: finish([...base, ...flags, feat(weak.length ? 'weak_evidence_only' : 'no_structural_evidence', 1), ...weak.flatMap((c) => c.features)]), coverage };
  }
  if (qualified.length > 1) {
    coverage.inspectionCut = truncated || binaryCut; coverage.fullyInspected = !(truncated || binaryCut);
    return { role: 'unknown', confidence: 'none', evidence: finish([...base, ...flags, feat('conflicting_role_evidence', qualified.length), ...qualified.flatMap((c) => c.features)]), coverage };
  }
  const top = qualified[0];
  // One role qualified, but part of the stream was not examined: unexamined content could contradict it
  // (a reply next to a message container, an assistant frame hidden by a depth cap, ...). Withhold the
  // specific role instead of labelling it; the candidate stays visible as coverage.withheldRole.
  if (relevantCut(coverage, top.role)) {
    coverage.inspectionCut = true; coverage.fullyInspected = false; coverage.withheldRole = top.role;
    return { role: 'unknown', confidence: 'none', evidence: finish([...base, ...flags, feat('withheld_for_incomplete_inspection', 1), ...top.features]), coverage };
  }
  let confidence = LEVEL_BY_SCORE[top.score];
  if (incomplete) confidence = stepDown(confidence);
  // Cuts that survive to here (the record pool under a content role) do not touch this verdict's inputs.
  coverage.inspectionCut = false; coverage.fullyInspected = true;
  return { role: top.role, confidence, evidence: finish([...base, ...flags, ...top.features]), coverage };
}
