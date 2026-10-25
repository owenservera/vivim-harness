import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDriveApi, driveVerdict } from '../../src/studio/drive-api.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { defaultPrompt, expectedWords } from '../../src/capture/campaign.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function directory(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'drive-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function harness(t, options = {}) {
  const dataDir = directory(t), api = createDriveApi({ dataDir, ...options });
  t.after(() => api.close());
  async function request(route = 'jobs', method = 'GET', body = {}) {
    const result = { headers: {} };
    const res = { setHeader: (k, v) => { result.headers[k] = v; }, writeHead: (status, headers) => { result.status = status; Object.assign(result.headers, headers); }, end: (text) => { result.body = JSON.parse(text); } };
    try { result.handled = await api.handle({ method }, res, new URL(`http://localhost/api/v1/drive/${route}`), body); }
    catch (e) { result.status = e.status; result.body = { error: e.message, code: e.code }; }
    return result;
  }
  return { dataDir, api, request };
}
async function completed(request, id) {
  for (let n = 0; n < 100; n++) {
    const job = (await request(`jobs/${id}`)).body.job;
    if (!['queued', 'running'].includes(job.state)) return job;
    await delay(5);
  }
  assert.fail('Fixture job did not finish');
}

test('sites exposes default prompt and historical compatibility is display-only, not capture acceptance', async (t) => {
  const { dataDir, request } = harness(t);
  writeFileSync(path.join(dataDir, 'campaign-state.json'), JSON.stringify({ sites: { chatgpt: { status: 'failed', reason: 'the reply contains all 12 expected words in order' } } }));
  const result = await request('sites');
  assert.equal(result.body.defaultPrompt, defaultPrompt);
  assert.match(result.body.verdictMeaning, /capture acceptance is not checked/);
  const last = result.body.sites.find((s) => s.id === 'chatgpt').last;
  assert.equal(last.status, 'verified'); assert.equal(last.reason, 'Reply matched, capture not checked');
  assert.equal(driveVerdict({ ok: false, status: 'failed', reason: 'the reply contains all 12 expected words in order' }), 'failed');
  assert.equal(driveVerdict({ ok: true, reply: expectedWords.join(' ') }, defaultPrompt), 'verified');
});

test('default dry-run for drive and campaign never invokes browser or campaign execution', async (t) => {
  let calls = 0;
  const { request } = harness(t, { drive: async () => { calls++; throw new Error('No browser allowed'); }, campaign: async () => { calls++; throw new Error('No execution allowed'); } });
  for (const mode of ['drive', 'campaign']) {
    const created = await request('jobs', 'POST', { mode, sites: ['chatgpt'] });
    assert.equal(created.status, 202); assert.equal(created.body.job.dryRun, true);
    const job = await completed(request, created.body.job.id);
    assert.equal(job.state, 'done'); assert.equal(job.progress[0].verdict, null);
  }
  assert.equal(calls, 0);
});

test('live execution requires explicit boolean confirmation', async (t) => {
  let calls = 0;
  const { request } = harness(t, { drive: async () => { calls++; } });
  for (const confirm of [undefined, false, 'true']) {
    assert.equal((await request('jobs', 'POST', { mode: 'drive', sites: ['chatgpt'], dryRun: false, confirm })).status, 400);
  }
  assert.equal(calls, 0);
});

test('deferred current driver retains concurrency lock until cleanup, with no active abort signal', async (t) => {
  const started = deferred(), cleanup = deferred(); let calls = 0;
  t.after(() => cleanup.resolve());
  const { request } = harness(t, { drive: async (args) => {
    calls++; assert.equal(args.signal, undefined); started.resolve(); await cleanup.promise;
    return { ok: true, reply: 'local fixture reply' };
  } });
  const body = { mode: 'drive', sites: ['chatgpt'], dryRun: false, confirm: true };
  const created = await request('jobs', 'POST', body), id = created.body.job.id;
  await started.promise;
  assert.equal((await request('jobs', 'POST', body)).status, 409);
  const cancelled = await request(`jobs/${id}/cancel`, 'POST');
  assert.equal(cancelled.body.job.state, 'running');
  assert.equal(cancelled.body.job.cancellationMode, 'after-current-site');
  const conflict = await request('jobs', 'POST', body);
  assert.equal(conflict.status, 409); assert.equal(conflict.body.activeJobId, id);
  cleanup.resolve(); assert.equal((await completed(request, id)).state, 'cancelled');
  assert.equal(calls, 1);
  const next = await request('jobs', 'POST', { mode: 'drive', sites: ['chatgpt'] });
  assert.equal(next.status, 202); await completed(request, next.body.job.id);
});

test('a browser lease held by a Chat conversation is named in the job error, not flattened', async (t) => {
  const { request } = harness(t, { drive: async () => { throw Object.assign(new Error('busy'), { code: 'DRIVE_LEASE_BUSY', holder: { kind: 'conversation', id: 'c1' } }); } });
  const created = await request('jobs', 'POST', { mode: 'drive', sites: ['chatgpt'], dryRun: false, confirm: true });
  assert.equal(created.status, 202);
  const job = await completed(request, created.body.job.id);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /Chat conversation/, 'says who holds the browser');
  assert.match(job.error, /Nothing was sent/);
  assert.doesNotMatch(job.error, /no automatic retry was attempted/, 'the generic text is not used for a known conflict');
});

test('campaign cancellation finishes current site then skips remaining sites without resend', async (t) => {
  const started = deferred(), cleanup = deferred(), sites = [];
  t.after(() => cleanup.resolve());
  const { request } = harness(t, {
    drive: async (args) => { assert.equal(args.signal, undefined); started.resolve(); await cleanup.promise; return { ok: true, reply: 'fixture' }; },
    campaign: async (options) => { sites.push(...options.sites); const result = await options.drive({ prompt: options.prompt }); return { sites: [result] }; },
  });
  const created = await request('jobs', 'POST', { mode: 'campaign', sites: ['chatgpt', 'claude'], dryRun: false, confirm: true, cooldown: 0 });
  const id = created.body.job.id; await started.promise;
  await request(`jobs/${id}/cancel`, 'POST');
  assert.equal((await request('jobs', 'POST', { mode: 'drive', sites: ['chatgpt'] })).status, 409);
  cleanup.resolve(); const job = await completed(request, id);
  assert.equal(job.state, 'cancelled'); assert.equal(job.progress[0].state, 'done'); assert.equal(job.progress[1].state, 'skipped');
  assert.deepEqual(sites, ['chatgpt']);
});

test('restart marks interrupted history cancelled and never invokes a driver', async (t) => {
  const dataDir = directory(t); let calls = 0;
  writeFileSync(path.join(dataDir, 'drive-jobs.json'), JSON.stringify([{ id: 'interrupted', state: 'running', progress: [{ state: 'running' }, { state: 'pending' }] }]));
  const api = createDriveApi({ dataDir, drive: async () => { calls++; } }); t.after(() => api.close());
  let result;
  await api.handle({ method: 'GET' }, { writeHead() {}, end: (text) => { result = JSON.parse(text); } }, new URL('http://localhost/api/v1/drive/jobs'));
  assert.equal(result.jobs[0].state, 'cancelled');
  assert.ok(result.jobs[0].progress.every((p) => p.state === 'skipped'));
  assert.match(result.jobs[0].error, /never retried/); await delay(10); assert.equal(calls, 0);
});

test('job metadata omits prompt, reply and raw events, including echoes in reason', async (t) => {
  const prompt = 'PRIVATE-PROMPT-fixture', reply = 'PRIVATE-REPLY-fixture';
  const { request, dataDir } = harness(t, { drive: async () => ({ ok: true, prompt, reply, reason: `reason ${prompt} ${reply}`, events: [{ secret: 'PRIVATE-EVENT-fixture' }] }) });
  const created = await request('jobs', 'POST', { mode: 'drive', sites: ['chatgpt'], prompt, dryRun: false, confirm: true });
  const job = await completed(request, created.body.job.id);
  assert.equal(job.progress[0].replyChars, reply.length); assert.equal(job.progress[0].verdict, 'unverified');
  const stored = readFileSync(path.join(dataDir, 'drive-jobs.json'), 'utf8');
  for (const secret of [prompt, reply, 'PRIVATE-EVENT-fixture']) {
    assert.equal(stored.includes(secret), false); assert.equal(JSON.stringify(job).includes(secret), false);
  }
  assert.equal(Object.hasOwn(job, 'prompt'), false); assert.equal(Object.hasOwn(job.progress[0], 'reply'), false);
});

test('failed live result mentioning all words is not upgraded', async (t) => {
  const { request } = harness(t, { drive: async () => ({ ok: false, status: 'failed', reason: 'all 12 expected words in order' }) });
  const created = await request('jobs', 'POST', { mode: 'drive', sites: ['chatgpt'], dryRun: false, confirm: true });
  const job = await completed(request, created.body.job.id);
  assert.equal(job.state, 'failed'); assert.equal(job.progress[0].verdict, 'failed');
});

test('unsupported methods return 405 and Allow', async (t) => {
  const { request } = harness(t);
  for (const [route, method, allow] of [['sites', 'POST', 'GET'], ['jobs', 'DELETE', 'GET, POST'], ['jobs/missing', 'POST', 'GET'], ['jobs/missing/cancel', 'GET', 'POST']]) {
    const result = await request(route, method); assert.equal(result.status, 405); assert.equal(result.headers.allow, allow);
  }
});

test('Studio applies authentication before injected drive routing', async (t) => {
  const paths = dataPaths(directory(t)); ensureDataDirs(paths); let calls = 0;
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, token: 'drive-test-token',
    conversationRuntime: { isSessionActive: () => false, close: async () => {} }, drive: async () => { calls++; return { ok: false }; } });
  t.after(() => studio.close());
  const url = `http://127.0.0.1:${studio.port}/api/v1/drive/jobs`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { 'x-studio-token': studio.token } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { jobs: [] }); assert.equal(calls, 0);
});

test('local owner can drive HTTP loopback fixtures and query-bearing URLs', async (t) => {
  const calls = [];
  const { request } = harness(t, { drive: async (options) => {
    calls.push(options);
    return { ok: true, status: 'ok', reply: 'synthetic local fixture', reason: 'mock only' };
  } });
  const local = 'http://127.0.0.1:8943/fixture?mode=fast&case=one';
  const created = await request('jobs', 'POST', {
    mode: 'drive', sites: [local], dryRun: false, confirm: true, prompt: 'test only',
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  await completed(request, created.body.job.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].adapter.url, local);
  const denied = await request('jobs', 'POST', {
    mode: 'drive', sites: ['http://example.org/private'], dryRun: false, confirm: true,
  });
  assert.equal(denied.status, 400);
});
