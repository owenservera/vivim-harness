// QA-only offline regressions. No browser, network, real credentials or live sends.
// Run explicitly from AION checkout: node --test workspace/aion/qa/capture-studio/tests/sprint02-capture-safety.test.mjs
// Original 02310fe baseline: split-secret negatives reproduced in V8. Later Core introduced a pre-disk guard: these tests work with both versions, and assess raw/excluded rather than assume mask characters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubSecrets } from '../../src/capture/redact.mjs';
import { NetworkRecorder } from '../../src/capture/network.mjs';
import { createConversationService } from '../../src/capture/conversation-service.mjs';
import { acquireDriveLease } from '../../src/capture/drive-lease.mjs';

const fixture = {
  json: '{"api_key":"abcdef1234567890"}',  // fake demonstration string; never use real secrets
  bearer: 'Bearer abcdefghijklmnopqrstuvwxyz1234567890',
  jwt: 'eyJaaaaaaaaaa.bbbbbbbbbb.cccccccccc',
};
function captureChunks(parts) {
  const records = [];
  const network = new NetworkRecorder({ append: (r) => { records.push(r); return records.length; },
    profile: { capture: {} }, getPageUrl: () => 'https://example.test/page' });
  const state = { sid: 'test:synthetic', chunks: 0, bytes: 0 };
  for (const part of parts) network._chunk(state, Buffer.from(part, 'latin1'));
  // Current guard intentionally delays safe tail until stream Finish; simulate that exact flush
  // without invoking DevTools or incorrectly treating a pending tail as successful capture.
  if (state.guard && !state.credentialExcluded && typeof network._appendProtectedChunk === 'function')
    network._appendProtectedChunk(state, state.guard.finish(), { finalSecurityTail: true });
  return { raw: Buffer.concat(records.filter((r) => r.k === 'chunk').map((r) => Buffer.from(r.b64, 'base64'))).toString('latin1'),
    excluded: records.some((r) => r.k === 'body.excluded'), records };
}

for (const [name, value] of Object.entries(fixture)) {
  test('pre-disk control: single chunk masks ' + name, () => {
    const after = captureChunks([value]);
    assert.ok(!after.raw.includes(value), 'synthetic credential must never enter raw append');
    assert.ok(after.excluded || after.raw.includes('*'), 'guard must either exclude or mask with provenance');
  });
}
test('pre-disk boundary: split JSON credential must not survive in raw chunks', () => {
  const after = captureChunks(['{"api_key":', '"abcdef1234567890"}']);
  assert.ok(!after.raw.includes('abcdef1234567890'), 'two chunks must not reconstruct a readable credential');
});
test('pre-disk boundary: split Bearer credential must not survive in raw chunks', () => {
  const after = captureChunks(['Bearer abcdefgh', 'ijklmnopqrstuvwxyz1234567890']);
  assert.ok(!after.raw.includes('abcdefghijklmnopqrstuvwxyz1234567890'), 'Bearer payload split must not be persisted');
});
test('pre-disk boundary: three-way JWT must not survive in raw chunks', () => {
  const after = captureChunks(['eyJaaaaaaaaaa.bbbb', 'bbbbbb.ccccc', 'ccccc']);
  assert.ok(!after.raw.includes(fixture.jwt), 'JWT split must not be persisted before append');
});

test('uncertain browser submission: fresh key blocked; original key read-only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-qa-conversation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = { targetId: 'synthetic-tab', origin: 'https://example.test', ownedByStudio: true };
  let typed = 0, sent = 0, reads = 0;
  const adapter = {
    connect: async (binding) => ({ binding, sessionId: 'qa-session', readiness: { ready: true, draft: { present: false, chars: 0 } } }),
    preflight: async (binding) => ({ binding, draft: { present: false, chars: 0 }, boundary: { sequence: 2, transcriptCount: 0 } }),
    type: async () => { typed++; },
    submit: async () => { sent++; return null; }, // transport effect uncertain
    reconcile: async () => { reads++; return null; },
    stop: async () => {},
    closeTab: async () => {},
  };
  const svc = createConversationService({ dataDir: dir, id: 'qa-uncertain', adapter });
  await svc.connect({ ...b, expectedRevision: svc.read().revision });
  const req = { key: 'key-1', prompt: 'synthetic prompt', expectedRevision: svc.read().revision, confirm: true };
  const first = await svc.submit(req);
  assert.equal(first.send.state, 'uncertain');
  await assert.rejects(() => svc.submit({ ...req, key: 'key-new', expectedRevision: svc.read().revision }), (e) => e.code === 'ONE_TURN_LIMIT');
  const original = await svc.submit({ ...req, expectedRevision: svc.read().revision });
  assert.equal(original.id, first.id);
  await svc.reconcile({ expectedRevision: svc.read().revision });
  await assert.rejects(() => svc.submit({ ...req, key: 'key-new-2', expectedRevision: svc.read().revision }), (e) => e.code === 'ONE_TURN_LIMIT');
  assert.deepEqual({ typed, sent, reads }, { typed: 1, sent: 1, reads: 1 });
});
test('lease must not be stolen from live owner after owner metadata corruption', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-qa-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  acquireDriveLease({ port: 19097, root, holder: { kind: 'qa-first', id: 'one' } });
  fs.writeFileSync(path.join(root, '19097', 'owner.json'), '{not-json');
  assert.throws(() => acquireDriveLease({ port: 19097, root, staleGraceMs: 0,
    holder: { kind: 'qa-second', id: 'two' } }), (e) => e.code === 'DRIVE_LEASE_BUSY',
    'corrupt metadata is not positive evidence the original owner stopped');
});
