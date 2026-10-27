// Native-shape fidelity QA, Capture Studio Sprint 2 wave 5 (lane: end-to-end native-shape fidelity).
// One layer above replay-fidelity: raw capture -> stream components -> rendered page.
// Offline only: no Chrome, no network, synthetic data only (all text is made up, ASCII only).
//
// Each variant is written through the real NetworkRecorder chunk path (_chunk API) and the real
// RawLog, then read back through Session, streamBytes, StreamReducer, detectStreamMap/applyStreamMap
// and buildStreamMessages/joinStreamToDom. Criteria, asserted in order per full variant:
//   (1) STREAM      raw bytes reconstructed from the raw log == bytes fed in; recording complete.
//   (2) COMPONENTS  detectStreamMap picks the expected built-in map; component text equals the
//                   expected reply; component count equals the expected block count; closure:
//                   every component closed when terminated, none closed by finalize when cut.
//   (3) PAGE        joinStreamToDom over buildStreamMessages gives `verified` for the assistant
//                   message and `unlinked_dom` for the user turn; block links only when counts agree.
//                   Cut variants: `partial`, never `verified`.
//   (4) HONESTY     altered DOM text -> not verified; two identical assistant turns -> ambiguous, no
//                   link; empty DOM -> unlinked_stream, no link.
// Cut variants (last 2 SSE events dropped) are checked for (2) and (3) only.
//
// A real product defect is kept strict and marked with KNOWN_TODO (variant|layer -> reason).
//
// Run from the AION checkout:
//   node --test workspace/aion/qa/capture-studio/tests/native-shape-fidelity.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/store/session.mjs';
import { NetworkRecorder } from '../../src/capture/network.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { streamBytes } from '../../src/replay/derive.mjs';
import { buildStreamMessages } from '../../src/replay/stream-messages.mjs';
import { joinStreamToDom } from '../../src/intel/join.mjs';
import { detectStreamMap, applyStreamMap } from '../../src/profiles/stream-map.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIALECT_DIR = path.join(here, '..', 'fixtures', 'ai-chat-dialects');
const loadPayloads = (file) => JSON.parse(fs.readFileSync(path.join(DIALECT_DIR, file), 'utf8')).payloads;

const SSE = 'text/event-stream';
const INCOMPLETE_KINDS = new Set(['gap', 'body.excluded', 'body.truncated']);
const LAYERS_FULL = ['stream', 'components', 'page', 'honesty'];

// Known product defects: `${variant}|${layer}` -> reason. The assertion stays strict; an entry only
// turns that one variant+layer into a todo. Empty unless a real defect is confirmed.
// Empty since the three defects this file found were fixed (2026-10-22):
//   - ChatGPT snapshot frames now supply the message id (delta.mjs _idFromSnapshot), so the message is
//     keyed and an altered DOM text reads text_mismatch/near_match instead of unlinked_stream.
//   - join.mjs pairs blocks by rank order, so composite/string indexes like "0.0" link to DOM ords.
//   - join.mjs blocks inherit message finality, so a non-final stream never yields a verified block.
const KNOWN_TODO = {};

const enc = (s) => Buffer.from(s, 'utf8');
const show = (v) => { const s = JSON.stringify(v); if (s === undefined) return 'undefined'; return s.length > 100 ? `${s.slice(0, 100)}...` : s; };

// ---------------------------------------------------------------------------------------------
// Wire rendering (same convention as test/unit/ai-chat-dialects.test.mjs): typed objects get an
// "event:" line, string payloads are written raw (e.g. [DONE]).
// ---------------------------------------------------------------------------------------------
function sseWire(payloads) {
  return enc(payloads.map((p) => {
    if (typeof p === 'string') return `data: ${p}\n\n`;
    const ev = typeof p.type === 'string' ? `event: ${p.type}\n` : '';
    return `${ev}data: ${JSON.stringify(p)}\n\n`;
  }).join(''));
}

// Typed-event Claude-style stream built from block delta lists (used by the generated variants).
function claudeTyped(id, blocks) {
  const p = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [] } }];
  blocks.forEach((deltas, i) => {
    p.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
    for (const d of deltas) p.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: d } });
    p.push({ type: 'content_block_stop', index: i });
  });
  p.push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  p.push({ type: 'message_stop' });
  return p;
}

// ---------------------------------------------------------------------------------------------
// Chunk boundary helpers (same approach as replay-fidelity).
// ---------------------------------------------------------------------------------------------
const cutsEvery = (len, n) => { const c = []; for (let i = n; i < len; i += n) c.push(i); return c; };

function multibyteCuts(wire) {
  const i3 = wire.indexOf(enc('\u4e16'));
  const i4 = wire.indexOf(enc('\ud83d\ude42'));
  if (i3 < 0 || i4 < 0) throw new Error('fixture lacks multi-byte material');
  const cuts = [i3 + 1, i4 + 2, i4 + 3];
  for (const c of cuts) if ((wire[c] & 0xc0) !== 0x80) throw new Error(`cut ${c} is not inside a UTF-8 sequence`);
  return cuts;
}

function splitAt(buf, cuts) {
  const pts = [...new Set(cuts.filter((c) => c > 0 && c < buf.length))].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const c of pts) { out.push(Buffer.from(buf.subarray(prev, c))); prev = c; }
  out.push(Buffer.from(buf.subarray(prev)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Variants. Expected values are written out by hand (dialect fixtures: the reply text is copied
// from the fixture's deltas, not computed by the product).
// ---------------------------------------------------------------------------------------------
const CLAUDE_BLOCKS = ['Synthetic block zero says hello to a made-up reader.', 'Block one is a second fake paragraph.'];
const CHATGPT_REPLY = 'Hello from a made-up synthetic stream. Second sentence.';
const OPENAI_REPLY = 'Synthetic Responses reply with a made-up ending.';

const MD = 'Here is a [link label](https://example.test/page) and a **bold** word.\n\n- first item\n- second item\n\n| name | value |\n| --- | --- |\n| alpha | beta |';
const MD_DELTAS = []; for (let i = 0; i < MD.length; i += 17) MD_DELTAS.push(MD.slice(i, i + 17));
const MD_DOM = [
  { ord: 0, type: 'paragraph', text: 'Here is a link label and a bold word.' },
  { ord: 1, type: 'list', text: 'first item second item' },
  { ord: 2, type: 'table', text: 'name value alpha beta' },
];

const LONG_BLOCKS = Array.from({ length: 201 }, (_, i) => `Paragraph ${i} carries synthetic fact number ${i}.`);

const CHUNK_BLOCKS = [
  'Stra\u00dfe \u4e16\u754c \ud83d\ude42 ends here.',
  'Second \u03a9mega block with quote" and back\\slash.',
];
const CHUNK_DELTAS = [['Stra\u00dfe ', '\u4e16\u754c ', '\ud83d\ude42 ends here.'], ['Second \u03a9mega block with quote" and back\\slash.']];

function base(name, expectMap, payloads, blocks, extra = {}) {
  return {
    name, expectMap, mime: SSE, sid: `p:${name}.1`, payloads, blocks,
    wire: sseWire(payloads), cuts: (w) => cutsEvery(w.length, 97),
    domBlocks: blocks.map((text, ord) => ({ ord, type: 'paragraph', text })),
    domText: blocks.join('\n\n'), cut: false, closedStrict: false, ...extra,
  };
}

function cutOf(v, closedStrict) {
  return { ...v, name: `${v.name}-cut`, cut: true, closedStrict,
    wire: sseWire(v.payloads.slice(0, -2)), sid: `p:${v.name}-cut.1`,
    cuts: (w) => cutsEvery(w.length, 97) };
}

function buildVariants() {
  const claudeP = loadPayloads('claude-typedevents.json');
  const chatgptP = loadPayloads('chatgpt-pathops.json');
  const openaiP = loadPayloads('openai-responses.json');

  const claude = base('dialect-claude-typedevents', 'claude-typed-events', claudeP, CLAUDE_BLOCKS,
    { cuts: (w) => cutsEvery(w.length, 4096) });
  const chatgpt = base('dialect-chatgpt-pathops', 'chatgpt-path-ops', chatgptP, [CHATGPT_REPLY]);
  const openai = base('dialect-openai-responses', 'openai-responses', openaiP, [OPENAI_REPLY]);

  const longP = claudeTyped('syn-msg-native-long', LONG_BLOCKS.map((t) => [t]));
  const longV = base('gen-long-201-blocks', 'claude-typed-events', longP, LONG_BLOCKS,
    { cuts: (w) => cutsEvery(w.length, 4096) });

  const chunkP = claudeTyped('syn-msg-native-chunk', CHUNK_DELTAS);
  const chunkV = base('gen-chunk-utf8-json-split', 'claude-typed-events', chunkP, CHUNK_BLOCKS, {
    cuts: (w) => {
      const q = w.indexOf(enc('\\"'));
      if (q < 0) throw new Error('fixture lacks a JSON escape');
      return [...multibyteCuts(w), q + 1, ...cutsEvery(w.length, 97)];
    },
  });

  const mdP = claudeTyped('syn-msg-native-md', [MD_DELTAS]);
  const mdV = base('gen-markdown-dom-differs', 'claude-typed-events', mdP, [MD], {
    domBlocks: MD_DOM, domText: MD_DOM.map((b) => b.text).join('\n\n'),
  });

  const full = [claude, chatgpt, openai, longV, chunkV, mdV];
  const cuts = [
    cutOf(claude, false), // claude closes blocks with content_block_stop (not finalize), so closure is checked per op
    cutOf(chatgpt, true),
    cutOf(openai, true),
  ];
  return { full, cuts };
}

// ---------------------------------------------------------------------------------------------
// Writing sessions through the real capture primitives (copied from replay-fidelity).
// ---------------------------------------------------------------------------------------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-qa-native-shape-'));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });
const SESSIONS = path.join(ROOT, 'sessions');
fs.mkdirSync(SESSIONS, { recursive: true });

async function writeSession(spec) {
  const s = Session.create(SESSIONS, {
    site: 'chat.example.test',
    meta: { target: { url: 'https://chat.example.test/' }, fixture: spec.name, synthetic: true },
  });
  const add = (r) => s.raw.append(r);
  add({ k: 'run.start', fixture: spec.name, target: { url: 'https://chat.example.test/' } });
  add({ k: 'req', sid: spec.sid, url: 'https://chat.example.test/api/chat', method: 'POST', type: 'Fetch', frameId: 'F1', target: 'p' });
  add({ k: 'res', sid: spec.sid, status: 200, mime: spec.mime, protocol: 'h2' });
  const net = new NetworkRecorder({ append: add, profile: { capture: {} }, getPageUrl: () => 'https://chat.example.test/', options: {} });
  const st = { sid: spec.sid, chunks: 0, bytes: 0 };
  for (const piece of splitAt(spec.wire, spec.cuts(spec.wire))) net._chunk(st, piece);
  if (st.guard && !st.truncated && !st.credentialExcluded) net._appendProtectedChunk(st, st.guard.finish(), { finalSecurityTail: true });
  add({ k: 'done', sid: spec.sid, encodedDataLength: spec.wire.length, chunks: st.chunks, bytes: st.bytes,
    ...(st.truncated ? { truncated: true } : {}) });
  await s.raw.close();
  return s.dir;
}

// ---------------------------------------------------------------------------------------------
// Criterion evaluation helpers.
// ---------------------------------------------------------------------------------------------
function firstByteDiff(expected, got) {
  const n = Math.min(expected.length, got.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== got[i]) return `first differing byte at offset ${i}: expected 0x${expected[i].toString(16)} got 0x${got[i].toString(16)}`;
  }
  if (expected.length !== got.length) return `length expected ${expected.length} got ${got.length} (common prefix equal)`;
  return null;
}

function firstArrayDiff(exp, got) {
  if (exp.length !== got.length) return `count expected ${exp.length} got ${got.length}`;
  for (let i = 0; i < exp.length; i++) if (exp[i] !== got[i]) return `block ${i}: expected ${show(exp[i])} got ${show(got[i])}`;
  return null;
}

async function layer(fn) {
  try {
    const d = await fn();
    return { ok: d === null, detail: d ?? '' };
  } catch (e) {
    return { ok: false, detail: `threw: ${String(e?.message ?? e)}` };
  }
}

// Synthetic user prompt (prompts are not in a stream) and the assistant turn builder.
const USER_TURN = { index: 0, id: 'u1', domId: 'dom-u1', role: 'user', text: 'Say something synthetic',
  blocks: [{ ord: 0, type: 'paragraph', text: 'Say something synthetic' }] };
const assistantTurn = (text, blocks) => ({ index: 1, id: 'a1', domId: 'dom-a1', role: 'assistant', text, blocks });

async function evaluate(spec, dir) {
  const session = new Session(dir);
  const records = [];
  for await (const r of session.records()) records.push(r);
  const reducer = new StreamReducer({ keepEvents: true });
  const events = reducer.ingestAll(records).filter((e) => e.sid === spec.sid);
  const incomplete = records.filter((r) => INCOMPLETE_KINDS.has(r.k)).map((r) => `${r.k}@seq${r.seq}`);
  const out = { name: spec.name, cut: spec.cut, layers: {}, info: {} };

  out.layers.stream = await layer(async () => {
    if (incomplete.length) return `recording INCOMPLETE: ${incomplete.join(', ')}`;
    const { bytes } = await streamBytes(session, spec.sid);
    return firstByteDiff(spec.wire, bytes);
  });

  out.layers.components = await layer(() => {
    const det = detectStreamMap(events);
    out.info.map = det.map?.id ?? null;
    if (!det.map) return `detectStreamMap returned null; candidates ${show(det.candidates.map((c) => [c.id, c.matched]))}`;
    if (det.map.id !== spec.expectMap) return `map ${det.map.id}, expected ${spec.expectMap}`;
    const r = applyStreamMap(det.map, events);
    const comps = r.components.filter((c) => c.component !== 'message'); // 'message' is the turn container, not a block
    const texts = comps.map((c) => c.text);
    out.info.components = texts.length;
    if (texts.join('\n\n') !== spec.blocks.join('\n\n')) return `reply text differs: first block diff ${firstArrayDiff(spec.blocks, texts) ?? 'none (join differs)'}`;
    const bd = firstArrayDiff(spec.blocks, texts);
    if (bd) return `component text: ${bd}`;
    const message = r.components.find((c) => c.component === 'message');
    if (spec.cut) {
      if (r.stats.finalized !== false) return 'finalized is true on a cut stream';
      if (r.timeline.some((t) => t.op === 'finalize')) return 'a finalize op fired on a cut stream';
      if (message && message.closed !== null) return `message component closed on a cut stream at ${show(message.closed)}`;
      const closed = r.components.filter((c) => c.closed !== null);
      if (spec.closedStrict && closed.length) return `component ${closed[0].component} closed on a cut stream (no close op should be reached)`;
      for (const c of closed) {
        if (!r.timeline.some((t) => t.op === 'close' && t.component === c.component)) return `component ${c.component} closed without a close op`;
      }
    } else {
      if (r.stats.finalized !== true) return 'stream terminated but finalized is false';
      const open = r.components.find((c) => c.closed === null);
      if (open) return `component ${open.component} has no closed position after termination`;
    }
    return null;
  });

  out.layers.page = await layer(() => {
    const messages = buildStreamMessages(reducer);
    if (messages.length !== 1) return `expected 1 stream message, got ${messages.length}`;
    const turns = [USER_TURN, assistantTurn(spec.domText, spec.domBlocks)];
    const { links } = joinStreamToDom({ messages, turns });
    const ul = links.find((l) => l.turnId === 'u1');
    const ml = links.find((l) => l.messageIndex === 0);
    if (!ul || ul.status !== 'unlinked_dom') return `user turn status ${ul?.status}, expected unlinked_dom`;
    if (!ml) return 'no link for the stream message';
    if (spec.cut) {
      if (ml.status !== 'partial') return `cut: assistant status ${ml.status}, expected partial (notes ${show(ml.evidence.notes)})`;
      if (ml.blockLinks.some((b) => b.status === 'verified')) {
        const b = ml.blockLinks.find((x) => x.status === 'verified');
        return `cut: block ${b.blockKey} verified on a non-final stream (join doc: verified requires a final stream)`;
      }
      return null;
    }
    if (ml.status !== 'verified') return `assistant status ${ml.status} (textMatch ${ml.textMatch}, notes ${show(ml.evidence.notes)})`;
    if (ml.turnId !== 'a1') return `assistant linked to turn ${ml.turnId}, expected a1`;
    const sb = messages[0].blocks.length;
    const db = spec.domBlocks.length;
    if (sb === db) {
      if (ml.blockLinks.length !== sb) return `block links ${ml.blockLinks.length}, expected ${sb} (counts agree)`;
      const bad = ml.blockLinks.find((b) => b.status !== 'verified');
      if (bad) return `block ${bad.blockKey}: ${bad.status} (counts agree, expected verified)`;
    } else if (ml.blockLinks.some((b) => b.evidence.rule !== null)) {
      return `block links present although counts differ (stream ${sb}, dom ${db})`;
    }
    return null;
  });

  if (!spec.cut) {
    out.layers.honesty = await layer(() => {
      const messages = buildStreamMessages(reducer);
      // (a) one DOM word altered
      const altered = spec.domText.replace(/[A-Za-z]{4,}/, 'zzzzz');
      const a = joinStreamToDom({ messages, turns: [USER_TURN, assistantTurn(altered, [])] }).links.find((l) => l.messageIndex === 0);
      if (a.status === 'verified') return `altered DOM text was verified`;
      if (!['near_match', 'text_mismatch'].includes(a.status)) return `altered DOM text: status ${a.status}, expected near_match or text_mismatch`;
      // (b) two identical assistant turns
      const b = joinStreamToDom({ messages, turns: [USER_TURN, { ...assistantTurn(spec.domText, spec.domBlocks), index: 1, id: 'a1' },
        { ...assistantTurn(spec.domText, spec.domBlocks), index: 2, id: 'a2', domId: 'dom-a2' }] });
      const bm = b.links.find((l) => l.messageIndex === 0);
      if (bm.status !== 'ambiguous') return `identical turns: status ${bm.status}, expected ambiguous`;
      if (bm.turnId !== null || bm.turnIndex !== null) return `identical turns: forced link to ${bm.turnId}`;
      if (bm.blockLinks.length) return `identical turns: ${bm.blockLinks.length} block links despite ambiguity`;
      const freeAsst = b.links.filter((l) => l.messageKey === null && l.role === 'assistant').map((l) => l.status);
      if (freeAsst.join(',') !== 'unlinked_dom,unlinked_dom') return `identical turns: DOM statuses ${freeAsst.join(',')}`;
      // (c) empty DOM
      const c = joinStreamToDom({ messages, turns: [] }).links.find((l) => l.messageIndex === 0);
      if (c.status !== 'unlinked_stream') return `empty DOM: status ${c.status}, expected unlinked_stream`;
      if (c.turnIndex !== null || c.blockLinks.length) return 'empty DOM: a link was forced';
      return null;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Build the corpus once, evaluate every variant, then report through node:test.
// ---------------------------------------------------------------------------------------------
const { full: FULL, cuts: CUTS } = buildVariants();
const RESULTS = [];
for (const spec of [...FULL, ...CUTS]) RESULTS.push(await evaluate(spec, await writeSession(spec)));

const KNOWN = (name, layer) => (KNOWN_TODO[`${name}|${layer}`] ? { todo: KNOWN_TODO[`${name}|${layer}`] } : {});

for (const r of RESULTS) {
  const suffix = r.cut ? ' (cut)' : '';
  for (const k of r.cut ? ['stream', 'components', 'page'] : LAYERS_FULL) {
    const label = { stream: '(1) STREAM', components: '(2) COMPONENTS', page: '(3) PAGE', honesty: '(4) HONESTY' }[k];
    test(`${r.name}${suffix}: ${label}`, KNOWN(r.name, k), () => {
      const L = r.layers[k];
      assert.equal(L.ok, true, `${label} ${r.name}: ${L.detail}`);
    });
  }
}

test('summary: native-shape fidelity counts', () => {
  const full = RESULTS.filter((r) => !r.cut);
  const cut = RESULTS.filter((r) => r.cut);
  const faithful = full.filter((r) => LAYERS_FULL.every((k) => r.layers[k].ok));
  const per = (k) => full.filter((r) => r.layers[k].ok).length;
  const cutOk = cut.filter((r) => r.layers.components.ok && r.layers.page.ok).length;
  console.log(`native-shape-fidelity: ${faithful.length} variants fully faithful of ${full.length}`);
  console.log(`native-shape-fidelity per-layer: stream ${per('stream')}/${full.length}, components ${per('components')}/${full.length}, page ${per('page')}/${full.length} (page includes honesty negatives: ${per('honesty')}/${full.length})`);
  console.log(`native-shape-fidelity cut variants: ${cutOk}/${cut.length} non-final (components closure and page partial)`);
  assert.equal(full.length, 6, 'corpus shape: full variant count');
  assert.equal(cut.length, 3, 'corpus shape: cut variant count');
});
