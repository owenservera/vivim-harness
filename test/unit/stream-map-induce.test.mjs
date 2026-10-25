// Stream-map induction: synthetic fixtures only (made-up text), plus the existing synthetic
// ai-chat dialect fixtures. Assertions are by property (which rules exist, what they select, what
// the applied map assembles), never by whole-object deepEqual against a golden document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SseDecoder } from '../../src/decode/decoders.mjs';
import {
  DEFAULT_STREAM_MAPS,
  validateStreamMap,
  applyStreamMap,
} from '../../src/profiles/stream-map.mjs';
import { induceStreamMap, compareMaps } from '../../src/profiles/stream-map-induce.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'fixtures', 'ai-chat-dialects');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

// Same SSE rendering as test/unit/stream-map.test.mjs.
function toSse(payloads) {
  return payloads.map((p) => {
    if (typeof p === 'string') return `data: ${p}\n\n`;
    const ev = typeof p.type === 'string' ? `event: ${p.type}\n` : '';
    return `${ev}data: ${JSON.stringify(p)}\n\n`;
  }).join('');
}

function streamEvents(payloads, sid = 'syn-sid') {
  const dec = new SseDecoder();
  return [...dec.push(Buffer.from(toSse(payloads), 'utf8')), ...dec.end()]
    .map((ev, i) => ({ ...ev, sid, seq: i }));
}

const MAP = Object.fromEntries(DEFAULT_STREAM_MAPS.map((m) => [m.id, m]));
// Everything except the message container: the same text the reply is made of.
const assembledText = (r) => r.components.filter((c) => c.component !== 'message').map((c) => c.text).join('');
const opsOf = (map, op) => map.stream.ops.filter((r) => r.op === op);

const claudeEvents = streamEvents(load('claude-typedevents.json').payloads);
const chatgptEvents = streamEvents(load('chatgpt-pathops.json').payloads);
const responsesEvents = streamEvents(load('openai-responses.json').payloads);

// ---------------------------------------------------------------------------------------------
// Typed events (Claude-style)
// ---------------------------------------------------------------------------------------------

test('typed-events: induction validates and selects message id, block index and the four roles', () => {
  const map = induceStreamMap(claudeEvents);
  assert.equal(validateStreamMap(map).ok, true, validateStreamMap(map).errors.join('; '));
  assert.equal(map.dialect, 'typed-events');
  assert.equal(map.stream.messageIdPath, 'message.id');
  assert.equal(map.stream.blockIndexPath, 'index');
  assert.equal(opsOf(map, 'open').length, 1);
  assert.deepEqual(opsOf(map, 'open')[0].when, { type: 'message_start' });
  assert.equal(opsOf(map, 'open')[0].keyPath, 'message.id');
  assert.equal(opsOf(map, 'append').length, 1);
  assert.deepEqual(opsOf(map, 'append')[0].when, { type: 'content_block_delta', 'delta.type': 'text_delta' });
  assert.equal(opsOf(map, 'append')[0].textPath, 'delta.text');
  assert.equal(opsOf(map, 'close').length, 1);
  assert.equal(opsOf(map, 'finalize').length, 1);
  assert.equal(map.unexplained.length, 0);
});

test('typed-events: the induced map assembles the same reply text as the hand-written map', () => {
  const map = induceStreamMap(claudeEvents);
  const a = applyStreamMap(map, claudeEvents);
  const b = applyStreamMap(MAP['claude-typed-events'], claudeEvents);
  assert.equal(assembledText(a), assembledText(b));
  assert.equal(a.unmapped.length, 0);
  assert.equal(b.unmapped.length, 0);
  // The induced message container is keyed by its own id; the reply blocks carry the same keys.
  const blockKeys = (r) => r.components.filter((c) => c.component !== 'message').map((c) => c.componentKey);
  assert.deepEqual(blockKeys(a), blockKeys(b));
  assert.deepEqual(blockKeys(a), ['syn-msg-claude-001:0', 'syn-msg-claude-001:1']);
});

// ---------------------------------------------------------------------------------------------
// Path-ops (ChatGPT-style) + comparison with the hand-written map
// ---------------------------------------------------------------------------------------------

test('path-ops: induction uses the pointer template, "p" as block index path and a capture pattern', () => {
  const map = induceStreamMap(chatgptEvents);
  assert.equal(validateStreamMap(map).ok, true, validateStreamMap(map).errors.join('; '));
  assert.equal(map.dialect, 'path-ops');
  assert.equal(map.stream.blockIndexPath, 'p');
  assert.doesNotThrow(() => new RegExp(map.stream.blockIndexPattern));
  assert.equal(map.stream.messageIdPath, 'message.id');
  const app = opsOf(map, 'append');
  assert.equal(app.length, 1);
  assert.equal(app[0].when.path, '/message/content/parts/*');
  assert.equal(app[0].textPath, 'v');
});

test('path-ops vs hand map: compareMaps is a number in [0,1] per category and the text matches', () => {
  const induced = induceStreamMap(chatgptEvents);
  const hand = MAP['chatgpt-path-ops'];
  const cmp = compareMaps(induced, hand);
  for (const cat of ['open', 'append', 'close', 'ignore', 'all']) {
    assert.equal(typeof cmp[cat], 'number', cat);
    assert.ok(Number.isFinite(cmp[cat]), cat);
    assert.ok(cmp[cat] >= 0 && cmp[cat] <= 1, `${cat}=${cmp[cat]}`);
  }
  // The text selector is the same template on both sides, so the append overlap is exact.
  assert.equal(cmp.append, 1);
  // Targets are not compared (open differs: isObject vs hasKey vocabulary), so it stays a number.
  assert.equal(cmp.open, 0);

  const a = applyStreamMap(induced, chatgptEvents);
  const b = applyStreamMap(hand, chatgptEvents);
  assert.equal(assembledText(a), assembledText(b));
  assert.equal(assembledText(a), 'Hello from a made-up synthetic stream. Second sentence.');
  assert.equal(a.unmapped.length, 0);
  assert.equal(b.unmapped.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Named typed events (OpenAI Responses-style)
// ---------------------------------------------------------------------------------------------

test('named typed events: append reads the bare delta string and close/finalize are positional', () => {
  const map = induceStreamMap(responsesEvents);
  assert.equal(validateStreamMap(map).ok, true);
  assert.equal(map.stream.messageIdPath, 'response.id');
  assert.equal(map.stream.blockIndexPath, 'output_index');
  const app = opsOf(map, 'append');
  assert.equal(app.length, 1);
  assert.equal(app[0].when.type, 'response.output_text.delta');
  assert.equal(opsOf(map, 'append')[0].textPath, 'delta');
  // The SSE event name is the terminal sentinel in this encoding, so the terminal flag is the
  // evidence (the hand map keys on the type name instead; both finalize the same event).
  assert.ok(opsOf(map, 'finalize').some((r) => r.when.terminal === true || r.when.type === 'response.completed'));
  assert.ok(opsOf(map, 'close').some((r) => r.when.type === 'response.output_text.done'));
  const r = applyStreamMap(map, responsesEvents);
  assert.equal(assembledText(r), 'Synthetic Responses reply with a made-up ending.');
  assert.equal(r.unmapped.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Snapshot growth: a "set" stream that an append-only engine cannot reproduce
// ---------------------------------------------------------------------------------------------

test('snapshot-growth: cumulative snapshots are reported as unexplained, never as an append rule', () => {
  const payloads = [
    { type: 'start' },
    { type: 'snapshot', text: '' },
    { type: 'snapshot', text: 'Alpha ' },
    { type: 'snapshot', text: 'Alpha beta.' },
  ];
  const events = streamEvents(payloads);
  const map = induceStreamMap(events);
  assert.equal(validateStreamMap(map).ok, true);
  assert.equal(opsOf(map, 'append').length, 0);
  const u = map.unexplained.find((x) => x.count === 3);
  assert.ok(u, JSON.stringify(map.unexplained));
  assert.equal(u.reason, 'cumulative_snapshot_text');
  // Applying it must not invent duplicated text: the snapshots stay unmapped.
  const r = applyStreamMap(map, events);
  assert.equal(r.components.length, 0);
  assert.equal(r.unmapped.length, 3);
});

// ---------------------------------------------------------------------------------------------
// Heartbeat-only stream
// ---------------------------------------------------------------------------------------------

test('heartbeat-only: one ignore rule, no append rule, nothing unmapped when applied', () => {
  const events = [{ event: 'ping', sid: 'hb', seq: 0 }, { event: 'ping', sid: 'hb', seq: 1 }, { event: 'ping', sid: 'hb', seq: 2 }];
  const map = induceStreamMap(events);
  assert.equal(validateStreamMap(map).ok, true);
  assert.equal(opsOf(map, 'append').length, 0);
  assert.equal(opsOf(map, 'ignore').length, 1);
  assert.deepEqual(opsOf(map, 'ignore')[0].when, { event: 'ping', type: null });
  const r = applyStreamMap(map, events);
  assert.equal(r.timeline.length, 3);
  assert.ok(r.timeline.every((t) => t.op === 'ignore'));
  assert.equal(r.unmapped.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Null-valued error keys must never become an error signal
// ---------------------------------------------------------------------------------------------

test('null-valued error keys: no signal rule is induced and applying the map raises no error', () => {
  const frames = [
    { event: 'message', json: { v: { message: { id: 'syn-m1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] } }, error: null, error_code: null } } },
    { event: 'message', json: { v: { p: '/message/content/parts/0', o: 'append', v: 'Hello ' } } },
    { event: 'message', json: { v: { p: '/message/error_state', o: 'replace', v: { error: null, error_code: null } } } },
    { event: 'message', json: { v: { error: null, error_code: null } } },
    { event: 'message', json: { v: { p: '/message/content/parts/0', o: 'append', v: 'world.' } } },
    { event: 'message', json: { v: { p: '/message/content/parts/0', o: 'append', v: ' Made-up.' } } },
    { event: 'message', json: { v: { p: '/message/error_state', o: 'replace', v: { error: null, error_code: null } } } },
    '[DONE]',
  ];
  const events = streamEvents(frames, 'err');
  const map = induceStreamMap(events);
  assert.equal(validateStreamMap(map).ok, true);
  assert.equal(map.stream.ops.some((r) => r.op === 'signal'), false);
  assert.equal(JSON.stringify(map).includes('nonNull'), false);
  const r = applyStreamMap(map, events);
  assert.equal(r.signals.length, 0);
  assert.equal(r.stats.errorSignals, 0);
  assert.equal(r.stats.hadError, false);
  assert.equal(assembledText(r), 'Hello world. Made-up.');
});

// ---------------------------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------------------------

test('empty stream: a valid map with no rules', () => {
  const map = induceStreamMap([]);
  assert.equal(validateStreamMap(map).ok, true);
  assert.deepEqual(map.stream.ops, []);
  assert.deepEqual(map.unexplained, []);
  assert.equal(map.induction.units, 0);
  assert.equal(map.dialect, 'typed-events');
  assert.deepEqual(applyStreamMap(map, []).stats.unmapped, 0);
});

test('one-event stream: no append rule and no crash', () => {
  const map = induceStreamMap([{ event: 'message', sid: 'one', seq: 0, json: { v: 'only fragment' } }]);
  assert.equal(validateStreamMap(map).ok, true);
  assert.equal(opsOf(map, 'append').length, 0);
  const r = applyStreamMap(map, [{ event: 'message', sid: 'one', seq: 0, json: { v: 'only fragment' } }]);
  assert.equal(r.components.length, 0);
});

test('a cluster with no expressible selector is listed under unexplained, not dropped', () => {
  const events = [{ sid: 'x', seq: 0, json: { only: 1 } }, { sid: 'x', seq: 1, json: { only: 2 } }];
  const map = induceStreamMap(events);
  assert.equal(validateStreamMap(map).ok, true);
  assert.equal(map.stream.ops.length, 0);
  assert.equal(map.unexplained.length, 1);
  assert.equal(map.unexplained[0].reason, 'no_selector');
  assert.equal(map.unexplained[0].count, 2);
});

// ---------------------------------------------------------------------------------------------
// Determinism and multi-stream input
// ---------------------------------------------------------------------------------------------

test('induction is deterministic on repeated calls', () => {
  for (const events of [claudeEvents, chatgptEvents, responsesEvents]) {
    assert.equal(JSON.stringify(induceStreamMap(events)), JSON.stringify(induceStreamMap(events)));
  }
});

test('multi-stream input: appends aggregate and the open frame must start every stream', () => {
  const a = streamEvents(load('claude-typedevents.json').payloads.slice(0, 7), 'sid-a');
  const b = streamEvents(load('claude-typedevents.json').payloads, 'sid-b');
  const events = [...a, ...b];
  const map = induceStreamMap(events);
  assert.equal(validateStreamMap(map).ok, true);
  assert.equal(map.induction.streams, 2);
  assert.equal(opsOf(map, 'open').length, 1);
  assert.equal(opsOf(map, 'open')[0].evidence.streams, 2);
  const app = opsOf(map, 'append')[0];
  assert.ok(app);
  assert.ok(app.evidence.growthPairs >= 2);
  assert.equal(JSON.stringify(induceStreamMap(events)), JSON.stringify(induceStreamMap(events)));
});

// ---------------------------------------------------------------------------------------------
// Evidence and confidence on every rule; compareMaps shape
// ---------------------------------------------------------------------------------------------

test('every emitted rule carries counts-only evidence and a confidence in [0,1]', () => {
  for (const events of [claudeEvents, chatgptEvents, responsesEvents]) {
    const map = induceStreamMap(events);
    for (const rule of map.stream.ops) {
      assert.equal(typeof rule.evidence.clusterId, 'string');
      assert.ok(Number.isInteger(rule.evidence.count) && rule.evidence.count >= 1);
      assert.equal(typeof rule.confidence, 'number');
      assert.ok(rule.confidence >= 0 && rule.confidence <= 1);
      for (const [k, v] of Object.entries(rule.evidence)) {
        if (k === 'clusterId') continue;
        assert.equal(typeof v, 'number', `${k} must be a count`);
        assert.ok(Number.isFinite(v));
      }
    }
  }
});

test('compareMaps: a map against itself is 1 everywhere and only numbers are returned', () => {
  const map = induceStreamMap(chatgptEvents);
  const cmp = compareMaps(map, map);
  for (const cat of ['open', 'append', 'close', 'ignore', 'all']) {
    assert.equal(cmp[cat], 1, cat);
    assert.equal(typeof cmp[cat], 'number');
  }
  const empty = { stream: { ops: [] } };
  const zero = compareMaps({ stream: { ops: [] } }, empty);
  assert.equal(zero.all, 1); // both sides empty: nothing to disagree about
  assert.deepEqual(Object.keys(compareMaps(map, MAP['chatgpt-path-ops'])).sort(), ['all', 'append', 'close', 'ignore', 'open']);
});
