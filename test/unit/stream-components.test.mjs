// Stream-to-component map wired into derive: each committed AI-chat dialect fixture is replayed as
// raw SSE into a temp session, derived, and checked against kv STREAM_COMPONENTS. Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';
import { derive } from '../../src/replay/derive.mjs';
import { ScopedLearner } from '../../src/intel/learn.mjs';
import { buildStreamComponents } from '../../src/replay/stream-components.mjs';

const SCHEMA = 'capture-studio.stream-components/1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'ai-chat-dialects');
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')).payloads;

// One SSE event per payload: objects as JSON, strings verbatim (the "[DONE]" marker).
function sseOf(payloads) {
  return payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');
}

// streams: [{ sid, body }] in order; each becomes one HTTP event-stream response.
async function seed(paths, streams) {
  const s = Session.create(paths.sessions, { site: 'components-test' });
  for (const { sid, body } of streams) {
    s.raw.append({ k: 'req', sid, url: 'https://chat.example.test/api/chat', method: 'POST', type: 'Fetch' });
    s.raw.append({ k: 'res', sid, status: 200, mime: 'text/event-stream' });
    s.raw.append({ k: 'chunk', sid, b64: Buffer.from(body).toString('base64') });
    s.raw.append({ k: 'done', sid, encodedDataLength: 1 });
  }
  await s.raw.close();
  return s;
}

function env(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stream-components-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = new ProfileStore(paths.profiles).load('generic');
  const learner = new ScopedLearner(path.join(root, 'learner'));
  return { root, paths, profile, learner };
}

const streamOf = (doc, sid) => doc.streams.find((x) => x.sid === sid);

test('claude typed-events fixture -> claude-typed-events; two paragraph parts with concatenated deltas', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-claude', body: sseOf(fixture('claude-typedevents.json')) }]);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  assert.equal(doc.schema, SCHEMA);
  const st = streamOf(doc, 's-claude');
  assert.equal(st.mapId, 'claude-typed-events');
  assert.equal(st.components[0].component, 'message');
  assert.equal(st.components[0].componentKey, null, 'message_start has no block index, so no key is invented');
  const paras = st.components.filter((c) => c.component === 'paragraph');
  assert.deepEqual(paras.map((c) => c.componentKey), ['syn-msg-claude-001:0', 'syn-msg-claude-001:1']);
  assert.equal(paras[0].text, 'Synthetic block zero says hello to a made-up reader.');
  assert.equal(paras[1].text, 'Block one is a second fake paragraph.');
  assert.ok(paras.every((c) => c.closed !== null), 'both blocks saw content_block_stop');
  assert.equal(st.unmappedCount, 0);
  assert.equal(doc.totals.mapped, 1);
});

test('chatgpt path-ops fixture -> chatgpt-path-ops; patch envelope and bare continuation feed one part', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-chatgpt', body: sseOf(fixture('chatgpt-pathops.json')) }]);
  await derive(s, e.profile, { learner: e.learner });
  const st = streamOf(s.kv.get('STREAM_COMPONENTS'), 's-chatgpt');
  assert.equal(st.mapId, 'chatgpt-path-ops');
  assert.equal(st.components[0].componentKey, null);
  const paras = st.components.filter((c) => c.component === 'paragraph');
  assert.deepEqual(paras.map((c) => c.componentKey), ['syn-msg-chatgpt-001:0']);
  assert.equal(paras[0].text, 'Hello from a made-up synthetic stream. Second sentence.');
  assert.equal(paras[0].closed !== null, true, 'finalize closes open parts');
  assert.equal(st.unmappedCount, 0);
});

test('openai responses fixture -> openai-responses; output_text deltas build one part keyed by output_index', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-openai', body: sseOf(fixture('openai-responses.json')) }]);
  await derive(s, e.profile, { learner: e.learner });
  const st = streamOf(s.kv.get('STREAM_COMPONENTS'), 's-openai');
  assert.equal(st.mapId, 'openai-responses');
  const paras = st.components.filter((c) => c.component === 'paragraph');
  assert.deepEqual(paras.map((c) => c.componentKey), ['syn-resp-openai-001:0']);
  assert.equal(paras[0].text, 'Synthetic Responses reply with a made-up ending.');
  assert.equal(paras[0].text, fixture('openai-responses.json')[6].text, 'equals the done event text');
  assert.equal(st.unmappedCount, 0);
});

test('unknown dialect -> mapId null with candidates and no components (never a guessed map)', async (t) => {
  const e = env(t);
  const body = sseOf([{ foo: 'bar' }, { baz: [1, 2] }]);
  const s = await seed(e.paths, [{ sid: 's-unknown', body }]);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  const st = streamOf(doc, 's-unknown');
  assert.equal(st.mapId, null);
  assert.deepEqual(st.candidates.map((c) => c.matched), [0, 0, 0]);
  assert.equal('components' in st, false);
  assert.equal(doc.totals.noMap, 1);
});

test('streams are ordered by first seq; an unknown stream first leaves a known one second', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [
    { sid: 's-unknown', body: sseOf([{ foo: 1 }]) },
    { sid: 's-claude', body: sseOf(fixture('claude-typedevents.json')) },
  ]);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  assert.deepEqual(doc.streams.map((x) => x.sid), ['s-unknown', 's-claude']);
  assert.equal(doc.streams[0].mapId, null);
  assert.equal(doc.streams[1].mapId, 'claude-typed-events');
});

test('component text is capped at 2000 chars with textTruncated and the real length', async (t) => {
  const e = env(t);
  const long = 'a'.repeat(2500);
  const body = sseOf([
    { type: 'message_start', message: { id: 'syn-msg-long' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: long } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]);
  const s = await seed(e.paths, [{ sid: 's-long', body }]);
  await derive(s, e.profile, { learner: e.learner });
  const para = streamOf(s.kv.get('STREAM_COMPONENTS'), 's-long').components.find((c) => c.component === 'paragraph');
  assert.equal(para.text.length, 2000);
  assert.equal(para.textTruncated, true);
  assert.equal(para.textLength, 2500);
});

test('re-deriving the same raw log writes byte-identical STREAM_COMPONENTS', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [
    { sid: 's-claude', body: sseOf(fixture('claude-typedevents.json')) },
    { sid: 's-openai', body: sseOf(fixture('openai-responses.json')) },
  ]);
  await derive(s, e.profile, { learner: e.learner });
  const first = JSON.stringify(s.kv.get('STREAM_COMPONENTS'));
  await derive(s, e.profile, { learner: e.learner });
  const second = JSON.stringify(s.kv.get('STREAM_COMPONENTS'));
  assert.equal(second, first);
  assert.equal(s.kv.get('STREAM_COMPONENTS').totals.mapped, 2);
});

test('no response streams -> status no_events', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, []);
  await derive(s, e.profile, { learner: e.learner });
  assert.deepEqual(s.kv.get('STREAM_COMPONENTS'), { schema: SCHEMA, status: 'no_events' });
  assert.equal(s.kv.get('RECEIPT').stream_components, 'no_events');
});

test('derive still succeeds when the component pass throws; the failure is recorded in STREAM_COMPONENTS', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-claude', body: sseOf(fixture('claude-typedevents.json')) }]);
  const result = await derive(s, e.profile, {
    learner: e.learner,
    componentsImpl: () => { throw new Error('injected components failure'); },
  });
  assert.deepEqual(s.kv.get('STREAM_COMPONENTS'), { schema: SCHEMA, error: 'injected components failure' });
  assert.equal(s.kv.get('RECEIPT').stream_components, 'error');
  assert.ok(result.receipt, 'derive returns its receipt');
  assert.ok(s.kv.get('KNOWLEDGE_STATUS'), 'the knowledge layer still ran and recorded its outcome');
});

test('GET /api/sessions/:id/components returns the kv, not_derived when underived, 405 for POST', async (t) => {
  const e = env(t);
  const derived = await seed(e.paths, [{ sid: 's-claude', body: sseOf(fixture('claude-typedevents.json')) }]);
  await derive(derived, e.profile, { learner: e.learner });
  const bare = Session.create(e.paths.sessions, { site: 'components-test' });
  await bare.raw.close();
  const runtime = {
    isSessionActive: () => false, close: async () => {},
    targets: async () => ({ sites: [], targets: [] }), list: async () => [],
  };
  const studio = await startStudio({ paths: e.paths, profileStore: new ProfileStore(e.paths.profiles),
    conversationRuntime: runtime, port: 0, accessMode: 'local' });
  t.after(() => studio.close());
  const get = async (id) => {
    const r = await fetch(`http://127.0.0.1:${studio.port}/api/sessions/${id}/components`);
    return { status: r.status, body: await r.json() };
  };
  const got = await get(derived.id);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, derived.kv.get('STREAM_COMPONENTS'));
  const none = await get(bare.id);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, { status: 'not_derived' });
  const post = await fetch(`http://127.0.0.1:${studio.port}/api/sessions/${derived.id}/components`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
});

// ---------------------------------------------------------------------------------------------
// Signals in the kv. Synthetic only: made-up ids, codes and a distinctive message word.
// ---------------------------------------------------------------------------------------------

const SIG_WORD = 'zephyrquartz';
const SIG_TEXT = `Synthetic ${SIG_WORD} notice.`;
const P0 = '/message/content/parts/0';
const SIG_KEYS = ['errorCount', 'statusCount', 'codes', 'sample'];

// A reply with a shape-A error envelope between two text deltas, then [DONE].
const errorReply = () => sseOf([
  { message: { id: 'syn-msg-err-1', content: { parts: [''] } }, conversation_id: 'syn-conv-err' },
  { p: P0, o: 'append', v: 'Synthetic reply. ' },
  { v: { conversation_id: 'syn-conv-err', error: 'syn-error', error_code: 'syn_rate_limit', message: SIG_TEXT } },
  { p: P0, o: 'append', v: 'Second.' },
  '[DONE]',
]);

test('error stream: a reply with an interleaved error envelope keeps its paragraph, finalizes, and reports hadError', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-err', body: errorReply() }]);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  const st = streamOf(doc, 's-err');
  assert.equal(st.mapId, 'chatgpt-path-ops');
  assert.equal(st.hadError, true);
  assert.equal(st.unmappedCount, 0);
  const para = st.components.find((c) => c.component === 'paragraph');
  assert.equal(para.text, 'Synthetic reply. Second.');
  assert.notEqual(para.closed, null, '[DONE] finalizes the part');
  assert.equal(st.signals.errorCount, 1);
  assert.equal(st.signals.statusCount, 0);
  assert.deepEqual(st.signals.codes, [{ code: 'syn_rate_limit', count: 1 }]);
  assert.equal(st.signals.sample.length, 1);
  assert.equal(st.signals.sample[0].kind, 'error');
  assert.equal(st.signals.sample[0].code, 'syn_rate_limit');
  assert.equal(st.signals.sample[0].messageChars, SIG_TEXT.length);
  assert.equal(doc.totals.streamsWithErrors, 1);
  assert.equal(JSON.stringify(doc).includes(SIG_WORD), false, 'message text never reaches the kv');
});

test('no-error stream: hadError false, empty signal summary, streamsWithErrors 0; the kv shape is stable', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-claude', body: sseOf(fixture('claude-typedevents.json')) }]);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  const st = streamOf(doc, 's-claude');
  assert.equal(st.hadError, false);
  assert.deepEqual(Object.keys(st.signals), SIG_KEYS);
  assert.deepEqual(st.signals, { errorCount: 0, statusCount: 0, codes: [], sample: [] });
  assert.equal(doc.totals.streamsWithErrors, 0);
  assert.ok('streamsWithErrors' in doc.totals);
  assert.equal('stats' in st, true, 'existing per-stream fields are kept');
  assert.equal('unmappedSample' in st, true);
});

test('unknown-dialect stream: hadError is null (no map ran, so unknown) and it has no signal summary', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-unknown', body: sseOf([{ foo: 'bar' }]) }]);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  const st = streamOf(doc, 's-unknown');
  assert.equal(st.hadError, null);
  assert.equal('signals' in st, false);
  assert.equal(doc.totals.streamsWithErrors, 0);
});

test('signal summary: codes capped at 5 (count, then code order) and sample capped at 5 in input order', () => {
  const events = Array.from({ length: 7 }, (_, i) => ({
    sid: 'syn-cap', seq: i, n: i, json: { v: { error_code: `syn_code_${i}`, message: 'x'.repeat(i + 1) } },
  }));
  const doc = buildStreamComponents(new Map([['syn-cap', { events, omitted: 0 }]]));
  const st = doc.streams[0];
  assert.equal(st.mapId, 'chatgpt-path-ops');
  assert.equal(st.hadError, true);
  assert.equal(st.signals.errorCount, 7);
  assert.equal(st.signals.codes.length, 5);
  assert.deepEqual(st.signals.codes[0], { code: 'syn_code_0', count: 1 });
  assert.equal(st.signals.sample.length, 5);
  assert.deepEqual(st.signals.sample.map((x) => x.seq), [0, 1, 2, 3, 4]);
  assert.equal(st.signals.sample[2].messageChars, 3);
  assert.equal(doc.totals.streamsWithErrors, 1);
});

test('signal summary: a null code is counted as its own code entry', () => {
  const events = [
    // ADJUSTED in the correction turn: error is non-null so this is a real error with a null code.
    { sid: 'syn-null', seq: 0, n: 0, json: { v: { error: 'syn-error', error_code: null, message: 'abc' } } },
    { sid: 'syn-null', seq: 1, n: 1, json: { v: { error_code: 'syn_ok', message: 'de' } } },
  ];
  const doc = buildStreamComponents(new Map([['syn-null', { events, omitted: 0 }]]));
  assert.deepEqual(doc.streams[0].signals.codes, [{ code: 'syn_ok', count: 1 }, { code: null, count: 1 }]);
  assert.equal(doc.streams[0].signals.sample[0].code, null);
});

test('re-deriving an error stream writes byte-identical STREAM_COMPONENTS', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-err', body: errorReply() }]);
  await derive(s, e.profile, { learner: e.learner });
  const first = JSON.stringify(s.kv.get('STREAM_COMPONENTS'));
  await derive(s, e.profile, { learner: e.learner });
  assert.equal(JSON.stringify(s.kv.get('STREAM_COMPONENTS')), first);
});

// Real-shaped frames (correction): rendered with their SSE event names, which the survey rules read.
const frameFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')).frames;
const framesSse = (frames) => frames.map((f) => `${f.event ? `event: ${f.event}\n` : ''}data: ${typeof f.raw === 'string' ? f.raw : JSON.stringify(f.json)}\n\n`).join('');

test('real-shaped ChatGPT v1 fixture: one message and one paragraph, hadError false, no unmapped, no streams with errors', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, [{ sid: 's-v1', body: framesSse(frameFixture('chatgpt-pathops-v1.json')) }]);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  const st = streamOf(doc, 's-v1');
  assert.equal(st.mapId, 'chatgpt-path-ops');
  assert.equal(st.hadError, false);
  assert.equal(st.unmappedCount, 0);
  assert.equal(st.components.filter((c) => c.component === 'message').length, 1);
  const paras = st.components.filter((c) => c.component === 'paragraph');
  assert.equal(paras.length, 1);
  assert.equal(paras[0].text, 'Synthetic made-up text.');
  assert.notEqual(paras[0].closed, null, 'message_stream_complete finalizes the part');
  assert.deepEqual(st.signals, { errorCount: 0, statusCount: 0, codes: [], sample: [] });
  assert.equal(doc.totals.streamsWithErrors, 0);
});

test('real-shaped ChatGPT v1 fixture with an injected error frame: hadError true, paragraph still built', async (t) => {
  const e = env(t);
  const frames = frameFixture('chatgpt-pathops-v1.json');
  const injected = [...frames.slice(0, 3), { event: 'message', json: { v: { conversation_id: 'syn-conv-v1-001', error: 'syn-error', error_code: 'syn_code_v1', message: SIG_TEXT } } }, ...frames.slice(3)];
  const s = await seed(e.paths, [{ sid: 's-v1-err', body: framesSse(injected) }]);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  const st = streamOf(doc, 's-v1-err');
  assert.equal(st.hadError, true);
  assert.equal(st.signals.errorCount, 1);
  assert.deepEqual(st.signals.codes, [{ code: 'syn_code_v1', count: 1 }]);
  assert.equal(st.components.find((c) => c.component === 'paragraph').text, 'Synthetic made-up text.');
  assert.equal(st.unmappedCount, 0);
  assert.equal(doc.totals.streamsWithErrors, 1);
  assert.equal(JSON.stringify(doc).includes(SIG_WORD), false);
});
