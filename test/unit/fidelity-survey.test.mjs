// Read-only fidelity survey: synthetic sessions built from the committed ai-chat-dialects fixtures
// in a temp data directory. Nothing here touches the owner's real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SseDecoder } from '../../src/decode/decoders.mjs';
import { TOOL_ROOT } from '../../src/config.mjs';
import {
  runSurvey, assertNotRepoCheckout, diffSnapshots, reasonLabel, GuardError, UsageError,
  diagnoseAssistantTurns,
} from '../../scripts/fidelity-survey.mjs';
import { joinStreamToDom } from '../../src/intel/join.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', '..', 'scripts', 'fidelity-survey.mjs');
const FIXTURES = path.join(here, '..', 'fixtures', 'ai-chat-dialects');
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

const QUERY_TOKEN = 'SYN-QUERY-TOKEN-123';
const URL_WITH_QUERY = `https://chat.example.test/backend-api/conversation?token=${QUERY_TOKEN}`;
// Distinctive reply/prompt words that must never appear in the serialized report.
const FORBIDDEN = ['Hello from', 'made-up', 'Synthetic block', 'Second sentence', 'Responses reply',
  'Synthetic user prompt', 'syn-msg', QUERY_TOKEN, 'backend-api', '/c/'];

// Same SSE rendering as test/unit/ai-chat-dialects.test.mjs.
function toSse(payloads) {
  return payloads.map((p) => {
    if (typeof p === 'string') return `data: ${p}\n\n`;
    const ev = typeof p.type === 'string' ? `event: ${p.type}\n` : '';
    return `${ev}data: ${JSON.stringify(p)}\n\n`;
  }).join('');
}

const chatgptPayloads = load('chatgpt-pathops.json').payloads;
const claudePayloads = load('claude-typedevents.json').payloads;
const openaiPayloads = load('openai-responses.json').payloads;

const CHATGPT_TEXT = ['Hello from ', 'a made-up ', 'synthetic ', 'stream. ', 'Second sentence.'].join('');
const claudeBlock = (idx) => claudePayloads
  .filter((p) => p.type === 'content_block_delta' && p.index === idx)
  .map((p) => p.delta.text).join('');
const CLAUDE_TEXT = [claudeBlock(0), claudeBlock(1)].join('\n\n');
const OPENAI_TEXT = openaiPayloads.filter((p) => p.type === 'response.output_text.delta').map((p) => p.delta).join('');

const turn = (index, id, role, text, blocks = [{ ord: 0, type: 'paragraph', text }]) => ({
  index, id, domId: `dom-${id}`, role, text, blocks,
});

function writeSession(sessionsDir, id, { payloads, domTurns = null, blank = false }) {
  const dir = path.join(sessionsDir, id);
  mkdirSync(path.join(dir, 'raw'), { recursive: true });
  mkdirSync(path.join(dir, 'kv'), { recursive: true });
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    id, site: 'synthetic', createdAt: '2026-01-01T00:00:00.000Z', status: 'complete', target: { url: URL_WITH_QUERY },
  }, null, 2));
  const sid = 's-1';
  const recs = [
    { seq: 1, t: 1000, k: 'req', sid, url: URL_WITH_QUERY, method: 'POST', type: 'Fetch' },
    { seq: 2, t: 1010, k: 'res', sid, status: 200, mime: 'text/event-stream' },
    { seq: 3, t: 1020, k: 'chunk', sid, b64: Buffer.from(toSse(payloads), 'utf8').toString('base64') },
    { seq: 4, t: 1030, k: 'done', sid, encodedDataLength: 1 },
  ];
  if (!blank) writeFileSync(path.join(dir, 'raw', '000001.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (domTurns) writeFileSync(path.join(dir, 'kv', 'DOM_TURNS.json'), JSON.stringify(domTurns, null, 2));
}

function makeEnv(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fidelity-survey-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeSession(sessionsDir, 'syn-chatgpt', {
    payloads: chatgptPayloads,
    domTurns: [turn(0, 'u1', 'user', 'Synthetic user prompt'), turn(1, 'a1', 'assistant', CHATGPT_TEXT)],
  });
  writeSession(sessionsDir, 'syn-claude', {
    payloads: claudePayloads,
    domTurns: [turn(0, 'u2', 'user', 'Synthetic user prompt'),
      turn(1, 'a2', 'assistant', CLAUDE_TEXT, [
        { ord: 0, type: 'paragraph', text: claudeBlock(0) },
        { ord: 1, type: 'paragraph', text: claudeBlock(1) },
      ])],
  });
  writeSession(sessionsDir, 'syn-openai', {
    payloads: openaiPayloads,
    domTurns: [turn(0, 'a3', 'assistant', OPENAI_TEXT)],
  });
  // Corrupt: session.json is not JSON.
  const bad = path.join(sessionsDir, 'syn-zz-corrupt');
  mkdirSync(bad, { recursive: true });
  writeFileSync(path.join(bad, 'session.json'), '{"id": ');
  return { root, sessionsDir };
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
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 });
}

const byId = (report) => Object.fromEntries(report.sessions.map((s) => [s.id, s]));

test('fixtures: each synthetic session reports the expected map id and dialect', async (t) => {
  const { root } = makeEnv(t);
  const { report, writeDetected } = await runSurvey({ dataDir: root, all: true });
  assert.deepEqual(writeDetected, []);
  const s = byId(report);
  assert.equal(s['syn-chatgpt'].status, 'ok');
  assert.equal(s['syn-chatgpt'].mapId, 'chatgpt-path-ops');
  assert.ok(s['syn-chatgpt'].dialects['path-ops'] >= 1);
  assert.equal(s['syn-claude'].mapId, 'claude-typed-events');
  assert.ok(s['syn-claude'].dialects['typed-events'] >= 1);
  assert.equal(s['syn-openai'].mapId, 'openai-responses');
  assert.ok(s['syn-openai'].dialects['typed-events'] >= 1);
  assert.equal(s['syn-chatgpt'].siteHost, 'chat.example.test');
  assert.equal(s['syn-chatgpt'].complete, true);
  assert.equal(s['syn-chatgpt'].framings.HTTP_SSE, 1);
});

test('join: the assistant message with a matching DOM turn is verified', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSurvey({ dataDir: root, all: true });
  const s = byId(report);
  for (const id of ['syn-chatgpt', 'syn-claude', 'syn-openai']) {
    assert.ok(s[id].joinStatusCounts, `${id} joined`);
    assert.equal(s[id].joinStatusCounts.verified, 1, `${id} verified`);
  }
  assert.equal(s['syn-chatgpt'].domTurns, 2);
  assert.equal(s['syn-chatgpt'].assistantTextChars, CHATGPT_TEXT.length);
  // Block links need stream blocks. Claude typed-events streams carry two text blocks, so both link.
  // ChatGPT path-ops streams carry no stream blocks, so their DOM block stays unlinked (a known gap,
  // reported by the survey as blockLinkStatusCounts.unlinked_dom, not asserted as verified).
  assert.equal(s['syn-claude'].blockLinkStatusCounts.verified, 2);
});

test('the report (aggregate and per session) carries no reply text, query token or URL path', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSurvey({ dataDir: root, all: true });
  const text = JSON.stringify(report);
  for (const phrase of FORBIDDEN) assert.equal(text.includes(phrase), false, `report leaks "${phrase}"`);
  assert.equal(text.includes('chat.example.test'), true);
});

test('--json output from the CLI leaks no reply text either', (t) => {
  const { root } = makeEnv(t);
  const r = cli(['--data-dir', root, '--all', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, 'capture-studio.fidelity-survey/1');
  for (const phrase of FORBIDDEN) assert.equal(r.stdout.includes(phrase), false, `stdout leaks "${phrase}"`);
  assert.equal(r.stdout.includes(root), false, 'stdout must not carry the data directory path');
});

test('the data directory listing is identical before and after the survey (in-process and CLI)', async (t) => {
  const { root } = makeEnv(t);
  const before = listTree(root);
  const { report, writeDetected } = await runSurvey({ dataDir: root, all: true });
  assert.deepEqual(writeDetected, []);
  assert.equal(report.safety.writeDetected, false);
  assert.deepEqual(listTree(root), before);
  const r = cli(['--data-dir', root, '--all', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listTree(root), before);
});

test('--out inside the data directory is refused (in-process and CLI exit 2)', async (t) => {
  const { root } = makeEnv(t);
  const out = path.join(root, 'survey.json');
  await assert.rejects(runSurvey({ dataDir: root, all: true, out }), UsageError);
  assert.equal(existsSync(out), false);
  const r = cli(['--data-dir', root, '--all', '--out', out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /inside the data directory/);
  assert.equal(existsSync(out), false);
});

test('a corrupt session directory yields status error while the others still report', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSurvey({ dataDir: root, all: true });
  const s = byId(report);
  assert.equal(s['syn-zz-corrupt'].status, 'error');
  assert.equal(s['syn-zz-corrupt'].errorClass, 'SyntaxError');
  assert.equal(s['syn-chatgpt'].status, 'ok');
  assert.equal(s['syn-claude'].mapId, 'claude-typed-events');
  assert.equal(report.aggregate.sessionsError, 1);
  assert.equal(report.aggregate.sessionsOk, 3);
  assert.equal(report.aggregate.sessionsByMapId['openai-responses'], 1);
});

test('--limit caps the --all selection; a zero limit is a usage error', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSurvey({ dataDir: root, all: true, limit: 2 });
  assert.equal(report.sessions.length, 2);
  assert.equal(report.selection.limit, 2);
  const r = cli(['--data-dir', root, '--all', '--limit', '0']);
  assert.equal(r.status, 2);
});

test('--session surveys one folder; a path-like id is refused', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSurvey({ dataDir: root, session: 'syn-claude' });
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].mapId, 'claude-typed-events');
  await assert.rejects(runSurvey({ dataDir: root, session: '../escape' }), UsageError);
  await assert.rejects(runSurvey({ dataDir: root, session: 'syn-claude', all: true }), UsageError);
});

test('events are capped per stream and the evictions are reported as eventsOmitted', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSurvey({ dataDir: root, session: 'syn-chatgpt', eventCap: 2 });
  assert.ok(report.sessions[0].eventsOmitted > 0);
  assert.equal(report.sessions[0].status, 'ok');
});

test('a write made during the run is reported as WRITE DETECTED and no report is produced', async (t) => {
  const { root } = makeEnv(t);
  const result = await runSurvey({
    dataDir: root, all: true,
    _testHookAfterRead: (dataRoot) => writeFileSync(path.join(dataRoot, 'sessions', 'syn-claude', 'INJECTED.txt'), 'x'),
  });
  assert.equal(result.report, null);
  assert.ok(result.writeDetected.some((w) => w.path === 'syn-claude/INJECTED.txt' && w.change === 'added'));
});

test('snapshot diff reports added, removed and modified entries only', () => {
  const before = new Map([['a/x', { kind: 'file', size: 1, mtimeMs: 5 }], ['a/y', { kind: 'file', size: 1, mtimeMs: 5 }], ['a/z', { kind: 'file', size: 1, mtimeMs: 5 }]]);
  const after = new Map([['a/x', { kind: 'file', size: 1, mtimeMs: 5 }], ['a/y', { kind: 'file', size: 2, mtimeMs: 5 }], ['a/new', { kind: 'file', size: 0, mtimeMs: 1 }]]);
  assert.deepEqual(diffSnapshots(before, after), [
    { path: 'a/new', change: 'added' },
    { path: 'a/y', change: 'modified' },
    { path: 'a/z', change: 'removed' },
  ]);
  assert.deepEqual(diffSnapshots(before, before), []);
});

test('repository guard refuses the checkout and anything inside it, and accepts an outside folder', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fidelity-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeRepo = path.join(root, 'fake-repo');
  mkdirSync(path.join(fakeRepo, 'data'), { recursive: true });
  assert.throws(() => assertNotRepoCheckout(fakeRepo, { toolRoot: fakeRepo, gitRoots: [] }), GuardError);
  assert.throws(() => assertNotRepoCheckout(path.join(fakeRepo, 'data'), { toolRoot: fakeRepo, gitRoots: [] }), GuardError);
  assert.doesNotThrow(() => assertNotRepoCheckout(path.join(root, 'data'), { toolRoot: fakeRepo, gitRoots: [] }));
  assert.throws(() => assertNotRepoCheckout(TOOL_ROOT), GuardError);
});

test('runSurvey refuses to run against the repository checkout before reading anything', async () => {
  await assert.rejects(runSurvey({ dataDir: TOOL_ROOT, all: true }), GuardError);
});

test('a missing data directory is an error and is never created', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fidelity-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, 'nope');
  await assert.rejects(runSurvey({ dataDir: missing, all: true }), GuardError);
  assert.equal(existsSync(missing), false);
});

test('unmapped reason labels keep schema-shaped parts and redact anything else', () => {
  assert.equal(
    reasonLabel('no_rule_matched: type=content_block_delta event=- path=/message/content/parts/0 o=append'),
    'no_rule_matched: type=content_block_delta event=- path=/message/content/parts/0 o=append',
  );
  assert.equal(reasonLabel('no_rule_matched: type=Hello there world'), 'no_rule_matched: [redacted-shape]');
  assert.equal(reasonLabel('close_without_open'), 'close_without_open');
  assert.equal(reasonLabel(undefined), 'unknown');
});

// ---------------------------------------------------------------------------------------------
// --diagnose (join diagnostics). Synthetic reply words below must never reach the output.
// ---------------------------------------------------------------------------------------------
const DIAG_FORBIDDEN = ['quokka', 'lighthouse', 'marmalade', 'harbour', 'northern bay',
  'Gardening', 'tomatoes', 'compost', 'turn0search1', 'charts.example.test'];
const PRIVATE_USE = /[\uE000-\uF8FF]/;

// Clean reply: 48 whitespace tokens, so one changed token gives Dice 47/48-based 0.979 (near).
const DIAG_CLEAN = 'The quokka field guide notes that the lighthouse keepers logged marmalade tides every morning '
  + 'before dawn while the harbour charts were redrawn each spring after the winter storms passed through '
  + 'the northern bay where old ferries docked for repairs and the crew rested until the tide turned again';
// Stream form: a ChatGPT-style private-use citation attached to one word, and a markdown link whose
// rendered text is the DOM text. The current normalizer leaves U+E200-U+E202 in place.
const DIAG_STREAM_MARKED = DIAG_CLEAN
  .replace('tides every', 'tides\uE200cite\uE202turn0search1\uE201 every')
  .replace('the harbour charts', 'the [harbour charts](https://charts.example.test/a)');

// Claude-style typed events, one text block per entry (same shape as the fixture).
function claudeReplyPayloads(blockTexts) {
  const p = [{ type: 'message_start', message: { id: 'syn-msg-diag', type: 'message', role: 'assistant', content: [], stop_reason: null } }];
  blockTexts.forEach((text, i) => {
    p.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
    p.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } });
    p.push({ type: 'content_block_stop', index: i });
  });
  p.push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  p.push({ type: 'message_stop' });
  return p;
}

function addDiagSessions(root) {
  const sessionsDir = path.join(root, 'sessions');
  writeSession(sessionsDir, 'diag-marked', {
    payloads: claudeReplyPayloads([DIAG_STREAM_MARKED]),
    domTurns: [turn(0, 'u8', 'user', 'Synthetic user prompt'), turn(1, 'a8', 'assistant', DIAG_CLEAN)],
  });
  writeSession(sessionsDir, 'diag-unrelated', {
    payloads: claudeReplyPayloads([DIAG_CLEAN]),
    domTurns: [turn(0, 'a7', 'assistant', 'Gardening tomatoes compost bins shed')],
  });
  writeSession(sessionsDir, 'diag-no-reply', {
    payloads: [],
    domTurns: [turn(0, 'u9', 'user', 'Synthetic user prompt'), turn(1, 'a9', 'assistant', 'Some rendered reply')],
  });
}

const diagOf = (report, id) => byId(report)[id].turnDiagnostics;

test('--diagnose: a perfect match is exact_after_normalization with dice 1', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSurvey({ dataDir: root, session: 'syn-claude', diagnose: true });
  const [d] = diagOf(report, 'syn-claude');
  assert.equal(d.turnIndex, 1);
  assert.equal(d.blocks, 2);
  assert.equal(d.diagnosis, 'exact_after_normalization');
  assert.equal(d.bestMessage.diceScore, 1);
  assert.equal(d.bestMessage.lengthRatio, 1);
  assert.equal(d.bestMessage.commonPrefixChars, d.domChars);
  assert.equal(d.bestMessage.commonSuffixChars, d.domChars);
  assert.equal(d.bestMessage.streamFinal, true);
  assert.equal(d.bestMessage.streamChars, d.domChars);
  assert.equal(d.likelyCause, 'none_detected');
  assert.equal(d.messagesConsidered, 1);
  assert.equal(d.runnerUpScore, null);
});

test('--diagnose: private-use markers and markdown link syntax in the stream are seen as near with the right cause', async (t) => {
  const root = makeEnv(t).root;
  addDiagSessions(root);
  const { report } = await runSurvey({ dataDir: root, session: 'diag-marked', diagnose: true });
  const [d] = diagOf(report, 'diag-marked');
  assert.equal(d.diagnosis, 'near', 'one changed token out of 48 scores above NEAR_THRESHOLD, not exact');
  assert.ok(d.bestMessage.diceScore >= 0.95 && d.bestMessage.diceScore < 1);
  assert.equal(d.likelyCause, 'private_use_markers_in_stream_only');
  assert.equal(d.featureCounts.stream.privateUseChars, 3);
  assert.equal(d.featureCounts.dom.privateUseChars, 0);
  assert.equal(d.featureCounts.stream.markdownLinks, 1);
  assert.equal(d.featureCounts.dom.markdownLinks, 0);
  assert.equal(d.featureCounts.stream.zeroWidthChars, 0);
  // The join itself does not verify this pair (it reports near_match at best).
  assert.equal(report.sessions.find((s) => s.id === 'diag-marked').joinStatusCounts.verified, 0);
});

test('--diagnose: the local Dice copy agrees with the join near_match score', () => {
  const diag = diagnoseAssistantTurns(
    [{ role: 'assistant', text: DIAG_STREAM_MARKED, final: true, blocks: [] }],
    [{ index: 1, role: 'assistant', text: DIAG_CLEAN, blocks: [] }],
  );
  const { links } = joinStreamToDom({
    messages: [{ key: null, role: 'assistant', text: DIAG_STREAM_MARKED, final: true, blocks: [] }],
    turns: [{ index: 1, role: 'assistant', text: DIAG_CLEAN, blocks: [] }],
  });
  const msg = links.find((l) => l.messageIndex === 0);
  assert.equal(msg.status, 'near_match');
  assert.ok(msg.evidence.notes.join(' | ').includes(`token Dice ${diag[0].bestMessage.diceScore.toFixed(3)}`));
});

test('--diagnose: a DOM turn with unrelated text is different with dice 0', async (t) => {
  const root = makeEnv(t).root;
  addDiagSessions(root);
  const { report } = await runSurvey({ dataDir: root, session: 'diag-unrelated', diagnose: true });
  const [d] = diagOf(report, 'diag-unrelated');
  assert.equal(d.diagnosis, 'different');
  assert.equal(d.bestMessage.diceScore, 0);
  assert.equal(d.bestMessage.commonPrefixChars, 0);
  assert.equal(report.aggregate.diagnostics.diceHistogram['[0]'], 1);
});

test('--diagnose: a session with no assistant message is no_candidate, and user turns are not diagnosed', async (t) => {
  const root = makeEnv(t).root;
  addDiagSessions(root);
  const { report } = await runSurvey({ dataDir: root, session: 'diag-no-reply', diagnose: true });
  const diags = diagOf(report, 'diag-no-reply');
  assert.equal(diags.length, 1, 'only the assistant DOM turn is diagnosed');
  assert.equal(diags[0].diagnosis, 'no_candidate');
  assert.equal(diags[0].bestMessage, null);
  assert.equal(diags[0].messagesConsidered, 0);
  assert.equal(diags[0].featureCounts.stream, null);
  assert.equal(diags[0].likelyCause, null);
  assert.equal(report.aggregate.diagnostics.byDiagnosis.no_candidate, 1);
});

test('--diagnose: the output carries no reply words, no DOM text and no private-use characters (in-process and CLI)', async (t) => {
  const root = makeEnv(t).root;
  addDiagSessions(root);
  const { report } = await runSurvey({ dataDir: root, all: true, diagnose: true });
  const text = JSON.stringify(report);
  for (const phrase of [...FORBIDDEN, ...DIAG_FORBIDDEN]) assert.equal(text.includes(phrase), false, `report leaks "${phrase}"`);
  assert.equal(PRIVATE_USE.test(text), false, 'report carries a private-use character');
  assert.equal(text.includes(root), false);
  const r = cli(['--data-dir', root, '--all', '--json', '--diagnose']);
  assert.equal(r.status, 0, r.stderr);
  for (const phrase of [...FORBIDDEN, ...DIAG_FORBIDDEN]) assert.equal(r.stdout.includes(phrase), false, `stdout leaks "${phrase}"`);
  assert.equal(PRIVATE_USE.test(r.stdout), false, 'stdout carries a private-use character');
  assert.ok(JSON.parse(r.stdout).aggregate.diagnostics);
});

test('--diagnose: the data directory listing is unchanged, and without the flag no diagnostic field appears', async (t) => {
  const root = makeEnv(t).root;
  addDiagSessions(root);
  const before = listTree(root);
  const { report, writeDetected } = await runSurvey({ dataDir: root, all: true, diagnose: true });
  assert.deepEqual(writeDetected, []);
  assert.deepEqual(listTree(root), before);
  const plain = (await runSurvey({ dataDir: root, all: true })).report;
  assert.equal(plain.aggregate.diagnostics, undefined);
  for (const s of plain.sessions) assert.equal('turnDiagnostics' in s, false, `${s.id} has no turnDiagnostics`);
  assert.deepEqual(listTree(root), before);
});
