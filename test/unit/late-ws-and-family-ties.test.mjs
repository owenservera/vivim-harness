// Regressions for two long-standing e2e defects (see test/e2e/universality.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { detectFamilies } from '../../src/families/families.mjs';

test('a late-joined WebSocket is never summarised as observed from its start', () => {
  const r = new StreamReducer();
  r.ingest({ k: 'ws.open', sid: 'late', t: 1, seq: 1, lateJoin: true, urlUnknown: true, target: 'page' });
  r.ingest({ k: 'ws.frame', sid: 'late', t: 2, seq: 2, dir: 'in', opcode: 1, payload: '{"type":"tick","seq":5}' });
  r.ingest({ k: 'ws.open', sid: 'full', t: 3, seq: 3, url: 'ws://h/ws', target: 'page' });
  r.ingest({ k: 'ws.frame', sid: 'full', t: 4, seq: 4, dir: 'in', opcode: 1, payload: '{"type":"tick","seq":1}' });
  const by = Object.fromEntries(r.summary().streams.map((s) => [s.sid, s]));
  assert.equal(by.late.lateJoin, true);
  assert.equal(by.late.urlUnknown, true);
  assert.equal(by.late.url, undefined);
  assert.notEqual(by.late.coverage, 'observed_from_request_start');
  assert.equal(by.full.coverage, 'observed_from_request_start');
  assert.equal(by.full.lateJoin, undefined);
  assert.equal(by.full.url, 'ws://h/ws');
});

test('families that saturate the 1.0 score cap are ranked by uncapped evidence, not declaration order', () => {
  const ev = { statuses: new Set([401]), textLength: 900, longestAssembled: 0 };
  const thin = { name: 'thin', detect: [{ signal: 'auth_gated', weight: 1 }] };
  const rich = { name: 'rich', detect: [{ signal: 'auth_gated', weight: 0.8 }, { signal: 'text_length', weight: 0.7 }] };
  const ranked = detectFamilies([thin, rich], ev);
  assert.deepEqual(ranked.map((f) => [f.family, f.score]), [['rich', 1], ['thin', 1]]);
  // Still stable for true ties, and a requirement failure still ranks last.
  const tie = detectFamilies([thin, { name: 'same', detect: [{ signal: 'auth_gated', weight: 1 }] }], ev);
  assert.deepEqual(tie.map((f) => f.family), ['thin', 'same']);
  const unmet = detectFamilies([{ name: 'blocked', requires: ['text_length'], detect: [{ signal: 'auth_gated', weight: 5 }] }, thin], { ...ev, textLength: 0 });
  assert.deepEqual(unmet.map((f) => f.family), ['thin', 'blocked']);
});
