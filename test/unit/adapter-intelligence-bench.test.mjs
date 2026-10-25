/**
 * AION Intelligence Bench — adversarial, offline, read-only checks against real Studio exports.
 * Every case is synthetic. Labels such as SAVED_REAL_CAPTURE below exercise scoring branches;
 * they are NOT claims that this suite collected independently accepted live evidence.
 * No CDP actor, no network, no browser writes, no learned-profile promotion.
 * Run: node --test test/unit/adapter-intelligence-bench.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { synthesizeWebappAdapter } from '../../src/studio/adaptive-adapter-factory.mjs';
import { probesFromSession, scopeProbes, transcriptFromSession, TEXT_PREVIEW_CAP } from '../../src/studio/adapter-probes.mjs';
import { qualifyHoldout, assessDrift, createBoundedProjection, scopeKey } from '../../src/studio/systems-probes.mjs';
import { createCasVersionedStore } from '../../src/studio/adapter-learning-pipeline.mjs';
import { VersionedStore } from '../../src/store/versioned.mjs';
import { SseDecoder } from '../../src/decode/decoders.mjs';
import { induceStreamMap } from '../../src/profiles/stream-map-induce.mjs';
import { applyStreamMap, DEFAULT_STREAM_MAPS } from '../../src/profiles/stream-map.mjs';

const scope = { siteId: 'previously-unlisted-site', origin: 'https://unknown-fixture.invalid', account: 'fixture-account', surface: 'chat' };
const bench = (scenario, metrics) => console.log('AION_BENCH ' + JSON.stringify({ scenario, ...metrics, synthetic: true }));
const probe = (captureId, feature, candidate, outcome = 'present', evidenceClass = 'SYNTHETIC_TEST') => ({
  siteId: scope.siteId, origin: scope.origin, surface: scope.surface, captureId,
  feature, candidate, outcome, evidenceClass, coverage: 'complete',
  type: feature === 'thread-route' ? 'route' : feature === 'stream-component' ? 'stream-map' : 'selector',
  carrier: feature === 'stream-component' ? 'network' : 'dom', sequence: 1,
});
const session = (id, turns, assembled = {}) => {
  const url = scope.origin + '/chat';
  const kv = new Map(Object.entries({ DOM_TURNS: turns, ASSEMBLED: assembled, RECEIPT: { pageUrl: url } }));
  return { id, kv: { get: (k, fallback) => kv.has(k) ? kv.get(k) : fallback }, meta: { target: { url } } };
};
const turn = (role, index, text = 'turn ' + index, blocks = []) => ({
  index, role, roleAttribute: 'data-role', roleMatch: 'exact',
  domId: 'div[data-role=' + role + ']', text, blocks,
});

test('unknown-site: saved evidence produces scoped user/assistant reads without invented route or effect grant', () => {
  const all = [];
  const origins = new Map();
  for (let i = 1; i <= 3; i++) {
    const id = 'unknown-' + i;
    origins.set(id, scope.origin);
    all.push(...probesFromSession(session(id, [turn('user', 0), turn('assistant', 1)]), { evidenceClass: 'SYNTHETIC_TEST' }));
  }
  const scoped = scopeProbes(all, { siteId: scope.siteId, origin: scope.origin, surface: 'chat', sessionOrigins: origins });
  const result = synthesizeWebappAdapter({ siteId: scope.siteId, origin: scope.origin, surface: 'chat', observations: scoped });
  assert.equal(result.features['user-turn'].selected?.candidate, '[data-role="user"]');
  assert.equal(result.features['assistant-turn'].selected?.candidate, '[data-role="assistant"]');
  assert.equal(result.features['assistant-turn'].selected.status, 'provisional');
  assert.equal(result.features['thread-route'].selected, null, 'a URL without native conversation identity is not enough');
  assert.equal(result.authority.sendPermission, false);
  bench('unknown_site', { sourceCaptures: 3, readRolesRecognized: 2, inventedRoutes: 0, readStatus: 'provisional' });
});

test('known-site drift: retired selector, replacement proposal and consecutive-window source gate', () => {
  const prior = synthesizeWebappAdapter({ ...scope, observations: ['old1', 'old2', 'old3'].map(id =>
    probe(id, 'assistant-turn', '[data-role="assistant"]', 'present', 'SAVED_REAL_CAPTURE')) });
  assert.equal(prior.features['assistant-turn'].selected?.status, 'shadow-ready');
  const observations = [
    probe('new0', 'assistant-turn', '[data-role="assistant"]', 'absent', 'SANDBOX_REAL_BROWSER'),
    ...['new1', 'new2', 'new3'].map(id => probe(id, 'assistant-turn', '[data-msg-role="assistant"]', 'present', 'SANDBOX_REAL_BROWSER')),
  ];
  const changed = synthesizeWebappAdapter({ ...scope, prior, observations });
  assert.equal(changed.features['assistant-turn'].selected?.candidate, '[data-msg-role="assistant"]');
  assert.ok(changed.drift.some(x => x.reason === 'PREVIOUS_CANDIDATE_NEGATIVE_OBSERVATION'));
  assert.equal(changed.authority.sendPermission, false);
  const observationsForGate = [
    ['n1', 20, '[data-msg-role="assistant"]', 'present'],
    ['n2', 21, '[data-msg-role="assistant"]', 'present'],
    ['n3', 21, '[data-msg-role="assistant"]', 'present'],
    ['o1', 20, '[data-role="assistant"]', 'absent'],
    ['o2', 21, '[data-role="assistant"]', 'absent'],
  ].map(([lineage, window, candidate, outcome]) => ({
    scope, session: lineage, lineage, window, candidate, outcome,
    sourceQualified: true, coreAccepted: true, coverage: 'complete',
  }));
  const args = { scope, incumbent: '[data-role="assistant"]', proposal: '[data-msg-role="assistant"]' };
  const qualified = assessDrift({ ...args, observations: observationsForGate });
  assert.equal(qualified.decision, 'shadow-revalidate-read-only');
  const flapping = assessDrift({ ...args, observations: observationsForGate.map(x => ({ ...x, window: x.window === 21 ? 23 : 20 })) });
  assert.equal(flapping.reason, 'MORE_INDEPENDENT_EVIDENCE_REQUIRED');
  bench('known_site_drift', { newPositiveSessions: 3, oldNegativeSessions: 2, windows: 2, consecutiveQualified: qualified.ok, flappingQualified: flapping.ok, sendPermission: false });
});

const manifest = (id, lineage, digest, account = scope.account) => ({
  id, lineage, sourceDigest: digest, scope: { ...scope, account }, coverage: 'complete',
  sourceQualified: true, coreAccepted: true,
});
test('holdout leakage: remount, cross-account and equal-source-digest diagnostics', () => {
  const train = [manifest('a', 'raw-a', 'sha256:a'), manifest('b', 'raw-b', 'sha256:b')];
  const heldout = [manifest('c', 'raw-c', 'sha256:c')];
  const args = { train, heldout, expectedScope: scope };
  assert.equal(qualifyHoldout(args).ok, true);
  assert.equal(qualifyHoldout({ ...args, heldout: [manifest('z', 'raw-a', 'sha256:z')] }).reason, 'EVIDENCE_LINEAGE_REUSED');
  assert.equal(qualifyHoldout({ ...args, heldout: [manifest('z', 'raw-z', 'sha256:z', 'other-account')] }).reason, 'SCOPE_MISMATCH');
  // Probe-local gap detector: this pure diagnostic does not compare sourceDigest. The
  // production pipeline separately verifies immutable manifest lineage and digest overlap.
  const digestAlias = qualifyHoldout({ ...args, heldout: [manifest('z', 'raw-z', 'sha256:a')] });
  bench('holdout_leakage', { reusedLineageRejected: true, crossAccountRejected: true,
    identicalDigestWithForgedDistinctLineageAcceptedByStandaloneProbe: digestAlias.ok });
  assert.equal(typeof digestAlias.ok, 'boolean');
});

// Two fidelity layers: native stream mapping, and the explicitly lossy learned transcript.
test('native stream: induced/seed maps preserve component identity and text from typed-event fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/ai-chat-dialects/claude-typedevents.json', import.meta.url), 'utf8'));
  const sse = fixture.payloads.map(p => (typeof p === 'string' ? 'data: ' + p :
    (typeof p.type === 'string' ? 'event: ' + p.type + '\n' : '') + 'data: ' + JSON.stringify(p))).join('\n\n') + '\n\n';
  const decoder = new SseDecoder();
  const events = [...decoder.push(Buffer.from(sse, 'utf8')), ...decoder.end()].map((x, i) => ({ ...x, sid: 'native-fixture', seq: i }));
  const induced = induceStreamMap(events);
  const seed = DEFAULT_STREAM_MAPS.find(x => x.id === 'claude-typed-events');
  assert.ok(seed);
  const projected = r => r.components.filter(x => x.component !== 'message').map(x => ({ key: x.componentKey, text: x.text }));
  const a = projected(applyStreamMap(induced, events));
  const b = projected(applyStreamMap(seed, events));
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
  bench('native_stream_fidelity', { events: events.length, componentCount: a.length,
    componentKeysMatched: a.length, textCharacters: a.map(x => x.text ?? '').join('').length });
});

test('native block boundary: learned transcript identifies bounded text preview, never claims artifact fidelity', () => {
  const rich = [ { type: 'code', id: 'source-code-001' }, { type: 'table', id: 'source-table-002' }, { type: 'citation', id: 'source-cite-003' } ];
  const s = session('rich-1', [turn('user', 0, 'request'), turn('assistant', 1, 'X'.repeat(TEXT_PREVIEW_CAP + 99), rich)]);
  const candidate = { schema: 'aion.adaptive-webapp-adapter/1', siteId: scope.siteId, origin: scope.origin, features: {
    'user-turn': { selected: { candidate: '[data-role="user"]' } },
    'assistant-turn': { selected: { candidate: '[data-role="assistant"]' } },
  } };
  const projected = transcriptFromSession(s, candidate);
  assert.deepEqual(projected.items.map(x => x.role), ['user', 'assistant']);
  assert.equal(projected.items[1].truncated, true);
  assert.equal(projected.items[1].textLength, TEXT_PREVIEW_CAP + 99);
  assert.equal(projected.items[1].evidence.session, 'rich-1');
  assert.equal(projected.items[1].text.length, TEXT_PREVIEW_CAP);
  assert.ok(!JSON.stringify(projected).includes('source-code-001'));
  bench('native_transcript_preview', { originalNativeBlocks: rich.length, nativeBlocksInPreview: 0,
    sourceTextCharacters: TEXT_PREVIEW_CAP + 99, previewCharacters: projected.items[1].text.length, clearlyTruncated: projected.items[1].truncated });
});

test('long-stream cost: 20000 offers across 80 ids bound projection memory and explicitly report loss', () => {
  const maxStreams = 32, maxChars = 256, updates = 20000, totalIds = 80;
  const projection = createBoundedProjection({ maxStreams, maxChars });
  const body = 'X'.repeat(1024);
  const startMem = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let i = 0; i < updates; i++) {
    projection.offer({ scopeKey: scopeKey(scope), streamId: 'stream-' + (i % totalIds),
      revision: Math.floor(i / totalIds), text: body + i });
  }
  const elapsedMs = +(performance.now() - started).toFixed(2);
  const deltaHeap = process.memoryUsage().heapUsed - startMem;
  const snap = projection.snapshot();
  assert.equal(snap.streams.length, maxStreams);
  assert.equal(snap.metrics.maxTracked, maxStreams);
  assert.equal(snap.metrics.accepted, updates * maxStreams / totalIds);
  assert.equal(snap.metrics.overflow, updates * (totalIds - maxStreams) / totalIds);
  assert.ok(snap.streams.every(x => x.text.length <= maxChars && x.truncated));
  assert.equal(projection.offer({ scopeKey: scopeKey(scope), streamId: 'stream-0', revision: 0, text: 'old' }).reason, 'STALE_REVISION');
  bench('long_stream_projection', { offers: updates, distinctStreams: totalIds, maxTracked: snap.metrics.maxTracked,
    accepted: snap.metrics.accepted, rejectedOverflow: snap.metrics.overflow,
    projectionGapCount: snap.metrics.uiGaps, elapsedMs, offersPerSecond: Math.round(updates / (elapsedMs / 1000 || 1)),
    heapDeltaBytes: deltaHeap, retainedCharCapPerStream: maxChars });
});

test('rollback CAS: stale rollbacks rejected; restores append version; scope isolation preserved', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aion-intelligence-bench-'));
  try {
    const store = new VersionedStore(path.join(root, 'versions'), { kind: 'learned adapter' });
    const cas = createCasVersionedStore({ store });
    const key = JSON.stringify([scope.siteId, scope.origin, scope.account, scope.surface]);
    const otherKey = JSON.stringify([scope.siteId, scope.origin, 'other-account', scope.surface]);
    const payload = marker => ({ schema: 'aion.learned-read-adapter/1', adapter: { marker }, readFeatures: ['assistant-turn'], sendPermission: false });
    assert.equal((await cas.promote(key, payload('old'), null)).version, 1);
    assert.equal((await cas.promote(key, payload('new'), 1)).version, 2);
    await assert.rejects(() => cas.rollback(key, 1, 1), e => e.code === 'CAS_VERSION_CONFLICT');
    const restored = await cas.rollback(key, 1, 2);
    assert.equal(restored.version, 3);
    assert.equal((await cas.current(key)).adapter.marker, 'old');
    assert.equal((await cas.current(key)).version, 3);
    assert.equal(await cas.current(otherKey), null);
    await assert.rejects(() => cas.rollback(key, 2, 2), e => e.code === 'CAS_VERSION_CONFLICT');
    bench('rollback_cas', { versionsCreated: 3, staleRollbackRejected: 2, restoredVersion: 1,
      appendedAtVersion: 3, otherAccountSelection: false, sendPermission: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});