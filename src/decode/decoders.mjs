// Incremental L2 decoders. Each consumes raw L1 bytes for one stream, in order, and yields
// protocol envelopes WITHOUT dropping unknown fields. Every event carries the byte span it was
// decoded from, so the studio can link raw bytes <-> parsed events.
//
// Decoder families:
//   SseDecoder          text/event-stream (byte-exact line framing, id/retry continuity)
//   NdjsonDecoder       newline-delimited JSON (tolerant: re-joins pretty-printed records)
//   ChunkedJsonDecoder  concatenated / progressively streamed JSON values, no framing at all
//   JsonSeqDecoder      RFC 7464 record-separator framed JSON (0x1e)
//   LengthPrefixedDecoder  "<len>\n<payload>" and netstring "<len>:<payload>," framing
//   GrpcFrameDecoder    gRPC / gRPC-Web length-prefixed message frames (1+4 byte prefix)
//   WholeBodyDecoder    non-incremental bodies (json/html/text/binary)
//   CsvRowDecoder       CSV tables (declared text/csv, or sniffed plain-text CSV)
//   AutoDecoder         re-sniffs the first bytes and switches decoder before any event is emitted
//   WsFrameDecoder      WebSocket frames incl. continuation reassembly + app-protocol decoding
//
// Nothing here is site specific: every recogniser keys off wire shape, never off a hostname.

import { CsvDecoder, sniffDelimiter } from './csv.mjs';
import { decodeProtobuf, protoStrings } from './protobuf.mjs';
import { createProtoFeatureExtractor } from './proto-features.mjs';
import { gunzipSync, inflateSync, inflateRawSync } from 'node:zlib';

export const NL = 0x0a, CR = 0x0d, RS = 0x1e, TAB = 0x09, SP = 0x20;

const isWs = (b) => b === SP || b === TAB || b === NL || b === CR;

export function parseJsonSafe(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (!t) return undefined;
  const c = t[0];
  if (c !== '{' && c !== '[' && c !== '"' && !(c === '-' || (c >= '0' && c <= '9')) && t !== 'true' && t !== 'false' && t !== 'null') return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

// Back-compat alias for the original private helper.
const tryJson = (t) => {
  if (typeof t !== 'string') return undefined;
  const s = t.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[' && s[0] !== '"')) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
};

// ---------------------------------------------------------------------------------------------
// Byte-level line splitter honoring \n, \r\n and \r (as the SSE spec requires).
// ---------------------------------------------------------------------------------------------
export class LineSplitter {
  constructor() { this.buf = Buffer.alloc(0); this.offset = 0; }
  // A CR that is the last byte of the available data is NOT consumed: its line stays held in buf
  // until the next byte shows whether an LF follows (so a CRLF split across chunks keeps the exact
  // span of the LF) or the stream ends (finish()).
  push(chunk) {
    const lines = [];
    const data = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const base = this.offset;
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (b !== NL && b !== CR) continue;
      if (b === CR && i + 1 === data.length) break;
      const crlf = b === CR && data[i + 1] === NL;
      const end = i + (crlf ? 2 : 1);
      lines.push({ line: data.subarray(start, i), start: base + start, end: base + end });
      if (crlf) i++;
      start = end;
    }
    this.buf = Buffer.from(data.subarray(start));
    this.offset = base + start;
    return lines;
  }
  rest() { return this.buf.length ? { line: this.buf, start: this.offset, end: this.offset + this.buf.length } : null; }
  // End of stream: a held CR-terminated line is complete (CR terminates a line), so it is returned
  // as a normal line with its exact span. Returns [] when nothing is held or the held bytes do not
  // end in CR (callers then use rest(), exactly as before).
  finish() {
    const n = this.buf.length;
    if (!n || this.buf[n - 1] !== CR) return [];
    const start = this.offset, end = this.offset + n;
    const line = this.buf.subarray(0, n - 1);
    this.buf = Buffer.alloc(0);
    this.offset = end;
    return [{ line, start, end }];
  }
}

// ---------------------------------------------------------------------------------------------
// Incremental top-level JSON value scanner.
// Emits every complete JSON value found in a byte stream, regardless of framing: concatenated
// objects ({}{}{}), whitespace/comma separated values, RFC 7464 records, and progressively
// streamed arrays ([{..},{..}  <- items emitted before the array closes).
// ---------------------------------------------------------------------------------------------
export class JsonStreamScanner {
  constructor({ unwrapArray = 'auto', maxValueBytes = 64 * 1024 * 1024 } = {}) {
    this.unwrapArray = unwrapArray;   // true | false | 'auto' (unwrap when items are objects/arrays)
    this.maxValueBytes = maxValueBytes;
    this.tail = Buffer.alloc(0);
    this.absBase = 0;      // absolute offset of tail[0]
    this.scanPos = 0;
    this.started = false;
    this.vStart = 0;
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.kind = null;      // 'container' | 'string' | 'bare'
    this.unwrapped = false;
    this.truncated = 0;
    this.arrayDepth = 0;
  }

  _abs(i) { return this.absBase + i; }

  push(chunk) {
    if (chunk && chunk.length) this.tail = this.tail.length ? Buffer.concat([this.tail, chunk]) : Buffer.from(chunk);
    const out = [];
    let i = this.scanPos;
    const emit = (endIdx, flags) => {
      const raw = this.tail.subarray(this.vStart, endIdx);
      out.push({ text: raw.toString('utf8'), start: this._abs(this.vStart), end: this._abs(endIdx), ...flags });
      this.started = false; this.kind = null; this.depth = 0; this.inString = false; this.escape = false;
    };
    while (i < this.tail.length) {
      const b = this.tail[i];
      if (!this.started) {
        if (isWs(b) || b === 0x2c || b === RS || b === 0x00) { i++; continue; }
        if (b === 0x5d && this.unwrapped) { this.unwrapped = false; i++; continue; }  // ] closes an unwrapped array
        if (b === 0x5b && !this.unwrapped && this.unwrapArray !== false) {
          let j = i + 1;
          while (j < this.tail.length && isWs(this.tail[j])) j++;
          if (j >= this.tail.length) break;                 // need more bytes to decide
          const n = this.tail[j];
          if (n === 0x5d) { i = j + 1; continue; }           // empty array: skip
          if (this.unwrapArray === true || n === 0x7b || n === 0x5b) { this.unwrapped = true; i = j; continue; }
        }
        this.started = true; this.vStart = i; this.depth = 0; this.inString = false; this.escape = false;
        this.kind = (b === 0x7b || b === 0x5b) ? 'container' : b === 0x22 ? 'string' : 'bare';
        continue;
      }
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (b === 0x5c) this.escape = true;
        else if (b === 0x22) {
          this.inString = false;
          if (this.kind === 'string' && this.depth === 0) { emit(i + 1); i++; continue; }
        }
        i++;
        continue;
      }
      if (b === 0x22) { this.inString = true; i++; continue; }
      if (b === 0x7b || b === 0x5b) { this.depth++; i++; continue; }
      if (b === 0x7d || b === 0x5d) {
        this.depth--; i++;
        if (this.depth <= 0) emit(i);
        continue;
      }
      if (this.kind === 'bare' && (isWs(b) || b === 0x2c || b === RS || b === 0x5d || b === 0x7d)) { emit(i); continue; }
      i++;
      if (this.maxValueBytes && i - this.vStart > this.maxValueBytes) { this.truncated++; emit(i, { truncated: true }); }
    }
    // Compact: drop everything already consumed.
    const keepFrom = this.started ? this.vStart : i;
    if (keepFrom > 0) { this.tail = Buffer.from(this.tail.subarray(keepFrom)); this.absBase += keepFrom; i -= keepFrom; this.vStart -= keepFrom; }
    this.scanPos = Math.max(0, i);
    return out;
  }

  rest() {
    if (!this.started || this.vStart >= this.tail.length) return null;
    const raw = this.tail.subarray(this.vStart);
    if (!raw.length) return null;
    return { text: raw.toString('utf8'), start: this._abs(this.vStart), end: this._abs(this.tail.length), incomplete: true };
  }
}

// ---------------------------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------------------------
const SSE_TERMINAL_DATA = new Set(['[DONE]', 'DONE', '[done]', 'done', '"[DONE]"']);
const SSE_TERMINAL_EVENT = /^(done|complete|completed|end|close|closed|finish|finished|stream_end|message_stop|response\.completed)$/i;
const HEARTBEAT_TEXT = new Set(['', 'ping', 'PING', 'pong', 'PONG', 'heartbeat', 'keepalive', 'keep-alive', 'h', '{}', '[]', '2', '3', '0', '\n']);

export class SseDecoder {
  constructor({ bomStrip = true } = {}) {
    this.kind = 'sse';
    this.lines = new LineSplitter();
    this._reset();
    this.count = 0;
    this.bomStrip = bomStrip;
    this._bomDone = false;
    this.lastEventId = undefined;
    this.retry = undefined;
    this.stats = { events: 0, comments: 0, heartbeats: 0, dataLines: 0, unknownFields: 0 };
  }
  _reset() { this.cur = { data: [], event: undefined, id: undefined, retry: undefined, comments: [], unknown: {}, start: null }; }
  _dispatch(end) {
    const c = this.cur;
    const hasContent = c.data.length || c.event !== undefined || c.id !== undefined || c.retry !== undefined || c.comments.length || Object.keys(c.unknown).length;
    this._reset();
    if (!hasContent) return null;
    const data = c.data.join('\n');
    const ev = { type: 'sse', event: c.event ?? 'message', data, span: [c.start, end], index: this.count++ };
    if (c.id !== undefined) { ev.id = c.id; this.lastEventId = c.id; }
    else if (this.lastEventId !== undefined) ev.lastEventId = this.lastEventId;
    if (c.retry !== undefined) { ev.retry = c.retry; if (typeof c.retry === 'number') this.retry = c.retry; }
    if (c.comments.length) ev.comments = c.comments;
    if (Object.keys(c.unknown).length) { ev.unknownFields = c.unknown; this.stats.unknownFields++; }
    const env = sniffEnvelope(data);
    if (env?.json !== undefined) ev.json = env.json;
    if (env?.envelope && !env.headerOnly) ev.envelope = env.envelope;
    const trimmed = data.trim();
    if (SSE_TERMINAL_DATA.has(trimmed) || SSE_TERMINAL_EVENT.test(String(ev.event))) ev.terminal = true;
    if (!c.data.length && !c.event && c.comments.length) { ev.type = 'sse.comment'; this.stats.comments++; }
    if (HEARTBEAT_TEXT.has(trimmed) && !ev.terminal) { ev.heartbeat = true; this.stats.heartbeats++; }
    const nested = ev.json !== undefined ? unwrapNestedJson(ev.json) : null;
    if (nested) ev.jsonNested = nested;
    this.stats.events++;
    return ev;
  }
  push(chunk) {
    const out = [];
    let buf = chunk;
    if (this.bomStrip && !this._bomDone) {
      this._bomDone = true;
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
    }
    this._feed(this.lines.push(buf), out);
    return out;
  }
  _feed(lines, out) {
    for (const { line, start, end } of lines) {
      if (this.cur.start === null) this.cur.start = start;
      if (line.length === 0) { const e = this._dispatch(end); if (e) out.push(e); continue; }
      const s = line.toString('utf8');
      if (s[0] === ':') { this.cur.comments.push(s.slice(1).replace(/^ /, '')); continue; }
      const colon = s.indexOf(':');
      const field = colon === -1 ? s : s.slice(0, colon);
      const value = colon === -1 ? '' : s.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') { this.cur.data.push(value); this.stats.dataLines++; }
      else if (field === 'event') this.cur.event = value;
      else if (field === 'id') this.cur.id = value;
      else if (field === 'retry') this.cur.retry = /^\d+$/.test(value) ? Number(value) : value;
      else (this.cur.unknown[field] ??= []).push(value);
    }
  }
  end() {
    const out = [];
    const held = this.lines.finish();
    if (held.length) this._feed(held, out);
    else if (this.lines.rest()) out.push(...this.push(Buffer.from('\n')));
    if (this.cur.start !== null) {
      const e = this._dispatch(this.lines.offset);
      if (e) { e.incomplete = true; out.push(e); }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// NDJSON (tolerant: consecutive unparsed lines that start a JSON value are re-joined, so
// pretty-printed "newline delimited" payloads still decode into one event per record).
// ---------------------------------------------------------------------------------------------
export class NdjsonDecoder {
  constructor({ coalesce = true, maxHoldBytes = 4 * 1024 * 1024 } = {}) {
    this.kind = 'ndjson';
    this.lines = new LineSplitter();
    this.count = 0;
    this.coalesce = coalesce;
    this.maxHoldBytes = maxHoldBytes;
    this.hold = null; // { text, start, end }
    this.stats = { events: 0, unparsed: 0, coalesced: 0, heartbeats: 0 };
  }
  _mk(text, start, end, extra = {}) {
    const ev = { type: 'ndjson', text, span: [start, end], index: this.count++, ...extra };
    const env = sniffEnvelope(text);
    if (env?.json !== undefined) ev.json = env.json; else { ev.unparsed = true; this.stats.unparsed++; }
    if (env?.envelope) ev.envelope = env.envelope;
    if (HEARTBEAT_TEXT.has(text.trim())) { ev.heartbeat = true; this.stats.heartbeats++; }
    const nested = ev.json !== undefined ? unwrapNestedJson(ev.json) : null;
    if (nested) ev.jsonNested = nested;
    this.stats.events++;
    return ev;
  }
  _line({ line, start, end }, incomplete = false) {
    const text = line.toString('utf8');
    const out = [];
    if (this.hold) {
      const joined = this.hold.text + '\n' + text;
      if (parseJsonSafe(joined) !== undefined) {
        const ev = this._mk(joined, this.hold.start, end, { coalescedLines: this.hold.lines + 1 });
        this.stats.coalesced++;
        this.hold = null;
        if (incomplete) ev.incomplete = true;
        out.push(ev);
        return out;
      }
      if (Buffer.byteLength(joined) > this.maxHoldBytes) {
        out.push(this._mk(this.hold.text, this.hold.start, this.hold.end, { unjoinable: true }));
        this.hold = null;
      } else {
        this.hold = { text: joined, start: this.hold.start, end, lines: this.hold.lines + 1 };
        if (incomplete) { const ev = this._mk(this.hold.text, this.hold.start, this.hold.end, { incomplete: true }); this.hold = null; out.push(ev); }
        return out;
      }
    }
    if (!text.trim()) return out;
    const parsed = parseJsonSafe(text);
    if (parsed === undefined && this.coalesce && !incomplete && /^\s*[{[]/.test(text)) {
      this.hold = { text, start, end, lines: 1 };
      return out;
    }
    const ev = this._mk(text, start, end);
    if (incomplete) ev.incomplete = true;
    out.push(ev);
    return out;
  }
  push(chunk) {
    const out = [];
    for (const l of this.lines.push(chunk)) out.push(...this._line(l));
    return out;
  }
  end() {
    const out = [];
    const held = this.lines.finish();
    if (held.length) { for (const l of held) out.push(...this._line(l)); }
    else { const r = this.lines.rest(); if (r) out.push(...this._line(r, true)); }
    if (this.hold) { out.push(this._mk(this.hold.text, this.hold.start, this.hold.end, { incomplete: true })); this.hold = null; }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Framing-free JSON stream (concatenated values, progressive arrays) and RFC 7464 json-seq.
// ---------------------------------------------------------------------------------------------
export class ChunkedJsonDecoder {
  // maxBytes (0 = unlimited): a value whose span is larger is emitted as an oversize marker with
  // no text and no parsed json. Only the live recorder sets it (see reducer jsonMaxBytes).
  constructor({ kind = 'chunked-json', unwrapArray = 'auto', maxBytes = 0 } = {}) {
    this.kind = kind;
    this.scanner = new JsonStreamScanner({ unwrapArray });
    this.maxBytes = maxBytes;
    this.count = 0;
    this.stats = { events: 0, unparsed: 0, heartbeats: 0, oversize: 0 };
  }
  _mk(v, extra = {}) {
    const type = this.kind === 'jsonseq' ? 'jsonseq' : 'json.value';
    if (this.maxBytes && v.end - v.start > this.maxBytes) {
      const over = { type, oversize: true, bytes: v.end - v.start, span: [v.start, v.end], index: this.count++, ...extra };
      if (v.truncated) over.truncated = true;
      if (v.incomplete) over.incomplete = true;
      this.stats.oversize++; this.stats.events++;
      return over;
    }
    const ev = { type, text: v.text, span: [v.start, v.end], index: this.count++, ...extra };
    const json = parseJsonSafe(v.text);
    if (json !== undefined) ev.json = json; else { ev.unparsed = true; this.stats.unparsed++; }
    if (v.truncated) ev.truncated = true;
    if (v.incomplete) ev.incomplete = true;
    if (HEARTBEAT_TEXT.has(v.text.trim())) { ev.heartbeat = true; this.stats.heartbeats++; }
    const nested = ev.json !== undefined ? unwrapNestedJson(ev.json) : null;
    if (nested) ev.jsonNested = nested;
    this.stats.events++;
    return ev;
  }
  push(chunk) { return this.scanner.push(chunk).map((v) => this._mk(v)); }
  end() {
    const out = this.scanner.push(Buffer.alloc(0)).map((v) => this._mk(v));
    const r = this.scanner.rest();
    if (r) out.push(this._mk(r, { incomplete: true }));
    return out;
  }
}

export class JsonSeqDecoder extends ChunkedJsonDecoder {
  constructor(opts = {}) { super({ kind: 'jsonseq', unwrapArray: false, ...opts }); }
}

// ---------------------------------------------------------------------------------------------
// Length-prefixed text framing: "<len>\n<payload>" (hex or decimal) and netstrings
// "<len>:<payload>,". Both appear in long-poll and custom RPC transports.
// ---------------------------------------------------------------------------------------------
export class LengthPrefixedDecoder {
  constructor({ style = 'auto' } = {}) {
    this.kind = 'length-prefixed';
    this.style = style;      // 'auto' | 'newline' | 'netstring'
    this.buf = Buffer.alloc(0);
    this.base = 0;
    this.count = 0;
    this.stats = { events: 0, unparsed: 0, desync: 0 };
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      const head = this.buf.subarray(0, 32).toString('latin1');
      let m;
      if ((this.style === 'auto' || this.style === 'netstring') && (m = /^(\d{1,9}):/.exec(head))) {
        const len = Number(m[1]); const start = m[0].length;
        if (this.buf.length < start + len + 1) break;
        out.push(this._mk(this.buf.subarray(start, start + len), start + len + 1, 'netstring'));
        continue;
      }
      if ((this.style === 'auto' || this.style === 'newline') && (m = /^([0-9a-fA-F]{1,9})\r?\n/.exec(head))) {
        const len = parseInt(m[1], /^[0-9]+$/.test(m[1]) ? 10 : 16); const start = m[0].length;
        if (!Number.isFinite(len) || len < 0) { this.stats.desync++; break; }
        if (this.buf.length < start + len) break;
        out.push(this._mk(this.buf.subarray(start, start + len), start + len, 'newline'));
        continue;
      }
      break;
    }
    return out;
  }
  _mk(payload, consumed, style) {
    const text = payload.toString('utf8');
    const ev = { type: 'framed', framing: style, text, span: [this.base, this.base + consumed], index: this.count++ };
    const env = sniffEnvelope(text);
    if (env?.json !== undefined) ev.json = env.json;
    if (env?.envelope) ev.envelope = env.envelope;
    if (ev.json === undefined) { ev.unparsed = true; this.stats.unparsed++; }
    if (HEARTBEAT_TEXT.has(text.trim())) ev.heartbeat = true;
    this.buf = Buffer.from(this.buf.subarray(consumed));
    this.base += consumed;
    this.stats.events++;
    return ev;
  }
  end() {
    if (!this.buf.length) return [];
    const text = this.buf.toString('utf8');
    const ev = { type: 'framed', framing: this.style, text, span: [this.base, this.base + this.buf.length], index: this.count++, incomplete: true };
    const env = sniffEnvelope(text);
    if (env?.json !== undefined) ev.json = env.json;
    this.buf = Buffer.alloc(0);
    return [ev];
  }
}

// ---------------------------------------------------------------------------------------------
// gRPC / gRPC-Web / Connect message frames: 1 byte flags + 4 byte big-endian length.
// Framing, sizes, trailers and printable strings are always recovered (raw payload). For
// non-end-stream data frames the payload is additionally:
//   compressed (0x01): inflated with gunzip, then zlib inflate, then raw deflate (first success
//     wins; never throws). Event gets compression: 'gzip' | 'deflate' | 'deflate-raw' | 'undecodable'.
//   protobuf: decoded schema-less (src/decode/protobuf.mjs) when the response mime contains
//     'proto' or the payload is not JSON text. Event gets proto: { ok, strings, fieldCount, truncated }
//     or { ok: false, reason }.
// End-stream frames (0x02, Connect JSON trailer) and trailer frames (0x80) keep their exact shape.
// ---------------------------------------------------------------------------------------------
const INFLATE_MAX_BYTES = 16 * 1024 * 1024;   // hard cap on inflated size (zlib maxOutputLength)
const PROTO_MAX_STRINGS = 64;                 // per event: bounds persisted size (events dataset)
const PROTO_MAX_CHARS = 4000;                 // per string, in code points (no split surrogates)
const INFLATERS = [['gzip', gunzipSync], ['deflate', inflateSync], ['deflate-raw', inflateRawSync]];

// Returns { method, bytes } with bytes null when no inflater accepts the payload.
function inflateFrame(payload) {
  for (const [method, fn] of INFLATERS) {
    try { return { method, bytes: fn(payload, { maxOutputLength: INFLATE_MAX_BYTES }) }; } catch { /* next */ }
  }
  return { method: 'undecodable', bytes: null };
}

// Bounded view of a decoded protobuf body. Oversize (live cap) is decided before decoding.
function protoView(body, cap) {
  if (cap && body.length > cap) return { ok: false, reason: 'oversize' };
  let r;
  try { r = decodeProtobuf(body); } catch { return { ok: false, reason: 'decode-error' }; }
  if (!r.ok) return { ok: false, reason: r.reason };
  const strings = [];
  let truncated = false;
  for (const s of protoStrings(r.tree)) {
    if (strings.length >= PROTO_MAX_STRINGS) { truncated = true; break; }
    let text = s.text;
    if (text.length > PROTO_MAX_CHARS) {
      const chars = Array.from(text);
      if (chars.length > PROTO_MAX_CHARS) { text = chars.slice(0, PROTO_MAX_CHARS).join(''); truncated = true; }
    }
    strings.push({ path: s.path, text });
  }
  return { ok: true, strings, fieldCount: r.stats.fields, truncated };
}

export class GrpcFrameDecoder {
  // mime: response content type (protobuf when it contains 'proto'). jsonMaxBytes (0 = unlimited)
  // is the live cap shared with the JSON path: a larger inflated protobuf body is an oversize marker.
  constructor({ maxFrameBytes = 32 * 1024 * 1024, mime = null, jsonMaxBytes = 0 } = {}) {
    this.kind = 'grpc';
    this.buf = Buffer.alloc(0);
    this.base = 0;
    this.count = 0;
    this.maxFrameBytes = maxFrameBytes;
    this.mime = mime;
    this.jsonMaxBytes = jsonMaxBytes;
    this.stats = { frames: 0, trailers: 0, compressed: 0, bytes: 0 };
    // ONE bounded structural-feature extractor per decoder (so per stream), created lazily on the first
    // protobuf-path frame: a JSON-only gRPC / Connect stream never pays for it. Decoders do not share it.
    this._pf = null;
  }

  // Attach the COMPACT feature snapshot (constant size, counts only: see proto-features.mjs snapshot()) to a
  // protobuf-path event. The frame is handed over already inflated; nothing is inflated or framed twice.
  // A frame that could not be analyzed (undecodable compression, live-cap oversize) is recorded as an
  // incomplete record, never as a protobuf frame that was inspected. Never throws, never alters ev.proto.
  _feature(ev, body) {
    try {
      this._pf ??= createProtoFeatureExtractor();
      if (body === null || ev.proto?.reason === 'oversize') this._pf.add({ complete: false });
      else this._pf.add({ payload: body });
      ev.protoFeatures = this._pf.snapshot();
    } catch { /* feature extraction is observational: the decoded event stays exactly as before */ }
  }

  // Adds compression / proto to a data frame. rawJson: JSON parse of the raw payload (or undefined).
  _annotate(ev, payload, rawJson) {
    let body = payload;
    if (ev.compressed) {
      const inf = inflateFrame(payload);
      ev.compression = inf.method;
      body = inf.bytes;
    }
    if (body !== null) {
      const bodyIsJson = ev.compressed ? parseJsonSafe(body.toString('utf8')) !== undefined : rawJson !== undefined;
      const protoMime = /proto/i.test(String(this.mime ?? ''));
      if (!protoMime && bodyIsJson) { this._pf?.gap(); return; }   // JSON Connect payload: current handling only
      ev.proto = protoView(body, this.jsonMaxBytes);
      this._feature(ev, body);
    } else {
      ev.proto = { ok: false, reason: 'undecodable' };
      this._feature(ev, null);
    }
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    while (this.buf.length >= 5) {
      const flag = this.buf[0];
      const len = this.buf.readUInt32BE(1);
      if (len > this.maxFrameBytes) { this.stats.desync = (this.stats.desync ?? 0) + 1; break; }
      if (this.buf.length < 5 + len) break;
      const payload = this.buf.subarray(5, 5 + len);
      const trailer = (flag & 0x80) !== 0;
      const ev = {
        type: trailer ? 'grpc.trailer' : 'grpc.frame', compressed: (flag & 0x01) === 1,
        size: len, span: [this.base, this.base + 5 + len], index: this.count++,
      };
      if (trailer) { ev.trailers = parseHttpHeaderBlock(payload.toString('utf8')); this.stats.trailers++; }
      else {
        this.stats.frames++;
        const text = payload.toString('utf8');
        const json = parseJsonSafe(text);
        if (json !== undefined) ev.json = json;                       // grpc-gateway / JSON codec
        else { const strs = extractStrings(payload, 3); if (strs.length) ev.strings = strs.slice(0, 40); }
        if ((flag & 0x02) === 0) this._annotate(ev, payload, json);  // not end-stream (Connect JSON trailer)
      }
      if (ev.compressed) this.stats.compressed++;
      this.stats.bytes += len;
      out.push(ev);
      this.buf = Buffer.from(this.buf.subarray(5 + len));
      this.base += 5 + len;
    }
    return out;
  }
  end() {
    if (!this.buf.length) return [];
    const ev = { type: 'grpc.partial', size: this.buf.length, span: [this.base, this.base + this.buf.length], index: this.count++, incomplete: true };
    // A trailing partial frame in a stream that carried protobuf frames: the feature coverage must say that
    // something was NOT analyzed (incomplete), so a clean-looking cumulative snapshot never hides it.
    if (this._pf) this._feature(ev, null);
    this.buf = Buffer.alloc(0);
    return [ev];
  }
}

export function parseHttpHeaderBlock(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// Printable ASCII/UTF-8 runs inside a binary payload (never guesses structure).
export function extractStrings(buf, min = 4) {
  const out = [];
  let cur = [];
  for (const b of buf) {
    if (b >= 0x20 && b < 0x7f) cur.push(b);
    else { if (cur.length >= min) out.push(Buffer.from(cur).toString('latin1')); cur = []; }
  }
  if (cur.length >= min) out.push(Buffer.from(cur).toString('latin1'));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Whole-body decoders
// ---------------------------------------------------------------------------------------------
// maxBytes (0 = unlimited) applies to kind 'json' only: a body larger than the cap is emitted as an
// oversize marker with NO parsed json (its raw bytes stay in the raw log). Past the cap the bytes
// are not retained here, so memory is bounded too. Only the live recorder sets maxBytes.
export class WholeBodyDecoder {
  constructor(kind = 'json', { maxBytes = 0 } = {}) { this.kind = kind; this.parts = []; this.size = 0; this.maxBytes = maxBytes; }
  push(chunk) {
    this.size += chunk.length;
    if (this.maxBytes && this.kind === 'json' && this.size > this.maxBytes) this.parts = null;
    else if (this.parts) this.parts.push(chunk);
    return [];
  }
  bytes() { return this.parts ? Buffer.concat(this.parts) : Buffer.alloc(0); }
  end() {
    if (this.parts === null) return [{ type: 'json', oversize: true, bytes: this.size, size: this.size, span: [0, this.size], index: 0 }];
    const buf = Buffer.concat(this.parts);
    if (!buf.length) return [];
    if (this.kind === 'binary') return [{ type: 'binary', size: buf.length, span: [0, buf.length], index: 0 }];
    const text = buf.toString('utf8');
    const ev = { type: this.kind, span: [0, buf.length], index: 0, size: buf.length };
    const j = tryJson(text);
    if (j !== undefined) ev.json = j;
    else if (this.kind === 'json') ev.unparsed = true;
    if (this.kind === 'html' || this.kind === 'text') ev.text = text;
    if (ev.json !== undefined) { const nested = unwrapNestedJson(ev.json); if (nested) ev.jsonNested = nested; }
    return [ev];
  }
}

// AutoDecoder: picks a decoder from the declared MIME, then re-sniffs once enough bytes have
// arrived. Switching is only ever done while no event has been emitted yet, and the buffered
// prefix is replayed into the new decoder, so no byte is decoded twice or lost.
export class AutoDecoder {
  constructor({ mime, forced, resniffBytes = 4096, maxResniffChunks = 8, jsonMaxBytes = 0 } = {}) {
    this.mime = mime;
    this.forced = forced;
    this.resniffBytes = resniffBytes;
    this.maxResniffChunks = maxResniffChunks;
    this.jsonMaxBytes = jsonMaxBytes;
    this.head = [];
    this.headBytes = 0;
    this.chunkCount = 0;
    this.emitted = 0;
    this.switched = null;
    this.inner = null;
    this.kind = forced ?? classifyMime(mime);
  }
  _init(firstBytes) {
    this.inner = decoderForKind(sniff(this.mime, firstBytes), { forced: this.forced, jsonMaxBytes: this.jsonMaxBytes, mime: this.mime });
    this.kind = this.inner.kind;
    return this.inner;
  }
  push(chunk) {
    this.chunkCount++;
    if (!this.inner) this._init(chunk);
    if (this.headBytes < this.resniffBytes && this.chunkCount <= this.maxResniffChunks) {
      this.head.push(chunk); this.headBytes += chunk.length;
      // Whole-body decoders emit nothing until end(), so a late switch is always safe.
      if (this.emitted === 0 && this.inner instanceof WholeBodyDecoder && this.chunkCount > 1) {
        const head = Buffer.concat(this.head);
        const better = sniff(this.mime, head);
        if (better !== this.inner.kind && ['sse', 'ndjson', 'jsonseq', 'chunked-json', 'grpc', 'length-prefixed', 'csv'].includes(better)) {
          this.switched = { from: this.inner.kind, to: better, atChunk: this.chunkCount };
          this.inner = decoderForKind(better, { forced: this.forced, jsonMaxBytes: this.jsonMaxBytes, mime: this.mime });
          this.kind = this.inner.kind;
          const evs = this.inner.push(head);
          this.emitted += evs.length;
          return evs;
        }
      }
    }
    const evs = this.inner.push(chunk);
    this.emitted += evs.length;
    this.kind = this.inner.kind;
    return evs;
  }
  end() {
    if (!this.inner) this._init(Buffer.alloc(0));
    const evs = this.inner.end();
    this.emitted += evs.length;
    return evs;
  }
  get stats() { return this.inner?.stats; }
}

// ---------------------------------------------------------------------------------------------
// MIME / content classification
// ---------------------------------------------------------------------------------------------
export function classifyMime(mime = '') {
  const m = String(mime ?? '').toLowerCase();
  if (m.includes('event-stream')) return 'sse';
  // Connect streaming (application/connect+proto, connect+json) uses the same 5-byte envelopes as gRPC.
  if (m.includes('grpc') || m.includes('connect+')) return 'grpc';
  if (m.includes('json-seq')) return 'jsonseq';
  if (m.includes('ndjson') || m.includes('jsonl') || m.includes('x-json-stream')) return 'ndjson';
  if (m.includes('json')) return 'json';
  if (m.includes('csv')) return 'csv';
  if (m.includes('html')) return 'html';
  if (m.startsWith('text/') || m.includes('javascript') || m.includes('xml')) return 'text';
  if (!m) return 'unknown';
  return 'binary';
}

// CSV rows are emitted with the same event envelope as the other decoders
// (type / text / span / index) plus the decoded payload: `data` (mirrored into `json`)
// holds the row object when a header row was detected, otherwise the array of cell values.
class CsvRowDecoder extends CsvDecoder {
  _event(r) {
    const ev = super._event(r);
    const row = this.hasHeader ? ev.row : (ev.values ?? []);
    ev.data = row;
    ev.json = row;
    const headers = Array.isArray(ev.columns) ? ev.columns : [];
    const delimiter = ev.delimiter ?? ',';
    ev.envelope = { headers: headers.slice(), delimiter, raw: headers.join(delimiter) };
    return ev;
  }
}

export function decoderForKind(kind, { forced, jsonMaxBytes = 0, mime = null } = {}) {
  switch (kind) {
    case 'csv': return new CsvRowDecoder();
    case 'sse': return new SseDecoder();
    case 'ndjson': return new NdjsonDecoder();
    case 'jsonseq': return new JsonSeqDecoder({ maxBytes: jsonMaxBytes });
    case 'chunked-json': return new ChunkedJsonDecoder({ maxBytes: jsonMaxBytes });
    case 'length-prefixed': return new LengthPrefixedDecoder();
    case 'grpc': return new GrpcFrameDecoder({ mime, jsonMaxBytes });
    case 'json': case 'html': case 'text': return new WholeBodyDecoder(kind, { maxBytes: jsonMaxBytes });
    default: return new WholeBodyDecoder(forced === 'binary' ? 'binary' : 'binary');
  }
}

// Choose a decoder from the declared MIME type, overridden by content sniffing of the first bytes
// (sites often serve SSE or NDJSON under a generic type).
export function pickDecoder(mime, firstBytes, forced) {
  const kind = forced || sniff(mime, firstBytes);
  return decoderForKind(kind, { forced });
}

// Opt-in resilient decoder used by the reducer: re-sniffs the head before committing.
export function pickAutoDecoder(mime, forced, opts = {}) {
  return new AutoDecoder({ mime, forced, ...opts });
}

export function sniff(mime, firstBytes) {
  const declared = classifyMime(mime);
  if (declared === 'sse' || declared === 'ndjson' || declared === 'jsonseq' || declared === 'grpc' || declared === 'csv') return declared;
  const buf = firstBytes && firstBytes.length ? firstBytes : null;
  const head = buf ? buf.subarray(0, 1024).toString('utf8') : '';
  // SSE: field lines, or a comment-only keepalive preamble.
  if (/^(data|event|id|retry):/m.test(head) && /^(data|event|id|retry):/.test(head.trimStart())) return 'sse';
  if (/^:\s*\S/.test(head.trimStart()) && /\n\n/.test(head) && /^(data|event):/m.test(head)) return 'sse';
  // json-seq: record separators.
  if (buf && buf.includes(RS) && /\x1e\s*[{["]/.test(head)) return 'jsonseq';
  // gRPC framing: 1 flag byte in {0,1} + plausible length that lands inside the buffer.
  if (buf && buf.length >= 5 && (buf[0] === 0 || buf[0] === 1)) {
    const len = buf.readUInt32BE(1);
    if (len > 0 && len < 8 * 1024 * 1024 && (declared === 'binary' || declared === 'unknown')) {
      if (buf.length >= 5 + len || len > buf.length) return 'grpc';
    }
  }
  // Servers frequently mislabel a JSON stream as octet-stream; trust the bytes when they are
  // unmistakably text-structured, never otherwise.
  const textLike = /^\s*[{["]/.test(head);
  if (declared === 'json' || declared === 'unknown' || declared === 'text' || (declared === 'binary' && textLike)) {
    const lines = head.split('\n').filter((l) => l.trim());
    if (lines.length >= 2 && lines.slice(0, -1).every((l) => /^\s*[{[]/.test(l) && tryJson(l) !== undefined)) return 'ndjson';
    // Concatenated JSON values with no newline framing: }{ or } { or }\n{ on one logical run.
    if (/\}\s*\{/.test(head) || /\]\s*\[/.test(head)) return 'chunked-json';
    // A JSON array that is still open after the first element closed: progressive array stream.
    if (/^\s*\[\s*[{[]/.test(head) && /\},?\s*\{/.test(head)) return 'chunked-json';
    // Length-prefixed / netstring framing.
    if (/^\s*\d{1,9}:[{["]/.test(head) || /^[0-9a-fA-F]{1,9}\r?\n\s*[{["]/.test(head)) return 'length-prefixed';
    if (declared === 'binary' && textLike) return 'json';
  }
  if (declared === 'unknown' && /^\s*[{[]/.test(head)) return 'json';
  // CSV: only for bodies that are plain text and carry an unambiguous delimiter structure.
  // The checks above already rejected JSON / SSE / NDJSON / json-seq / gRPC / framed input,
  // and HTML is only reachable through its mime type, so those never land here.
  if (declared === 'text' || declared === 'unknown') {
    const csvBuf = buf ? buf.subarray(0, 4096) : null;
    if (csvBuf && looksLikeTextBytes(csvBuf) && sniffDelimiter(csvBuf.toString('utf8')).confidence >= 0.8) return 'csv';
  }
  return declared === 'unknown' ? 'text' : declared;
}

// Plain-text test for a byte window: no NUL bytes and no UTF-8 replacement characters.
function looksLikeTextBytes(buf) {
  if (!buf || !buf.length) return false;
  if (buf.includes(0x00)) return false;
  return !buf.toString('utf8').includes('\ufffd');
}

// ---------------------------------------------------------------------------------------------
// Envelope sniffing for unknown text formats: header tokens followed by a JSON payload
// (e.g. "EVT|order.updated|{...}", "42[\"msg\",{...}]", "MSG 12 {...}", "topic\t{...}"),
// or header-only frames (heartbeats). Returns null when nothing structured is found.
// ---------------------------------------------------------------------------------------------
export function sniffEnvelope(text) {
  if (typeof text !== 'string' || !text) return null;
  const j0 = tryJson(text);
  if (j0 !== undefined) return { json: j0 };
  const i = text.search(/[[{]/);
  if (i > 0 && i < 200) {
    const json = tryJson(text.slice(i));
    if (json !== undefined) {
      const head = text.slice(0, i);
      const delim = (/[|\t;]/.exec(head) ?? /[: ]/.exec(head) ?? [''])[0];
      const headers = head.split(/[|\t;: ]+/).filter(Boolean);
      return { json, envelope: { headers, delimiter: delim, raw: head } };
    }
  }
  if (text.length < 200 && (/^[A-Za-z0-9_.\-]+([|\t;][A-Za-z0-9_.\-]+)+$/.test(text) || /^[A-Z][A-Z0-9_]{1,15}[: ][A-Za-z0-9_.\-]+$/.test(text))) {
    const delim = /[|\t;: ]/.exec(text)[0];
    return { envelope: { headers: text.split(/[|\t;: ]/), delimiter: delim, raw: text }, headerOnly: true };
  }
  return null;
}

// Many transports wrap a JSON document inside a JSON *string* field. Surfacing it makes the
// payload reviewable and lets the delta assembler see the real document.
const NESTED_KEYS = ['data', 'payload', 'message', 'body', 'result', 'params', 'value', 'content', 'event_data', 'json'];
export function unwrapNestedJson(json, depth = 0) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || depth > 2) return null;
  for (const k of NESTED_KEYS) {
    const v = json[k];
    if (typeof v !== 'string' || v.length < 2) continue;
    const t = v.trim();
    if (t[0] !== '{' && t[0] !== '[') continue;
    const parsed = parseJsonSafe(t);
    if (parsed !== undefined && typeof parsed === 'object') return { key: k, json: parsed };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Text frame protocols carried over WebSocket (and sometimes long-poll bodies).
// Recognised purely from frame shape; no provider names are hard coded as behaviour.
// ---------------------------------------------------------------------------------------------
const EIO_TYPES = { 0: 'open', 1: 'close', 2: 'ping', 3: 'pong', 4: 'message', 5: 'upgrade', 6: 'noop' };
const SIO_TYPES = { 0: 'connect', 1: 'disconnect', 2: 'event', 3: 'ack', 4: 'connect_error', 5: 'binary_event', 6: 'binary_ack' };
const STOMP_COMMANDS = /^(CONNECT|STOMP|CONNECTED|SEND|SUBSCRIBE|UNSUBSCRIBE|ACK|NACK|BEGIN|COMMIT|ABORT|DISCONNECT|MESSAGE|RECEIPT|ERROR)\n/;
const GQL_WS_TYPES = new Set(['connection_init', 'connection_ack', 'connection_error', 'connection_terminate', 'ka', 'ping', 'pong', 'start', 'stop', 'subscribe', 'next', 'data', 'error', 'complete']);
const SIGNALR_TYPES = { 1: 'invocation', 2: 'stream_item', 3: 'completion', 4: 'stream_invocation', 5: 'cancel_invocation', 6: 'ping', 7: 'close' };

export function decodeTextFrame(text) {
  const out = { protocol: null };
  if (typeof text !== 'string') return out;
  const t = text.trim();
  if (!t) { out.protocol = 'empty'; out.heartbeat = true; return out; }

  // SockJS
  if (/^[ohc]$/.test(t)) { out.protocol = 'sockjs'; out.frameType = t === 'o' ? 'open' : t === 'h' ? 'heartbeat' : 'close'; out.heartbeat = t === 'h'; return out; }
  if (/^[ac]\[/.test(t)) {
    const json = parseJsonSafe(t.slice(1));
    out.protocol = 'sockjs'; out.frameType = t[0] === 'a' ? 'message' : 'close';
    if (json !== undefined) out.json = json;
    return out;
  }

  // SignalR (JSON records terminated by 0x1e)
  if (text.includes('\u001e')) {
    const first = text.split('\u001e').filter((x) => x.trim())[0];
    const json = parseJsonSafe(first ?? '');
    if (json && typeof json === 'object' && json.type !== undefined) {
      out.protocol = 'signalr'; out.frameType = SIGNALR_TYPES[json.type] ?? String(json.type);
      out.json = json; out.msgId = json.invocationId; out.event = json.target;
      out.heartbeat = json.type === 6;
      out.terminal = json.type === 7 || json.type === 3;
      return out;
    }
  }

  // STOMP
  if (STOMP_COMMANDS.test(text)) {
    const nl2 = text.indexOf('\n\n');
    const headPart = nl2 === -1 ? text : text.slice(0, nl2);
    const bodyPart = nl2 === -1 ? '' : text.slice(nl2 + 2).replace(/\0\s*$/, '');
    const lines = headPart.split('\n');
    out.protocol = 'stomp'; out.frameType = lines[0].trim();
    out.headers = parseHttpHeaderBlock(lines.slice(1).join('\n'));
    out.channel = out.headers.destination;
    out.msgId = out.headers['message-id'] ?? out.headers.receipt ?? out.headers['receipt-id'];
    if (bodyPart) { const json = parseJsonSafe(bodyPart); if (json !== undefined) out.json = json; else out.text = bodyPart; }
    out.heartbeat = out.frameType === 'CONNECTED' ? false : false;
    out.terminal = out.frameType === 'ERROR' || out.frameType === 'DISCONNECT';
    return out;
  }
  if (text === '\n' || text === '\r\n' || text === '\0') { out.protocol = 'stomp'; out.frameType = 'heartbeat'; out.heartbeat = true; return out; }

  // engine.io / socket.io
  const eio = /^(\d)(?:(\d)(?:(\/[^,]*),)?(\d+)?)?/.exec(t);
  if (eio && (t.length === 1 || /^[0-9]{1,2}(\/|\[|\{|$)/.test(t))) {
    const eioType = Number(eio[1]);
    if (EIO_TYPES[eioType] !== undefined) {
      out.protocol = 'engine.io';
      out.frameType = EIO_TYPES[eioType];
      out.heartbeat = eioType === 2 || eioType === 3;
      const rest = t.slice(eio[0].length);
      if (eioType === 4 && eio[2] !== undefined) {
        out.protocol = 'socket.io';
        out.frameType = SIO_TYPES[Number(eio[2])] ?? `sio${eio[2]}`;
        if (eio[3]) out.channel = eio[3];
        if (eio[4]) out.msgId = eio[4];
        const json = parseJsonSafe(rest);
        if (json !== undefined) {
          out.json = json;
          if (Array.isArray(json) && typeof json[0] === 'string') { out.event = json[0]; out.payload = json.length === 2 ? json[1] : json.slice(1); }
        } else if (rest) out.text = rest;
        return out;
      }
      if (rest) { const json = parseJsonSafe(rest); if (json !== undefined) out.json = json; else out.text = rest; }
      if (out.json !== undefined || out.heartbeat || t.length <= 2) return out;
    }
  }

  const json = parseJsonSafe(t);
  if (json !== undefined && json && typeof json === 'object') {
    out.json = json;
    // GraphQL over WebSocket
    if (!Array.isArray(json) && typeof json.type === 'string' && GQL_WS_TYPES.has(json.type)) {
      out.protocol = 'graphql-ws'; out.frameType = json.type; out.msgId = json.id;
      out.heartbeat = json.type === 'ka' || json.type === 'ping' || json.type === 'pong';
      out.terminal = json.type === 'complete' || json.type === 'connection_terminate';
      return out;
    }
    // Phoenix channels: [join_ref, ref, topic, event, payload] or {topic,event,payload,ref}
    if (Array.isArray(json) && json.length === 5 && typeof json[2] === 'string' && typeof json[3] === 'string') {
      out.protocol = 'phoenix'; out.frameType = json[3]; out.channel = json[2]; out.msgId = json[1]; out.event = json[3]; out.payload = json[4];
      out.heartbeat = json[2] === 'phoenix' || json[3] === 'heartbeat';
      return out;
    }
    if (!Array.isArray(json) && typeof json.topic === 'string' && typeof json.event === 'string') {
      out.protocol = 'phoenix'; out.frameType = json.event; out.channel = json.topic; out.msgId = json.ref; out.event = json.event; out.payload = json.payload;
      out.heartbeat = json.event === 'heartbeat' || json.topic === 'phoenix';
      return out;
    }
    // ActionCable
    if (!Array.isArray(json) && (json.identifier !== undefined || ['welcome', 'ping', 'confirm_subscription', 'reject_subscription', 'disconnect'].includes(json.type))) {
      out.protocol = 'actioncable'; out.frameType = json.type ?? 'message';
      out.channel = typeof json.identifier === 'string' ? json.identifier : undefined;
      out.heartbeat = json.type === 'ping';
      out.terminal = json.type === 'disconnect';
      return out;
    }
    // Pusher-style: event + data-as-JSON-string + channel
    if (!Array.isArray(json) && typeof json.event === 'string' && (typeof json.data === 'string' || json.channel !== undefined)) {
      out.protocol = 'pusher'; out.frameType = json.event; out.event = json.event; out.channel = json.channel;
      out.heartbeat = /ping|pong/i.test(json.event);
      return out;
    }
    // Centrifugo / bidirectional push envelope
    if (!Array.isArray(json) && (json.push !== undefined || (json.id !== undefined && (json.result !== undefined || json.error !== undefined)))) {
      out.protocol = 'centrifugo-like'; out.frameType = json.push ? 'push' : json.error ? 'error' : 'reply';
      out.channel = json.push?.channel; out.msgId = json.id;
      return out;
    }
    // JSON-RPC 2.0
    if (!Array.isArray(json) && (json.jsonrpc === '2.0' || (typeof json.method === 'string' && 'params' in json))) {
      out.protocol = 'json-rpc'; out.frameType = json.method ?? (json.error ? 'error' : 'result'); out.msgId = json.id; out.event = json.method;
      return out;
    }
    // MQTT over JSON / generic topic+payload
    if (!Array.isArray(json) && typeof json.channel === 'string' && json.data !== undefined) {
      out.protocol = 'channel-envelope'; out.frameType = String(json.type ?? json.event ?? 'message'); out.channel = json.channel;
      return out;
    }
    out.protocol = 'json';
    return out;
  }
  if (json !== undefined) { out.json = json; out.protocol = 'json'; return out; }

  if (HEARTBEAT_TEXT.has(t)) { out.protocol = 'heartbeat'; out.frameType = t || 'empty'; out.heartbeat = true; return out; }

  const env = sniffEnvelope(text);
  if (env) {
    if (env.json !== undefined) { out.json = env.json; out.protocol = 'enveloped-json'; }
    if (env.envelope) { out.envelope = env.envelope; out.protocol ??= 'envelope'; out.frameType = env.envelope.headers[0]; }
    if (env.headerOnly) { out.headerOnly = true; out.heartbeat = env.envelope.headers.length <= 2; }
    return out;
  }
  out.protocol = 'text';
  out.text = text;
  return out;
}

export function textFrameProtocol(text) { return decodeTextFrame(text).protocol; }

// WebSocket frame payload decoding (JSON, Socket.IO-style prefixes, generic envelopes).
export function decodeWsPayload({ opcode, payload }) {
  if (opcode === 2) {
    const buf = Buffer.from(payload ?? '', 'base64');
    const ev = { type: 'ws.binary', size: buf.length };
    // Binary frames are frequently just UTF-8 JSON, or gRPC-Web / protobuf.
    const text = buf.toString('utf8');
    const json = parseJsonSafe(text);
    if (json !== undefined) { ev.json = json; ev.decodedAs = 'json'; }
    else if (buf.length >= 5 && (buf[0] === 0 || buf[0] === 1) && buf.readUInt32BE(1) + 5 <= buf.length) { ev.decodedAs = 'grpc-frame'; ev.frameSize = buf.readUInt32BE(1); const s = extractStrings(buf.subarray(5), 4); if (s.length) ev.strings = s.slice(0, 20); }
    else { const s = extractStrings(buf, 4); if (s.length) ev.strings = s.slice(0, 20); }
    return ev;
  }
  if (opcode === 8) {
    const buf = Buffer.from(payload ?? '', 'base64');
    const ev = { type: 'ws.control', frameType: 'close', terminal: true };
    if (buf.length >= 2) { ev.code = buf.readUInt16BE(0); if (buf.length > 2) ev.reason = buf.subarray(2).toString('utf8'); }
    return ev;
  }
  if (opcode === 9 || opcode === 10) return { type: 'ws.control', frameType: opcode === 9 ? 'ping' : 'pong', heartbeat: true, size: (payload ?? '').length };
  const text = payload ?? '';
  const ev = { type: 'ws.text', text };
  const frame = decodeTextFrame(text);
  if (frame.protocol && frame.protocol !== 'text') ev.protocol = frame.protocol;
  if (frame.frameType !== undefined) ev.frameType = frame.frameType;
  if (frame.channel !== undefined) ev.channel = frame.channel;
  if (frame.event !== undefined) ev.event = frame.event;
  if (frame.msgId !== undefined) ev.msgId = frame.msgId;
  if (frame.headers !== undefined) ev.headers = frame.headers;
  if (frame.heartbeat) ev.heartbeat = true;
  if (frame.terminal) ev.terminal = true;
  const env = sniffEnvelope(text);
  if (env?.json !== undefined) ev.json = env.json;
  else if (frame.json !== undefined) ev.json = frame.json;
  if (env?.envelope) { ev.envelope = env.envelope; if (/^\d+$/.test(env.envelope.headers[0] ?? '') && env.envelope.headers.length === 1) ev.prefix = env.envelope.headers[0]; }
  if (env?.headerOnly || frame.headerOnly) ev.headerOnly = true;
  if (ev.json !== undefined) { const nested = unwrapNestedJson(ev.json); if (nested) ev.jsonNested = nested; }
  if (frame.payload !== undefined && ev.json === undefined) ev.payload = frame.payload;
  return ev;
}

// ---------------------------------------------------------------------------------------------
// WebSocket stream decoder: per-direction continuation reassembly + protocol tracking.
// Chrome usually delivers whole messages, but fragmented messages arrive as opcode 0 follow-ups.
// Each fragment is still emitted immediately (so the live view never stalls); the reassembled
// message is emitted afterwards and marked, so nothing is duplicated silently.
// ---------------------------------------------------------------------------------------------
export class WsFrameDecoder {
  constructor() {
    this.kind = 'ws';
    this.count = 0;
    this.partial = { in: null, out: null };
    this.protocols = new Map();
    this.stats = { frames: 0, text: 0, binary: 0, control: 0, heartbeats: 0, reassembled: 0, fragments: 0 };
  }

  push({ opcode, payload, dir = 'in', t } = {}) {
    const out = [];
    this.stats.frames++;
    const isCont = opcode === 0;
    if (isCont) {
      this.stats.fragments++;
      const p = this.partial[dir];
      const ev = { type: 'ws.continuation', dir, index: this.count++, size: frameSize(opcode, payload) };
      if (p) {
        p.parts.push(payload ?? '');
        p.size += ev.size;
        const joined = p.opcode === 2
          ? Buffer.concat(p.parts.map((x) => Buffer.from(x, 'base64'))).toString('base64')
          : p.parts.join('');
        const re = decodeWsPayload({ opcode: p.opcode, payload: joined });
        out.push(ev);
        out.push({ ...re, dir, index: this.count++, reassembled: true, fragments: p.parts.length, size: p.size, continuationOf: p.index });
        this.stats.reassembled++;
        p.emitted = true;
      } else out.push({ ...ev, orphanContinuation: true });
      return out;
    }
    if (opcode === 9 || opcode === 10 || opcode === 8) {
      this.stats.control++;
      const ev = { ...decodeWsPayload({ opcode, payload }), dir, index: this.count++ };
      if (ev.heartbeat) this.stats.heartbeats++;
      return [ev];
    }
    const ev = { ...decodeWsPayload({ opcode, payload }), dir, opcode, index: this.count++, size: frameSize(opcode, payload) };
    if (opcode === 2) this.stats.binary++; else this.stats.text++;
    if (ev.heartbeat) this.stats.heartbeats++;
    if (ev.protocol) this.protocols.set(ev.protocol, (this.protocols.get(ev.protocol) ?? 0) + 1);
    this.partial[dir] = { opcode, parts: [payload ?? ''], size: ev.size, index: ev.index, emitted: false };
    if (t !== undefined) ev.frameT = t;
    return [ev];
  }

  end() { this.partial = { in: null, out: null }; return []; }

  dominantProtocol() {
    let best = null, n = -1;
    for (const [p, c] of this.protocols) if (c > n && p !== 'json' && p !== 'text') { best = p; n = c; }
    if (best) return best;
    for (const [p, c] of this.protocols) if (c > n) { best = p; n = c; }
    return best;
  }
}

function frameSize(opcode, payload) {
  if (payload === undefined || payload === null) return 0;
  return opcode === 2 ? Buffer.from(payload, 'base64').length : Buffer.byteLength(payload);
}
