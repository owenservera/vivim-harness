// Stall guard for the recorder. (1) Section timings exist and are sane. (2) Live JSON size cap: a
// response larger than liveJsonMaxBytes is an oversize marker with no parsed json in the LIVE view,
// while DERIVE (its own reducer, cap 0) decodes it in full with the same event count as an uncapped
// decode. (3) The cap never drops raw records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Recorder } from '../../src/capture/recorder.mjs';
import { Session } from '../../src/store/session.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { ShapeInferencer } from '../../src/shapes/infer.mjs';
import { NetworkRecorder } from '../../src/capture/network.mjs';
import { DomObserver } from '../../src/capture/dom.mjs';

const MIB = 1024 * 1024;
const SECTIONS = ['statusTick', 'persistTick', 'shapeReport', 'shapeFlush', 'shapeDrain', 'finalize', 'finalizeIngest'];

// A Recorder wired the same way start() wires it (reducer option included), without a browser.
function makeRecorder(root, opts = {}) {
  const profile = { name: 'stall-guard', version: 1, dom: { enabled: false }, match: { hosts: ['*'] } };
  const r = new Recorder({ sessionsDir: root, ...opts });
  r.profile = profile;
  r.privacy = { url: (u) => u };
  r.pageUrl = 'https://lab.test/';
  r.state = 'recording';
  r.startedAt = Date.now();
  r.session = Session.create(root, { site: 'stall-guard' });
  r.reducer = new StreamReducer({ deltaDialect: 'auto', maxEventsPerStream: 2000, jsonMaxBytes: r.liveJsonMaxBytes });
  r.shapes = new ShapeInferencer();
  r.eventsDs = r.session.dataset('events');
  const append = (rec) => r._append(rec);
  r.net = new NetworkRecorder({ append, profile, getPageUrl: () => r.pageUrl, options: { allBodies: true, maxStreamBytes: 0 } });
  r.dom = new DomObserver({ append, profile });
  return r;
}

function ndjsonLines(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${JSON.stringify({ name: `row-${i}`, value: i, tags: ['x'] })}\n`);
  return out;
}

function feedNdjson(r, sid, n, t0 = 1000) {
  const lines = ndjsonLines(n);
  r._append({ k: 'req', sid, t: t0, url: `https://lab.test/api/${sid.replace(':', '-')}`, method: 'POST', type: 'Fetch' });
  r._append({ k: 'res', sid, t: t0 + 1, status: 200, mime: 'application/x-ndjson' });
  for (let i = 0; i < lines.length; i += 7) r._append({ k: 'chunk', sid, t: t0 + 2 + i, b64: Buffer.from(lines.slice(i, i + 7).join('')).toString('base64') });
  r._append({ k: 'done', sid, t: t0 + 2 + lines.length });
}

// One JSON object of about `mb` MiB: a single top-level value (the whole-body decoder path).
function bigJsonBody(mb = 3) {
  return Buffer.from(JSON.stringify({ conversation: { id: 'c-big' }, pad: 'x'.repeat(mb * MIB) }), 'utf8');
}

function feedBody(r, sid, body, t0 = 5000) {
  r._append({ k: 'req', sid, t: t0, url: 'https://lab.test/api/history', method: 'GET', type: 'Fetch' });
  r._append({ k: 'res', sid, t: t0 + 1, status: 200, mime: 'application/json' });
  for (let off = 0; off < body.length; off += 64 * 1024) {
    r._append({ k: 'chunk', sid, t: t0 + 2, b64: body.subarray(off, off + 64 * 1024).toString('base64') });
  }
  r._append({ k: 'done', sid, t: t0 + 3 });
}

async function finish(root, r) {
  try { await r.stop({ reason: 'test' }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('timing counters exist and are non-negative after a short run', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'recorder-stall-guard-'));
  const r = makeRecorder(root);
  try {
    feedNdjson(r, 'p:1', 60);
    r.status();
    r._persist();
    r.flushShapes();
    const timing = r.status().stats.timing;
    for (const k of SECTIONS) {
      assert.ok(timing[k], `section ${k} exists`);
      for (const f of ['count', 'lastMs', 'maxMs', 'totalMs']) {
        assert.ok(Number.isFinite(timing[k][f]) && timing[k][f] >= 0, `${k}.${f} is a non-negative number`);
      }
    }
    assert.ok(timing.statusTick.count >= 1, 'status was timed');
    assert.ok(timing.persistTick.count >= 1, 'persist was timed');
    assert.ok(timing.finalize.count >= 1, 'the terminal record was timed');
    assert.ok(timing.finalizeIngest.count >= 1, 'the terminal reducer ingest was timed');
    assert.ok(timing.shapeFlush.count >= 1, 'explicit flush was timed');
  } finally { await finish(root, r); }
});

test('live: a 3 MB JSON response is an oversize marker with no json; derive decodes it in full', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'recorder-stall-guard-'));
  const r = makeRecorder(root);
  const live = [];
  r.on('event', (ev) => { if (ev.sid === 'p:big') live.push(ev); });
  const body = bigJsonBody(3);
  try {
    feedBody(r, 'p:big', body);
    const marker = live.filter((e) => e.type === 'json');
    assert.equal(marker.length, 1, 'one json event');
    assert.equal(marker[0].oversize, true);
    assert.equal(marker[0].json, undefined, 'live view carries no parsed json');
    assert.equal(marker[0].bytes, body.length);
    assert.deepEqual(marker[0].span, [0, body.length]);
    await r.stop({ reason: 'test' });

    // DERIVE: the same reducer configuration derive.mjs uses (cap 0), read back from the raw log.
    const records = [];
    for await (const rec of r.session.records()) records.push(rec);
    const derive = new StreamReducer({ deltaDialect: 'auto', keepEvents: true, maxEventsPerStream: 400 });
    const derived = derive.ingestAll(records);
    const full = derived.filter((e) => e.type === 'json');
    assert.equal(full.length, 1);
    assert.equal(full[0].oversize, undefined, 'derive is not capped');
    assert.equal(full[0].json.pad.length, 3 * MIB, 'derive has the complete json');
    assert.equal(full[0].json.conversation.id, 'c-big');

    const uncapped = new StreamReducer({ deltaDialect: 'auto', keepEvents: true, maxEventsPerStream: 400, jsonMaxBytes: 0 });
    const uncappedEvents = uncapped.ingestAll(records);
    assert.equal(derived.length, uncappedEvents.length, 'derive event count equals an uncapped decode');
    assert.equal(derived.length, live.length, 'the marker is one event, so live and derive agree on the count');
  } finally { await finish(root, r); }
});

test('a reducer built by the caller (no option) is still capped on the live recorder path', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'recorder-stall-guard-'));
  const r = makeRecorder(root);
  r.reducer = new StreamReducer({ deltaDialect: 'auto', maxEventsPerStream: 2000 });
  const live = [];
  r.on('event', (ev) => { if (ev.sid === 'p:lab') live.push(ev); });
  try {
    feedBody(r, 'p:lab', bigJsonBody(3));
    const marker = live.find((e) => e.type === 'json');
    assert.equal(marker?.oversize, true);
    assert.equal(marker.json, undefined);
  } finally { await finish(root, r); }
});

test('the cap drops nothing from raw: record and reducer counts equal with and without the cap', async () => {
  const rootA = mkdtempSync(path.join(tmpdir(), 'recorder-stall-guard-'));
  const rootB = mkdtempSync(path.join(tmpdir(), 'recorder-stall-guard-'));
  const capped = makeRecorder(rootA);
  const uncapped = makeRecorder(rootB, { liveJsonMaxBytes: 0 });
  const count = (r) => { const c = { records: 0, events: 0 }; r.on('record', () => c.records++); r.on('event', () => c.events++); return c; };
  const cc = count(capped);
  const uc = count(uncapped);
  try {
    for (const r of [capped, uncapped]) { feedBody(r, 'p:big', bigJsonBody(3)); feedNdjson(r, 'p:nd', 40); }
    assert.equal(capped.session.raw.stats.records, uncapped.session.raw.stats.records, 'raw record count equal');
    assert.equal(cc.records, uc.records, 'appended record count equal');
    assert.equal(cc.events, uc.events, 'derived event count equal (the marker is one event)');
    assert.equal(capped.reducer.totals.bytes, uncapped.reducer.totals.bytes, 'reducer byte totals equal');
    assert.equal(capped.liveJsonMaxBytes, 2 * MIB, 'live default is 2 MiB');
  } finally { await finish(rootA, capped); await finish(rootB, uncapped); }
});
