// End-to-end: real Chromium + synthetic site. Run with CHROME_PATH=/path/to/chrome npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSite } from '../fixtures/site.mjs';
import { hasChrome, launchHeadless, userDriver, sleep, waitFor } from './helpers.mjs';
import { Recorder } from '../../src/capture/recorder.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';
import { derive, streamBytes } from '../../src/replay/derive.mjs';

const PORT = 9400 + Math.floor(Math.random() * 400);
let site, chrome, dataDir, profiles;
const fixtureSockets = new Set();

before(async () => {
  if (!hasChrome) return;
  site = await startSite();
  site.server.on('upgrade', (_req, socket) => {
    fixtureSockets.add(socket);
    socket.once('close', () => fixtureSockets.delete(socket));
  });
  chrome = await launchHeadless(site.url, PORT);
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-'));
  profiles = new ProfileStore(path.join(dataDir, 'profiles'));
  for (const mode of ['filtered', 'local-raw']) {
    const generic = profiles.load('generic');
    profiles.save('fixture-' + mode, { ...generic, name: 'fixture-' + mode,
      capture: { ...generic.capture, privacyMode: mode } }, 'explicit synthetic test capture policy');
  }
});
after(() => { chrome?.kill(); site?.server.close(); });

function allFiles(dir) { return readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? allFiles(p) : [p]; }); }

test('records L1 raw stream, L2 events, L3 DOM and actions from a live tab', { skip: !hasChrome && 'set CHROME_PATH' }, async () => {
  const user = await userDriver(PORT, '127.0.0.1');
  await waitFor(async () => (await user.eval('document.readyState')) === 'complete');
  const rec = new Recorder({ sessionsDir: path.join(dataDir, 'sessions'), profileStore: profiles, port: PORT });
  const session = await rec.start({ target: user.targetId, profile: 'fixture-filtered' });
  // The person reloads the page and asks a question.
  await user.reload();
  await waitFor(async () => (await user.eval('!!document.getElementById("ask") && !!window.ws && window.ws.readyState === 1')));
  await sleep(300);
  await user.eval('document.getElementById("ask").click()');
  await waitFor(async () => (await user.eval('document.querySelector("#thread p")?.textContent || ""')).includes('correlate'));
  await sleep(600);
  // Filtered frame guards release their final tail only after confirmed socket closure.
  await user.eval('window.ws.close()');
  // This fixture does not implement the WebSocket close handshake; end only its owned sockets.
  for (const socket of fixtureSockets) socket.end();
  await sleep(100);
  const snap = await rec.snapshotDom();
  assert.ok(snap.bytes > 500);
  const shapesLive = await rec.inspectDom();
  assert.ok(shapesLive.proposals.some((p) => p.kind === 'collection' && p.count === 6), 'DOM collection of 6 items');
  const result = await rec.stop();
  user.close();

  assert.equal(result.verify.ok, true, JSON.stringify(result.verify));
  const s = Session.open(path.join(dataDir, 'sessions'), session.id);
  const d = await derive(s, profiles.load('generic'));
  const streams = d.summary.streams;
  const conv = streams.find((x) => x.url?.includes('/api/conversation'));
  assert.ok(conv, 'conversation stream captured');
  assert.equal(conv.transport, 'HTTP_SSE');
  if (conv.armed === 'stream') assert.ok(conv.chunks > 0, 'armed capture contains bytes');
  else {
    assert.ok(conv.armError, 'unarmed capture reports its arming error');
    assert.equal(conv.retrospective, true, 'short completed response recovered by explicit body fallback');
  }
  assert.ok(conv.deltaRevisions >= 6, 'delta assembled');
  const assembled = s.kv.get('ASSEMBLED')[conv.sid];
  assert.equal(assembled.doc.message.content.parts[0], 'Hello from the fixture stream. This sentence is long enough to correlate with the DOM.');
  assert.equal(assembled.doc.message.status, 'finished_successfully');
  const raw = await streamBytes(s, conv.sid);
  const expected = Buffer.from(await (await fetch(site.url + 'api/conversation', { method: 'POST' })).arrayBuffer());
  assert.deepEqual(raw.bytes, expected, 'entire deterministic fixture response preserved, including SSE framing');
  assert.ok(raw.bytes.toString().includes('data: [DONE]'), 'raw SSE framing preserved byte-for-byte');
  assert.ok(raw.bytes.toString().includes(': keep-alive comment'), 'comments kept');

  const es = streams.find((x) => x.url?.includes('/api/events'));
  assert.ok(es && es.esMessages === 3, `EventSource parsed view (${es?.esMessages})`);
  const ws = streams.find((x) => x.kind === 'ws');
  assert.ok(ws && ws.frames >= 3, 'websocket frames');
  const feed = streams.find((x) => x.url?.includes('/api/feed'));
  assert.equal(feed.decoder, 'ndjson');
  assert.equal(feed.events, 4);

  const auth = streams.find((x) => x.url?.includes('/api/auth/session'));
  assert.equal(auth.bodyExcluded, 'credential_policy');
  // Credentials never reach disk.
  const blob = allFiles(s.dir).map((f) => readFileSync(f).toString('latin1')).join('\n');
  for (const secret of ['SECRET-COOKIE', 'SECRET-REQUEST-TOKEN', 'eyJzdWIiOiJ1c2VyIn0', 'eyJzdWIiOiJ3cyJ9']) assert.ok(!blob.includes(secret), `leaked ${secret}`);

  const kinds = new Set(d.report.suggestions.map((x) => x.kind));
  for (const k of ['stream_endpoint', 'delta_stream', 'collection', 'beacon_exclusion', 'correlation', 'action_effect', 'timestamp_field', 'identity_field']) assert.ok(kinds.has(k), `suggestion ${k}: got ${[...kinds]}`);
  const armedWithData = streams.some((stream) => stream.armed === 'stream' && stream.bytes > 0);
  assert.equal(d.receipt.verdict, armedWithData ? 'A1_RAW_CAPTURE_VIABLE' : 'A1_UNAVAILABLE');
  if (armedWithData) assert.equal(d.receipt.cdp_stream_resource_content, 'SUPPORTED_AND_DATA');
  else assert.notEqual(d.receipt.cdp_stream_resource_content, 'SUPPORTED_AND_DATA', 'fallback is not incremental CDP proof');
});

test('forced short-stream arm refusal recovers exact browser-received body in local-raw mode', { skip: !hasChrome && 'set CHROME_PATH' }, async (t) => {
  const user = await userDriver(PORT, '127.0.0.1');
  t.after(() => user.close());
  const rec = new Recorder({ sessionsDir: path.join(dataDir, 'sessions'), profileStore: profiles, port: PORT });
  const session = await rec.start({ target: user.targetId, profile: 'fixture-local-raw', label: 'forced-fallback' });
  t.after(async () => { if (rec.state === 'recording') await rec.stop(); });
  // Only refuse arming; the request, completed body read and persisted bytes use real Chrome/CDP.
  rec.net._armStream = async () => { throw new Error('synthetic forced short-stream arm refusal'); };
  const browserText = await user.eval(`fetch('/api/conversation', { method: 'POST', body: 'local-raw-fallback-payload' }).then(r => r.text())`);
  await sleep(300);
  const result = await rec.stop();
  assert.equal(result.verify.ok, true);
  const s = Session.open(path.join(dataDir, 'sessions'), session.id);
  const d = await derive(s, profiles.load('fixture-local-raw'));
  const conv = d.summary.streams.find((stream) => stream.url?.endsWith('/api/conversation'));
  assert.ok(conv);
  assert.match(conv.armError, /synthetic forced/);
  assert.equal(conv.armed, undefined);
  assert.equal(conv.retrospective, true);
  assert.equal(conv.status, 'complete');
  assert.deepEqual((await streamBytes(s, conv.sid)).bytes, Buffer.from(browserText));
  const records = [];
  for await (const record of s.records()) if (record.sid === conv.sid) records.push(record);
  assert.equal(records.filter((record) => record.k === 'body').length, 1, 'one fallback body, not duplicate recovery');
  assert.equal(records.find((record) => record.k === 'body').captureMode, 'local-raw');
  assert.equal(records.find((record) => record.k === 'req').postData, 'local-raw-fallback-payload');
  assert.equal(records.some((record) => ['body.unavailable', 'body.truncated', 'body.excluded'].includes(record.k)), false);
  assert.equal(s.kv.get('ASSEMBLED')[conv.sid].doc.message.content.parts[0], 'Hello from the fixture stream. This sentence is long enough to correlate with the DOM.');
});

test('long response fully retained on a normal disk', { skip: !hasChrome && 'set CHROME_PATH' }, async () => {
  const user = await userDriver(PORT, '127.0.0.1');
  const rec = new Recorder({ sessionsDir: path.join(dataDir, 'sessions'), profileStore: profiles, port: PORT });
  const session = await rec.start({ target: user.targetId, label: 'long' });
  await user.eval('document.getElementById("ask-long").click()');
  await waitFor(async () => (await user.eval('[...document.querySelectorAll("#thread p")].pop()?.textContent || ""')).includes('word399'), 15000);
  // Browser rendering and this separate CDP client can get ahead of Recorder's event backlog.
  assert.ok(await waitFor(() => rec.reducer.summary().streams.some((stream) => stream.url?.includes('long=1') && stream.status === 'complete'), 15000),
    'recorder observed the long response terminal event before the complete-response assertion');
  const result = await rec.stop();
  user.close();
  assert.equal(result.verify.ok, true);
  assert.equal(result.verify.droppedRecords, 0);
  const s = Session.open(path.join(dataDir, 'sessions'), session.id);
  const d = await derive(s, profiles.load('generic'));
  const conv = d.summary.streams.find((x) => x.url?.includes('long=1'));
  const text = s.kv.get('ASSEMBLED')[conv.sid].doc.message.content.parts[0];
  assert.equal(text.trim().split(' ').length, 400);
  assert.ok(text.includes('word0 ') && text.includes('word399'));
  assert.equal(conv.status, 'complete');
});

test('slow disk produces explicit gaps, not silent loss', { skip: !hasChrome && 'set CHROME_PATH' }, async () => {
  const user = await userDriver(PORT, '127.0.0.1');
  const rec = new Recorder({ sessionsDir: path.join(dataDir, 'sessions'), profileStore: profiles, port: PORT, rawOptions: { maxQueueBytes: 8 * 1024, writeDelayMs: 1500 } });
  const session = await rec.start({ target: user.targetId, label: 'slowdisk' });
  await user.eval('document.getElementById("ask-long").click()');
  await waitFor(async () => (await user.eval('document.querySelectorAll("#thread p")[document.querySelectorAll("#thread p").length-1]?.textContent || ""')).includes('word399'), 15000);
  await sleep(300);
  const result = await rec.stop();
  user.close();
  assert.equal(result.verify.ok, true);
  const s = Session.open(path.join(dataDir, 'sessions'), session.id);
  const d = await derive(s, profiles.load('generic'));
  assert.ok(d.summary.gaps >= 1, 'gap recorded');
  assert.ok(result.verify.droppedRecords > 0);
  assert.equal(d.receipt.verdict, 'A1_PARTIAL');
  const conv = d.summary.streams.find((x) => x.url?.includes('long=1'));
  assert.ok(conv.gaps >= 1 || d.report.suggestions.some((x) => x.kind === 'coverage_gap'));
});

test('stream in flight before attach is honestly reported as unobserved', { skip: !hasChrome && 'set CHROME_PATH' }, async () => {
  const user = await userDriver(PORT, '127.0.0.1');
  await user.eval('document.getElementById("ask-long").click()');
  await sleep(150);
  const rec = new Recorder({ sessionsDir: path.join(dataDir, 'sessions'), profileStore: profiles, port: PORT });
  const session = await rec.start({ target: user.targetId, label: 'lateattach' });
  await sleep(1500);
  await rec.stop();
  user.close();
  const s = Session.open(path.join(dataDir, 'sessions'), session.id);
  const d = await derive(s, profiles.load('generic'));
  assert.equal(d.summary.streams.filter((x) => x.url?.includes('long=1')).length, 0, 'no fabricated stream');
  const start = (await s.dataset('timeline').toArray()).find((e) => e.k === 'run.start');
  assert.ok(start);
});
