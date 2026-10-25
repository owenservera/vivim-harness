// Frontend-only Records panel contract checks. No browser, no network, no live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../src/studio/ui/index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1]?.split('</script>')[0] ?? '';
const escLine = script.split('\n').find((line) => line.startsWith('const esc = '));
const recStart = script.indexOf('/* ---------------- records (read-only view of saved datasets)');
const recEnd = script.indexOf("/* Read-only rendering of Core's read-through continuity contract. */");
const records = recStart >= 0 && recEnd > recStart ? script.slice(recStart, recEnd) : '';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ sessionId = 'sess-1', responder } = {}) {
  const nodes = new Map();
  const $ = (sel) => { if (!nodes.has(sel)) nodes.set(sel, { innerHTML: '', value: '' }); return nodes.get(sel); };
  const calls = [];
  const S = { sessionRequestSeq: 1, sessionId };
  const api = (path) => { calls.push(path); return responder ? responder(path) : Promise.resolve([]); };
  const fns = runInNewContext(escLine + '\n' + records + '\n({recordCell,renderRecordTable,loadRecords,recordPickerOptions})',
    { $, S, api }, { timeout: 1000 });
  return { fns, $, S, calls, out: () => $('#recOut').innerHTML };
}

test('Records panel exists in Sessions detail with a dataset picker and output region', () => {
  assert.match(html, /id="recPanel"/);
  assert.match(html, /id="recPicker"[^>]*aria-label="Saved dataset to read"/);
  assert.match(html, /id="recOut"/);
  assert.match(script, /\$\('#recPicker'\)\.onchange = \(\) => loadRecords\(id, datasets, requestSeq/);
  assert.match(script, /loadRecords\(id, datasets, requestSeq, recDefault\)/);
  assert.doesNotThrow(() => new Script(script));
});

test('Records panel adds no write action or new route', () => {
  assert.equal(records.length > 500, true);
  assert.doesNotMatch(records, /method:\s*'POST'|opts\.body|body:/);
  assert.doesNotMatch(records, /\/derive|\/delete|\/import|\/save/);
  assert.doesNotMatch(html.slice(html.indexOf('id="recPanel"'), html.indexOf('id="recPanel"') + 600), /<button/);
  assert.doesNotMatch(records, /core|Core API|localhost:\d/i);
});

test('Row cells and headers are escaped; raw innerHTML is never fed row data', () => {
  assert.match(records, /'<th>' \+ esc\(k\) \+ '<\/th>'/);
  assert.match(records, /recordCell\(r\[k\]\)/);
  const h = harness();
  const payload = '<img src=x onerror=alert(1)>';
  const table = h.fns.renderRecordTable([{ [payload]: payload, note: { nested: payload } }], false);
  assert.match(table, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(table, /<img/);
  assert.equal(h.fns.recordCell(payload), '&lt;img src=x onerror=alert(1)&gt;');
  assert.doesNotMatch(h.fns.recordCell({ a: payload }), /<img/);
});

test('Long values carry a truncated marker and the real length', () => {
  const h = harness();
  const long = 'x'.repeat(250);
  const cell = h.fns.recordCell(long);
  assert.match(cell, /truncated, real length 250 chars/);
  assert.ok(cell.includes('x'.repeat(200)));
  assert.ok(!cell.includes('x'.repeat(201)));
  assert.equal(h.fns.recordCell('short'), 'short');
});

test('API limit applies: shows N of more than N and never more than the page size', async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ n: i }));
  const h = harness({ responder: () => Promise.resolve(rows) });
  await h.fns.loadRecords('sess-1', ['family-ai-chat-message'], 1, 'family-ai-chat-message');
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0], /\/dataset\/family-ai-chat-message\?limit=51$/);
  assert.match(h.out(), /showing 50 of more than 50 rows \(API limit 50; total not reported\)/);
  assert.equal((h.out().match(/<tr>/g) || []).length, 51, 'header plus 50 body rows');
});

test('Under the limit the table shows an exact row count without a truncation claim', async () => {
  const h = harness({ responder: () => Promise.resolve([{ a: 1 }, { a: 2 }]) });
  await h.fns.loadRecords('sess-1', ['streams'], 1, 'streams');
  assert.match(h.out(), /2 rows/);
  assert.doesNotMatch(h.out(), /API limit|more than/);
});

test('Empty dataset shows an explicit no-rows state', async () => {
  const h = harness({ responder: () => Promise.resolve([]) });
  await h.fns.loadRecords('sess-1', ['streams'], 1, 'streams');
  assert.match(h.out(), /No rows in this dataset/);
  assert.doesNotMatch(h.out(), /<table/);
});

test('Missing dataset says not derived yet, makes no request and offers no write action', async () => {
  const h = harness();
  await h.fns.loadRecords('sess-1', [], 1, 'family-ai-chat-message');
  assert.equal(h.calls.length, 0);
  assert.match(h.out(), /has not been derived yet/);
  assert.doesNotMatch(h.out(), /<button|<form|<input|Rebuild|\/derive/i);
  assert.match(h.fns.recordPickerOptions(['streams']), /family-ai-chat-message \(not derived yet\)/);
});

test('Stale dataset response never replaces a newer selection', async () => {
  const first = deferred(), second = deferred();
  const h = harness({ responder: (path) => path.includes('/streams') ? second.promise : first.promise });
  const a = h.fns.loadRecords('sess-1', ['family-ai-chat-message', 'streams'], 1, 'family-ai-chat-message');
  const b = h.fns.loadRecords('sess-1', ['family-ai-chat-message', 'streams'], 1, 'streams');
  second.resolve([{ label: 'newer choice' }]);
  await b;
  first.resolve([{ label: 'stale choice' }]);
  await a;
  assert.match(h.out(), /newer choice/);
  assert.doesNotMatch(h.out(), /stale choice/);
});

test('Records from a previously selected session are dropped', async () => {
  const late = deferred();
  const h = harness({ responder: () => late.promise });
  const run = h.fns.loadRecords('sess-1', ['streams'], 1, 'streams');
  h.S.sessionId = 'sess-2';
  late.resolve([{ leaked: 'yes' }]);
  await run;
  assert.doesNotMatch(h.out(), /leaked/);
});
