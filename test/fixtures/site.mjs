// Synthetic test site reproducing the transport patterns the studio must handle.
// No real website data; deterministic content.
import http from 'node:http';
import { createHash } from 'node:crypto';

const PAGE = `<!doctype html><html><head><title>Fixture Chat</title></head><body>
<main>
  <h1>Fixture conversation</h1>
  <div id="thread"></div>
  <ul id="items"></ul>
  <textarea id="prompt" aria-label="Message"></textarea>
  <button id="ask">Send</button>
  <button id="ask-long">Send long</button>
  <button id="ask-flaky">Send flaky</button>
</main>
<script>
const thread = document.getElementById('thread');
async function ask(long, flaky) {
  const u = document.createElement('div'); u.setAttribute('data-role', 'user'); u.textContent = 'hi'; thread.appendChild(u);
  const msg = document.createElement('div'); msg.className = 'msg assistant'; msg.setAttribute('data-role', 'assistant');
  const p = document.createElement('p'); msg.appendChild(p); thread.appendChild(msg);
  let r;
  try { r = await fetch('/api/conversation' + (flaky ? '?break=1' : long ? '?long=1' : ''), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SECRET-REQUEST-TOKEN-1234567890' }, body: JSON.stringify({ prompt: 'hi' }) });
  const reader0 = r.body.getReader(); await readAll(reader0, p); } catch (e) { if (flaky) { p.textContent = ''; return ask(false, false); } }
}
async function readAll(reader, p) {
  const dec = new TextDecoder(); let buf = '', text = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\\n\\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = ev.split('\\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\\n');
      if (data === '[DONE]') continue;
      try { const j = JSON.parse(data); if (typeof j.v === 'string') { text += j.v; p.textContent = text; } } catch {}
    }
  }
}
document.getElementById('ask').onclick = () => ask(false);
document.getElementById('ask-long').onclick = () => ask(true);
document.getElementById('ask-flaky').onclick = () => ask(false, true);
fetch('/api/auth/session').then(r => r.json());
fetch('/api/items').then(r => r.json()).then(j => { const ul = document.getElementById('items'); for (const it of j.items) { const li = document.createElement('li'); li.className = 'item'; li.innerHTML = '<a href="https://example.org/' + it.id + '">' + it.title + '</a> <time datetime="' + it.created_at + '">' + it.created_at + '</time>'; ul.appendChild(li); } });
for (let i = 0; i < 3; i++) fetch('/api/beacon', { method: 'POST', body: 'x' });
window.es = new EventSource('/api/events');
window.ws = new WebSocket('ws://' + location.host + '/ws');
window.ws.onopen = () => window.ws.send(JSON.stringify({ type: 'subscribe', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3cyJ9.c2lnbmF0dXJlc2lnbmF0dXJl' }));
fetch('/api/feed').then(r => r.text());
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const LONG_WORDS = 400;

function wsAccept(key) { return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); }
function wsFrame(text) {
  const payload = Buffer.from(text);
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}


// ---------------- additional, substantially different site patterns ----------------
const CLAUDE_PAGE = `<!doctype html><html><head><title>Fixture Assistant B</title></head><body>
<div class="app"><section id="convo"></section>
<div contenteditable="true" id="composer" aria-label="Write a message"></div><button id="send" aria-label="Send message">Send</button></div>
<script>
const convo = document.getElementById('convo');
const CID = '7a7a7a7a-1111-2222-3333-444444444444';
document.getElementById('send').onclick = async () => {
  const h = document.createElement('div'); h.setAttribute('data-speaker', 'human'); h.innerHTML = '<p>Explain the plan</p>'; convo.appendChild(h);
  const a = document.createElement('div'); a.setAttribute('data-speaker', 'assistant'); const live = document.createElement('p'); a.appendChild(live); convo.appendChild(a);
  const r = await fetch('/api/chat_conversations/' + CID + '/completion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Explain the plan' }) });
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', text = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\\n\\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = ev.split('\\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('');
      try { const j = JSON.parse(data); if (j.type === 'content_block_delta') { text += j.delta.text; live.textContent = text; } } catch {} } }
  // The app re-renders the finished reply as rich content.
  a.innerHTML = '<h3>The plan</h3><p>' + text + ' See <a href="https://example.org/source" class="citation-link">[1]</a>.</p>' +
    '<ol><li>Collect the data</li><li>Model it<ul><li>entities</li><li>relations</li></ul></li></ol>' +
    '<table><thead><tr><th>Step</th><th>Owner</th></tr></thead><tbody><tr><td>Collect</td><td>Ana</td></tr><tr><td>Model</td><td>Ben</td></tr></tbody></table>' +
    '<pre><code class="language-python">print("plan")</code></pre>' +
    '<span class="katex-display"><span class="katex"><math><semantics><annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math></span></span>' +
    '<blockquote><p>Quoted note</p></blockquote>';
};
</script></body></html>`;

const DASHBOARD_PAGE = `<!doctype html><html><head><title>Fixture Dashboard</title></head><body><main>
<h1>Markets</h1><table id="t"><thead><tr><th>Symbol</th><th>Price</th><th>Updated</th></tr></thead><tbody></tbody></table>
<div id="cpu" aria-live="polite"></div></main>
<script>
const rows = {}; const tb = document.querySelector('#t tbody');
for (const s of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) { const tr = document.createElement('tr'); tr.innerHTML = '<td>' + s + '</td><td class="p">-</td><td class="u">-</td>'; tb.appendChild(tr); rows[s] = tr; }
const ws = new WebSocket('ws://' + location.host + '/ws-ticks');
ws.onmessage = (m) => { const j = JSON.parse(m.data); const tr = rows[j.symbol]; if (tr) { tr.querySelector('.p').textContent = j.price.toFixed(2); tr.querySelector('.u').textContent = new Date(j.ts).toISOString().slice(11, 19); } };
setInterval(() => fetch('/api/metrics').then(r => r.json()).then(j => { document.getElementById('cpu').textContent = 'CPU ' + j.cpu + '%'; }), 300);
</script></body></html>`;

const FEED_PAGE = `<!doctype html><html><head><title>Fixture Feed</title><style>.post{height:220px}</style></head><body><main><h1>Latest posts</h1><div id="list"></div><div id="sentinel">Loading…</div></main>
<script>
let page = 0, loading = false;
async function more() { if (loading || page >= 4) return; loading = true; page++;
  const j = await fetch('/api/posts?page=' + page).then(r => r.json());
  for (const it of j.results) { const a = document.createElement('article'); a.className = 'post'; a.innerHTML = '<h2><a href="' + it.url + '">' + it.title + '</a></h2><p class="by">' + it.author + '</p><time datetime="' + it.published_at + '">' + it.published_at + '</time><p>' + it.summary + '</p>'; document.getElementById('list').appendChild(a); }
  loading = false; }
addEventListener('scroll', () => { if (innerHeight + scrollY > document.body.scrollHeight - 300) more(); }, { passive: true });
more();
</script></body></html>`;

const FORM_PAGE = `<!doctype html><html><head><title>Fixture Signup</title></head><body><main><h1>Create account</h1>
<form id="f" onsubmit="return false">
<section data-step="1"><label>Name <input name="name"></label><label>Email <input name="email" type="email"></label><button type="button" class="next">Next</button></section>
<section data-step="2" hidden><label>Plan <select name="plan"><option>basic</option><option>pro</option></select></label><label>Company <input name="company"></label><button type="button" class="next">Continue</button></section>
<section data-step="3" hidden><label><input type="checkbox" name="terms"> Accept terms</label><button type="submit" id="submit">Submit</button></section>
</form><p id="status" aria-live="polite"></p></main>
<script>
const f = document.getElementById('f'); let step = 1;
async function send(final) { const data = Object.fromEntries(new FormData(f)); const r = await fetch('/api/signup/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, final, data }) }); return r.json(); }
document.querySelectorAll('.next').forEach(b => b.onclick = async () => { const j = await send(false); document.querySelector('[data-step="' + step + '"]').hidden = true; step = j.next; document.querySelector('[data-step="' + step + '"]').hidden = false; });
document.getElementById('submit').onclick = async () => { const j = await send(true); document.getElementById('status').textContent = 'Submitted: ' + j.reference; };
</script></body></html>`;

const ARTICLE_PAGE = `<!doctype html><html><head><title>Fixture Article</title></head><body><main><article>
<h1>Field notes on capture</h1><p class="byline">By A. Writer</p>
<h2>Background</h2><p>${'Long form paragraph text about observation and fidelity. '.repeat(12)}</p>
<figure><img src="/img/chart.png" alt="Chart of results" width="2" height="2"><figcaption>Figure 1. Results</figcaption></figure>
<h2>Method</h2><p>${'Another long paragraph describing the method in detail. '.repeat(12)}</p>
<video src="/media/clip.mp4" controls></video>
<h2>Downloads</h2><p><a href="/files/report.pdf" download>Full report (PDF)</a> and <a href="/files/data.csv">raw data</a>.</p>
<h3>Related</h3><ul><li><a href="https://example.org/a">Related A</a></li><li><a href="https://example.org/b">Related B</a></li><li><a href="https://example.org/c">Related C</a></li></ul>
</article></main></body></html>`;

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function extraRoutes(url, req, res) {
  const p = url.pathname;
  if (p === '/follow-worker.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    res.end(`fetch('/api/worker-follow').then(r => r.json()).then(value => postMessage(value)).catch(() => postMessage({error:'worker-fetch-failed'}));`);
    return true;
  }
  if (p === '/api/worker-follow') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, source: 'dedicated-worker-first-fetch' }));
    return true;
  }
  if (p === '/claude') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(CLAUDE_PAGE); return true; }
  if (p === '/dashboard') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(DASHBOARD_PAGE); return true; }
  if (p === '/feed') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FEED_PAGE); return true; }
  if (p === '/form') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FORM_PAGE); return true; }
  if (p === '/article') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(ARTICLE_PAGE); return true; }
  if (p === '/img/chart.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG_1PX); return true; }
  if (p.startsWith('/media/') || p.startsWith('/files/')) { res.writeHead(200, { 'content-type': p.endsWith('.csv') ? 'text/csv' : 'application/octet-stream' }); res.end('x'); return true; }
  if (/^\/api\/chat_conversations\/[^/]+\/completion$/.test(p)) {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { id: 'msg_01FixtureAssistantB', role: 'assistant', model: 'fixture-model-b', content: [], stop_reason: null, conversation_uuid: '7a7a7a7a-1111-2222-3333-444444444444' } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const w of ['First', ' we', ' collect', ' the', ' data,', ' then', ' we', ' model', ' entities', ' and', ' relations.']) { await sleep(25); ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }); }
    ev({ type: 'ping' });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11 } });
    ev({ type: 'message_stop' });
    res.end(); return true;
  }
  if (p === '/api/metrics') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ cpu: 20 + Math.round(Math.random() * 50), mem: 40 + Math.round(Math.random() * 20), ts: Date.now() })); return true; }
  if (p === '/api/posts') {
    const page = Number(url.searchParams.get('page') ?? 1);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ page, next: page < 4 ? page + 1 : null, results: Array.from({ length: 5 }, (_, i) => { const n = (page - 1) * 5 + i; return { id: `post-${String(n).padStart(4, '0')}-aaaaaaaa`, title: `Post number ${n} about capture`, url: `https://example.org/posts/${n}`, published_at: `2026-10-${String(1 + (n % 28)).padStart(2, '0')}T08:00:00Z`, author: `Author ${n % 3}`, summary: `Summary of post ${n}, long enough to read as text.` }; }) }));
    return true;
  }
  if (p === '/api/signup/step') {
    let body = ''; req.on('data', (c) => (body += c)); await new Promise((r) => req.on('end', r));
    const j = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(j.final ? { status: 'submitted', reference: 'R-000123' } : { status: 'ok', next: j.step + 1 }));
    return true;
  }
  return false;
}

function tickSocket(socket) {
  // Deliberately includes one duplicate and one out-of-order frame.
  const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
  let seq = 0, n = 0;
  const t = setInterval(() => {
    if (n >= 30) { clearInterval(t); return; }
    let s = ++seq;
    if (n === 10) s = seq - 1;            // duplicate
    if (n === 20) s = seq - 5;            // out of order
    socket.write(wsFrame(JSON.stringify({ type: 'tick', seq: s, symbol: syms[n % 5], price: 100 + n * 1.25 + (n % 5), ts: Date.now() })));
    n++;
  }, 40);
  socket.on('close', () => clearInterval(t));
}

export function startSite(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
    if (url.pathname === '/api/auth/session') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=SECRET-COOKIE; HttpOnly' });
      return res.end(JSON.stringify({ user: { name: 'Fixture' }, accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ', expires: '2099-01-01' }));
    }
    if (url.pathname === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ items: Array.from({ length: 6 }, (_, i) => ({ id: `0000000${i}-aaaa-bbbb-cccc-1234567890ab`, title: `Item ${i}`, created_at: `2026-10-2${i}T10:00:00Z`, score: i * 1.5 })) }));
    }
    if (url.pathname === '/api/beacon') { req.resume(); res.writeHead(204); return res.end(); }
    if (url.pathname === '/api/conversation') {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const id = '11111111-2222-3333-4444-555555555555';
      res.write(`event: delta_encoding\ndata: "v1"\n\n`);
      res.write(`data: ${JSON.stringify({ v: { message: { id, author: { role: 'assistant' }, create_time: 1792500000, content: { content_type: 'text', parts: [''] }, status: 'in_progress' }, conversation_id: '99999999-8888-7777-6666-555555555555' } })}\n\n`);
      const words = url.searchParams.get('long') ? Array.from({ length: LONG_WORDS }, (_, i) => `word${i} `) : ['Hello', ' from', ' the', ' fixture', ' stream', '. This sentence is long enough to correlate with the DOM.'];
      if (url.searchParams.get('break')) { res.write(`data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'Partial ans' })}\n\n`); await sleep(60); res.socket.destroy(); return; }
      let first = true;
      for (const w of words) {
        await sleep(url.searchParams.get('long') ? 2 : 30);
        res.write(`data: ${JSON.stringify(first ? { p: '/message/content/parts/0', o: 'append', v: w } : { v: w })}\n\n`);
        first = false;
      }
      res.write(`data: ${JSON.stringify({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] })}\n\n`);
      res.write(': keep-alive comment\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < 3; i++) { await sleep(50); res.write(`event: notice\nid: ${i}\ndata: ${JSON.stringify({ type: 'notice', n: i })}\n\n`); }
      await sleep(50);
      return res.end();
    }
    if (url.pathname === '/api/feed') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (let i = 0; i < 4; i++) { await sleep(20); res.write(JSON.stringify({ type: 'row', row: i, label: `row ${i}` }) + '\n'); }
      return res.end();
    }
    if (await extraRoutes(url, req, res)) return;
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    socket.on('error', () => {});
    if (req.url === '/ws-ticks') return tickSocket(socket);
    let n = 0;
    const t = setInterval(() => { if (n >= 3) { clearInterval(t); return; } socket.write(wsFrame(JSON.stringify({ type: 'update', seq: n++, conversation_id: '99999999-8888-7777-6666-555555555555' }))); }, 60);
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => clearInterval(t));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}/` })));
}

if (process.argv[1] && process.argv[1].endsWith('site.mjs')) startSite(Number(process.argv[2] ?? 8787)).then((s) => console.log(`fixture site on ${s.url}`));
