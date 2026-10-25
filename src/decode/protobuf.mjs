// Schema-less protobuf wire decoder and Connect / gRPC-web envelope splitter.
// Pure functions: no imports from the product, no I/O, no Date, no random.
// Zero dependencies (Node built-ins only: Buffer, TextDecoder).
//
// Layers:
//   splitEnvelopes(buf)      1 flag byte + 4 byte big-endian length + payload (Connect / gRPC-web).
//   decodeProtobuf(buf)      schema-less wire decode into an ordered field tree.
//   flattenProtobuf(tree)    pre-order list of { path, wt, kind, value|len, ambiguous? }.
//   protoStrings(tree)       string leaves in document order.
//   describeProtobuf(tree)   shape only (path + kind + count), no values.
//
// Field nodes: { no, wt, kind, ... } where kind is one of
//   varint   value: decimal string (lossless)
//   fixed64  value: 16 hex digits, unsigned little-endian integer
//   fixed32  value: 8 hex digits, unsigned little-endian integer
//   string   value: UTF-8 text (wire type 2 classified as text)
//   message  fields: nested ordered field list
//   bytes    len, head: first 8 bytes in hex (wire type 2, neither text nor message)
// A string that also parses as a one-field message carries ambiguous: true.

export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_MAX_FIELDS = 20000;

const FLAG_COMPRESSED = 0x01;
const FLAG_END_STREAM = 0x02;
const FLAG_TRAILERS = 0x80;
const KNOWN_FLAGS = FLAG_COMPRESSED | FLAG_END_STREAM | FLAG_TRAILERS;
const MAX_FIELD_NUMBER = 536870911;
const MAX_FIELD_NUMBER_BIG = 536870911n;
const TWO_64 = 1n << 64n;
const HARD_MAX_DEPTH = 64;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const PRINTABLE_RATIO = 0.9;
// Letters, numbers, punctuation, symbols (incl. emoji), separators, marks, format chars (ZWJ),
// plus tab / LF / CR. Controls, private use and unassigned code points are not printable.
const PRINTABLE = /[\p{L}\p{N}\p{P}\p{S}\p{Zs}\p{M}\p{Cf}\t\n\r]/u;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('expected Buffer or Uint8Array');
}

function clampInt(v, lo, hi, dflt) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

// ---------------------------------------------------------------------------------------------
// Connect / gRPC-web envelopes
// ---------------------------------------------------------------------------------------------
// Returns { ok, frames, consumed, leftover, reason? }.
// frames: complete frames, plus at most one trailing frame with complete:false (payload null,
// have = bytes of payload seen so far). The incomplete frame is NOT counted in consumed; the
// caller re-feeds leftover (= buf.subarray(consumed)) with the next chunk.
// ok:false (reason) on unknown flag bits or a length above maxFrameBytes; nothing is allocated
// for the rejected payload.
export function splitEnvelopes(input, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  const buf = asBuffer(input);
  const cap = clampInt(maxFrameBytes, 0, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_FRAME_BYTES);
  const frames = [];
  let pos = 0;
  const finish = (ok, reason) => {
    const out = { ok, frames, consumed: pos, leftover: buf.subarray(pos) };
    if (!ok) { out.reason = reason; out.offset = pos; }
    return out;
  };
  while (buf.length - pos >= 5) {
    const flags = buf[pos];
    const length = buf.readUInt32BE(pos + 1);
    if ((flags & ~KNOWN_FLAGS) !== 0) return finish(false, 'unknown-flags');
    if (length > cap) return finish(false, 'frame-too-large');
    const meta = {
      flags,
      compressed: (flags & FLAG_COMPRESSED) !== 0,
      endStream: (flags & FLAG_END_STREAM) !== 0,
      trailers: (flags & FLAG_TRAILERS) !== 0,
      offset: pos,
      length,
    };
    const end = pos + 5 + length;
    if (end > buf.length) {
      frames.push({ ...meta, payload: null, complete: false, have: buf.length - pos - 5 });
      break;
    }
    frames.push({ ...meta, payload: buf.subarray(pos + 5, end), complete: true });
    pos = end;
  }
  return finish(true);
}

// ---------------------------------------------------------------------------------------------
// Wire-format decode
// ---------------------------------------------------------------------------------------------
// Internal fault. budget:true means a resource cap was hit and must abort the whole decode;
// budget:false means malformed input, which a speculative nested parse absorbs as bytes.
class ProtoFault {
  constructor(reason, budget = false) { this.reason = reason; this.budget = budget; }
}

function readVarint(b, pos, end) {
  let v = 0n;
  let shift = 0n;
  let i = pos;
  for (let k = 0; k < 10; k++) {
    if (i >= end) throw new ProtoFault('truncated-varint');
    const byte = b[i++];
    v |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (v >= TWO_64) throw new ProtoFault('varint-overflow');
      return { v, next: i };
    }
    shift += 7n;
  }
  throw new ProtoFault('varint-too-long');
}

function printableStats(text) {
  let total = 0;
  let good = 0;
  for (const ch of text) {
    total++;
    if (PRINTABLE.test(ch)) good++;
  }
  return { total, good };
}

// Classify one wire-type-2 payload b[s..e) whose containing message sits at `depth`.
function classifyLen(ctx, s, e, depth) {
  const b = ctx.buf;
  const n = e - s;
  if (n === 0) return { kind: 'bytes', len: 0, head: '' };
  let text = null;
  try { text = STRICT_UTF8.decode(b.subarray(s, e)); } catch { text = null; }
  let textOk = false;
  if (text !== null) {
    const ps = printableStats(text);
    textOk = ps.total >= ctx.minStringChars && ps.good >= PRINTABLE_RATIO * ps.total;
  }
  let msg = null;
  if (depth + 1 <= ctx.maxDepth) {
    try {
      msg = parseFields(ctx, s, e, depth + 1, []);
    } catch (err) {
      if (!(err instanceof ProtoFault) || err.budget) throw err;
      msg = null;
    }
  }
  if (textOk) {
    if (msg && msg.length >= 2) return { kind: 'message', fields: msg };
    if (msg && msg.length === 1) return { kind: 'string', value: text, ambiguous: true };
    return { kind: 'string', value: text };
  }
  if (msg && msg.length >= 1) return { kind: 'message', fields: msg };
  return { kind: 'bytes', len: n, head: b.subarray(s, s + Math.min(8, n)).toString('hex') };
}

function parseFields(ctx, start, end, depth, out) {
  const b = ctx.buf;
  let pos = start;
  while (pos < end) {
    const t = readVarint(b, pos, end);
    const no = t.v >> 3n;
    if (no === 0n || no > MAX_FIELD_NUMBER_BIG) throw new ProtoFault('bad-field-number');
    const wt = Number(t.v & 7n);
    const fieldNo = Number(no);
    pos = t.next;
    ctx.work++;
    if (ctx.work > ctx.maxFields) throw new ProtoFault('max-fields', true);
    switch (wt) {
      case 0: {
        const v = readVarint(b, pos, end);
        out.push({ no: fieldNo, wt, kind: 'varint', value: v.v.toString() });
        pos = v.next;
        break;
      }
      case 1: {
        if (end - pos < 8) throw new ProtoFault('truncated-fixed64');
        out.push({ no: fieldNo, wt, kind: 'fixed64', value: b.readBigUInt64LE(pos).toString(16).padStart(16, '0') });
        pos += 8;
        break;
      }
      case 5: {
        if (end - pos < 4) throw new ProtoFault('truncated-fixed32');
        out.push({ no: fieldNo, wt, kind: 'fixed32', value: b.readUInt32LE(pos).toString(16).padStart(8, '0') });
        pos += 4;
        break;
      }
      case 2: {
        const L = readVarint(b, pos, end);
        if (L.v > BigInt(end - L.next)) throw new ProtoFault('length-beyond-buffer');
        const s = L.next;
        const e = s + Number(L.v);
        out.push({ no: fieldNo, wt, ...classifyLen(ctx, s, e, depth) });
        pos = e;
        break;
      }
      case 3:
      case 4:
        throw new ProtoFault('group-wire-type');
      default:
        throw new ProtoFault('invalid-wire-type');
    }
  }
  return out;
}

function treeStats(fields, work) {
  const st = { fields: 0, varint: 0, fixed64: 0, fixed32: 0, string: 0, message: 0, bytes: 0, ambiguous: 0, depth: 0, work };
  const walk = (list, level) => {
    if (level > st.depth) st.depth = level;
    for (const f of list) {
      st.fields++;
      st[f.kind]++;
      if (f.ambiguous) st.ambiguous++;
      if (f.kind === 'message') walk(f.fields, level + 1);
    }
  };
  walk(fields, 1);
  return st;
}

// Returns { ok:true, tree, stats } or { ok:false, reason, tree:null, partial, stats }.
// tree is the ordered top-level field list. On failure, partial holds the top-level fields decoded
// before the failure point. Malformed nested payloads never fail the decode: they fall back to
// string or bytes. Limits: maxDepth (message nesting, root = 1, clamped 1..64), maxFields (total
// field attempts including speculative nested parses), maxBytes (input size).
export function decodeProtobuf(input, opts = {}) {
  const o = opts ?? {};
  const buf = asBuffer(input);
  const maxBytes = clampInt(o.maxBytes, 0, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
  if (buf.length > maxBytes) {
    return { ok: false, reason: 'input-too-large', tree: null, partial: [], stats: treeStats([], 0) };
  }
  const ctx = {
    buf,
    maxDepth: clampInt(o.maxDepth, 1, HARD_MAX_DEPTH, DEFAULT_MAX_DEPTH),
    maxFields: clampInt(o.maxFields, 1, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_FIELDS),
    minStringChars: clampInt(o.minStringChars, 0, Number.MAX_SAFE_INTEGER, 1),
    work: 0,
  };
  const fields = [];
  try {
    parseFields(ctx, 0, buf.length, 1, fields);
  } catch (err) {
    if (!(err instanceof ProtoFault)) throw err;
    return { ok: false, reason: err.reason, tree: null, partial: fields, stats: treeStats(fields, ctx.work) };
  }
  return { ok: true, tree: fields, stats: treeStats(fields, ctx.work) };
}

// ---------------------------------------------------------------------------------------------
// Views over a decoded tree
// ---------------------------------------------------------------------------------------------
// Repeated field numbers at the same level get [i] indexes (0-based among same-number siblings);
// non-repeated field numbers get no index.
export function flattenProtobuf(tree) {
  const out = [];
  const walk = (fields, prefix) => {
    const totals = new Map();
    for (const f of fields) totals.set(f.no, (totals.get(f.no) ?? 0) + 1);
    const seen = new Map();
    for (const f of fields) {
      let seg = String(f.no);
      if (totals.get(f.no) > 1) {
        const i = seen.get(f.no) ?? 0;
        seen.set(f.no, i + 1);
        seg += `[${i}]`;
      }
      const path = prefix ? `${prefix}.${seg}` : seg;
      const e = { path, wt: f.wt, kind: f.kind };
      if (f.kind === 'bytes') e.len = f.len;
      else if (f.kind !== 'message') e.value = f.value;
      if (f.ambiguous) e.ambiguous = true;
      out.push(e);
      if (f.kind === 'message') walk(f.fields, path);
    }
  };
  walk(Array.isArray(tree) ? tree : [], '');
  return out;
}

// String leaves in document order (flatten is pre-order).
export function protoStrings(tree, { minChars = 1 } = {}) {
  return flattenProtobuf(tree)
    .filter((e) => e.kind === 'string' && Array.from(e.value).length >= minChars)
    .map((e) => ({ path: e.path, text: e.value }));
}

// Shape only: index-free path, kind and occurrence count. Never includes values or lengths.
export function describeProtobuf(tree) {
  const map = new Map();
  for (const e of flattenProtobuf(tree)) {
    const path = e.path.replace(/\[\d+\]/g, '');
    const key = `${path}|${e.kind}`;
    const hit = map.get(key);
    if (hit) hit.count++;
    else map.set(key, { path, kind: e.kind, count: 1 });
  }
  return [...map.values()];
}
