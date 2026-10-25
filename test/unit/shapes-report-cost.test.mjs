// Shape report cost. The raw-to-DOM correlation pass must keep the pre-change first-match
// semantics (one normalisation per block, not one per probe), explicit reads and stop must build the
// complete report, and repeated reports with no new observations must be identical and cheap.
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

const long = (tag, n) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);
const stable = (rep) => { const { generatedAt, ...rest } = rep; return JSON.parse(JSON.stringify(rest)); };

// Minimal reducer surface that report() reads: summary(), streams (sid -> stream with _events and
// _delta.texts), actions, gaps and dom.blocks.
function fakeReducer({ streams, blocks = [], actions = [], gaps = [] }) {
  const list = streams.map((s) => ({
    sid: s.sid, method: 'POST', url: s.url, transport: 'HTTP_SSE', kind: 'http', status: 'complete', status_code: 200,
    bytes: s.text.reduce((a, t) => a + t.length, 0), events: s.events.length, startedT: 1000, policy: 'body', deltaRevisions: 0, deltaDialects: [], mime: 'text/event-stream',
  }));
  const map = new Map(streams.map((s) => [s.sid, { sid: s.sid, _events: s.events, _delta: { revisions: 0, texts: (n) => s.text.slice(0, n).map((t) => ({ text: t })) } }]));
  return {
    summary: () => ({ streams: list, totals: {}, transportCounts: {}, transportDetailCounts: {}, appProtocols: [], stalledStreams: [] }),
    streams: map, actions, gaps,
    dom: { blocks: new Map(blocks.map((b) => [b.id, b])) },
  };
}

// The pre-change correlation pass, kept verbatim in semantics: probes in stream order, first block (in
// block order) whose normalised text contains the probe head wins, uncorrelated blocks capped at 10.
function referenceCorrelation(reducer, blocks) {
  const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const streamTexts = [];
  for (const s of reducer.summary().streams) {
    const st = reducer.streams.get(s.sid);
    const texts = st?._delta?.texts?.(40) ?? [];
    const evTexts = (st?._events ?? []).filter((e) => typeof e.text === 'string' && e.text.length >= 40).map((e) => ({ text: e.text }));
    for (const t of [...texts.slice(0, 3), ...evTexts.slice(0, 2)]) streamTexts.push({ sid: s.sid, text: norm(t.text) });
  }
  const pairs = [];
  const matched = new Set();
  for (const st of streamTexts) {
    const probe = st.text.slice(0, 120);
    if (probe.length < 30) continue;
    const hit = blocks.find((b) => b.text && norm(b.text).includes(probe.slice(0, 60)));
    if (hit) { matched.add(hit.id); pairs.push(`${st.sid}|${hit.id}`); }
  }
  const uncorrelated = blocks.filter((b) => !matched.has(b.id) && b.text && b.text.length >= 200 && !b.removed).slice(0, 10).map((b) => b.id);
  return { pairs, uncorrelated };
}

function matchingFixture() {
  const streams = [
    { sid: 'p:1', url: 'https://lab.test/api/chat', text: [long('Alpha beta gamma delta epsilon', 300), 'short'], events: [{ text: long('Zeta eta theta iota kappa', 200) }, { text: 'x' }] },
    { sid: 'p:2', url: 'https://lab.test/api/other', text: [long('Lambda mu nu xi omicron', 260)], events: [{ text: long('Pi rho sigma tau upsilon', 220) }] },
  ];
  const blocks = [
    { id: 1, text: long('Unrelated page chrome', 400), sig: 'div.nav', revisions: 1 },
    { id: 2, text: 'Alpha   beta gamma delta epsilon Alpha beta gamma delta epsilon ' + 'filler '.repeat(60), sig: 'div.msg', revisions: 3 },
    { id: 3, text: 'Alpha   beta gamma delta epsilon again ' + 'z'.repeat(300), sig: 'div.msg2', revisions: 2 },
    { id: 4, text: long('Zeta eta theta iota kappa', 350), sig: 'div.msg3', revisions: 1 },
    { id: 5, text: null, sig: 'div.empty', revisions: 1 },
    { id: 6, text: long('Lambda mu nu xi omicron', 300), sig: 'div.msg4', revisions: 1, removed: true },
    { id: 7, text: long('Lambda mu nu xi omicron', 300), sig: 'div.msg5', revisions: 1 },
  ];
  return { streams, blocks };
}

test('correlation pass keeps the pre-change first-match and uncorrelated results', () => {
  const { streams, blocks } = matchingFixture();
  const reducer = fakeReducer({ streams, blocks });
  const rep = new ShapeInferencer().report(reducer, { families: [], profile: null });
  const want = referenceCorrelation(fakeReducer({ streams, blocks }), blocks);
  const got = rep.suggestions.filter((s) => s.kind === 'correlation').map((s) => `${s.evidence.sid}|${s.evidence.domId}`);
  const gotUi = rep.suggestions.filter((s) => s.kind === 'uncorrelated_ui').map((s) => s.evidence.domId);
  assert.deepEqual(got, want.pairs);
  assert.deepEqual(gotUi, want.uncorrelated);
  assert.ok(want.pairs.length >= 3, 'the fixture really exercises matches (including a multi-match probe)');
});

test('correlation over more than ten uncorrelated blocks is capped at ten, in block order', () => {
  const blocks = Array.from({ length: 14 }, (_, i) => ({ id: 100 + i, text: long(`Block ${i} body`, 260), sig: `div.b${i}`, revisions: 1 }));
  const streams = [{ sid: 'p:9', url: 'https://lab.test/api/x', text: [long('Nothing here matches', 200)], events: [] }];
  const rep = new ShapeInferencer().report(fakeReducer({ streams, blocks }), { families: [], profile: null });
  const gotUi = rep.suggestions.filter((s) => s.kind === 'uncorrelated_ui').map((s) => s.evidence.domId);
  assert.deepEqual(gotUi, blocks.slice(0, 10).map((b) => b.id));
});

test('explicit domBlocks argument gives the same report as reading reducer.dom.blocks', () => {
  const { streams, blocks } = matchingFixture();
  const a = new ShapeInferencer().report(fakeReducer({ streams, blocks }), { families: [], profile: null });
  const b = new ShapeInferencer().report(fakeReducer({ streams, blocks: [] }), { families: [], profile: null, domBlocks: blocks });
  assert.deepEqual(stable(b), stable(a));
});

test('large synthetic input: a periodic-size report finishes under a generous bound and repeats identically', () => {
  const streams = Array.from({ length: 20 }, (_, i) => ({
    sid: `p:${i}`, url: `https://lab.test/api/stream-${i % 4}`,
    text: [long(`Stream ${i} text`, 800), long(`Shared phrase ${i % 5}`, 300)],
    events: Array.from({ length: 150 }, (_, k) => ({ text: long(`Event ${i}-${k} body`, 120), json: { id: `${i}-${k}`, type: 'delta', value: k } })),
  }));
  // The first 40 blocks render a stream's text head (correlation hits); the rest are uncorrelated.
  const blocks = Array.from({ length: 400 }, (_, i) => ({
    id: i, text: i < 40 ? `${long(`Stream ${i % 20} text`, 800)} tail ${i}` : long(`Block ${i} content ${i % 7}`, 1500 + (i % 9) * 100), sig: `div.k${i % 11}`, revisions: 1,
  }));
  const inf = new ShapeInferencer({ deferred: false });
  const reducer = fakeReducer({ streams, blocks });
  for (const st of streams) for (const ev of st.events) inf.observeEvent({ type: 'sse', json: ev.json, t: 1, sid: st.sid, text: ev.text }, { method: 'POST', url: streams[0].url });
  const t0 = performance.now();
  const first = inf.report(reducer, { families: [], profile: null });
  const ms = performance.now() - t0;
  assert.ok(ms < 10_000, `one report took ${ms.toFixed(0)} ms (generous bound 10000 ms)`);
  assert.ok(first.suggestions.some((s) => s.kind === 'correlation'), 'correlation really ran on the large input');
  const phases = inf.lastReportPhases;
  for (const k of ['summary', 'groups', 'suggest', 'evidence', 'families', 'rank', 'profiler', 'quality']) {
    assert.ok(Number.isFinite(phases[k]) && phases[k] >= 0, `phase ${k} is timed`);
  }
  assert.ok('s.domMatch' in phases, 'the correlation section is timed');
  assert.deepEqual(stable(inf.report(reducer, { families: [], profile: null })), stable(first));
});

test('repeated reports with no new observations are idempotent and cheap', () => {
  const { streams, blocks } = matchingFixture();
  const inf = new ShapeInferencer({ deferred: false });
  for (const st of streams) for (const ev of st.events) inf.observeEvent({ type: 'sse', json: { type: 'delta', text: ev.text }, t: 1, sid: st.sid }, { method: 'POST', url: st.url });
  const reducer = fakeReducer({ streams, blocks });
  const first = stable(inf.report(reducer, { families: [], profile: null }));
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) inf.flush();
  const second = inf.report(reducer, { families: [], profile: null });
  const ms = performance.now() - t0;
  assert.deepEqual(stable(second), first);
  assert.ok(ms < 5_000, `repeat took ${ms.toFixed(0)} ms`);
});

// ---- Recorder-level: periodic persist, explicit read and stop all build the complete report.

function makeRecorder(root) {
  const profile = { name: 'shapes-report-cost', version: 1, dom: { enabled: false }, match: { hosts: ['*'] } };
  const r = new Recorder({ sessionsDir: root });
  r.profile = profile;
  r.privacy = { url: (u) => u };
  r.pageUrl = 'https://lab.test/';
  r.state = 'recording';
  r.startedAt = Date.now();
  r.session = Session.create(root, { site: 'shapes-report-cost' });
  r.reducer = new StreamReducer({ deltaDialect: 'auto', maxEventsPerStream: 2000 });
  r.shapes = new ShapeInferencer();
  r.eventsDs = r.session.dataset('events');
  const append = (rec) => r._append(rec);
  r.net = new NetworkRecorder({ append, profile, getPageUrl: () => r.pageUrl, options: { allBodies: true, maxStreamBytes: 0 } });
  r.dom = new DomObserver({ append, profile });
  return r;
}

function feed(r, sid, n, t0 = 1000) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`${JSON.stringify({ name: `row-${i}`, value: (i * 7919) % 1000, type: ['alpha', 'bravo', 'charlie'][i % 3], ts: 1700000000000 + i })}\n`);
  r._append({ k: 'req', sid, t: t0, url: `https://lab.test/api/${sid.replace(':', '-')}/chat`, method: 'POST', type: 'Fetch' });
  r._append({ k: 'res', sid, t: t0 + 1, status: 200, mime: 'application/x-ndjson' });
  for (let i = 0; i < lines.length; i += 7) r._append({ k: 'chunk', sid, t: t0 + 2 + i, b64: Buffer.from(lines.slice(i, i + 7).join('')).toString('base64') });
  r._append({ k: 'done', sid, t: t0 + 2 + lines.length });
}

test('periodic persist, explicit read and stop all carry the same complete report', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'shapes-report-cost-'));
  const r = makeRecorder(root);
  try {
    feed(r, 'p:1', 300);
    feed(r, 'p:2', 120, 5000);
    const explicit = stable(r.liveReport());
    await r._persist(); // periodic writes are asynchronous (kv.setAsync); await the settled files
    assert.deepEqual(stable(r.session.kv.get('SHAPES')), explicit, 'periodic persist equals an explicit read');
    const groupEvents = explicit.groups.filter((g) => g.source !== 'assembled').reduce((n, g) => n + g.count, 0);
    assert.equal(groupEvents, 420, 'every observed event is in the report (nothing dropped)');
    await r.stop({ reason: 'test' });
    assert.deepEqual(stable(r.session.kv.get('SHAPES')), explicit, 'the stop report equals the explicit read');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
