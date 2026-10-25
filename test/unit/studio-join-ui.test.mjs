// Frontend-only "Stream to page" panel checks. No browser, no network, no live data.
// The panel code is loaded from index.html with a vm stub DOM (same approach as studio-records-ui.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../src/studio/ui/index.html', import.meta.url), 'utf8');
const script = html.replace(/\r\n/g, '\n').split('<script>')[1]?.split('</script>')[0] ?? '';
const escLine = script.split('\n').find((line) => line.startsWith('const esc = '));
const navStart = script.indexOf('function parseSessionDeepLink(hash)');
const navEnd = script.indexOf("if (location.hash.startsWith('#session='))", navStart);
const navigation = navStart > 0 && navEnd > navStart ? script.slice(navStart, navEnd) : '';
const joinStart = script.indexOf('/* ---------------- stream to page');
const joinEnd = script.indexOf('/* ---------------- Knowledge workspace');
const join = joinStart > 0 && joinEnd > joinStart ? script.slice(joinStart, joinEnd) : '';
const panelStart = html.indexOf('<h3>Stream to page');
const panelEnd = html.indexOf('<h3>Time travel</h3>');
const panel = panelStart > 0 && panelEnd > panelStart ? html.slice(panelStart, panelEnd) : '';

const SCHEMA = 'capture-studio.stream-dom-join/1';
const PAYLOAD = '<img src=x onerror=alert(1)>';
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';

// Objects built inside the vm context have another Object prototype; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ sessionId = 'sess-1', responder } = {}) {
  const nodes = new Map();
  const node = () => ({ innerHTML: '', textContent: '', hidden: true, dataset: {}, querySelectorAll: () => [], querySelector: () => null,
    setAttribute() {}, classList: { toggle() {} } });
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node()); return nodes.get(sel); };
  const calls = [], replaced = [];
  const S = { sessionRequestSeq: 1, sessionId, sid: null };
  const api = (path) => { calls.push(path); return responder ? responder(path) : Promise.resolve(null); };
  const history = { replaceState: (_state, _title, url) => replaced.push(url) };
  const fns = runInNewContext(escLine + '\n' + navigation + '\n' + join +
    '\n({parseSessionDeepLink,joinDeepLinkHref,renderJoinHtml,loadJoin,selectJoinMessage,openSessionDeepLink,pending:() => pendingJoinFocus})',
    { $, S, api, history, URLSearchParams, show: () => {}, openSession: async () => true, selectSessionContext: () => {},
      loadStreams: async () => [], openStream: async () => true, toast: () => {}, guard: (f) => f }, { timeout: 2000 });
  return { fns, $, S, calls, replaced, out: () => $('#joinOut').innerHTML };
}

const emptyEv = { rule: null, ordering: 'none', notes: [], candidates: [], candidateOf: [] };
const link = (over = {}) => ({ messageKey: 'm1:0', messageIndex: 0, messageId: 'm1', role: 'assistant', turnIndex: 1, turnId: 't1', domId: 'd1',
  status: 'verified', textMatch: 'exact', blockLinks: [], evidence: { rule: 'order+text', ordering: 'position', notes: [], candidates: [], candidateOf: [] }, ...over });
const unlinkedUser = { messageKey: null, messageIndex: null, messageId: null, role: 'user', turnIndex: 0, turnId: 't0', domId: 'd0',
  status: 'unlinked_dom', textMatch: 'none', blockLinks: [], evidence: { ...emptyEv } };
const TURNS = [
  { index: 0, id: 't0', domId: 'd0', role: 'user', text: 'Explain streams' },
  { index: 1, id: 't1', domId: 'd1', role: 'assistant', text: 'Streams are ordered.' },
];
const counts = (ms) => ({ verified: 0, partial: 0, near_match: 0, ambiguous: 0, text_mismatch: 0, unlinked_stream: 0, unlinked_dom: 0, ...ms });
const joinValue = (links, ms = {}) => ({ schema: SCHEMA, summary: { messages: links.filter((l) => l.messageIndex != null).length, turns: 2, messageStatus: counts(ms), blockStatus: {}, rules: {} }, links, sources: { streams: ['sid-1'], domTurns: 2 } });

test('Stream to page panel exists in Sessions detail, wires the loader and stays read-only', () => {
  assert.ok(panel.length > 100, 'panel markup found');
  assert.match(panel, /id="joinPanel"/);
  assert.match(panel, /id="joinOut" role="status" aria-live="polite"/);
  assert.doesNotMatch(panel, /<button/, 'static panel markup has no action');
  assert.match(script, /guard\(loadJoin\)\(id, requestSeq\);/);
  assert.doesNotThrow(() => new Script(script));
});

test('join loader adds no write action, no non-GET request and no raw innerHTML of data', () => {
  assert.ok(join.length > 1000, 'join section found');
  assert.doesNotMatch(join, /method\s*:/);
  assert.doesNotMatch(join, /opts\.body|body\s*:/);
  assert.doesNotMatch(join, /\bfetch\s*\(|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(join, /\/derive|\/delete|\/import|\/save/);
  assert.match(join, /api\('sessions\/' \+ enc \+ '\/join'\)/);
  assert.match(join, /api\('sessions\/' \+ enc \+ '\/turns'\)/);
  assert.doesNotMatch(join, /api\([^)]*,\s*\{/, 'every api call is a plain GET');
});

test('summary counts render from messageStatus', () => {
  const h = harness();
  const out = h.fns.renderJoinHtml(joinValue([link()], { verified: 3, ambiguous: 1 }), TURNS, null, null);
  assert.match(out, /\[OK\] verified <b>3<\/b>/);
  assert.match(out, /\[\?\] ambiguous <b>1<\/b>/);
  assert.match(out, /\[~\] partial <b>0<\/b>/);
});

test('verified link is shown on both sides; the user turn is unlinked and explained', () => {
  const h = harness();
  const out = h.fns.renderJoinHtml(joinValue([link(), unlinkedUser], { verified: 1, unlinked_dom: 1 }), TURNS, null, null);
  assert.match(out, /\[OK\] verified/);
  assert.match(out, /order and normalized text agree/);
  assert.match(out, /claimed by stream message #0/);
  assert.match(out, /data-link-turn="1"/, 'message button carries its linked turn');
  assert.match(out, /turn #0<\/b> user/);
  assert.match(out, /\[-\] unlinked_dom/);
  assert.match(out, /no stream message claimed this turn/);
  assert.match(out, /User prompts travel in the request body, not in a stream/);
  assert.match(out, /rule: order\+text \(position and text\)/);
});

test('every status has a text cue and label, never colour alone', () => {
  const h = harness();
  const cases = [
    ['verified', link(), '[OK] verified', 'order and normalized text agree'],
    ['partial', link({ status: 'partial', textMatch: 'prefix' }), '[~] partial', 'stream not final or render ahead'],
    ['near_match', link({ status: 'near_match', textMatch: 'near', evidence: { rule: 'order+text', notes: ['token Dice 0.978'] } }), '[~~] near_match', 'close but not verified'],
    ['text_mismatch', link({ status: 'text_mismatch', textMatch: 'differs' }), '[X] text_mismatch', 'aligned by order but text differs'],
    ['unlinked_stream', link({ status: 'unlinked_stream', turnIndex: null, turnId: null, domId: null, textMatch: 'none', evidence: { rule: null, notes: [] } }), '[ ] unlinked_stream', 'no DOM turn matched this stream message'],
  ];
  for (const [status, l, chip, text] of cases) {
    const out = h.fns.renderJoinHtml(joinValue([l], { [status]: 1 }), TURNS, null, null);
    assert.ok(out.includes(chip), status + ' chip: ' + chip);
    assert.ok(out.includes(text), status + ' text: ' + text);
  }
  const all = h.fns.renderJoinHtml(joinValue([link(), unlinkedUser]), TURNS, null, null);
  assert.match(all, /\[-\] unlinked_dom/);
});

test('ambiguous link lists candidate turns and never forces a single link', () => {
  const h = harness();
  const turns = [...TURNS, { index: 3, id: 't3', domId: 'd3', role: 'assistant', text: 'Streams are ordered.' }];
  const amb = link({ status: 'ambiguous', turnIndex: null, turnId: null, domId: null, textMatch: 'none',
    evidence: { rule: 'text-only', ordering: 'text', notes: ['several turns fit the text; ordering not used'], candidates: [1, 3], candidateOf: [] } });
  const out = h.fns.renderJoinHtml(joinValue([amb], { ambiguous: 1 }), turns, null, null);
  assert.match(out, /candidate turns #1, #3: no single link chosen/);
  assert.match(out, /data-link-turn=""/, 'no linked turn on the message button');
  assert.doesNotMatch(out, /claimed by stream message/, 'no turn is claimed');
  assert.match(out, /candidate for stream message #0; no link chosen/);
  assert.match(out, /ordering not used/);
});

test('near match is labelled close but not verified; partial is labelled as stream not final', () => {
  const h = harness();
  const out = h.fns.renderJoinHtml(joinValue([link({ status: 'near_match', textMatch: 'near' })], { near_match: 1 }), TURNS, null, null);
  assert.match(out, /close but not verified/);
  assert.doesNotMatch(out, /data-status="verified"/);
  const p = h.fns.renderJoinHtml(joinValue([link({ status: 'partial', textMatch: 'prefix' })], { partial: 1 }), TURNS, null, null);
  assert.match(p, /stream not final or render ahead/);
});

test('text mismatch and unlinked stream message show no DOM turn', () => {
  const h = harness();
  const unl = link({ status: 'unlinked_stream', turnIndex: null, turnId: null, domId: null, textMatch: 'none', evidence: { rule: null, notes: [] } });
  const out = h.fns.renderJoinHtml(joinValue([unl], { unlinked_stream: 1 }), TURNS, null, null);
  assert.match(out, /stream message #0 -&gt;|stream message #0 -> no DOM turn/);
  assert.match(out, /no DOM turn/);
});

test('block links render as one compact line each, including unlinked blocks', () => {
  const h = harness();
  const l = link({ blockLinks: [
    { blockKey: 'b1', ord: 0, status: 'verified', textMatch: 'exact', evidence: {} },
    { blockKey: 'b2', ord: null, status: 'unlinked_stream', textMatch: 'none', evidence: {} },
    { blockKey: null, ord: 2, status: 'unlinked_dom', textMatch: 'none', evidence: {} },
  ] });
  const out = h.fns.renderJoinHtml(joinValue([l], { verified: 1 }), TURNS, null, null);
  assert.match(out, /stream block b1 -&gt; DOM block ord 0: verified|stream block b1 -> DOM block ord 0: verified/);
  assert.match(out, /stream block b2 -> DOM block ord none: unlinked_stream/);
  assert.match(out, /stream block none -> DOM block ord 2: unlinked_dom/);
});

test('turn text and notes are escaped: markup payloads render as text', () => {
  const h = harness();
  const turns = [{ index: 0, id: 't0', domId: 'd0', role: PAYLOAD, text: PAYLOAD }, { index: 1, id: 't1', domId: 'd1', role: 'assistant', text: 'ok' }];
  const l = link({ messageId: PAYLOAD, evidence: { rule: 'order+text', notes: [PAYLOAD], candidates: [], candidateOf: [] } });
  const out = h.fns.renderJoinHtml(joinValue([l, { ...unlinkedUser, turnIndex: 0, evidence: { ...emptyEv, notes: [PAYLOAD] } }], { verified: 1 }), turns, null, null);
  assert.ok(out.includes(ESCAPED), 'payload appears as escaped text');
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /onerror=alert\(1\)>/);
});

test('long turn text shows the first 160 characters with a truncated marker and real length', () => {
  const h = harness();
  const turns = [{ index: 0, id: 't0', domId: 'd0', role: 'user', text: 'x'.repeat(200) }, { index: 1, id: 't1', domId: 'd1', role: 'assistant', text: 'ok' }];
  const out = h.fns.renderJoinHtml(joinValue([link(), unlinkedUser], { verified: 1 }), turns, null, null);
  assert.match(out, /truncated, real length 200 chars/);
  assert.ok(out.includes('x'.repeat(160)));
  assert.ok(!out.includes('x'.repeat(161)));
});

test('not_derived, no_dom_turns, no_stream_messages, error and unexpected responses each say so with no action', () => {
  const h = harness();
  const cases = [
    [{ status: 'not_derived' }, /has not been derived/],
    [{ schema: SCHEMA, status: 'no_dom_turns' }, /No rendered DOM turns were captured/],
    [{ schema: SCHEMA, status: 'no_stream_messages' }, /No stream messages were parsed/],
    [{ schema: SCHEMA, error: PAYLOAD }, /could not be computed/],
    [[], /Unexpected stream-to-page response/],
    [{ schema: 'other/9', summary: {}, links: [] }, /Unrecognized stream-to-page response/],
  ];
  for (const [value, re] of cases) {
    const out = h.fns.renderJoinHtml(value, TURNS, null, null);
    assert.match(out, re);
    assert.doesNotMatch(out, /<button|<form|<input/, 'no action in state ' + JSON.stringify(value));
  }
  const err = h.fns.renderJoinHtml({ schema: SCHEMA, error: PAYLOAD }, TURNS, null, null);
  assert.ok(err.includes(ESCAPED));
  assert.doesNotMatch(err, /<img/);
});

test('loader shows not_derived from the join endpoint and reads turns with GET only', async () => {
  const h = harness({ responder: (path) => Promise.resolve(path.endsWith('/join') ? { status: 'not_derived' } : TURNS) });
  await h.fns.loadJoin('sess-1', 1);
  assert.deepEqual(h.calls, ['sessions/sess-1/join', 'sessions/sess-1/turns']);
  assert.match(h.out(), /has not been derived/);
});

test('loader shows a join error when the join request fails, without showing stale links', async () => {
  const h = harness({ responder: (path) => path.endsWith('/join') ? Promise.reject(new Error('Studio unreachable ' + PAYLOAD)) : Promise.resolve(TURNS) });
  await h.fns.loadJoin('sess-1', 1);
  assert.match(h.out(), /Could not load the stream-to-page join/);
  assert.ok(h.out().includes(ESCAPED));
  assert.doesNotMatch(h.out(), /<img/);
});

test('stale join response from a previous session selection is dropped', async () => {
  const first = deferred();
  const h = harness({ sessionId: 'sess-1', responder: (path) => path.endsWith('/join') ? first.promise : Promise.resolve(TURNS) });
  const run = h.fns.loadJoin('sess-1', 1);
  h.S.sessionId = 'sess-2';
  h.S.sessionRequestSeq = 2;
  first.resolve(joinValue([link()], { verified: 1 }));
  await run;
  assert.doesNotMatch(h.out(), /\[OK\] verified/);
  assert.match(h.out(), /Loading stream-to-page join/);
});

test('an older join request for the same session never replaces a newer one', async () => {
  const a = deferred(), b = deferred();
  let joins = 0;
  const h = harness({ responder: (path) => path.endsWith('/join') ? (joins++ === 0 ? a.promise : b.promise) : Promise.resolve(TURNS) });
  const older = h.fns.loadJoin('sess-1', 1);
  const newer = h.fns.loadJoin('sess-1', 1);
  b.resolve(joinValue([link({ status: 'verified' })], { verified: 1 }));
  await newer;
  a.resolve(joinValue([link({ status: 'text_mismatch', textMatch: 'differs' })], { text_mismatch: 1 }));
  await older;
  assert.match(h.out(), /\[OK\] verified/);
  assert.doesNotMatch(h.out(), /data-status="text_mismatch"/);
});

test('rows are native buttons with aria-pressed; no inline or role=button click handlers are rendered', () => {
  const h = harness();
  const out = h.fns.renderJoinHtml(joinValue([link(), unlinkedUser], { verified: 1, unlinked_dom: 1 }), TURNS, null, null);
  assert.match(out, /<button type="button" class="row-action" data-join="0"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(out, /onclick|role="button"|tabindex|onkeydown/);
  assert.match(join, /out\.querySelectorAll\('button\[data-join\]'\)\.forEach\(\(b\) => b\.onclick = guard\(\(\) => selectJoinMessage\(Number\(b\.dataset\.join\)\)\)\);/);
});

test('selecting a message updates the hash with join= via replaceState and the parser reads it back', () => {
  const h = harness({ sessionId: 'sess-1' });
  const btn = { dataset: { join: '3', linkTurn: '1' }, setAttribute() {}, classList: { toggle() {} } };
  const out = h.$('#joinOut');
  out.querySelector = (sel) => (sel === 'button[data-join="3"]' ? btn : null);
  assert.equal(h.fns.selectJoinMessage(3), true);
  assert.equal(h.fns.selectJoinMessage(9), false, 'unknown message selects nothing');
  assert.deepEqual(h.replaced, ['#session=sess-1&view=sessions&join=3']);
  assert.equal(h.fns.parseSessionDeepLink(h.replaced[0]).join, 3);
});

test('join deep-link parameter round-trips and is validated like the existing parameters', () => {
  const h = harness();
  const href = h.fns.joinDeepLinkHref('s 1/x', 3);
  assert.equal(href, '#session=s%201%2Fx&view=sessions&join=3');
  assert.deepEqual(plain(h.fns.parseSessionDeepLink(href)), { id: 's 1/x', view: 'sessions', sid: null, seq: null, join: 3 });
  assert.equal(h.fns.parseSessionDeepLink('#session=s1&join=0').join, 0);
  assert.equal(h.fns.parseSessionDeepLink('#session=s1').join, null);
  assert.equal(h.fns.parseSessionDeepLink('#session=s1&view=sessions').join, null);
  for (const bad of ['#session=s1&view=streams&join=2', '#session=s1&view=knowledge&join=2', '#session=s1&join=-1',
    '#session=s1&join=2.5', '#session=s1&join=', '#session=s1&join=abc', '#session=s1&join=1&join=2',
    '#session=s1&join=99999999999999999999', '#session=s1&join=1&sid=x']) {
    assert.equal(h.fns.parseSessionDeepLink(bad), null, bad);
  }
});

test('a join deep link never opens a stream and hands its index to the loader once', async () => {
  const h = harness();
  assert.equal(await h.fns.openSessionDeepLink('#session=sess-1&join=4'), true);
  assert.deepEqual(plain(h.fns.pending()), { id: 'sess-1', index: 4 });
  assert.deepEqual(h.calls, [], 'no API read is made by the deep link itself');
  await h.fns.loadJoin('sess-1', 1);
  assert.equal(h.fns.pending(), null, 'pending focus is consumed');
});

test('a requested message that is not in the join says so', () => {
  const h = harness();
  const present = h.fns.renderJoinHtml(joinValue([link({ messageIndex: 4 })], { verified: 1 }), TURNS, null, 4);
  assert.doesNotMatch(present, /is not in this join/);
  const missing = h.fns.renderJoinHtml(joinValue([link()], { verified: 1 }), TURNS, null, 4);
  assert.match(missing, /Requested stream message #4 is not in this join/);
});
