// Stream-to-component map characterization. Synthetic fixtures only (made-up text).
// Path under test: raw SSE text -> SseDecoder -> events with sid/seq -> stream map engine.
// Assertions are by property (component text, keys, ops, reasons), not whole-document deepEqual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SseDecoder } from '../../src/decode/decoders.mjs';
import {
  STREAM_MAP_SCHEMA,
  DEFAULT_STREAM_MAPS,
  validateStreamMap,
  applyStreamMap,
  detectStreamMap,
} from '../../src/profiles/stream-map.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'fixtures', 'ai-chat-dialects');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

// Same SSE rendering as test/unit/ai-chat-dialects.test.mjs.
function toSse(payloads) {
  return payloads.map((p) => {
    if (typeof p === 'string') return `data: ${p}\n\n`;
    const ev = typeof p.type === 'string' ? `event: ${p.type}\n` : '';
    return `${ev}data: ${JSON.stringify(p)}\n\n`;
  }).join('');
}

function decodeSse(payloads) {
  const dec = new SseDecoder();
  return [...dec.push(Buffer.from(toSse(payloads), 'utf8')), ...dec.end()];
}

// Decoded events carry no sid/seq of their own; the test stamps them the way a session would.
function streamEvents(payloads, sid = 'syn-sid') {
  return decodeSse(payloads).map((ev, i) => ({ ...ev, sid, seq: i }));
}

const MAP = Object.fromEntries(DEFAULT_STREAM_MAPS.map((m) => [m.id, m]));
const claudeMap = MAP['claude-typed-events'];
const chatgptMap = MAP['chatgpt-path-ops'];
const responsesMap = MAP['openai-responses'];

const claudePayloads = load('claude-typedevents.json').payloads;
const chatgptPayloads = load('chatgpt-pathops.json').payloads;
const responsesPayloads = load('openai-responses.json').payloads;

const CHATGPT_DELTAS = ['Hello from ', 'a made-up ', 'synthetic ', 'stream. ', 'Second sentence.'];
const claudeText = (idx) => claudePayloads
  .filter((p) => p.type === 'content_block_delta' && p.index === idx)
  .map((p) => p.delta.text)
  .join('');
const responsesText = responsesPayloads
  .filter((p) => p.type === 'response.output_text.delta')
  .map((p) => p.delta)
  .join('');

// Deterministic shuffle (no Math.random) so the "unknown dialect" test is reproducible.
function shuffled(items, seed = 7) {
  const a = items.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const byKey = (components, key) => components.find((c) => c.componentKey === key);

// ---------------------------------------------------------------------------------------------
// Validation of the built-in maps
// ---------------------------------------------------------------------------------------------

test('schema constant is the documented capture-studio.stream-map/1', () => {
  assert.equal(STREAM_MAP_SCHEMA, 'capture-studio.stream-map/1');
});

test('each default map validates', () => {
  assert.deepEqual(DEFAULT_STREAM_MAPS.map((m) => m.id), ['claude-typed-events', 'chatgpt-path-ops', 'openai-responses']);
  for (const m of DEFAULT_STREAM_MAPS) {
    const v = validateStreamMap(m);
    assert.equal(v.ok, true, `${m.id}: ${v.errors.join('; ')}`);
    assert.deepEqual(v.errors, []);
  }
});

test('validateStreamMap rejects an unknown op', () => {
  const bad = structuredClone(claudeMap);
  bad.stream.ops[0].op = 'explode';
  const v = validateStreamMap(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /unknown op "explode"/.test(e)));
});

test('validateStreamMap rejects open without a component', () => {
  const bad = structuredClone(claudeMap);
  delete bad.stream.ops[1].component;
  const v = validateStreamMap(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /open needs a component/.test(e)));
});

test('validateStreamMap rejects textPath on a non-append op', () => {
  const bad = structuredClone(claudeMap);
  bad.stream.ops[3].textPath = 'delta.text'; // content_block_stop is a close op
  const v = validateStreamMap(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /textPath is only allowed on append/.test(e)));
});

test('validateStreamMap rejects a duplicate identical when', () => {
  const bad = structuredClone(claudeMap);
  bad.stream.ops.push({ when: { type: 'ping' }, op: 'ignore' });
  const v = validateStreamMap(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /duplicate when/.test(e)));
});

test('validateStreamMap rejects a componentMap target outside the family enum', () => {
  const bad = structuredClone(claudeMap);
  bad.dom.componentMap.paragraph = 'sparkle';
  const v = validateStreamMap(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /dom\.componentMap\.paragraph targets "sparkle"/.test(e)));
});

test('validateStreamMap rejects wrong schema and unknown dialect', () => {
  const bad = { ...structuredClone(claudeMap), schema: 'other/1', dialect: 'mystery' };
  const v = validateStreamMap(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /schema must be/.test(e)));
  assert.ok(v.errors.some((e) => /unknown dialect/.test(e)));
});

test('applyStreamMap refuses an invalid map instead of guessing', () => {
  const bad = structuredClone(claudeMap);
  bad.stream.ops[1].op = 'bogus';
  assert.throws(() => applyStreamMap(bad, streamEvents(claudePayloads)), /invalid stream map/);
});

// ---------------------------------------------------------------------------------------------
// Claude typed events
// ---------------------------------------------------------------------------------------------

test('claude: each block component text equals its concatenated text_delta values', () => {
  const r = applyStreamMap(claudeMap, streamEvents(claudePayloads));
  const paragraphs = r.components.filter((c) => c.component === 'paragraph');
  assert.equal(paragraphs.length, 2);
  assert.equal(byKey(r.components, 'syn-msg-claude-001:0').text, claudeText(0));
  assert.equal(byKey(r.components, 'syn-msg-claude-001:1').text, claudeText(1));
});

test('claude: component keys are <message id>:<index>; the message container has no index so null', () => {
  const r = applyStreamMap(claudeMap, streamEvents(claudePayloads));
  const message = r.components.find((c) => c.component === 'message');
  assert.equal(message.componentKey, null);
  assert.deepEqual(r.components.map((c) => c.componentKey), [null, 'syn-msg-claude-001:0', 'syn-msg-claude-001:1']);
});

test('claude: ping and message_delta (usage/stop reason) land in ignore, not unmapped', () => {
  const r = applyStreamMap(claudeMap, streamEvents(claudePayloads));
  assert.equal(r.unmapped.length, 0);
  const ignored = r.timeline.filter((t) => t.op === 'ignore');
  assert.deepEqual(ignored.map((t) => t.seq), [4, 11]);
});

test('claude: stats count every payload once and the stream is finalized by message_stop', () => {
  const r = applyStreamMap(claudeMap, streamEvents(claudePayloads));
  assert.equal(r.stats.events, claudePayloads.length);
  assert.equal(r.stats.mapped, 11);
  assert.equal(r.stats.ignored, 2);
  assert.equal(r.stats.unmapped, 0);
  assert.equal(r.stats.finalized, true);
  assert.equal(r.stats.openComponents, 0);
  assert.ok(r.components.every((c) => c.closed !== null));
  assert.equal(r.components.find((c) => c.component === 'message').closed.seq, 12);
});

test('claude: a block without an id (no message_start in the stream) gets a null key, text still correct', () => {
  const r = applyStreamMap(claudeMap, streamEvents(claudePayloads.slice(1)));
  assert.ok(r.components.filter((c) => c.component === 'paragraph').every((c) => c.componentKey === null));
  assert.equal(r.components.filter((c) => c.component === 'paragraph')[0].text, claudeText(0));
});

test('claude: an event type the map does not know is unmapped with a reason and never forced into a component', () => {
  const events = streamEvents(claudePayloads);
  events.push({ sid: 'syn-sid', seq: events.length, event: 'mystery', data: '{"type":"mystery.thing"}', json: { type: 'mystery.thing' } });
  const r = applyStreamMap(claudeMap, events);
  assert.equal(r.unmapped.length, 1);
  assert.equal(r.unmapped[0].seq, claudePayloads.length);
  assert.match(r.unmapped[0].reason, /no_rule_matched/);
  assert.match(r.unmapped[0].reason, /mystery\.thing/);
  assert.equal(r.timeline.some((t) => t.seq === claudePayloads.length), false);
});

test('claude: truncated stream (last three events dropped) reports finalized false and closed null', () => {
  // Drops content_block_stop(index 1), message_delta and message_stop.
  const r = applyStreamMap(claudeMap, streamEvents(claudePayloads.slice(0, -3)));
  assert.equal(r.stats.finalized, false);
  assert.equal(byKey(r.components, 'syn-msg-claude-001:0').closed !== null, true);
  assert.equal(byKey(r.components, 'syn-msg-claude-001:1').closed, null);
  assert.equal(r.components.find((c) => c.component === 'message').closed, null);
  assert.equal(r.stats.openComponents, 2);
});

// ---------------------------------------------------------------------------------------------
// ChatGPT path-ops
// ---------------------------------------------------------------------------------------------

test('chatgpt: paragraph text equals the concatenated deltas (bare, patch-nested and direct appends)', () => {
  const r = applyStreamMap(chatgptMap, streamEvents(chatgptPayloads));
  const para = byKey(r.components, 'syn-msg-chatgpt-001:0');
  assert.equal(para.component, 'paragraph');
  assert.equal(para.text, CHATGPT_DELTAS.join(''));
});

test('chatgpt: patch envelope is expanded; its sub-operations keep the parent seq and carry a sub index', () => {
  const r = applyStreamMap(chatgptMap, streamEvents(chatgptPayloads));
  const subs = r.timeline.filter((t) => t.seq === 4);
  assert.deepEqual(subs.map((t) => [t.sub, t.op]), [[0, 'ignore'], [1, 'append']]);
  assert.equal(subs[1].text, 'stream. ');
});

test('chatgpt: [DONE] finalizes, status replace is ignored, and the status text never reaches the paragraph', () => {
  const r = applyStreamMap(chatgptMap, streamEvents(chatgptPayloads));
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.stats.finalized, true);
  assert.equal(r.timeline.filter((t) => t.op === 'ignore').length, 2);
  assert.equal(r.timeline[r.timeline.length - 1].op, 'finalize');
  assert.equal(byKey(r.components, 'syn-msg-chatgpt-001:0').text.includes('finished_successfully'), false);
});

test('chatgpt: the first full-message frame opens the message container with a null key (no index)', () => {
  const r = applyStreamMap(chatgptMap, streamEvents(chatgptPayloads));
  assert.equal(r.components[0].component, 'message');
  assert.equal(r.components[0].componentKey, null);
});

test('chatgpt: truncated stream (no [DONE]) leaves the paragraph closed null', () => {
  const r = applyStreamMap(chatgptMap, streamEvents(chatgptPayloads.slice(0, -1)));
  assert.equal(r.stats.finalized, false);
  assert.equal(byKey(r.components, 'syn-msg-chatgpt-001:0').closed, null);
});

// ---------------------------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------------------------

test('responses: output_text deltas build the paragraph; keys use response id and output_index', () => {
  const r = applyStreamMap(responsesMap, streamEvents(responsesPayloads));
  const para = byKey(r.components, 'syn-resp-openai-001:0');
  assert.equal(para.component, 'paragraph');
  assert.equal(para.text, responsesText);
  assert.equal(para.text, responsesPayloads.find((p) => p.type === 'response.output_text.done').text);
  assert.equal(r.components[0].componentKey, null);
});

test('responses: output_item.added is ignored; output_text.done closes the paragraph; response.completed finalizes', () => {
  const r = applyStreamMap(responsesMap, streamEvents(responsesPayloads));
  assert.equal(r.timeline.find((t) => t.seq === 1).op, 'ignore');
  const para = byKey(r.components, 'syn-resp-openai-001:0');
  assert.equal(para.closed.seq, 6);
  assert.equal(r.stats.finalized, true);
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.stats.openComponents, 0);
});

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

test('detectStreamMap picks the right built-in map for each fixture', () => {
  assert.equal(detectStreamMap(streamEvents(claudePayloads)).map.id, 'claude-typed-events');
  assert.equal(detectStreamMap(streamEvents(chatgptPayloads)).map.id, 'chatgpt-path-ops');
  assert.equal(detectStreamMap(streamEvents(responsesPayloads)).map.id, 'openai-responses');
});

test('detectStreamMap returns map null for a shuffled, renamed (unknown) dialect and lists candidates', () => {
  // Claude events with every type renamed to an unknown vocabulary, then shuffled.
  const renamed = claudePayloads.map((p) => (typeof p.type === 'string' ? { ...p, type: `x.${p.type}` } : p));
  const events = shuffled(streamEvents(renamed)).map((e, i) => ({ ...e, seq: i }));
  const d = detectStreamMap(events);
  assert.equal(d.map, null);
  assert.deepEqual(d.candidates.map((c) => c.id), ['claude-typed-events', 'chatgpt-path-ops', 'openai-responses']);
  assert.ok(d.candidates.every((c) => c.matched === 0));
});

test('detectStreamMap returns map null on a tie', () => {
  const tie = [...streamEvents(responsesPayloads.slice(0, 1)), ...streamEvents(chatgptPayloads.slice(0, 1), 'other')];
  const d = detectStreamMap(tie);
  assert.equal(d.map, null);
  assert.equal(d.candidates.find((c) => c.id === 'chatgpt-path-ops').matched, 1);
});

// ---------------------------------------------------------------------------------------------
// Determinism and ordering
// ---------------------------------------------------------------------------------------------

test('applyStreamMap is deterministic: same input gives the same output twice', () => {
  const a = applyStreamMap(claudeMap, streamEvents(claudePayloads));
  const b = applyStreamMap(claudeMap, streamEvents(claudePayloads));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(detectStreamMap(streamEvents(chatgptPayloads))), JSON.stringify(detectStreamMap(streamEvents(chatgptPayloads))));
});

test('timeline is in input order (seq never goes backwards)', () => {
  for (const [m, p] of [[claudeMap, claudePayloads], [chatgptMap, chatgptPayloads], [responsesMap, responsesPayloads]]) {
    const r = applyStreamMap(m, streamEvents(p));
    for (let i = 1; i < r.timeline.length; i++) assert.ok(r.timeline[i].seq >= r.timeline[i - 1].seq, m.id);
  }
});

test('applyStreamMap does not mutate the default map', () => {
  const before = JSON.stringify(claudeMap);
  applyStreamMap(claudeMap, streamEvents(claudePayloads));
  assert.equal(JSON.stringify(claudeMap), before);
});

test('DOM-only block types that the family enum can represent keep their own identity', () => {
  // rule, equation and file exist in the ai-chat family enum, so collapsing them to unknown
  // would discard information the family model can hold. graphic and details have no equivalent.
  for (const map of Object.values(DEFAULT_STREAM_MAPS)) {
    const cm = map.dom.componentMap;
    assert.equal(cm.rule, 'rule');
    assert.equal(cm.equation, 'equation');
    assert.equal(cm.file, 'file');
    assert.equal(cm.graphic, 'unknown');
    assert.equal(cm.details, 'unknown');
    assert.equal(validateStreamMap(map).ok, true);
  }
});

// ---------------------------------------------------------------------------------------------
// ChatGPT survey labels (type=<json.type> event=<SSE event>). Synthetic values only.
// ---------------------------------------------------------------------------------------------

// The real ChatGPT frames are event=message with the protocol kind in json.type. toSse() above
// names the SSE event after payload.type, which would be wrong for these labels, so this helper
// takes the SSE event name explicitly. Each frame: { event?, json } or { event?, raw }.
function chatgptFrames(frames, sid = 'syn-sid') {
  const text = frames.map((f) => {
    const ev = f.event ? `event: ${f.event}\n` : '';
    const data = typeof f.raw === 'string' ? f.raw : JSON.stringify(f.json);
    return `${ev}data: ${data}\n\n`;
  }).join('');
  const dec = new SseDecoder();
  return [...dec.push(Buffer.from(text, 'utf8')), ...dec.end()].map((ev, i) => ({ ...ev, sid, seq: i }));
}

const CGPT_OPEN = {
  event: 'message',
  json: {
    message: { id: 'syn-msg-cgpt-002', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress' },
    conversation_id: 'syn-conv-cgpt-002',
  },
};
const cgptAppend = (path, v) => ({ event: 'message', json: { p: path, o: 'append', v } });
const cgptReplace = (path, v) => ({ event: 'message', json: { p: path, o: 'replace', v } });
const P0 = '/message/content/parts/0';

// Rule the timeline entry matched, read back from the map (so the test follows the map).
const ruleWhen = (r, seq, sub) => {
  const t = r.timeline.find((x) => x.seq === seq && (sub === undefined || x.sub === sub));
  assert.ok(t, `no timeline entry for seq ${seq}`);
  return chatgptMap.stream.ops[t.rule].when;
};

test('chatgpt map: the four original rules stay first and unchanged (appended rules cannot shadow them)', () => {
  assert.deepEqual(chatgptMap.stream.ops.slice(0, 4), [
    { when: { hasKey: 'message', type: null }, op: 'open', component: 'message' },
    { when: { path: '/message/content/parts/*', o: 'append' }, op: 'append', component: 'paragraph', textPath: 'v' },
    { when: { path: '/message/status' }, op: 'ignore' },
    { when: { terminal: true, data: '[DONE]' }, op: 'finalize' },
  ]);
  assert.equal(validateStreamMap(chatgptMap).ok, true);
});

test('chatgpt: message_stream_complete finalizes and closes every open component', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([CGPT_OPEN, cgptAppend(P0, 'Made-up text.'), { event: 'message', json: { type: 'message_stream_complete', conversation_id: 'syn-conv-cgpt-002' } }]));
  const last = r.timeline[r.timeline.length - 1];
  assert.equal(last.op, 'finalize');
  assert.deepEqual(ruleWhen(r, last.seq), { event: 'message', type: 'message_stream_complete' });
  assert.equal(r.stats.finalized, true);
  assert.equal(r.stats.openComponents, 0);
  assert.ok(r.components.every((c) => c.closed !== null));
  assert.equal(r.unmapped.length, 0);
});

test('chatgpt: without message_stream_complete the stream stays unfinished (truncation still visible)', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([CGPT_OPEN, cgptAppend(P0, 'Made-up text.')]));
  assert.equal(r.stats.finalized, false);
  assert.equal(r.components.find((c) => c.component === 'paragraph').closed, null);
});

test('chatgpt: non-content protocol types land in timeline as ignore with their own rule, never in unmapped', () => {
  const types = ['message_marker', 'title_generation', 'input_message', 'resume_conversation_token', 'server_ste_metadata', 'conversation_detail_metadata', 'user_signal_metadata'];
  for (const type of types) {
    const r = applyStreamMap(chatgptMap, chatgptFrames([{ event: 'message', json: { type, synthetic: 'made-up' } }]));
    assert.equal(r.unmapped.length, 0, type);
    assert.equal(r.timeline.length, 1, type);
    assert.equal(r.timeline[0].op, 'ignore', type);
    assert.equal(r.timeline[0].component, null, type);
    assert.deepEqual(ruleWhen(r, 0), { event: 'message', type }, type);
    assert.equal(r.components.length, 0, type);
  }
});

test('chatgpt: input_message echoes the user prompt and never becomes a component of the reply', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([
    { event: 'message', json: { type: 'input_message', input: { parts: ['Synthetic user question?'] } } },
  ]));
  assert.equal(r.timeline[0].op, 'ignore');
  assert.equal(r.components.length, 0);
  assert.equal(r.unmapped.length, 0);
});

test('chatgpt: delta_encoding version frame is ignored', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([{ event: 'delta_encoding', json: { encoding: 'syn-delta', version: 1 } }]));
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.timeline[0].op, 'ignore');
  assert.deepEqual(ruleWhen(r, 0), { event: 'delta_encoding' });
});

test('chatgpt: metadata-path deltas (any op) and update_time/end_turn are ignored, not unmapped', () => {
  const metaFrames = [
    cgptAppend('/message/metadata/model_dil_v2/fallbackMarkdown', 'syn md'),
    cgptAppend('/message/metadata/model_dil_v2/constants', 'syn-const'),
    cgptReplace('/message/metadata/conversation_followup_suggestions_eligible', true),
    cgptAppend('/message/metadata', { syn: true }),
    cgptReplace('/message/metadata/model_dil_v2/code', 'syn'),
    cgptAppend('/message/metadata/streaming_parent_revision', 'syn-rev'),
    cgptReplace('/message/update_time', 1700000000),
    cgptReplace('/message/end_turn', true),
  ];
  const r = applyStreamMap(chatgptMap, chatgptFrames(metaFrames));
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.timeline.length, metaFrames.length);
  assert.ok(r.timeline.every((t) => t.op === 'ignore'));
  assert.equal(r.components.length, 0);
});

test('chatgpt: a /message/content/parts/0 append still builds the paragraph between metadata frames', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([
    CGPT_OPEN,
    cgptAppend(P0, 'Alpha '),
    cgptAppend('/message/metadata/model_dil_v2/constants', 'syn-const'),
    cgptAppend(P0, 'Beta.'),
  ]));
  assert.equal(r.unmapped.length, 0);
  assert.equal(byKey(r.components, 'syn-msg-cgpt-002:0').text, 'Alpha Beta.');
});

test('chatgpt: an unknown-shape event stays unmapped and its reason names type and event', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([
    { event: 'message', json: { synthetic: 'no type key here' } },
    { event: 'message', json: { type: 'syn_new_kind', value: 'x' } },
    { event: 'message', json: { p: '/message/weird', o: 'replace', v: 'x' } },
  ]));
  assert.equal(r.unmapped.length, 3);
  assert.match(r.unmapped[0].reason, /^no_rule_matched: type=- event=message$/);
  assert.match(r.unmapped[1].reason, /^no_rule_matched: type=syn_new_kind event=message$/);
  assert.match(r.unmapped[2].reason, /^no_rule_matched: type=- event=message path=\/message\/weird o=replace$/);
  assert.equal(r.components.length, 0);
});

test('chatgpt: full synthetic sequence yields one paragraph, finalized, no unmapped events', () => {
  const frames = [
    { event: 'delta_encoding', json: { encoding: 'syn-delta', version: 1 } },
    { event: 'message', json: { type: 'input_message', input: { parts: ['Synthetic user question?'] } } },
    { event: 'message', json: { type: 'message_marker', marker: 'syn-marker' } },
    CGPT_OPEN,
    cgptAppend(P0, 'Hello from '),
    { event: 'message', json: { v: 'a made-up ' } },
    { event: 'message', json: { o: 'patch', v: [
      { p: '/message/status', o: 'replace', v: 'in_progress' },
      { p: P0, o: 'append', v: 'stream. ' },
    ] } },
    { event: 'message', json: { v: 'Second sentence.' } },
    cgptAppend('/message/metadata/model_dil_v2/fallbackMarkdown', 'syn md'),
    cgptReplace('/message/metadata/conversation_followup_suggestions_eligible', true),
    cgptReplace('/message/update_time', 1700000000),
    cgptReplace('/message/end_turn', true),
    { event: 'message', json: { type: 'title_generation', title: 'Synthetic title' } },
    { event: 'message', json: { type: 'message_stream_complete', conversation_id: 'syn-conv-cgpt-002' } },
  ];
  const r = applyStreamMap(chatgptMap, chatgptFrames(frames));
  const paragraphs = r.components.filter((c) => c.component === 'paragraph');
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].text, 'Hello from a made-up stream. Second sentence.');
  assert.equal(paragraphs[0].componentKey, 'syn-msg-cgpt-002:0');
  assert.equal(r.stats.finalized, true);
  assert.equal(r.stats.openComponents, 0);
  assert.equal(r.stats.unmapped, 0);
  assert.equal(r.unmapped.length, 0);
  // 14 frames, one of which is a patch envelope with 2 sub-operations: 15 timeline entries.
  assert.equal(r.timeline.length, 15);
  assert.equal(r.stats.ignored, 9);
  assert.equal(r.stats.mapped, 6);
  assert.equal(r.timeline[r.timeline.length - 1].op, 'finalize');
});

test('chatgpt: the full synthetic sequence is deterministic', () => {
  const frames = [CGPT_OPEN, cgptAppend(P0, 'Alpha. '), cgptReplace('/message/update_time', 1), { event: 'message', json: { type: 'message_stream_complete' } }];
  const a = applyStreamMap(chatgptMap, chatgptFrames(frames));
  const b = applyStreamMap(chatgptMap, chatgptFrames(frames));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---------------------------------------------------------------------------------------------
// Signals: error envelopes. Synthetic only: made-up ids, codes and a distinctive message word.
// ---------------------------------------------------------------------------------------------

const SIG_WORD = 'zephyrquartz';
const SIG_MESSAGE = `Synthetic ${SIG_WORD} notice for a made-up reader.`;
const ERR_V = { conversation_id: 'syn-conv-err-1', error: 'syn-error', error_code: 'syn_code_01', message: SIG_MESSAGE };
const errA = (v) => ({ event: 'message', json: { v } }); // shape A: bare v, no p/o
const errB = (v) => ({ event: 'message', json: { o: 'add', p: '', v } }); // shape B: add at empty path
// ADJUSTED in the correction turn: error is now null too. A non-null error alone is a real error.
const withoutCode = () => { const v = { ...ERR_V, error: null }; delete v.error_code; return v; };
const SIG_KEYS = ['errorCount', 'statusCount', 'codes', 'sample'];

test('signals: shape A error envelope after a text delta is a signal, not unmapped, and the reply continues', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([CGPT_OPEN, cgptAppend(P0, 'Alpha '), errA(ERR_V), cgptAppend(P0, 'Beta.')]));
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].kind, 'error');
  assert.equal(r.signals[0].code, 'syn_code_01');
  assert.equal(r.signals[0].messageChars, SIG_MESSAGE.length);
  assert.equal(chatgptMap.stream.ops[r.signals[0].rule].op, 'signal');
  assert.equal(byKey(r.components, 'syn-msg-cgpt-002:0').text, 'Alpha Beta.');
  assert.equal(r.timeline.some((t) => t.seq === 2), false, 'a signal is not a timeline entry');
});

test('signals: shape A as the very first event (no pointer yet) is still a signal, not unmapped', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([errA(ERR_V)]));
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.signals.length, 1);
  assert.equal(r.timeline.length, 0);
});

test('signals: shape B (add, empty path, object value) is a signal, matched by its own rule', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([CGPT_OPEN, cgptAppend(P0, 'Alpha.'), errB(ERR_V)]));
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].code, 'syn_code_01');
  // ADJUSTED in the correction turn: the rule is keyed on a non-null error field, not key presence.
  assert.deepEqual(chatgptMap.stream.ops[r.signals[0].rule].when, { nonNull: ['v.error_code', 'v.error'], o: 'add', path: '' });
});

test('signals: code is kept only as a short token; long, spaced, empty, numeric and null codes become null', () => {
  const cases = [
    ['syn_code-01:x.y', 'syn_code-01:x.y'],
    ['a'.repeat(64), 'a'.repeat(64)],
    ['a'.repeat(65), null],
    ['has space', null],
    ['', null],
    [429, null],
    [null, null],
  ];
  for (const [raw, want] of cases) {
    for (const make of [errA, errB]) {
      const r = applyStreamMap(chatgptMap, chatgptFrames([make({ ...ERR_V, error_code: raw })]));
      assert.equal(r.unmapped.length, 0, JSON.stringify(raw));
      assert.equal(r.signals.length, 1, JSON.stringify(raw));
      assert.equal(r.signals[0].code, want, JSON.stringify(raw));
    }
  }
});

test('signals: an envelope without error_code is not a signal (the rule keys on error_code) and stays unmapped', () => {
  // Shape A with no pointer yet: the path gate reports it before any rule could match.
  const a = applyStreamMap(chatgptMap, chatgptFrames([errA(withoutCode())]));
  assert.equal(a.signals.length, 0);
  assert.equal(a.unmapped.length, 1);
  assert.equal(a.unmapped[0].reason, 'path_op_without_path');
  // Shape B: the add at an empty path matches no rule without error_code.
  const b = applyStreamMap(chatgptMap, chatgptFrames([errB(withoutCode())]));
  assert.equal(b.signals.length, 0);
  assert.match(b.unmapped[0].reason, /^no_rule_matched: type=- event=message path= o=add$/);
});

test('signals: message text never appears in any output; messageChars is its length', () => {
  for (const make of [errA, errB]) {
    const r = applyStreamMap(chatgptMap, chatgptFrames([CGPT_OPEN, make(ERR_V)]));
    assert.equal(JSON.stringify(r).includes(SIG_WORD), false);
    assert.equal(r.signals[0].messageChars, SIG_MESSAGE.length);
    assert.deepEqual(Object.keys(r.signals[0]).sort(), ['code', 'kind', 'messageChars', 'n', 'rule', 'seq', 'sid']);
  }
});

test('signals: a normal reply with an interleaved error frame still builds the paragraph and finalizes; hadError true', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([
    CGPT_OPEN,
    cgptAppend(P0, 'Hello from '),
    errA(ERR_V),
    cgptAppend(P0, 'a made-up stream.'),
    { event: 'message', json: { type: 'message_stream_complete', conversation_id: 'syn-conv-cgpt-002' } },
  ]));
  assert.equal(byKey(r.components, 'syn-msg-cgpt-002:0').text, 'Hello from a made-up stream.');
  assert.equal(r.stats.finalized, true);
  assert.equal(r.stats.openComponents, 0);
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.stats.signals, 1);
  assert.equal(r.stats.errorSignals, 1);
  assert.equal(r.stats.hadError, true);
});

test('signals: a stream with no error has hadError false and an empty signal list', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([CGPT_OPEN, cgptAppend(P0, 'Clean.'), { event: 'message', json: { type: 'message_stream_complete' } }]));
  assert.deepEqual(r.signals, []);
  assert.equal(r.stats.signals, 0);
  assert.equal(r.stats.errorSignals, 0);
  assert.equal(r.stats.hadError, false);
});

test('signals: a status-kind rule is reported with kind status and does not set hadError', () => {
  const custom = structuredClone(chatgptMap);
  custom.stream.ops.push({ when: { hasKey: 'v.state', o: 'add', path: '' }, op: 'signal', kind: 'status', codePath: 'v.state' });
  assert.equal(validateStreamMap(custom).ok, true);
  const r = applyStreamMap(custom, chatgptFrames([{ event: 'message', json: { o: 'add', p: '', v: { state: 'syn_busy' } } }]));
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.signals[0].kind, 'status');
  assert.equal(r.signals[0].code, 'syn_busy');
  assert.equal(r.signals[0].messageChars, null);
  assert.equal(r.stats.errorSignals, 0);
  assert.equal(r.stats.hadError, false);
});

test('signals: plain hasKey still checks only the top level; a dotted one checks the nested key', () => {
  const custom = structuredClone(chatgptMap);
  custom.stream.ops.push({ when: { hasKey: 'syn_top' }, op: 'signal', kind: 'status' });
  const nested = applyStreamMap(custom, chatgptFrames([{ event: 'message', json: { nested: { syn_top: 1 } } }]));
  assert.equal(nested.signals.length, 0);
  assert.equal(nested.unmapped.length, 1);
  const top = applyStreamMap(custom, chatgptFrames([{ event: 'message', json: { syn_top: 1 } }]));
  assert.equal(top.signals.length, 1);
});

test('signals: a bare envelope continuing an ignore pointer (/message/status) is ignored by that earlier rule, not reported', () => {
  // Pinned known limit: earlier survey rules keep first match. Change deliberately if the engine changes.
  const r = applyStreamMap(chatgptMap, chatgptFrames([CGPT_OPEN, cgptReplace('/message/status', 'in_progress'), errA(ERR_V)]));
  assert.equal(r.signals.length, 0);
  assert.equal(r.timeline[r.timeline.length - 1].op, 'ignore');
});

test('signals: survey ignore rules still ignore their events and report no signals', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([
    { event: 'message', json: { type: 'input_message', input: { parts: ['Synthetic question?'] } } },
    { event: 'message', json: { type: 'message_marker', marker: 'syn-marker' } },
    cgptReplace('/message/update_time', 1700000000),
  ]));
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.signals.length, 0);
  assert.ok(r.timeline.every((t) => t.op === 'ignore'));
});

test('signals: applyStreamMap output including signals is deterministic', () => {
  const frames = [CGPT_OPEN, cgptAppend(P0, 'Alpha. '), errA(ERR_V), errB({ ...ERR_V, error_code: 'syn_code_02' }), cgptAppend(P0, 'Beta.')];
  assert.equal(JSON.stringify(applyStreamMap(chatgptMap, chatgptFrames(frames))), JSON.stringify(applyStreamMap(chatgptMap, chatgptFrames(frames))));
});

test('signals: validateStreamMap accepts a valid signal rule and rejects each invalid one', () => {
  const withRule = (rule) => { const m = structuredClone(chatgptMap); m.stream.ops.push(rule); return validateStreamMap(m); };
  assert.equal(withRule({ when: { hasKey: 'v.syn_ok' }, op: 'signal', kind: 'status', codePath: 'v.state', textPath: 'v.message' }).ok, true);
  const cases = [
    [{ when: { hasKey: 'v.syn_c1' }, op: 'signal', component: 'paragraph' }, /signal rule must not set component/],
    [{ when: { hasKey: 'v.syn_c2' }, op: 'signal', kind: 'warning' }, /signal kind must be error or status/],
    [{ when: { hasKey: 'v.syn_c3' }, op: 'signal', codePath: 'v.error-code' }, /codePath must be a dotted identifier path/],
    [{ when: { hasKey: 'v.syn_c4' }, op: 'signal', codePath: '1abc' }, /codePath must be a dotted identifier path/],
    [{ when: { hasKey: 'v.syn_c5' }, op: 'signal', codePath: 'v..x' }, /codePath must be a dotted identifier path/],
    [{ when: { hasKey: 'v.syn_c6' }, op: 'signal', textPath: 'v.mes sage' }, /textPath must be a dotted identifier path/],
    [{ when: { hasKey: 'v.syn_c7' }, op: 'ignore', textPath: 'v.message' }, /textPath is only allowed on append and signal/],
    [{ when: { hasKey: 'v.syn_c8' }, op: 'ignore', kind: 'error' }, /kind is only allowed on signal/],
    [{ when: { hasKey: 'v..bad' }, op: 'signal' }, /when\.hasKey has an unsupported value/],
  ];
  for (const [rule, re] of cases) {
    const v = withRule(rule);
    assert.equal(v.ok, false, JSON.stringify(rule));
    assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(rule)}: ${v.errors.join('; ')}`);
  }
});

test('signals: applyStreamMap refuses an invalid signal rule', () => {
  const bad = structuredClone(chatgptMap);
  bad.stream.ops.push({ when: { hasKey: 'v.syn_bad' }, op: 'signal', kind: 'loud' });
  assert.throws(() => applyStreamMap(bad, chatgptFrames([errA(ERR_V)])), /invalid stream map/);
});

// ---------------------------------------------------------------------------------------------
// Real-shaped frames (correction): message-open frames carry the message object in v.message with
// null error fields. Null error fields are NOT errors. Synthetic ids, roles and text only.
// ---------------------------------------------------------------------------------------------

const V1 = load('chatgpt-pathops-v1.json').frames;
const realV = (id, role) => ({
  conversation_id: 'syn-conv-real-001',
  error: null,
  error_code: null,
  message: { id, ...(role === undefined ? {} : { author: { role } }), content: { content_type: 'text', parts: [''] }, status: 'in_progress' },
});
const realA = (id, role) => ({ event: 'message', json: { c: 0, v: realV(id, role) } });
const realB = (id, role) => ({ event: 'message', json: { c: 0, o: 'add', p: '', v: realV(id, role) } });

test('real-shaped: null error fields on a message-open frame are not a signal and not unmapped; the frame opens a message', () => {
  for (const make of [realA, realB]) {
    const r = applyStreamMap(chatgptMap, chatgptFrames([make('syn-msg-null-1', 'assistant')]));
    assert.equal(r.signals.length, 0);
    assert.equal(r.unmapped.length, 0);
    assert.equal(r.components.length, 1);
    assert.equal(r.components[0].component, 'message');
    assert.equal(r.components[0].componentKey, 'syn-msg-null-1');
  }
});

test('real-shaped: a non-null error_code string is a signal (short token kept, messageChars only, no text)', () => {
  for (const make of [errA, errB]) {
    const r = applyStreamMap(chatgptMap, chatgptFrames([make({ ...realV('syn-msg-x', 'assistant'), error_code: 'syn_code_77', message: SIG_MESSAGE })]));
    assert.equal(r.unmapped.length, 0);
    assert.equal(r.signals.length, 1);
    assert.equal(r.signals[0].code, 'syn_code_77');
    assert.equal(r.signals[0].messageChars, SIG_MESSAGE.length);
    assert.equal(JSON.stringify(r).includes(SIG_WORD), false);
  }
});

test('real-shaped: a non-null error with error_code null is a signal with code null', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([errA({ ...ERR_V, error: 'syn-error', error_code: null })]));
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].code, null);
});

test('real-shaped: user-authored message-open frames are ignored (shape A and B, role matched case-insensitively)', () => {
  for (const role of ['user', 'User']) {
    for (const make of [realA, realB]) {
      const r = applyStreamMap(chatgptMap, chatgptFrames([make('syn-msg-user-1', role)]));
      assert.equal(r.components.length, 0, role);
      assert.equal(r.timeline.length, 1, role);
      assert.equal(r.timeline[0].op, 'ignore', role);
      assert.equal(r.unmapped.length, 0, role);
    }
  }
});

test('real-shaped: assistant, absent, or other-role message-open frames open a message component', () => {
  for (const role of ['assistant', 'system', 'tool', undefined]) {
    for (const make of [realA, realB]) {
      const r = applyStreamMap(chatgptMap, chatgptFrames([make('syn-msg-open-1', role)]));
      assert.equal(r.components.length, 1, String(role));
      assert.equal(r.components[0].component, 'message', String(role));
      assert.equal(r.components[0].componentKey, 'syn-msg-open-1', String(role));
    }
  }
});

test('real-shaped: the message key comes from v.message.id and block keys inherit it', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames([realB('syn-msg-key-1', 'assistant'), cgptAppend(P0, 'Hi.')]));
  assert.equal(byKey(r.components, 'syn-msg-key-1').component, 'message');
  assert.equal(byKey(r.components, 'syn-msg-key-1:0').text, 'Hi.');
});

test('real-shaped: the v1 fixture yields one assistant message, one paragraph, finalized, hadError false, nothing unmapped', () => {
  const r = applyStreamMap(chatgptMap, chatgptFrames(V1));
  const messages = r.components.filter((c) => c.component === 'message');
  const paragraphs = r.components.filter((c) => c.component === 'paragraph');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].componentKey, 'syn-msg-v1-001');
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].componentKey, 'syn-msg-v1-001:0');
  assert.equal(paragraphs[0].text, 'Synthetic made-up text.');
  assert.equal(r.stats.finalized, true);
  assert.equal(r.stats.openComponents, 0);
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.signals.length, 0);
  assert.equal(r.stats.hadError, false);
  assert.equal(r.components.length, 2, 'the user-authored frame built no component');
});

test('real-shaped: an error injected into the v1 sequence sets hadError, keeps the paragraph, and still finalizes', () => {
  const injected = [...V1.slice(0, 3), errA({ conversation_id: 'syn-conv-v1-001', error: 'syn-error', error_code: 'syn_code_v1', message: SIG_MESSAGE }), ...V1.slice(3)];
  const r = applyStreamMap(chatgptMap, chatgptFrames(injected));
  assert.equal(r.stats.hadError, true);
  assert.equal(r.signals.length, 1);
  assert.equal(r.unmapped.length, 0);
  assert.equal(byKey(r.components, 'syn-msg-v1-001:0').text, 'Synthetic made-up text.');
  assert.equal(r.stats.finalized, true);
  assert.equal(r.stats.openComponents, 0);
});

test('real-shaped: the v1 sequence is deterministic', () => {
  const a = applyStreamMap(chatgptMap, chatgptFrames(V1));
  const b = applyStreamMap(chatgptMap, chatgptFrames(V1));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('real-shaped: rule order is survey rules, then error signals, then user-ignore, then message-open', () => {
  // A real error must win over a message object in the same frame, so the signal rules come first;
  // they are guarded by nonNull, so a healthy frame (null error fields) can never match them.
  const ops = chatgptMap.stream.ops;
  const at = (pred) => ops.findIndex(pred);
  const survey = at((r) => r.when.event === 'message' && r.when.type === 'message_stream_complete');
  const firstSignal = at((r) => r.op === 'signal');
  const userIgnore = at((r) => r.op === 'ignore' && r.when.isObject === 'v.message');
  const open = at((r) => r.op === 'open' && r.when.isObject === 'v.message');
  assert.ok(survey < firstSignal && firstSignal < userIgnore && userIgnore < open);
  assert.deepEqual(ops.slice(-2).map((r) => r.op), ['open', 'open']);
  assert.ok(ops.filter((r) => r.op === 'signal').every((r) => r.when.nonNull), 'every signal rule is guarded by nonNull');
});

test('real-shaped: validateStreamMap accepts nonNull, isObject and equals, and rejects malformed values', () => {
  const withRule = (rule) => { const m = structuredClone(chatgptMap); m.stream.ops.push(rule); return validateStreamMap(m); };
  assert.equal(withRule({ when: { nonNull: ['v.syn_n1', 'v.syn_n2'] }, op: 'signal' }).ok, true);
  assert.equal(withRule({ when: { nonNull: 'v.syn_n3' }, op: 'signal' }).ok, true);
  assert.equal(withRule({ when: { isObject: 'v.syn_o1' }, op: 'ignore' }).ok, true);
  assert.equal(withRule({ when: { equals: { 'v.syn_e1.role': 'user' } }, op: 'ignore' }).ok, true);
  const bad = [
    [{ nonNull: 'v..x' }, /when\.nonNull has an unsupported value/],
    [{ nonNull: [] }, /when\.nonNull has an unsupported value/],
    [{ nonNull: ['v.ok', 'bad..'] }, /when\.nonNull has an unsupported value/],
    [{ nonNull: 5 }, /when\.nonNull has an unsupported value/],
    [{ isObject: 'v..x' }, /when\.isObject has an unsupported value/],
    [{ equals: {} }, /when\.equals has an unsupported value/],
    [{ equals: 'user' }, /when\.equals has an unsupported value/],
    [{ equals: { 'v.a': 5 } }, /when\.equals has an unsupported value/],
    [{ equals: { 'v..a': 'x' } }, /when\.equals has an unsupported value/],
  ];
  for (const [when, re] of bad) {
    const v = withRule({ when, op: 'ignore' });
    assert.equal(v.errors.some((e) => /unknown when key/.test(e)), false, JSON.stringify(when));
    assert.equal(v.ok, false, JSON.stringify(when));
    assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(when)}: ${v.errors.join('; ')}`);
  }
});

test('real-shaped: validateStreamMap rejects keyPath on a non-open op and a malformed keyPath on open', () => {
  const withRule = (rule) => { const m = structuredClone(chatgptMap); m.stream.ops.push(rule); return validateStreamMap(m); };
  const notOpen = withRule({ when: { hasKey: 'v.syn_k1' }, op: 'ignore', keyPath: 'v.message.id' });
  assert.equal(notOpen.ok, false);
  assert.ok(notOpen.errors.some((e) => /keyPath is only allowed on open/.test(e)));
  const malformed = withRule({ when: { hasKey: 'v.syn_k2' }, op: 'open', component: 'message', keyPath: 'v..id' });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.errors.some((e) => /keyPath is only allowed on open/.test(e)));
});

test('a frame with a REAL error and a message object reports the error (signal rules precede message-open)', () => {
  const map = chatgptMap;
  const both = { sid: 's1', seq: 1, n: 0, t: 0, layer: 'L2', json: { c: 0, v: { conversation_id: 'c1', error: 'boom', error_code: 'rate_limit_exceeded', message: { id: 'm1', author: { role: 'assistant' } } } } };
  const healthy = { sid: 's1', seq: 2, n: 0, t: 0, layer: 'L2', json: { c: 1, v: { conversation_id: 'c1', error: null, error_code: null, message: { id: 'm2', author: { role: 'assistant' } } } } };
  const r = applyStreamMap(map, [both, healthy]);
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].code, 'rate_limit_exceeded');
  assert.equal(r.signals[0].seq, 1);
  assert.equal(r.stats.hadError, true);
  // the healthy frame still opens its message and is not a signal
  assert.ok(r.components.some((c) => c.component === 'message' && String(c.componentKey).includes('m2')));
  assert.ok(!r.components.some((c) => String(c.componentKey).includes('m1')));
});
