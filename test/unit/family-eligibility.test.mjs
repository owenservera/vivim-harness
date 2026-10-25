// CORE Issue #68: evidence-to-acceptance-to-versioned-family boundary.
// All input is synthetic, local and deterministic. No Chrome, network, provider,
 // acceptance bypass, or invented user assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { derive } from '../../src/replay/derive.mjs';
import { evaluateAcceptance, writeAcceptance, readAcceptance } from '../../src/capture/acceptance.mjs';
import { buildFamily, collectSessions, writeFamily } from '../../src/families/build.mjs';
import { runCampaign, defaultPrompt } from '../../src/capture/campaign.mjs';

const PROMPT = 'Say hello';
const REPLY = 'Hello there';
const CONVERSATION = {
  prompt: PROMPT, expectedReplyWords: ['hello', 'there'],
  completionRule: { requireDone: true, stableObserved: true },
  // Pre-send freshness cursor: the fixture page has no turns before the send.
  baseline: { userTurns: 0, assistantTurns: 0 },
};
const event = (type, obj) => 'event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n';
const SSE = [
  event('message_start', { type: 'message_start', message: { id: 'msg_synthetic_001' } }),
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } }),
  event('content_block_stop', { type: 'content_block_stop', index: 0 }),
  event('message_stop', { type: 'message_stop' }),
  'data: [DONE]\n\n',
].join('');
const SITE = 'https://chat.example.test';

function area(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'core-family-eligibility-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = dataPaths(dir);
  ensureDataDirs(paths);
  return { paths, profile: new ProfileStore(paths.profiles).load('generic') };
}
async function fixture(paths, {
  url = SITE + '/conversation', api = SITE + '/api/chat',
  rawGap = false, status = 'complete', withShapes = true,
  thirdParty = 'https://telemetry.other.test/batch',
  knowledgeStatus = 'complete', withDerivation = true,
} = {}) {
  const s = Session.create(paths.sessions, { site: 'example.test',
    meta: { target: { url } } });
  const sid = 'synthetic-stream';
  s.raw.append({ k: 'req', sid, url: api, method: 'POST', type: 'Fetch', t: 1000 });
  s.raw.append({ k: 'res', sid, status: 200, mime: 'text/event-stream', t: 1001 });
  s.raw.append({ k: 'chunk', sid, b64: Buffer.from(SSE).toString('base64'), t: 1002 });
  s.raw.append({ k: 'done', sid, encodedDataLength: SSE.length, t: 1003 });
  if (rawGap) s.raw.append({ k: 'body.truncated', sid, reason: 'synthetic', bytes: 2 });
  await s.raw.close();
  s.meta.status = status; s.saveMeta();
  s.kv.set('DOM_TURNS', [{ id: 'u', role: 'user', text: PROMPT },
    { id: 'a', role: 'assistant', text: REPLY }]);
  // Acceptance reads the actual derived stream text; SHAPES alone is not reply evidence.
  if (withDerivation) await derive(s, new ProfileStore(paths.profiles).load('generic'));
  s.kv.set('KNOWLEDGE_STATUS', { ...s.kv.get('KNOWLEDGE_STATUS'), status: knowledgeStatus });
  if (withShapes) s.kv.set('SHAPES', {
    endpoints: [
      { endpoint: 'POST ' + api, transports: { HTTP_SSE: 1 }, resourceTypes: ['Fetch'] },
      { endpoint: 'POST ' + thirdParty, transports: { HTTP_SSE: 1 }, resourceTypes: ['Fetch'] },
    ],
    groups: [
      { endpoint: 'POST ' + api, count: 4, fields: { '$.delta.text': { count: 4 } }, collections: [] },
      { endpoint: 'POST ' + thirdParty, count: 17, fields: { '$.telemetry': { count: 17 } }, collections: [] },
    ],
  });
  return s;
}
async function accepted(s) {
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.verdict, 'capture_accepted', JSON.stringify(doc.reasons));
  writeAcceptance(s, doc);
  assert.equal(readAcceptance(s).verdict, 'capture_accepted');
}

test('missing assembled evidence remains incomplete even with matching saved DOM', async (t) => {
  const { paths } = area(t);
  const s = await fixture(paths);
  s.kv.set('ASSEMBLED', {});
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.verdict, 'capture_incomplete');
  assert.equal(doc.gates.G3.value, 'unknown');
  assert.equal(doc.gates.G7.value, 'unknown');
});

test('scheme-less shapes need one observed exact origin, never a guessed page scheme', async (t) => {
  const { paths } = area(t);
  const s = await fixture(paths);
  await accepted(s);
  const endpoint = 'POST chat.example.test/api/chat';
  const shapes = { endpoints: [{ endpoint, transports: { HTTP_SSE: 1 } }], groups: [
    { endpoint, origins: [SITE], count: 1, fields: { '$.allowed': { count: 1 } } },
    { endpoint, count: 1, fields: { '$.unknown': { count: 1 } } },
    { endpoint, origins: [SITE, 'http://chat.example.test'], count: 1, fields: { '$.mixed': { count: 1 } } },
    { endpoint, origins: ['http://chat.example.test'], count: 1, fields: { '$.wrongScheme': { count: 1 } } },
    { endpoint, origins: ['https://other.example.test'], count: 1, fields: { '$.wrongHost': { count: 1 } } },
  ] };
  s.kv.set('SHAPES', shapes);
  const built = buildFamily({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(built.shapes.length, 1);
  assert.deepEqual(built.shapes[0].fields.map((f) => f.path), ['$.allowed']);
  assert.equal(built.coverage.outOfOriginGroups, 4);
});

test('real offline G1–G7 evaluation makes one synthetic session eligible for a versioned family', async (t) => {
  const { paths } = area(t);
  const s = await fixture(paths);
  await accepted(s);
  const collected = collectSessions({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(collected.length, 1);
  assert.equal(collected[0].acceptance, 'capture_accepted');
  assert.equal(collected[0].eligible, true);
  const b = buildFamily({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.deepEqual(b.family.members, [s.id]);
  assert.equal(b.family.origin, SITE);
  assert.equal(b.coverage.eligible, 1);
  assert.equal(b.coverage.outOfOriginGroups, 1, 'foreign-origin telemetry shape is excluded');
  assert.equal(b.shapes.length, 1);
  assert.match(b.family.sources[0].rawDigest, /^[0-9a-f]{64}$/);
  assert.match(b.family.sources[0].shapesDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(b.family.sources[0].seqRange, [1, 4]);
  assert.equal(b.family.sources[0].verdict, 'capture_accepted');
  assert.ok(b.shapes[0].fields.some((f) => f.path === '$.delta.text'));
  assert.equal(b.shapes[0].fields.some((f) => f.path === '$.telemetry'), false);
  const saved = writeFamily({ familiesDir: paths.families, built: b });
  assert.ok(saved.record.version >= 1);
  assert.deepEqual(saved.record.members, [s.id]);
  assert.equal(saved.record.coverage.eligible, 1);
  assert.equal(existsSync(path.join(paths.families, b.family.id, 'CURRENT')), true);
});

test('SHAPES-only and unassessed sessions stay visible, but cannot be published', async (t) => {
  const { paths } = area(t);
  const s = await fixture(paths, { withDerivation: false });
  const listed = collectSessions({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(listed[0].hasDerived, true);
  assert.equal(listed[0].acceptance, 'unassessed');
  assert.equal(listed[0].eligible, false);
  const b = buildFamily({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(b.coverage.withDerived, 1);
  assert.equal(b.coverage.eligible, 0);
  assert.deepEqual(b.family.members, []);
  assert.deepEqual(b.shapes, []);
  assert.throws(() => writeFamily({ familiesDir: paths.families, built: b }),
    (err) => err.code === 'FAMILY_NOT_ELIGIBLE');
  assert.equal(existsSync(path.join(paths.families, b.family.id, 'CURRENT')), false);
  assert.ok(b.coverage.inspected.some((x) => x.id === s.id && x.status === 'withheld'));
});

test('a rejected G5 truncation cannot enter a family regardless of derived shapes', async (t) => {
  const { paths } = area(t);
  const s = await fixture(paths, { rawGap: true });
  const doc = await evaluateAcceptance({ session: s, conversation: CONVERSATION });
  assert.equal(doc.verdict, 'capture_rejected');
  writeAcceptance(s, doc);
  const b = buildFamily({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(b.coverage.eligible, 0);
  assert.equal(b.coverage.inspected[0].verdict, 'capture_rejected');
  assert.throws(() => writeFamily({ familiesDir: paths.families, built: b }),
    /publication withheld/);
});

test('raw mutation invalidates previously accepted evidence without rewriting it', async (t) => {
  const { paths } = area(t);
  const s = await fixture(paths);
  await accepted(s);
  appendFileSync(path.join(s.dir, 'raw', '000001.jsonl'), '\n');
  assert.equal(readAcceptance(s).verdict, 'unassessed');
  const b = buildFamily({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(b.coverage.eligible, 0);
  assert.deepEqual(b.family.members, []);
});

test('different exact page origins do not merge through a common host or site', async (t) => {
  const { paths } = area(t);
  const a = await fixture(paths, { url: SITE + '/c/1' });
  const otherOrigin = 'https://chat.example.test:8443';
  const b = await fixture(paths, { url: otherOrigin + '/c/2', api: otherOrigin + '/api/chat' });
  await accepted(a);
  await accepted(b);
  const built = buildFamily({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(built.coverage.acceptedAcrossOrigins, 2);
  assert.equal(built.coverage.eligible, 1);
  assert.equal(built.coverage.withheld, 1);
  assert.equal(built.family.members.length, 1);
  assert.equal(built.family.origin, SITE);
  assert.equal(built.coverage.inspected.filter((x) => x.reason === 'different-exact-origin').length, 1);
});

test('a missing origin or failed knowledge status cannot be promoted', async (t) => {
  const { paths } = area(t);
  const a = await fixture(paths, { url: 'about:blank' });
  await accepted(a);
  const b = await fixture(paths);
  await accepted(b);
  // Acceptance does not become a timeless authorization to publish. A later
  // failed knowledge transaction must withhold the session even if raw is sound.
  b.kv.set('KNOWLEDGE_STATUS', { status: 'failed', entityCount: 0 });
  const built = buildFamily({ sessionsDir: paths.sessions, site: 'example.test' });
  assert.equal(built.coverage.eligible, 0);
  assert.equal(built.family.members.length, 0);
  assert.ok(built.coverage.inspected.some((x) => x.reason === 'no-exact-page-origin'));
  assert.ok(built.coverage.inspected.some((x) => x.reason === 'knowledge-not-complete'));
});

// The actual SHAPES producer is exercised through derive, not just handcrafted
// consumer inputs; no fabricated acceptance context is attributed to derive.
test('offline derive defaults to incomplete, then explicit synthetic context can promote G1–G7', async (t) => {
  const { paths, profile } = area(t);
  const s = await fixture(paths, { withShapes: false });
  await derive(s, profile);
  assert.equal(readAcceptance(s).verdict, 'capture_incomplete');
  const shapes = s.kv.get('SHAPES');
  assert.ok(Array.isArray(shapes?.groups));
  assert.ok(shapes.groups.length > 0, 'real derivation produced shape groups from synthetic SSE');
  await accepted(s);
  const built = buildFamily({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(built.coverage.eligible, 1);
  assert.ok(built.shapes.length > 0, 'real derived source-side shapes contribute');
  const written = writeFamily({ familiesDir: paths.families, built });
  assert.deepEqual(written.record.members, [s.id]);
});


test('Campaign leaves a wrongly calibrated synthetic reply derived but unpublished', async (t) => {
  const { paths } = area(t);
  const s = await fixture(paths);
  const result = await runCampaign({
    sites: ['chatgpt'], execute: true, dataDir: paths.root,
    prompt: defaultPrompt, cooldownMs: 0, resume: false,
    // Mocked drive result: absolutely no browser/CDP call or external send.
    drive: async () => ({ ok: true, blocked: false, sessionId: s.id,
      reply: 'This is not the expected calibration answer', done: true,
      target: { url: SITE + '/conversation' }, errors: [] }),
  });
  assert.equal(result.sites[0].status, 'unverified');
  assert.equal(result.sites[0].derived, true, 'raw can still be derived offline');
  assert.equal(result.sites[0].family, null);
  assert.notEqual(readAcceptance(Session.open(paths.sessions, s.id)).verdict, 'capture_accepted');
  assert.equal(existsSync(path.join(paths.families, 'chat.example.test', 'CURRENT')), false);
});


test('re-derive preserves accepted context only while raw+DOM bindings and current offline gates remain sound', async (t) => {
  const { paths, profile } = area(t);
  const s = await fixture(paths, { withShapes: false });
  await derive(s, profile);
  assert.equal(readAcceptance(s).verdict, 'capture_incomplete');
  await accepted(s);
  const original = readAcceptance(s);
  await derive(s, profile);
  const retained = readAcceptance(s);
  assert.equal(retained.verdict, 'capture_accepted');
  assert.equal(retained.contextualEvidence.kind, 'revalidated-prior-acceptance');
  assert.equal(retained.binding.rawDigest, original.binding.rawDigest);
  assert.equal(retained.binding.domDigest, original.binding.domDigest);
  assert.ok(['G1', 'G2', 'G3'].every((id) => retained.gates[id].value === 'passed'));
  const mutated = s.kv.get('DOM_TURNS');
  mutated[1].text = 'An unrelated synthetic paragraph which changes the source projection';
  s.kv.set('DOM_TURNS', mutated);
  assert.equal(readAcceptance(s).verdict, 'unassessed', 'DOM edits invalidate the contextual binding');
  await derive(s, profile);
  assert.notEqual(readAcceptance(s).verdict, 'capture_accepted',
    'fresh derive cannot carry the old context across changed DOM');
});

test('raw-equal but DOM-changed acceptance may never publish a family', async (t) => {
  const { paths } = area(t);
  const s = await fixture(paths);
  await accepted(s);
  const dom = s.kv.get('DOM_TURNS');
  dom[1].text = 'Tampered rendered projection';
  s.kv.set('DOM_TURNS', dom);
  const verdict = readAcceptance(s);
  assert.equal(verdict.verdict, 'unassessed');
  assert.match(verdict.reasons.join(' '), /DOM_TURNS changed/);
  const b = buildFamily({ sessionsDir: paths.sessions, host: 'chat.example.test' });
  assert.equal(b.coverage.eligible, 0);
  assert.equal(b.family.members.length, 0);
});
