// Adversarial evidence boundary tests: provider-independent discovery, no new browser actor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativePartsFromSession, compareNativePartEvidence, probesFromSession,
  probesFromLiveMeasurement, scopeProbes, liveMeasurementExpression,
} from '../../src/studio/adapter-probes.mjs';
import { induceStreamMap } from '../../src/profiles/stream-map-induce.mjs';

const ORIGIN = 'https://chat.example.test';
function session(id, { url = ORIGIN + '/chat', turns = [], streams = [] } = {}) {
  const kv = new Map([
    ['DOM_TURNS', turns], ['ASSEMBLED', {}], ['RECEIPT', { pageUrl: url }],
    ['STREAM_COMPONENTS', { schema: 'capture-studio.stream-components/1', streams }],
  ]);
  return { id, meta: { target: { url } }, kv: { get: (k) => kv.get(k) } };
}
const a = (type, extras = {}) => ({ type, ...extras });
const domTurn = (role, blocks) => ({ role, roleAttribute: 'data-role', roleMatch: 'exact',
  text: 'Private text must not become an adapter selector', blocks });

test('saved DOM blocks report rich parts, nested structure and citations without leaking content', () => {
  const s = session('session-one', { turns: [
    domTurn('user', [a('paragraph', { text: 'PRIVATE-PROMPT' })]),
    domTurn('assistant', [
      a('table', { headers: ['PRIVATE-HEADER'], rows: [['PRIVATE-CELL']] }),
      a('list', { items: [{ blocks: [a('code', { text: 'PRIVATE-CODE' })] }] }),
      a('paragraph', { inline: [{ t: 'citation', href: 'https://private.test', text: 'secret' }] }),
    ]),
  ] });
  const doc = nativePartsFromSession(s);
  assert.equal(doc.completeness, 'presence-only');
  assert.ok(doc.parts.some((p) => p.role === 'assistant' && p.nativeType === 'table' &&
    p.sourceRef === 'KV:DOM_TURNS[1].blocks[0]'));
  assert.ok(doc.parts.some((p) => p.nativeType === 'code' &&
    p.sourceRef === 'KV:DOM_TURNS[1].blocks[1].items[0].blocks[0]'));
  assert.ok(doc.parts.some((p) => p.nativeType === 'citation' &&
    p.sourceRef === 'KV:DOM_TURNS[1].blocks[2].inline[0]'));
  assert.ok(doc.parts.some((p) => p.role === 'user' && p.nativeType === 'paragraph'));
  assert.doesNotMatch(JSON.stringify(doc), /PRIVATE-|private\.test|secret/);
});

test('unmapped stream is not promoted; mapped but omitted or partial stream stays incomplete', () => {
  const s = session('session-two', { streams: [
    { sid: 'a', mapId: null, components: [{ component: 'code' }] },
    { sid: 'b', mapId: 'existing-map', eventsOmitted: 2, components: [{ component: 'table', opened: true, closed: true }] },
    { sid: 'c', mapId: 'existing-map', eventsOmitted: 0, unmappedCount: 0,
      components: [{ component: 'paragraph', opened: true, closed: false }] },
  ] });
  const parts = nativePartsFromSession(s).parts.filter((p) => p.carrier === 'network');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].nativeType, 'table');
  assert.equal(parts[0].state, 'incomplete');
  assert.equal(parts[0].role, 'unverified'); // no DOM/network join asserted
  assert.equal(parts[1].state, 'streaming');
  assert.equal(parts[1].sourceRef, 'KV:STREAM_COMPONENTS.streams[2].components[0]');
});

test('saved structural additions are source-bound; missing past parts are not absence/drift votes', () => {
  const before = nativePartsFromSession(session('before', { turns: [
    domTurn('assistant', [a('table')]),
  ] }));
  const after = nativePartsFromSession(session('after', { turns: [
    domTurn('assistant', [a('code')]),
  ] }));
  const d = compareNativePartEvidence(before, after);
  assert.equal(d.outcome, 'new-structure-observed');
  assert.deepEqual(d.added.map((p) => p.nativeType), ['code']);
  assert.deepEqual(d.notObserved.map((p) => p.nativeType), ['table']);
  assert.equal(d.coverage, 'presence-only');
  assert.equal(d.adapterPromotionAuthorized, false);
  assert.throws(() => compareNativePartEvidence(before, before), /NOT_INDEPENDENT/);
});

test('spoofed/stale role scan cannot prove presence without independent selector count', () => {
  const m = { readyState: 'complete', url: ORIGIN + '/chat',
    battery: {}, roles: [{ attr: 'data-role', role: 'assistant', count: 0 }],
    prior: { 'assistant-turn': [0] }, priorCandidates: { 'assistant-turn': ['[data-role="assistant"]'] } };
  const p = probesFromLiveMeasurement({ measurement: m, origin: ORIGIN, captureId: 'live-a' });
  assert.equal(p.filter((x) => x.feature === 'assistant-turn').length, 1);
  assert.equal(p.find((x) => x.feature === 'assistant-turn').outcome, 'absent');
  m.roles[0].count = 3;
  assert.equal(probesFromLiveMeasurement({ measurement: m, origin: ORIGIN, captureId: 'live-b' })
    .find((x) => x.feature === 'assistant-turn').outcome, 'present');
  m.roles[0].count = undefined;
  assert.equal(probesFromLiveMeasurement({ measurement: m, origin: ORIGIN, captureId: 'live-c' })
    .some((x) => x.outcome === 'present'), false);
});

test('in-flight navigation cannot prove absence and wrong-origin measurements fail closed', () => {
  const m = { readyState: 'complete', startUrl: ORIGIN + '/chat/1', url: ORIGIN + '/chat/2',
    battery: { composer: [0] }, prior: {}, roles: [] };
  const p = probesFromLiveMeasurement({ measurement: m, origin: ORIGIN, captureId: 'changed' });
  assert.equal(p[0].coverage, 'partial');
  assert.equal(p[0].outcome, 'unknown');
  assert.throws(() => probesFromLiveMeasurement({
    measurement: { ...m, url: 'https://attacker.example/path' },
    origin: ORIGIN, captureId: 'wrong',
  }), /LIVE_ORIGIN_MISMATCH/);
  const expr = liveMeasurementExpression();
  assert.match(expr, /count: sel \? q\(sel\) : -1/);
  assert.doesNotMatch(expr, /fetch\(|XMLHttpRequest|\.click\(|\.submit\(/);
});

test('route template cannot be scoped to a different origin using a forged session-origin map', () => {
  const s = session('spoof', { url: 'https://other.example/c/4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b' });
  const p = probesFromSession(s);
  assert.throws(() => scopeProbes(p, { siteId: 'generic', origin: ORIGIN,
    sessionOrigins: new Map([['spoof', ORIGIN]]) }), /PROBE_ROUTE_ORIGIN_MISMATCH/);
});

function events(sid, pieces) {
  return pieces.map((delta, seq) => ({ sid, seq, json: { type: 'response.output_text.delta', delta } }));
}
test('induction keeps multi-stream cumulative snapshots unexplained, never as append', () => {
  const source = [...events('sid-a', ['a growing response', 'a growing response with more text']),
    ...events('sid-b', ['another response', 'another response with more text'])];
  const m = induceStreamMap(source);
  assert.equal(m.stream.ops.some((op) => op.op === 'append'), false);
  assert.ok(m.unexplained.some((u) => u.reason === 'cumulative_snapshot_text'));
});

test('induction still finds true fragments repeated independently across streams', () => {
  const source = [...events('sid-a', ['first ', 'second ', 'third ']),
    ...events('sid-b', ['fourth ', 'fifth ', 'sixth '])];
  const m = induceStreamMap(source);
  assert.ok(m.stream.ops.some((op) => op.op === 'append' && op.textPath === 'delta'));
});

test('changing metadata names never masquerade as streamed response text', () => {
  const source = ['metadata alpha long', 'metadata beta long', 'metadata gamma long'].map((name, seq) =>
    ({ sid: 'one', seq, json: { type: 'metadata', name } }));
  const m = induceStreamMap(source);
  assert.equal(m.stream.ops.some((op) => op.op === 'append'), false);
});
