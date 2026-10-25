// aion.web-observation/1 — the loss-aware L02->L03 projection. Bench Tier-0: E00 (unknown parts
// preserved, never coerced to text), E03 (identity: only the source-supported parser may surface
// a nativeRef; title/ordinal/timestamp/text never become identity), plus the five DISTINCT
// completion facts. Synthetic sessions only; no webapp, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/store/session.mjs';
import { OBSERVATION_SCHEMA, buildObservation, observeSession, SEMANTIC_PARTS } from '../../src/shapes/observation.mjs';

function fixture(t, { site = 'chatgpt', url = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111', kv = {}, status = 'complete' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'observation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = Session.create(root, { site, meta: { target: { url }, ...(status ? { status } : {}), profile: { name: 'generic' } } });
  for (const [k, v] of Object.entries(kv)) s.kv.set(k, v);
  return s;
}

const STREAM_COMPONENTS = {
  schema: 'capture-studio.stream-components/1',
  streams: [
    { sid: 's1', mapId: 'chatgpt-path-ops', eventsOmitted: 0,
      components: [
        { componentKey: 'msg-1:0', component: 'paragraph', opened: true, closed: true, text: 'Answer prose with a citation [1].' },
        { componentKey: 'msg-1:1', component: 'weird-widget', opened: true, closed: false, text: 'interactive thing' },
      ],
      unmappedCount: 3, unmappedSample: [{ seq: 9, reason: 'no rule' }], signals: { errorCount: 0 } },
  ],
  totals: { streams: 1, mapped: 1, noMap: 0, components: 2, unmappedCount: 3, eventsOmitted: 0, streamsWithErrors: 0 },
};

test('schema, provider, surface detection and bounded previews', (t) => {
  const s = fixture(t);
  const o = buildObservation({ session: s, components: STREAM_COMPONENTS,
    domTurns: [{ domId: 'u1', role: 'user', text: 'x'.repeat(500) }],
    shapes: { endpoints: [{ endpoint: 'POST /backend-api/conversation', transports: { HTTP_SSE: 1 } }] } });
  assert.equal(o.schema, OBSERVATION_SCHEMA);
  assert.equal(o.provider, 'chatgpt');
  assert.equal(o.surface, 'chat');
  assert.equal(o.account.state, 'unknown');
  assert.equal(o.account.ref, null);
  const turn = o.turns[0];
  assert.equal(turn.textPreview.length, 240);
  assert.equal(turn.textTruncated, true);
  assert.equal(turn.textLength, 500);
});

test('E03 identity: chatgpt URL parser verifies; other sites and guest query params stay unverified with nativeRef null', (t) => {
  const gpt = fixture(t, { site: 'chatgpt', url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' });
  const o1 = buildObservation({ session: gpt });
  assert.equal(o1.conversation.binding, 'url-parser-verified');
  assert.equal(o1.conversation.nativeRef, 'chatgpt-c:11111111-1111-4111-8111-111111111111');
  assert.ok(o1.conversation.identitySource);

  const claude = fixture(t, { site: 'claude', url: 'https://claude.ai/chat/abc123-not-a-parser' });
  const o2 = buildObservation({ session: claude });
  assert.equal(o2.conversation.binding, 'unverified');
  assert.equal(o2.conversation.nativeRef, null);

  const duck = fixture(t, { site: 'duck-ai', url: 'https://duck.ai/?chatID=4a945005-1361-4c2b-9cb7-0dc51ea6e526' });
  const o3 = buildObservation({ session: duck });
  assert.equal(o3.conversation.binding, 'unverified', 'a guest query-parameter id is NOT a verified durable thread');
  assert.equal(o3.conversation.nativeRef, null);
});

test('E00 loss-awareness: unknown native parts and unknown DOM roles are preserved with loss markers, never coerced to text', (t) => {
  const s = fixture(t);
  const o = buildObservation({ session: s, components: STREAM_COMPONENTS,
    domTurns: [{ domId: 'x1', role: 'system-banner', text: 'unknown thing' }] });
  const weird = o.streams[0].components.find((c) => c.nativeType === 'weird-widget');
  assert.ok(weird, 'the unknown component is retained');
  assert.equal(weird.partType, 'unknown-native');
  assert.equal(weird.textPreview, 'interactive thing', 'its raw text is retained under its own type');
  assert.equal(weird.lossMarker, 'unknown-native-part');
  assert.equal(o.streams[0].unmapped.count, 3);
  const roleTurn = o.turns[0];
  assert.equal(roleTurn.partType, 'unknown-native');
  assert.equal(roleTurn.lossMarker, 'unknown-dom-role');
  assert.ok(o.lossMarkers.some((m) => m.kind === 'unknown-native-parts' && m.count === 1));
  assert.ok(o.lossMarkers.some((m) => m.kind === 'unknown-dom-roles' && m.count === 1));
  assert.ok(o.lossMarkers.some((m) => m.kind === 'unmapped-stream-events' && m.count === 3));
  // The semantic vocabulary itself contains no fabrication path: unknown is a member.
  assert.ok(SEMANTIC_PARTS.includes('unknown'));
});

test('five completion facts are distinct and each traces to its own evidence class', (t) => {
  const s = fixture(t);
  const base = { session: s, components: STREAM_COMPONENTS, domTurns: [{ domId: 'u1', role: 'user', text: 'q' }] };
  const o = buildObservation({ ...base, terminal: { streams: 2, done: 1, fail: 0, chatStreams: null, domTurns: 1, seqRange: [1, 40] },
    acceptance: { verdict: 'capture_incomplete', gates: { G1: { value: 'passed', evidence: { freshness: 'pre-send baseline enforced' } }, G3: { value: 'passed' } } } });
  assert.equal(o.completion.providerNetworkEnded, 'partial', 'one of two streams ended; not yes, not no');
  assert.equal(o.completion.pageStable, 'passed', 'from the G3 gate, not from network state');
  assert.equal(o.completion.turnAttribution.domObserved, true);
  assert.equal(o.completion.turnAttribution.freshness, 'pre-send baseline enforced');
  assert.equal(o.completion.captureFinalized, 'yes', 'session status complete');
  assert.equal(o.completion.captureAccepted, 'capture_incomplete', 'acceptance is its own fact');
  const noEvidence = buildObservation({ session: fixture(t, { status: null }) });
  assert.equal(noEvidence.completion.providerNetworkEnded, 'unknown');
  assert.equal(noEvidence.completion.pageStable, 'unassessed');
  // A fresh Session defaults to status 'recording': not finalized is 'no', not 'unknown'.
  assert.equal(noEvidence.completion.captureFinalized, 'no');
  assert.equal(noEvidence.completion.captureAccepted, 'unassessed');
});

test('missing derive artifacts project as not-derived, never guessed; failing join is a visible loss marker', (t) => {
  const s = fixture(t);
  const o = buildObservation({ session: s, join: { schema: 'capture-studio.stream-dom-join/1', error: 'reducer exploded' } });
  assert.deepEqual(o.streams, []);
  assert.deepEqual(o.turns, []);
  assert.equal(o.reconciliation.dom, 'absent');
  assert.equal(o.reconciliation.network, 'absent');
  assert.equal(o.reconciliation.join.status, 'join-error');
  assert.ok(o.lossMarkers.some((m) => m.kind === 'join-error'));
  assert.equal(o.surface, 'unknown');
  assert.equal(o.completion.providerNetworkEnded, 'unknown');
});

test('observeSession scans the raw log for terminal records and wires the acceptance document', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'observation-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = Session.create(root, { site: 'example', meta: { target: { url: 'https://chat.example.test/x' }, status: 'complete' } });
  s.raw.append({ k: 'req', sid: 's1', url: 'https://chat.example.test/api/chat', method: 'POST', type: 'Fetch', t: 1 });
  s.raw.append({ k: 'res', sid: 's1', status: 200, mime: 'text/event-stream', t: 2 });
  s.raw.append({ k: 'chunk', sid: 's1', b64: Buffer.from('data: x\n\n').toString('base64'), t: 3 });
  s.raw.append({ k: 'done', sid: 's1', encodedDataLength: 9, t: 4 });
  await s.raw.close();
  const o = await observeSession(s, { acceptance: { verdict: 'capture_incomplete', gates: {} } });
  // One stream with one done record, but the scan has no chat-role document, so it cannot prove
  // that EVERY chat stream ended: 'partial' is the honest label, not 'yes'.
  assert.equal(o.completion.providerNetworkEnded, 'partial');
  assert.equal(o.completion.captureAccepted, 'capture_incomplete');
  assert.equal(o.evidence.capture.session, s.id);
});
