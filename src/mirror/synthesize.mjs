// "Synthesize" mode: stream a reconstructed (or substituted) answer in the delta dialect that was
// learned from the capture.
//
// Learning works on the decoded event sequence of one captured stream (SSE, NDJSON or WebSocket
// text frames): the events are re-applied through DeltaAssembler (decode/delta.mjs) exactly as
// the reducer does, the primary text path of the final document is located, and every event that
// grows that text is classified as a delta *carrier*:
//   append      a string leaf equal to the appended piece (typed-events, path-ops, ot-ops, ...)
//   cumulative  a string leaf equal to the whole text so far (json-patch replace, full documents)
// Synthesis then keeps the captured preamble/postamble events, and emits one cloned carrier event
// per text piece (template i follows captured delta i, the last template repeats), with the
// captured inter-delta rhythm. The output is re-assembled through a fresh DeltaAssembler as a
// self-check: if it does not reproduce the requested text, the caller falls back to replay.
import { DeltaAssembler, getPointer } from '../decode/delta.mjs';
import { decodeWsPayload } from '../decode/decoders.mjs';

// ---------------------------------------------------------------------------------------------
// Units: one decoded event plus everything needed to re-serialize it.
// ---------------------------------------------------------------------------------------------
export function sseBlock({ event, id, retry, data, comments }) {
  let s = '';
  for (const c of comments ?? []) s += `: ${c}\n`;
  if (event !== undefined && event !== 'message') s += `event: ${event}\n`;
  if (id !== undefined) s += `id: ${id}\n`;
  if (retry !== undefined) s += `retry: ${retry}\n`;
  if (data !== undefined && (data !== '' || !s)) for (const line of String(data).split('\n')) s += `data: ${line}\n`;
  return s + '\n';
}

function frameText(unit, payload) {
  if (unit.framing === 'sse') return sseBlock({ ...unit.ev, data: payload });
  if (unit.framing === 'ndjson') return payload + '\n';
  return payload;
}

function makeUnit(ev, framing, at, payloadText, raw, opcode) {
  const envRaw = ev.envelope && !ev.headerOnly && typeof ev.envelope.raw === 'string' ? ev.envelope.raw : '';
  let rewritable = false;
  if (ev.json !== undefined && typeof payloadText === 'string' && payloadText.startsWith(envRaw)) {
    try { JSON.parse(payloadText.slice(envRaw.length)); rewritable = true; } catch { rewritable = false; }
  }
  return {
    at, framing, ev, raw, opcode, payloadText, envRaw, rewritable,
    outer: ev.json, nestedKey: ev.jsonNested?.key ?? null,
    json: ev.jsonNested?.json !== undefined ? ev.jsonNested.json : ev.json,
  };
}

// HTTP stream events as produced by StreamReducer / reconstructStream. Returns null when the
// framing cannot be re-serialized (chunked-json, gRPC, ...).
export function unitsFromStreamEvents(events, t0) {
  const units = [];
  for (const ev of events) {
    const at = Math.max(0, (ev.t ?? t0) - t0);
    if (ev.type === 'sse' || ev.type === 'sse.comment' || ev.type === 'eventsource') {
      units.push(makeUnit(ev, 'sse', at, ev.type === 'sse.comment' ? undefined : ev.data, sseBlock(ev)));
    } else if (ev.type === 'ndjson') {
      units.push(makeUnit(ev, 'ndjson', at, ev.text, `${ev.text}\n`));
    } else return null;
  }
  return units;
}

// WebSocket frames of one turn: [{ rel, opcode, text, payload:Buffer }].
export function unitsFromWsFrames(frames) {
  return frames.map((f) => {
    if (f.opcode !== 1 || typeof f.text !== 'string') return { at: f.rel, framing: 'ws', ev: {}, raw: f.payload, opcode: f.opcode, json: undefined, rewritable: false };
    const ev = decodeWsPayload({ opcode: 1, payload: f.text });
    return makeUnit(ev, 'ws', f.rel, f.text, f.text, 1);
  });
}

export function renderUnit(unit, forDeltaJson, at = unit.at) {
  if (forDeltaJson === undefined || !unit.rewritable) return { at, raw: unit.raw, opcode: unit.opcode, json: unit.json, framing: unit.framing };
  const outer = unit.nestedKey ? { ...unit.outer, [unit.nestedKey]: JSON.stringify(forDeltaJson) } : forDeltaJson;
  const payload = unit.envRaw + JSON.stringify(outer);
  return { at, raw: frameText(unit, payload), opcode: unit.opcode, json: forDeltaJson, framing: unit.framing };
}

// ---------------------------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------------------------
function findLeaf(node, pred, p = []) {
  if (typeof node === 'string') return pred(node) ? p : null;
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { const r = findLeaf(v, pred, [...p, k]); if (r) return r; }
  }
  return null;
}

function setLeaf(obj, leaf, value) {
  if (!leaf.length) return value;
  let node = obj;
  for (let i = 0; i < leaf.length - 1; i++) node = node[leaf[i]];
  node[leaf[leaf.length - 1]] = value;
  return obj;
}

function mapLeaves(node, fn) {
  if (typeof node === 'string') return fn(node);
  if (Array.isArray(node)) return node.map((v) => mapLeaves(v, fn));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, mapLeaves(v, fn)]));
  return node;
}

export function learnDeltas(units, { dialect = 'auto' } = {}) {
  const full = new DeltaAssembler({ dialect, opsLog: 0 });
  for (const u of units) if (u.json !== undefined) full.apply(u.json);
  const primary = full.texts(1).filter((t) => !/\/_(incomplete|done)$/.test(t.path))[0];
  if (!primary) return { deltas: [], reason: 'no_text_in_assembled_document', dialects: [...full.detected] };
  const parts = primary.path.split('/').slice(1);
  const a = new DeltaAssembler({ dialect, opsLog: 0 });
  const textAt = (doc) => { const v = getPointer(doc, parts); return typeof v === 'string' ? v : ''; };
  const deltas = [], opaque = new Set();
  let base = null;
  units.forEach((u, i) => {
    if (u.json === undefined) return;
    const before = textAt(a.doc);
    a.apply(u.json);
    const after = textAt(a.doc);
    if (after === before) return;
    let mode = null, leaf = null;
    if (after.startsWith(before)) {
      const piece = after.slice(before.length);
      leaf = findLeaf(u.json, (s) => s === piece);
      if (leaf) mode = 'append';
    }
    if (!leaf) { leaf = findLeaf(u.json, (s) => s === after); if (leaf) mode = 'cumulative'; }
    if (!leaf || !u.rewritable) { opaque.add(i); return; }
    if (base === null) base = before;
    deltas.push({ i, mode, leaf, grew: after.length - before.length });
  });
  return {
    path: primary.path, parts, finalText: primary.text, base: base ?? '', deltas, opaque,
    dialects: [...full.detected], modes: [...new Set(deltas.map((d) => d.mode))],
  };
}

// ---------------------------------------------------------------------------------------------
// Text pieces
// ---------------------------------------------------------------------------------------------
export function splitText(text, size = 4) {
  if (!text) return [];
  const n = Math.max(1, Math.round(size));
  const toks = text.match(/\s*\S+|\s+$/g) ?? [text];
  const out = [];
  let cur = '';
  for (const t of toks) {
    cur += t;
    if (cur.length >= n) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  // Very long pieces (no whitespace, CJK, code) are cut on code points.
  return out.flatMap((p) => {
    if (p.length <= n * 4) return [p];
    const cps = Array.from(p), r = [];
    for (let i = 0; i < cps.length; i += n * 2) r.push(cps.slice(i, i + n * 2).join(''));
    return r;
  });
}

const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---------------------------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------------------------
// text: string to stream, or undefined to stream the reconstructed captured answer.
export function synthesizeUnits(units, text, { dialect = 'auto', pieceSize } = {}) {
  const L = learnDeltas(units, { dialect });
  if (!L.deltas.length) return { ok: false, reason: L.reason ?? 'no_delta_carrier', learned: summary(L) };
  const first = L.deltas[0].i, last = L.deltas[L.deltas.length - 1].i;
  const deltaAt = new Map(L.deltas.map((d) => [d.i, d]));
  const target = typeof text === 'string' ? text : L.finalText;
  const resetBase = L.base && !target.startsWith(L.base);
  const base = resetBase ? '' : L.base;
  const streamed = target.slice(base.length);
  const changed = target !== L.finalText;

  const fixUnit = (u, at) => {
    if (!changed && !resetBase) return renderUnit(u, undefined, at);
    if (u.json === undefined || !u.rewritable) {
      if (changed && typeof u.raw === 'string' && L.finalText.length >= 8 && u.raw.includes(L.finalText)) return { ...renderUnit(u, undefined, at), raw: u.raw.split(L.finalText).join(target) };
      return renderUnit(u, undefined, at);
    }
    let touched = false;
    const json = mapLeaves(u.json, (s) => {
      if (changed && s === L.finalText) { touched = true; return target; }
      if (changed && L.finalText.length >= 8 && s.includes(L.finalText)) { touched = true; return s.split(L.finalText).join(target); }
      if (resetBase && s === L.base) { touched = true; return ''; }
      return s;
    });
    return touched ? renderUnit(u, json, at) : renderUnit(u, undefined, at);
  };

  const out = [];
  for (let i = 0; i < first; i++) out.push(fixUnit(units[i], units[i].at));

  const grow = L.deltas.map((d) => d.grew).filter((n) => n > 0 && n < 400);
  const size = pieceSize ?? Math.max(1, median(grow) || 4);
  const pieces = splitText(streamed, size);
  const ats = L.deltas.map((d) => units[d.i].at);
  const gaps = ats.slice(1).map((t, k) => Math.max(0, t - ats[k]));
  if (!gaps.length) gaps.push(20);
  const mids = [];
  for (let i = first + 1; i < last; i++) {
    if (deltaAt.has(i) || L.opaque.has(i)) continue;
    mids.push({ u: units[i], slot: Math.round(((i - first) / Math.max(1, last - first)) * pieces.length) });
  }
  let at = units[first].at, acc = '', m = 0;
  for (let k = 0; k < pieces.length; k++) {
    if (k > 0) at += gaps[(k - 1) % gaps.length];
    while (m < mids.length && mids[m].slot <= k) out.push(fixUnit(mids[m++].u, at));
    const tpl = L.deltas[Math.min(k, L.deltas.length - 1)];
    acc += pieces[k];
    const json = setLeaf(structuredClone(units[tpl.i].json), tpl.leaf, tpl.mode === 'append' ? pieces[k] : base + acc);
    out.push(renderUnit(units[tpl.i], json, at));
  }
  while (m < mids.length) out.push(fixUnit(mids[m++].u, at));
  const lastAt = units[last].at;
  for (let i = last + 1; i < units.length; i++) out.push(fixUnit(units[i], at + Math.max(0, units[i].at - lastAt)));

  // Self-check through the same assembler.
  const chk = new DeltaAssembler({ dialect, opsLog: 0 });
  for (const u of out) if (u.json !== undefined) chk.apply(u.json);
  const got = getPointer(chk.doc, L.parts);
  const ok = got === base + streamed;
  return {
    ok, reason: ok ? null : 'self_check_mismatch', units: out,
    learned: summary(L), pieces: pieces.length, pieceSize: size,
    text: { chars: target.length, fromCapture: typeof text !== 'string' },
    check: { expectedChars: (base + streamed).length, gotChars: typeof got === 'string' ? got.length : null },
  };
}

function summary(L) {
  return {
    path: L.path ?? null, dialects: L.dialects ?? [], modes: L.modes ?? [], deltas: L.deltas?.length ?? 0,
    opaque: L.opaque?.size ?? 0, capturedChars: L.finalText?.length ?? 0, baseChars: L.base?.length ?? 0,
  };
}
