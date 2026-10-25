import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RawLog } from '../../src/store/raw-log.mjs';
import { Session, listSessions } from '../../src/store/session.mjs';
import { redactHeaders, redactUrl, scrubSecrets, isSensitiveUrl } from '../../src/capture/redact.mjs';
import { pickTarget } from '../../src/cdp/discovery.mjs';
import { assertLoopbackUrl } from '../../src/cdp/client.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));

test('raw log rotates segments and records sha256 manifest', async () => {
  const dir = tmp();
  const log = new RawLog(dir, { segmentBytes: 2000 });
  for (let i = 0; i < 100; i++) log.append({ k: 'chunk', sid: 's1', b64: Buffer.from(`chunk-${i}`).toString('base64') });
  await log.close();
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.ok(m.segments.length > 1, 'expected rotation');
  assert.equal(m.segments.reduce((a, s) => a + s.records, 0), 100);
  assert.equal(log.stats.droppedRecords, 0);
});

test('raw log drops under overflow and writes an explicit gap record (never silent)', async () => {
  const root = tmp();
  const s = Session.create(root, { site: 'test', rawOptions: { maxQueueBytes: 4000, writeDelayMs: 10_000 } });
  for (let i = 0; i < 200; i++) s.raw.append({ k: 'chunk', sid: `s${i % 3}`, b64: 'x'.repeat(100) });
  assert.ok(s.raw.stats.droppedRecords > 0);
  await s.raw.close();
  const recs = [];
  for await (const r of s.records()) recs.push(r);
  const gaps = recs.filter((r) => r.k === 'gap');
  assert.equal(gaps.length >= 1, true);
  assert.equal(gaps.reduce((a, g) => a + g.droppedRecords, 0), s.raw.stats.droppedRecords);
  const v = await s.verify();
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.droppedRecords, s.raw.stats.droppedRecords);
  assert.equal(listSessions(root).length, 1);
});

test('headers keep allowlisted values only; credentials dropped', () => {
  const h = redactHeaders({ 'Content-Type': 'text/event-stream', Cookie: 'a=b', Authorization: 'Bearer x', 'X-Custom-Thing': 'v' });
  assert.equal(h['Content-Type'], 'text/event-stream');
  assert.equal(h.Cookie, '[dropped]');
  assert.equal(h.Authorization, '[dropped]');
  assert.equal(h['X-Custom-Thing'], '[redacted]');
});

test('url credential params masked; sensitive endpoints detected', () => {
  assert.match(redactUrl('https://ex.com/a?access_token=abc&q=1'), /access_token=%5Bredacted%5D&q=1/);
  assert.equal(isSensitiveUrl('https://ex.com/api/auth/session'), true);
  assert.equal(isSensitiveUrl('https://ex.com/backend/conversation'), false);
});

test('body scrubber masks JWTs and credential fields in place, preserving length', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  const body = Buffer.from(`{"accessToken":"${jwt}","text":"hello","password":"hunter22"}`);
  const { bytes, redactions } = scrubSecrets(body);
  assert.equal(bytes.length, body.length);
  assert.ok(!bytes.toString().includes(jwt));
  assert.ok(!bytes.toString().includes('hunter22'));
  assert.ok(bytes.toString().includes('"text":"hello"'));
  assert.ok(redactions.length >= 2);
});

test('target picking and loopback enforcement', () => {
  const t = [{ id: 'AAA1', url: 'https://chatgpt.com/c/1', title: 'Chat' }, { id: 'BBB2', url: 'https://example.com', title: 'Ex' }];
  assert.equal(pickTarget(t, 'chatgpt').id, 'AAA1');
  assert.equal(pickTarget(t, 'BBB').id, 'BBB2');
  assert.equal(pickTarget(t, '1').id, 'BBB2');
  assert.throws(() => pickTarget(t));
  assert.throws(() => assertLoopbackUrl('ws://192.168.1.5:9222/devtools/browser/x'));
  assertLoopbackUrl('ws://127.0.0.1:9222/devtools/browser/x');
});

test('gaps spanning segment rotation and a gap pending at shutdown are both declared and verified', async () => {
  const root = tmp();
  const s = Session.create(root, { site: 'rot', rawOptions: { maxQueueBytes: 3000, writeDelayMs: 30, segmentBytes: 1500 } });
  // Several overflow episodes interleaved with drains, across many small segments.
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 80; i++) s.raw.append({ k: 'chunk', sid: `r${round}`, b64: 'y'.repeat(60) });
    await new Promise((r) => setTimeout(r, 120));
  }
  // Leave an overflow episode open at shutdown.
  for (let i = 0; i < 200; i++) s.raw.append({ k: 'chunk', sid: 'final', b64: 'z'.repeat(60) });
  assert.ok(s.raw.dropped, 'an overflow episode is still open at close');
  await s.raw.close();
  const v = await s.verify();
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(v.segments.length > 2, 'rotation happened');
  assert.ok(v.gapRecords >= 2);
  assert.equal(v.droppedRecords, s.raw.stats.droppedRecords, 'every dropped record is declared');
  assert.equal(v.records + v.droppedRecords, s.raw.seq, 'seq accounting: written + declared-dropped = issued');
  const recs = []; for await (const r of s.records()) recs.push(r);
  const lastGap = recs.filter((r) => r.k === 'gap').at(-1);
  assert.ok(lastGap.sids.includes('final'), 'shutdown gap names the affected stream');
});

test('verify flags an undeclared hole and a tampered segment', async () => {
  const root = tmp();
  const s = Session.create(root, { site: 'tamper' });
  for (let i = 0; i < 50; i++) s.raw.append({ k: 'chunk', sid: 's', b64: 'q' });
  await s.raw.close();
  const seg = path.join(s.dir, 'raw', '000001.jsonl');
  const lines = readFileSync(seg, 'utf8').split('\n');
  lines.splice(10, 1); // silently remove one record
  writeFileSync(seg, lines.join('\n'));
  const v = await s.verify();
  assert.equal(v.ok, false);
  assert.equal(v.unexplainedSeqGaps, 1);
  assert.equal(v.segments[0].shaMatches, false);
});
