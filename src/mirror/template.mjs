// Parameter substitution: variable request fields echoed by the captured response.
//
// When the incoming request differs from the captured one in a path segment, a query value or a
// JSON body leaf at the same position, the captured value is replaced by the incoming value
// wherever it appears in the replayed response (bytes, SSE/NDJSON events, WebSocket frames,
// Location headers). Values shorter than 3 characters and redacted values are never used.
// Replacement is byte-exact on the concatenated body and the original chunk boundaries are
// carried through the edit, so chunk timing is preserved even when a value spans two chunks.
import { splitPath } from './catalog.mjs';
import { flattenLeaves, parseJsonMaybe } from './match.mjs';

const REDACTED = '[redacted]';
const MAX_PAIRS = 64;

function usable(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  if (from === to || from.length < 3 || from === REDACTED || from.includes('***')) return false;
  if (/^(true|false|null|undefined|none|auto|default|get|post)$/i.test(from)) return false;
  return true;
}

function scalar(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v) && String(v).length >= 4) return String(v);
  return null;
}

// [{ from, to, where }]
export function substitutionPairs(inc, ex) {
  const pairs = [], seen = new Set();
  const add = (from, to, where) => {
    if (!usable(from, to) || seen.has(from) || pairs.length >= MAX_PAIRS) return;
    seen.add(from); pairs.push({ from, to, where });
  };
  const capSegs = splitPath(ex.path);
  if (capSegs.length === inc.segs.length) {
    for (let i = 0; i < capSegs.length; i++) {
      let a = capSegs[i], b = inc.segs[i];
      try { a = decodeURIComponent(a); b = decodeURIComponent(b); } catch { /* keep raw */ }
      add(a, b, `path[${i}]`);
    }
  }
  const capQ = new Map(ex.query);
  for (const [k, v] of inc.query) if (capQ.has(k)) add(capQ.get(k), v, `query.${k}`);
  if (inc.json !== undefined && ex.postData !== undefined) {
    const capJson = ex._json?.v ?? parseJsonMaybe(ex.postData);
    if (capJson !== undefined) {
      const A = flattenLeaves(capJson), B = flattenLeaves(inc.json);
      for (const [p, v] of A) {
        if (!B.has(p)) continue;
        const a = scalar(v), b = scalar(B.get(p));
        if (a !== null && b !== null) add(a, b, `body${p}`);
      }
    }
  }
  // Longest first so a value never clobbers a longer value that contains it.
  return pairs.sort((x, y) => y.from.length - x.from.length);
}

// Pairs from a client message vs. the captured trigger message (WebSocket turns).
export function messagePairs(incomingText, capturedText) {
  const a = parseJsonMaybe(capturedText), b = parseJsonMaybe(incomingText);
  if (a === undefined || b === undefined) return [];
  const pairs = [], seen = new Set();
  const A = flattenLeaves(a), B = flattenLeaves(b);
  for (const [p, v] of A) {
    if (!B.has(p)) continue;
    const x = scalar(v), y = scalar(B.get(p));
    if (x !== null && y !== null && usable(x, y) && !seen.has(x)) { seen.add(x); pairs.push({ from: x, to: y, where: `msg${p}` }); }
    if (pairs.length >= MAX_PAIRS) break;
  }
  return pairs.sort((x, y) => y.from.length - x.from.length);
}

// Byte-level variants: raw and JSON-string-escaped (for values echoed inside JSON strings).
function byteVariants(pairs) {
  const out = [];
  for (const { from, to } of pairs) {
    out.push({ from: Buffer.from(from), to: Buffer.from(to) });
    const ef = JSON.stringify(from).slice(1, -1), et = JSON.stringify(to).slice(1, -1);
    if (ef !== from) out.push({ from: Buffer.from(ef), to: Buffer.from(et) });
    else if (et !== to) out[out.length - 1].toJson = Buffer.from(et);
  }
  return out.sort((x, y) => y.from.length - x.from.length);
}

// Apply pairs across ordered chunks. Returns { parts: Buffer[] (same count), count }.
// json: when true, a raw value is inserted JSON-escaped (the response is a JSON-bearing stream).
export function substituteParts(parts, pairs, { json = false } = {}) {
  if (!pairs?.length || !parts.length) return { parts, count: 0 };
  const variants = byteVariants(pairs);
  const full = Buffer.concat(parts);
  const matches = [];
  for (const v of variants) {
    let i = 0;
    while ((i = full.indexOf(v.from, i)) !== -1) { matches.push({ start: i, end: i + v.from.length, to: json && v.toJson ? v.toJson : v.to }); i += v.from.length; }
  }
  if (!matches.length) return { parts, count: 0 };
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  let lastEnd = -1;
  for (const m of matches) if (m.start >= lastEnd) { kept.push(m); lastEnd = m.end; }
  // Rebuild and map every original boundary into the edited buffer.
  const pieces = [];
  let cur = 0;
  for (const m of kept) { pieces.push(full.subarray(cur, m.start), m.to); cur = m.end; }
  pieces.push(full.subarray(cur));
  const edited = Buffer.concat(pieces);
  const bounds = [];
  let acc = 0;
  for (const p of parts) { acc += p.length; bounds.push(acc); }
  const mapped = bounds.map((b) => {
    let shift = 0, pos = b;
    for (const m of kept) {
      if (m.end <= b) shift += m.to.length - (m.end - m.start);
      else if (m.start < b) { pos = m.end; shift += m.to.length - (m.end - m.start); }
      else break;
    }
    return pos + shift;
  });
  const outParts = [];
  let prev = 0;
  for (const b of mapped) { const e = Math.max(prev, Math.min(b, edited.length)); outParts.push(edited.subarray(prev, e)); prev = e; }
  if (prev < edited.length) outParts[outParts.length - 1] = Buffer.concat([outParts[outParts.length - 1], edited.subarray(prev)]);
  return { parts: outParts, count: kept.length };
}

export function substituteText(text, pairs, { json = false } = {}) {
  if (!pairs?.length || typeof text !== 'string') return { text, count: 0 };
  const r = substituteParts([Buffer.from(text)], pairs, { json });
  return { text: r.count ? r.parts[0].toString('utf8') : text, count: r.count };
}
