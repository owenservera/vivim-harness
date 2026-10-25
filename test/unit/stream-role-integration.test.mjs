// Stream role classifier wired into the reducer (opt-in summary) and derive (kv STREAM_ROLES).
// Synthetic only: raw L1 records go through the real StreamReducer and the real derive(); the expected
// roles are computed by calling classifyStreamRole directly on independently assembled input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';
import { ScopedLearner } from '../../src/intel/learn.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { derive, streamRolesCurrent, STREAM_ROLES_SCHEMA, STREAM_ROLE_CLASSIFIER_VERSION } from '../../src/replay/derive.mjs';
import { deriveAll } from '../../src/replay/derive-all.mjs';
import { detectStreamMap, applyStreamMap } from '../../src/profiles/stream-map.mjs';
import {
  classifyStreamRole, buildStreamRoles, describeStreamRoles, cleanCoverage, STREAM_ROLES, CONFIDENCE_LEVELS, EVIDENCE_FEATURES,
} from '../../src/replay/stream-role.mjs';

const SENTINEL = 'ZQSENTINEL';
const HOST = 'https://private-host.example.test';

// ---- synthetic raw streams ------------------------------------------------------------------
const sse = (payloads) => payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');
const split = (s, n) => { const k = Math.ceil(s.length / n); return Array.from({ length: n }, (_, i) => s.slice(i * k, (i + 1) * k)).filter(Boolean); };

const CHAT = sse([
  { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${SENTINEL} Hel` } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo, ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'friend' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_stop' },
]);
const CONFIG = JSON.stringify({
  models: [
    { id: 'm-1', name: 'Alpha', role: 'default', enabled: true },
    { id: 'm-2', name: 'Beta', role: 'assistant', enabled: false },
    { id: 'm-3', name: 'Gamma', role: 'system', enabled: true },
  ],
  features: { voice: true, canvas: false, search: true },
  limits: { maxFiles: 10 },
});
const HISTORY = JSON.stringify({ conversation: { messages: [
  { role: 'user', content: `${SENTINEL} question` },
  { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
] } });
const GENERIC = JSON.stringify({ alpha: 'one', beta: { gamma: 'two' }, note: 'some words here', list: ['a', 'b', 'c'] });

// sid -> { mime, method, chunks }, in order. Order matters: it is the reducer's stream order.
const FIXTURE = [
  { sid: 's-chat', mime: 'text/event-stream', method: 'POST', chunks: split(CHAT, 3) },
  { sid: 's-config', mime: 'application/json', method: 'GET', chunks: split(CONFIG, 4) },
  { sid: 's-history', mime: 'application/json', method: 'GET', chunks: [HISTORY] },
  { sid: 's-unknown', mime: 'application/json', method: 'GET', chunks: split(GENERIC, 3) },
];
const EXPECTED = { 's-chat': 'chat-reply', 's-config': 'config', 's-history': 'history-load', 's-unknown': 'unknown' };

function rawRecords(streams) {
  const recs = [];
  let seq = 1; let t = 1000;
  for (const { sid, mime, method, chunks } of streams) {
    recs.push({ k: 'req', sid, seq: seq++, t: t++, url: `${HOST}/api/${sid}`, method, type: 'Fetch' });
    recs.push({ k: 'res', sid, seq: seq++, t: t++, status: 200, mime, protocol: 'h2' });
    for (const c of chunks) recs.push({ k: 'chunk', sid, seq: seq++, t: t++, b64: Buffer.from(c).toString('base64') });
    recs.push({ k: 'done', sid, seq: seq++, t: t++, encodedDataLength: 1 });
  }
  return recs;
}

// Expected role computed WITHOUT the reducer's role path: assemble the classifier input by hand.
function directClassification(records, opts = { keepEvents: true, maxEventsPerStream: 20000 }) {
  const r = new StreamReducer(opts);
  r.ingestAll(records);
  const out = {};
  for (const row of r.summary().streams) {
    const events = r.eventsOf(row.sid);
    const det = row.kind === 'ws' || !events.length ? { map: null } : detectStreamMap(events);
    out[row.sid] = classifyStreamRole({
      summary: row, events, assembled: r.assembled(row.sid), map: det.map ? applyStreamMap(det.map, events) : null,
    });
  }
  return out;
}

function env(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stream-role-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { paths, profile: new ProfileStore(paths.profiles).load('generic'), learner: new ScopedLearner(path.join(root, 'learner')) };
}
async function seed(paths, streams) {
  const s = Session.create(paths.sessions, { site: 'stream-role-test' });
  for (const rec of rawRecords(streams)) s.raw.append(rec);
  await s.raw.close();
  return s;
}

// ---- reducer: opt-in summary -----------------------------------------------------------------
test('summary() default carries no role fields, never calls the classifier, and is unchanged by the option existing', () => {
  let calls = 0;
  const counting = new StreamReducer({ roleClassifier: (x) => { calls++; return classifyStreamRole(x); } });
  const plain = new StreamReducer();
  counting.ingestAll(rawRecords(FIXTURE));
  plain.ingestAll(rawRecords(FIXTURE));
  const a = counting.summary({ now: 5000 });
  const b = plain.summary({ now: 5000 });
  assert.equal(calls, 0, 'default summary does not classify');
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'identical key order');
  for (const s of a.streams) assert.ok(!('role' in s) && !('roleConfidence' in s) && !('roleEvidence' in s) && !('roleCoverage' in s));
  assert.ok(!('roleCounts' in a));
  assert.equal(counting.streamRole('nope'), null);
  assert.equal(calls, 0);
});

test('summary({ includeStreamRoles: true }) adds role fields and keeps every other field identical', () => {
  const r = new StreamReducer();
  r.ingestAll(rawRecords(FIXTURE));
  const base = r.summary({ now: 5000 });
  const withRoles = r.summary({ now: 5000, includeStreamRoles: true });
  assert.deepEqual(withRoles.roleCounts, { 'chat-reply': 1, 'history-load': 1, config: 1, telemetry: 0, 'push-presence': 0, asset: 0, auth: 0, unknown: 1 });
  const stripped = withRoles.streams.map(({ role, roleConfidence, roleEvidence, roleCoverage, ...rest }) => rest);
  assert.ok(withRoles.streams.every((s) => s.roleCoverage && s.roleCoverage.version === 1 && s.roleCoverage.fullyInspected === true), 'fixtures are small: nothing was cut');
  assert.deepEqual(stripped, base.streams);
  for (const s of withRoles.streams) {
    assert.equal(s.role, EXPECTED[s.sid]);
    assert.ok(CONFIDENCE_LEVELS.includes(s.roleConfidence));
  }
  // second call: deterministic
  assert.deepEqual(r.summary({ now: 5000, includeStreamRoles: true }), withRoles);
});

test('role results are cached per stream and invalidated exactly when that stream changes', () => {
  let calls = 0;
  const r = new StreamReducer({ roleClassifier: (x) => { calls++; return classifyStreamRole(x); } });
  const recs = rawRecords(FIXTURE);
  r.ingestAll(recs);
  r.summary({ includeStreamRoles: true });
  assert.equal(calls, 4);
  r.summary({ includeStreamRoles: true });
  r.streamRole('s-chat');
  assert.equal(calls, 4, 'memoised');
  // new bytes on one stream: only that stream is re-classified
  r.ingest({ k: 'chunk', sid: 's-unknown', seq: 9000, t: 9000, b64: Buffer.from(' ').toString('base64') });
  r.summary({ includeStreamRoles: true });
  assert.equal(calls, 5);
  // streams touched by a gap / pause are invalidated too
  r.ingest({ k: 'gap', seq: 9001, t: 9001, sids: ['s-config'], droppedRecords: 1 });
  const row = r.summary({ includeStreamRoles: true }).streams.find((s) => s.sid === 's-config');
  assert.equal(calls, 6);
  assert.ok(row.roleEvidence.some((e) => e.feature === 'incomplete_capture'), 'coverage loss is visible in the role evidence');
  // run.end touches everything
  r.ingest({ k: 'run.end', seq: 9002, t: 9002 });
  r.summary({ includeStreamRoles: true });
  assert.equal(calls, 10);
});

test('emitted role evidence is a copy: mutating it never alters the cache or later summaries', () => {
  const r = new StreamReducer();
  r.ingestAll(rawRecords(FIXTURE));
  const first = r.summary({ includeStreamRoles: true });
  const pristine = JSON.stringify(first);
  const chat = first.streams.find((s) => s.sid === 's-chat');
  chat.roleEvidence.push({ feature: 'x', count: 1 });
  chat.roleEvidence[0].count = 999;
  chat.roleCoverage.binary.versions.push(99);
  chat.roleCoverage.fullyInspected = false;
  r.streamRole('s-chat').coverage.growthDocsCut = 77;
  chat.role = 'asset';
  first.roleCounts.asset = 9;
  const direct = r.streamRole('s-chat');
  direct.evidence.length = 0;
  assert.equal(JSON.stringify(r.summary({ includeStreamRoles: true })), pristine);
  assert.ok(r.streamRole('s-chat').evidence.length > 0);
});

test('a bounded event window or keepEvents:false is marked as omitted events, never silently complete', () => {
  const bounded = new StreamReducer({ maxEventsPerStream: 3 });
  bounded.ingestAll(rawRecords([FIXTURE[0]]));
  const row = bounded.summary({ includeStreamRoles: true }).streams[0];
  assert.ok(row.eventsOnlyOnDisk > 0);
  assert.ok(row.roleEvidence.some((e) => e.feature === 'incomplete_capture'));

  // the bounded window is a reducer omission, reported as such (and not as a classifier cap)
  assert.ok(row.roleCoverage.eventsReducerOmitted > 0);
  assert.equal(row.roleCoverage.eventsClassifierSkipped, 0);
  assert.equal(row.roleCoverage.inspectionCut, true);
  assert.equal(row.roleCoverage.fullyInspected, false);
  assert.notEqual(row.role, 'chat-reply', 'a partial window never produces a label');

  const none = new StreamReducer({ keepEvents: false });
  none.ingestAll(rawRecords([FIXTURE[0]]));
  const r2 = none.summary({ includeStreamRoles: true }).streams[0];
  assert.equal(r2.roleCoverage.source, 'assembled-only');
  assert.equal(r2.roleCoverage.eventsRetained, 0);
  assert.equal(r2.role, 'unknown', 'assembler-only evidence is withheld, not labelled');
  assert.ok(r2.roleEvidence.some((e) => e.feature === 'incomplete_capture'));
  // the assembler's document may still support a verdict, but never a clean-capture confidence
  assert.ok(r2.roleConfidence !== 'high', 'events held only on disk cap the confidence');
  assert.ok(r2.roleEvidence.some((e) => e.feature === 'incomplete_capture'));
});

// A stream whose reply deltas sit deeper than the growth walker goes, next to a message container. Before
// the coverage fix the reply was invisible, the conflict vanished and this was a confident history-load.
const nestW = (o, n) => { let x = o; for (let i = 0; i < n; i++) x = { w: x }; return x; };
const CUT_BODY = sse([
  { messages: [{ role: 'user', content: 'a question' }, { role: 'assistant', content: 'an answer' }] },
  { type: 'message_start', message: { id: 'm-cut', role: 'assistant', content: [] } },
  ...Array.from({ length: 6 }, (_, i) => nestW({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `piece-${i} ` } }, 6)),
]);
const CUT_STREAM = { sid: 's-cut', mime: 'text/event-stream', method: 'POST', chunks: [CUT_BODY] };

test('reducer: an inspection cap that could hide a conflict withholds the role and records why', () => {
  const r = new StreamReducer();
  r.ingestAll(rawRecords([CUT_STREAM]));
  const row = r.summary({ includeStreamRoles: true }).streams[0];
  assert.equal(row.role, 'unknown');
  assert.equal(row.roleConfidence, 'none');
  assert.equal(row.roleCoverage.withheldRole, 'history-load');
  assert.equal(row.roleCoverage.growthDocsCut, 6);
  assert.equal(row.roleCoverage.fullyInspected, false);
  assert.equal(row.roleCoverage.eventsReducerOmitted, 0, 'no event was omitted: the cut is a classifier cap');
  assert.ok(row.roleEvidence.some((e) => e.feature === 'withheld_for_incomplete_inspection'));
  const direct = r.streamRole('s-cut');
  assert.deepEqual(direct.coverage, row.roleCoverage);
  assert.equal(r.summary({ includeStreamRoles: true }).roleCounts.unknown, 1);
});

test('summary of an open stream is classified from what exists and is not a different answer after it ends', () => {
  const r = new StreamReducer();
  const recs = rawRecords([FIXTURE[1]]);
  r.ingestAll(recs.slice(0, -1)); // no done yet
  const open = r.summary({ includeStreamRoles: true }).streams[0];
  assert.equal(open.status, 'open');
  r.ingest(recs.at(-1));
  assert.equal(r.summary({ includeStreamRoles: true }).streams[0].role, 'config');
});

// ---- derive: persisted artifact --------------------------------------------------------------
test('derive persists STREAM_ROLES matching direct classification, with schema, provenance and enum-only evidence', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, FIXTURE);
  const result = await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_ROLES');
  assert.equal(doc.schema, STREAM_ROLES_SCHEMA);
  assert.equal(doc.schema, 'capture-studio.stream-roles/3');
  assert.equal(doc.classifier.id, 'stream-role');
  assert.equal(doc.classifier.version, STREAM_ROLE_CLASSIFIER_VERSION);
  assert.equal(doc.classifier.version, 3);
  assert.equal(doc.classifier.coverageVersion, 1);
  assert.match(doc.confidenceScale, /heuristic-ordinal/);
  assert.match(doc.confidenceScale, /uncalibrated/);
  assert.deepEqual(doc.streams.map((x) => x.sid), ['s-chat', 's-config', 's-history', 's-unknown']);

  const expected = directClassification(rawRecords(FIXTURE));
  for (const row of doc.streams) {
    assert.equal(row.role, EXPECTED[row.sid], row.sid);
    assert.equal(row.role, expected[row.sid].role);
    assert.equal(row.roleConfidence, expected[row.sid].confidence);
    assert.deepEqual(row.roleEvidence, expected[row.sid].evidence);
    assert.deepEqual(Object.keys(row).sort(), ['eventsOmitted', 'roleConfidence', 'roleCoverage', 'roleEvidence', 'role', 'sid'].sort());
    assert.deepEqual(row.roleCoverage, cleanCoverage(expected[row.sid].coverage), 'persisted coverage equals the direct classification');
    assert.equal(row.roleCoverage.fullyInspected, true);
  }
  const unknown = doc.streams.find((x) => x.sid === 's-unknown');
  assert.equal(unknown.roleConfidence, 'none', 'unknown is explicit and carries no confidence');
  assert.ok(unknown.roleEvidence.some((x) => x.feature === 'no_structural_evidence'));
  assert.deepEqual(doc.totals, { streams: 4, byRole: { 'chat-reply': 1, 'history-load': 1, config: 1, telemetry: 0, 'push-presence': 0, asset: 0, auth: 0, unknown: 1 }, unknown: 1, withheld: 0, inspectionCut: 0 });
  assert.equal(doc.inputs.eventWindow, 20000);
  assert.match(doc.inputs.identity, /sid only/);

  // evidence = enum feature names and counts only; no content, URLs or ids
  for (const row of doc.streams) for (const ev of row.roleEvidence) {
    assert.deepEqual(Object.keys(ev).sort(), ['count', 'feature']);
    assert.ok(EVIDENCE_FEATURES.includes(ev.feature));
    assert.ok(Number.isInteger(ev.count) && ev.count > 0);
  }
  const flat = JSON.stringify(doc);
  assert.ok(!flat.includes(SENTINEL) && !flat.includes('private-host') && !flat.includes('https://') && !flat.includes('msg_1'));

  assert.equal(result.receipt.stream_roles, '4 streams: 1 chat-reply, 1 history-load, 1 config, 1 unknown');
  assert.equal(s.kv.get('RECEIPT').stream_roles, result.receipt.stream_roles);
  assert.ok(STREAM_ROLES.includes(doc.streams[0].role));
  assert.equal(streamRolesCurrent(s), true);
});

test('derive: a withheld stream is persisted as unknown with its candidate and coverage; normal streams are unaffected', async (t) => {
  const e = env(t);
  const streams = [...FIXTURE, CUT_STREAM];
  const s = await seed(e.paths, streams);
  const result = await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_ROLES');
  const cut = doc.streams.find((x) => x.sid === 's-cut');
  assert.equal(cut.role, 'unknown');
  assert.equal(cut.roleCoverage.withheldRole, 'history-load');
  assert.equal(cut.roleCoverage.fullyInspected, false);
  assert.deepEqual(cut.roleCoverage, cleanCoverage(directClassification(rawRecords(streams))['s-cut'].coverage));
  for (const sid of Object.keys(EXPECTED)) assert.equal(doc.streams.find((x) => x.sid === sid).role, EXPECTED[sid], sid);
  assert.equal(doc.totals.withheld, 1);
  assert.equal(doc.totals.inspectionCut, 1);
  assert.equal(doc.totals.byRole.unknown, 2);
  assert.equal(result.receipt.stream_roles, '5 streams: 1 chat-reply, 1 history-load, 1 config, 2 unknown (1 specific role withheld: incomplete inspection)');
  // enums / counts only
  const flat = JSON.stringify(doc);
  assert.ok(!flat.includes(SENTINEL) && !flat.includes('private-host') && !flat.includes('m-cut') && !flat.includes('piece-'));
  // deterministic
  await derive(s, e.profile, { learner: e.learner });
  assert.equal(JSON.stringify(s.kv.get('STREAM_ROLES')), flat);
});

test('re-deriving the same raw log writes byte-identical STREAM_ROLES', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, FIXTURE);
  await derive(s, e.profile, { learner: e.learner });
  const first = JSON.stringify(s.kv.get('STREAM_ROLES'));
  await derive(s, e.profile, { learner: e.learner });
  assert.equal(JSON.stringify(s.kv.get('STREAM_ROLES')), first);
});

test('the other derive artifacts are unchanged by the shared wide replay', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, FIXTURE);
  await derive(s, e.profile, { learner: e.learner });
  const doc = s.kv.get('STREAM_COMPONENTS');
  assert.equal(doc.schema, 'capture-studio.stream-components/1');
  assert.equal(doc.streams.find((x) => x.sid === 's-chat').mapId, 'claude-typed-events');
  assert.equal(doc.streams.find((x) => x.sid === 's-config').mapId, null, 'no map is guessed for the config stream');
  assert.equal(doc.totals.mapped, 1);
});

test('no streams -> explicit status; the role pass failing is isolated and recorded', async (t) => {
  const e = env(t);
  const empty = await seed(e.paths, []);
  await derive(empty, e.profile, { learner: e.learner });
  assert.deepEqual(empty.kv.get('STREAM_ROLES'), { schema: STREAM_ROLES_SCHEMA, status: 'no_streams' });
  assert.equal(empty.kv.get('RECEIPT').stream_roles, 'no_streams');
  assert.equal(streamRolesCurrent(empty), true, 'an explicit empty result is a current artifact');

  const s = await seed(e.paths, FIXTURE);
  const result = await derive(s, e.profile, { learner: e.learner, rolesImpl: () => { throw new Error('injected roles failure'); } });
  assert.deepEqual(s.kv.get('STREAM_ROLES'), { schema: STREAM_ROLES_SCHEMA, error: 'injected roles failure' });
  assert.equal(s.kv.get('RECEIPT').stream_roles, 'error');
  assert.ok(result.receipt);
  assert.ok(s.kv.get('STREAM_COMPONENTS').streams, 'components pass unaffected');
  assert.ok(s.kv.get('KNOWLEDGE_STATUS'), 'knowledge layer unaffected');
  assert.equal(streamRolesCurrent(s), false, 'a failed role pass is never "current"');

  const bad = await seed(e.paths, FIXTURE);
  await derive(bad, e.profile, { learner: e.learner, componentsImpl: () => { throw new Error('injected components failure'); } });
  assert.ok(bad.kv.get('STREAM_ROLES').streams, 'roles do not depend on componentsImpl');
});

test('streamRolesCurrent: missing, older-schema and older-classifier artifacts are stale, so they cannot be reused silently', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, FIXTURE);
  assert.equal(streamRolesCurrent(s), false, 'never derived');
  await derive(s, e.profile, { learner: e.learner });
  assert.equal(streamRolesCurrent(s), true);
  const doc = s.kv.get('STREAM_ROLES');
  s.kv.set('STREAM_ROLES', { ...doc, classifier: { ...doc.classifier, version: STREAM_ROLE_CLASSIFIER_VERSION - 1 } });
  assert.equal(streamRolesCurrent(s), false, 'older classifier version');
  s.kv.set('STREAM_ROLES', { ...doc, schema: 'capture-studio.stream-roles/0' });
  assert.equal(streamRolesCurrent(s), false, 'older schema');
  s.kv.set('STREAM_ROLES', null);
  assert.equal(streamRolesCurrent(s), false);
  assert.equal(streamRolesCurrent({ kv: { get() { throw new Error('x'); } } }), false);
});

// ---- derive-all incremental freshness ----------------------------------------------------------
async function finishedSession(e) {
  const s = await seed(e.paths, FIXTURE);
  s.meta.status = 'stopped';
  s.meta.endedAt = new Date().toISOString();
  s.saveMeta();
  return s;
}
const statusesOf = async (s, e, extra = {}) => {
  const seen = {};
  await deriveAll(s, { profile: e.profile, ...extra, onStage: (ev) => { if (ev.status === 'start' || ev.status === 'skipped') seen[ev.stage] = ev.status; } });
  return seen;
};

test('derive-all: a fresh manifest with a current role artifact is still skipped (incremental behaviour kept)', async (t) => {
  const e = env(t);
  const s = await finishedSession(e);
  const first = await statusesOf(s, e);
  assert.equal(first.base, 'start');
  assert.equal(streamRolesCurrent(s), true);
  const second = await statusesOf(s, e);
  assert.deepEqual(Object.values(second).filter((v) => v !== 'skipped'), [], 'every stage skipped');
  assert.equal(second.base, 'skipped');
});

test('derive-all: same cursor + fresh manifest but missing / older / errored role artifact is NOT skipped', async (t) => {
  const e = env(t);
  const s = await finishedSession(e);
  await statusesOf(s, e);
  const good = s.kv.get('STREAM_ROLES');
  const stale = {
    'missing (derived before roles existed)': null,
    'older classifier version': { ...good, classifier: { ...good.classifier, version: STREAM_ROLE_CLASSIFIER_VERSION - 1 } },
    'older schema': { ...good, schema: 'capture-studio.stream-roles/0' },
    'previous generation (schema /1, classifier v1, no coverage)': { ...good, schema: 'capture-studio.stream-roles/1', classifier: { id: 'stream-role', version: 1 } },
    'errored role pass': { schema: STREAM_ROLES_SCHEMA, error: 'boom' },
  };
  for (const [name, artifact] of Object.entries(stale)) {
    s.kv.set('STREAM_ROLES', artifact);
    assert.equal(streamRolesCurrent(s), false, name);
    const run = await statusesOf(s, e);
    assert.equal(run.base, 'start', `${name}: base re-derived`);
    assert.equal(streamRolesCurrent(s), true, `${name}: artifact repaired`);
    assert.deepEqual(s.kv.get('STREAM_ROLES'), good, `${name}: same content as before (deterministic)`);
    const again = await statusesOf(s, e);
    assert.equal(again.base, 'skipped', `${name}: and skipped again once current`);
  }
});

test('derive-all: the role artifact only gates runs that include the base stage', async (t) => {
  const e = env(t);
  const s = await finishedSession(e);
  await statusesOf(s, e);
  s.kv.set('STREAM_ROLES', null);
  const run = await statusesOf(s, e, { stages: ['schemas'] });
  assert.deepEqual(run, { schemas: 'skipped' }, 'base is not part of this run, so nothing is forced');
  assert.equal(streamRolesCurrent(s), false);
});

test('buildStreamRoles / describeStreamRoles are pure and tolerate odd rows', () => {
  assert.deepEqual(buildStreamRoles([]), { schema: STREAM_ROLES_SCHEMA, status: 'no_streams' });
  assert.deepEqual(buildStreamRoles(null), { schema: STREAM_ROLES_SCHEMA, status: 'no_streams' });
  const rows = [{ sid: 'a', role: 'made-up', roleConfidence: 'certain', roleEvidence: [{ feature: 'json_events', count: 2, extra: 'x' }], eventsOnlyOnDisk: 4 }, { nosid: true }];
  const doc = buildStreamRoles(rows, { eventWindow: 10 });
  assert.equal(doc.streams.length, 1);
  assert.deepEqual(doc.streams[0], { sid: 'a', role: 'unknown', roleConfidence: 'none', roleEvidence: [{ feature: 'json_events', count: 2 }], roleCoverage: null, eventsOmitted: 4 });
  assert.equal(describeStreamRoles(doc), '1 streams: 1 unknown');
  assert.equal(describeStreamRoles({ status: 'no_streams' }), 'no_streams');
  assert.equal(describeStreamRoles({ error: 'x' }), 'error');
  assert.equal(JSON.stringify(buildStreamRoles(rows, { eventWindow: 10 })), JSON.stringify(doc));
});

// ---- measured cost (timings are reported, nothing is asserted about speed) -----------------------
test('repeated-summary cost check: default vs opt-in cold vs opt-in cached (timings only)', (t) => {
  const STREAMS = 120; const REPEATS = 40;
  const streams = Array.from({ length: STREAMS }, (_, i) => FIXTURE[i % FIXTURE.length]).map((f, i) => ({ ...f, sid: `m-${i}` }));
  let calls = 0;
  const r = new StreamReducer({ roleClassifier: (x) => { calls++; return classifyStreamRole(x); } });
  r.ingestAll(rawRecords(streams));
  const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  r.summary(); // warm the stream-summary memo so the default timing is the steady state
  const defaultMs = time(() => { for (let i = 0; i < REPEATS; i++) r.summary(); });
  assert.equal(calls, 0);
  const coldMs = time(() => r.summary({ includeStreamRoles: true }));
  assert.equal(calls, STREAMS);
  const cachedMs = time(() => { for (let i = 0; i < REPEATS; i++) r.summary({ includeStreamRoles: true }); });
  assert.equal(calls, STREAMS, 'cached repeats classify nothing');
  const line = `repeated summary, ${STREAMS} synthetic streams: default x${REPEATS} ${defaultMs.toFixed(1)} ms; opt-in cold x1 ${coldMs.toFixed(1)} ms; opt-in cached x${REPEATS} ${cachedMs.toFixed(1)} ms`;
  t.diagnostic(line);
  console.log(`# ${line}`);
});
