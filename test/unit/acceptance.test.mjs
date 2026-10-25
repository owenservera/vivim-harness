// Offline acceptance label (G1-G7). Synthetic temp sessions only; no Chrome, no network.
// The reply stream is the synthetic chatgpt-pathops fixture (test/fixtures/ai-chat-dialects),
// wrapped as SSE in a raw req/res/chunk/done sequence, so the reply text comes through the real reducer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/store/session.mjs';
import {
  ACCEPTANCE_SCHEMA, EVALUATOR_VERSION, DEFAULT_RECIPE,
  evaluateAcceptance, writeAcceptance, readAcceptance,
} from '../../src/capture/acceptance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'ai-chat-dialects', 'chatgpt-pathops.json'), 'utf8'));
const PROMPT = 'Say something synthetic please.';
const REPLY = 'Hello from a made-up synthetic stream. Second sentence.';
const WORDS = ['hello', 'synthetic', 'second', 'sentence'];
// The baseline cursor is the honest pre-send truth for this fixture: an empty page before the
// send (0/0), measured by the same full-DOM scan that produced DOM_TURNS. G1/G2 enforce growth
// from it; without a baseline a text match alone can no longer reach capture_accepted.
const CONVERSATION = { prompt: PROMPT, expectedReplyWords: WORDS, completionRule: { requireDone: true, stableObserved: true }, baseline: { userTurns: 0, assistantTurns: 0 } };

function sseOf(payloads) {
  return payloads.map((p) => {
    if (typeof p === 'string') return `data: ${p}\n\n`;
    const ev = typeof p.type === 'string' ? `event: ${p.type}\n` : '';
    return `${ev}data: ${JSON.stringify(p)}\n\n`;
  }).join('');
}

function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

// Builds a saved, closed session. extra = raw records appended after the reply sequence.
async function makeSession(t, { domText = REPLY, dom = true, extra = [], status = 'complete', derive = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acceptance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = Session.create(root, { site: 'example', meta: { target: { url: 'https://chat.example.test/c/1' } } });
  const sse = sseOf(fixture.payloads);
  s.raw.append({ k: 'req', sid: 's1', url: 'https://chat.example.test/backend/conversation', method: 'POST', type: 'fetch', t: 1000 });
  s.raw.append({ k: 'res', sid: 's1', status: 200, mime: 'text/event-stream', protocol: 'h2', t: 1001 });
  s.raw.append({ k: 'chunk', sid: 's1', b64: Buffer.from(sse).toString('base64'), t: 1002 });
  s.raw.append({ k: 'done', sid: 's1', encodedDataLength: sse.length, t: 1003 });
  for (const rec of extra) s.raw.append(rec);
  await s.raw.close();
  s.meta.status = status;
  s.saveMeta();
  if (derive) {
    // Real derive writes ASSEMBLED with the stream doc; this fixture only needs the stream keys.
    s.kv.set('ASSEMBLED', { s1: { endpoint: 'POST /backend/conversation', revisions: 5 } });
    s.kv.set('KNOWLEDGE_STATUS', { schema: 'capture-studio.knowledge-status/1', status: 'complete', entityCount: 0, entitiesDatasetPresent: false });
  }
  if (dom) {
    s.kv.set('DOM_TURNS', [
      { id: 'u1', role: 'user', text: PROMPT },
      { id: 'a1', role: 'assistant', text: domText },
    ]);
  }
  return s;
}

const gateValues = (doc) => Object.fromEntries(Object.entries(doc.gates).map(([k, g]) => [k, g.value]));

test('clean complete session with matching DOM turn and full context is capture_accepted', async (t) => {
  const s = await makeSession(t);
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.schema, ACCEPTANCE_SCHEMA);
  assert.equal(doc.evaluator.version, EVALUATOR_VERSION);
  assert.deepEqual(gateValues(doc), { G1: 'passed', G2: 'passed', G3: 'passed', G4: 'passed', G5: 'passed', G6: 'passed', G7: 'passed' }, JSON.stringify(doc.gates));
  assert.equal(doc.verdict, 'capture_accepted', JSON.stringify(doc.reasons));
  assert.deepEqual(doc.reasons, []);
  assert.equal(doc.binding.recipe.id, DEFAULT_RECIPE.id);
  assert.equal(doc.binding.recipe.version, DEFAULT_RECIPE.version);
  assert.deepEqual(doc.binding.seqRange, [1, 4]);
  assert.match(doc.binding.rawDigest, /^[0-9a-f]{64}$/);
  assert.equal(doc.gates.G7.evidence.status, 'consistent');
});

test('same session without conversation is capture_incomplete with G1-G3 not-checked', async (t) => {
  const s = await makeSession(t);
  const doc = await evaluateAcceptance({ session: s });
  assert.equal(doc.gates.G1.value, 'not-checked');
  assert.equal(doc.gates.G2.value, 'not-checked');
  assert.equal(doc.gates.G3.value, 'not-checked');
  for (const id of ['G4', 'G5', 'G6', 'G7']) assert.equal(doc.gates[id].value, 'passed', id);
  assert.equal(doc.verdict, 'capture_incomplete');
  assert.equal(doc.reasons.length, 3);
});

test('G3 with conversation but no completionRule is unknown, and a missing stableObserved flag is never a pass', async (t) => {
  const s = await makeSession(t);
  const noRule = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT, expectedReplyWords: WORDS } });
  assert.equal(noRule.gates.G3.value, 'unknown');
  assert.equal(noRule.verdict, 'capture_incomplete');
  const noFlag = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT, completionRule: { requireDone: true } } });
  assert.equal(noFlag.gates.G3.value, 'unknown');
  const unstable = await evaluateAcceptance({ session: s, conversation: { prompt: PROMPT, completionRule: { stableObserved: false } } });
  assert.equal(unstable.gates.G3.value, 'failed');
  assert.equal(unstable.verdict, 'capture_rejected');
});

test('a gap record gives capture_rejected via G5', async (t) => {
  // Synthetic gap record as the writer emits it; verify counts it as a declared drop.
  const s = await makeSession(t, { extra: [{ k: 'gap', reason: 'local_queue_overflow', droppedRecords: 1, droppedBytes: 10, droppedSeqFrom: 5, droppedSeqTo: 5, sids: ['s1'], since: 1004 }] });
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.gates.G5.value, 'failed');
  assert.equal(doc.gates.G5.evidence.gapRecords, 1);
  assert.equal(doc.gates.G5.evidence.droppedRecords, 1);
  assert.equal(doc.verdict, 'capture_rejected');
});

test('body.excluded and body.truncated each fail G5', async (t) => {
  const excluded = await makeSession(t, { extra: [{ k: 'body.excluded', sid: 's1', reason: 'security_tail_unfinished_failure' }] });
  const d1 = await evaluateAcceptance({ session: excluded, conversation: CONVERSATION });
  assert.equal(d1.gates.G5.value, 'failed');
  assert.equal(d1.gates.G5.evidence.bodyExcluded, 1);
  const truncated = await makeSession(t, { extra: [{ k: 'body.truncated', sid: 's1', bytes: 100, cap: 100, reason: 'max_stream_bytes' }] });
  const d2 = await evaluateAcceptance({ session: truncated, conversation: CONVERSATION });
  assert.equal(d2.gates.G5.value, 'failed');
  assert.equal(d2.gates.G5.evidence.bodyTruncated, 1);
  assert.equal(d2.verdict, 'capture_rejected');
});

test('G4 requires status exactly complete', async (t) => {
  const s = await makeSession(t, { status: 'complete_with_integrity_warnings' });
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.gates.G4.value, 'failed');
  assert.equal(doc.verdict, 'capture_rejected');
});

test('DOM text that does not match the L2 reply gives G7 failed', async (t) => {
  const s = await makeSession(t, { domText: 'Completely different rendered text about another subject entirely, nothing shared here at all.' });
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.gates.G7.value, 'failed');
  assert.match(doc.gates.G7.reason, /diverges|partially_rendered/);
  assert.equal(doc.verdict, 'capture_rejected');
});

test('no DOM turns gives G7 not-checked (no reconciliation attempted), so the verdict is incomplete', async (t) => {
  const s = await makeSession(t, { dom: false });
  const withCtx = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(withCtx.gates.G7.value, 'not-checked');
  assert.equal(withCtx.gates.G1.value, 'unknown');
  assert.equal(withCtx.gates.G2.value, 'unknown');
  assert.equal(withCtx.verdict, 'capture_incomplete');
  const noCtx = await evaluateAcceptance({ session: s });
  assert.equal(noCtx.gates.G7.value, 'not-checked');
  assert.equal(noCtx.verdict, 'capture_incomplete');
});

test('no derive output gives G6 not-checked and G7 unknown (no assembled reply to reconcile)', async (t) => {
  const s = await makeSession(t, { derive: false });
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.gates.G6.value, 'not-checked');
  assert.equal(doc.gates.G7.value, 'unknown');
  assert.equal(doc.verdict, 'capture_incomplete');
});

test('writeAcceptance then readAcceptance round-trips; raw is byte-identical; write is atomic', async (t) => {
  const s = await makeSession(t);
  const rawBefore = hashTree(s.rawDir);
  const jsonBefore = readFileSync(path.join(s.dir, 'session.json'), 'utf8');
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.deepEqual(hashTree(s.rawDir), rawBefore, 'evaluation must not touch raw');
  const p = writeAcceptance(s, doc);
  assert.equal(p, path.join(s.dir, 'acceptance.json'));
  assert.deepEqual(hashTree(s.rawDir), rawBefore, 'write must not touch raw');
  assert.equal(readFileSync(path.join(s.dir, 'session.json'), 'utf8'), jsonBefore, 'write must not touch session.json');
  assert.equal(readdirSync(s.dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp file left behind');
  const back = readAcceptance(s);
  assert.equal(back.verdict, 'capture_accepted');
  assert.equal(back.binding.rawDigest, doc.binding.rawDigest);
  // refuses to write a self-inconsistent document
  assert.throws(() => writeAcceptance(s, { ...doc, verdict: 'capture_rejected' }), /does not follow/);
  assert.throws(() => writeAcceptance(s, { ...doc, verdict: 'accepted' }), /unknown verdict/);
});

test('tampering with raw after evaluation makes readAcceptance unassessed', async (t) => {
  const s = await makeSession(t);
  writeAcceptance(s, await evaluateAcceptance({ session: s, conversation: CONVERSATION }));
  assert.equal(readAcceptance(s).verdict, 'capture_accepted');
  appendFileSync(path.join(s.dir, 'raw', '000001.jsonl'), '\n');
  const after = readAcceptance(s);
  assert.equal(after.verdict, 'unassessed');
  assert.match(after.reasons.join(' '), /raw digest changed/);
});

test('unknown recipe version returns unassessed, both by reader option and by a stored recipe edit', async (t) => {
  const s = await makeSession(t);
  writeAcceptance(s, await evaluateAcceptance({ session: s, conversation: CONVERSATION }));
  const byOption = readAcceptance(s, { recipe: { id: DEFAULT_RECIPE.id, version: 2 } });
  assert.equal(byOption.verdict, 'unassessed');
  const file = path.join(s.dir, 'acceptance.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.binding.recipe.version = 99;
  writeFileSync(file, JSON.stringify(stored, null, 2));
  const byStore = readAcceptance(s);
  assert.equal(byStore.verdict, 'unassessed');
  assert.match(byStore.reasons.join(' '), /recipe mismatch/);
});

test('a stored verdict edited to accepted over failed gates is not trusted', async (t) => {
  const s = await makeSession(t, { extra: [{ k: 'body.excluded', sid: 's1', reason: 'x' }] });
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.verdict, 'capture_rejected');
  writeFileSync(path.join(s.dir, 'acceptance.json'), JSON.stringify({ ...doc, verdict: 'capture_accepted' }, null, 2));
  const back = readAcceptance(s);
  assert.equal(back.verdict, 'unassessed');
  assert.match(back.reasons.join(' '), /does not follow from stored gates/);
});

test('legacy session with no acceptance.json is unassessed, never rejected, and no file is created', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acceptance-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = Session.create(root, { site: 'legacy' });
  s.raw.append({ k: 'req', sid: 'old', url: 'https://x.test/a', method: 'GET', type: 'fetch', t: 1 });
  await s.raw.close();
  const back = readAcceptance(s);
  assert.equal(back.verdict, 'unassessed');
  assert.match(back.reasons.join(' '), /no acceptance\.json/);
  assert.equal(existsSync(path.join(s.dir, 'acceptance.json')), false);
});
