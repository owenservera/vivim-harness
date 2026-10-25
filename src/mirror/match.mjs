// Request -> captured exchange matching by similarity scoring.
//
// Score (0..100, plus small bonuses):
//   method 20   same method (HEAD~GET counts 15)
//   path   45   exact path, else per-segment equality with id-like segments treated as variables
//   query  15   key Jaccard + value agreement (cache-buster keys ignored, redacted values wildcard)
//   body   15   JSON leaf-path Jaccard + leaf value agreement, or token Jaccard for text
//   host   +-5  only when the client names a host (absolute-form proxy URL or x-mirror-host)
// "how": exact (everything equal) | route (same method + templated path) | nearest (fallback).
// Among equally good candidates the least-used one in capture order wins, so a repeated call
// replays successive captures of the same endpoint (polling, multi-turn conversations).
import { splitPath, isIdLike } from './catalog.mjs';

const WEIGHTS = { method: 20, path: 45, query: 15, body: 15 };
const IGNORED_QUERY = new Set(['_', 't', 'ts', 'cb', '_t', '_ts', 'timestamp', 'nocache', 'rand', 'r', 'cachebust', '_cb', 'v']);
const REDACTED = '[redacted]';

export function parseJsonMaybe(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

// Normalised view of an incoming request. `controls` collects __mirror_* query parameters,
// which steer the mirror and never take part in matching.
export function parseIncoming(req, body = Buffer.alloc(0)) {
  const raw = req.url ?? '/';
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let u;
  try { u = new URL(absolute ? raw : raw.startsWith('/') ? raw : `/${raw}`, 'http://mirror.invalid'); } catch { u = new URL('http://mirror.invalid/'); }
  const controls = {};
  for (const k of [...u.searchParams.keys()]) {
    if (k.startsWith('__mirror_')) { controls[k.slice(9)] = u.searchParams.get(k); u.searchParams.delete(k); }
  }
  const hostHint = absolute ? u.host : (req.headers['x-mirror-host'] || controls.host || null);
  const bodyText = body.length ? body.toString('utf8') : '';
  const isWs = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
  return {
    method: String(req.method ?? 'GET').toUpperCase(), kind: isWs ? 'ws' : 'http',
    path: u.pathname || '/', segs: splitPath(u.pathname), query: [...u.searchParams.entries()],
    search: u.search, hostHint: hostHint ? String(hostHint).toLowerCase() : null,
    headers: req.headers, body, bodyText, json: parseJsonMaybe(bodyText), controls,
  };
}

// ---------------------------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------------------------
function methodScore(a, b) {
  if (a === b) return 1;
  if ((a === 'HEAD' && b === 'GET') || (a === 'GET' && b === 'HEAD')) return 0.75;
  return 0;
}

export function pathScore(a, b) {
  const ja = a.join('/'), jb = b.join('/');
  if (ja === jb) return { score: 1, exact: true, template: true };
  if (a.length === b.length && a.length > 0) {
    let sum = 0, template = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) sum += 1;
      else if (b[i] === REDACTED || b[i] === '{id}' || (isIdLike(a[i]) && isIdLike(b[i]))) sum += 0.85;
      else { template = false; if (a[i].toLowerCase() === b[i].toLowerCase()) sum += 0.9; }
    }
    return { score: (sum / a.length) * (template ? 1 : 0.7), exact: false, template };
  }
  const n = Math.min(a.length, b.length), m = Math.max(a.length, b.length) || 1;
  let p = 0;
  while (p < n && (a[p] === b[p] || (isIdLike(a[p]) && isIdLike(b[p])))) p++;
  return { score: 0.5 * (p / m), exact: false, template: false };
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function queryScore(inc, cap) {
  const A = new Map(inc.filter(([k]) => !IGNORED_QUERY.has(k)));
  const B = new Map(cap.filter(([k]) => !IGNORED_QUERY.has(k)));
  if (!A.size && !B.size) return 1;
  const keyJ = jaccard(new Set(A.keys()), new Set(B.keys()));
  let shared = 0, same = 0;
  for (const [k, v] of A) {
    if (!B.has(k)) continue;
    shared++;
    const w = B.get(k);
    if (w === v || w === REDACTED) same++;
    else if (isIdLike(v) && isIdLike(w)) same += 0.5;
  }
  return 0.6 * keyJ + 0.4 * (shared ? same / shared : 0);
}

export function flattenLeaves(node, out = new Map(), p = '', limit = 600) {
  if (out.size >= limit) return out;
  if (node === null || typeof node !== 'object') { out.set(p || '$', node); return out; }
  const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
  if (!entries.length) out.set(p || '$', Array.isArray(node) ? '[]' : '{}');
  for (const [k, v] of entries) flattenLeaves(v, out, `${p}/${k}`, limit);
  return out;
}

function tokens(text, limit = 4000) {
  const s = new Set();
  for (const m of String(text).toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) { s.add(m[0]); if (s.size >= limit) break; }
  return s;
}

export function jsonSimilarity(a, b) {
  const A = flattenLeaves(a), B = flattenLeaves(b);
  const keyJ = jaccard(new Set(A.keys()), new Set(B.keys()));
  let shared = 0, same = 0;
  for (const [k, v] of A) {
    if (!B.has(k)) continue;
    shared++;
    const w = B.get(k);
    if (w === v || w === REDACTED) same++;
    else if (typeof v === 'string' && typeof w === 'string' && isIdLike(v) && isIdLike(w)) same += 0.5;
  }
  return 0.6 * keyJ + 0.4 * (shared ? same / shared : 0);
}

export function textSimilarity(a, b) {
  if (a === b) return 1;
  const ja = parseJsonMaybe(a), jb = parseJsonMaybe(b);
  if (ja !== undefined && jb !== undefined) return jsonSimilarity(ja, jb);
  return jaccard(tokens(a), tokens(b));
}

export function bodyScore(inc, ex) {
  const cap = ex.postData;
  const incEmpty = !inc.bodyText, capEmpty = cap === undefined || cap === '';
  if (incEmpty && capEmpty) return ex.hasPostData && cap === undefined ? 0.6 : 1; // body existed but was not recorded
  if (incEmpty || capEmpty) return cap === undefined && ex.hasPostData ? 0.5 : 0.2;
  if (inc.bodyText === cap) return 1;
  ex._json ??= { v: parseJsonMaybe(cap) };
  if (inc.json !== undefined && ex._json.v !== undefined) return jsonSimilarity(inc.json, ex._json.v);
  return jaccard(tokens(inc.bodyText), tokens(cap));
}

export function scoreExchange(inc, ex) {
  const m = methodScore(inc.method, ex.method);
  const p = pathScore(inc.segs, ex._segs ??= splitPath(ex.path));
  const q = queryScore(inc.query, ex.query);
  const b = inc.kind === 'ws' ? 1 : bodyScore(inc, ex);
  let total = WEIGHTS.method * m + WEIGHTS.path * p.score + WEIGHTS.query * q + WEIGHTS.body * b;
  if (inc.hostHint && ex.host) total += inc.hostHint === ex.host.toLowerCase() ? 5 : -5;
  // Prefer captures that can actually be replayed.
  const hasPayload = ex.bytes > 0 || ex.esMessages > 0 || ex.framesIn > 0;
  if (hasPayload) total += 2;
  if (!hasPayload && (ex.outcome === 'failed' || ex.outcome === 'canceled')) total -= 3;
  const how = m === 1 && p.exact && q > 0.999 && b > 0.999 ? 'exact' : m >= 0.75 && p.template ? 'route' : 'nearest';
  return { total: Math.round(total * 100) / 100, how, parts: { method: m, path: Math.round(p.score * 1000) / 1000, query: Math.round(q * 1000) / 1000, body: Math.round(b * 1000) / 1000 } };
}

export function summarize(ex, s) {
  return { sid: ex.sid, id: ex.id, route: ex.routeKey, kind: ex.routeKind, score: s.total, how: s.how, parts: s.parts };
}

// Best captured exchange for an incoming request, or null with the nearest alternatives.
export function findMatch(catalog, inc, { minScore = 35, fallback = true } = {}) {
  const wantWs = inc.kind === 'ws';
  const scored = [];
  for (const ex of catalog.exchanges) {
    if ((ex.kind === 'ws') !== wantWs) continue;
    scored.push({ ex, s: scoreExchange(inc, ex) });
  }
  if (!scored.length) return { match: null, alternatives: [] };
  scored.sort((x, y) => y.s.total - x.s.total || x.ex.order - y.ex.order);
  const best = scored[0];
  // Equivalent candidates: same route, within half a point. Least-used first, then capture order.
  const pool = scored.filter((c) => c.ex.routeKey === best.ex.routeKey && best.s.total - c.s.total <= 0.5);
  pool.sort((x, y) => x.ex.uses - y.ex.uses || x.ex.order - y.ex.order);
  const chosen = pool[0];
  const alternatives = scored.slice(0, 4).map((c) => summarize(c.ex, c.s));
  if (chosen.s.total < minScore) return { match: null, alternatives, reason: 'below_min_score' };
  if (!fallback && chosen.s.how === 'nearest') return { match: null, alternatives, reason: 'no_route_match' };
  return { match: { ex: chosen.ex, score: chosen.s }, alternatives };
}
