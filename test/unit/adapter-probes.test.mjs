// Probe production tests: saved-capture probes, live measurement mapping, route generalization,
// scope enforcement, and the read-only transcript projections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeWebappAdapter } from '../../src/studio/adaptive-adapter-factory.mjs';
import {
  routeCandidateFromUrl, probesFromSession, scopeProbes,
  probesFromLiveMeasurement, probesFromLivePage, liveMeasurementExpression,
  transcriptFromSession, liveTranscriptExpression,
} from '../../src/studio/adapter-probes.mjs';

const ORIGIN = 'https://127.0.0.1:8443';

function fakeSession(id, { url, turns = [], assembled = {} } = {}) {
  const kv = new Map(Object.entries({ DOM_TURNS: turns, ASSEMBLED: assembled, RECEIPT: { pageUrl: url } }));
  return { id, kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }, meta: { target: { url } } };
}
const turn = (role, attr = 'data-role', i = 0) => ({ index: i, id: `t${i}`, domId: `div.chat-bubble[${attr}=${role}]`, role, roleAttribute: attr, text: `hello ${role} ${i}`, truncated: undefined, blocks: [] });

test('saved session probes: stable attribute selectors for user and assistant turns', () => {
  const s = fakeSession('s1', { url: `${ORIGIN}/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b`, turns: [turn('user'), turn('assistant')] });
  const probes = probesFromSession(s);
  const features = Object.fromEntries(probes.map((p) => [`${p.feature}:${p.candidate}`, p]));
  assert.equal(features['user-turn:[data-role="user"]'].outcome, 'present');
  assert.equal(features['user-turn:[data-role="user"]'].carrier, 'dom');
  assert.equal(features['user-turn:[data-role="user"]'].evidenceClass, 'SAVED_REAL_CAPTURE');
  assert.equal(features['assistant-turn:[data-role="assistant"]'].feature, 'assistant-turn');
  // every probe carries the session reference
  for (const p of probes) assert.equal(p.captureId, 's1');
});

test('one capture = one vote per candidate, no matter how many turns', () => {
  const s = fakeSession('s1', { url: `${ORIGIN}/chat`, turns: [turn('user', 'data-role', 0), turn('user', 'data-role', 1), turn('user', 'data-role', 2)] });
  const probes = probesFromSession(s);
  const r = synthesizeWebappAdapter({ siteId: 'x', origin: ORIGIN, surface: 'chat', observations: scopeProbes(probes, { siteId: 'x', origin: ORIGIN, sessionOrigins: new Map([['s1', ORIGIN]]) }) });
  const slot = r.features['user-turn'].proposals.find((p) => p.candidate === '[data-role="user"]');
  assert.equal(slot.provenance.positive, 1);
  assert.equal(slot.status, 'provisional'); // a single capture never reaches shadow-ready
});

test('roles outside the factory vocabulary are skipped, not coerced', () => {
  const s = fakeSession('s1', { url: `${ORIGIN}/chat`, turns: [turn('human'), turn('bot')] });
  const probes = probesFromSession(s);
  assert.equal(probes.filter((p) => p.feature === 'user-turn' || p.feature === 'assistant-turn').length, 0);
});

test('thread route only when the URL carries identity; never fabricated', () => {
  const withUuid = probesFromSession(fakeSession('s1', { url: `${ORIGIN}/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b` }));
  assert.ok(withUuid.some((p) => p.feature === 'thread-route' && p.candidate === `${ORIGIN}/chat?chatID=:uuid`));
  const bare = probesFromSession(fakeSession('s2', { url: `${ORIGIN}/chat` }));
  assert.equal(bare.some((p) => p.feature === 'thread-route'), false);
  const pathUuid = probesFromSession(fakeSession('s3', { url: 'https://chat.example.test/c/1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d' }));
  assert.ok(pathUuid.some((p) => p.candidate === 'https://chat.example.test/c/:uuid'));
});

test('routeCandidateFromUrl edge cases', () => {
  assert.equal(routeCandidateFromUrl('https://a.test/t/123456'), 'https://a.test/t/:id');
  assert.equal(routeCandidateFromUrl('https://a.test/plain/page?q=hello'), null); // no identity evidence
  assert.equal(routeCandidateFromUrl('not a url'), null);
  assert.equal(routeCandidateFromUrl('https://a.test/x?id=abcdef0123456789abcdef0123456789'), 'https://a.test/x?id=:id');
});

test('ASSEMBLED endpoints become stream-map probes on the network carrier', () => {
  const s = fakeSession('s1', { url: `${ORIGIN}/chat`, assembled: { a: { endpoint: 'POST /api/chat' }, b: { endpoint: 'POST /api/chat' } } });
  const probes = probesFromSession(s);
  const streams = probes.filter((p) => p.feature === 'stream-component');
  assert.equal(streams.length, 1); // deduped by endpoint
  assert.equal(streams[0].candidate, '/api/chat');
  assert.equal(streams[0].carrier, 'network');
});

test('cross-origin teaching fails closed', () => {
  const s = fakeSession('s1', { url: 'https://evil.test/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b' });
  const probes = probesFromSession(s);
  assert.throws(() => scopeProbes(probes, { siteId: 'x', origin: ORIGIN, sessionOrigins: new Map([['s1', 'https://evil.test']]) }), /PROBE_ORIGIN_MISMATCH/);
});

test('live measurement: complete document proves presence AND absence', () => {
  const m = {
    readyState: 'complete', url: `${ORIGIN}/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b`,
    battery: { composer: [0, 2, 0, 0], 'send-control': [1, 0, 0], 'stop-control': [0, 0], 'assistant-turn': [0, 1, 0, 0], 'user-turn': [0, 3] },
    prior: { 'user-turn': [0] }, priorCandidates: { 'user-turn': ['[data-role="user"]'] },
    roles: [{ attr: 'data-role', role: 'user', count: 3 }, { attr: 'data-role', role: 'assistant', count: 1 }],
  };
  const probes = probesFromLiveMeasurement({ measurement: m, origin: ORIGIN });
  const find = (f, c) => probes.find((p) => p.feature === f && p.candidate === c);
  assert.equal(find('composer', 'textarea').outcome, 'absent'); // honest absence, complete probe
  assert.equal(find('composer', '[contenteditable="true"]').outcome, 'present');
  // The roles scan found [data-role="user"] present; the raw prior measurement of the SAME
  // selector (count 0) is a self-contradiction and is suppressed — exactly one vote survives.
  const userProbes = probes.filter((p) => p.feature === 'user-turn' && p.candidate === '[data-role="user"]');
  assert.equal(userProbes.length, 1);
  assert.equal(userProbes[0].outcome, 'present');
  assert.equal(userProbes[0].evidenceClass, 'SANDBOX_REAL_BROWSER');
  assert.equal(find('thread-route', `${ORIGIN}/chat?chatID=:uuid`).outcome, 'present');
});

test('live measurement on an unloaded document reports unknown, not absence', () => {
  const m = { readyState: 'loading', url: `${ORIGIN}/chat`, battery: { composer: [0] }, prior: {}, roles: null };
  const probes = probesFromLiveMeasurement({ measurement: m, origin: ORIGIN });
  assert.equal(probes.find((p) => p.feature === 'composer').outcome, 'unknown');
  assert.equal(probes.find((p) => p.feature === 'composer').coverage, 'partial');
});

test('prior candidate absence is measurable when the role scan sees nothing', () => {
  const m = {
    readyState: 'complete', url: `${ORIGIN}/chat`,
    battery: { composer: [1, 0, 0, 0], 'send-control': [0, 0, 0], 'stop-control': [0, 0], 'assistant-turn': [0, 0, 0, 0], 'user-turn': [0, 0] },
    prior: { 'user-turn': [0], 'assistant-turn': [0] }, priorCandidates: { 'user-turn': ['[data-role="user"]'], 'assistant-turn': ['[data-role="assistant"]'] },
    roles: [], // scan sees nothing under the new UI
  };
  const probes = probesFromLiveMeasurement({ measurement: m, origin: ORIGIN });
  assert.ok(probes.some((p) => p.candidate === '[data-role="user"]' && p.outcome === 'absent'));
  assert.ok(probes.some((p) => p.candidate === '[data-role="assistant"]' && p.outcome === 'absent'));
});

test('probesFromLivePage wraps the DomObserver read-only evaluate; no second actor', async () => {
  let expression = null;
  const dom = { _evalInMain: async (expr) => { expression = expr; return { value: { readyState: 'complete', url: `${ORIGIN}/chat`, battery: { composer: [1, 0, 0, 0] }, prior: {}, roles: [{ attr: 'data-role', role: 'user', count: 1 }] } }; } };
  const probes = await probesFromLivePage({ dom, origin: ORIGIN, captureId: 'live-1', priorSelectors: {} });
  assert.match(expression, /querySelectorAll/);
  assert.doesNotMatch(expression, /\bdispatchEvent\b|\bInput\.\w|\.click\(|\.submit\(|innerHTML\s*=/);
  assert.ok(probes.some((p) => p.candidate === '[data-role="user"]' && p.outcome === 'present'));
});

test('live measurement expression is bounded and read-only', () => {
  const expr = liveMeasurementExpression({ priorSelectors: { 'user-turn': ['[data-role="user"]'] } });
  assert.doesNotMatch(expr, /fetch\(|XMLHttpRequest|localStorage\.set|dispatchEvent|\.click\(|\.submit\(/);
  assert.match(expr, /slice\(0, 40\)/); // bounded role entries
});

test('saved transcript: attribute+value must both match; identity never fabricated', () => {
  const s = fakeSession('s1', { url: `${ORIGIN}/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b`, turns: [turn('user', 'data-role', 0), turn('assistant', 'data-role', 1)] });
  const cand = synthesizeWebappAdapter({
    siteId: 'x', origin: ORIGIN, surface: 'chat',
    observations: scopeProbes(probesFromSession(s), { siteId: 'x', origin: ORIGIN, sessionOrigins: new Map([['s1', ORIGIN]]) }),
  });
  // force selection for the transcript test (synthesis alone leaves provisional entries unselected)
  cand.features['user-turn'].selected = { type: 'selector', candidate: '[data-role="user"]', status: 'shadow-ready', provenance: cand.features['user-turn'].proposals[0].provenance, confidence: 0.9, agreement: 1 };
  cand.features['assistant-turn'].selected = { type: 'selector', candidate: '[data-msg-author="assistant"]', status: 'shadow-ready', provenance: { sessions: 3, positive: 3, contradicted: 0, unknown: 0, realPositive: 3, refs: [], refsTruncated: false }, confidence: 0.9, agreement: 1 };
  const t = transcriptFromSession(s, cand);
  assert.equal(t.items.length, 1); // assistant candidate names a different attribute: no match, no fabrication
  assert.equal(t.items[0].role, 'user');
  assert.equal(t.items[0].evidence.session, 's1');
  assert.equal(t.thread.binding, 'unverified'); // fixture origin has no supported parser
  assert.equal(t.thread.nativeRef, null);
});

test('live transcript expression applies exactly the learned selectors', () => {
  const expr = liveTranscriptExpression({ userSelector: '[data-role="user"]', assistantSelector: '[data-role="assistant"]', cap: 200, textCap: 240 });
  assert.match(expr, /grab\("\[data-role=\\"user\\"\]", 'user'\)/);
  assert.doesNotMatch(expr, /dispatch|\.click\(|fetch\(|XMLHttpRequest/);
});

test('a role attribute matched by suffix yields a suffix selector, never an exact one that matches nothing (found live on ChatGPT)', () => {
  const kv = new Map([['DOM_TURNS', [
    { role: 'user', roleAttribute: 'data-content-search-unit-key', roleMatch: 'suffix', text: 'q' },
    { role: 'assistant', roleAttribute: 'data-content-search-unit-key', roleMatch: 'suffix', text: 'a' },
    { role: 'assistant', roleAttribute: 'data-message-author-role', roleMatch: 'exact', text: 'b' },
  ]]]);
  const probes = probesFromSession({ id: 's1', kv: { get: (k, d) => kv.get(k) ?? d } });
  const sel = probes.filter((p) => p.type === 'selector').map((p) => p.candidate);
  assert.ok(sel.includes('[data-content-search-unit-key$="assistant"]'));
  assert.ok(sel.includes('[data-content-search-unit-key$="user"]'));
  assert.ok(sel.includes('[data-message-author-role="assistant"]'));
  assert.ok(!sel.includes('[data-content-search-unit-key="assistant"]'));
});
