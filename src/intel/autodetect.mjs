// Standalone content autodetect. No imports (CSV sniff is inlined).

const clamp = (n) => Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));

function toBuf(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
  return Buffer.alloc(0);
}

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

function magicKind(buf) {
  if (startsWith(buf, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'gif';
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (startsWith(buf, [0x00, 0x61, 0x73, 0x6d])) return 'wasm';
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) return 'ogg';
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'mp4';
  if (buf.length >= 2 && buf[0] === 0x78 && (buf[1] === 0x01 || buf[1] === 0x5e || buf[1] === 0x9c || buf[1] === 0xda)) {
    const cm = buf[0] & 0x0f;
    const cinfo = buf[0] >> 4;
    if (cm === 8 && cinfo <= 7 && ((buf[0] * 256 + buf[1]) % 31) === 0) return 'zlib';
  }
  return null;
}

function zeroBias(buf) {
  const pairs = Math.floor(buf.length / 2);
  if (!pairs) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < pairs * 2; i++) {
    if (buf[i] !== 0) continue;
    if (i % 2 === 0) even++;
    else odd++;
  }
  if (odd / pairs > 0.3) return 'utf-16le';
  if (even / pairs > 0.3) return 'utf-16be';
  return null;
}

function strictUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function detectCharset(buf) {
  const evidence = [];
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { charset: 'utf-8', evidence: ['bom:utf-8'] };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { charset: 'utf-16le', evidence: ['bom:utf-16le'] };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { charset: 'utf-16be', evidence: ['bom:utf-16be'] };
  }
  const utf8 = strictUtf8(buf);
  const bias = zeroBias(buf);
  if (utf8 && !bias) {
    evidence.push('charset:utf-8');
    return { charset: 'utf-8', evidence };
  }
  if (bias) {
    evidence.push(utf8 ? 'utf16-zero-bytes' : 'charset:utf-16');
    evidence.push(`charset:${bias}`);
    return { charset: bias, evidence };
  }
  if (utf8) {
    evidence.push('charset:utf-8');
    return { charset: 'utf-8', evidence };
  }
  evidence.push('charset:latin1');
  return { charset: 'latin1', evidence };
}

function decodeText(buf, charset) {
  if (charset === 'utf-8') {
    const b = (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? buf.subarray(3) : buf;
    return new TextDecoder('utf-8', { fatal: false }).decode(b);
  }
  if (charset === 'utf-16le') {
    const b = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) ? buf.subarray(2) : buf;
    return new TextDecoder('utf-16le', { fatal: false }).decode(b);
  }
  if (charset === 'utf-16be') {
    const b = (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) ? buf.subarray(2) : buf;
    return new TextDecoder('utf-16be', { fatal: false }).decode(b);
  }
  return buf.toString('latin1');
}

function looksBinary(buf, charset) {
  if (!buf.length) return false;
  if (charset === 'utf-16le' || charset === 'utf-16be') return false;
  let ctrl = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0 || b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return ctrl / buf.length > 0.1;
}

function mimeKind(mime) {
  const m = String(mime ?? '').toLowerCase();
  if (!m) return null;
  if (m.includes('gzip')) return 'gzip';
  if (m.includes('zlib')) return 'zlib';
  if (m.includes('zip')) return 'zip';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('wasm')) return 'wasm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('ndjson') || m.includes('jsonl') || m.includes('x-json-stream')) return 'ndjson';
  if (m.includes('event-stream')) return 'sse';
  if (m.includes('html')) return 'html';
  if (m.includes('yaml') || m.includes('yml')) return 'yaml';
  if (m.includes('xml')) return 'xml';
  if (m.includes('csv')) return 'csv';
  if (m.includes('json')) return 'json';
  if (m.includes('msgpack')) return 'msgpack';
  if (m.includes('protobuf')) return 'protobuf';
  if (m.includes('logfmt')) return 'logfmt';
  if (m.includes('ini') || m.includes('x-wine-conf') || m.endsWith('/toml')) return 'ini';
  if (m.startsWith('text/plain') || m === 'text') return 'text';
  if (m.includes('octet-stream')) return 'binary';
  return null;
}

function logicalLines(text, max = 50) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const lines = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < s.length && lines.length < max; i++) {
    const c = s[i];
    if (c === '"') {
      if (inQ && s[i + 1] === '"') { cur += '""'; i++; continue; }
      inQ = !inQ;
      cur += c;
      continue;
    }
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && s[i + 1] === '\n') i++;
      lines.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur && lines.length < max) lines.push(cur);
  return lines;
}

function countFields(line, delimiter) {
  let n = 1;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { i++; continue; }
      inQ = !inQ;
      continue;
    }
    if (!inQ && c === delimiter) n++;
  }
  return n;
}

/** Inline copy of sniffDelimiter — this module does not import csv.mjs. */
function sniffDelimiter(text) {
  const lines = logicalLines(text, 50).filter((l) => l.length > 0);
  const delims = [',', ';', '\t', '|'];
  let best = { delimiter: ',', confidence: 0 };
  if (!lines.length) return best;
  for (const delimiter of delims) {
    const counts = lines.map((line) => countFields(line, delimiter));
    const freq = new Map();
    let multi = 0;
    for (const c of counts) {
      if (c > 1) { multi++; freq.set(c, (freq.get(c) ?? 0) + 1); }
    }
    if (!multi) continue;
    let mode = 0;
    let modeN = 0;
    for (const [k, v] of freq) {
      if (v > modeN || (v === modeN && k > mode)) { mode = k; modeN = v; }
    }
    let confidence = (modeN / counts.length) * (modeN / multi);
    if (counts.length < 2) confidence *= 0.7;
    confidence = Math.round(Math.min(1, confidence) * 10000) / 10000;
    if (confidence > best.confidence) best = { delimiter, confidence };
  }
  return best;
}

function scoreJson(text) {
  const t = text.trim();
  if (!t) return 0;
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object') return 0.93;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return 0.5;
    return 0;
  } catch {
    return 0;
  }
}

function scoreNdjson(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return 0;
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
    } catch {
      return 0;
    }
  }
  return 0.9;
}

function scoreSse(text) {
  const lines = text.split(/\r?\n/);
  let n = 0;
  for (const line of lines) if (/^(?:data|event|id|retry):/.test(line)) n++;
  if (n >= 2) return 0.88;
  if (n === 1) return 0.6;
  return 0;
}

function scoreHtml(text) {
  const t = text.trim();
  if (/^<!doctype\s+html\b/i.test(t)) return 0.95;
  if (/<html[\s>]/i.test(t)) return 0.9;
  const tags = t.match(/<\/?(?:html|head|body|div|span|p|a|table|script|style|br|h1|ul|li|section|article)\b/gi);
  if (tags && tags.length >= 2) return 0.72;
  return 0;
}

function scoreXml(text) {
  const t = text.trim();
  if (/^<\?xml\s/i.test(t)) return 0.92;
  if (/^<!doctype\s+html\b/i.test(t) || /<html[\s>]/i.test(t)) return 0;
  if (!t.startsWith('<')) return 0;
  const re = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*(\/?)>/g;
  let depth = 0;
  let roots = 0;
  let saw = 0;
  let m;
  while ((m = re.exec(t))) {
    const open = !m[0].startsWith('</');
    const self = open && (m[2] === '/' || m[0].endsWith('/>'));
    if (!open) {
      depth--;
      if (depth < 0) return 0;
    } else if (!self) {
      if (depth === 0) roots++;
      depth++;
      saw++;
    } else {
      if (depth === 0) roots++;
      saw++;
    }
  }
  if (saw >= 1 && depth === 0 && roots === 1) return 0.74;
  return 0;
}

function scoreYaml(text) {
  if (/[{}]/.test(text) || /<[A-Za-z!?]/.test(text)) return 0;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length < 2) return 0;
  const kv = lines.filter((l) => /^[A-Za-z_][\w.-]*:\s+\S/.test(l));
  if (kv.length < 2) return 0;
  if (kv.length / lines.length < 0.5) return 0;
  return text.trimStart().startsWith('---') ? 0.8 : 0.68;
}

function scoreCsv(text) {
  const sn = sniffDelimiter(text);
  if (!(sn.confidence > 0)) return { score: 0, delimiter: sn.delimiter };
  return { score: clamp(sn.confidence * 0.85), delimiter: sn.delimiter };
}

function scoreLogfmt(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50);
  if (!lines.length) return 0;
  const re = /(?:^|\s)[A-Za-z_][\w.-]*=(?:[^\s"']+|"[^"]*"|'[^']*')/g;
  let good = 0;
  for (const line of lines) {
    const n = line.match(re);
    if (n && n.length >= 3) good++;
  }
  if (!good) return 0;
  return good / lines.length >= 0.5 ? 0.77 : 0.62;
}

function scoreIni(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith(';'));
  const sections = lines.filter((l) => /^\[[^\]\r\n]+\]$/.test(l)).length;
  const keys = lines.filter((l) => /^[^[\]=\s][^=]*=/.test(l)).length;
  if (sections >= 1 && keys >= 1) return 0.8;
  return 0;
}

function readVarint(buf, o) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (o + i >= buf.length) return null;
    const b = buf[o + i];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) return null;
      return { value, next: o + i + 1 };
    }
    shift += 7;
  }
  return null;
}

function scoreProtobuf(buf) {
  let o = 0;
  let fields = 0;
  while (fields < 3 && o < buf.length) {
    const tag = readVarint(buf, o);
    if (!tag) return 0;
    const fieldNum = tag.value >>> 3;
    const wt = tag.value & 7;
    if (fieldNum < 1 || fieldNum > 100000) return 0;
    if (wt === 0) {
      const v = readVarint(buf, tag.next);
      if (!v) return 0;
      o = v.next;
    } else if (wt === 1) {
      if (tag.next + 8 > buf.length) return 0;
      o = tag.next + 8;
    } else if (wt === 2) {
      const len = readVarint(buf, tag.next);
      if (!len || len.value > buf.length || len.next + len.value > buf.length) return 0;
      o = len.next + Number(len.value);
    } else if (wt === 5) {
      if (tag.next + 4 > buf.length) return 0;
      o = tag.next + 4;
    } else return 0;
    fields++;
  }
  if (fields < 3) return 0;
  return o === buf.length ? 0.78 : 0.66;
}

function mpItems(buf, o, count, mult, depth) {
  let p = o;
  const items = count * mult;
  if (!Number.isFinite(items) || items < 0 || items > 200000) return null;
  for (let i = 0; i < items; i++) {
    const s = mpSize(buf, p, depth + 1);
    if (s == null || s <= 0) return null;
    p += s;
    if (p > buf.length) return null;
  }
  return p - o;
}

function mpNeed(buf, o, n) {
  return o + n <= buf.length ? n : null;
}

function mpSized(buf, o, lenBytes) {
  if (o + 1 + lenBytes > buf.length) return null;
  let len = 0;
  if (lenBytes === 1) len = buf[o + 1];
  else if (lenBytes === 2) len = buf.readUInt16BE(o + 1);
  else {
    len = buf.readUInt32BE(o + 1);
    if (len > buf.length) return null;
  }
  const total = 1 + lenBytes + len;
  return o + total <= buf.length ? total : null;
}

function mpSize(buf, o, depth) {
  if (depth > 12 || o >= buf.length) return null;
  const b = buf[o];
  if (b <= 0x7f || b >= 0xe0) return 1;
  if (b >= 0x80 && b <= 0x8f) {
    const n = mpItems(buf, o + 1, b & 0x0f, 2, depth);
    return n == null ? null : 1 + n;
  }
  if (b >= 0x90 && b <= 0x9f) {
    const n = mpItems(buf, o + 1, b & 0x0f, 1, depth);
    return n == null ? null : 1 + n;
  }
  if (b >= 0xa0 && b <= 0xbf) return mpNeed(buf, o, 1 + (b & 0x1f));
  if (b === 0xc0 || b === 0xc2 || b === 0xc3) return 1;
  if (b === 0xc4 || b === 0xd9) return mpSized(buf, o, 1);
  if (b === 0xc5 || b === 0xda) return mpSized(buf, o, 2);
  if (b === 0xc6 || b === 0xdb) return mpSized(buf, o, 4);
  if (b === 0xca || b === 0xce || b === 0xd2) return mpNeed(buf, o, 5);
  if (b === 0xcb || b === 0xcf || b === 0xd3) return mpNeed(buf, o, 9);
  if (b === 0xcc || b === 0xd0) return mpNeed(buf, o, 2);
  if (b === 0xcd || b === 0xd1) return mpNeed(buf, o, 3);
  if (b === 0xd4) return mpNeed(buf, o, 3);
  if (b === 0xd5) return mpNeed(buf, o, 4);
  if (b === 0xd6) return mpNeed(buf, o, 6);
  if (b === 0xd7) return mpNeed(buf, o, 10);
  if (b === 0xd8) return mpNeed(buf, o, 18);
  if (b === 0xdc) {
    if (o + 3 > buf.length) return null;
    const n = mpItems(buf, o + 3, buf.readUInt16BE(o + 1), 1, depth);
    return n == null ? null : 3 + n;
  }
  if (b === 0xdd) {
    if (o + 5 > buf.length) return null;
    const count = buf.readUInt32BE(o + 1);
    if (count > 100000) return null;
    const n = mpItems(buf, o + 5, count, 1, depth);
    return n == null ? null : 5 + n;
  }
  if (b === 0xde) {
    if (o + 3 > buf.length) return null;
    const n = mpItems(buf, o + 3, buf.readUInt16BE(o + 1), 2, depth);
    return n == null ? null : 3 + n;
  }
  if (b === 0xdf) {
    if (o + 5 > buf.length) return null;
    const count = buf.readUInt32BE(o + 1);
    if (count > 100000) return null;
    const n = mpItems(buf, o + 5, count, 2, depth);
    return n == null ? null : 5 + n;
  }
  return null;
}

function scoreMsgpack(buf) {
  if (!buf.length) return 0;
  const b0 = buf[0];
  const isMap = (b0 >= 0x80 && b0 <= 0x8f) || b0 === 0xdc || b0 === 0xde;
  if (!isMap) return 0;
  const size = mpSize(buf, 0, 0);
  if (size == null || size <= 0 || size > buf.length) return 0;
  const ratio = size / buf.length;
  if (ratio >= 0.8) return 0.84;
  if (size >= 4 && ratio >= 0.5) return 0.7;
  return 0;
}

function applyMime(score, kind, prior) {
  if (prior && prior === kind && score > 0) return clamp(score + 0.1);
  return score;
}

export function detectContent(input, opts = {}) {
  const maxBytes = opts.maxBytes ?? 65536;
  const full = toBuf(input);
  const truncated = full.length > maxBytes;
  const buf = truncated ? full.subarray(0, maxBytes) : full;
  const prior = mimeKind(opts.mime);
  const evidence = [];
  if (truncated) evidence.push('truncated');

  const magic = magicKind(buf);
  if (magic) {
    let confidence = 0.98;
    evidence.push(`magic:${magic}`);
    if (prior === magic) {
      confidence = 1;
      evidence.push('mime+0.1');
    }
    return { kind: magic, confidence, charset: 'binary', evidence };
  }

  if (!buf.length) {
    const confidence = applyMime(0.2, 'text', prior);
    evidence.push('empty', 'fallback:text');
    if (prior === 'text' && confidence > 0.2) evidence.push('mime+0.1');
    return { kind: 'text', confidence, charset: 'utf-8', evidence };
  }

  const cs = detectCharset(buf);
  evidence.push(...cs.evidence);
  const binary = looksBinary(buf, cs.charset);

  if (binary) {
    const msg = applyMime(scoreMsgpack(buf), 'msgpack', prior);
    const proto = applyMime(scoreProtobuf(buf), 'protobuf', prior);
    if (msg >= proto && msg >= 0.5) {
      evidence.push('msgpack');
      if (prior === 'msgpack') evidence.push('mime+0.1');
      return { kind: 'msgpack', confidence: msg, charset: cs.charset, evidence };
    }
    if (proto >= 0.5) {
      evidence.push('protobuf');
      if (prior === 'protobuf') evidence.push('mime+0.1');
      return { kind: 'protobuf', confidence: proto, charset: cs.charset, evidence };
    }
    const confidence = applyMime(0.4, 'binary', prior);
    evidence.push('fallback:binary');
    if (prior === 'binary' && confidence > 0.4) evidence.push('mime+0.1');
    return { kind: 'binary', confidence, charset: cs.charset, evidence };
  }

  const text = decodeText(buf, cs.charset);
  const csv = scoreCsv(text);
  const probes = [
    ['json', scoreJson(text), 'json'],
    ['ndjson', scoreNdjson(text), 'ndjson'],
    ['sse', scoreSse(text), 'sse'],
    ['html', scoreHtml(text), 'html'],
    ['xml', scoreXml(text), 'xml'],
    ['yaml', scoreYaml(text), 'yaml'],
    ['csv', csv.score, `csv:${csv.delimiter === '\t' ? 'tab' : csv.delimiter}`],
    ['logfmt', scoreLogfmt(text), 'logfmt'],
    ['ini', scoreIni(text), 'ini'],
  ];
  let best = { kind: 'text', score: 0, tag: 'fallback:text' };
  for (const [kind, raw, tag] of probes) {
    const score = applyMime(raw, kind, prior);
    if (score > best.score) best = { kind, score, tag, boosted: score > raw && raw > 0 };
  }
  if (best.score < 0.5) {
    const confidence = applyMime(0.35, 'text', prior);
    evidence.push('fallback:text');
    if (prior === 'text' && confidence > 0.35) evidence.push('mime+0.1');
    return { kind: 'text', confidence, charset: cs.charset, evidence };
  }
  evidence.push(best.tag);
  if (best.boosted) evidence.push('mime+0.1');
  return { kind: best.kind, confidence: clamp(best.score), charset: cs.charset, evidence };
}

export function detectBatch(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => {
    if (item && typeof item === 'object' && !ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer)) {
      const input = item.input ?? item.data ?? item.bytes ?? item.body ?? item.content;
      return detectContent(input, { mime: item.mime, maxBytes: item.maxBytes });
    }
    return detectContent(item);
  });
}
