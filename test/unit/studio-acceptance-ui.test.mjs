// Frontend-only "Capture acceptance" panel checks. No browser, no network, no live data.
// The code is loaded from index.html with a vm stub DOM (same approach as studio-components-ui.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../src/studio/ui/index.html', import.meta.url), 'utf8');
const script = html.replace(/\r\n/g, '\n').split('<script>')[1]?.split('</script>')[0] ?? '';
const escLine = script.split('\n').find((line) => line.startsWith('const esc = '));
const accStart = script.indexOf('/* ---------------- capture acceptance');
const accEnd = script.indexOf('/* ---------------- records (read-only');
const acc = accStart > 0 && accEnd > accStart ? script.slice(accStart, accEnd) : '';
const panelStart = html.indexOf('<h3>Capture acceptance');
const panelEnd = html.indexOf('<h3>Export</h3>');
const panel = panelStart > 0 && panelEnd > panelStart ? html.slice(panelStart, panelEnd) : '';

const PAYLOAD = '<img src=x onerror=alert(1)>';
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';
const DIGEST = '0123456789abcdef'.repeat(4);
const NOTE = 'needs a conversation context (a driven chat turn); not available for passively recorded sessions';
const INFO = 'This label does not change what the studio does with the capture: it is information, not a gate.';
const IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function accHarness({ sessionId = 'sess-1', responder } = {}) {
  const nodes = new Map();
  const node = () => ({ innerHTML: '', textContent: '' });
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node()); return nodes.get(sel); };
  const calls = [];
  const S = { sessionRequestSeq: 1, sessionId };
  const api = (path, opts) => { calls.push({ path, opts }); return responder ? responder(path) : Promise.resolve(null); };
  const fns = runInNewContext(escLine + '\n' + acc + '\n({renderAcceptanceHtml, loadAcceptance})',
    { $, S, api, guard: (f) => f }, { timeout: 2000 });
  return { fns, S, calls, $, out: () => $('#acceptanceOut').innerHTML };
}

const gate = (value, reason = 'ok', evidence = {}) => ({ value, reason, evidence });
const gatesAll = (over = {}) => Object.fromEntries(IDS.map((id) => [id, over[id] ?? gate('passed', id + ' ok', { userTurns: 1 })]));
const doc = (verdict, over = {}) => ({ schema: 'capture-studio.acceptance/1', evaluator: { version: '1.0.0' }, evaluatedAt: '2026-10-22T10:00:00.000Z',
  binding: { rawDigest: DIGEST, seqRange: [1, 2000], recipe: { id: 'clean-data-gate', version: 1 } },
  gates: gatesAll(), verdict, reasons: [], ...over });
const rowOf = (out, id) => {
  const m = out.match(new RegExp('<tr data-gate="' + id + '">[\\s\\S]*?</tr>'));
  return m ? m[0] : '';
};

test('panel sits at the top of Sessions detail, before Records, with no action and GET only', () => {
  assert.ok(panel.length > 80, 'panel markup found');
  assert.match(panel, /id="acceptancePanel"/);
  assert.match(panel, /id="acceptanceOut" role="status" aria-live="polite"/);
  assert.doesNotMatch(panel, /<button|<form|<input|<select/, 'static panel markup has no action');
  assert.ok(html.indexOf('bGoKnowledge') < html.indexOf('<h3>Capture acceptance'), 'after the session header actions');
  assert.ok(html.indexOf('<h3>Capture acceptance') < html.indexOf('<h3>Export</h3>'), 'before Export');
  assert.ok(html.indexOf('<h3>Export</h3>') < html.indexOf('<h3>Records'), 'before Records');
  assert.match(script, /guard\(loadAcceptance\)\(id, requestSeq\);/);
  assert.doesNotThrow(() => new Script(script));
  assert.match(acc, /api\('sessions\/' \+ encodeURIComponent\(id\) \+ '\/acceptance'\)/);
  assert.doesNotMatch(acc, /method\s*:|opts\.body|body\s*:|\bfetch\s*\(|insertAdjacentHTML|document\.write|POST|\/derive|\/evaluate|\/send|\/delete|\/save|\/import|writeAcceptance|evaluateAcceptance/);
});

test('the loader issues exactly one plain GET request with no options', async () => {
  const h = accHarness({ responder: () => Promise.resolve(doc('capture_accepted')) });
  await h.fns.loadAcceptance('sess-1', 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, 'sessions/sess-1/acceptance');
  assert.equal(h.calls[0].opts, undefined, 'no body, no method override');
});

test('each verdict renders its symbol, its text label and its explanation', () => {
  const h = accHarness();
  const cases = [
    [doc('capture_accepted'), '[OK] capture accepted', 'all seven gates passed.'],
    [doc('capture_rejected', { gates: gatesAll({ G4: gate('failed', 'session status is failed') }), reasons: ['G4 failed: session status is failed'] }),
      '[X] capture rejected', 'at least one gate failed.'],
    [doc('capture_incomplete', { gates: gatesAll({ G6: gate('unknown', 'derive status is running; not finished') }) }),
      '[~] capture incomplete', 'not enough evidence'],
    [doc('unassessed', { gates: null, binding: null, reasons: ['raw digest changed since evaluation; re-evaluate'] }),
      '[?] unassessed', 'there is no evaluation, or the saved evaluation no longer matches the raw log.'],
  ];
  for (const [d, label, meaning] of cases) {
    const out = h.fns.renderAcceptanceHtml(d);
    assert.ok(out.includes(label), 'label ' + label);
    assert.ok(out.includes(meaning), 'explanation for ' + label);
    assert.ok(out.includes(INFO), 'information-not-gate sentence for ' + label);
    assert.ok(out.indexOf(label) < out.indexOf(meaning), 'symbol and label come before the explanation');
  }
});

test('the vocabulary never shows a bare accepted or rejected', () => {
  const h = accHarness();
  const outs = [
    h.fns.renderAcceptanceHtml(doc('capture_accepted')),
    h.fns.renderAcceptanceHtml(doc('capture_rejected', { gates: gatesAll({ G1: gate('failed', 'x') }) })),
    h.fns.renderAcceptanceHtml(doc('capture_incomplete', { gates: gatesAll({ G1: gate('unknown', 'x') }) })),
    h.fns.renderAcceptanceHtml(doc('unassessed', { gates: null, binding: null, reasons: ['r'] })),
    h.fns.renderAcceptanceHtml({ verdict: 'unassessed', reason: 'no acceptance.json' }),
  ];
  for (const out of outs) assert.doesNotMatch(out.replace(/capture (accepted|rejected|incomplete)/g, ''), /\b(accepted|rejected)\b/);
});

test('the gate table has seven rows with the names and the right text cues', () => {
  const h = accHarness();
  const out = h.fns.renderAcceptanceHtml(doc('capture_incomplete', {
    gates: gatesAll({ G2: gate('failed', 'order'), G3: gate('not-checked', 'no conversation context supplied'), G4: gate('unknown', 'status missing'), G5: gate('passed', 'verify ok', { gapRecords: 0 }) }),
  }));
  assert.equal(out.split('data-gate="').length - 1, 7);
  assert.match(rowOf(out, 'G1'), /prompt matched/);
  assert.match(rowOf(out, 'G1'), /<td>passed<\/td>/);
  assert.match(rowOf(out, 'G2'), /reply words in order/);
  assert.match(rowOf(out, 'G2'), /<td>failed<\/td>/);
  assert.match(rowOf(out, 'G3'), /reply stable and complete/);
  assert.match(rowOf(out, 'G3'), /<td>not checked<\/td>/);
  assert.match(rowOf(out, 'G4'), /recording stopped cleanly/);
  assert.match(rowOf(out, 'G4'), /<td>unknown<\/td>/);
  assert.match(rowOf(out, 'G5'), /raw log verified with no gaps/);
  assert.match(rowOf(out, 'G5'), /<td class="num">0 <span class="small-note">gapRecords<\/span><\/td>/, 'one short count from evidence');
  assert.match(rowOf(out, 'G6'), /derive complete/);
  assert.match(rowOf(out, 'G7'), /stream text matches rendered text/);
});

test('G1, G2 and G3 not-checked rows say they need a conversation context; G4 does not', () => {
  const h = accHarness();
  const out = h.fns.renderAcceptanceHtml(doc('capture_incomplete', {
    gates: gatesAll({ G1: gate('not-checked', 'no conversation context supplied'), G2: gate('not-checked', 'no expectedReplyWords supplied'),
      G3: gate('not-checked', 'no conversation context supplied'), G4: gate('not-checked', 'derive has not written KNOWLEDGE_STATUS') }),
  }));
  assert.equal(out.split(NOTE).length - 1, 3, 'exactly G1 G2 G3');
  for (const id of ['G1', 'G2', 'G3']) assert.match(rowOf(out, id), new RegExp(NOTE.replace(/[()]/g, '\\$&')), id);
  assert.doesNotMatch(rowOf(out, 'G4'), /needs a conversation context/);
  assert.match(rowOf(out, 'G4'), /<td>not checked<\/td>/);
});

test('a long reason is cut at 200 characters with a truncation marker and the real length', () => {
  const h = accHarness();
  const out = h.fns.renderAcceptanceHtml(doc('capture_rejected', { gates: gatesAll({ G5: gate('failed', 'x'.repeat(500)) }) }));
  assert.ok(out.includes('x'.repeat(200)));
  assert.ok(!out.includes('x'.repeat(201)));
  assert.match(out, /truncated, real length 500 chars/);
  const short = h.fns.renderAcceptanceHtml(doc('capture_accepted'));
  assert.doesNotMatch(short, /truncated, real length/);
});

test('markup inside a reason renders as escaped text, never as an element', () => {
  const h = accHarness();
  const out = h.fns.renderAcceptanceHtml(doc('capture_rejected', { gates: gatesAll({ G5: gate('failed', PAYLOAD) }), reasons: [PAYLOAD] }));
  assert.ok(out.includes(ESCAPED));
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /onerror=alert\(1\)>/);
});

test('legacy recording without acceptance.json shows the unassessed state, not a failure', () => {
  const h = accHarness();
  const out = h.fns.renderAcceptanceHtml({ verdict: 'unassessed', reason: 'no acceptance.json' });
  assert.match(out, /no acceptance\.json for this recording/);
  assert.ok(out.includes('[?] unassessed'));
  assert.ok(out.includes(INFO));
  assert.doesNotMatch(out, /<table/);
  assert.doesNotMatch(out, /<button|<form|<input/);
});

test('an unassessed document lists its reasons and says there are no gate results', () => {
  const h = accHarness();
  const out = h.fns.renderAcceptanceHtml(doc('unassessed', { gates: null, binding: null,
    reasons: ['raw digest changed since evaluation; re-evaluate', 'raw evidence unreadable: ' + PAYLOAD] }));
  assert.match(out, /Reasons \(2\)/);
  assert.ok(out.includes('raw digest changed since evaluation; re-evaluate'));
  assert.ok(out.includes(ESCAPED));
  assert.match(out, /No gate results/);
  assert.match(out, /Binding: not available/);
  assert.doesNotMatch(out, /<img/);
});

test('an unrecognized document shows the wording and its escaped schema string', () => {
  const h = accHarness();
  const other = h.fns.renderAcceptanceHtml({ schema: 'other/9', verdict: 'capture_accepted', gates: {} });
  assert.match(other, /unrecognized acceptance document/);
  assert.ok(other.includes('other/9'));
  assert.doesNotMatch(other, /\[OK\]/, 'no verdict is shown for an unrecognized document');
  const hostile = h.fns.renderAcceptanceHtml({ schema: PAYLOAD, verdict: 'x' });
  assert.match(hostile, /unrecognized acceptance document/);
  assert.ok(hostile.includes(ESCAPED));
  assert.doesNotMatch(hostile, /<img/);
  assert.match(h.fns.renderAcceptanceHtml([]), /Unexpected capture acceptance response/);
  assert.match(h.fns.renderAcceptanceHtml(null), /Unexpected capture acceptance response/);
  assert.match(h.fns.renderAcceptanceHtml(doc('capture_accepted', { schema: 'capture-studio.acceptance/1', verdict: 'maybe' })), /unrecognized acceptance document/);
});

test('an unrecognized gate value is labelled as such and an absent gate is shown as missing', () => {
  const h = accHarness();
  const out = h.fns.renderAcceptanceHtml(doc('capture_incomplete', { gates: { ...gatesAll(), G7: gate('maybe', 'x') } }));
  assert.match(rowOf(out, 'G7'), /unrecognized value/);
  const partial = h.fns.renderAcceptanceHtml(doc('capture_incomplete', { gates: { G1: gate('passed') } }));
  assert.match(rowOf(partial, 'G2'), /<td>missing<\/td>/);
});

test('the binding line shows the evaluator version, the evaluated time as text, the seq range and 12 digest characters only', () => {
  const h = accHarness();
  const out = h.fns.renderAcceptanceHtml(doc('capture_accepted'));
  assert.match(out, /evaluator 1\.0\.0/);
  assert.ok(out.includes('2026-10-22T10:00:00.000Z'));
  assert.match(out, /seq 1 to 2000/);
  assert.ok(out.includes(DIGEST.slice(0, 12)));
  assert.ok(!out.includes(DIGEST.slice(0, 13)), 'no 13th digest character');
  assert.ok(!out.includes(DIGEST), 'the full digest is never shown');
});

test('a request error shows the escaped message and no stale verdict', async () => {
  const h = accHarness({ responder: () => Promise.reject(new Error('Studio unreachable ' + PAYLOAD)) });
  await h.fns.loadAcceptance('sess-1', 1);
  assert.match(h.out(), /Could not load capture acceptance/);
  assert.ok(h.out().includes(ESCAPED));
  assert.doesNotMatch(h.out(), /<img/);
  assert.doesNotMatch(h.out(), /\[OK\]|\[X\]|\[~\]/);
});

test('the loader shows the verdict it was given, the legacy state from the endpoint and the unassessed reasons', async () => {
  const legacy = accHarness({ responder: () => Promise.resolve({ verdict: 'unassessed', reason: 'no acceptance.json' }) });
  await legacy.fns.loadAcceptance('sess-1', 1);
  assert.match(legacy.out(), /no acceptance\.json for this recording/);
  const accepted = accHarness({ responder: () => Promise.resolve(doc('capture_accepted')) });
  await accepted.fns.loadAcceptance('sess-1', 1);
  assert.match(accepted.out(), /\[OK\] capture accepted/);
  assert.match(accepted.out(), /data-gate="G7"/);
});

test('a stale response from a previous session selection is dropped', async () => {
  const first = deferred();
  const h = accHarness({ sessionId: 'sess-1', responder: () => first.promise });
  const run = h.fns.loadAcceptance('sess-1', 1);
  h.S.sessionId = 'sess-2';
  h.S.sessionRequestSeq = 2;
  first.resolve(doc('capture_accepted'));
  await run;
  assert.doesNotMatch(h.out(), /capture accepted/);
  assert.match(h.out(), /Loading capture acceptance/);
});

test('a stale response from an earlier load of the same session is dropped by the newer load', async () => {
  const gates = [deferred(), deferred()];
  let n = 0;
  const h = accHarness({ sessionId: 'sess-1', responder: () => gates[n++].promise });
  const older = h.fns.loadAcceptance('sess-1', 1);
  const newer = h.fns.loadAcceptance('sess-1', 1);
  gates[1].resolve(doc('capture_rejected', { gates: gatesAll({ G1: gate('failed', 'newer') }) }));
  await newer;
  gates[0].resolve(doc('capture_accepted'));
  await older;
  assert.match(h.out(), /\[X\] capture rejected/);
  assert.doesNotMatch(h.out(), /capture accepted/);
});
