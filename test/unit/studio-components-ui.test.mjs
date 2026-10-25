// Frontend-only "Page components" panel and full event paging checks. No browser, no network, no live data.
// The code is loaded from index.html with a vm stub DOM (same approach as studio-join-ui.test.mjs).
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
const compStart = script.indexOf('/* ---------------- page components');
const compEnd = script.indexOf('/* ---------------- Knowledge workspace');
const comps = compStart > 0 && compEnd > compStart ? script.slice(compStart, compEnd) : '';
const pageStart = script.indexOf('/* ---------------- stream events paging');
const pageEnd = script.indexOf('async function openStream(sid)');
const paging = pageStart > 0 && pageEnd > pageStart ? script.slice(pageStart, pageEnd) : '';
const panelStart = html.indexOf('<h3>Page components');
const panelEnd = html.indexOf('<h3>Time travel</h3>');
const panel = panelStart > 0 && panelEnd > panelStart ? html.slice(panelStart, panelEnd) : '';

const COMP_SCHEMA = 'capture-studio.stream-components/1';
const PAYLOAD = '<img src=x onerror=alert(1)>';
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function compHarness({ sessionId = 'sess-1', responder } = {}) {
  const nodes = new Map();
  const node = () => ({ innerHTML: '', textContent: '', hidden: true, dataset: {}, querySelectorAll: () => [], querySelector: () => null,
    setAttribute() {}, classList: { toggle() {} } });
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node()); return nodes.get(sel); };
  const calls = [], replaced = [];
  const S = { sessionRequestSeq: 1, sessionId, sid: null };
  const api = (path) => { calls.push(path); return responder ? responder(path) : Promise.resolve(null); };
  const history = { replaceState: (_state, _title, url) => replaced.push(url) };
  const fns = runInNewContext(escLine + '\n' + navigation + '\n' + comps +
    '\n({parseSessionDeepLink,compDeepLinkHref,renderComponentsHtml,loadComponents,selectComponent,openSessionDeepLink,pendingComp:() => pendingCompFocus})',
    { $, S, api, history, URLSearchParams, show: () => {}, openSession: async () => true, selectSessionContext: () => {},
      loadStreams: async () => [], openStream: async () => true, toast: () => {}, guard: (f) => f }, { timeout: 2000 });
  return { fns, $, S, calls, replaced, out: () => $('#compOut').innerHTML };
}

const comp = (over = {}) => ({ componentKey: 'm1:0', component: 'paragraph', text: 'Hello', textTruncated: false, textLength: 5,
  opened: { seq: 3, n: 0 }, closed: { seq: 5, n: 1 }, ...over });
const mapped = (over = {}) => ({ sid: 'sid-1', mapId: 'claude-typed-events', eventsOmitted: 0,
  stats: { events: 4, components: 2, openComponents: 1, finalized: false, unmapped: 1 },
  components: [comp(), comp({ componentKey: null, component: 'list', text: 'x', opened: { seq: 6, n: 0 }, closed: null })],
  unmappedCount: 1, unmappedSample: [{ seq: 9, reason: 'no_rule_matched: type=ping' }], ...over });
const value = (streams, over = {}) => ({ schema: COMP_SCHEMA, streams,
  totals: { streams: streams.length, mapped: 1, noMap: 0, components: 2, unmappedCount: 1, eventsOmitted: 0 }, ...over });

test('Page components panel sits after Stream to page, loads with GET only and stays read-only', () => {
  assert.ok(panel.length > 80, 'panel markup found');
  assert.match(panel, /id="compPanel"/);
  assert.match(panel, /id="compOut" role="status" aria-live="polite"/);
  assert.doesNotMatch(panel, /<button/, 'static panel markup has no action');
  assert.ok(html.indexOf('<h3>Stream to page') < html.indexOf('<h3>Page components'), 'after the Stream to page panel');
  assert.match(script, /guard\(loadComponents\)\(id, requestSeq\);/);
  assert.doesNotThrow(() => new Script(script));
  assert.match(comps, /api\('sessions\/' \+ encodeURIComponent\(id\) \+ '\/components'\)/);
  assert.doesNotMatch(comps, /method\s*:|opts\.body|body\s*:|\bfetch\s*\(|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(comps, /\/derive|\/delete|\/import|\/save/);
});

test('table shows a component key and a null key, with opened and closed seq.n and the still-open hint', () => {
  const h = compHarness();
  const out = h.fns.renderComponentsHtml(value([mapped()]), null);
  assert.match(out, /m1:0/);
  assert.match(out, /no id observed/);
  assert.match(out, /still open/);
  assert.match(out, /stream not finalized/);
  assert.match(out, />3\.0</);
  assert.match(out, />5\.1</);
  assert.match(out, /data-comp="0\.0"/);
  assert.match(out, /data-comp="0\.1"/);
  assert.match(out, /<button type="button" class="row-action"/);
  assert.match(out, /Map <span class="mono">claude-typed-events<\/span>/);
});

test('long component text shows 160 characters with a truncated marker and the real length', () => {
  const h = compHarness();
  const long = h.fns.renderComponentsHtml(value([mapped({ components: [comp({ text: 'a'.repeat(200), textLength: 200 })] })]), null);
  assert.match(long, /truncated, 200 chars/);
  assert.ok(long.includes('a'.repeat(160)));
  assert.ok(!long.includes('a'.repeat(161)));
  const capped = h.fns.renderComponentsHtml(value([mapped({ components: [comp({ text: 'b'.repeat(2000), textTruncated: true, textLength: 2500 })] })]), null);
  assert.match(capped, /truncated, 2500 chars/);
  const short = h.fns.renderComponentsHtml(value([mapped()]), null);
  assert.doesNotMatch(short, /truncated, /);
});

test('unmapped count and a clickable-free sample with reason text are shown', () => {
  const h = compHarness();
  const out = h.fns.renderComponentsHtml(value([mapped({ unmappedCount: 7, unmappedSample: [{ seq: 9, reason: 'no_rule_matched: type=ping' }] })]), null);
  assert.match(out, /7 stream message\(s\) not placed into any component/);
  assert.match(out, /#9 no_rule_matched: type=ping/);
  assert.match(out, /Showing 1 of 7\./);
  const tail = out.slice(out.indexOf('not placed into any component'));
  assert.doesNotMatch(tail, /<button/, 'the sample list has no action');
});

test('mapId null shows the candidate list and no components are guessed', () => {
  const h = compHarness();
  const out = h.fns.renderComponentsHtml(value([{ sid: 'sid-2', mapId: null, eventsOmitted: 0,
    candidates: [{ id: 'claude-typed-events', matched: 0 }, { id: 'chatgpt-path-ops', matched: 0 }] }], { totals: { streams: 1, mapped: 0, noMap: 1, components: 0, unmappedCount: 0, eventsOmitted: 0 } }), null);
  assert.match(out, /no built-in map matched this stream/);
  assert.match(out, /claude-typed-events matched 0 event\(s\)/);
  assert.match(out, /chatgpt-path-ops matched 0 event\(s\)/);
  assert.doesNotMatch(out, /<table/);
  assert.doesNotMatch(out, /data-comp=/);
  assert.doesNotMatch(out, /<button/);
});

test('not_derived, no_events, error and unexpected responses each say so with no action', () => {
  const h = compHarness();
  const cases = [
    [{ status: 'not_derived' }, /have not been derived/],
    [{ schema: COMP_SCHEMA, status: 'no_events' }, /no decoded stream events/],
    [{ schema: COMP_SCHEMA, error: PAYLOAD }, /could not be computed/],
    [[], /Unexpected page-components response/],
    [{ schema: 'other/9', streams: [] }, /Unrecognized page-components response/],
  ];
  for (const [v, re] of cases) {
    const out = h.fns.renderComponentsHtml(v, null);
    assert.match(out, re);
    assert.doesNotMatch(out, /<button|<form|<input/, 'no action in state ' + JSON.stringify(v));
  }
  const err = h.fns.renderComponentsHtml({ schema: COMP_SCHEMA, error: PAYLOAD }, null);
  assert.ok(err.includes(ESCAPED));
  assert.doesNotMatch(err, /<img/);
});

test('markup in component text, key and unmapped reason renders as text', () => {
  const h = compHarness();
  const out = h.fns.renderComponentsHtml(value([mapped({
    components: [comp({ text: PAYLOAD, componentKey: PAYLOAD })],
    unmappedCount: 1, unmappedSample: [{ seq: 2, reason: PAYLOAD }],
  })]), null);
  assert.ok(out.includes(ESCAPED), 'payload appears as escaped text');
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /onerror=alert\(1\)>/);
});

test('loader shows not_derived from the components endpoint and a load error without stale rows', async () => {
  const notDerived = compHarness({ responder: () => Promise.resolve({ status: 'not_derived' }) });
  await notDerived.fns.loadComponents('sess-1', 1);
  assert.deepEqual(notDerived.calls, ['sessions/sess-1/components']);
  assert.match(notDerived.out(), /have not been derived/);

  const failing = compHarness({ responder: () => Promise.reject(new Error('Studio unreachable ' + PAYLOAD)) });
  await failing.fns.loadComponents('sess-1', 1);
  assert.match(failing.out(), /Could not load page components/);
  assert.ok(failing.out().includes(ESCAPED));
  assert.doesNotMatch(failing.out(), /<img/);
});

test('a stale components response from a previous session selection is dropped', async () => {
  const first = deferred();
  const h = compHarness({ sessionId: 'sess-1', responder: () => first.promise });
  const run = h.fns.loadComponents('sess-1', 1);
  h.S.sessionId = 'sess-2';
  h.S.sessionRequestSeq = 2;
  first.resolve(value([mapped()]));
  await run;
  assert.doesNotMatch(h.out(), /data-comp=/);
  assert.match(h.out(), /Loading page components/);
});

test('component deep-link parameter round-trips and is validated like the existing parameters', () => {
  const h = compHarness();
  const href = h.fns.compDeepLinkHref('s 1/x', '0.1');
  assert.equal(href, '#session=s%201%2Fx&view=sessions&comp=0.1');
  assert.deepEqual(plain(h.fns.parseSessionDeepLink(href)), { id: 's 1/x', view: 'sessions', sid: null, seq: null, join: null, comp: { stream: 0, component: 1 } });
  assert.deepEqual(plain(h.fns.parseSessionDeepLink('#session=s1&comp=0.0')).comp, { stream: 0, component: 0 });
  // Existing join links keep exactly the same parsed shape (no comp key appears).
  assert.deepEqual(plain(h.fns.parseSessionDeepLink('#session=s1&view=sessions&join=3')), { id: 's1', view: 'sessions', sid: null, seq: null, join: 3 });
  for (const bad of ['#session=s1&comp=a.b', '#session=s1&comp=1', '#session=s1&comp=1.2.3', '#session=s1&comp=-1.0',
    '#session=s1&view=streams&comp=0.1', '#session=s1&view=knowledge&comp=0.1', '#session=s1&join=1&comp=0.1',
    '#session=s1&comp=0.1&comp=0.2', '#session=s1&comp=99999999999999999999.0', '#session=s1&comp=0.1&sid=x', '#session=s1&comp=']) {
    assert.equal(h.fns.parseSessionDeepLink(bad), null, bad);
  }
});

test('selecting a component sets comp= with replaceState and aria-pressed; the parser reads it back', () => {
  const h = compHarness({ sessionId: 'sess-1' });
  const btn = { dataset: { comp: '0.1' }, setAttribute() {}, classList: { toggle() {} } };
  const out = h.$('#compOut');
  out.querySelector = (sel) => (sel === 'button[data-comp="0.1"]' ? btn : null);
  assert.equal(h.fns.selectComponent('0.1'), true);
  assert.equal(h.fns.selectComponent('0.9'), false, 'unknown row selects nothing');
  assert.deepEqual(h.replaced, ['#session=sess-1&view=sessions&comp=0.1']);
  assert.deepEqual(plain(h.fns.parseSessionDeepLink(h.replaced[0])).comp, { stream: 0, component: 1 });
});

test('a comp deep link never opens a stream and hands its focus to the loader', async () => {
  const h = compHarness();
  assert.equal(await h.fns.openSessionDeepLink('#session=sess-1&comp=1.2'), true);
  assert.deepEqual(plain(h.fns.pendingComp()), { id: 'sess-1', comp: { stream: 1, component: 2 } });
  assert.deepEqual(h.calls, [], 'no API read is made by the deep link itself');
});

test('keyboard: rows are native buttons and Enter or Space select the focused row', () => {
  const h = compHarness();
  const out = h.fns.renderComponentsHtml(value([mapped()]), null);
  assert.doesNotMatch(out, /role="button"|tabindex|onclick=/);
  assert.match(comps, /out\.onkeydown = \(ev\) =>/);
  assert.match(comps, /ev\.key === 'Enter' \|\| ev\.key === ' '/);
  assert.match(comps, /selectComponent\(b\.dataset\.comp\)/);
});

test('the components focus from a deep link is reported missing when the derivation has no such row', () => {
  const h = compHarness();
  const present = h.fns.renderComponentsHtml(value([mapped()]), { stream: 0, component: 1 });
  assert.doesNotMatch(present, /is not in this derivation/);
  const missing = h.fns.renderComponentsHtml(value([mapped()]), { stream: 0, component: 9 });
  assert.match(missing, /Requested component 0\.9 is not in this derivation/);
});

// ---- event paging ----

function pagingHarness({ pages = [], sessionId = 'sess-1', sid = 'A' } = {}) {
  const fetches = [], appended = [];
  const nodes = new Map();
  const node = () => ({ innerHTML: '', textContent: '', onclick: null, querySelector: () => null, querySelectorAll: () => [] });
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node()); return nodes.get(sel); };
  const S = { sid, sessionId, streamRequestSeq: 1 };
  const fetch = (url) => {
    fetches.push(url);
    const next = pages[fetches.length - 1];
    if (!next) return Promise.reject(new Error('unexpected request ' + url));
    const make = () => new Response(JSON.stringify(next.body), { status: 200, headers: next.header === undefined ? {} : { 'X-Next-After': next.header } });
    return (next.gate ?? Promise.resolve()).then(make);
  };
  const fns = runInNewContext(paging + '\n({apiPaged, eventsPagePath, newEventPaging, mergeEventPage, loadEventPage, renderEventMore, canLoadEventPage,' +
    ' setPaging: (v) => { evPaging = v; }, EV_ROWS_CAP})',
    { $, S, fetch, src: () => ({ kind: 'session', id: sessionId }), appendEvent: (e) => appended.push(e), guard: (f) => f, toast: () => {} }, { timeout: 2000 });
  return { fns, $, S, fetches, appended };
}

const seqRange = (from, to, extra = {}) => Array.from({ length: to - from + 1 }, (_, i) => ({ sid: 'A', seq: from + i, n: 0, ...extra }));

test('paging: first page with a cursor then a second page without one gives exactly the union, no duplicates', async () => {
  const page1 = seqRange(1, 2000);
  const repeated = { sid: 'A', seq: 2000, n: 0 };
  const page2 = [repeated, ...seqRange(2001, 2500)];
  const h = pagingHarness({ pages: [{ body: page1, header: '2000' }, { body: page2 }] });
  const first = await h.fns.apiPaged(h.fns.eventsPagePath('sess-1', 'A', null));
  const state = h.fns.newEventPaging('sess-1', 'A', false);
  h.fns.setPaging(state);
  h.fns.mergeEventPage(state, first.json, first.nextAfter);
  assert.equal(state.cursor, '2000');
  h.fns.renderEventMore(state);
  assert.match(h.$('#evMeta').textContent, /showing 2000 events, more available/);
  assert.match(h.$('#evMore').innerHTML, /Load more events/);
  await h.$('#evLoadMore').onclick();
  assert.deepEqual(h.fetches, ['/api/sessions/sess-1/events/A', '/api/sessions/sess-1/events/A?after=2000']);
  assert.deepEqual(h.appended.map((e) => e.seq), Array.from({ length: 2500 }, (_, i) => i + 1));
  assert.equal(new Set(h.appended.map((e) => e.seq)).size, 2500);
  assert.equal(state.cursor, null);
  assert.equal(h.$('#evMeta').textContent, 'all 2500 events loaded');
  assert.equal(h.$('#evMore').innerHTML, '');
});

test('paging: the last page issues no further request, even when called directly', async () => {
  const h = pagingHarness({ pages: [{ body: seqRange(1, 3) }] });
  const first = await h.fns.apiPaged(h.fns.eventsPagePath('sess-1', 'A', null));
  assert.equal(first.nextAfter, null, 'no header on the last page');
  const state = h.fns.newEventPaging('sess-1', 'A', false);
  h.fns.setPaging(state);
  h.fns.mergeEventPage(state, first.json, first.nextAfter);
  h.fns.renderEventMore(state);
  assert.equal(h.fns.canLoadEventPage(state), false);
  assert.equal(await h.fns.loadEventPage(state), false);
  assert.equal(h.fetches.length, 1, 'only the first page was requested');
  assert.equal(h.$('#evMeta').textContent, 'all 3 events loaded');
});

test('paging: the helper reads X-Next-After case-insensitively and ignores a missing or non-numeric value', async () => {
  const custom = (headers) => runInNewContext(paging + '\n({apiPaged})', {
    $: () => ({}), S: { sid: 'A', sessionId: 's' }, src: () => ({ id: 's' }), appendEvent: () => {}, guard: (f) => f, toast: () => {},
    fetch: async () => ({ ok: true, status: 200, headers: headers(), json: async () => [] }),
  }, { timeout: 2000 }).apiPaged;
  const lower = custom(() => ({ get: (name) => ({ 'x-next-after': '7' })[String(name).toLowerCase()] ?? null }));
  assert.equal((await lower('sessions/s/events/A')).nextAfter, '7');
  const store = { 'X-NEXT-AFTER': '42' };
  const upper = custom(() => ({ get: (name) => { const k = Object.keys(store).find((x) => x.toLowerCase() === String(name).toLowerCase()); return k ? store[k] : null; } }));
  assert.equal((await upper('sessions/s/events/A')).nextAfter, '42', 'a header stored in upper case is found by the helper');
  const real = pagingHarness({ pages: [{ body: [], header: '2000' }, { body: [], header: 'abc' }] });
  assert.equal((await real.fns.apiPaged('sessions/sess-1/events/A')).nextAfter, '2000');
  assert.equal((await real.fns.apiPaged('sessions/sess-1/events/A')).nextAfter, null, 'non-numeric header is not a cursor');
});

test('paging: the safety cap stops loading and labels it; the cap is 100000 rows by default', async () => {
  assert.equal(pagingHarness().fns.EV_ROWS_CAP, 100000);
  const h = pagingHarness({ pages: [{ body: seqRange(1, 5), header: '5' }, { body: seqRange(6, 9) }] });
  const state = h.fns.newEventPaging('sess-1', 'A', false);
  state.cap = 3;
  h.fns.setPaging(state);
  const first = await h.fns.apiPaged(h.fns.eventsPagePath('sess-1', 'A', null));
  h.fns.mergeEventPage(state, first.json, first.nextAfter);
  h.fns.renderEventMore(state);
  assert.equal(state.rows, 3);
  assert.match(h.$('#evMeta').textContent, /stopped at cap: 3 events in memory \(limit 3\)/);
  assert.equal(h.$('#evMore').innerHTML, '', 'no load control once capped');
  assert.equal(await h.fns.loadEventPage(state), false);
  assert.equal(h.fetches.length, 1, 'no request beyond the cap');
});

test('paging: reaching the cap exactly with a cursor is still labelled as stopped', () => {
  const h = pagingHarness();
  const state = h.fns.newEventPaging('sess-1', 'A', false);
  state.cap = 3;
  h.fns.setPaging(state);
  h.fns.mergeEventPage(state, seqRange(1, 3), '3');
  h.fns.renderEventMore(state);
  assert.match(h.$('#evMeta').textContent, /stopped at cap/);
  assert.equal(h.fns.canLoadEventPage(state), false);
});

test('paging: rows with the same seq and n are unique; rows without n are all kept', () => {
  const h = pagingHarness();
  const state = h.fns.newEventPaging('sess-1', 'A', false);
  h.fns.setPaging(state);
  const added = h.fns.mergeEventPage(state, [{ sid: 'A', seq: 4, n: 0 }, { sid: 'A', seq: 4, n: 0 }, { sid: 'A', seq: 4, n: 1 },
    { sid: 'A', seq: 5, t: 1 }, { sid: 'A', seq: 5, t: 2 }], null);
  assert.equal(added, 4);
  assert.equal(h.appended.length, 4);
});

test('paging: a page for a replaced stream is dropped', async () => {
  const gate = deferred();
  const h = pagingHarness({ pages: [{ body: seqRange(3, 4), gate: gate.promise }] });
  const state = h.fns.newEventPaging('sess-1', 'A', false);
  h.fns.setPaging(state);
  h.fns.mergeEventPage(state, seqRange(1, 2), '2');
  const run = h.fns.loadEventPage(state);
  h.fns.setPaging(h.fns.newEventPaging('sess-1', 'B', false));
  gate.resolve();
  assert.equal(await run, false);
  assert.deepEqual(h.appended.map((e) => e.seq), [1, 2], 'no rows from the replaced stream were added');
});

test('paging: openStream reads the first page through the cursor helper and no fetch is unbounded', () => {
  assert.match(script, /apiPaged\(eventsPagePath\(id, sid, null\)\)/);
  assert.match(script, /evPaging = newEventPaging\(id, sid, s\.kind === 'live'\);/);
  assert.match(html, /<div id="evMore" class="pad" role="status" aria-live="polite"><\/div>/);
  assert.doesNotMatch(paging, /\bapi\(/, 'paging code never uses the plain api() helper');
  assert.match(paging, /X-Next-After/);
  assert.match(paging, /EV_ROWS_CAP = 100000/);
});
