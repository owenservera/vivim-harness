// Categorization scoreboard: synthetic sessions built from the committed ai-chat-dialects fixtures
// in a temp data directory. Nothing here touches the owner's real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  runScoreboard, renderSummary, aggregate, roleOfStream, roleDisposition, roleStability, originContextOf, endpointCoverage, ORIGIN_CLASSES, dialectStateOf, registrableHost,
  endpointHash, compareReports, readLearnerState, familyBucket, SKIP_STATUSES, sessionRef,
  framingLabel, roleLabel, statusLabel, familyLabel, mapLabel, STREAM_ROLES, SESSION_STATUSES,
} from '../../scripts/categorization-scoreboard.mjs';
import { GuardError } from '../../scripts/fidelity-survey.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', '..', 'scripts', 'categorization-scoreboard.mjs');
const FIXTURES = path.join(here, '..', 'fixtures', 'ai-chat-dialects');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

// Every one of these strings is planted in the fixture and must never reach the output.
const BODY_SENTINEL = 'SENTqx7body';
const PATH_SENTINEL = 'SENTqx7urlpath';
const QUERY_SENTINEL = 'SENTqx7query';
const TITLE_SENTINEL = 'SENTqx7title';
const DOM_SENTINEL = 'SENTqx7domtext';
const FAMILY_EVIDENCE_SENTINEL = 'SENTqx7familyevidence';
const LEARNER_SENTINEL = 'SENTqx7learnertext';
const SUBDOMAIN = 'sentinel-sub';
const REGISTRABLE = 'qa-fixture.test';
// Private-text sentinels that sit in fields the report must never echo (bounded enums only).
const PRIVATE_FAMILY = 'SENTqx7privatefamily';
const PRIVATE_STATUS = 'SENTqx7privatestatus';
const FORBIDDEN = [BODY_SENTINEL, PATH_SENTINEL, QUERY_SENTINEL, TITLE_SENTINEL, DOM_SENTINEL,
  FAMILY_EVIDENCE_SENTINEL, LEARNER_SENTINEL, PRIVATE_FAMILY, PRIVATE_STATUS, SUBDOMAIN, '@',
  'sessions/', 'raw/', 'kv/', '000001.jsonl', 'syn-qa-'];
const URL_WITH_SENTINELS = `https://${SUBDOMAIN}.${REGISTRABLE}/${PATH_SENTINEL}/node?${QUERY_SENTINEL}=1`;

const chatgptPayloads = load('chatgpt-pathops.json').payloads;
const claudePayloads = load('claude-typedevents.json').payloads;
const openaiPayloads = load('openai-responses.json').payloads;

// Same SSE rendering the other fixtures use.
function toSse(payloads) {
  return payloads.map((p) => {
    if (typeof p === 'string') return `data: ${p}\n\n`;
    const ev = typeof p.type === 'string' ? `event: ${p.type}\n` : '';
    return `${ev}data: ${JSON.stringify(p)}\n\n`;
  }).join('');
}

// streamUrl: the URL the single synthetic stream requested; targetUrl: the session's first-tab target
// (null = a session with no usable target). Both default to the sentinel URL (same host).
function writeSession(sessionsDir, id, { payloads = null, status = 'complete', family = null, raw = true, body = null, mime = 'text/event-stream', chunks = null, streamUrl = URL_WITH_SENTINELS, targetUrl = URL_WITH_SENTINELS } = {}) {
  const dir = path.join(sessionsDir, id);
  mkdirSync(path.join(dir, 'raw'), { recursive: true });
  mkdirSync(path.join(dir, 'kv'), { recursive: true });
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    id,
    site: 'synthetic',
    createdAt: '2026-01-01T00:00:00.000Z',
    status,
    ...(targetUrl === null ? {} : { target: { id: 't-1', url: targetUrl, title: TITLE_SENTINEL } }),
  }, null, 2));
  // The scoreboard never reads DOM turns; the sentinel is planted to prove that.
  writeFileSync(path.join(dir, 'kv', 'DOM_TURNS.json'), JSON.stringify([
    { index: 0, role: 'assistant', text: DOM_SENTINEL, blocks: [] },
  ], null, 2));
  if (family) {
    writeFileSync(path.join(dir, 'kv', 'RECEIPT.json'), JSON.stringify({
      family: { best: family, score: 0.8, linked: null },
      notes: FAMILY_EVIDENCE_SENTINEL,
    }, null, 2));
  }
  if (!raw || (payloads === null && body === null && chunks === null)) return dir;
  const sid = 's-1';
  const parts = chunks ?? [body ?? toSse(payloads)];
  const recs = [
    { seq: 1, t: 1000, k: 'req', sid, url: streamUrl, method: body === null && chunks === null ? 'POST' : 'GET', type: 'Fetch' },
    { seq: 2, t: 1010, k: 'res', sid, status: 200, mime },
    ...parts.map((p, i) => ({ seq: 3 + i, t: 1020 + i, k: 'chunk', sid, b64: Buffer.from(p, 'utf8').toString('base64') })),
    { seq: 3 + parts.length, t: 1030 + parts.length, k: 'done', sid, encodedDataLength: 1 },
  ];
  writeFileSync(path.join(dir, 'raw', '000001.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

function makeEnv(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'categorization-scoreboard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const sessionsDir = path.join(dataDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(path.join(root, 'out'), { recursive: true });
  writeSession(sessionsDir, 'syn-qa-chatgpt', { payloads: chatgptPayloads, family: 'ai-chat' });
  writeSession(sessionsDir, 'syn-qa-claude', { payloads: claudePayloads, family: 'ai-chat' });
  writeSession(sessionsDir, 'syn-qa-openai', { payloads: openaiPayloads });
  // Derived knowledge on disk for one session only.
  writeFileSync(path.join(sessionsDir, 'syn-qa-chatgpt', 'kv', 'MODEL.json'), JSON.stringify({ types: {}, relationships: [] }));
  // Still growing: counted in the accounting, skipped by every stream measure.
  writeSession(sessionsDir, 'syn-qa-recording', { status: 'recording', raw: false });
  mkdirSync(path.join(dataDir, 'learner'), { recursive: true });
  // Journal-shaped snapshot: what <data-dir>/learner/learner.json holds after a save().
  writeFileSync(path.join(dataDir, 'learner', 'learner.json'), JSON.stringify({
    version: 2, revision: 3, parentRevision: 2, savedAt: '2026-01-01T00:00:00.000Z',
    models: { 'site:qa': { examples: 4 } },
    globalLearned: [{ features: [], role: 'text', weight: 1 }],
    overrides: { 'instance:1': 'text' },
    corrections: [
      { id: 'c-1', scope: 'local', status: 'accepted', text: LEARNER_SENTINEL },
      { id: 'c-2', scope: 'global', status: 'accepted', text: LEARNER_SENTINEL },
      { id: 'c-3', scope: 'local', reverted: true, text: LEARNER_SENTINEL },
    ],
    proposals: [{ id: 'p-1', status: 'proposed' }, { id: 'p-2', status: 'rejected' }, { id: 'p-3' }],
    audit: [{ action: 'teach' }],
    calibrator: { bins: { field_role: [{ n: 2, pos: 1, psum: 0.6 }, { n: 1, pos: 1, psum: 0.85 }] } },
    integrity: 'fixture',
  }, null, 2));
  return { root, dataDir, sessionsDir, outDir: path.join(root, 'out') };
}

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const st = statSync(p);
      out.push([path.relative(dir, p).split(path.sep).join('/'), e.isDirectory() ? 'dir' : 'file', st.size, st.mtimeMs]);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 180000 });
}

const byRef = (report) => Object.fromEntries(report.sessions.map((s) => [s.ref, s]));
const at = (report, id) => byRef(report)[sessionRef(id)];
const allText = (report) => JSON.stringify(report);

test('runs on synthetic sessions and measures framing, dialect state and stream maps', async (t) => {
  const { dataDir } = makeEnv(t);
  const { report, changes } = await runScoreboard({ dataDir });
  assert.deepEqual(changes, []);
  assert.equal(report.schema, 'capture-studio.categorization-scoreboard/1');
  const chatgpt = at(report, 'syn-qa-chatgpt');
  assert.equal(chatgpt.status, 'ok');
  assert.equal(chatgpt.framing.transport.HTTP_SSE, 1);
  assert.equal(chatgpt.streamMap.mapId, 'chatgpt-path-ops');
  assert.equal(at(report, 'syn-qa-claude').streamMap.mapId, 'claude-typed-events');
  assert.equal(at(report, 'syn-qa-openai').streamMap.mapId, 'openai-responses');
  assert.equal(chatgpt.dialectState.counts['known-delta'], 1, 'path-ops is a known dialect');
  assert.equal(chatgpt.dialectState.field, 0, 'no summary field yet: the fallback is used and labelled');
  assert.equal(chatgpt.dialectState.fallback, 1);
  assert.equal(chatgpt.siteHost, REGISTRABLE, 'registrable host only');
  assert.equal(chatgpt.streamBytes > 0, true);
  assert.equal(chatgpt.family.verdict, 'ai-chat');
  assert.equal(chatgpt.family.bucket, '[0.75,1]');
  assert.equal(chatgpt.family.source, 'receipt');
  assert.equal(report.aggregate.measures.streamMap.sessionsWithMap, 3);
  assert.equal(report.aggregate.measures.framing.streams.transportDetail.HTTP_SSE >= 3, true);
});

test('a recording session is counted but skipped by the stream measures', async (t) => {
  const { dataDir } = makeEnv(t);
  const { report } = await runScoreboard({ dataDir });
  const rec = at(report, 'syn-qa-recording');
  assert.equal(SKIP_STATUSES.includes('recording'), true);
  assert.equal(rec.status, 'skipped');
  assert.equal(rec.skipReason, 'session_in_progress');
  assert.equal('streams' in rec, false, 'a skipped session carries no stream measures');
  assert.equal(report.aggregate.sessions.total, 4);
  assert.equal(report.aggregate.sessions.measurable, 3);
  assert.equal(report.aggregate.sessions.skipped, 1);
  assert.equal(report.aggregate.sessions.bySessionStatus.recording, 1);
  assert.equal(report.aggregate.sessions.withDerivedKnowledge, 1, 'only syn-qa-chatgpt carries derived artifacts');
});

// A static config document split across chunks, and a generic JSON document with no structure.
const CONFIG_BODY = JSON.stringify({
  models: [{ id: 'm-1', name: 'Alpha', enabled: true }, { id: 'm-2', name: 'Beta', enabled: false }, { id: 'm-3', name: 'Gamma', enabled: true }],
  features: { voice: true, canvas: false, search: true },
});
const GENERIC_BODY = JSON.stringify({ alpha: 'one', beta: { gamma: 'two' }, note: 'some words here', list: ['a', 'b', 'c'] });
const half = (s) => [s.slice(0, s.length >> 1), s.slice(s.length >> 1)];

test('--no-roles / roles:"off" is the deliberate pre-role baseline: role_field_present=false, coverage zero, stability null', async (t) => {
  const { dataDir } = makeEnv(t);
  const { report } = await runScoreboard({ dataDir, roles: 'off' });
  const m = report.aggregate.measures;
  assert.equal(m.role.mode, 'off');
  assert.equal(m.role.field_present, false);
  assert.equal(m.role.streams > 0, true);
  assert.equal(m.role.streamsLabeled, 0);
  assert.equal(m.role.streamsWithoutRole, m.role.streams);
  assert.equal(m.role.streamsAbsent, m.role.streams, 'every stream is "absent", not "unknown"');
  assert.equal(m.role.streamsUnknown, 0);
  assert.equal(m.role.labeledStreamShare, 0);
  assert.deepEqual(m.role.distribution, {});
  assert.equal(m.roleStability.stabilityShare, null, 'stability is only meaningful when roles exist');
  assert.equal(m.roleStability.endpointsComparable, 0);
  await assert.rejects(runScoreboard({ dataDir, roles: 'persisted' }), /roles must be one of/);
  const r = cli(['--data-dir', dataDir, '--no-roles']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).aggregate.measures.role.mode, 'off');
});

test('default (replay) mode requests includeStreamRoles: role fields exist and known vs unknown coverage is separate', async (t) => {
  const { dataDir, sessionsDir } = makeEnv(t);
  writeSession(sessionsDir, 'syn-qa-config', { body: CONFIG_BODY, mime: 'application/json', chunks: half(CONFIG_BODY) });
  writeSession(sessionsDir, 'syn-qa-generic', { body: GENERIC_BODY, mime: 'application/json' });
  const { report } = await runScoreboard({ dataDir });
  const m = report.aggregate.measures;
  assert.equal(m.role.mode, 'replay');
  assert.equal(m.role.field_present, true);
  assert.match(m.role.confidenceScale, /ordinal heuristic/);
  assert.match(m.role.confidenceScale, /not a probability/);
  assert.equal(at(report, 'syn-qa-chatgpt').role.fieldPresent, true);
  assert.equal(at(report, 'syn-qa-config').role.dispositions.specific, 1);
  assert.deepEqual(at(report, 'syn-qa-config').role.distribution, { config: 1 });
  assert.equal(at(report, 'syn-qa-generic').role.dispositions.unknown, 1);
  assert.deepEqual(at(report, 'syn-qa-generic').role.distribution, { unknown: 1 });
  assert.equal(at(report, 'syn-qa-generic').role.labeled, 0, 'unknown is not a specific role');
  assert.equal(at(report, 'syn-qa-generic').role.unlabeled, 1);
  // aggregate: 5 measured sessions x 1 stream; the config stream is specific, the generic one is unknown
  assert.equal(m.role.streams, 5);
  assert.ok(m.role.streamsLabeled >= 1);
  assert.equal(m.role.streamsLabeled + m.role.streamsUnknown + m.role.streamsTruncated + m.role.streamsAbsent + m.role.streamsWithheld, m.role.streams, 'dispositions reconcile');
  assert.equal(m.role.streamsFullyInspectedSpecific, m.role.streamsLabeled, 'every emitted specific role was fully inspected');
  assert.equal(m.role.streamsRawSpecific, m.role.streamsLabeled + m.role.streamsWithheld);
  assert.equal(m.role.streamsCoverageUnavailable, 0);
  assert.equal(m.role.streamsUnknown >= 1, true);
  assert.equal(m.role.streamsWithoutRole, m.role.streams - m.role.streamsLabeled);
  assert.equal(m.role.distribution.unknown, m.role.streamsUnknown, 'unknown is reported but is not in the coverage share');
  assert.equal(m.role.labeledStreamShare, Math.round((m.role.streamsLabeled / m.role.streams) * 1000) / 1000);
  assert.equal(m.role.labeledBytes + m.role.unknownBytes + m.role.truncatedBytes + m.role.absentBytes + m.role.withheldBytes, m.role.bytes);
  for (const lvl of Object.keys(m.role.confidence)) assert.ok(['low', 'medium', 'high'].includes(lvl), 'specific roles carry an ordinal level, never "none"');
  assert.equal(Object.values(m.role.confidence).reduce((a, b) => a + b, 0), m.role.streamsLabeled);
  for (const label of Object.keys(m.role.distribution)) assert.ok(STREAM_ROLES.includes(label), label);
  assert.equal(m.role.eventsOmitted, 0);
  const text = allText(report);
  for (const phrase of FORBIDDEN) assert.equal(text.includes(phrase), false, `report leaks "${phrase}"`);
});

test('streams whose events were bounded are truncated, never counted as role coverage', async (t) => {
  const { dataDir } = makeEnv(t);
  const complete = await runScoreboard({ dataDir, sessions: ['syn-qa-claude'] });
  assert.equal(complete.report.aggregate.measures.role.streamsTruncated, 0);
  const capped = await runScoreboard({ dataDir, sessions: ['syn-qa-claude'], eventCap: 2 });
  const m = capped.report.aggregate.measures.role;
  assert.equal(m.streamsTruncated, 1);
  assert.equal(m.streamsLabeled, 0, 'a partial window is not coverage');
  assert.equal(m.truncatedBytes > 0, true);
  assert.equal(m.eventsOmitted > 0, true, 'omissions are counted');
  assert.deepEqual(m.distribution, {}, 'no label is reported for a truncated stream');
  const s = at(capped.report, 'syn-qa-claude').role;
  assert.equal(s.dispositions.truncated, 1);
});

test('persisted kv/STREAM_ROLES is never read: a stale or lying artifact cannot change the measurement', async (t) => {
  const { dataDir, sessionsDir } = makeEnv(t);
  const before = await runScoreboard({ dataDir });
  writeFileSync(path.join(sessionsDir, 'syn-qa-claude', 'kv', 'STREAM_ROLES.json'), JSON.stringify({
    schema: 'capture-studio.stream-roles/1', classifier: { version: 0 },
    streams: [{ sid: 's-1', role: 'asset', roleConfidence: 'high', roleEvidence: [{ feature: 'asset_media_type', count: 1 }] }],
  }));
  const after = await runScoreboard({ dataDir });
  assert.deepEqual(after.report.aggregate.measures.role, before.report.aggregate.measures.role);
  assert.deepEqual(at(after.report, 'syn-qa-claude').role, at(before.report, 'syn-qa-claude').role);
});

test('role aggregation and stability are measured when the fields exist', () => {
  const entry = {
    ref: 'aaaaaaaaaa', status: 'ok', sessionStatus: 'complete', siteHost: null, derivedKnowledge: true, family: null,
    rawRecords: 0, corruptRecords: 0, streams: 4, streamBytes: 400,
    framing: { transport: { HTTP_SSE: 4 }, transportDetail: { HTTP_SSE: 4 } },
    framingBytes: { transport: { HTTP_SSE: 400 }, transportDetail: { HTTP_SSE: 400 } },
    role: {
      fieldPresent: true, labeled: 2, labeledWithEvidence: 2, unlabeled: 2,
      labeledBytes: 300, bytesWithEvidence: 300,
      distribution: { 'chat-reply': 2, unknown: 1 }, distributionBytes: { 'chat-reply': 300, unknown: 60 },
      dispositions: { specific: 2, unknown: 1, truncated: 1 }, dispositionBytes: { specific: 300, unknown: 60, truncated: 40 },
      confidence: { medium: 1, high: 1 }, eventsOmitted: 7,
    },
    dialectState: { field: 4, fallback: 0, counts: { 'known-delta': 4 }, bytes: { 'known-delta': 400 } },
    streamMap: { mapId: 'chatgpt-path-ops', mapIds: ['chatgpt-path-ops'], mappedStreams: 2, unmappedEvents: 1, errorSignals: 0 },
  };
  const stability = roleStability([
    { session: 'a', endpoints: [{ endpoint: 'e1', role: 'chat-reply' }, { endpoint: 'e2', role: 'chat-reply' }] },
    { session: 'b', endpoints: [{ endpoint: 'e1', role: 'chat-reply' }, { endpoint: 'e2', role: 'config' }] },
    { session: 'c', endpoints: [{ endpoint: 'e3', role: null }] },
  ]);
  const agg = aggregate([entry], stability, { store: { stateFilePresent: false } }, { roleFieldPresent: true });
  const m = agg.measures;
  assert.equal(m.role.field_present, true);
  assert.equal(m.role.streamsLabeled, 2);
  assert.equal(m.role.labeledStreamShare, 0.5);
  assert.equal(m.role.labeledByteShare, 0.75);
  assert.equal(m.role.streamShare, 0.5, 'only roles with evidence count towards coverage');
  assert.equal(m.role.byteShare, 0.75);
  assert.deepEqual(m.role.distribution, { 'chat-reply': 2, unknown: 1 });
  assert.deepEqual(m.role.distributionBytes, { 'chat-reply': 300, unknown: 60 });
  assert.equal(m.role.streamsUnknown, 1);
  assert.equal(m.role.streamsTruncated, 1);
  assert.equal(m.role.unknownBytes, 60);
  assert.equal(m.role.truncatedBytes, 40);
  assert.equal(m.role.eventsOmitted, 7);
  assert.deepEqual(m.role.confidence, { medium: 1, high: 1 });
  assert.equal(stability.endpointsMultiSession, 2);
  assert.equal(stability.endpointsComparable, 2);
  assert.equal(stability.endpointsStable, 1);
  assert.equal(stability.stabilityShare, 0.5, 'e1 agrees across sessions, e2 does not');
  assert.equal(stability.endpointsExcludedMissingRole, 0, 'e3 was seen in one session only');
  assert.equal(stability.endpointsExcludedUnstableWithinSession, 0);
  assert.equal(m.dialectState.sourceFieldSessions, 1);
  assert.equal(m.streamMap.sessionsWithMap, 1);
  assert.equal(m.streamMap.unmappedEvents, 1);
});

test('roleOfStream reads role, evidence, specificity, truncation and ordinal confidence defensively', () => {
  const none = {
    fieldPresent: false, role: null, hasRole: false, hasEvidence: false, specific: false, truncated: false, omittedEvents: 0, confidence: 'none',
    hasCoverage: false, fullyInspected: null, inspectionCut: null, withheldRole: null, rawSpecific: false, classifierTruncatedEvidence: false,
  };
  assert.deepEqual(roleOfStream({}), none);
  assert.deepEqual(roleOfStream({ role: '  ' }), { ...none, fieldPresent: true });
  assert.deepEqual(roleOfStream({ role: 'chat-reply', roleConfidence: 'high', roleEvidence: [{ feature: 'json_events', count: 1 }] }),
    { ...none, fieldPresent: true, role: 'chat-reply', hasRole: true, hasEvidence: true, specific: true, confidence: 'high', rawSpecific: true });
  // coverage: absent -> null (never assumed complete); present -> exactly what the classifier said
  const withCov = roleOfStream({ role: 'chat-reply', roleConfidence: 'medium', roleCoverage: { fullyInspected: true, inspectionCut: false, withheldRole: null } });
  assert.deepEqual([withCov.hasCoverage, withCov.fullyInspected, withCov.inspectionCut], [true, true, false]);
  const held = roleOfStream({ role: 'unknown', roleConfidence: 'none', roleCoverage: { fullyInspected: false, inspectionCut: true, withheldRole: 'history-load' }, roleEvidence: [{ feature: 'inspection_truncated', count: 2 }] });
  assert.equal(held.specific, false, 'a withheld candidate is not a specific role');
  assert.equal(held.rawSpecific, true, 'but it is a raw specific candidate');
  assert.equal(held.withheldRole, 'history-load');
  assert.equal(held.classifierTruncatedEvidence, true);
  assert.equal(roleDisposition(held), 'withheld');
  assert.equal(roleOfStream({ role: 'unknown', roleCoverage: { withheldRole: 'secret-role' } }).withheldRole, null, 'only vocabulary roles pass');
  assert.equal(roleOfStream({ role: 'config', roleEvidence: [] }).hasEvidence, false);
  assert.equal(roleOfStream({ role: 'unknown', roleConfidence: 'none' }).specific, false, 'unknown is not a specific role');
  assert.equal(roleOfStream({ role: 'unknown' }).hasRole, true, 'but it is a present, explicit answer');
  assert.equal(roleOfStream({ role: 'assistant' }).specific, false, 'the old conversational vocabulary is not a classifier role');
  assert.equal(roleOfStream({ role: 'config', roleConfidence: 0.93 }).confidence, 'none', 'a probability-looking value is not an ordinal level');
  const cut = roleOfStream({ role: 'config', eventsOnlyOnDisk: 5 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.omittedEvents, 5);
  assert.equal(roleDisposition(cut), 'truncated');
  assert.equal(roleDisposition(roleOfStream({ role: 'config' })), 'specific');
  assert.equal(roleDisposition(roleOfStream({ role: 'unknown' })), 'unknown');
  assert.equal(roleDisposition(roleOfStream({})), 'absent');
});

// The five states: a delta dialect name wins; unapplied deltas are unknown-delta; plain JSON with no
// delta evidence is static; anything with no JSON evidence (heartbeats, undecoded frames, nothing at
// all) is opaque and never claims to be static.
test('dialectStateOf prefers the summary field, names known dialects and never fakes static', () => {
  assert.deepEqual(dialectStateOf({ dialectState: 'snapshot', deltaDialects: [] }, []), { state: 'snapshot', source: 'field' });
  assert.deepEqual(dialectStateOf({ dialectState: 'nonsense' }, [{ json: {} }]), { state: 'static', source: 'fallback' });
  assert.deepEqual(dialectStateOf({ deltaDialects: ['path-ops'], deltaUnapplied: 0 }, [{ json: {} }]),
    { state: 'known-delta', source: 'fallback' });
  assert.deepEqual(dialectStateOf({ deltaDialects: ['json-patch'], deltaUnapplied: 0 }, [{ json: {} }]),
    { state: 'known-delta', source: 'fallback' }, 'json-patch and dotted-set are applied dialects too');
  assert.deepEqual(dialectStateOf({ deltaDialects: ['path-ops'], deltaUnapplied: 2 }, [{ json: {} }]),
    { state: 'known-delta', source: 'fallback' }, 'a named dialect stays named even when some deltas did not apply');
  assert.deepEqual(dialectStateOf({ deltaDialects: [], deltaUnapplied: 2 }, [{ json: {} }]),
    { state: 'unknown-delta', source: 'fallback' }, 'unclassified incremental JSON');
  assert.deepEqual(dialectStateOf({ deltaDialects: ['made-up-dialect'], deltaUnapplied: 0 }, [{ json: {} }]),
    { state: 'unknown-delta', source: 'fallback' });
  assert.deepEqual(dialectStateOf({ deltaDialects: [], deltaUnapplied: 0 }, [{ json: {} }]),
    { state: 'static', source: 'fallback' }, 'plain JSON, no delta evidence');
  assert.deepEqual(dialectStateOf({ deltaDialects: [], deltaUnapplied: 0 }, [{ k: 'heartbeat' }]),
    { state: 'opaque', source: 'fallback' }, 'a heartbeat is not JSON evidence');
  assert.deepEqual(dialectStateOf({ deltaDialects: [], deltaUnapplied: 0 }, []),
    { state: 'opaque', source: 'fallback' }, 'no events is not a static claim');
});

test('the output carries no reply text, DOM text, URL path, query, title, session id or file name', async (t) => {
  const { dataDir, root } = makeEnv(t);
  const { report } = await runScoreboard({ dataDir });
  const text = allText(report);
  for (const phrase of FORBIDDEN) assert.equal(text.includes(phrase), false, `report leaks "${phrase}"`);
  assert.equal(text.includes(REGISTRABLE), true, 'the registrable host is reported');
  assert.equal(text.includes(root), false, 'the data directory path is not reported');
  const r = cli(['--data-dir', dataDir]);
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.schema, 'capture-studio.categorization-scoreboard/1');
  for (const phrase of FORBIDDEN) {
    assert.equal(r.stdout.includes(phrase), false, `stdout leaks "${phrase}"`);
    assert.equal(r.stderr.includes(phrase), false, `stderr leaks "${phrase}"`);
  }
  assert.equal(r.stdout.includes(dataDir), false, 'stdout must not carry the data directory path');
});

test('labels are bounded enums: a private family or status name becomes "other" and is never echoed', async (t) => {
  const { dataDir, sessionsDir } = makeEnv(t);
  writeSession(sessionsDir, 'syn-qa-private', { payloads: openaiPayloads, status: PRIVATE_STATUS, family: PRIVATE_FAMILY });
  const { report } = await runScoreboard({ dataDir });
  const priv = at(report, 'syn-qa-private');
  assert.equal(priv.sessionStatus, 'other', 'an unknown session status is labelled other');
  assert.equal(priv.family.verdict, 'other', 'an unknown family name is labelled other');
  assert.equal(priv.family.score, 0.8, 'the score is still reported');
  const text = allText(report);
  assert.equal(text.includes(PRIVATE_FAMILY), false);
  assert.equal(text.includes(PRIVATE_STATUS), false);
  assert.equal(familyLabel('ai-chat'), 'ai-chat');
  assert.equal(familyLabel(PRIVATE_FAMILY), 'other');
  assert.equal(statusLabel('complete'), 'complete');
  assert.equal(statusLabel(PRIVATE_STATUS), 'other');
  assert.equal(roleLabel('chat-reply'), 'chat-reply');
  assert.equal(roleLabel('unknown'), 'unknown');
  assert.equal(roleLabel('assistant'), 'other');
  assert.equal(roleLabel('SENTqx7 privaterole/path'), 'other');
  assert.equal(framingLabel('HTTP_SSE'), 'HTTP_SSE');
  assert.equal(framingLabel('SENTqx7PRIVATE'), 'other');
  assert.equal(framingLabel('WEBSOCKET_JSON'), 'WEBSOCKET_JSON');
  assert.equal(mapLabel('chatgpt-path-ops'), 'chatgpt-path-ops');
  assert.equal(mapLabel('SENTqx7-private-map'), 'other');
  assert.deepEqual([...STREAM_ROLES], ['chat-reply', 'history-load', 'config', 'telemetry', 'push-presence', 'asset', 'auth', 'unknown']);
  assert.equal(SESSION_STATUSES.includes('recording'), true);
});

test('no file in the data directory changes (in-process and CLI); the check is stat, not a content hash', async (t) => {
  const { dataDir } = makeEnv(t);
  const before = listTree(dataDir);
  const { report, changes } = await runScoreboard({ dataDir });
  assert.deepEqual(changes, []);
  const w = report.safety.writeCheck;
  assert.equal(report.safety.readOnly, true);
  assert.equal(w.method, 'stat');
  assert.equal(w.contentHashVerified, false, 'metadata only, never a content proof');
  assert.equal(w.metadataUnchanged, true);
  assert.equal(w.added, 0);
  assert.equal(w.removed, 0);
  assert.equal(w.modified, 0);
  assert.ok(w.entriesSnapshotted > 0);
  assert.deepEqual(listTree(dataDir), before);
  const r = cli(['--data-dir', dataDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listTree(dataDir), before);
});

test('an external write during the read is counted but does not abort the scoreboard', async (t) => {
  const { dataDir } = makeEnv(t);
  const before = listTree(dataDir);
  const touched = path.join(dataDir, 'sessions', 'syn-qa-claude', 'kv', 'DERIVE_TMP.json');
  const { report, changes } = await runScoreboard({
    dataDir,
    _testHookAfterRead: () => writeFileSync(touched, '{}'),
  });
  assert.equal(report.safety.writeCheck.metadataUnchanged, false);
  assert.equal(report.safety.writeCheck.added, 1, 'the new file');
  assert.equal(report.safety.writeCheck.modified, 1, 'the kv/ directory mtime moved');
  assert.equal(report.safety.writeCheck.contentHashVerified, false);
  // Two entries move: the new file (added) and its parent directory (mtime modified).
  assert.equal(report.safety.externalChanges, changes.length);
  assert.deepEqual(changes.map((c) => c.change).sort(), ['added', 'modified']);
  assert.equal('changes' in report.safety || 'changes' in report.safety.writeCheck, false,
    'no path or file name is reported');
  assert.equal(report.sessions.length, 4, 'a changed folder does not lose the report');
  rmSync(touched, { force: true });
  const filesOnly = (tree) => tree.filter(([p]) => p.includes('.')).map(([p, kind, size]) => [p, kind, size]);
  assert.deepEqual(filesOnly(listTree(dataDir)), filesOnly(before));
});

test('the learner store is read from the configured path with its journal schema, counts only', async (t) => {
  const { dataDir } = makeEnv(t);
  const direct = readLearnerState(dataDir);
  assert.deepEqual(direct.store, { configuredDirPresent: true, stateFilePresent: true, unreadable: false });
  assert.equal(direct.priorsSource, 'builtin-in-memory', 'priors are in-memory priors, not this file');
  assert.equal(direct.revision, 3, 'the journal revision, not an invented one');
  assert.equal(direct.corrections, 3);
  assert.equal(direct.correctionsActive, 2);
  assert.equal(direct.correctionsReverted, 1);
  assert.equal(direct.proposals, 3);
  assert.equal(direct.proposalsPending, 1, 'pending means status "proposed", exactly as the CLI counts it');
  assert.equal(direct.audit, 1);
  assert.equal(direct.models, 1);
  assert.equal(direct.globalLearned, 1);
  assert.equal(direct.overrides, 1);
  assert.equal(direct.calibrationKinds, 1);
  assert.equal(direct.calibrationSamples, 3);
  const { report } = await runScoreboard({ dataDir });
  assert.equal(report.aggregate.measures.learner.store.stateFilePresent, true);
  assert.equal(JSON.stringify(report).includes(LEARNER_SENTINEL), false);
  // No store: the directory is simply absent; nothing is created and nothing is invented.
  const missing = path.join(dataDir, 'no-such-store');
  const empty = readLearnerState(missing);
  assert.deepEqual(empty.store, { configuredDirPresent: false, stateFilePresent: false, unreadable: false });
  assert.equal(empty.revision, 0);
  assert.equal(existsSync(path.join(missing, 'learner')), false);
});

test('--out inside the data directory is refused', async (t) => {
  const { dataDir, sessionsDir } = makeEnv(t);
  const inside = path.join(sessionsDir, 'scoreboard.json');
  await assert.rejects(runScoreboard({ dataDir, out: inside }), /inside the data directory/);
  assert.equal(existsSync(inside), false);
  const r = cli(['--data-dir', dataDir, '--out', inside]);
  assert.equal(r.status, 2);
  assert.equal(existsSync(inside), false);
});

test('--sessions measures the named folders only', async (t) => {
  const { dataDir } = makeEnv(t);
  const { report } = await runScoreboard({ dataDir, sessions: ['syn-qa-claude'] });
  assert.equal(report.sessions.length, 1);
  assert.equal(report.selection.explicit, true);
  assert.equal(report.sessions[0].streamMap.mapId, 'claude-typed-events');
});

test('--compare reports per-measure deltas against an earlier report', (t) => {
  const { dataDir, outDir, sessionsDir } = makeEnv(t);
  const beforeFile = path.join(outDir, 'before.json');
  const r1 = cli(['--data-dir', dataDir, '--out', beforeFile]);
  assert.equal(r1.status, 0, r1.stderr);
  const first = JSON.parse(readFileSync(beforeFile, 'utf8'));

  // Identical run: every delta is zero.
  const sameFile = path.join(outDir, 'same.json');
  const r2 = cli(['--data-dir', dataDir, '--out', sameFile, '--compare', beforeFile]);
  assert.equal(r2.status, 0, r2.stderr);
  const same = JSON.parse(readFileSync(sameFile, 'utf8'));
  assert.equal(same.comparison.changed, 0);
  assert.ok(same.comparison.comparedPaths > 0);
  assert.match(r2.stderr, /comparison: 0 of \d+ numeric measures changed/);

  // Drop one session: the session totals and the per-measure counts move.
  rmSync(path.join(sessionsDir, 'syn-qa-openai'), { recursive: true, force: true });
  const afterFile = path.join(outDir, 'after.json');
  const r3 = cli(['--data-dir', dataDir, '--out', afterFile, '--compare', beforeFile]);
  assert.equal(r3.status, 0, r3.stderr);
  const after = JSON.parse(readFileSync(afterFile, 'utf8'));
  assert.ok(after.comparison.changed > 1);
  const total = after.comparison.deltas.find((d) => d.path === 'sessions.total');
  assert.deepEqual([total.before, total.after, total.delta], [4, 3, -1]);
  // A label that disappears from a label-keyed map has no numeric delta, only before/after.
  assert.ok(after.comparison.deltas.every((d) => (d.delta === null ? d.before === null || d.after === null : typeof d.delta === 'number')));
  assert.ok(after.comparison.deltas.some((d) => d.delta === null), 'the dropped session loses its map label');
  assert.ok(after.comparison.deltas.every((d) => !String(d.path).includes('generatedAt')));
  assert.match(r3.stderr, /comparison: \d+ of \d+ numeric measures changed/);

  // compareReports is also usable in-process.
  const cmp = compareReports(first, after);
  assert.ok(cmp.deltas.some((d) => d.path === 'measures.framing.streams.transportDetail.HTTP_SSE' && d.delta === -1));
});

test('an unreadable --compare file and a missing data directory are errors, not crashes', async (t) => {
  const { dataDir, outDir } = makeEnv(t);
  const r = cli(['--data-dir', dataDir, '--compare', path.join(outDir, 'nope.json')]);
  assert.equal(r.status, 1);
  await assert.rejects(runScoreboard({ dataDir: path.join(outDir, 'no-data-dir') }), GuardError);
  assert.equal(existsSync(path.join(outDir, 'no-data-dir')), false);
});

test('summary labels role stability counts as counts and the share as a ratio', async (t) => {
  const { dataDir } = makeEnv(t);
  const { report } = await runScoreboard({ dataDir });
  report.aggregate.measures.roleStability = {
    endpointsMultiSession: 405, endpointsComparable: 18, endpointsStable: 18, stabilityShare: 1,
    endpointsExcludedMissingRole: 387, endpointsExcludedUnstableWithinSession: 0,
  };
  const line = renderSummary(report).split('\n').find((l) => l.startsWith('role stability:'));
  assert.equal(line, 'role stability: 18/18 comparable multi-session endpoints stable (ratio 1; 405 seen in 2+ sessions)');
  assert.equal(/\b1 of 18\b/.test(line), false, 'a ratio is never printed as a count');
});

// ---- coverage honesty ----------------------------------------------------------------------------
const nestW = (o, n) => { let x = o; for (let i = 0; i < n; i++) x = { w: x }; return x; };
const CUT_PAYLOADS = [
  { messages: [{ role: 'user', content: 'a question' }, { role: 'assistant', content: 'an answer' }] },
  { type: 'message_start', message: { id: 'm-cut', role: 'assistant', content: [] } },
  ...Array.from({ length: 6 }, (_, i) => nestW({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `piece-${i} ` } }, 6)),
];

test('replay coverage: a stream whose inspection was cut is withheld; raw and fully inspected specific coverage are reported apart', async (t) => {
  const { dataDir, sessionsDir } = makeEnv(t);
  writeSession(sessionsDir, 'syn-qa-cut', { payloads: CUT_PAYLOADS });
  const { report } = await runScoreboard({ dataDir, sessions: ['syn-qa-cut', 'syn-qa-claude'] });
  const cut = at(report, 'syn-qa-cut').role;
  assert.deepEqual(cut.dispositions, { withheld: 1 });
  assert.equal(cut.labeled, 0, 'a withheld candidate is not a label');
  assert.equal(cut.rawSpecific, 1);
  assert.equal(cut.fullyInspectedSpecific, 0);
  assert.equal(cut.inspectionCutUnknown, 1);
  assert.deepEqual(cut.distribution, {}, 'no role label is reported for it');
  const ok = at(report, 'syn-qa-claude').role;
  assert.equal(ok.fullyInspectedSpecific, 1);
  assert.equal(ok.rawSpecific, 1);
  const m = report.aggregate.measures.role;
  assert.equal(m.streams, 2);
  assert.equal(m.streamsRawSpecific, 2);
  assert.equal(m.streamsFullyInspectedSpecific, 1);
  assert.equal(m.streamsWithheld, 1);
  assert.equal(m.streamsInspectionCutUnknown, 1);
  assert.equal(m.streamsRawSpecific - m.streamsFullyInspectedSpecific, m.streamsWithheld, 'the gap is exactly what incomplete inspection cost');
  assert.equal(m.rawSpecificByteShare > m.fullyInspectedSpecificByteShare, true);
  assert.equal(m.withheldBytes > 0 && m.inspectionCutUnknownBytes === m.withheldBytes, true);
  // both sessions fetch the same endpoint: one fully inspected specific observation out of two -> "some"
  assert.equal(m.endpointCoverage.distinctEndpoints, 1);
  assert.equal(m.endpointCoverage.endpointsSomeFullyInspectedSpecific, 1);
  assert.equal(m.endpointCoverage.endpointsAllFullyInspectedSpecific, 0);
  const text = renderSummary(report);
  assert.match(text, /role coverage honesty: raw specific candidates 2\/2/);
  assert.match(text, /fully inspected specific 1 /);
  assert.match(text, /withheld for incomplete inspection 1 streams/);
  for (const phrase of FORBIDDEN) assert.equal(JSON.stringify(report).includes(phrase), false, phrase);
});

test('origin context is computed per stream against its own session target, never inherited from another session', async (t) => {
  const { dataDir, sessionsDir } = makeEnv(t);
  const SHARED = 'https://stream-only-host.test/api-sentinel-path?q=secret';
  writeSession(sessionsDir, 'syn-qa-oa', { payloads: claudePayloads, streamUrl: SHARED, targetUrl: 'https://stream-only-host.test/app' });
  writeSession(sessionsDir, 'syn-qa-ob', { payloads: claudePayloads, streamUrl: SHARED, targetUrl: 'https://first-tab.qa-fixture.test/x' });
  writeSession(sessionsDir, 'syn-qa-oc', { payloads: claudePayloads, streamUrl: 'https://cdn.first-tab.qa-fixture.test/y', targetUrl: 'https://first-tab.qa-fixture.test/x' });
  writeSession(sessionsDir, 'syn-qa-od', { payloads: claudePayloads, streamUrl: SHARED, targetUrl: null });
  const { report } = await runScoreboard({ dataDir, sessions: ['syn-qa-oa', 'syn-qa-ob', 'syn-qa-oc', 'syn-qa-od'] });
  const cls = (id) => Object.keys(at(report, id).role.byOriginClass);
  assert.deepEqual(cls('syn-qa-oa'), ['same-host']);
  assert.deepEqual(cls('syn-qa-ob'), ['different-registrable'], 'the very same stream host is a different class in another session');
  assert.deepEqual(cls('syn-qa-oc'), ['same-registrable']);
  assert.deepEqual(cls('syn-qa-od'), ['no-target-context']);
  const agg = report.aggregate.measures.role.byOriginClass;
  assert.deepEqual(Object.keys(agg).sort(), ['different-registrable', 'no-target-context', 'same-host', 'same-registrable']);
  for (const tab of Object.values(agg)) { assert.equal(tab.streams, 1); assert.equal(tab.fullyInspectedSpecific, 1); }
  const text = JSON.stringify(report);
  for (const leak of ['api-sentinel-path', 'secret', 'cdn.first-tab', 'first-tab.qa-fixture.test/x']) assert.equal(text.includes(leak), false, leak);
  for (const k of Object.keys(agg)) assert.ok(ORIGIN_CLASSES.includes(k));
});

test('binary streams are tallied by structural kind and never get a role from it', async (t) => {
  const { dataDir, sessionsDir } = makeEnv(t);
  // undecoded octet-stream bytes (control characters): opaque, JSON-free
  writeSession(sessionsDir, 'syn-qa-bin', { chunks: ['\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007'.repeat(8)], mime: 'application/octet-stream' });
  const { report } = await runScoreboard({ dataDir, sessions: ['syn-qa-bin'] });
  const bin = at(report, 'syn-qa-bin').role;
  assert.equal(bin.rawSpecific, 0);
  assert.equal(bin.labeled, 0);
  assert.deepEqual(Object.keys(bin.binaryKinds), ['opaque']);
  assert.equal(report.aggregate.measures.role.binaryKinds.opaque, 1);
  assert.equal(report.aggregate.measures.role.binaryKindBytes.opaque > 0, true);
  // aggregate-level: a structural count merges, and is not a role
  const entry = { ...at(report, 'syn-qa-bin'), role: { ...bin, binaryKinds: { structural: 2, opaque: 1 }, binaryKindBytes: { structural: 50, opaque: 10 } } };
  const m = aggregate([entry], roleStability([]), { store: { stateFilePresent: false } }, { roleFieldPresent: true }).measures.role;
  assert.deepEqual(m.binaryKinds, { structural: 2, opaque: 1 });
  assert.equal(m.streamsRawSpecific, 0);
});

test('originContextOf: exact host, registrable host, different, and the two missing-context classes', () => {
  assert.equal(originContextOf('https://a.example.test/p', 'https://a.example.test/q'), 'same-host');
  assert.equal(originContextOf('https://cdn.example.test/p', 'https://a.example.test/q'), 'same-registrable');
  assert.equal(originContextOf('https://other.test/p', 'https://a.example.test/q'), 'different-registrable');
  assert.equal(originContextOf('https://a.example.test/p', undefined), 'no-target-context');
  assert.equal(originContextOf('https://a.example.test/p', 'not a url'), 'no-target-context');
  assert.equal(originContextOf(undefined, 'https://a.example.test/q'), 'no-stream-url');
  assert.equal(originContextOf('', ''), 'no-stream-url');
});

test('endpoint-deduplicated coverage: repeated huge fetches of one endpoint do not dominate', () => {
  const big = (session) => ({ session, endpoints: [{ endpoint: 'big', bytes: 5_000_000, fullySpecific: true, rawSpecific: true }] });
  const small = { session: 's0', endpoints: [
    { endpoint: 'e1', bytes: 100, fullySpecific: false, rawSpecific: false },
    { endpoint: 'e2', bytes: 100, fullySpecific: false, rawSpecific: true },
    { endpoint: 'e3', bytes: 100, fullySpecific: true, rawSpecific: true },
    { endpoint: 'e3', bytes: 100, fullySpecific: false, rawSpecific: false },
  ] };
  const cov = endpointCoverage([...Array.from({ length: 10 }, (_, i) => big(`b${i}`)), small]);
  assert.equal(cov.distinctEndpoints, 4);
  assert.equal(cov.endpointsAllFullyInspectedSpecific, 1);
  assert.equal(cov.endpointsSomeFullyInspectedSpecific, 1);
  assert.equal(cov.endpointsNoFullyInspectedSpecific, 2);
  assert.equal(cov.endpointsWithRawSpecificCandidate, 3);
  assert.equal(cov.shareAnyFullyInspectedSpecific, 0.5, 'by endpoint, half; by bytes it would be ~99.9%');
  assert.equal(cov.topEndpointByteShare > 0.99, true, 'the concentration is reported so the gap is explainable');
  assert.equal(cov.sessionEndpointUnits, 10 + 3);
  assert.equal(cov.sessionEndpointUnitsWithFullyInspectedSpecific, 11);
  assert.deepEqual(endpointCoverage([]).distinctEndpoints, 0);
  assert.equal(endpointCoverage([]).shareAnyFullyInspectedSpecific, null);
});

test('host and endpoint identity helpers never return content', () => {
  assert.equal(registrableHost('sentinel-sub.qa-fixture.test'), REGISTRABLE);
  assert.equal(registrableHost('chat.example.co.uk'), 'example.co.uk');
  assert.equal(registrableHost('10.1.2.3'), 'ip-literal');
  assert.equal(registrableHost('::1'), 'ip-literal');
  assert.equal(registrableHost(''), null);
  const a = endpointHash('POST', 'https://x.test/a/1?q=1');
  const b = endpointHash('POST', 'https://x.test/a/2?q=2');
  const c = endpointHash('GET', 'https://x.test/a/1?q=1');
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.equal(a, b, 'the same url template hashes the same');
  assert.notEqual(a, c, 'the method is part of the identity');
  assert.match(sessionRef('syn-qa-chatgpt'), /^[0-9a-f]{10}$/);
  assert.notEqual(sessionRef('syn-qa-chatgpt'), 'syn-qa-chatgpt');
  assert.equal(familyBucket(0.8), '[0.75,1]');
  assert.equal(familyBucket(0), '0');
  assert.equal(familyBucket(null), null);
});
