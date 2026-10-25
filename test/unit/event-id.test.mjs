// Unique, deterministic event identity: (sid, seq, n) per decoded event. Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { eventId, parseEventId, compareEventIds } from '../../src/replay/event-id.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');

// Synthetic SSE stream: request, response, one chunk carrying three events, a second chunk, then done.
function sseRecords(sid) {
  return [
    { k: 'req', sid, url: 'https://lab.test/api/chat', method: 'POST', type: 'Fetch', t: 1, seq: 1 },
    { k: 'res', sid, status: 200, mime: 'text/event-stream', t: 2, seq: 2 },
    { k: 'chunk', sid, t: 3, seq: 3, b64: b64('data: {"text":"a"}\n\ndata: {"text":"b"}\n\ndata: {"text":"c"}\n\n') },
    { k: 'chunk', sid, t: 4, seq: 4, b64: b64('data: {"text":"d"}\n\n') },
    { k: 'done', sid, t: 5, seq: 5 },
  ];
}

function runAll(records) {
  const r = new StreamReducer();
  const evs = [];
  for (const rec of records) evs.push(...r.ingest(rec));
  return { r, evs };
}

test('three events in one raw record share seq and get n 0,1,2 with unique ids', () => {
  const { evs } = runAll(sseRecords('s1'));
  const first = evs.filter((e) => e.seq === 3);
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((e) => e.n), [0, 1, 2]);
  const ids = first.map(eventId);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, ['s1#3.0', 's1#3.1', 's1#3.2']);
});

test('a second raw record gets a different seq, so its events never collide with the first', () => {
  const { evs } = runAll(sseRecords('s1'));
  const second = evs.filter((e) => e.seq === 4);
  assert.equal(second.length, 1);
  assert.equal(second[0].n, 0);
  const all = evs.map(eventId);
  assert.equal(new Set(all).size, all.length);
  assert.notEqual(eventId(second[0]), eventId(evs[0]));
});

test('re-running the same raw records through a fresh reducer gives identical ids', () => {
  const a = runAll(sseRecords('s1')).evs.map(eventId);
  const b = runAll(sseRecords('s1')).evs.map(eventId);
  assert.ok(a.length > 0);
  assert.deepEqual(a, b);
});

test('eventId and parseEventId round-trip, including a sid with colons and hashes', () => {
  for (const sid of ['plain', 'tab:1:abc', 'x#y:z', 'v1.2:chat']) {
    const e = { sid, seq: 42, n: 7 };
    const id = eventId(e);
    assert.equal(id, `${sid}#42.7`);
    assert.deepEqual(parseEventId(id), { sid, seq: 42, n: 7 });
  }
});

test('legacy event without n has no suffix and parses with n null', () => {
  const legacy = { sid: 'old:sid', seq: 9 };
  assert.equal(eventId(legacy), 'old:sid#9');
  assert.deepEqual(parseEventId('old:sid#9'), { sid: 'old:sid', seq: 9, n: null });
});

test('parseEventId returns null for malformed input', () => {
  for (const bad of [null, undefined, 42, '', 'nohash', '#5.1', 's#x.1', 's#5.x', 's#.1', 's#']) {
    assert.equal(parseEventId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('end-of-stream drain events carry the end record seq with n starting at 0', () => {
  // Unterminated SSE block: only the end-of-stream drain can surface it.
  const sid = 'drain';
  const recs = [
    { k: 'req', sid, url: 'https://lab.test/api/chat', method: 'GET', type: 'Fetch', t: 1, seq: 1 },
    { k: 'res', sid, status: 200, mime: 'text/event-stream', t: 2, seq: 2 },
    { k: 'chunk', sid, t: 3, seq: 3, b64: b64('data: {"text":"a"}\n\ndata: {"text":"tail"}') },
    { k: 'done', sid, t: 9, seq: 9 },
  ];
  const { evs } = runAll(recs);
  const drained = evs.filter((e) => e.seq === 9);
  assert.ok(drained.length >= 1, 'expected at least one drained event');
  assert.deepEqual(drained.map((e) => e.n), drained.map((_, i) => i));
  assert.equal(eventId(drained[0]), `${sid}#9.0`);
});

test('compareEventIds orders by seq, then n numerically', () => {
  const ids = ['s#10.0', 's#2.10', 's#2.2', 's#2.0', 's#3', 's#10.1'];
  const sorted = [...ids].sort(compareEventIds);
  assert.deepEqual(sorted, ['s#2.0', 's#2.2', 's#2.10', 's#3', 's#10.0', 's#10.1']);
  assert.equal(compareEventIds('s#2.1', 's#2.1'), 0);
  assert.ok(compareEventIds('s#2.1', 's#2.2') < 0);
  assert.ok(compareEventIds('s#9.0', 's#10.0') < 0);
});
