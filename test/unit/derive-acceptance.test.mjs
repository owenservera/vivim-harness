// Derive wiring for the offline acceptance label (acceptance.json + receipt line, read-only route)
// and the stream side of join links (stream.sid, raw text preview). Synthetic temp sessions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';
import { derive } from '../../src/replay/derive.mjs';
import { ScopedLearner } from '../../src/intel/learn.mjs';
import { ACCEPTANCE_SCHEMA, evaluateAcceptance, readAcceptance } from '../../src/capture/acceptance.mjs';

const STREAM = 's-accept';
// Short on purpose: the assembled-text picker prefers a longer meta id over a shorter reply (see report).
// A realistic provider-style id: longer than the short synthetic reply ("Hello there"). A shorter id used
// to hide a bug where the assembled-text picker chose the message id over the reply (G7 then failed).
const MSG_ID = 'msg_01XFDUDYJgAACzvnptvVoYEL';
const PROMPT = 'Say hello';
const LONG = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
const strip = ({ evaluatedAt, ...rest }) => rest;

// One typed-events SSE reply with a message id and a terminal marker (message_stop and [DONE]).
function sse(text) {
  const lines = [
    `data: ${JSON.stringify({ type: 'message_start', message: { id: MSG_ID } })}`, '',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', '',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`, '',
    'data: {"type":"content_block_stop","index":0}', '',
    'data: {"type":"message_stop"}', '', 'data: [DONE]', '',
  ];
  return lines.join('\n') + '\n';
}

// A saved session with status complete, one SSE reply, and DOM turns for the prompt and the reply.
async function seed(paths, { reply = 'Hello there', domReply = reply } = {}) {
  const s = Session.create(paths.sessions, { site: 'accept-test', meta: { status: 'complete', target: { url: 'https://chat.example.test/c/1' } } });
  s.raw.append({ k: 'req', sid: STREAM, url: 'https://chat.example.test/api/chat', method: 'POST', type: 'Fetch' });
  s.raw.append({ k: 'res', sid: STREAM, status: 200, mime: 'text/event-stream' });
  s.raw.append({ k: 'chunk', sid: STREAM, b64: Buffer.from(sse(reply)).toString('base64') });
  s.raw.append({ k: 'done', sid: STREAM, encodedDataLength: 1 });
  await s.raw.close();
  s.kv.set('DOM_TURNS', [
    { index: 0, id: 'u1', domId: 'dom-u1', role: 'user', text: PROMPT, blocks: [{ ord: 0, type: 'paragraph', text: PROMPT }] },
    { index: 1, id: 'a1', domId: 'dom-a1', role: 'assistant', text: domReply, blocks: [{ ord: 0, type: 'paragraph', text: domReply }] },
  ]);
  return s;
}

function env(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'derive-acceptance-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = new ProfileStore(paths.profiles).load('generic');
  const learner = new ScopedLearner(path.join(root, 'learner'));
  return { root, paths, profile, learner };
}

async function studioFor(t, e) {
  const runtime = {
    isSessionActive: () => false, close: async () => {},
    targets: async () => ({ sites: [], targets: [] }), list: async () => [],
  };
  const studio = await startStudio({ paths: e.paths, profileStore: new ProfileStore(e.paths.profiles),
    conversationRuntime: runtime, port: 0, accessMode: 'local' });
  t.after(() => studio.close());
  return studio;
}

test('derive writes acceptance.json and a receipt line for a clean synthetic session; no conversation context gives capture_incomplete', async (t) => {
  const e = env(t);
  const s = await seed(e.paths);
  await derive(s, e.profile, { learner: e.learner });
  const file = path.join(s.dir, 'acceptance.json');
  assert.ok(existsSync(file), 'acceptance.json written by derive');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.schema, ACCEPTANCE_SCHEMA);
  assert.equal(doc.verdict, 'capture_incomplete', JSON.stringify(doc.reasons));
  for (const id of ['G1', 'G2', 'G3']) assert.equal(doc.gates[id].value, 'not-checked', id);
  for (const id of ['G4', 'G5', 'G6', 'G7']) assert.equal(doc.gates[id].value, 'passed', id);
  assert.equal(s.kv.get('RECEIPT').acceptance, 'verdict capture_incomplete: G1-G3 not-checked, G4-G7 passed');
});

test('GET /api/sessions/:id/acceptance returns the stored label; unassessed for a session without the file; POST evaluates with optional context', async (t) => {
  const e = env(t);
  const derived = await seed(e.paths);
  await derive(derived, e.profile, { learner: e.learner });
  const bare = Session.create(e.paths.sessions, { site: 'accept-test' });
  await bare.raw.close();
  const studio = await studioFor(t, e);
  const base = `http://127.0.0.1:${studio.port}/api/sessions`;
  const got = await fetch(`${base}/${derived.id}/acceptance`);
  assert.equal(got.status, 200);
  const body = await got.json();
  assert.equal(body.verdict, 'capture_incomplete');
  assert.deepEqual(body, readAcceptance(derived));
  const none = await fetch(`${base}/${bare.id}/acceptance`);
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { verdict: 'unassessed', reason: 'no acceptance.json' });
  // POST without context re-evaluates honestly: G1-G3 not-checked, G4-G7 re-derived, verdict incomplete.
  const post = await fetch(`${base}/${derived.id}/acceptance`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 200);
  const receipt = await post.json();
  assert.equal(receipt.verdict, 'capture_incomplete');
  assert.equal(receipt.gates.G1, 'not-checked');
  assert.equal(receipt.gates.G4, 'passed');
  assert.deepEqual(await (await fetch(`${base}/${derived.id}/acceptance`)).json(), readAcceptance(derived));
  // Malformed context fails closed before any evaluation or write.
  const bad = await fetch(`${base}/${derived.id}/acceptance`, { method: 'POST',
    body: JSON.stringify({ conversation: { prompt: 'x', baseline: { userTurns: -1, assistantTurns: 0 } } }) });
  assert.equal(bad.status, 400);
  const badUnexpected = await fetch(`${base}/${derived.id}/acceptance`, { method: 'POST',
    body: JSON.stringify({ conversation: { prompt: 'x', forged: true } }) });
  assert.equal(badUnexpected.status, 400);
});

test('tampering with a raw segment after derive makes the route return unassessed', async (t) => {
  const e = env(t);
  const s = await seed(e.paths);
  await derive(s, e.profile, { learner: e.learner });
  const studio = await studioFor(t, e);
  const url = `http://127.0.0.1:${studio.port}/api/sessions/${s.id}/acceptance`;
  assert.equal((await (await fetch(url)).json()).verdict, 'capture_incomplete');
  appendFileSync(path.join(s.rawDir, '000001.jsonl'), '\n');
  const body = await (await fetch(url)).json();
  assert.equal(body.verdict, 'unassessed');
  assert.match(body.reasons.join(' '), /raw digest changed/);
});

test('deriving twice keeps the label readable, the digest unchanged, and the document identical apart from evaluatedAt', async (t) => {
  const e = env(t);
  const s = await seed(e.paths);
  await derive(s, e.profile, { learner: e.learner });
  const file = path.join(s.dir, 'acceptance.json');
  const first = JSON.parse(readFileSync(file, 'utf8'));
  const receipt1 = s.kv.get('RECEIPT').acceptance;
  await derive(s, e.profile, { learner: e.learner });
  const second = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(second.binding.rawDigest, first.binding.rawDigest, 're-derive must not change raw');
  assert.equal(s.kv.get('RECEIPT').acceptance, receipt1);
  assert.deepEqual(strip(second), strip(first));
  assert.equal(readAcceptance(s).verdict, 'capture_incomplete');
  const a = await evaluateAcceptance({ session: s });
  const b = await evaluateAcceptance({ session: s });
  assert.deepEqual(strip(a), strip(b));
});

test('derive still succeeds when the acceptance evaluator throws; the error is recorded in the receipt line', async (t) => {
  const e = env(t);
  const s = await seed(e.paths);
  const result = await derive(s, e.profile, {
    learner: e.learner,
    acceptanceImpl: async () => { throw new Error('injected acceptance failure'); },
  });
  assert.ok(result.receipt, 'derive returns its receipt');
  assert.equal(s.kv.get('RECEIPT').acceptance, 'error: injected acceptance failure');
  assert.equal(existsSync(path.join(s.dir, 'acceptance.json')), false);
  assert.ok(s.kv.get('KNOWLEDGE_STATUS'), 'knowledge layer still recorded its outcome');
  assert.equal(s.kv.get('STREAM_DOM_JOIN').summary.messageStatus.verified, 1);
});

test('join links carry the stream sid and a raw 160-character preview; re-derive is byte-identical', async (t) => {
  const e = env(t);
  const long = await seed(e.paths, { reply: LONG });
  await derive(long, e.profile, { learner: e.learner });
  const j = long.kv.get('STREAM_DOM_JOIN');
  const msg = j.links.find((l) => l.messageKey === MSG_ID);
  assert.equal(msg.status, 'verified');
  assert.deepEqual(msg.stream, { sid: STREAM, textPreview: LONG.slice(0, 160), textLength: LONG.length, textTruncated: true });
  assert.equal(msg.stream.textPreview.length, 160);
  const userLink = j.links.find((l) => l.turnId === 'u1');
  assert.equal(userLink.messageIndex, null);
  assert.equal('stream' in userLink, false, 'links without a stream message carry no stream field');
  const first = JSON.stringify(j);
  await derive(long, e.profile, { learner: e.learner });
  assert.equal(JSON.stringify(long.kv.get('STREAM_DOM_JOIN')), first);

  const short = await seed(e.paths, { reply: '**Hello** there', domReply: 'Hello there' });
  await derive(short, e.profile, { learner: e.learner });
  const sm = short.kv.get('STREAM_DOM_JOIN').links.find((l) => l.messageKey === MSG_ID);
  assert.deepEqual(sm.stream, { sid: STREAM, textPreview: '**Hello** there', textLength: 15, textTruncated: false });
});
