import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generatePacket, renderMarkdown, verifyPacket, writeOutputs } from '../../src/export/outcome-packet.mjs';
const fixturePath = new URL('../fixtures/value-oracle/demo.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const copy = () => structuredClone(fixture);
const packet = () => generatePacket(copy(), 'fixture.json');
const local = path.resolve(fileURLToPath(new URL('../../src/export/outcome-packet.mjs', import.meta.url)));

test('positive: explicit saved summary, decision, actions and unknowns', () => {
  const p = packet();
  assert.match(p.answer.text, /local handoff/);
  assert.equal(p.decisions.length, 1);
  assert.equal(p.decisions[0].confirmation, 'not-user-confirmed');
  assert.equal(p.actions.length, 2);
  assert(p.actions.every((a) => a.status === 'proposed-not-executed' && a.assignee === null));
  assert.equal(p.unresolved_questions.length, 1);
  assert.equal(p.source_stated_unknowns.length, 1);
  assert.equal(p.evidence.length, 6);
  assert.equal(p.delivery.external_actions, 0);
  assert(verifyPacket(fixture, p));
});

test('exact evidence hash and line verification fails after source mutation', () => {
  const x = copy(), p = generatePacket(x);
  assert(verifyPacket(x, p));
  x.turns[1].text = x.turns[1].text.replace('local handoff', 'remote handoff');
  assert.equal(verifyPacket(x, p), false);
});

test('no unlabelled statement is promoted to a decision or action', () => {
  const x = copy(); x.turns[1].text = 'Maybe one day we could publish an issue. The answer may be 42.';
  const p = generatePacket(x);
  assert.equal(p.answer, null); assert.equal(p.decisions.length, 0); assert.equal(p.actions.length, 0);
  assert(p.unknowns.includes('no-explicit-decisions-found'));
});

test('unattributed streams used only when no assistant turns, explicitly unauthenticated', () => {
  const x = copy(); x.turns = [];
  x.streams = [{ sid: 's0', texts: [{ path: '/message', text: 'Summary: Recorded as stream text only.\nDecision: Save locally.' }] }];
  const p = generatePacket(x);
  assert.equal(p.answer.source_role, 'stream-unattributed');
  assert.equal(p.decisions[0].confirmation, 'not-user-confirmed');
  assert.equal(p.evidence[0].json_pointer, '#/streams/0/texts/0/text');
  assert(verifyPacket(x, p));
});

test('assistant turns take precedence over duplicate transport streams', () => {
  const x = copy(); x.streams = [{ sid: 's0', texts: [{ text: 'Decision: Not from the DOM turn.' }] }];
  const p = generatePacket(x);
  assert.equal(p.decisions.length, 1);
  assert.match(p.decisions[0].text, /transcript JSON/);
});

test('credential-shaped lines withheld, not printed in markdown', () => {
  const x = copy(); x.turns[1].text += '\nNext action: upload api_key=abc123456789';
  const p = generatePacket(x); const md = renderMarkdown(p);
  assert.equal(p.actions.length, 2);
  assert(p.unknowns.includes('credential-shaped-lines-withheld:1'));
  assert(!md.includes('abc123456789'));
});

test('duplicate explicit action collapsed and provenance preserved', () => {
  const x = copy(); x.turns[1].text += '\nAction: Run the standalone packet generator against the saved fixture.';
  const p = generatePacket(x);
  assert.equal(p.actions.length, 2);
  assert.equal(p.actions[0].source_refs.length, 2);
  assert(verifyPacket(x, p));
});

test('incomplete metadata remains unknown, not accepted', () => {
  const x = copy(); x.meta.status = 'interrupted';
  const p = generatePacket(x);
  assert(p.unknowns.includes('capture-completeness-not-proven'));
  assert.equal(p.measurement.independently_accepted, false);
});

test('no source text safely abstains', () => {
  const x = copy(); x.turns = []; x.streams = [];
  const p = generatePacket(x);
  assert.equal(p.answer, null); assert.equal(p.evidence.length, 0);
  assert(p.unknowns.includes('no-observable-turns-or-stream-text'));
});

test('bad session, malformed source shape and oversized text rejected', () => {
  assert.throws(() => generatePacket({ meta: { id: 'ok' }, turns: null, streams: [] }), { code: 'INVALID_TRANSCRIPT' });
  const x = copy(); x.meta.id = '../escape';
  assert.throws(() => generatePacket(x), { code: 'INVALID_SESSION' });
  const y = copy(); y.turns[1].text = 'A'.repeat(200001);
  assert.throws(() => generatePacket(y), { code: 'OVERSIZE_TEXT' });
});

test('external claimed pointers ignored; actual references always reverified', () => {
  const x = copy(); x.sourceRefs = ['https://fabricated.invalid/claim'];
  x.turns[1].sourceRefs = ['#/nonexistent'];
  const p = generatePacket(x);
  assert(p.evidence.every((e) => !e.json_pointer.includes('nonexistent')));
  assert(verifyPacket(x, p));
  p.evidence[0].json_pointer = '#/turns/999/text';
  assert.equal(verifyPacket(x, p), false);
});

test('one command emits both packets and QA-compatible receipt, no send', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aion-value-v1-'));
  const r = spawnSync(process.execPath, [local, '--demo', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(readFileSync(path.join(out, 'outcome-packet.json')));
  assert.equal(p.delivery.state, 'not-attempted');
  for (const f of ['run.json', 'steps.jsonl', 'metrics.json', 'failures.jsonl', 'summary.md']) assert(existsSync(path.join(out, 'qa-v1', 'round-L4', f)), f);
  const run = JSON.parse(readFileSync(path.join(out, 'qa-v1', 'round-L4', 'run.json')));
  assert.equal(run.acceptance, 'self-test-only-not-qa-accepted');
  const metrics = JSON.parse(readFileSync(path.join(out, 'qa-v1', 'round-L4', 'metrics.json')));
  assert.equal(metrics.ui_steps, null); assert.equal(metrics.sends, 0);
});

test('CLI missing input fails without emitting a false success packet', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'aion-value-error-'));
  const r = spawnSync(process.execPath, [local, '--input', path.join(out, 'none.json'), '--out', out], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert(!existsSync(path.join(out, 'outcome-packet.json')));
  assert.match(r.stderr, /FAIL/);
});

test('replies carry each assistant turn verbatim with a verifiable locator and fail verification if the source changes', async () => {
  const { generatePacket, verifyPacket, renderMarkdown } = await import('../../src/export/outcome-packet.mjs');
  const t = { meta: { id: 'sess-r1', status: 'complete' }, streams: [], turns: [
    { role: 'user', text: 'Explain caching in one line.' }, { role: 'assistant', text: 'Caching stores copies.\nIt cuts latency.' },
    { role: 'user', text: 'Now a table.' }, { role: 'assistant', text: '| a | b |\n|---|---|\n| 1 | 2 |' }] };
  const p = generatePacket(t, 'x.json');
  assert.equal(p.replies.length, 2);
  assert.equal(p.replies[1].prompt, 'Now a table.');
  assert.equal(p.replies[0].text, 'Caching stores copies.\nIt cuts latency.');
  assert.ok(verifyPacket(t, p));
  assert.match(renderMarkdown(p), /### Turn 2[\s\S]*\| 1 \| 2 \|/);
  const changed = structuredClone(t); changed.turns[1].text += ' (edited)';
  assert.equal(verifyPacket(changed, p), false);
  assert.equal(p.derivation.interpreted_decisions, 0);
});
