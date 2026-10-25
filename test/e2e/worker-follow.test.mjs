// Real Chrome only, synthetic loopback data; never the owner's browser/CDP port/profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startSite } from '../fixtures/site.mjs';
import { hasChrome, launchHeadless, userDriver, waitFor } from './helpers.mjs';
import { Recorder } from '../../src/capture/recorder.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.notEqual(port, 9222);
  return port;
}

test('follow=true releases a newly created dedicated worker promptly and captures its first fetch', { skip: !hasChrome && 'set CHROME_PATH', timeout: 45000 }, async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cs-worker-follow-'));
  let site, chrome, user, recorder;
  t.after(async () => {
    try { if (recorder?.state === 'recording') await recorder.stop({ reason: 'worker-test-cleanup' }); }
    finally {
      user?.close(); chrome?.kill();
      site?.server.closeAllConnections();
      if (site) await new Promise((resolve) => site.server.close(resolve));
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  site = await startSite();
  const port = await unusedPort();
  chrome = await launchHeadless(`${site.url}article`, port);
  user = await userDriver(port, '/article');
  assert.equal(await waitFor(async () => await user.eval('document.readyState === "complete"')), true);
  recorder = new Recorder({ sessionsDir: path.join(dataDir, 'sessions'), profileStore: new ProfileStore(path.join(dataDir, 'profiles')),
    port, follow: true, reconnect: false, heartbeatMs: 0 });
  const lifecycle = [], warnings = [];
  recorder.on('record', (record) => { if (record.k === 'lifecycle') lifecycle.push({ event: record.event, targetType: record.targetType }); });
  recorder.on('warn', (e) => warnings.push(String(e?.message ?? e)));
  const session = await recorder.start({ target: user.targetId, label: 'worker-follow-regression' });
  assert.equal(recorder.pauseNewTargets, true);
  const started = performance.now();
  await user.eval(`globalThis.workerResult = null;
    globalThis.fixtureWorker = new Worker('/follow-worker.js');
    fixtureWorker.onmessage = event => { globalThis.workerResult = {value:event.data,elapsedMs:performance.now()-globalThis.workerStarted}; };
    globalThis.workerStarted = performance.now();`);
  const received = await waitFor(async () => await user.eval('globalThis.workerResult !== null'), 3000);
  const elapsedMs = performance.now() - started;
  const result = await user.eval('globalThis.workerResult');
  const stopped = await recorder.stop({ reason: 'worker-follow-test' });
  const saved = Session.open(path.join(dataDir, 'sessions'), session.id);
  const requests = [];
  for await (const record of saved.records()) if (record.k === 'req' && record.url?.includes('/api/worker-follow')) requests.push(record);
  t.diagnostic(JSON.stringify({ port, receivedWithin3s: received, elapsedMs: Math.round(elapsedMs), workerElapsedMs: result?.elapsedMs ?? null,
    rawWorkerRequests: requests.length, requestTargets: requests.map((r) => r.target), lifecycle, warnings, integrity: stopped?.verify?.ok }));
  assert.equal(received, true, `Worker did not return within 3000 ms (observed ${Math.round(elapsedMs)} ms)`);
  assert.deepEqual(result.value, { ok: true, source: 'dedicated-worker-first-fetch' });
  assert.ok(result.elapsedMs <= 3000, `Worker took ${Math.round(result.elapsedMs)} ms`);
  assert.ok(requests.some((r) => r.target === 'worker' && r.sid && !r.sid.startsWith('p:')), 'First worker fetch must be persisted from a worker session, not fabricated as primary-page traffic');
  assert.equal(stopped.verify.ok, true);
});
