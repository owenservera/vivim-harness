// Cross-site CORE library: one contract for how AI chat sites stream an answer, plus the per-site
// dialect that differs. Nothing in the contract is hardcoded: every transport, frame kind, delta
// field, terminal marker and envelope field is EARNED from the derived sessions on disk.
//
// Reused vocabulary and stores (no parallel taxonomy):
//   - sessions + SHAPES / ASSEMBLED   src/store/session.mjs via collectSessions() in ./build.mjs
//   - endpoint path patterns          ./build.mjs  pathPattern()
//   - per-site stream hash            ./build.mjs  familySignature()
//   - persistence                     ./families.mjs FamilyStore (vNNNN.json + CURRENT)
//   - transport + field names         src/shapes/infer.mjs / profiler.mjs (endpoints[], groups[].fields)
//
// Delta / terminal evidence: within one shape group (same endpoint + discriminator, i.e. the same
// kind of frame of the same stream) a field present in several records whose value is not constant
// behaves like a delta; a frame whose discriminator or field names a completion behaves like a
// terminal marker. Scalar fields expose `distinct`; container fields (object/array) are treated as
// changing because their contents can change while the path stays the same.
//
// Determinism: every collection is sorted, the per-site and core signatures hash only normalised
// data (no timestamps, no session ids), so two runs over the same sessions are byte-identical.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ADAPTER_IDS } from '../profiles/sites/index.mjs';
import { collectSessions, familySignature, pathPattern } from './build.mjs';
import { FamilyStore } from './families.mjs';

// The nine sites this build knows how to drive (same list as the adapter registry).
export const CORE_SITES = Object.freeze([...ADAPTER_IDS]);

const LIBRARY_ID = 'ai-chat-core';
const SIG_NOTE = 'ai-chat-core contract v1';

const STREAMING = new Set(['HTTP_SSE', 'HTTP_NDJSON', 'HTTP_STREAMED', 'EVENT_SOURCE', 'WEBSOCKET']);
const SCALAR = new Set(['string', 'number', 'boolean', 'null']);

// Field leaves that behave like streamed answer text when they are present on a streaming frame.
const DELTA_LEAVES = new Set(['v', 'value', 'delta', 'text', 'token', 'tokens', 'chunk', 'chunks', 'completion', 'fragment', 'patch', 'answer', 'output', 'response']);
const TERMINAL_LEAVES = new Set(['end_turn', 'finish_reason', 'stop_reason', 'stop_sequence', 'stream_close_reason', 'message_stream_complete', 'done']);
const STRONG_FRAME = /message_stream_complete|message_stop|\[DONE\]|stream_complete|end_turn|finish_reason|stop_reason|stream_close|close_reason/i;
const ENVELOPE_LEAVES = new Set(['type', 'kind', 'model', 'stream', 'metadata', 'delta', 'conversation_id', 'message_id', 'id', 'request_id', 'role', 'content', 'usage', 'status', 'event', 'session_id', 'prompt', 'messages', 'data', 'error']);
const TOOL_LEAVES = new Set(['tool_use', 'tool_call', 'tool_calls', 'function_call', 'tool_result', 'tool_name', 'tool_use_id']);
const USAGE_LEAVES = new Set(['usage', 'input_tokens', 'output_tokens', 'token_usage', 'cached_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']);
const REQUEST_LEAVES = new Set(['input_message', 'messages', 'prompt', 'instructions', 'system', 'content', 'parts']);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (iterable) => [...iterable].sort(cmp);
const uniq = (iterable) => sorted(new Set(iterable));

// Last path segment as a normalised field name ("$.metadata[\"Stream-Close-Reason\"]" -> stream_close_reason).
function leafOf(p) {
  const seg = String(p ?? '').replace(/\[\*\]/g, '').split('.').pop() ?? '';
  const m = /\["([^"]+)"\]$/.exec(seg);
  return (m ? m[1] : seg).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '');
}

const isStreamingEndpoint = (ep) => Object.keys(ep?.transports ?? {}).some((t) => STREAMING.has(t));

// The transport that carried most of this endpoint's streams (ties broken by name).
function dominantTransport(ep) {
  const entries = Object.entries(ep?.transports ?? {});
  if (!entries.length) return 'UNKNOWN';
  entries.sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0) || cmp(a[0], b[0]));
  return entries[0][0];
}

// Field paths that behave like a delta on this frame kind.
function deltaFieldsOf(g) {
  const out = new Set();
  for (const [p, f] of Object.entries(g?.fields ?? {})) {
    if (!p || p === '$') continue;
    if (Number(f?.count ?? 0) < 2) continue;
    const stripped = String(p).replace(/\[\*\]/g, '');
    // Collection-item paths only count when they sit under an explicit delta envelope
    // (choices[*].delta.content); otherwise every nested array element looks like a delta.
    if (String(p).includes('[*]') && !/(^|\.)delta(\.|$)/i.test(stripped)) continue;
    if (stripped.split('.').length - 1 > 3) continue;
    const leaf = leafOf(p);
    if (!leaf) continue;
    const types = Array.isArray(f?.types) ? f.types : [];
    const scalar = types.length > 0 && types.every((t) => SCALAR.has(t));
    const changes = scalar ? (f?.distinct === undefined || Number(f.distinct) > 1) : true;
    if (!changes) continue;
    const textish = DELTA_LEAVES.has(leaf) || /(^|\.)delta(\.|$)/i.test(stripped);
    const grows = types.includes('object') || types.includes('array')
      || Number(f?.avgLen ?? 0) >= 8 || Number(f?.maxLen ?? 0) >= 8;
    if (textish && grows) out.add(p);
  }
  return sorted(out);
}

// Evidence that this frame kind ends (or closes) the stream.
function terminalMarkersOf(g) {
  const out = new Set();
  const d = String(g?.discriminator ?? '');
  if (STRONG_FRAME.test(d)) out.add(`frame:${d}`);
  for (const [p, f] of Object.entries(g?.fields ?? {})) {
    const leaf = leafOf(p);
    if (!TERMINAL_LEAVES.has(leaf)) continue;
    out.add(`field:${leaf}`);
    for (const v of Array.isArray(f?.enum) ? f.enum : []) out.add(`field:${leaf}=${v}`);
  }
  return sorted(out);
}

// Answer-stream evidence: a frame counts only when it actually carries answer text (delta), the
// outbound request, a tool call, token usage, or an explicit stream terminator. Page-bootstrap
// streams that merely have a "complete" flag are not an answer stream and are left out.
function answerEvidence(g, { post = false } = {}) {
  const d = String(g?.discriminator ?? '');
  const leaves = new Set(Object.keys(g?.fields ?? {}).map(leafOf));
  return deltaFieldsOf(g).length > 0
    || (post && [...leaves].some((l) => REQUEST_LEAVES.has(l)))
    || [...leaves].some((l) => TOOL_LEAVES.has(l))
    || [...leaves].some((l) => USAGE_LEAVES.has(l))
    || [...leaves].some((l) => TERMINAL_LEAVES.has(l))
    || STRONG_FRAME.test(d);
}

// Normalised frame kinds of one site's streaming frames.
function frameKindsOf(groups, deltaFields, terminalMarkers) {
  const kinds = new Set();
  if (deltaFields.length) kinds.add('delta');
  if (terminalMarkers.length) kinds.add('terminal');
  for (const g of groups) {
    const d = String(g?.discriminator ?? '');
    if (/delta|patch|chunk/i.test(d)) kinds.add('delta');
    if (/tool|function_call/i.test(d)) kinds.add('tool');
    if (/usage/i.test(d)) kinds.add('usage');
    if (/ping|heartbeat|keepalive/i.test(d)) kinds.add('keepalive');
    const leaves = new Set(Object.keys(g?.fields ?? {}).map(leafOf));
    if ([...leaves].some((l) => TOOL_LEAVES.has(l))) kinds.add('tool');
    if ([...leaves].some((l) => USAGE_LEAVES.has(l))) kinds.add('usage');
    if ([...leaves].some((l) => REQUEST_LEAVES.has(l))) kinds.add('request');
  }
  return sorted(kinds);
}

// Root-level envelope fields observed on streaming frames.
function envelopeFieldsOf(groups) {
  const out = new Set();
  for (const g of groups) {
    for (const p of Object.keys(g?.fields ?? {})) {
      const stripped = String(p).replace(/\[\*\]/g, '');
      if (!/^\$\.[A-Za-z_$][\w$]*$/.test(stripped)) continue;
      const leaf = leafOf(stripped);
      if (ENVELOPE_LEAVES.has(leaf)) out.add(leaf);
    }
  }
  return sorted(out);
}

// Merge every derived session of one site into its streaming dialect.
function dialectOf(sessions) {
  const streams = new Map();          // "transport endpoint" -> signature shape
  const patterns = new Set();         // streaming endpoint path patterns
  const transports = new Set();
  const groups = [];                  // streaming shape groups (all sessions)
  const dialects = new Set();         // assembled delta dialects (src/replay/derive.mjs)

  for (const s of sessions) {
    if (!s.hasDerived) continue;
    for (const a of Object.values(s.assembled ?? {})) for (const d of a?.dialects ?? []) dialects.add(d);
    const eps = new Map((s.endpoints ?? []).map((e) => [e.endpoint, e]));
    for (const g of s.groups ?? []) {
      const ep = eps.get(g.endpoint) ?? null;
      if (!isStreamingEndpoint(ep)) continue;   // the core describes streamed answers, not metadata polls
      // ...and only frames that carry answer-stream evidence (request frames only on POST endpoints).
      if (!answerEvidence(g, { post: /^POST\b/i.test(String(g.endpoint ?? '')) })) continue;
      for (const t of Object.keys(ep?.transports ?? {})) transports.add(t);
      const transport = dominantTransport(ep);
      const endpoint = pathPattern(g.endpoint ?? '');
      patterns.add(endpoint);
      const key = `${transport} ${endpoint}`;
      const entry = streams.get(key) ?? { transport, endpoint, fields: new Map() };
      for (const [p, f] of Object.entries(g?.fields ?? {})) {
        entry.fields.set(p, (entry.fields.get(p) ?? 0) + Number(f?.count ?? 0));
      }
      streams.set(key, entry);
      groups.push(g);
    }
  }

  const shapes = [...streams.values()]
    .sort((a, b) => cmp(a.transport, b.transport) || cmp(a.endpoint, b.endpoint))
    .map((e) => ({
      transport: e.transport,
      endpoint: e.endpoint,
      fields: [...e.fields.entries()].sort((a, b) => cmp(a[0], b[0])).map(([p, count]) => ({ path: p, count })),
      deltas: [],
    }));

  const deltaFields = uniq(groups.flatMap((g) => deltaFieldsOf(g)));
  const terminalMarkers = uniq(groups.flatMap((g) => terminalMarkersOf(g)));
  return {
    shapes,
    transports: sorted(transports),
    endpoints: sorted(patterns),
    dialects: sorted(dialects),
    deltaFields,
    terminalMarkers,
    frameKinds: frameKindsOf(groups, deltaFields, terminalMarkers),
    envelopeFields: envelopeFieldsOf(groups),
    streams: streams.size,
  };
}

function primaryHost(sessions) {
  const counts = new Map();
  for (const s of sessions) if (s.host) counts.set(s.host, (counts.get(s.host) ?? 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  return entries[0]?.[0] ?? '';
}

// sha256 over the sorted, normalised contract. familySignature() is reused per site (it hashes one
// site's shape set), but the CORE signature must cover the cross-site contract and per-site
// dialects, so it hashes those two objects directly. The note keeps the scheme versioned.
function coreSignature(core, perSite) {
  const canon = JSON.stringify({ note: SIG_NOTE, core, perSite });
  return `sha256:${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

// Build the core library object (read-only; see writeCoreLibrary to persist it).
export function buildCoreLibrary({ sessionsDir, familiesDir = null, sites = CORE_SITES, minSessions = 1 } = {}) {
  if (!sessionsDir) throw new Error('buildCoreLibrary needs sessionsDir');
  const ids = (Array.isArray(sites) && sites.length ? sites : CORE_SITES).map((s) => String(s).toLowerCase());
  const siteRows = [];
  const perSite = {};
  const gaps = [];
  let sessionsTotal = 0;
  let derivedTotal = 0;
  let streamsTotal = 0;

  for (const id of ids) {
    const sessions = collectSessions({ sessionsDir, site: id });
    const derived = sessions.filter((s) => s.hasDerived);
    const dialect = dialectOf(sessions);
    sessionsTotal += sessions.length;
    derivedTotal += derived.length;
    streamsTotal += dialect.streams;

    if (!sessions.length) gaps.push(`${id}: no sessions`);
    else if (!derived.length) gaps.push(`${id}: no derived sessions (${sessions.length} session(s); run "studio derive <session> --full")`);
    else if (!dialect.endpoints.length) gaps.push(`${id}: no answer-stream frames observed in the derived sessions`);
    else {
      if (!dialect.deltaFields.length) gaps.push(`${id}: no delta field observed`);
      if (!dialect.terminalMarkers.length) gaps.push(`${id}: no terminal marker observed`);
    }
    if (sessions.length && sessions.length < minSessions) gaps.push(`${id}: ${sessions.length} session(s), below --min ${minSessions}`);

    siteRows.push({
      id,
      host: primaryHost(sessions),
      sessions: sessions.length,
      withDerived: derived.length,
      transports: dialect.transports,
      endpoints: dialect.endpoints,
      signature: familySignature(dialect.shapes),
      dialects: dialect.dialects,
      deltaFields: dialect.deltaFields,
      terminalMarkers: dialect.terminalMarkers,
      variants: uniq(dialect.shapes.map((s) => `${s.transport} ${s.endpoint}`)),
    });

    perSite[id] = {
      site: id,
      host: primaryHost(sessions),
      transports: dialect.transports,
      endpoints: dialect.endpoints,
      dialects: dialect.dialects,
      deltaFields: dialect.deltaFields,
      terminalMarkers: dialect.terminalMarkers,
      frameKinds: dialect.frameKinds,
      envelopeFields: dialect.envelopeFields,
      variants: uniq(dialect.shapes.map((s) => `${s.transport} ${s.endpoint}`)),
      signature: familySignature(dialect.shapes),
    };
  }

  // Core contract: group each evidence item by its normalised name and record the sites that show it.
  const deltaByName = new Map();   // name -> { name, paths: { site: [...] } }
  for (const row of siteRows) {
    for (const p of row.deltaFields) {
      const name = leafOf(p);
      const entry = deltaByName.get(name) ?? { name, paths: {} };
      entry.paths[row.id] = uniq([...(entry.paths[row.id] ?? []), p]);
      deltaByName.set(name, entry);
    }
  }
  const deltaFields = [...deltaByName.values()]
    .sort((a, b) => cmp(a.name, b.name))
    .map((e) => ({
      name: e.name,
      paths: Object.fromEntries(ids.filter((id) => e.paths[id]).map((id) => [id, e.paths[id]])),
    }));

  const terminalByName = new Map();
  for (const row of siteRows) {
    for (const marker of row.terminalMarkers) {
      const entry = terminalByName.get(marker) ?? { marker, sites: new Set() };
      entry.sites.add(row.id);
      terminalByName.set(marker, entry);
    }
  }

  const envelopeByName = new Map();
  for (const row of siteRows) {
    for (const name of perSite[row.id]?.envelopeFields ?? []) {
      const entry = envelopeByName.get(name) ?? { name, sites: new Set() };
      entry.sites.add(row.id);
      envelopeByName.set(name, entry);
    }
  }

  const transports = uniq(siteRows.flatMap((r) => r.transports));
  const frameKinds = uniq(Object.values(perSite).flatMap((p) => p.frameKinds));

  const core = {
    transports,
    frameKinds,
    deltaFields,
    terminalMarkers: [...terminalByName.values()].sort((a, b) => cmp(a.marker, b.marker))
      .map((e) => ({ marker: e.marker, sites: sorted(e.sites) })),
    envelopeFields: [...envelopeByName.values()].sort((a, b) => cmp(a.name, b.name))
      .map((e) => ({ name: e.name, sites: sorted(e.sites) })),
  };

  const coverage = {
    sites: ids.length,
    sitesWithData: siteRows.filter((r) => r.sessions > 0).length,
    sessions: sessionsTotal,
    withDerived: derivedTotal,
    streams: streamsTotal,
  };

  return {
    id: LIBRARY_ID,
    name: LIBRARY_ID,
    kind: 'core-library',
    sites: siteRows,
    core,
    perSite,
    coverage,
    gaps: sorted(gaps),
    signature: coreSignature(core, perSite),
  };
}

// Persist through FamilyStore (versioned vNNNN.json + CURRENT) AND a plain diffable core.json in the
// same directory as the versioned files. Never rewrites the per-site families.
export function writeCoreLibrary({ familiesDir, library } = {}) {
  if (!familiesDir) throw new Error('writeCoreLibrary needs familiesDir');
  if (!library?.id) throw new Error('writeCoreLibrary needs a built core library');
  const store = new FamilyStore(familiesDir);
  // No session ids go into the record: FamilyStore.addMember() treats `members` as profile names.
  const rec = store.save(library.id, {
    ...library,
    kind: 'core-library',
    coverage: library.coverage,
    gaps: library.gaps,
  }, `core contract from ${library.coverage?.sitesWithData ?? 0}/${library.coverage?.sites ?? 0} site(s), signature ${library.signature}`);

  const dir = path.join(familiesDir, library.id);
  const versionFile = path.join(dir, `v${String(rec.version).padStart(4, '0')}.json`);
  const currentFile = path.join(dir, 'CURRENT');
  const plainFile = path.join(dir, 'core.json');
  // core.json is the deterministic build output (no version/savedAt), so humans can diff two runs.
  writeFileSync(plainFile, `${JSON.stringify(library, null, 2)}\n`);
  return {
    store: 'src/families/families.mjs FamilyStore (VersionedStore: vNNNN.json + CURRENT)',
    dir,
    version: rec.version,
    record: rec,
    files: [versionFile, currentFile, plainFile],
  };
}

// How the sites DIFFER, as rows a table can render directly.
export function compareSites({ library } = {}) {
  if (!library?.sites) throw new Error('compareSites needs a built core library');
  return library.sites.map((row) => {
    const p = library.perSite?.[row.id] ?? {};
    const transports = p.transports ?? [];
    const framing = [
      transports.some((t) => t === 'HTTP_SSE' || t === 'EVENT_SOURCE') ? 'sse' : null,
      transports.some((t) => t === 'HTTP_STREAMED' || t === 'HTTP_NDJSON') ? 'chunked' : null,
      transports.includes('WEBSOCKET') ? 'websocket' : null,
      transports.includes('HTTP') ? 'http' : null,
    ].filter(Boolean).join('+') || 'none';
    return {
      site: row.id,
      transport: transports.filter((t) => STREAMING.has(t))[0] ?? 'none',
      framing,
      sse: framing.includes('sse'),
      chunked: framing.includes('chunked'),
      endpoint: (p.endpoints ?? [])[0] ?? '—',
      deltaField: (p.deltaFields ?? []).join(', ') || '—',
      terminalMarker: (p.terminalMarkers ?? [])[0] ?? '—',
    };
  });
}
