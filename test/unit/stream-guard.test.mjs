import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkCredentialGuard, FrameCredentialGuard } from '../../src/capture/stream-guard.mjs';
import { NetworkRecorder } from '../../src/capture/network.mjs';

const byteChunks = (s, step) => {
  const b = Buffer.from(s);
  const out = [];
  for (let i = 0; i < b.length; i += step) out.push(b.subarray(i, i + step));
  return out;
};
const materialize = (chunks) => Buffer.concat(chunks.filter((b) => b?.length)).toString('utf8');
const safeText = 'data: {"message":"This is safe conversation content."}\n'.repeat(12);

test('W4 chunk guard reproduces safe HTTP/SSE bytes with a bounded delayed tail', () => {
  for (const step of [1, 2, 5, 31, 128]) {
    const guard = new ChunkCredentialGuard();
    const saved = [];
    for (const part of byteChunks(safeText, step)) {
      const r = guard.push(part);
      assert.equal(r.excluded, false);
      saved.push(r.bytes);
    }
    saved.push(guard.finish().bytes);
    assert.equal(materialize(saved), safeText);
  }
});

test('W4 all split positions of JSON/password, bearer and JWT markers fail closed pre-append', () => {
  const examples = [
    { prefix: 'data: {"ok":1}\n', marker: '"password":"correct-horse-battery"'},
    { prefix: 'data: {"ok":1}\n', marker: '"accessToken":"synthetic-token-value"'},
    { prefix: 'data: {"ok":1}\n', marker: 'Bearer synthetic01234567890' },
    { prefix: 'data: {"ok":1}\n', marker: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.syntheticpart' },
    { prefix: 'data: {"ok":1}\n', marker: 'sk-proj-synthetic-not-a-real-key' },
  ];
  for (const { prefix, marker } of examples) {
    const body = prefix + marker + '\nend';
    for (const step of [1, 2, 3, 7, 64, body.length]) {
      const guard = new ChunkCredentialGuard();
      const recorded = [];
      let excluded = false;
      for (const bytes of byteChunks(body, step)) {
        const r = guard.push(bytes);
        recorded.push(r.bytes);
        excluded ||= r.excluded;
      }
      const end = guard.finish();
      recorded.push(end.bytes);
      excluded ||= end.excluded;
      assert.equal(excluded, true, 'marker not excluded for chunk step=' + step);
      const out = materialize(recorded);
      assert.equal(out.includes(marker), false);
      assert.equal(out.includes('correct-horse-battery'), false);
      assert.equal(out.includes('synthetic-token-value'), false);
      assert.equal(out.includes('synthetic01234567890'), false);
    }
  }
});

test('W4 giant chunk fails closed rather than bypassing the bounded scanner', () => {
  const guard = new ChunkCredentialGuard({ maxBufferedBytes: 32 });
  const r = guard.push(Buffer.from('x'.repeat(40)));
  assert.equal(r.excluded, true);
  assert.equal(r.reason, 'security_scan_limit');
  assert.equal(guard.finish().bytes.length, 0);
});

test('W4 WS frame guard preserves safe frame order while withholding cross-frame candidates', () => {
  const g = new FrameCredentialGuard();
  const frames = [];
  const safe = ['safe-one-'.repeat(30), 'safe-two-'.repeat(30), 'safe-three-'.repeat(30)];
  for (const [i, payload] of safe.entries()) {
    const r = g.push({ order: i, payload }, Buffer.from(payload));
    assert.equal(r.excluded, false);
    frames.push(...r.frames);
  }
  frames.push(...g.finish().frames);
  assert.deepEqual(frames.map((x) => x.order), [0, 1, 2]);
  const h = new FrameCredentialGuard();
  const queued = [];
  const pieces = ['prefix '.repeat(10), '"pass', 'word"', ':', '"synthetic-long-password"'];
  for (const [i, payload] of pieces.entries()) {
    const r = h.push({ order: i, payload }, Buffer.from(payload));
    queued.push(...r.frames);
    if (r.excluded) break;
  }
  assert.equal(h.excluded, true);
  assert.equal(queued.join('').includes('synthetic-long-password'), false);
  assert.equal(h.finish().frames.length, 0);
});

test('W4 recorder HTTP raw append never contains split credentials and declares loss', async () => {
  const records = [];
  const recorder = new NetworkRecorder({ append: (r) => records.push(r),
    profile: { capture: { privacyMode: 'filtered', retrospectiveFallback: false } },
    getPageUrl: () => 'https://example.com' });
  const st = { sid: 'p:req1', armed: true, body: true, chunks: 0, bytes: 0 };
  recorder.reqs.set(st.sid, st);
  for (const part of byteChunks('hello-safe-content\n'.repeat(20) + '"accessToken":"synthetic-super-secret"', 2))
    recorder._chunk(st, part, { ct: 100 });
  await recorder._finalize({}, st, { timestamp: 110 });
  const raw = records.map((r) => JSON.stringify(r)).join('\n');
  assert.equal(raw.includes('synthetic-super-secret'), false);
  assert.ok(records.some((r) => r.k === 'body.excluded' && r.reason === 'credential_candidate'));
  assert.ok(records.some((r) => r.k === 'done'));
  assert.equal(records.some((r) => r.k === 'chunk' && Buffer.from(r.b64, 'base64').toString().includes('synthetic-super-secret')), false);
});

test('W4 recorder WS frame body remains metadata-only after split secret prefix', () => {
  const records = [];
  const recorder = new NetworkRecorder({ append: (r) => records.push(r),
    profile: { capture: { privacyMode: 'filtered', wsSentFrames: false } },
    getPageUrl: () => 'https://example.com' });
  const st = { sid: 'p:ws1', body: true, ws: true, frames: 0, bytes: 0 };
  recorder.reqs.set(st.sid, st);
  for (const payload of ['safe '.repeat(30), '"access', 'Token"', ':"abc-synthetic-secret"', 'after'])
    recorder._onWsFrame('p', { requestId: 'ws1', timestamp: 9, response: { opcode: 1, payloadData: payload } }, 'in');
  assert.ok(records.some((r) => r.k === 'body.excluded' && r.securityGuard === 'ws-frames-v1'));
  assert.equal(records.some((r) => r.k === 'ws.frame' && r.payload.includes('abc-synthetic-secret')), false);
  assert.ok(records.some((r) => r.k === 'ws.frame_meta' && r.policy === 'metadata_only:credential_guard'));
});

test('W4 no secret tail on interrupted or detached HTTP response', () => {
  const records = [];
  const recorder = new NetworkRecorder({ append: (r) => records.push(r),
    profile: { capture: { privacyMode: 'filtered' } }, getPageUrl: () => 'https://example.com' });
  const st = { sid: 'p:r', body: true, armed: true, bytes: 0, chunks: 0 };
  recorder.reqs.set(st.sid, st);
  recorder._chunk(st, Buffer.from('an unfinished response under the scanner tail'));
  recorder._onFailed('p', { requestId: 'r', timestamp: 1, errorText: 'aborted' });
  assert.equal(records.some((r) => r.k === 'chunk'), false);
  assert.ok(records.some((r) => r.k === 'body.excluded' && r.reason === 'security_tail_unfinished_failure'));
});

test('W4 parsed EventSource views also exclude split credential values', async () => {
  const records = [];
  const recorder = new NetworkRecorder({ append: (r) => records.push(r),
    profile: { capture: { privacyMode: 'filtered', retrospectiveFallback: false } },
    getPageUrl: () => 'https://example.com' });
  const st = { sid: 'p:es', body: true, armed: true, chunks: 0, bytes: 0 };
  recorder.reqs.set(st.sid, st);
  for (const data of ['safe '.repeat(50), '"refresh', 'Token"', ':', '"synthetic-eventsource-secret"', 'after'])
    recorder._onEventSource('p', { requestId: 'es', timestamp: 9, eventName: 'message', data });
  await recorder._finalize({}, st, { timestamp: 11 });
  assert.equal(records.some((r) => r.k === 'es.msg' && r.data.includes('synthetic-eventsource-secret')), false);
  assert.ok(records.some((r) => r.k === 'body.excluded' && r.securityGuard === 'eventsource-v1'));
  assert.equal(st.credentialExcluded, true);
});

test('W4 local-raw passthrough: guard is bypassed by design and raw bytes are written unmodified', async () => {
  // Owner decision: default capture mode is local-raw; credential stream guards are intentionally bypassed.
  // privacyMode is deliberately NOT set here, so the default (local-raw) applies. Env var is not used.
  const records = [];
  const recorder = new NetworkRecorder({ append: (r) => records.push(r),
    profile: { capture: { retrospectiveFallback: false } },
    getPageUrl: () => 'https://example.com' });
  assert.equal(recorder.privacy.localRaw, true);
  const marker = '"accessToken":"synthetic-passthrough-secret"';
  const st = { sid: 'p:raw', body: true, armed: true, chunks: 0, bytes: 0 };
  recorder.reqs.set(st.sid, st);
  for (const part of byteChunks('hello-safe-content\n' + marker, 2))
    recorder._chunk(st, part, { ct: 100 });
  await recorder._finalize({}, st, { timestamp: 110 });
  const raw = Buffer.concat(records.filter((r) => r.k === 'chunk').map((r) => Buffer.from(r.b64, 'base64'))).toString('utf8');
  assert.ok(raw.includes(marker));
  assert.equal(records.some((r) => r.k === 'body.excluded'), false);
  assert.equal(st.credentialExcluded, undefined);
});

test('W4 bounded frame memory excludes a flood of empty frames', () => {
  const g = new FrameCredentialGuard({ maxPendingFrames: 3 });
  for (let i = 0; i < 3; i++) assert.equal(g.push({ i }, Buffer.alloc(0)).excluded, false);
  const rejected = g.push({ i: 3 }, Buffer.alloc(0));
  assert.equal(rejected.excluded, true);
  assert.equal(rejected.reason, 'security_scan_limit');
  assert.equal(rejected.dropped.length, 4);
});
