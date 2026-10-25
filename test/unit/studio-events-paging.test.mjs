import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';

// Fixture: a studio over a temp data dir, plus sessions seeded through the real Session store.
async function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'studio-events-paging-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const runtime = {
    isSessionActive: () => false, close: async () => {},
    targets: async () => ({ sites: [], targets: [] }), list: async () => [],
  };
  const studio = await startStudio({
    paths, profileStore: new ProfileStore(paths.profiles), conversationRuntime: runtime,
    port: 0, ...overrides,
  });
  t.after(async () => { await studio.close(); rmSync(root, { recursive: true, force: true }); });
  return { studio, paths };
}
const base = (studio) => 'http://127.0.0.1:' + studio.port;

function seed(paths, events) {
  const s = Session.create(paths.sessions, { site: 'paging-test' });
  s.dataset('events').push(events);
  s.flushDatasets();
  return s.id;
}

async function get(studio, route, headers = {}) {
  const response = await fetch(base(studio) + route, { headers });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text.startsWith('[') || text.startsWith('{') ? JSON.parse(text) : text };
}

// Follow X-Next-After until it is absent; returns every seq plus the page sizes.
async function pageAll(studio, id, sid, extraQuery = '') {
  const seqs = [], sizes = [];
  let after = null;
  for (let i = 0; i < 100; i++) {
    const params = [extraQuery, after === null ? '' : `after=${after}`].filter(Boolean).join('&');
    const r = await get(studio, `/api/sessions/${id}/events/${sid}${params ? '?' + params : ''}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body), 'page body must stay a JSON array');
    sizes.push(r.body.length);
    for (const e of r.body) seqs.push(e.seq);
    const next = r.headers.get('x-next-after');
    if (next === null) return { seqs, sizes, last: r };
    assert.ok(r.body.length > 0, 'a page that announces more events must not be empty');
    after = next;
  }
  throw new Error('paging did not finish within 100 pages');
}

test('a 2500-event stream pages fully via after/X-Next-After with no gaps or duplicates', async (t) => {
  const { studio, paths } = await fixture(t, { accessMode: 'local' });
  // Interleave a second stream so the sid filter is exercised: stream A gets odd seq values.
  const events = [];
  for (let seq = 1; seq <= 5000; seq++) events.push({ sid: seq % 2 ? 'A' : 'B', seq, t: seq, k: 'ws.frame' });
  const id = seed(paths, events);
  const expected = Array.from({ length: 2500 }, (_, i) => 2 * i + 1);

  const { seqs, sizes, last } = await pageAll(studio, id, 'A');
  assert.deepEqual(seqs, expected);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq must strictly increase at index ${i}`);
  assert.deepEqual(sizes, [2000, 500]);
  assert.equal(last.headers.get('x-next-after'), null, 'last page has no X-Next-After');
});

test('default behaviour without after is unchanged: first 2000 events as an array', async (t) => {
  const { studio, paths } = await fixture(t, { accessMode: 'local' });
  const id = seed(paths, Array.from({ length: 2500 }, (_, i) => ({ sid: 'A', seq: i + 1, t: i + 1, k: 'ws.frame' })));
  const r = await get(studio, `/api/sessions/${id}/events/A`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.ok(Array.isArray(r.body));
  assert.equal(r.body.length, 2000);
  assert.equal(r.body[0].seq, 1);
  assert.equal(r.body[1999].seq, 2000);
  assert.equal(r.body[0].sid, 'A');
  assert.equal(r.headers.get('x-next-after'), '2000');
});

test('a stream with no more events than one page has no X-Next-After', async (t) => {
  const { studio, paths } = await fixture(t, { accessMode: 'local' });
  const id = seed(paths, [1, 2, 3].map((seq) => ({ sid: 'S', seq, t: seq, k: 'ws.frame' })));
  const r = await get(studio, `/api/sessions/${id}/events/S`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((e) => e.seq), [1, 2, 3]);
  assert.equal(r.headers.get('x-next-after'), null);
  const after = await get(studio, `/api/sessions/${id}/events/S?after=3`);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, []);
  assert.equal(after.headers.get('x-next-after'), null);
});

test('limit defaults to 2000, is clamped to 5000, and a bad limit falls back to the default', async (t) => {
  const { studio, paths } = await fixture(t, { accessMode: 'local' });
  const id = seed(paths, Array.from({ length: 5200 }, (_, i) => ({ sid: 'C', seq: i + 1, t: i + 1, k: 'ws.frame' })));
  const big = await get(studio, `/api/sessions/${id}/events/C?limit=99999`);
  assert.equal(big.status, 200);
  assert.equal(big.body.length, 5000);
  assert.equal(big.body[4999].seq, 5000);
  assert.equal(big.headers.get('x-next-after'), '5000');
  const exact = await get(studio, `/api/sessions/${id}/events/C?limit=5000`);
  assert.equal(exact.body.length, 5000);
  const small = await get(studio, `/api/sessions/${id}/events/C?limit=10`);
  assert.equal(small.body.length, 10);
  assert.equal(small.headers.get('x-next-after'), '10');
  const junk = await get(studio, `/api/sessions/${id}/events/C?limit=abc`);
  assert.equal(junk.body.length, 2000);
});

test('invalid after values return 400 with the existing error shape', async (t) => {
  const { studio, paths } = await fixture(t, { accessMode: 'local' });
  const id = seed(paths, [{ sid: 'S', seq: 1, t: 1, k: 'ws.frame' }]);
  for (const bad of ['-1', 'abc', '1.5', '', '1e3', '0x10', '99999999999999999999999']) {
    const r = await get(studio, `/api/sessions/${id}/events/S?after=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `after=${bad} must be rejected`);
    assert.equal(typeof r.body.error, 'string');
  }
  const ok = await get(studio, `/api/sessions/${id}/events/S?after=0`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.map((e) => e.seq), [1]);
});

test('events that share a seq (one raw record) are never split across pages', async (t) => {
  const { studio, paths } = await fixture(t, { accessMode: 'local' });
  const seqs = [1, 2, 2, 3, 4, 4, 4, 5];
  const id = seed(paths, seqs.map((seq, i) => ({ sid: 'T', seq, t: i, k: 'ws.frame' })));
  const { seqs: got } = await pageAll(studio, id, 'T', 'limit=2');
  assert.deepEqual(got, seqs);
});

test('auth and Origin/Host failures keep their statuses on the events route', async (t) => {
  const tokened = await fixture(t, { token: 'paging-token' });
  const id = seed(tokened.paths, [{ sid: 'S', seq: 1, t: 1, k: 'ws.frame' }]);
  const noToken = await get(tokened.studio, `/api/sessions/${id}/events/S?after=abc`);
  assert.equal(noToken.status, 401, 'auth runs before validation');
  const withToken = await get(tokened.studio, `/api/sessions/${id}/events/S`, { 'x-studio-token': 'paging-token' });
  assert.equal(withToken.status, 200);

  const local = await fixture(t, { accessMode: 'local' });
  const lid = seed(local.paths, [{ sid: 'S', seq: 1, t: 1, k: 'ws.frame' }]);
  const foreignOrigin = await get(local.studio, `/api/sessions/${lid}/events/S?after=1`, { origin: 'https://example.org' });
  assert.equal(foreignOrigin.status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: local.studio.port,
      path: `/api/sessions/${lid}/events/S`, headers: { Host: 'other.example' } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(foreignHost, 421);
});
