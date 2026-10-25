// Adapter factory service lifecycle: synthesize -> shadow -> promote (server-side recheck) ->
// learned adapter shape -> rollback -> drift, with fail-closed promotion policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VersionedStore } from '../../src/store/versioned.mjs';
import { createAdapterFactory, learnedAdapterFromCandidate } from '../../src/studio/adapter-factory-service.mjs';
import { synthesizeWebappAdapter } from '../../src/studio/adaptive-adapter-factory.mjs';
import { probesFromSession } from '../../src/studio/adapter-probes.mjs';

const ORIGIN = 'https://127.0.0.1:8443';

function fakeSession(id, { roleAttr = 'data-role' } = {}) {
  const url = `${ORIGIN}/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b`;
  const turns = [
    { index: 0, domId: `div.bubble[${roleAttr}=user]`, role: 'user', roleAttribute: roleAttr, text: 'prompt text' },
    { index: 1, domId: `div.bubble[${roleAttr}=assistant]`, role: 'assistant', roleAttribute: roleAttr, text: 'reply text' },
  ];
  const kv = new Map(Object.entries({ DOM_TURNS: turns, ASSEMBLED: { a: { endpoint: 'POST /api/chat' } }, RECEIPT: { pageUrl: url } }));
  return { id, kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }, meta: { target: { url } } };
}

function freshFactory() {
  const dir = mkdtempSync(path.join(tmpdir(), 'aion-learned-'));
  const store = new VersionedStore(path.join(dir, 'learned-adapters'), { kind: 'learned adapter' });
  return { factory: createAdapterFactory({ learnedStore: store }), dir, store };
}

const SCOPED = { siteId: 'fixture-chat', origin: ORIGIN, surface: 'chat', sessionOrigins: new Map() };

test('full lifecycle: three training sessions, one held-out, promotion to read-only adapter', () => {
  const { factory, dir } = freshFactory();
  try {
    const training = [fakeSession('t1'), fakeSession('t2'), fakeSession('t3')];
    const heldout = [fakeSession('h1')];

    const { candidate } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: training });
    assert.equal(candidate.schema, 'aion.adaptive-webapp-adapter/1');
    assert.equal(candidate.authority.sendPermission, false);
    assert.equal(candidate.coverage['user-turn'], 'shadow-ready');
    assert.equal(candidate.coverage['assistant-turn'], 'shadow-ready');
    assert.equal(candidate.coverage['thread-route'], 'shadow-ready');
    assert.equal(candidate.features['user-turn'].selected.candidate, '[data-role="user"]');

    const shadow = factory.shadowEvaluate({ candidate, sessions: heldout });
    assert.equal(shadow.recommendation, 'candidate-read-only-preview');
    assert.ok(shadow.checked >= 3); // user-turn + assistant-turn + thread-route held-out positives

    const rec = factory.promote({ candidate, sessions: heldout, clientShadow: shadow, note: 'demo v1', expectedVersion: null });
    assert.equal(rec.version, 1);
    assert.equal(rec.adapter.learned, true);
    assert.equal(rec.adapter.readOnly, true);
    assert.equal(rec.adapter.send.strategy, 'learned-readonly');
    assert.equal(rec.adapter.authority.sendPermission, false);
    assert.deepEqual(rec.adapter.factory.readFeatures.sort(), ['assistant-turn', 'stream-component', 'thread-route', 'user-turn']);
    assert.equal(rec.adapter.userTurn.selectors[0], '[data-role="user"]');
    assert.equal(rec.adapter.assistantTurn.selectors[0], '[data-role="assistant"]');
    assert.ok(rec.adapter.threadRoute.pattern.includes('chatID=:uuid'));

    // The learned adapter is visible through the read view but carries no composer at all.
    assert.equal(rec.adapter.composer, undefined);
    const loaded = factory.loadLearned('fixture-chat');
    assert.equal(loaded.id, 'fixture-chat');
    assert.equal(factory.loadRecord('fixture-chat').version, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('promotion is fail-closed: no held-out sessions, quarantine, authority violation, receipt mismatch', () => {
  const { factory, dir } = freshFactory();
  try {
    const training = [fakeSession('t1'), fakeSession('t2'), fakeSession('t3')];
    const { candidate } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: training });

    // No held-out sessions -> recomputed shadow is collect-more-evidence -> refused.
    assert.throws(() => factory.promote({ candidate, sessions: [], expectedVersion: null }), (e) => e.code === 'PROMOTION_NOT_EARNED');

    // A quarantined candidate (held-out contradiction) never promotes.
    const badSession = fakeSession('bad');
    const badTurns = [...badSession.kv.get('DOM_TURNS')];
    badTurns[0] = { ...badTurns[0], roleAttribute: 'data-other' }; // training selector absent in this capture
    // contradiction via a wrong claim cannot be built from saved probes (presence-only), so
    // quarantine is exercised at the unit level through a mismatched client receipt instead.
    assert.throws(() => factory.promote({ candidate, sessions: [fakeSession('h1')], clientShadow: { recommendation: 'quarantine' }, expectedVersion: null }), (e) => e.code === 'SHADOW_MISMATCH');

    // Authority violation: a doctored candidate cannot promote.
    const doctored = JSON.parse(JSON.stringify(candidate));
    doctored.authority.sendPermission = true;
    assert.throws(() => factory.promote({ candidate: doctored, sessions: [fakeSession('h1')], expectedVersion: null }), (e) => e.code === 'AUTHORITY_VIOLATION');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cross-origin synthesis fails closed', () => {
  const { factory, dir } = freshFactory();
  try {
    const evil = fakeSession('e1');
    const kv = new Map(Object.entries({
      DOM_TURNS: evil.kv.get('DOM_TURNS'),
      ASSEMBLED: {},
      RECEIPT: { pageUrl: 'https://evil.test/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b' },
    }));
    const s = { id: 'e1', kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }, meta: { target: { url: 'https://evil.test/chat' } } };
    assert.throws(() => factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: [s] }), /PROBE_ORIGIN_MISMATCH/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('drift: prior candidate measured absent on the new UI triggers both drift reasons', async () => {
  const { factory, dir } = freshFactory();
  try {
    const training = [fakeSession('t1'), fakeSession('t2'), fakeSession('t3')];
    const heldout = [fakeSession('h1')];
    const { candidate } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: training });
    factory.promote({ candidate, sessions: heldout, expectedVersion: null });

    // Site UI changed: role attribute renamed data-role -> data-msg-role. Live probes carry the
    // honest absence of the previous selector (SANDBOX_REAL_BROWSER, complete document) plus the
    // new attribute's presence; saved captures from the new UI supply the multi-capture support.
    const liveProbes = probesFromSession(fakeSession('live'), { evidenceClass: 'SANDBOX_REAL_BROWSER' })
      .map((p) => (p.candidate === '[data-role="user"]' ? { ...p, outcome: 'absent', candidate: '[data-role="user"]' } : p));
    const v2training = [fakeSession('v1', { roleAttr: 'data-msg-role' }), fakeSession('v2', { roleAttr: 'data-msg-role' }), fakeSession('v3', { roleAttr: 'data-msg-role' })];

    const { candidate: v2 } = factory.synthesize({
      siteId: 'fixture-chat', origin: ORIGIN, sessions: [...v2training], priorName: 'fixture-chat',
    });
    // saved captures cannot prove absence of the old selector; live probes supply that
    const withAbsence = synthesize2(factory, liveProbes, v2training);
    assert.ok(withAbsence.drift.some((d) => d.reason === 'PREVIOUS_CANDIDATE_NEGATIVE_OBSERVATION' && d.previousCandidate === '[data-role="user"]'));
    assert.ok(withAbsence.drift.some((d) => d.reason === 'PROPOSED_REPLACEMENT_REQUIRES_SHADOW_VALIDATION'));
    // plain synthesize (saved captures only) still proposes the replacement but cannot prove the
    // old selector negative — so only the shadow-validation reason appears (per drifted feature)
    assert.ok(v2.drift.length >= 2); // user-turn AND assistant-turn both drifted
    assert.ok(v2.drift.every((d) => d.reason === 'PROPOSED_REPLACEMENT_REQUIRES_SHADOW_VALIDATION'));
    assert.equal(v2.features['user-turn'].selected.candidate, '[data-msg-role="user"]');

    // v2 relearn to promotion
    const shadow2 = factory.shadowEvaluate({ candidate: withAbsence.candidate, sessions: [fakeSession('h2', { roleAttr: 'data-msg-role' })] });
    assert.equal(shadow2.recommendation, 'candidate-read-only-preview');
    const rec2 = factory.promote({ candidate: withAbsence.candidate, sessions: [fakeSession('h2', { roleAttr: 'data-msg-role' })], note: 'relearn v2', expectedVersion: 1 });
    assert.equal(rec2.version, 2);
    assert.equal(rec2.adapter.userTurn.selectors[0], '[data-msg-role="user"]');

    // rollback to v1 restores the previous selectors by APPENDING v3 (no re-synthesis, strict explicit expectation)
    const rb1 = factory.rollback('fixture-chat', 1, { expectedVersion: 2 });
    assert.equal(rb1.version, 3);
    assert.equal(rb1.restoredFrom, 1);
    assert.equal(factory.loadLearned('fixture-chat').userTurn.selectors[0], '[data-role="user"]');
    const rb2 = factory.rollback('fixture-chat', 2, { expectedVersion: 3 });
    assert.equal(rb2.version, 4);
    assert.equal(factory.loadLearned('fixture-chat').userTurn.selectors[0], '[data-msg-role="user"]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// helper: synthesize with extra server-produced probes folded in (mirrors the live route)
function synthesize2(factory, liveProbes, sessions) {
  const observations = [];
  const sessionOrigins = new Map();
  for (const s of sessions) { sessionOrigins.set(s.id, ORIGIN); observations.push(...probesFromSession(s)); }
  let seq = 100000; // keep sequences unique against the saved probes
  for (const p of liveProbes) observations.push({ ...p, sequence: seq++, captureId: `live-${p.captureId}` });
  for (const p of observations) { p.siteId = 'fixture-chat'; p.origin = ORIGIN; p.surface = 'chat'; }
  const candidate = synthesizeWebappAdapter({ siteId: 'fixture-chat', origin: ORIGIN, surface: 'chat', observations, prior: factory.loadRecord('fixture-chat').candidate });
  return { candidate, drift: candidate.drift };
}

test('learnedAdapterFromCandidate only activates held-out-confirmed features', () => {
  const candidate = {
    schema: 'aion.adaptive-webapp-adapter/1', siteId: 'x', origin: ORIGIN, surface: 'chat',
    authority: { browser: 'existing-capture-studio-only', sendPermission: false, autoExecution: false },
    features: {
      'user-turn': { selected: { type: 'selector', candidate: '[data-u="1"]', status: 'shadow-ready' } },
      'assistant-turn': { selected: { type: 'selector', candidate: '[data-a="1"]', status: 'shadow-ready' } },
      'composer': { selected: { type: 'selector', candidate: 'textarea', status: 'shadow-ready' } },
    },
  };
  const adapter = learnedAdapterFromCandidate(candidate, { recommendation: 'candidate-read-only-preview', coverage: ['user-turn', 'composer'], checked: 2, positive: 2, contradicted: 0 });
  assert.equal(adapter.userTurn.selectors[0], '[data-u="1"]');
  assert.equal(adapter.assistantTurn, undefined); // not held-out-confirmed -> NOT activated
  // composer IS a write surface: even when shadow-confirmed it must never appear on a learned adapter
  assert.equal(adapter.composer, undefined);
  assert.equal(adapter.send.strategy, 'learned-readonly');
});
