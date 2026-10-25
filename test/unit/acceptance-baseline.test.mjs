// Acceptance freshness (Core #68 / gap E06): G1/G2 with a pre-send baseline enforce post-send
// growth and match the FIRST new turn; a text match without a baseline is 'unknown' (the verdict
// can never be capture_accepted on historical text). Synthetic temp sessions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/store/session.mjs';
import { evaluateAcceptance, readAcceptance, writeAcceptance, reuseAcceptedContext, EVALUATOR_VERSION } from '../../src/capture/acceptance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'ai-chat-dialects', 'chatgpt-pathops.json'), 'utf8'));
const PROMPT = 'Say something synthetic please.';
const OLD_PROMPT = 'An earlier unrelated question?';
const REPLY = 'Hello from a made-up synthetic stream. Second sentence.';
const OLD_REPLY = 'A historical answer that merely re-rendered. Second sentence.';
const WORDS = ['hello', 'synthetic', 'second', 'sentence'];
const BASELINE = { userTurns: 1, assistantTurns: 1, sampledAt: '2026-10-24T10:00:00.000Z' };

function sseOf(payloads) {
  return payloads.map((p) => {
    if (typeof p === 'string') return `data: ${p}\n\n`;
    const ev = typeof p.type === 'string' ? `event: ${p.type}\n` : '';
    return `${ev}data: ${JSON.stringify(p)}\n\n`;
  }).join('');
}

// A saved, closed session whose DOM_TURNS shows a HISTORICAL turn pair plus (optionally) the new
// one. This is the false-positive lane from Core #68: matching text that existed before the send.
async function makeSession(t, { domTurns }) {
  const root = path.join(process.cwd(), '.tmp-acceptance-baseline-', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { mkdirSync, rmSync } = await import('node:fs');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = Session.create(root, { site: 'example', meta: { target: { url: 'https://chat.example.test/c/1' } } });
  const sse = sseOf(fixture.payloads);
  s.raw.append({ k: 'req', sid: 's1', url: 'https://chat.example.test/backend/conversation', method: 'POST', type: 'fetch', t: 1000 });
  s.raw.append({ k: 'res', sid: 's1', status: 200, mime: 'text/event-stream', protocol: 'h2', t: 1001 });
  s.raw.append({ k: 'chunk', sid: 's1', b64: Buffer.from(sse).toString('base64'), t: 1002 });
  s.raw.append({ k: 'done', sid: 's1', encodedDataLength: sse.length, t: 1003 });
  await s.raw.close();
  s.meta.status = 'complete';
  s.saveMeta();
  s.kv.set('ASSEMBLED', { s1: { endpoint: 'POST /backend/conversation', revisions: 5 } });
  s.kv.set('KNOWLEDGE_STATUS', { schema: 'capture-studio.knowledge-status/1', status: 'complete', entityCount: 0, entitiesDatasetPresent: false });
  s.kv.set('DOM_TURNS', domTurns);
  return s;
}

const gateValues = (doc) => Object.fromEntries(Object.entries(doc.gates).map(([k, v]) => [k, v.value]));
const historical = () => [
  { id: 'u0', role: 'user', text: OLD_PROMPT },
  { id: 'a0', role: 'assistant', text: OLD_REPLY },
];
const withNewTurns = () => [...historical(),
  { id: 'u1', role: 'user', text: PROMPT },
  { id: 'a1', role: 'assistant', text: REPLY },
];

test('baseline freshness: prompt + reply in NEW turns after the baseline pass G1/G2', async (t) => {
  const s = await makeSession(t, { domTurns: withNewTurns() });
  const doc = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT, expectedReplyWords: WORDS,
    completionRule: { requireDone: true, stableObserved: true }, baseline: BASELINE } });
  assert.deepEqual(gateValues(doc), { G1: 'passed', G2: 'passed', G3: 'passed', G4: 'passed', G5: 'passed', G6: 'passed', G7: 'passed' }, JSON.stringify(doc.gates));
  assert.equal(doc.verdict, 'capture_accepted');
  assert.equal(doc.gates.G1.evidence.freshness, 'pre-send baseline enforced');
  assert.equal(doc.gates.G2.evidence.baselineAssistantTurns, 1);
});

test('baseline freshness: a historical transcript that never grew FAILS G1/G2 even when the text matches', async (t) => {
  const s = await makeSession(t, { domTurns: historical() });
  // The historical prompt/reply text is deliberately fed as the expected context: text equality
  // without post-send growth is exactly the false positive this gate exists to refuse.
  const doc = await evaluateAcceptance({ session: s, conversation: { prompt: OLD_PROMPT, expectedReplyWords: ['historical', 'answer', 'second', 'sentence'],
    completionRule: { requireDone: true, stableObserved: true }, baseline: BASELINE } });
  assert.equal(doc.gates.G1.value, 'failed');
  assert.equal(doc.gates.G2.value, 'failed');
  assert.match(doc.gates.G1.reason, /no user turn rendered after the pre-send baseline/);
  assert.equal(doc.verdict, 'capture_rejected');
});

test('baseline freshness: growth to the WRONG text fails; the matched turn is the first new one, not merely the newest', async (t) => {
  const s = await makeSession(t, { domTurns: [...historical(),
    { id: 'u1', role: 'user', text: 'A different new prompt entirely' },
    { id: 'a1', role: 'assistant', text: OLD_REPLY },
    { id: 'a2', role: 'assistant', text: REPLY }] });
  const doc = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT, expectedReplyWords: WORDS,
    completionRule: { requireDone: true, stableObserved: true }, baseline: BASELINE } });
  assert.equal(doc.gates.G1.value, 'failed', doc.gates.G1.reason);
  // The first NEW assistant turn (a1) is the attribution target; a later new turn (a2) with the
  // expected words does not satisfy turn attribution for this send.
  assert.equal(doc.gates.G2.value, 'failed', doc.gates.G2.reason);
  assert.equal(doc.verdict, 'capture_rejected');
});

test('no baseline: a text match is UNKNOWN (capture_incomplete), never accepted — even a consistent capture', async (t) => {
  // G1/G2 match the newest turns and G7 reconciles, yet without the pre-send cursor the verdict
  // stays honest: capture_incomplete. The baseline is what makes capture_accepted reachable.
  const s = await makeSession(t, { domTurns: withNewTurns() });
  const doc = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT, expectedReplyWords: WORDS,
    completionRule: { requireDone: true, stableObserved: true } } });
  assert.equal(doc.gates.G1.value, 'unknown');
  assert.equal(doc.gates.G2.value, 'unknown');
  assert.match(doc.gates.G1.reason, /freshness is unproven/);
  assert.equal(doc.gates.G1.evidence.freshness, 'unproven (no baseline supplied)');
  assert.equal(doc.verdict, 'capture_incomplete');
});

test('no baseline over a purely historical transcript: G1/G2 unknown and G7 rejects the mismatched reply', async (t) => {
  const s = await makeSession(t, { domTurns: historical() });
  const doc = await evaluateAcceptance({ session: s, conversation: { prompt: OLD_PROMPT, expectedReplyWords: ['historical', 'answer', 'second', 'sentence'],
    completionRule: { requireDone: true, stableObserved: true } } });
  assert.equal(doc.gates.G1.value, 'unknown');
  assert.equal(doc.gates.G2.value, 'unknown');
  assert.equal(doc.verdict, 'capture_rejected', 'the historical DOM reply does not reconcile with the assembled stream');
});

test('no baseline: a mismatch is still a definite failure, not unknown', async (t) => {
  const s = await makeSession(t, { domTurns: historical() });
  const doc = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT,
    completionRule: { requireDone: true, stableObserved: true } } });
  assert.equal(doc.gates.G1.value, 'failed');
  assert.equal(doc.verdict, 'capture_rejected');
});

test('malformed baseline shapes are unknown, never silently coerced', async (t) => {
  const s = await makeSession(t, { domTurns: withNewTurns() });
  for (const bad of [{ userTurns: -1, assistantTurns: 0 }, { userTurns: 1 }, { userTurns: 1.5, assistantTurns: 1 }, '1', 42]) {
    const doc = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT, baseline: bad } });
    assert.equal(doc.gates.G1.value, 'unknown', JSON.stringify(bad));
    assert.match(doc.gates.G1.reason, /malformed/);
  }
});

test('evaluator version bump refuses to reuse accepted G1-G3 across the semantics change', async (t) => {
  const s = await makeSession(t, { domTurns: withNewTurns() });
  const current = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT, expectedReplyWords: WORDS,
    completionRule: { requireDone: true, stableObserved: true }, baseline: BASELINE } });
  assert.equal(EVALUATOR_VERSION, '1.1.0');
  const forged = { ...current, evaluator: { version: '1.0.0' } };
  writeAcceptance(s, forged);
  const stored = readAcceptance(s);
  assert.equal(stored.verdict, 'capture_accepted');
  const next = await evaluateAcceptance({ session: s, conversation: null });
  const reused = reuseAcceptedContext(stored, next);
  assert.equal(reused, next, 'a previous accepted document from another evaluator version must not supply G1-G3');
});
