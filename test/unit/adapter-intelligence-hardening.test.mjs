// Learned-adapter intelligence hardening: drift fail-closed retirement, content digests and
// version lineage, stale-basis promotion guard, suffix-role fidelity across saved/live/transcript,
// provider-native thread binding, and private-slug generalization in learned route templates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VersionedStore } from '../../src/store/versioned.mjs';
import { synthesizeWebappAdapter, candidateDigest } from '../../src/studio/adaptive-adapter-factory.mjs';
import { createAdapterFactory } from '../../src/studio/adapter-factory-service.mjs';
import {
  probesFromSession, probesFromLiveMeasurement, liveMeasurementExpression, transcriptFromSession,
  routeCandidateFromUrl, selectorForRole, threadProviderForOrigin,
} from '../../src/studio/adapter-probes.mjs';

const ctx = { siteId: 'example', origin: 'https://example.test', surface: 'chat' };
const probe = ({ feature = 'assistant-turn', candidate = '[data-role="assistant"]', captureId = 's1', sequence = 1, outcome = 'present', evidenceClass = 'SAVED_REAL_CAPTURE' } = {}) => ({
  ...ctx, feature, type: feature === 'thread-route' ? 'route' : feature === 'stream-component' ? 'stream-map' : 'selector',
  candidate, captureId, sequence, outcome, coverage: 'complete', evidenceClass,
  carrier: feature === 'stream-component' ? 'network' : 'dom',
});

test('drift: a prior rule contradicted by fresh evidence is retired, never inherited as shadow-ready', () => {
  const prior = synthesizeWebappAdapter({ ...ctx, observations: ['s1', 's2', 's3'].map((captureId) => probe({ captureId })) });
  assert.equal(prior.features['assistant-turn'].selected.status, 'shadow-ready');
  // The site UI changed: complete live probes now measure the old selector absent, no replacement yet.
  const next = synthesizeWebappAdapter({ ...ctx, prior, observations: ['l1', 'l2'].map((captureId) => probe({ captureId, outcome: 'absent', evidenceClass: 'SANDBOX_REAL_BROWSER' })) });
  const slot = next.features['assistant-turn'];
  assert.equal(slot.selected, null, 'contradicted prior must not stay selected');
  assert.equal(slot.inherited, false);
  assert.deepEqual(slot.retired, { candidate: '[data-role="assistant"]', reason: 'CONTRADICTED_BY_FRESH_EVIDENCE' });
  assert.equal(next.coverage['assistant-turn'], 'unverified');
  assert.ok(next.drift.some((d) => d.reason === 'PREVIOUS_CANDIDATE_NEGATIVE_OBSERVATION'));
  assert.ok(next.drift.some((d) => d.reason === 'PREVIOUS_CANDIDATE_RETIRED_NO_REPLACEMENT'));
  // An uncontradicted prior with no fresh evidence is still inherited (unchanged behavior).
  const quiet = synthesizeWebappAdapter({ ...ctx, prior, observations: [] });
  assert.equal(quiet.features['assistant-turn'].inherited, true);
  assert.equal(quiet.features['assistant-turn'].selected.candidate, '[data-role="assistant"]');
});

test('versioning: deterministic content digest survives a JSON round-trip and links lineage to the exact prior', () => {
  const obs = ['s1', 's2', 's3'].map((captureId) => probe({ captureId }));
  const a = synthesizeWebappAdapter({ ...ctx, observations: obs });
  const b = synthesizeWebappAdapter({ ...ctx, observations: [...obs].reverse() });
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.equal(a.digest, b.digest);
  const roundTripped = JSON.parse(JSON.stringify(a));
  assert.equal(candidateDigest(roundTripped), a.digest);
  // key order from a client must not matter
  const reordered = Object.fromEntries(Object.entries(roundTripped).reverse());
  assert.equal(candidateDigest(reordered), a.digest);
  assert.equal(a.lineage.priorDigest, null);
  const child = synthesizeWebappAdapter({ ...ctx, prior: a, observations: obs });
  assert.equal(child.lineage.priorDigest, a.digest);
  // a tampered prior is linked by its recomputed content digest, not its claimed digest field
  const tampered = { ...roundTripped, coverage: { ...roundTripped.coverage, composer: 'shadow-ready' } };
  const child2 = synthesizeWebappAdapter({ ...ctx, prior: tampered, observations: obs });
  assert.notEqual(child2.lineage.priorDigest, a.digest);
  assert.notEqual(candidateDigest({ ...roundTripped, siteId: 'other' }), a.digest);
});

const ORIGIN = 'https://127.0.0.1:8443';
function fakeSession(id, { roleAttr = 'data-role' } = {}) {
  const url = `${ORIGIN}/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b`;
  const turns = [
    { index: 0, domId: `div[${roleAttr}=user]`, role: 'user', roleAttribute: roleAttr, text: 'p' },
    { index: 1, domId: `div[${roleAttr}=assistant]`, role: 'assistant', roleAttribute: roleAttr, text: 'r' },
  ];
  const kv = new Map(Object.entries({ DOM_TURNS: turns, ASSEMBLED: { a: { endpoint: 'POST /api/chat' } }, RECEIPT: { pageUrl: url } }));
  return { id, kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }, meta: { target: { url } } };
}

test('promotion: a candidate learned on version N cannot replace a newer version (STALE_BASIS); records carry digest + lineage', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aion-hardening-'));
  try {
    const factory = createAdapterFactory({ learnedStore: new VersionedStore(path.join(dir, 'learned'), { kind: 'learned adapter' }) });
    const train = (p, attr) => [`${p}1`, `${p}2`, `${p}3`].map((id) => fakeSession(id, { roleAttr: attr }));
    const { candidate: v1 } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: train('a', 'data-role') });
    assert.equal(v1.basis, undefined, 'no prior -> no basis');
    const r1 = factory.promote({ candidate: v1, sessions: [fakeSession('h1')], expectedVersion: null });
    assert.equal(r1.version, 1);
    assert.equal(r1.candidateDigest, v1.digest);

    // Two relearns are synthesized on top of v1; the first one lands as v2.
    const { candidate: relearnA } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: train('b', 'data-msg-role'), priorName: 'fixture-chat' });
    const { candidate: relearnB } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: train('c', 'data-role'), priorName: 'fixture-chat' });
    assert.equal(relearnA.basis.name, 'fixture-chat');
    assert.equal(relearnA.basis.version, 1);
    assert.equal(relearnA.basis.priorDigest, v1.digest);
    assert.equal(relearnA.lineage.priorDigest, v1.digest);
    const r2 = factory.promote({ candidate: JSON.parse(JSON.stringify(relearnA)), sessions: [fakeSession('h2', { roleAttr: 'data-msg-role' })], expectedVersion: 1 });
    assert.equal(r2.version, 2);

    // The second relearn still claims basis v1: targeting CURRENT=2 is refused before any write.
    assert.throws(() => factory.promote({ candidate: relearnB, sessions: [fakeSession('h3')], expectedVersion: 2 }), (e) => e.code === 'STALE_BASIS');
    // A first-create expectation over a based candidate is equally stale.
    assert.throws(() => factory.promote({ candidate: relearnB, sessions: [fakeSession('h3')], expectedVersion: null }), (e) => e.code === 'STALE_BASIS');
    assert.throws(() => factory.promote({ candidate: { ...relearnB, basis: { name: 'fixture-chat' } }, sessions: [fakeSession('h3')], expectedVersion: 2 }), (e) => e.code === 'BASIS_INVALID');
    assert.equal(factory.loadRecord('fixture-chat').version, 2, 'refusals wrote nothing');

    // Re-synthesizing on the current version is the fix; the stored record links back to v2 exactly.
    const { candidate: rebased } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: train('c', 'data-role'), priorName: 'fixture-chat' });
    const v2digest = factory.loadRecord('fixture-chat').candidateDigest;
    assert.equal(rebased.basis.version, 2);
    // A client-edited digest field is not trusted: the stored digest is recomputed.
    const r3 = factory.promote({ candidate: { ...rebased, digest: '0'.repeat(64) }, sessions: [fakeSession('h4')], expectedVersion: 2 });
    assert.equal(r3.version, 3);
    const rec = factory.loadRecord('fixture-chat');
    assert.equal(rec.candidateDigest, rebased.digest);
    assert.equal(rec.candidate.digest, rebased.digest);
    assert.equal(rec.lineage.priorDigest, v2digest);
    assert.deepEqual(rec.basis, { name: 'fixture-chat', version: 2, priorDigest: v2digest });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('suffix role keys keep one selector form across saved probes, live probes and transcripts', () => {
  assert.equal(selectorForRole('data-content-search-unit-key', 'assistant', 'suffix'), '[data-content-search-unit-key$="assistant"]');
  assert.equal(selectorForRole('data-role', 'user'), '[data-role="user"]');
  assert.equal(selectorForRole('bad"]attr', 'user'), null);
  assert.equal(selectorForRole('data-role', 'Us"er'), null);

  // The in-page expression must carry roleMatch out of the page agent.
  assert.match(liveMeasurementExpression(), /roleMatch === 'suffix'/);
  const roles = [{ attr: 'data-content-search-unit-key', role: 'assistant', match: 'suffix' }, { attr: 'data-message-author-role', role: 'user', match: 'exact' }];
  const uncounted = probesFromLiveMeasurement({
    measurement: { readyState: 'complete', url: 'https://chatgpt.com/', startUrl: 'https://chatgpt.com/', battery: {}, prior: {}, roles },
    origin: 'https://chatgpt.com', captureId: 'live-uncounted',
  });
  assert.deepEqual(uncounted.filter((p) => p.feature === 'assistant-turn' || p.feature === 'user-turn'), [], 'a role label without a measured selector count is not presence');
  const live = probesFromLiveMeasurement({
    measurement: { readyState: 'complete', url: 'https://chatgpt.com/', startUrl: 'https://chatgpt.com/', battery: {}, prior: {},
      roles: roles.map((r) => ({ ...r, count: 1 })) },
    origin: 'https://chatgpt.com', captureId: 'live-x',
  });
  const cands = live.filter((p) => p.feature === 'assistant-turn' || p.feature === 'user-turn').map((p) => `${p.feature} ${p.candidate} ${p.outcome}`);
  assert.deepEqual(cands.sort(), [
    'assistant-turn [data-content-search-unit-key$="assistant"] present',
    'user-turn [data-message-author-role="user"] present',
  ]);
  assert.ok(!live.some((p) => p.candidate === '[data-content-search-unit-key="assistant"]'), 'never a fabricated exact selector');

  // Saved probes agree with live probes, and the transcript reads suffix-recorded turns only.
  const kv = new Map(Object.entries({ DOM_TURNS: [
    { index: 0, role: 'user', roleAttribute: 'data-content-search-unit-key', roleMatch: 'suffix', text: 'hello' },
    { index: 1, role: 'assistant', roleAttribute: 'data-content-search-unit-key', roleMatch: 'suffix', text: 'hi there' },
    { index: 2, role: 'assistant', roleAttribute: 'data-content-search-unit-key', roleMatch: 'exact', text: 'other form' },
  ] }));
  const session = { id: 'sx', kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }, meta: { target: { url: 'https://chatgpt.com/' } } };
  const saved = probesFromSession(session).filter((p) => p.feature === 'assistant-turn').map((p) => p.candidate);
  assert.ok(saved.includes('[data-content-search-unit-key$="assistant"]'));
  const candidate = { schema: 'aion.adaptive-webapp-adapter/1', siteId: 'chatgpt-learned', origin: 'https://chatgpt.com', features: {
    'user-turn': { selected: { candidate: '[data-content-search-unit-key$="user"]' } },
    'assistant-turn': { selected: { candidate: '[data-content-search-unit-key$="assistant"]' } },
  } };
  const tr = transcriptFromSession(session, candidate);
  assert.deepEqual(tr.items.map((i) => [i.role, i.text]), [['user', 'hello'], ['assistant', 'hi there']]);
});

test('thread binding is provider-native: the ChatGPT parser never binds another origin', () => {
  const UUID = '4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
  assert.equal(threadProviderForOrigin('https://chatgpt.com'), 'chatgpt');
  assert.equal(threadProviderForOrigin('https://chat.openai.com'), 'chatgpt');
  assert.equal(threadProviderForOrigin('https://claude.ai'), null);
  assert.equal(threadProviderForOrigin('https://chatgpt.com:8443'), null);
  assert.equal(threadProviderForOrigin('http://chatgpt.com'), null);
  const kvFor = (url) => { const kv = new Map(Object.entries({ DOM_TURNS: [], RECEIPT: { pageUrl: url } })); return { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }; };
  const cand = (origin) => ({ schema: 'aion.adaptive-webapp-adapter/1', siteId: 'x', origin, features: {} });

  const other = transcriptFromSession({ id: 'o1', kv: kvFor(`https://lookalike.test/c/${UUID}`), meta: {} }, cand('https://lookalike.test'));
  assert.equal(other.thread.binding, 'unverified');
  assert.equal(other.thread.nativeRef, null);

  const mismatch = transcriptFromSession({ id: 'o2', kv: kvFor(`https://lookalike.test/c/${UUID}`), meta: {} }, cand('https://chatgpt.com'));
  assert.equal(mismatch.thread.binding, 'unverified', 'page origin must equal the candidate origin');

  const real = transcriptFromSession({ id: 'o3', kv: kvFor(`https://chatgpt.com/c/${UUID}`), meta: {} }, cand('https://chatgpt.com'));
  assert.deepEqual(real.thread, { binding: 'verified', provider: 'chatgpt', nativeRef: `chatgpt-c:${UUID}`, url: `https://chatgpt.com/c/${UUID}` });
});

test('learned route templates never retain private slugs or opaque tokens; identity is still required', () => {
  const UUID = '4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
  const project = routeCandidateFromUrl(`https://chatgpt.com/g/g-p-67e1a2b3c4d5e6f7a8b9-my-private-project/c/${UUID}`);
  assert.equal(project, 'https://chatgpt.com/g/:token/c/:uuid');
  assert.equal(routeCandidateFromUrl(`https://example.test/workspace/acme-secret-launch-plan/chat/${UUID}`), 'https://example.test/workspace/:token/chat/:uuid');
  assert.equal(routeCandidateFromUrl(`https://example.test/s/%E2%9C%93name/c/${UUID}`), 'https://example.test/s/:token/c/:uuid');
  // stable provider route words survive
  assert.equal(routeCandidateFromUrl(`https://chatgpt.com/c/${UUID}`), 'https://chatgpt.com/c/:uuid');
  assert.equal(routeCandidateFromUrl(`https://example.test/backend-api/chat/${UUID}`), 'https://example.test/backend-api/chat/:uuid');
  // a generalized opaque token is not identity evidence on its own
  assert.equal(routeCandidateFromUrl('https://example.test/g/g-p-67e1a2b3c4d5e6f7a8b9-my-private-project'), null);
});
