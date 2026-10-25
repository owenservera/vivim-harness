#!/usr/bin/env node
// Protobuf reply-field search (READ-ONLY).
//
// For each saved session that has an assistant turn in kv/DOM_TURNS.json and at least one stream whose
// response mime names connect+proto, grpc or protobuf, this tool:
//   1. reassembles each such stream's bytes from its raw chunk records (fallback: its body record),
//      splits Connect envelopes, decompresses compressed frames (gzip, inflate, inflateRaw, brotli, in
//      that order), decodes protobuf and collects every string leaf with its index-free path;
//   2. aggregates each path's occurrences six ways and scores each aggregate against every saved
//      assistant DOM turn (multiset token Dice, the metric of join.mjs near_match):
//        last            the last occurrence
//        longest         the longest occurrence (first one on ties)
//        concat          all occurrences joined in frame order
//        concatDistinct  occurrences joined in order, skipping one identical to the previous occurrence
//                        or already contained in the joined text
//        chain           a growth chain: an occurrence that starts with the chain replaces it (snapshots),
//                        one already contained is skipped, anything else is appended (deltas)
//        unionAll        every distinct occurrence joined in first-seen order
//   3. measures presence coverage: the share of DOM assistant tokens (with multiplicity) whose token
//      appears anywhere in the stream's strings, and in each path's strings alone;
//   4. tries the in-frame-order concatenation of the top COMBO_N paths of each stream by coverage.
//
// Usage:
//   node scripts/proto-field-search.mjs [--data-dir DIR] (--session ID | --all) [--host claude.ai]
//                                       [--out FILE] [--json]
//
// Guarantees:
//   * Never writes into the data directory. Raw records are read with iterateRaw(dir, { useIndex: false })
//     (read-only); kv/DOM_TURNS.json and session.json are read with readFileSync. No session store.
//   * Never derives, never opens a browser, never contacts a network.
//   * Snapshots the touched session folders before and after the run. Any change prints WRITE DETECTED
//     and exits 4 with no report.
//   * Refuses a data directory that is the repository checkout (or inside one) and an --out file inside
//     the data directory.
//   * Zero text in the report: session ids, host name, numbers, paths (digits and dots) and enum labels.
//     No string values, no URLs or query strings, no titles.
//   * Bounded memory: raw records stream one at a time. Per stream, a string is capped at STRING_CAP
//     characters, frames at FRAME_CAP, distinct paths at PATH_CAP, and each aggregate at STRING_CAP.
//   * Each session runs in its own try/catch; a bad session becomes status "error" with a class name.
//
// Thresholds (code constants): COVERED_MIN (presence coverage that counts as "covered") and MATCH_MIN
// (Dice that counts as "reconstructs the reply"; equal to join.mjs NEAR_THRESHOLD).
// Known limit: src/decode/protobuf.mjs classifies a string that also parses as a message with two or
// more fields as a message, so such a text is not a string leaf here.
import { readFileSync, readdirSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultDataDir, dataPaths } from '../src/config.mjs';
import { iterateRaw } from '../src/store/raw-index.mjs';
import {
  splitEnvelopes, decodeProtobuf, protoStrings, DEFAULT_MAX_FRAME_BYTES,
} from '../src/decode/protobuf.mjs';
import { normalizeForJoin, normalizeRole, NEAR_THRESHOLD } from '../src/intel/join.mjs';
import {
  assertNotRepoCheckout, snapshotSessionDirs, diffSnapshots, errorClassOf, isInside,
  UsageError, GuardError,
} from './fidelity-survey.mjs';

export { UsageError, GuardError };

export const SCHEMA = 'capture-studio.proto-field-search/1';
export const STRING_CAP = 1 << 20;
export const FRAME_CAP = 50000;
export const PATH_CAP = 500;
export const INFLATE_CAP = 64 << 20;
export const TOP_N = 5;
export const COMBO_N = 3;
export const COVERED_MIN = 0.95;
export const MATCH_MIN = NEAR_THRESHOLD;
export const AGGREGATIONS = ['last', 'longest', 'concat', 'concatDistinct', 'chain', 'unionAll'];
export const MIME_RE = /connect\+proto|grpc|protobuf/i;

const METHOD_NAMES = ['gzip', 'inflate', 'inflateRaw', 'brotli'];
const KNOWN_FLAGS = 0x01 | 0x02 | 0x80;
const FLAG_COMPRESSED = 0x01;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_WRITE = 4;
const RANK_LIMIT = 20;

const USAGE = [
  'Usage: node scripts/proto-field-search.mjs [--data-dir DIR] (--session ID | --all) [--host claude.ai] [--out FILE] [--json]',
  '  --session ID   search one session folder (read-only)',
  '  --all          search every session folder',
  '  --host HOST    only sessions whose site host is HOST or a subdomain of it',
  '  --out FILE     also write the JSON report to FILE (refused inside the data directory)',
  '  --json         print the JSON report to stdout (default: table on stderr)',
  '',
].join('\n');

const r3 = (x) => Math.round(x * 1000) / 1000;
const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const stripIdx = (p) => p.replace(/\[\d+\]/g, '');
const AGG_INDEX = Object.fromEntries(AGGREGATIONS.map((a, i) => [a, i]));

// Decompressors in the documented order. maxOutputLength bounds each inflated frame.
const DECOMPRESSORS = {
  gzip: (b) => zlib.gunzipSync(b, { maxOutputLength: INFLATE_CAP }),
  inflate: (b) => zlib.inflateSync(b, { maxOutputLength: INFLATE_CAP }),
  inflateRaw: (b) => zlib.inflateRawSync(b, { maxOutputLength: INFLATE_CAP }),
  brotli: (b) => zlib.brotliDecompressSync(b, { maxOutputLength: INFLATE_CAP }),
};

// Returns { method, buf } for the first method that works, or null. Never throws.
export function inflateFrame(payload) {
  for (const name of METHOD_NAMES) {
    try { return { method: name, buf: DECOMPRESSORS[name](payload) }; } catch { /* try the next method */ }
  }
  return null;
}

// Multiset token Dice. Local copy of join.mjs tokenDice (not exported there). Drift is caught by a test
// that compares this value with the near_match score that join.mjs reports.
export function tokenDice(a, b) {
  const A = a.split(' ').filter(Boolean);
  const B = b.split(' ').filter(Boolean);
  if (!A.length || !B.length) return 0;
  const counts = new Map();
  for (const t of A) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of B) {
    const c = counts.get(t) ?? 0;
    if (c > 0) { common++; counts.set(t, c - 1); }
  }
  return (2 * common) / (A.length + B.length);
}

// Presence coverage: share of DOM tokens (with multiplicity) whose token occurs in tokenSet.
export function coverageOf(domTokens, tokenSet) {
  if (domTokens.length === 0) return 0;
  let hit = 0;
  for (const t of domTokens) if (tokenSet.has(t)) hit++;
  return hit / domTokens.length;
}

// Best Dice of one text against the DOM turns. Null when the normalized text is empty.
function bestAgainstTurns(text, domNorms) {
  const norm = normalizeForJoin(text);
  if (norm === '') return null;
  let best = null;
  domNorms.forEach((dn, i) => {
    const dice = tokenDice(norm, dn);
    if (best === null || dice > best.dice) best = { dice, turnIndex: i };
  });
  return best;
}

// ---------------------------------------------------------------------------------------------
// Bounded string accumulators. Every aggregate is capped at STRING_CAP characters.
// ---------------------------------------------------------------------------------------------
const newAcc = () => ({ s: '', n: 0, capped: false });

function appendCapped(acc, piece, sep = '') {
  if (acc.capped) return;
  const add = (acc.n > 0 ? sep : '') + piece;
  const room = STRING_CAP - acc.s.length;
  if (add.length > room) {
    acc.s += add.slice(0, Math.max(0, room));
    acc.capped = true;
  } else {
    acc.s += add;
  }
  acc.n++;
}

function setCapped(acc, text) {
  acc.s = text.length > STRING_CAP ? text.slice(0, STRING_CAP) : text;
  if (text.length > STRING_CAP) acc.capped = true;
  acc.n++;
}

function addDistinct(st, text) {
  const prev = st.prev;
  st.prev = text;
  if (text === prev) return;
  if (st.distinct.s.includes(text)) return;
  appendCapped(st.distinct, text);
}

function addChain(acc, text) {
  if (acc.capped) return;
  if (acc.n === 0) { setCapped(acc, text); return; }
  if (text.startsWith(acc.s)) { setCapped(acc, text); return; }
  if (acc.s.includes(text)) return;
  appendCapped(acc, text);
}

// One path within one stream: occurrences, the six aggregates, and the token set of its occurrences.
class PathStats {
  constructor() {
    this.count = 0;
    this.last = '';
    this.longest = '';
    this.concat = newAcc();
    this.distinct = newAcc();
    this.prev = null;
    this.chain = newAcc();
    this.seen = new Set();
    this.union = newAcc();
    this.tokens = new Set();
  }

  add(text, streamTokens) {
    this.count++;
    this.last = text;
    if (text.length > this.longest.length) this.longest = text;
    appendCapped(this.concat, text);
    addDistinct(this, text);
    addChain(this.chain, text);
    const h = sha1(text);
    if (this.seen.has(h)) return;
    this.seen.add(h);
    appendCapped(this.union, text, '\n');
    for (const t of normalizeForJoin(text).split(' ')) {
      if (!t) continue;
      this.tokens.add(t);
      streamTokens.add(t);
    }
  }

  value(agg) {
    switch (agg) {
      case 'last': return this.last;
      case 'longest': return this.longest;
      case 'concat': return this.concat.s;
      case 'concatDistinct': return this.distinct.s;
      case 'chain': return this.chain.s;
      case 'unionAll': return this.union.s;
      default: return '';
    }
  }
}

// Per-stream path table for one pass over the frames.
class StreamStats {
  constructor() {
    this.paths = new Map();
    this.tokens = new Set();
    this.pathsDropped = 0;
  }

  add(p, text) {
    let ps = this.paths.get(p);
    if (!ps) {
      if (this.paths.size >= PATH_CAP) { this.pathsDropped++; return; }
      ps = new PathStats();
      this.paths.set(p, ps);
    }
    ps.add(text, this.tokens);
  }
}

// ---------------------------------------------------------------------------------------------
// Frame decoder: incremental envelope split, decompression, protobuf decode, string leaves.
// onString(frameIndex, indexFreePath, cappedText) is called in document order per frame.
// ---------------------------------------------------------------------------------------------
export class StreamDecoder {
  constructor({ onString = () => {} } = {}) {
    this.onString = onString;
    this.pending = [];
    this.pendingLen = 0;
    this.need = 5;
    this.frames = 0;
    this.dead = false;
    this.stats = {
      framesTotal: 0, framesCompressed: 0, framesControl: 0, framesUndecodable: 0,
      protoDecodeErrors: 0, envelopeErrors: 0, stringsCapped: 0, pathsDropped: 0,
      framesCapped: false,
      methods: Object.fromEntries(METHOD_NAMES.map((m) => [m, 0])),
    };
  }

  push(buf) {
    if (this.dead || buf.length === 0) return;
    this.pending.push(buf);
    this.pendingLen += buf.length;
    if (this.pendingLen < this.need) return;
    const joined = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    const r = splitEnvelopes(joined);
    if (!r.ok) { this.stats.envelopeErrors++; this.dead = true; return; }
    for (const f of r.frames) {
      if (!f.complete) break;
      if (!this.frame(f)) return;
    }
    const left = Buffer.from(r.leftover);
    if (left.length) { this.pending.push(left); this.pendingLen = left.length; }
    if (left.length < 5) { this.need = 5; return; }
    const flags = left[0];
    const len = left.readUInt32BE(1);
    if ((flags & ~KNOWN_FLAGS) !== 0 || len > DEFAULT_MAX_FRAME_BYTES) {
      this.stats.envelopeErrors++;
      this.dead = true;
      return;
    }
    this.need = 5 + len;
  }

  // Returns false when decoding must stop (frame cap reached).
  frame(f) {
    if (this.frames >= FRAME_CAP) { this.stats.framesCapped = true; this.dead = true; return false; }
    const idx = this.frames++;
    this.stats.framesTotal++;
    if (f.endStream || f.trailers) { this.stats.framesControl++; return true; }
    let payload = f.payload;
    if (f.compressed) {
      this.stats.framesCompressed++;
      const got = inflateFrame(payload);
      if (!got) { this.stats.framesUndecodable++; return true; }
      this.stats.methods[got.method]++;
      payload = got.buf;
    }
    const r = decodeProtobuf(payload);
    if (!r.ok) this.stats.protoDecodeErrors++;
    const top = r.ok ? r.tree : r.partial;
    for (const s of protoStrings(top)) {
      let text = s.text;
      if (text.length > STRING_CAP) { text = text.slice(0, STRING_CAP); this.stats.stringsCapped++; }
      this.onString(idx, stripIdx(s.path), text);
    }
    return true;
  }

  end() {
    if (!this.dead && this.pendingLen > 0) this.stats.framesUndecodable++;
    this.pending = [];
    this.pendingLen = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Session reading (read-only)
// ---------------------------------------------------------------------------------------------
function canon(p) {
  let r = path.resolve(p);
  try { r = realpathSync(r); } catch {
    try { r = path.join(realpathSync(path.dirname(r)), path.basename(r)); } catch { /* keep resolved */ }
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function readSessionMeta(dir) {
  const p = path.join(dir, 'session.json');
  if (!existsSync(p)) { const e = new Error('session.json missing'); e.code = 'SESSION_JSON_MISSING'; throw e; }
  const meta = JSON.parse(readFileSync(p, 'utf8'));
  if (!meta || typeof meta !== 'object') { const e = new Error('session.json not an object'); e.code = 'SESSION_JSON_INVALID'; throw e; }
  return meta;
}

function readDomTurns(dir) {
  const p = path.join(dir, 'kv', 'DOM_TURNS.json');
  if (!existsSync(p)) return [];
  const v = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(v) ? v : [];
}

function hostOf(meta) {
  try { return new URL(meta?.target?.url).hostname || null; } catch { return null; }
}

function hostMatches(siteHost, host) {
  if (!siteHost) return false;
  return siteHost === host || siteHost.endsWith(`.${host}`);
}

// Pass 1: which streams exist, their response mime, and whether they carry chunk or body records.
async function scanStreamKinds(rawDir) {
  const streams = new Map();
  const get = (sid) => {
    let e = streams.get(sid);
    if (!e) { e = { mime: null, chunks: 0, bodies: 0 }; streams.set(sid, e); }
    return e;
  };
  for await (const rec of iterateRaw(rawDir, { useIndex: false, kinds: ['req', 'res', 'chunk', 'body'] })) {
    if (!rec || rec.k === 'corrupt' || rec.sid === undefined || rec.sid === null) continue;
    const e = get(rec.sid);
    if (rec.k === 'res' && typeof rec.mime === 'string') e.mime = rec.mime.toLowerCase();
    else if (rec.k === 'chunk' && typeof rec.b64 === 'string') e.chunks++;
    else if (rec.k === 'body' && typeof rec.b64 === 'string') e.bodies++;
  }
  return streams;
}

// Passes 2 and 3: feed each planned stream's bytes, in record order, into its decoder.
async function feedStreams(rawDir, plan, decoders) {
  if (plan.size === 0) return;
  for await (const rec of iterateRaw(rawDir, { useIndex: false, kinds: ['chunk', 'body'], sids: [...plan.keys()] })) {
    if (!rec || rec.k === 'corrupt') continue;
    if (plan.get(rec.sid) !== rec.k || typeof rec.b64 !== 'string') continue;
    decoders.get(rec.sid).push(Buffer.from(rec.b64, 'base64'));
  }
  for (const d of decoders.values()) d.end();
}

// Per-stream summary: presence coverage, per-path coverage, and per-path/aggregate Dice entries.
function summarizeStream(st, dstats, domNorms, domTokens) {
  dstats.pathsDropped = st.pathsDropped;
  const pathCoverage = new Map();
  const entries = [];
  for (const [p, ps] of st.paths) {
    pathCoverage.set(p, coverageOf(domTokens, ps.tokens));
    for (const agg of AGGREGATIONS) {
      const text = ps.value(agg);
      const best = bestAgainstTurns(text, domNorms);
      if (best) entries.push({ path: p, aggregation: agg, occurrences: ps.count, chars: text.length, dice: best.dice });
    }
  }
  return {
    stats: dstats,
    streamCoverage: coverageOf(domTokens, st.tokens),
    pathCoverage,
    entries,
  };
}

const byCoverageThenPath = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// Best (path, aggregation) pairs across streams, ranked by Dice, then coverage, then aggregation order.
function rankEntries(sums) {
  const best = new Map();
  const pathCov = new Map();
  for (const s of sums) {
    for (const [p, c] of s.pathCoverage) if (c > (pathCov.get(p) ?? -1)) pathCov.set(p, c);
    for (const e of s.entries) {
      const k = `${e.path}|${e.aggregation}`;
      const cur = best.get(k);
      if (!cur || e.dice > cur.dice) best.set(k, e);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.dice - a.dice
      || (pathCov.get(b.path) - pathCov.get(a.path))
      || (AGG_INDEX[a.aggregation] - AGG_INDEX[b.aggregation])
      || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, TOP_N)
    .map((e) => ({
      path: e.path,
      aggregation: e.aggregation,
      occurrences: e.occurrences,
      chars: e.chars,
      dice: r3(e.dice),
      coverageOfDom: r3(pathCov.get(e.path) ?? 0),
    }));
}

export async function searchSession(dir, id, { host = null } = {}) {
  const meta = readSessionMeta(dir);
  const siteHost = hostOf(meta);
  if (host && !hostMatches(siteHost, host)) return { id, siteHost, status: 'skipped', reason: 'host_filter' };
  const assistant = readDomTurns(dir).filter((t) => normalizeRole(t?.role) === 'assistant');
  if (assistant.length === 0) return { id, siteHost, status: 'skipped', reason: 'no_dom_assistant_turn' };
  const domNorms = assistant.map((t) => normalizeForJoin(String(t?.text ?? '')));
  const domTokens = domNorms.flatMap((n) => n.split(' ').filter(Boolean));
  const domAssistantChars = domNorms.reduce((a, n) => a + n.length, 0);

  const rawDir = path.join(dir, 'raw');
  const seen = await scanStreamKinds(rawDir);
  const plan = new Map();
  for (const [sid, e] of seen) {
    if (e.mime && MIME_RE.test(e.mime) && e.chunks + e.bodies > 0) plan.set(sid, e.chunks > 0 ? 'chunk' : 'body');
  }
  if (plan.size === 0) return { id, siteHost, status: 'skipped', reason: 'no_proto_stream' };

  // Pass 2: per-path statistics for every protobuf stream, one scan of the log.
  const stats = new Map();
  const decoders = new Map();
  for (const sid of plan.keys()) {
    const st = new StreamStats();
    stats.set(sid, st);
    decoders.set(sid, new StreamDecoder({ onString: (_i, p, text) => st.add(p, text) }));
  }
  await feedStreams(rawDir, plan, decoders);
  const sums = new Map();
  for (const sid of plan.keys()) {
    sums.set(sid, summarizeStream(stats.get(sid), decoders.get(sid).stats, domNorms, domTokens));
  }

  // Pass 3: concatenation of the top COMBO_N paths (by coverage) of each stream, in frame order.
  const comboPlan = new Map();
  const comboPaths = new Map();
  for (const [sid, sum] of sums) {
    const top = [...sum.pathCoverage].filter(([, c]) => c > 0).sort(byCoverageThenPath)
      .slice(0, COMBO_N).map(([p]) => p);
    if (top.length) { comboPaths.set(sid, top); comboPlan.set(sid, plan.get(sid)); }
  }
  const comboDecoders = new Map();
  const comboAcc = new Map();
  for (const [sid, paths] of comboPaths) {
    const set = new Set(paths);
    const acc = newAcc();
    comboAcc.set(sid, acc);
    comboDecoders.set(sid, new StreamDecoder({ onString: (_i, p, text) => { if (set.has(p)) appendCapped(acc, text); } }));
  }
  await feedStreams(rawDir, comboPlan, comboDecoders);
  let bestCombination = null;
  for (const [sid, acc] of comboAcc) {
    const norm = normalizeForJoin(acc.s);
    if (!norm) continue;
    const best = bestAgainstTurns(acc.s, domNorms);
    const cand = {
      paths: [...comboPaths.get(sid)],
      dice: r3(best.dice),
      coverage: r3(coverageOf(domTokens, new Set(norm.split(' ').filter(Boolean)))),
    };
    if (!bestCombination || cand.dice > bestCombination.dice
      || (cand.dice === bestCombination.dice && cand.coverage > bestCombination.coverage)) bestCombination = cand;
  }

  const totals = {
    framesTotal: 0, framesCompressed: 0, framesControl: 0, framesUndecodable: 0,
    protoDecodeErrors: 0, envelopeErrors: 0, stringsCapped: 0, pathsDropped: 0,
  };
  const decompressMethods = Object.fromEntries(METHOD_NAMES.map((m) => [m, 0]));
  let framesCapped = false;
  let streamCoverage = 0;
  for (const sum of sums.values()) {
    const d = sum.stats;
    for (const k of Object.keys(totals)) totals[k] += d[k];
    for (const m of METHOD_NAMES) decompressMethods[m] += d.methods[m];
    framesCapped = framesCapped || d.framesCapped;
    streamCoverage = Math.max(streamCoverage, sum.streamCoverage);
  }
  return {
    id,
    siteHost,
    status: 'ok',
    streams: seen.size,
    protoStreams: plan.size,
    ...totals,
    framesCapped,
    decompressMethods,
    domAssistantChars,
    streamCoverage: r3(streamCoverage),
    top: rankEntries([...sums.values()]),
    bestCombination,
  };
}

// ---------------------------------------------------------------------------------------------
// Aggregation and report
// ---------------------------------------------------------------------------------------------
function median(xs) {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return r3(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

export function aggregate(sessions) {
  const ok = sessions.filter((s) => s.status === 'ok');
  const skipped = {};
  const errorClasses = {};
  for (const s of sessions) {
    if (s.status === 'skipped') bump(skipped, s.reason);
    if (s.status === 'error') bump(errorClasses, s.errorClass);
  }
  const bestAggregation = Object.fromEntries(AGGREGATIONS.map((a) => [a, 0]));
  const pathRows = new Map();
  let covered = 0;
  let single = 0;
  let comboOnly = 0;
  for (const s of ok) {
    const t0 = s.top[0];
    if (t0) bestAggregation[t0.aggregation]++;
    if (s.streamCoverage >= COVERED_MIN) covered++;
    const bestSingle = t0 ? t0.dice : 0;
    const bestCombo = s.bestCombination ? s.bestCombination.dice : 0;
    if (bestSingle >= MATCH_MIN) single++;
    else if (bestCombo >= MATCH_MIN) comboOnly++;
    const perPath = new Map();
    for (const e of s.top) perPath.set(e.path, Math.max(perPath.get(e.path) ?? 0, e.dice));
    for (const [p, d] of perPath) {
      let row = pathRows.get(p);
      if (!row) { row = { path: p, sessionsInTop: 0, dices: [] }; pathRows.set(p, row); }
      row.sessionsInTop++;
      row.dices.push(d);
    }
  }
  const pathsInTop = [...pathRows.values()]
    .map((r) => ({ path: r.path, sessionsInTop: r.sessionsInTop, medianDice: median(r.dices) }))
    .sort((a, b) => b.sessionsInTop - a.sessionsInTop || b.medianDice - a.medianDice
      || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, RANK_LIMIT);
  const m = ok.length;
  const candidate = pathsInTop[0];
  return {
    sessionsTotal: sessions.length,
    sessionsEvaluated: m,
    sessionsSkipped: sessions.filter((s) => s.status === 'skipped').length,
    sessionsError: sessions.filter((s) => s.status === 'error').length,
    skippedReasons: skipped,
    errorClasses,
    bestAggregation,
    coveredSessions: covered,
    singlePathMatchSessions: single,
    comboOnlyMatchSessions: comboOnly,
    pathsInTop,
    verdict: [
      `reply fully covered in stream in ${covered} of ${m} sessions (presence coverage >= ${COVERED_MIN})`,
      `reply reconstructed by one path in ${single} of ${m} sessions (Dice >= ${MATCH_MIN})`,
      `reply reconstructed only by a path combination in ${comboOnly} of ${m} sessions`,
      candidate
        ? `candidate reply field: path ${candidate.path} (top-${TOP_N} in ${candidate.sessionsInTop} of ${m} sessions)`
        : 'candidate reply field: none',
    ],
  };
}

export async function runSearch({
  dataDir = defaultDataDir(), session = null, all = false, host = null, out = null, _testHookAfterRead = null,
} = {}) {
  const root = path.resolve(dataDir);
  if ((session === null) === (all === false)) throw new UsageError('choose exactly one of --session ID or --all');
  if (session !== null && !SESSION_ID_RE.test(session)) throw new UsageError('invalid session id');
  if (out !== null && isInside(canon(out), canon(root))) throw new UsageError('refusing --out inside the data directory');
  assertNotRepoCheckout(root);
  if (!existsSync(root)) throw new GuardError('data directory does not exist (the search never creates it)');
  const sessionsDir = dataPaths(root).sessions;
  let targets;
  if (all) {
    const ids = existsSync(sessionsDir)
      ? readdirSync(sessionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(path.join(sessionsDir, e.name, 'session.json')))
        .map((e) => e.name).sort().reverse()
      : [];
    targets = ids.map((id) => ({ id, dir: path.join(sessionsDir, id) }));
  } else {
    const dir = path.join(sessionsDir, session);
    if (!existsSync(dir)) throw new GuardError(`no session folder "${session}"`);
    targets = [{ id: session, dir }];
  }
  const before = snapshotSessionDirs(targets);
  const sessions = [];
  for (const t of targets) {
    try { sessions.push(await searchSession(t.dir, t.id, { host })); }
    catch (e) { sessions.push({ id: t.id, siteHost: null, status: 'error', errorClass: errorClassOf(e) }); }
  }
  if (_testHookAfterRead) _testHookAfterRead(root);
  const after = snapshotSessionDirs(targets);
  const writes = diffSnapshots(before, after);
  if (writes.length) return { writeDetected: writes, report: null };
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    selection: { mode: all ? 'all' : 'session', host, sessionCount: sessions.length },
    constants: {
      TOP_N, COMBO_N, COVERED_MIN, MATCH_MIN, STRING_CAP, FRAME_CAP, PATH_CAP, INFLATE_CAP,
      aggregations: AGGREGATIONS,
    },
    safety: { readOnly: true, sessionFoldersSnapshotted: targets.length, filesSnapshotted: before.size, writeDetected: false },
    aggregate: aggregate(sessions),
    sessions,
  };
  return { writeDetected: [], report };
}

function renderTable(report) {
  const head = ['ID', 'HOST', 'STREAMS', 'PROTO', 'FRAMES', 'UNDEC', 'COVER', 'BEST PATH', 'AGG', 'DICE', 'COMBO', 'STATUS'];
  const rows = [head];
  for (const s of report.sessions) {
    if (s.status === 'error') { rows.push([s.id, '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', `error:${s.errorClass}`]); continue; }
    if (s.status === 'skipped') { rows.push([s.id, s.siteHost ?? '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', `skipped:${s.reason}`]); continue; }
    const t0 = s.top[0];
    rows.push([
      s.id, s.siteHost ?? '-', String(s.streams), String(s.protoStreams), String(s.framesTotal), String(s.framesUndecodable),
      String(s.streamCoverage), t0 ? t0.path : '-', t0 ? t0.aggregation : '-', t0 ? String(t0.dice) : '-',
      s.bestCombination ? String(s.bestCombination.dice) : '-', 'ok',
    ]);
  }
  const widths = head.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
  const a = report.aggregate;
  lines.push('');
  lines.push(`sessions: ${a.sessionsTotal} (evaluated ${a.sessionsEvaluated}, skipped ${a.sessionsSkipped}, error ${a.sessionsError})`);
  for (const v of a.verdict) lines.push(v);
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const o = { dataDir: null, session: null, all: false, host: null, out: null, json: false, help: false };
  const need = (flag, v) => {
    if (v === undefined || v === '') throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    if (a.startsWith('--') && a.includes('=')) { inline = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (a) {
      case '--data-dir': o.dataDir = need(a, val()); break;
      case '--session': o.session = need(a, val()); break;
      case '--all': o.all = true; break;
      case '--host': o.host = need(a, val()).toLowerCase(); break;
      case '--out': o.out = need(a, val()); break;
      case '--json': o.json = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new UsageError(`unknown argument ${a}`);
    }
  }
  return o;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { stderr.write(`${e.message}\n${USAGE}`); return EXIT_USAGE; }
  if (args.help) { stdout.write(USAGE); return EXIT_OK; }
  let result;
  try {
    result = await runSearch({
      dataDir: args.dataDir ? path.resolve(args.dataDir) : defaultDataDir(),
      session: args.session, all: args.all, host: args.host, out: args.out,
    });
  } catch (e) {
    if (e instanceof UsageError) { stderr.write(`proto-field-search: ${e.message}\n${USAGE}`); return EXIT_USAGE; }
    stderr.write(`proto-field-search: ${e.message}\n`);
    return EXIT_ERROR;
  }
  if (result.writeDetected.length) {
    for (const w of result.writeDetected) stderr.write(`WRITE DETECTED ${w.path} (${w.change})\n`);
    stderr.write('proto-field-search: the touched session folders changed during the run; no report produced\n');
    return EXIT_WRITE;
  }
  const json = `${JSON.stringify(result.report, null, 2)}\n`;
  if (args.out) {
    try { writeFileSync(args.out, json); }
    catch (e) { stderr.write(`proto-field-search: cannot write --out (${errorClassOf(e)})\n`); return EXIT_ERROR; }
  }
  if (args.json) stdout.write(json);
  else stderr.write(renderTable(result.report));
  return EXIT_OK;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
