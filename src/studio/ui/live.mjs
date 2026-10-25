// Plain text only: captured content must never become HTML or executable script.
const form = document.querySelector('#filters');
const status = document.querySelector('#status');
const container = document.querySelector('#streams');
const streams = new Map();
const seen = new Set();
let source;

function clear() { streams.clear(); seen.clear(); container.replaceChildren(); }
function streamFor(data, session) {
  const sid = data.sid ?? data.stream?.sid ?? 'unknown';
  const key = `${session ?? ''}:${sid}`;
  if (!streams.has(key)) {
    if (streams.size >= 100) {
      const oldest = streams.keys().next().value;
      streams.get(oldest).section.remove(); streams.delete(oldest);
    }
    const section = document.createElement('section');
    const heading = document.createElement('h2');
    const state = document.createElement('p');
    const content = document.createElement('pre');
    heading.textContent = `${session ? session + ' / ' : ''}${sid}`;
    section.append(heading, state, content); container.append(section);
    streams.set(key, { section, state, content, text: '' });
  }
  return streams.get(key);
}

function receive(event) {
  let envelope;
  try { envelope = JSON.parse(event.data); } catch { status.textContent = 'Received an invalid feed event.'; return; }
  if (envelope.id && seen.has(envelope.id)) return;
  if (envelope.id) { seen.add(envelope.id); if (seen.size > 2000) seen.delete(seen.values().next().value); }
  const data = envelope.data ?? envelope;
  if (data.truncated) { status.textContent = 'An oversized event was omitted from this preview; use saved replay for full evidence.'; return; }
  const stream = streamFor(data, envelope.session);
  if (event.type === 'stream-open') stream.state.textContent = `Open ${data.kind ?? ''} ${data.url ?? ''}`;
  if (event.type === 'stream-close') stream.state.textContent = `Closed ${data.reason ?? ''}`;
  if (event.type !== 'text') return;
  const delta = typeof data.delta === 'string' ? data.delta : typeof data.text === 'string' ? data.text : typeof data === 'string' ? data : '';
  stream.text = data.replace === true || data.snapshot === true ? delta : stream.text + delta;
  if (stream.text.length > 200000) {
    stream.text = stream.text.slice(-200000);
    stream.state.textContent = 'Showing only the latest 200,000 characters; full evidence is in the recording.';
  }
  stream.content.textContent = stream.text;
}

function connect() {
  source?.close(); clear();
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) if (String(value).trim()) params.set(key, String(value).trim());
  params.set('types', 'stream-open,text,stream-close');
  status.textContent = 'Connecting…';
  source = new EventSource(`/api/v1/live?${params}`);
  source.addEventListener('open', () => { status.textContent = 'Connected. Waiting for live text.'; });
  source.addEventListener('error', () => { status.textContent = 'Feed disconnected or unavailable (authentication or optional live-tap module may be missing). Reconnecting when supported.'; });
  source.addEventListener('reset', () => { clear(); status.textContent = 'Replay cursor expired; text may be incomplete. Use saved replay for complete evidence.'; });
  for (const type of ['stream-open', 'text', 'stream-close']) source.addEventListener(type, receive);
}

form.addEventListener('submit', (event) => { event.preventDefault(); connect(); });
document.querySelector('#disconnect').addEventListener('click', () => { source?.close(); status.textContent = 'Disconnected.'; });
document.querySelector('#clear').addEventListener('click', clear);
window.addEventListener('pagehide', () => source?.close());
connect();
