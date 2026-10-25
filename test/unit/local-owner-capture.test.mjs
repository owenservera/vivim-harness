import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureMode, capturePrivacy } from '../../src/capture/privacy.mjs';
import { NetworkRecorder } from '../../src/capture/network.mjs';

const profile = (mode) => ({
  scope: { origins: ['same-site'], thirdParty: 'ignore' },
  capture: { privacyMode: mode, include: [], exclude: [], bodyResourceTypes: [],
    websockets: true, wsSentFrames: false, requestBodies: false, retrospectiveFallback: false },
});
const recorder = (mode) => {
  const events = [];
  const net = new NetworkRecorder({ append: (r) => { events.push(r); return events.length; },
    profile: profile(mode), getPageUrl: () => 'https://example.com/chat' });
  return { net, events };
};

test('local owner raw is the default; filtered remains opt-in and environment can override', () => {
  assert.equal(captureMode({}, {}), 'local-raw');
  assert.equal(captureMode(profile('filtered'), {}), 'filtered');
  assert.equal(captureMode(profile('filtered'), { CAPTURE_STUDIO_CAPTURE_MODE: 'local-raw' }), 'local-raw');
  assert.throws(() => captureMode({}, { CAPTURE_STUDIO_CAPTURE_MODE: 'bogus' }), /Invalid/);
  const raw = capturePrivacy(null, {});
  const sample = 'https://example.com/chat?access_token=synthetic';
  assert.equal(raw.url(sample), sample);
  assert.equal(raw.text('Bearer synthetic0123456789012345').text, 'Bearer synthetic0123456789012345');
  assert.equal(raw.headers({ Authorization: 'Bearer synthetic' }).Authorization, 'Bearer synthetic');
  const filtered = capturePrivacy(profile('filtered'), {});
  assert.notEqual(filtered.url(sample), sample);
  assert.equal(filtered.headers({ Authorization: 'Bearer synthetic' }).Authorization, '[dropped]');
});

test('local raw HTTP preserves auth endpoint, headers, request body, and chunks without delay', async () => {
  const { net, events } = recorder('local-raw');
  const url = 'https://example.com/api/auth/session?access_token=synthetic';
  const request = { url, method: 'POST', hasPostData: true,
    postData: '{"password":"synthetic-user-input"}', headers: { Authorization: 'Bearer synthetic0123456789012345' } };
  net._onRequest({}, 'p', { requestId: 'one', request, type: 'Fetch', timestamp: 1 }, {});
  const req = events.find((e) => e.k === 'req');
  assert.equal(req.url, url);
  assert.equal(req.headers.Authorization, request.headers.Authorization);
  assert.equal(req.postData, request.postData);
  assert.equal(req.policy, 'body');
  const st = net.reqs.get('p:one');
  st.armed = true;
  const raw = '{"password":"synthetic-secret-that-must-stay-local"}';
  for (let i = 0; i < raw.length; i += 3) net._chunk(st, Buffer.from(raw.slice(i, i + 3)), { ct: 2 });
  await net._finalize({}, st, { timestamp: 3 });
  const chunks = events.filter((e) => e.k === 'chunk');
  assert.equal(Buffer.concat(chunks.map((e) => Buffer.from(e.b64, 'base64'))).toString(), raw);
  assert.ok(chunks.every((e) => e.securityDelayed !== true));
  assert.equal(events.some((e) => e.k === 'body.excluded'), false);
});

test('local raw WebSocket and parsed EventSource views remain immediate and byte-faithful', () => {
  const { net, events } = recorder('local-raw');
  net.reqs.set('p:ws', { sid: 'p:ws', body: true, ws: true, frames: 0, bytes: 0 });
  net._onWsFrame('p', { requestId: 'ws', timestamp: 10,
    response: { opcode: 1, payloadData: '{"accessToken":"local-synthetic"}' } }, 'out');
  assert.equal(events.find((e) => e.k === 'ws.frame').payload, '{"accessToken":"local-synthetic"}');
  net.reqs.set('p:es', { sid: 'p:es', body: true, armed: true, chunks: 0, bytes: 0 });
  for (const part of ['"access', 'Token":"synthetic-local-secret"'])
    net._onEventSource('p', { requestId: 'es', timestamp: 11, eventName: 'message', data: part });
  assert.deepEqual(events.filter((e) => e.k === 'es.msg').map((e) => e.data),
    ['"access', 'Token":"synthetic-local-secret"']);
  assert.equal(events.some((e) => e.k === 'body.excluded'), false);
});

test('filtered mode retains sensitive-endpoint exclusion and the prewrite stream guard', () => {
  const { net, events } = recorder('filtered');
  const pol = net._policy('https://example.com/api/auth/session', 'Fetch', 'p');
  assert.equal(pol.body, false);
  const st = { sid: 'p:filtered', body: true, armed: true, bytes: 0, chunks: 0 };
  net.reqs.set(st.sid, st);
  const input = '{"password":"a-long-synthetic-secret"}';
  for (let i = 0; i < input.length; i += 3) net._chunk(st, Buffer.from(input.slice(i, i + 3)));
  assert.ok(events.some((e) => e.k === 'body.excluded' && e.securityGuard === 'stream-v1'));
  assert.equal(events.some((e) => e.k === 'chunk' && Buffer.from(e.b64, 'base64').toString().includes('synthetic-secret')), false);
});
