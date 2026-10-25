// Provider families: shared data models that many sites map into (ai-chat, data-table, ...).
// A family is DATA (entities, fields, hints, detection signals); nothing here names a specific
// website, endpoint or selector. Sites join a family through their profile's familyMappings.
//
// Detection is evidence-driven: gatherEvidence() collects everything the detectors may look at
// (wire transports, app protocols, delta dialects, JSON leaf paths, event type names, enum values,
// collections, URL shapes, user actions, rendered DOM), and each family lists weighted signals
// over that evidence. A signal may be negated with `not: true`, carry a negative weight, or be
// listed in the family's `requires` so a family cannot match without it.
import path from 'node:path';
import { TOOL_ROOT } from '../config.mjs';
import { VersionedStore } from '../store/versioned.mjs';
import { select } from '../shapes/extract.mjs';
import { templateUrl } from '../shapes/infer.mjs';
import { STREAMING_TRANSPORTS } from '../replay/reducer.mjs';

export class FamilyStore extends VersionedStore {
  constructor(dir) { super(dir, { builtinDir: path.join(TOOL_ROOT, 'families'), kind: 'family', normalize: (f) => ({ members: [], detect: [], entities: {}, ...f }) }); }

  addMember(name, profileName) {
    const f = this.load(name);
    if (f.members.includes(profileName)) return f;
    return this.save(name, { ...f, members: [...f.members, profileName] }, `member added: ${profileName}`);
  }

  // Register a brand-new family from accepted record rules (user-defined shared model).
  register(name, { description = '', entities = {}, fromProfile, detect = [] } = {}) {
    if (this.has(name)) throw new Error(`Family "${name}" already exists.`);
    return this.save(name, { name, description, members: fromProfile ? [fromProfile] : [], detect, entities }, `registered${fromProfile ? ` from ${fromProfile}` : ''}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Evidence: everything the detectors may look at, gathered once from a reducer (+ optional DOM).
// ---------------------------------------------------------------------------------------------
const ROLEISH = /(^|\.)(role|sender|from|speaker|author)$/i;
const STREAMING_SET = new Set(STREAMING_TRANSPORTS);
const MAX_SAMPLES = 400;
const MAX_COLLECTION_ITEMS = 200;
const DISCRIMINATOR_KEYS = ['type', 'event', 'kind', 'op', 'action', 'name', 'object', 'method', 'topic'];

function leafWalk(v, p, out, depth = 0) {
  if (depth > 9) return;
  if (v === null || typeof v !== 'object') { (out[p] ??= []).length < 50 && out[p].push(v); return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 30)) leafWalk(x, `${p}[*]`, out, depth + 1); return; }
  // Objects keyed by indices ({"0":…,"1":…}) are collections, not fixed fields.
  const keys = Object.keys(v);
  if (keys.length && keys.every((k) => /^\d+(\.\d+)*$/.test(k))) { for (const k of keys.slice(0, 30)) leafWalk(v[k], `${p}[*]`, out, depth + 1); return; }
  for (const [k, x] of Object.entries(v)) leafWalk(x, `${p}.${k}`, out, depth + 1);
}

// Arrays of objects, grouped by the path they live at, with bounded item samples.
function collectArrays(v, p, out, depth = 0) {
  if (depth > 8 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length) {
      const g = out.get(p) ?? { path: p, observations: 0, items: 0, samples: [], fields: new Map() };
      g.observations++; g.items += objs.length;
      for (const o of objs.slice(0, 30)) {
        if (g.samples.length < MAX_COLLECTION_ITEMS) g.samples.push(o);
        for (const k of Object.keys(o)) g.fields.set(k, (g.fields.get(k) ?? 0) + 1);
      }
      out.set(p, g);
    }
    for (const x of v.slice(0, 20)) collectArrays(x, `${p}[*]`, out, depth + 1);
    return;
  }
  for (const [k, x] of Object.entries(v)) collectArrays(x, `${p}.${k}`, out, depth + 1);
}

function discriminatorsOf(json) {
  const out = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const k of DISCRIMINATOR_KEYS) { const v = json[k]; if (typeof v === 'string' && v.length <= 64) out.push(v); }
  return out;
}

export function gatherEvidence(reducer, { domInspect = null, domTurns = null, phases = null } = {}) {
  // Optional per-sub-phase wall time (the caller's phase object; never part of the returned evidence).
  let tp = phases ? performance.now() : 0;
  const mark = phases ? (k) => { const n = performance.now(); phases[k] = (phases[k] ?? 0) + (n - tp); tp = n; } : null;
  const summary = reducer.summary();
  mark?.('e.summary');
  const leaves = {};
  const assembled = [];
  const samples = [];
  const arrays = new Map();
  const eventTypeCounts = new Map();
  const appProtocols = new Set();
  const transports = new Set();
  const transportDetails = new Set();
  const deltaDialects = new Set();
  const channels = new Set();
  const frameTypes = new Set();
  const methods = new Set();
  const statuses = new Set();
  const mimes = new Set();
  const paths = [];
  const queryKeys = new Set();
  const requestJsonKeys = new Set();
  let heartbeats = 0, graphql = null, rpc = null, eventBytes = 0, eventCount = 0;

  for (const s of reducer.streams.values()) {
    for (const e of s._events ?? []) {
      const j = e.jsonNested?.json !== undefined ? e.jsonNested.json : e.json;
      if (j !== undefined) {
        leafWalk(j, '$', leaves);
        if (samples.length < MAX_SAMPLES) samples.push(j);
        collectArrays(j, '$', arrays);
        for (const d of discriminatorsOf(j)) eventTypeCounts.set(d, (eventTypeCounts.get(d) ?? 0) + 1);
      }
      if (typeof e.event === 'string' && e.event && e.event !== 'message') eventTypeCounts.set(e.event, (eventTypeCounts.get(e.event) ?? 0) + 1);
      if (typeof e.frameType === 'string') { frameTypes.add(e.frameType); eventTypeCounts.set(e.frameType, (eventTypeCounts.get(e.frameType) ?? 0) + 1); }
      if (e.protocol) appProtocols.add(e.protocol);
      if (e.heartbeat) heartbeats++;
      if (e.channel !== undefined && e.channel !== null) channels.add(String(e.channel));
      eventCount++;
      eventBytes += (typeof e.text === 'string' ? e.text.length : 0) || (e.size ?? 0);
    }
    mark?.('e.eventWalk');
    if (s._delta?.revisions > 0 && s._delta.doc && typeof s._delta.doc === 'object') {
      leafWalk(s._delta.doc, '$', leaves);
      collectArrays(s._delta.doc, '$', arrays);
      const texts = s._delta.texts(1);
      assembled.push({ sid: s.sid, endpoint: `${s.method ?? 'GET'} ${templateUrl(s.url)}`, url: s.url, doc: s._delta.doc, revisions: s._delta.revisions, longest: texts[0]?.text?.length ?? 0, status: s.status, startedT: s.startedT, blocks: s._delta.blocks?.().length ?? 0 });
    }
    mark?.('e.deltaWalk');
    for (const d of s._delta?.detected ?? []) deltaDialects.add(d);
    if (s.appProtocol) appProtocols.add(s.appProtocol);
    if (s.graphql) graphql = s.graphql;
    if (s.rpc) rpc = s.rpc;
    for (const k of s.requestJsonKeys ?? []) requestJsonKeys.add(k);
  }

  for (const s of summary.streams) {
    transports.add(s.transport);
    if (s.transportDetail) transportDetails.add(s.transportDetail);
    if (s.method) methods.add(s.method);
    if (s.status_code !== undefined && s.status_code !== null) statuses.add(Number(s.status_code));
    if (s.mime) mimes.add(String(s.mime).split(';')[0]);
    try {
      const u = new URL(s.url);
      paths.push(`${u.pathname}`);
      for (const k of u.searchParams.keys()) queryKeys.add(k.toLowerCase());
    } catch { if (s.url) paths.push(String(s.url)); }
  }

  mark?.('e.summaryStreams');
  const roleValues = new Set();
  for (const [p, vals] of Object.entries(leaves)) if (ROLEISH.test(p)) for (const v of vals) if (typeof v === 'string' && v.length < 24) roleValues.add(v.toLowerCase());
  for (const t of domTurns ?? []) if (t.role) roleValues.add(String(t.role).toLowerCase());
  const fieldNames = new Set(Object.keys(leaves).map((p) => p.split('.').pop().replace(/\[\*\]$/, '')));
  // Numeric fields that change across observations (dashboards, tickers).
  const numericChanging = Object.entries(leaves).filter(([, vals]) => vals.length >= 3 && vals.every((v) => typeof v === 'number') && new Set(vals).size > 1).map(([p]) => p);
  // Small-cardinality string fields: the enum vocabulary a family can key off.
  const enumsByField = new Map();
  for (const [p, vals] of Object.entries(leaves)) {
    const strs = vals.filter((v) => typeof v === 'string' && v.length <= 32);
    if (strs.length < 2) continue;
    const distinct = new Set(strs.map((s) => s.toLowerCase()));
    if (distinct.size <= 12) {
      const name = p.split('.').pop().replace(/\[\*\]$/, '').toLowerCase();
      const set = enumsByField.get(name) ?? new Set();
      for (const d of distinct) set.add(d);
      enumsByField.set(name, set);
    }
  }
  mark?.('e.leafScan');
  const collections = [...arrays.values()].map((g) => ({
    path: g.path, observations: g.observations, items: g.items,
    avgItems: +(g.items / Math.max(1, g.observations)).toFixed(1),
    fields: [...g.fields.keys()], samples: g.samples,
  })).sort((a, b) => b.items - a.items);

  const textLength = domInspect?.textLength ?? 0;
  const longestAssembled = assembled.reduce((a, x) => Math.max(a, x.longest), 0);
  const hasStreaming = summary.streams.some((s) => STREAMING_SET.has(s.transport));
  mark?.('e.derive');

  return {
    summary, leaves, assembled, roleValues, fieldNames, numericChanging,
    actions: reducer.actions ?? [], domInspect, domTurns: domTurns ?? [], streams: summary.streams,
    // --- additions (all optional for existing signals) ---
    samples, collections, transports, transportDetails, appProtocols, deltaDialects,
    eventTypeCounts, eventTypes: new Set(eventTypeCounts.keys()), channels, frameTypes,
    methods, statuses, mimes, paths, queryKeys, requestJsonKeys, enumsByField,
    heartbeats, graphql, rpc, hasStreaming, textLength, longestAssembled,
    eventCount, avgEventBytes: eventCount ? Math.round(eventBytes / eventCount) : 0,
    totals: summary.totals ?? {},
  };
}

// ---------------------------------------------------------------------------------------------
// Signals. Each returns a human-readable reason string when it fires, or null.
// ---------------------------------------------------------------------------------------------
const lower = (x) => String(x ?? '').toLowerCase();
const anyFieldName = (ev, names) => {
  const have = [...ev.fieldNames].map(lower);
  for (const n of names) {
    const want = lower(n);
    const hit = have.find((h) => h === want || h.endsWith('_' + want) || h.startsWith(want + '_') || h === want.replace(/_/g, ''));
    if (hit) return hit;
  }
  return null;
};
const allFieldGroups = (ev, groups) => {
  const have = [...ev.fieldNames].map(lower);
  const found = [];
  for (const alts of groups) {
    const hit = alts.split('|').map(lower).find((a) => have.some((n) => n === a || n.endsWith('_' + a) || n.startsWith(a + '_')));
    if (!hit) return null;
    found.push(hit);
  }
  return found;
};
const matchesAny = (set, wanted) => { for (const w of wanted ?? []) if (set?.has(w)) return w; return null; };

const SIGNALS = {
  role_pair: (ev, s) => { const hit = s.pairs.find(([a, b]) => ev.roleValues.has(a) && ev.roleValues.has(b)); return hit ? `roles ${hit.join(' and ')}` : null; },
  streaming_text: (ev, s) => { const a = ev.assembled.find((x) => x.revisions >= (s.minRevisions ?? 5) && x.longest >= (s.minChars ?? 20)); return a ? `${a.endpoint}: ${a.revisions} revisions building ${a.longest} chars` : null; },
  field_name: (ev, s) => { const n = s.names.find((x) => ev.fieldNames.has(x)); return n ? `field "${n}"` : null; },
  input_then_stream: (ev) => {
    for (const a of ev.actions) {
      if (!['enter', 'click', 'submit'].includes(a.kind)) continue;
      const st = ev.streams.find((x) => x.startedT >= a.t && x.startedT <= a.t + 3000 && STREAMING_SET.has(x.transport));
      if (st) return `${a.kind}${a.target?.label ? ` “${a.target.label.slice(0, 30)}”` : ''} started ${st.transport.toLowerCase()}`;
    }
    return null;
  },
  dom_role_turns: (ev) => { const roles = new Set(ev.domTurns.map((t) => t.role)); return roles.size >= 2 ? `${ev.domTurns.length} turns with roles ${[...roles].join(', ')}` : null; },
  dom_table_or_grid: (ev) => { const p = ev.domInspect?.proposals ?? []; const t = p.find((x) => x.kind === 'table' && x.rows >= 2); const g = (ev.domInspect?.a11y?.roles ?? {}); return t ? `table ${t.rows}×${t.columns}` : (g.grid || g.table) ? 'grid role in accessibility tree' : null; },
  numeric_updates: (ev) => (ev.numericChanging.length ? `${ev.numericChanging.length} changing numeric field(s), e.g. ${ev.numericChanging[0].replace(/^\$\./, '')}` : null),
  collection: (ev, s) => {
    const min = s.minItems ?? 3;
    const best = (ev.collections ?? []).find((c) => c.fields.length >= 2 && c.items >= min);
    const dom = (ev.domInspect?.proposals ?? []).find((x) => x.kind === 'collection' && x.count >= min);
    if (best) return `records at ${best.path.replace(/^\$\.?/, '') || 'root'} (${best.items} items × ${best.fields.length} fields)`;
    if (dom) return `page list of ${dom.count} items`;
    // Fall back to the leaf-path shape used before collections were gathered.
    const arr = Object.keys(ev.leaves).filter((p) => /\[\*\]\.[^.[\]]+$/.test(p));
    return arr.length >= 2 ? `repeated records at ${arr[0].replace(/^\$\.?/, '')}` : null;
  },
  collection_with: (ev, s) => { const found = allFieldGroups(ev, s.fields); return found ? `fields ${found.join(', ')}` : null; },
  pagination: (ev) => {
    const by = new Map();
    for (const s of ev.streams) {
      try { const u = new URL(s.url); const k = `${u.host}${u.pathname}`; const pv = ['page', 'p', 'offset', 'cursor', 'after', 'start', 'skip', 'before'].map((n) => u.searchParams.get(n)).find((x) => x !== null); if (pv !== undefined) { if (!by.has(k)) by.set(k, new Set()); by.get(k).add(pv); } } catch { /* */ }
    }
    const hit = [...by].find(([, set]) => set.size >= 2);
    return hit ? `${hit[0]} fetched with ${hit[1].size} different page values` : null;
  },
  scroll_then_fetch: (ev) => {
    const sc = ev.actions.filter((a) => a.kind === 'scroll');
    const hit = sc.find((a) => ev.streams.some((x) => x.startedT >= a.t - 300 && x.startedT <= a.t + 2500 && x.policy === 'body'));
    return hit ? 'a request followed scrolling' : null;
  },
  form_steps: (ev) => { const steps = ev.actions.filter((a) => ['click', 'submit'].includes(a.kind) && /next|continue|submit|confirm|finish|done|step|send/i.test(a.target?.label ?? '')); return steps.length >= 2 ? `${steps.length} step actions (${[...new Set(steps.map((a) => a.target.label.slice(0, 16)))].join(', ')})` : null; },
  submit_then_request: (ev) => { const a = ev.actions.find((x) => (x.kind === 'submit' || (x.kind === 'click' && /submit|next|continue|send|save/i.test(x.target?.label ?? ''))) && ev.streams.some((s) => s.startedT >= x.t && s.startedT <= x.t + 2000 && s.method === 'POST')); return a ? `“${a.target?.label ?? a.kind}” sent a POST` : null; },
  dom_inputs: (ev, s) => { const i = (ev.domInspect?.proposals ?? []).find((x) => x.kind === 'inputs'); return i && i.count >= (s.minInputs ?? 3) ? `${i.count} inputs` : null; },
  headings_outline: (ev, s) => { const h = (ev.domInspect?.proposals ?? []).find((x) => x.kind === 'headings'); return h && h.count >= (s.minHeadings ?? 2) ? `${h.count} headings` : null; },
  media: (ev) => { const m = (ev.domInspect?.proposals ?? []).find((x) => x.kind === 'media'); return m && m.count ? `${m.count} media item(s)` : null; },
  static_long_text: (ev) => { const len = ev.textLength ?? ev.domInspect?.textLength ?? 0; return !ev.hasStreaming && len > 800 ? `${len} chars of page text, no streaming` : null; },

  // --- wire-level signals -------------------------------------------------------------------
  transport: (ev, s) => {
    const want = s.any ?? s.transports ?? (s.name ? [s.name] : []);
    const hit = matchesAny(ev.transports, want) ?? matchesAny(ev.transportDetails, want);
    return hit ? `${hit} stream observed` : null;
  },
  streaming_transport: (ev) => (ev.hasStreaming ? `${[...ev.transports].filter((t) => STREAMING_SET.has(t)).join(', ')} observed` : null),
  app_protocol: (ev, s) => { const hit = matchesAny(ev.appProtocols, s.names ?? s.any ?? []); return hit ? `${hit} frames on the socket` : null; },
  heartbeat: (ev, s) => (ev.heartbeats >= (s.minCount ?? 3) ? `${ev.heartbeats} heartbeat/keepalive frames` : null),
  delta_dialect: (ev, s) => { const hit = matchesAny(ev.deltaDialects, s.any ?? s.names ?? []); return hit ? `content assembled from ${hit} operations` : null; },
  channels: (ev, s) => (ev.channels.size >= (s.minChannels ?? 2) ? `${ev.channels.size} distinct channels/topics` : null),
  url_path: (ev, s) => {
    for (const pat of s.patterns ?? []) {
      let re; try { re = new RegExp(pat, 'i'); } catch { continue; }
      const hit = (ev.paths ?? []).find((p) => re.test(p));
      if (hit) return `request path ${hit}`;
    }
    return null;
  },
  query_key: (ev, s) => { const hit = (s.names ?? []).map(lower).find((n) => ev.queryKeys.has(n)); return hit ? `query parameter "${hit}"` : null; },
  method_used: (ev, s) => { const hit = (s.methods ?? []).find((m) => ev.methods.has(m)); return hit ? `${hit} requests observed` : null; },
  status_seen: (ev, s) => { const hit = (s.codes ?? []).find((c) => ev.statuses.has(Number(c))); return hit ? `HTTP ${hit} response observed` : null; },
  mime_seen: (ev, s) => { const hit = (s.types ?? []).find((m) => [...ev.mimes].some((x) => x.includes(m))); return hit ? `content type ${hit}` : null; },
  graphql_api: (ev) => {
    if (ev.graphql) return `GraphQL ${ev.graphql} sent`;
    if (ev.appProtocols.has('graphql-ws')) return 'GraphQL subscriptions over WebSocket';
    if ((ev.paths ?? []).some((p) => /\/graphql/i.test(p))) return 'a /graphql endpoint';
    if (ev.requestJsonKeys?.has('query') && ev.requestJsonKeys?.has('variables')) return 'query + variables request body';
    return null;
  },
  rpc_envelope: (ev) => {
    if (ev.rpc) return `${ev.rpc} envelopes`;
    if (ev.appProtocols.has('json-rpc')) return 'JSON-RPC frames';
    if (ev.transportDetails?.has('GRPC')) return 'gRPC message framing';
    if (ev.fieldNames.has('jsonrpc')) return 'jsonrpc field in payloads';
    return null;
  },
  event_type: (ev, s) => {
    const names = (s.names ?? []).map(lower);
    for (const [t, n] of ev.eventTypeCounts ?? []) {
      const lt = lower(t);
      if (names.some((x) => lt === x || lt.includes(x))) return `event type "${t}" (${n}×)`;
    }
    return null;
  },
  event_type_variety: (ev, s) => (ev.eventTypeCounts && ev.eventTypeCounts.size >= (s.minTypes ?? 4) ? `${ev.eventTypeCounts.size} distinct event types` : null),
  enum_field: (ev, s) => {
    const set = ev.enumsByField?.get(lower(s.field));
    if (!set) return null;
    const hits = (s.values ?? []).map(lower).filter((v) => set.has(v));
    return hits.length >= (s.minValues ?? 1) ? `${s.field} ∈ {${hits.join(', ')}}` : null;
  },
  many_small_updates: (ev, s) => (ev.eventCount >= (s.minEvents ?? 50) && ev.avgEventBytes > 0 && ev.avgEventBytes <= (s.maxAvgBytes ?? 400) ? `${ev.eventCount} small updates (avg ${ev.avgEventBytes} B)` : null),
  cursor_pagination: (ev) => {
    const n = anyFieldName(ev, ['cursor', 'next_cursor', 'end_cursor', 'page_info', 'has_more', 'next_page_token', 'continuation']);
    if (n) return `cursor field "${n}" in payloads`;
    const q = ['cursor', 'after', 'before', 'page_token', 'continuation'].find((x) => ev.queryKeys.has(x));
    return q ? `cursor query parameter "${q}"` : null;
  },
  timeseries: (ev, s) => {
    if (ev.numericChanging.length < (s.minFields ?? 1)) return null;
    const t = anyFieldName(ev, ['timestamp', 'ts', 'time', 'at', 'updated_at', 'date', 'epoch']);
    return t ? `${ev.numericChanging.length} changing numeric field(s) alongside "${t}"` : null;
  },
  nested_blocks: (ev, s) => {
    const c = (ev.collections ?? []).find((x) => {
      const f = x.fields.map(lower);
      return f.includes('type') && (f.includes('text') || f.includes('content') || f.includes('value')) && x.items >= (s.minItems ?? 2);
    });
    if (c) return `typed content blocks at ${c.path.replace(/^\$\.?/, '')}`;
    const blocky = ev.assembled.find((a) => (a.blocks ?? 0) >= (s.minItems ?? 2));
    return blocky ? `${blocky.blocks} indexed content blocks assembled` : null;
  },
  tool_calls: (ev) => {
    const n = anyFieldName(ev, ['tool_use', 'tool_call', 'tool_calls', 'function_call', 'tool_result', 'tool_name']);
    if (n) return `tool/function call field "${n}"`;
    const t = [...(ev.eventTypeCounts?.keys() ?? [])].find((x) => /tool|function_call/i.test(x));
    return t ? `event type "${t}"` : null;
  },
  citations: (ev) => {
    const g = allFieldGroups(ev, ['citation|citations|source|sources|reference|references', 'url|uri|href|link']);
    return g ? `citation fields ${g.join(' + ')}` : null;
  },
  search_query: (ev, s) => {
    const q = ['q', 'query', 'search', 'term', 'keyword', 'kw'].find((x) => ev.queryKeys.has(x)) ?? anyFieldName(ev, ['query', 'search_query', 'searchterm', 'term', 'keywords']);
    if (!q) return null;
    const results = (ev.collections ?? []).find((c) => c.items >= (s.minResults ?? 3));
    return results ? `search term "${q}" with ${results.items} result records` : `search term "${q}"`;
  },
  media_fields: (ev) => {
    const n = anyFieldName(ev, ['duration', 'duration_ms', 'bitrate', 'codec', 'resolution', 'playback_url', 'hls', 'dash', 'manifest', 'poster', 'thumbnail_url']);
    if (n) return `media field "${n}"`;
    const m = [...ev.mimes].find((x) => /^(video|audio)\//.test(x) || /mpegurl|dash\+xml|mp2t|mp4/i.test(x));
    return m ? `media content type ${m}` : null;
  },
  notification_shape: (ev) => {
    const n = anyFieldName(ev, ['unread', 'unread_count', 'read_at', 'seen', 'seen_at', 'notification', 'notification_id', 'badge']);
    return n ? `notification field "${n}"` : null;
  },
  presence_shape: (ev) => {
    const n = anyFieldName(ev, ['presence', 'online', 'is_online', 'typing', 'is_typing', 'cursor', 'selection', 'awareness', 'last_seen', 'participants']);
    if (n) return `presence field "${n}"`;
    const t = [...(ev.eventTypeCounts?.keys() ?? [])].find((x) => /presence|typing|cursor|awareness|join|leave/i.test(x));
    return t ? `presence event "${t}"` : null;
  },
  bidirectional_frames: (ev, s) => {
    const ws = ev.streams.filter((x) => x.kind === 'ws');
    const hit = ws.find((x) => (x.frames ?? 0) >= (s.minFrames ?? 4));
    if (!hit) return null;
    const dirs = new Set();
    for (const st of ev.summary.streams) if (st.kind === 'ws' && st.frameTypes) for (const f of st.frameTypes) dirs.add(f);
    return `${hit.frames} socket frames exchanged${dirs.size ? ` (${[...dirs].slice(0, 4).join(', ')})` : ''}`;
  },
  long_poll: (ev, s) => {
    const by = new Map();
    for (const st of ev.streams) {
      if (!st.durationMs || st.durationMs < (s.minDurationMs ?? 5000)) continue;
      const k = `${st.method ?? 'GET'} ${templateUrl(st.url)}`;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    const hit = [...by].find(([, n]) => n >= (s.minRequests ?? 2));
    return hit ? `${hit[0]} held open ${hit[1]} times` : null;
  },
  identity_graph: (ev, s) => {
    const parents = ['parent_id', 'conversation_id', 'thread_id', 'channel_id', 'board_id', 'project_id', 'owner_id', 'item_id', 'post_id'];
    const hit = parents.filter((p) => anyFieldName(ev, [p]));
    return hit.length >= (s.minLinks ?? 1) ? `parent reference field(s) ${hit.join(', ')}` : null;
  },
  auth_gated: (ev) => { const hit = [401, 403].find((c) => ev.statuses.has(c)); return hit ? `HTTP ${hit} seen (content is account-scoped)` : null; },
  text_length: (ev, s) => {
    const len = Math.max(ev.textLength ?? 0, ev.longestAssembled ?? 0);
    return len >= (s.minChars ?? 500) ? `${len} chars of text content` : null;
  },
};

export function signalNames() { return Object.keys(SIGNALS).sort(); }

export function detectFamilies(families, evidence) {
  const out = [];
  const rawOf = new WeakMap();
  for (const f of families) {
    const hits = [];
    const missing = [];
    let score = 0;
    let maxPositive = 0;
    for (const s of f.detect ?? []) {
      const fn = SIGNALS[s.signal];
      if (!fn) { missing.push({ signal: s.signal, label: s.label, reason: 'unknown_signal' }); continue; }
      const weight = s.weight ?? 0;
      if (weight > 0) maxPositive += weight;
      let why = null;
      try { why = fn(evidence, s); } catch { why = null; }
      const fired = s.not ? !why : !!why;
      if (fired) { score += weight; hits.push({ signal: s.signal, label: s.label, why: s.not ? (s.whyNot ?? `no ${s.signal} observed`) : why, weight }); }
      else missing.push({ signal: s.signal, label: s.label });
    }
    const hitNames = new Set(hits.map((h) => h.signal));
    // `requires` = every listed signal must fire. `requiresAny` = at least one must fire.
    // Both exist so a family can state its non-negotiable shape instead of relying on weights.
    const unmet = (f.requires ?? []).filter((r) => !hitNames.has(r));
    const anyList = f.requiresAny ?? [];
    const anyUnmet = anyList.length && !anyList.some((r) => hitNames.has(r));
    const raw = Math.max(0, score);
    const final = unmet.length || anyUnmet ? 0 : Math.min(1, raw);
    const max = maxPositive || 1;
    const rec = { family: f.name, score: +final.toFixed(2), coverage: +(raw / max).toFixed(2), evidence: hits };
    if (missing.length) rec.missing = missing.slice(0, 8);
    if (unmet.length) rec.unmetRequirements = unmet;
    if (anyUnmet) rec.unmetRequiresAny = anyList;
    if (f.minScore !== undefined && final < f.minScore) rec.belowMinScore = f.minScore;
    out.push(rec);
    rawOf.set(rec, final > 0 ? raw : 0);
  }
  // The score is capped at 1, so several families can saturate. Break such ties by the uncapped
  // evidence weight (a feed with pagination + scroll + items outweighs a page that merely has long text),
  // then by declaration order (Array.sort is stable).
  return out.sort((a, b) => b.score - a.score || rawOf.get(b) - rawOf.get(a));
}

// ---------------------------------------------------------------------------------------------
// Mapping proposals: rank observed JSON paths for each canonical field of an entity.
// ---------------------------------------------------------------------------------------------
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[A-Za-z0-9_-]{10,}$/i;
const typeScore = (spec, vals) => {
  const v = vals.filter((x) => x !== null && x !== undefined);
  if (!v.length) return 0;
  const strs = v.filter((x) => typeof x === 'string');
  switch (spec.type) {
    case 'id': return strs.length === v.length && strs.every((x) => UUIDISH.test(x)) ? 1 : (v.every((x) => typeof x === 'number') ? 0.6 : 0.3);
    case 'enum': return strs.length === v.length ? (spec.valueHints?.some((h) => strs.map((s) => s.toLowerCase()).includes(h)) ? 1 : 0.3) : 0;
    case 'text': return strs.length ? Math.min(1, 0.3 + (strs.reduce((a, s) => a + s.length, 0) / strs.length) / 60) : 0;
    case 'string': return strs.length === v.length ? 0.8 : 0.2;
    case 'number': return v.every((x) => typeof x === 'number') ? 1 : 0;
    case 'boolean': return v.every((x) => typeof x === 'boolean') ? 1 : 0;
    case 'time': return v.every((x) => (typeof x === 'number' && ((x > 1e9 && x < 4.2e9) || (x > 1e12 && x < 4.2e12))) || (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x))) ? 1 : 0;
    case 'url': return strs.length === v.length && strs.every((x) => /^(https?:)?\/\//.test(x) || x.startsWith('/')) ? 1 : 0;
    default: return 0.3;
  }
};
const nameScore = (spec, p, fieldName) => {
  const clean = p.replace(/^\$\.?/, '').replace(/\[\*\]/g, '');
  const last = clean.split('.').pop();
  const names = spec.names ?? [fieldName];
  let best = 0;
  for (const n of names) {
    if (clean === n || clean.endsWith('.' + n)) best = Math.max(best, n.includes('.') ? 1 : 0.9);
    else if (last === n) best = Math.max(best, 0.85);
    else if (last.toLowerCase() === n.toLowerCase().replace(/_/g, '')) best = Math.max(best, 0.7);
    else if (last.toLowerCase().includes(n.toLowerCase())) best = Math.max(best, 0.4);
  }
  return best;
};

export function proposeMapping(entitySpec, samples) {
  const leaves = {};
  for (const s of samples) leafWalk(s, '$', leaves);
  const fields = {};
  for (const [name, spec] of Object.entries(entitySpec.fields ?? {})) {
    if (spec.type === 'blocks') continue;
    const cands = [];
    for (const [p, vals] of Object.entries(leaves)) {
      const ns = nameScore(spec, p, name);
      if (ns === 0 && spec.type !== 'text') continue;
      const ts = typeScore(spec, vals);
      if (ts === 0) continue;
      let score = ns * 0.6 + ts * 0.4;
      if (spec.prefer === 'longest' && spec.type === 'text') score += Math.min(0.3, (vals.filter((v) => typeof v === 'string').reduce((a, v) => a + v.length, 0) / Math.max(1, samples.length)) / 2000);
      if (ns === 0) score *= 0.5;
      cands.push({ path: p, score: +score.toFixed(2), example: typeof vals[0] === 'string' ? vals[0].slice(0, 60) : vals[0] });
    }
    cands.sort((a, b) => b.score - a.score);
    if (cands.length) fields[name] = { path: cands[0].path, score: cands[0].score, example: cands[0].example, alternatives: cands.slice(1, 5), ...(spec.join !== undefined || cands[0].path.includes('[*]') ? { join: spec.join ?? '' } : {}), ...(spec.normalize ? { normalize: spec.normalize } : {}) };
  }
  const required = Object.entries(entitySpec.fields ?? {}).filter(([, s]) => s.required).map(([n]) => n);
  const confidence = required.length ? required.reduce((a, n) => a + (fields[n]?.score ?? 0), 0) / required.length : Object.values(fields).reduce((a, f) => a + f.score, 0) / Math.max(1, Object.keys(fields).length);
  const missing = required.filter((n) => !fields[n]);
  return { fields, confidence: +confidence.toFixed(2), missing };
}

// Apply a mapping to one source object -> canonical record (with provenance added by caller).
export function applyMapping(mapping, obj) {
  const rec = {};
  for (const [name, m] of Object.entries(mapping.fields ?? {})) {
    if (!m || m.exclude) continue;
    let vals = select(obj, m.path);
    if (m.normalize) vals = vals.map((v) => (typeof v === 'string' ? (m.normalize[v.toLowerCase()] ?? v.toLowerCase()) : v));
    let v = vals.length <= 1 ? vals[0] : (m.join !== undefined && vals.every((x) => typeof x === 'string') ? vals.join(m.join) : vals);
    if (m.type === 'number' && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
    rec[m.as ?? name] = v;
  }
  return rec;
}

// Choose which assembled docs / samples feed a family entity, and propose the mapping.
// Three evidence sources are considered for every entity:
//   assembled   reconstructed documents, grouped by endpoint (streamed content)
//   event       repeated records inside decoded events (collections)
//   dom-turns   rendered conversation turns (message entities only)
export function proposeFamilyLink(family, evidence) {
  const proposals = [];
  if (!family) return proposals;

  // --- message entity: streamed documents and rendered turns (unchanged behaviour) ---
  if (family.name === 'ai-chat' || family.entities?.message) {
    const spec = family.entities?.message;
    if (spec) {
      const byEndpoint = new Map();
      for (const a of evidence.assembled) { if (a.longest < 1) continue; if (!byEndpoint.has(a.endpoint)) byEndpoint.set(a.endpoint, []); byEndpoint.get(a.endpoint).push(a.doc); }
      for (const [endpoint, docs] of byEndpoint) {
        const m = proposeMapping(spec, docs);
        if (m.fields.text && m.confidence >= 0.4) proposals.push({ entity: 'message', source: { kind: 'assembled', endpoint: endpointPattern(endpoint) }, endpointLabel: endpoint, samples: docs.length, ...m });
      }
      if (evidence.domTurns.length) proposals.push({ entity: 'message', source: { kind: 'dom-turns' }, endpointLabel: 'rendered page turns', samples: evidence.domTurns.length, fields: { role: { path: '$.role', score: 0.9 }, text: { path: '$.text', score: 0.9 }, id: { path: '$.id', score: 0.6 }, blocks: { path: '$.blocks', score: 0.9 } }, confidence: 0.85, missing: [] });
    }
  }

  // --- every other entity: repeated records inside decoded events ---
  for (const [entity, spec] of Object.entries(family.entities ?? {})) {
    if (spec.embeddedIn) continue;                       // content blocks live inside their parent
    if (entity === 'message' && (family.name === 'ai-chat' || family.entities?.message)) continue;
    const candidates = [];
    for (const c of evidence.collections ?? []) {
      if (!c.samples?.length) continue;
      const m = proposeMapping(spec, c.samples);
      if (!Object.keys(m.fields).length || m.confidence < 0.4) continue;
      candidates.push({
        entity, source: { kind: 'event', itemsPath: c.path.endsWith('[*]') ? c.path : `${c.path}[*]` },
        endpointLabel: `records at ${c.path.replace(/^\$\.?/, '') || 'root'}`,
        samples: c.samples.length, ...m,
      });
    }
    // Whole-event records (one object per event, not a collection).
    if (!candidates.length && (evidence.samples ?? []).length >= 3) {
      const m = proposeMapping(spec, evidence.samples);
      if (Object.keys(m.fields).length && m.confidence >= 0.5) {
        candidates.push({ entity, source: { kind: 'event', itemsPath: '$' }, endpointLabel: 'decoded events', samples: evidence.samples.length, ...m });
      }
    }
    // Assembled documents, for entities that describe a whole page/document.
    if (!candidates.length && evidence.assembled.length) {
      const byEndpoint = new Map();
      for (const a of evidence.assembled) { if (!byEndpoint.has(a.endpoint)) byEndpoint.set(a.endpoint, []); byEndpoint.get(a.endpoint).push(a.doc); }
      for (const [endpoint, docs] of byEndpoint) {
        const m = proposeMapping(spec, docs);
        if (Object.keys(m.fields).length && m.confidence >= 0.5) candidates.push({ entity, source: { kind: 'assembled', endpoint: endpointPattern(endpoint) }, endpointLabel: endpoint, samples: docs.length, ...m });
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    if (candidates[0]) proposals.push(candidates[0]);
  }

  return proposals.sort((a, b) => b.confidence - a.confidence);
}

export function endpointPattern(endpoint) {
  const p = endpoint.replace(/^[A-Z]+ /, '');
  return p.split('{id}').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/?#]+');
}

// Family records produced by ONE decoded event, for 'event' mappings. derive calls this for every
// event while streaming, so coverage does not depend on the reducer's bounded event window.
const _endpointRe = new WeakMap();
export function familyRecordsFromEvent(profile, ev, stream, session) {
  const out = [];
  if (!profile?.family || ev === undefined || ev === null) return out;
  const json = ev.jsonNested?.json !== undefined ? ev.jsonNested.json : ev.json;
  if (json === undefined) return out;
  for (const fm of profile.familyMappings ?? []) {
    if (fm.source?.kind !== 'event') continue;
    if (fm.source.endpoint) {
      let re = _endpointRe.get(fm);
      if (!re) { re = new RegExp(fm.source.endpoint); _endpointRe.set(fm, re); }
      if (!re.test(templateUrl(stream?.url))) continue;
    }
    if (fm.source.eventType && !matchesEventType(fm.source.eventType, ev, json)) continue;
    for (const item of select(json, fm.source.itemsPath ?? '$')) {
      if (item && typeof item === 'object') out.push({ dataset: `family-${profile.family}-${fm.entity}`, record: { ...applyMapping(fm, item), _family: profile.family, _entity: fm.entity, _provenance: { site: profile.name, session: session?.id, source: 'network', sid: ev.sid, seq: ev.seq, t: ev.t } } });
    }
  }
  return out;
}

function matchesEventType(wanted, ev, json) {
  const want = String(wanted).toLowerCase();
  if (typeof ev.event === 'string' && ev.event.toLowerCase() === want) return true;
  if (typeof ev.frameType === 'string' && ev.frameType.toLowerCase() === want) return true;
  for (const k of DISCRIMINATOR_KEYS) if (typeof json?.[k] === 'string' && json[k].toLowerCase() === want) return true;
  return false;
}

// Produce canonical family records from a reducer using the profile's accepted familyMappings.
// When eventRecords ({ dataset: record[] }) is supplied, 'event' mappings are taken from it
// (complete, streamed by derive) instead of the reducer's bounded in-memory events.
export function extractFamilyRecords(profile, reducer, { session, domTurns = [], eventRecords } = {}) {
  const out = {};
  if (!profile?.family) return out;
  const push = (entity, rec) => { (out[`family-${profile.family}-${entity}`] ??= []).push(rec); };
  if (eventRecords) for (const [ds, recs] of Object.entries(eventRecords)) (out[ds] ??= []).push(...recs);
  for (const fm of profile.familyMappings ?? []) {
    if (fm.source.kind === 'assembled') {
      const re = new RegExp(fm.source.endpoint);
      for (const s of reducer.streams.values()) {
        if (!s._delta?.revisions || !re.test(templateUrl(s.url))) continue;
        const rec = applyMapping(fm, s._delta.doc);
        if (rec.text === undefined && rec.id === undefined) continue;
        push(fm.entity, { ...rec, _family: profile.family, _entity: fm.entity, _provenance: { site: profile.name, session: session?.id, source: 'network', sid: s.sid, revisions: s._delta.revisions, final: s.status === 'complete', status: s.status, t: s.endT ?? s.lastChunkT } });
      }
    } else if (fm.source.kind === 'dom-turns') {
      for (const t of domTurns) push(fm.entity, { ...applyMapping(fm, t), _family: profile.family, _entity: fm.entity, _provenance: { site: profile.name, session: session?.id, source: 'dom', domId: t.id } });
    } else if (fm.source.kind === 'event' && !eventRecords) {
      for (const s of reducer.streams.values()) for (const e of s._events ?? []) {
        const json = e.jsonNested?.json !== undefined ? e.jsonNested.json : e.json;
        if (json === undefined || (fm.source.endpoint && !new RegExp(fm.source.endpoint).test(templateUrl(s.url)))) continue;
        if (fm.source.eventType && !matchesEventType(fm.source.eventType, e, json)) continue;
        for (const item of select(json, fm.source.itemsPath ?? '$')) if (item && typeof item === 'object') push(fm.entity, { ...applyMapping(fm, item), _family: profile.family, _entity: fm.entity, _provenance: { site: profile.name, session: session?.id, source: 'network', sid: s.sid, seq: e.seq, t: e.t } });
      }
    }
  }
  // Link network messages to the rendered turns that show them (evidence correlation).
  const msgs = out[`family-${profile.family}-message`] ?? [];
  const net = msgs.filter((m) => m._provenance.source === 'network'), dom = msgs.filter((m) => m._provenance.source === 'dom');
  const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const n of net) {
    const probe = norm(n.text).slice(0, 80);
    if (probe.length < 10) continue;
    const d = dom.find((x) => norm(x.text).includes(probe));
    if (d) { n._provenance.renderedAs = d._provenance.domId; d._provenance.receivedIn = n._provenance.sid; }
  }
  return out;
}
