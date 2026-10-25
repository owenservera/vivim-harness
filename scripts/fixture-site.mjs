// Deterministic local fixture site for the Capture Studio live end-to-end driver.
//
// Everything here is synthetic and fixed: no real website data, no randomness, no clock
// dependent content. Two runs produce byte-identical responses, so the driver can compare
// captured bytes with the fixture and know that a difference is a real difference.
//
//   node scripts/fixture-site.mjs            # prints the URL and stays up
//   import { startFixture } from './fixture-site.mjs'
//
// Endpoints
//   GET  /            HTML page; its inline script streams SSE text into the DOM, loads a
//                     JSON list and opens one WebSocket-free long poll
//   POST /api/chat    text/event-stream: 12 `data: {"delta":"word …"}` events 80 ms apart,
//                     then `data: [DONE]`
//   GET  /api/items   JSON array of 8 objects {id, name, price}
//   GET  /api/ndjson  application/x-ndjson: 6 lines spread over 300 ms
//   GET  /data.csv    text/csv: a small table
//   GET  /api/poll    long poll: answers with 204 after ?wait=ms (nothing else)

import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The twelve streamed words. Distinct, >= 8 characters and sharing the "word" prefix so the
// driver can (a) check that they appear in order in an export and (b) search for one of them
// and for a one-character typo of it.
export const CHAT_WORDS = Object.freeze([
  'wordalpha', 'wordbravo', 'wordcharl', 'worddelta', 'wordecho', 'wordfoxtrot',
  'wordgolf', 'wordhotel', 'wordindia', 'wordjuliet', 'wordkilo', 'wordlima',
]);

// A word from CHAT_WORDS with one transposed pair of characters (edit distance 1).
export const CHAT_WORD_TYPO = 'wordalpa';

// The JSON list served by GET /api/items.
export const ITEMS = Object.freeze([
  { id: 'item-01', name: 'Widget', price: 9.5 },
  { id: 'item-02', name: 'Gadget', price: 19.25 },
  { id: 'item-03', name: 'Doohickey', price: 3.75 },
  { id: 'item-04', name: 'Thingamabob', price: 42 },
  { id: 'item-05', name: 'Gizmo', price: 7.25 },
  { id: 'item-06', name: 'Sprocket', price: 15.5 },
  { id: 'item-07', name: 'Flange', price: 5.75 },
  { id: 'item-08', name: 'Bracket', price: 11.4 },
]);

// The table served by GET /data.csv.
export const CSV_TEXT = [
  'id,name,price',
  'item-01,Widget,9.50',
  'item-02,Gadget,19.25',
  'item-03,Doohickey,3.75',
  'item-04,Thingamabob,42.00',
  '',
].join('\n');

// The lines served by GET /api/ndjson.
export const NDJSON_ROWS = Object.freeze(Array.from({ length: 6 }, (_, i) => ({
  id: `row-${String(i + 1).padStart(2, '0')}`,
  label: `row ${i + 1}`,
  value: (i + 1) * 10,
})));

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Capture Studio Fixture</title></head>
<body><main>
<h1>Capture Studio fixture page</h1>
<div data-role="user">hello fixture</div>
<pre id="stream" data-role="assistant"></pre>
<ul id="items"></ul>
</main>
<script>
(async () => {
  // (a) POST /api/chat: read the SSE stream and render every delta into the DOM.
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hello fixture' }) });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\\n\\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = raw.split('\\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (typeof j.delta === 'string') { text += j.delta; document.getElementById('stream').textContent = text; }
        } catch (e) { /* not a delta frame */ }
      }
    }
  } catch (e) { /* the driver reports the failure */ }
  // (b) GET /api/items: a plain JSON list rendered into the DOM.
  try {
    const items = await fetch('/api/items').then((r) => r.json());
    const ul = document.getElementById('items');
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = it.id + ' ' + it.name + ' ' + it.price;
      ul.appendChild(li);
    }
  } catch (e) { /* the driver reports the failure */ }
  // (c) one WebSocket-free long poll that returns nothing.
  try { await fetch('/api/poll?wait=400'); } catch (e) { /* the driver reports the failure */ }
})();
</script>
</body></html>`;

/**
 * Start the fixture site.
 * @param {{port?: number, host?: string}} [options]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export async function startFixture({ port = 0, host = '127.0.0.1', outcomeText = '' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;
    try {
      if (p === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PAGE);
        return;
      }
      if (p === '/api/chat' && req.method === 'POST') {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const w of CHAT_WORDS) {
          await sleep(80);
          res.write(`data: ${JSON.stringify({ delta: `${w} ` })}\n\n`);
        }
        if (outcomeText) res.write(`data: ${JSON.stringify({ delta: '\n' + outcomeText })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (p === '/api/items' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(ITEMS));
        return;
      }
      if (p === '/api/ndjson' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
        for (const row of NDJSON_ROWS) {
          await sleep(50);
          res.write(`${JSON.stringify(row)}\n`);
        }
        res.end();
        return;
      }
      if (p === '/data.csv' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
        res.end(CSV_TEXT);
        return;
      }
      if (p === '/api/poll') {
        req.resume();
        const wait = Math.min(2000, Math.max(0, Number(url.searchParams.get('wait') ?? 200) || 0));
        await sleep(wait);
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String(e?.message ?? e)); } catch { /* socket gone */ }
    }
  });
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });

  const actualPort = server.address().port;
  return {
    url: `http://${host}:${actualPort}/`,
    port: actualPort,
    close: () => new Promise((resolve) => {
      try { server.closeAllConnections?.(); } catch { /* not available */ }
      server.close(() => resolve());
    }),
  };
}

if (process.argv[1] && process.argv[1].endsWith('fixture-site.mjs')) {
  const fixture = await startFixture({ port: Number(process.argv[2] ?? 0) });
  console.log(`fixture site on ${fixture.url}`);
}
