// Adapter-factory demo fixture: an UNREGISTERED synthetic AI chat webapp.
//
// This is the "previously unseen webapp" of the Agent 14 Round 8 acceptance flow. It is a real,
// served, executing webapp (HTTPS + SSE streaming + URL thread identity + localStorage restore)
// that no handwritten adapter in src/profiles/sites knows about. Capture Studio's own generic
// path must be able to operate it, and the adapter factory must learn it from observed evidence.
//
//   FIXTURE_VIA_HTTP=1  serve plain HTTP instead of HTTPS (only for offline unit-style checks)
//   FIXTURE_V2=1        UI mutation: role attributes renamed data-role -> data-msg-role
//                       (the drift/relearn trigger; localStorage shape is unchanged)
//
// The webapp's own behavior (what it renders, what it streams) is entirely its own; nothing in
// it is a simulation of Capture Studio. The demo prompt → canned reply mapping is the fixture's
// product logic, like any demo mode a real site might ship.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const V2 = process.env.FIXTURE_V2 === '1';
const ATTR = V2 ? 'data-msg-role' : 'data-role';
const PORT = Number(process.env.FIXTURE_PORT ?? 8443);

const REPLIES = [
  'Sure — here is the deterministic fixture answer: alpha bravo charlie delta echo foxtrot.',
  'The fixture webapp streamed this reply token by token over SSE, exactly like a real provider.',
  'Thread state lives in the URL chatID parameter and localStorage, so reloads restore the conversation.',
];
const replyFor = (prompt) => REPLIES[[...prompt].reduce((a, c) => a + c.charCodeAt(0), 0) % REPLIES.length];

const page = (threadId) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>NimbusChat — a friendly AI notepad</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #faf7f2; color: #26221c; }
  header { padding: 12px 20px; background: #2f7d5d; color: #fff; font-weight: 600; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  .turn { margin: 10px 0; padding: 10px 14px; border-radius: 10px; max-width: 85%; white-space: pre-wrap; }
  .turn.user { background: #e8f0eb; margin-left: auto; }
  .turn.assistant { background: #fff; border: 1px solid #e2dccf; }
  .composer { display: flex; gap: 8px; padding: 12px; position: sticky; bottom: 0; background: #faf7f2; }
  .composer textarea { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #cfc8b8; font: inherit; }
  .composer button { padding: 10px 18px; border: 0; border-radius: 8px; background: #2f7d5d; color: #fff; }
  .markdown-body p { margin: 0; }
</style>
</head>
<body>
<header>NimbusChat${V2 ? ' (v2 UI)' : ''}</header>
<main id="thread"></main>
<form class="composer" id="composer">
  <textarea ${ATTR}="composer-input" rows="2" placeholder="Message NimbusChat"></textarea>
  <button type="submit">Send</button>
</form>
<script>
  const ATTR = ${JSON.stringify(ATTR)};
  const threadId0 = ${JSON.stringify(threadId)};
  const KEY = 'nimbuschat.thread.v1';
  const thread = document.getElementById('thread');
  const form = document.getElementById('composer');
  const ta = form.querySelector('textarea');

  const load = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  };
  const save = (t) => { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch {} };
  let state = load();
  if (!threadId0) {
    // A fresh "/" always starts a new conversation (and becomes the stored thread) — like a
    // real chatapp landing page. Restores only happen through /chat?chatID=<id> reloads.
    state = { chatId: null, messages: [] };
  } else if (!state || state.chatId !== threadId0) {
    state = { chatId: threadId0, messages: [] };
  }
  const render = (msg) => {
    const el = document.createElement('div');
    el.className = 'turn ' + msg.role + (msg.role === 'assistant' ? ' markdown-body' : '');
    el.setAttribute(ATTR, msg.role);
    el.textContent = msg.text;
    thread.appendChild(el);
    return el;
  };
  state.messages.forEach(render);
  const assignThread = () => {
    if (state.chatId) return;
    state.chatId = crypto.randomUUID();
    history.pushState({}, '', '/chat?chatID=' + state.chatId);
    save(state);
  };
  const send = async (text) => {
    if (!text) return;
    assignThread();
    state.messages.push({ role: 'user', text });
    render(state.messages[state.messages.length - 1]);
    save(state);
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: state.chatId, prompt: text }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    state.messages.push({ role: 'assistant', text: '' });
    const el = render(state.messages[state.messages.length - 1]);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\\n\\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!frame.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(frame.slice(6));
          if (evt.delta) { full += evt.delta; el.textContent = full; state.messages[state.messages.length - 1].text = full; }
          if (evt.done) save(state);
        } catch {}
      }
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); const t = ta.value; ta.value = ''; send(t); });
  // Real chat UIs dispatch on Enter inside the composer (Shift+Enter stays a newline).
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = ta.value; ta.value = ''; send(t); }
  });
  const demo = new URLSearchParams(location.search).get('autodemo');
  if (demo !== null) setTimeout(() => send('Tell me about the ' + decodeURIComponent(demo) + ' feature.'), 600);
</script>
</body>
</html>`;

const tlsKeyFile = process.env.FIXTURE_TLS_KEY_FILE ?? '';
const tlsCertFile = process.env.FIXTURE_TLS_CERT_FILE ?? '';
const viaHttp = process.env.FIXTURE_VIA_HTTP === '1';
const TLS = tlsKeyFile && tlsCertFile ? { key: fs.readFileSync(tlsKeyFile), cert: fs.readFileSync(tlsCertFile) } : null;
const server = (TLS ? https : http).createServer(TLS ?? {}, (req, res) => {
    const u = new URL(req.url, `https://127.0.0.1:${PORT}`);
    if (u.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, v2: V2, attr: ATTR }));
    }
    if (u.pathname === '/api/thread') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ chatID: u.searchParams.get('chatID') }));
    }
    if (u.pathname === '/api/chat' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let prompt = '';
        try { prompt = String(JSON.parse(body).prompt ?? ''); } catch {}
        const reply = replyFor(prompt);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'connection': 'keep-alive' });
        const words = reply.split(/(?<= )/);
        let i = 0;
        const timer = setInterval(() => {
          if (i < words.length) {
            res.write(`data: ${JSON.stringify({ delta: words[i++] })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            clearInterval(timer);
            res.end();
          }
        }, 90);
        // NOTE: req 'close' fires as soon as the request body is consumed in modern Node;
        // the response's 'close' is the actual abort/finish signal for an SSE stream.
        res.on('close', () => clearInterval(timer));
      });
      return;
    }
    if (u.pathname === '/' || u.pathname === '/chat') {
      const chatID = u.searchParams.get('chatID');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page(chatID));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  },
);

if (TLS || viaHttp) {
  server.listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ fixture: 'listening', url: `${TLS ? 'https' : 'http'}://127.0.0.1:${PORT}`, v2: V2 })));
} else {
  console.error('FIXTURE_TLS_KEY_FILE and FIXTURE_TLS_CERT_FILE must be provided (see scripts/adapter-factory-demo.mjs)');
  process.exit(2);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
export { randomUUID as _threadIdHelper };
