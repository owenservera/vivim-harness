// Dialect characterization for synthetic AI-chat streams.
// Path under test: raw SSE text -> SseDecoder (framing + envelope sniffing) -> ev.json ->
// DeltaAssembler (dialect detection + assembly). Fixtures are synthetic (made-up text only).
// Assertions are by property (dialect name, text equality, terminal flag), never whole-document deepEqual,
// because src/decode/delta.mjs is being extended by another lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SseDecoder } from '../../src/decode/decoders.mjs';
import { DeltaAssembler, detectDialect } from '../../src/decode/delta.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'fixtures', 'ai-chat-dialects');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

// Render decoded payloads back to SSE wire text. String payloads are written raw (e.g. [DONE]);
// typed objects also get an "event:" line, as typed-event providers do.
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

function assemble(events) {
  const asm = new DeltaAssembler({ dialect: 'auto' });
  for (const ev of events) if (ev.json !== undefined) asm.apply(ev.json);
  return asm;
}

// ---------------------------------------------------------------------------------------------
// chatgpt-pathops
// ---------------------------------------------------------------------------------------------
const chatgpt = load('chatgpt-pathops.json');
const CHATGPT_DELTAS = ['Hello from ', 'a made-up ', 'synthetic ', 'stream. ', 'Second sentence.'];

test('chatgpt-pathops fixture is labelled synthetic', () => {
  assert.equal(chatgpt._synthetic, true);
  assert.equal(chatgpt._dialect, 'chatgpt-pathops');
});

test('chatgpt-pathops: SSE decode yields one event per payload, each carrying parsed json or the raw [DONE]', () => {
  const events = decodeSse(chatgpt.payloads);
  assert.equal(events.length, chatgpt.payloads.length);
  const jsonEvents = events.filter((e) => e.json !== undefined);
  assert.equal(jsonEvents.length, chatgpt.payloads.length - 1);
});

test('chatgpt-pathops: dialect detected as path-ops on the delta frames', () => {
  const deltaFrames = chatgpt.payloads.filter((p) => typeof p === 'object' && ('o' in p || ('v' in p && !('message' in p))));
  assert.ok(deltaFrames.length >= 4);
  for (const f of deltaFrames) assert.equal(detectDialect(f), 'path-ops');
  const asm = assemble(decodeSse(chatgpt.payloads));
  assert.ok(asm.detected.has('path-ops'));
});

test('chatgpt-pathops: full-message frame is not a dialect match (stored as a document snapshot)', () => {
  // CURRENT behaviour: detectDialect returns null for the initial full message object; the
  // assembler then stores it as the document because no dialect has been seen yet.
  assert.equal(detectDialect(chatgpt.payloads[0]), null);
  const asm = assemble(decodeSse(chatgpt.payloads));
  assert.equal(asm.doc.message.id, 'syn-msg-chatgpt-001');
});

test('chatgpt-pathops: final assembled text equals the concatenated deltas (incl. bare and patch-nested)', () => {
  const asm = assemble(decodeSse(chatgpt.payloads));
  assert.equal(asm.textOf('/message/content/parts/0'), CHATGPT_DELTAS.join(''));
});

test('chatgpt-pathops: finalize op lands on status and does not touch the text', () => {
  const asm = assemble(decodeSse(chatgpt.payloads));
  assert.equal(asm.doc.message.status, 'finished_successfully');
  assert.equal(asm.textOf('/message/content/parts/0').includes('finished_successfully'), false);
});

test('chatgpt-pathops: [DONE] is detected as the terminal marker of the stream', () => {
  const events = decodeSse(chatgpt.payloads);
  const last = events[events.length - 1];
  assert.equal(last.data, '[DONE]');
  assert.equal(last.terminal, true);
  assert.equal(events.slice(0, -1).some((e) => e.terminal), false);
});

// ---------------------------------------------------------------------------------------------
// claude-typedevents
// ---------------------------------------------------------------------------------------------
const claude = load('claude-typedevents.json');
const claudeDeltasForIndex = (idx) => claude.payloads
  .filter((p) => p.type === 'content_block_delta' && p.index === idx)
  .map((p) => p.delta.text)
  .join('');

test('claude-typedevents fixture is labelled synthetic', () => {
  assert.equal(claude._synthetic, true);
  assert.equal(claude._dialect, 'claude-typedevents');
});

test('claude-typedevents: dialect detected as typed-events; ping is not a dialect match', () => {
  for (const p of claude.payloads.filter((x) => x.type !== 'ping')) {
    assert.equal(detectDialect(p), 'typed-events', `payload type ${p.type}`);
  }
  // CURRENT behaviour: the bare ping object has no dialect and is refused (counted as unapplied).
  assert.equal(detectDialect({ type: 'ping' }), null);
  const asm = assemble(decodeSse(claude.payloads));
  assert.ok(asm.detected.has('typed-events'));
  assert.ok(asm.stats().unapplied >= 1);
});

test('claude-typedevents: each indexed block text equals its concatenated text_delta values', () => {
  const asm = assemble(decodeSse(claude.payloads));
  const blocks = asm.blocks();
  assert.deepEqual(blocks.map((b) => b.index), ['0', '1']);
  assert.equal(blocks[0].text, claudeDeltasForIndex(0));
  assert.equal(blocks[1].text, claudeDeltasForIndex(1));
});

test('claude-typedevents: mid-stream ping does not corrupt block text', () => {
  const asm = assemble(decodeSse(claude.payloads));
  for (const b of asm.blocks()) assert.equal(/ping/i.test(b.text ?? ''), false);
  assert.equal(asm.blocks()[0].text.includes('ping'), false);
});

test('claude-typedevents: message_delta usage and stop reason do not change block text', () => {
  const asm = assemble(decodeSse(claude.payloads));
  assert.equal(asm.doc.message.stop_reason, 'end_turn');
  assert.equal(asm.doc.message.usage.output_tokens, 34);
  for (const b of asm.blocks()) assert.equal(String(b.text).includes('34'), false);
});

test('claude-typedevents: message id preserved from message_start and each block marked done', () => {
  const asm = assemble(decodeSse(claude.payloads));
  assert.equal(asm.doc.message.id, 'syn-msg-claude-001');
  assert.ok(asm.blocks().every((b) => b.done === true));
});

test('claude-typedevents: message_stop is detected as the terminal event', () => {
  const events = decodeSse(claude.payloads);
  const last = events[events.length - 1];
  assert.equal(last.event, 'message_stop');
  assert.equal(last.terminal, true);
});

// ---------------------------------------------------------------------------------------------
// openai-responses
// ---------------------------------------------------------------------------------------------
const openai = load('openai-responses.json');
const openaiDeltas = openai.payloads
  .filter((p) => p.type === 'response.output_text.delta')
  .map((p) => p.delta)
  .join('');

test('openai-responses fixture is labelled synthetic', () => {
  assert.equal(openai._synthetic, true);
  assert.equal(openai._dialect, 'openai-responses');
});

test('openai-responses: dialect detected as typed-events (no provider-specific name)', () => {
  for (const p of openai.payloads) assert.equal(detectDialect(p), 'typed-events', `payload type ${p.type}`);
  const asm = assemble(decodeSse(openai.payloads));
  assert.ok(asm.detected.has('typed-events'));
});

test('openai-responses: output_text deltas concatenate to the single text-bearing block', () => {
  const asm = assemble(decodeSse(openai.payloads));
  const textBlocks = asm.blocks().filter((b) => typeof b.text === 'string' && b.text.length > 0);
  assert.equal(textBlocks.length, 1);
  assert.equal(textBlocks[0].text, openaiDeltas);
  assert.equal(textBlocks[0].text, openai.payloads.find((p) => p.type === 'response.output_text.done').text);
});

test('openai-responses: output_text.done marks the text block done', () => {
  const asm = assemble(decodeSse(openai.payloads));
  const textBlock = asm.blocks().find((b) => typeof b.text === 'string' && b.text.length > 0);
  assert.equal(textBlock.done, true);
});

test('openai-responses: response.completed (usage, status) is terminal and does not alter text', () => {
  const events = decodeSse(openai.payloads);
  const last = events[events.length - 1];
  assert.equal(last.event, 'response.completed');
  assert.equal(last.terminal, true);
  const asm = assemble(events);
  assert.equal(asm.doc.response.id, 'syn-resp-openai-001');
  assert.equal(asm.doc.response.status, 'completed');
  assert.equal(asm.blocks().some((b) => String(b.text ?? '').includes('total_tokens')), false);
});
