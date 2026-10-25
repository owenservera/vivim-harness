// M1 Chat UI: exact chat thread identity and the explicit zero-send page Read.
// Deterministic and offline: pure helpers, source contracts, and the page booted against a minimal DOM fake with a
// stubbed fetch. No browser, no Chrome/CDP, no real site, no real URLs (synthetic fixtures only).
// The page is loaded from a data: URL so each boot is a fresh module under both node:test and `bun test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL('../../src/studio/ui/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('chat.html');
const source = read('chat.mjs');
const ui = await import('../../src/studio/ui/chat.mjs');

const UUID_A = '11111111-1111-4111-8111-111111111111', UUID_B = '22222222-2222-4222-8222-222222222222';
const REF_A = 'chatgpt-c:' + UUID_A, REF_B = 'chatgpt-c:' + UUID_B;
const threadOf = (uuid) => ({ kind: 'chatgpt-c', id: uuid, ref: 'chatgpt-c:' + uuid });
const READY = { ready: true, draft: { present: false, chars: 0 }, reason: null };
const conv = (extra = {}) => ({
  id: 'c9', revision: 3, state: 'ready', site: 'chatgpt', sessionId: 's9', turn: null, readiness: READY,
  binding: { targetId: 'tab-1', origin: 'https://studio.example.test', ownedByStudio: false, thread: threadOf(UUID_A) },
  identity: { state: 'bound', reason: null }, recovery: { pending: false },
  diagnostic: { finishPhase: 'idle', finishError: null, uncertainty: null },
  reply: { state: 'unknown', source: 'page', text: '', chars: 0, completion: 'unknown' },
  capture: { state: 'recording', integrity: null }, limitations: [], ...extra,
});
const unverifiedConv = () => conv({
  binding: { targetId: 'tab-2', origin: 'https://studio.example.test', ownedByStudio: false },
  identity: { state: 'unverified', reason: 'UNSUPPORTED_PATH' },
  readiness: { ready: false, draft: { present: false, chars: 0 }, reason: 'THREAD_IDENTITY_UNVERIFIED' },
});
const coverage = (extra = {}) => ({
  scope: 'currently-rendered-messages', complete: false, renderedMessages: 3, returnedMessages: 3, omittedMessages: 0, omittedChars: 0,
  truncatedMessages: 0, invalidMessages: 0, hiddenSkipped: 0, nestedDropped: 0, ambiguousSkipped: 0,
  olderHistory: 'unknown', newerHistory: 'bottom-reached', preAttachHistory: 'not-captured-by-this-read', ...extra,
});
const transcript = (extra = {}) => ({
  conversationId: 'c9', revision: 3, readAt: '2026-10-23T14:03:22.000Z', binding: { targetId: 'tab-1', origin: 'https://studio.example.test', thread: REF_A },
  identity: { state: 'bound', reason: null }, source: 'page-visible-dom',
  messages: [
    { index: 4, role: 'assistant', text: 'Second answer', chars: 13, truncated: false },
    { index: 2, role: 'user', text: 'First question', chars: 14, truncated: false },
    { index: 3, role: 'assistant', text: 'First answer', chars: 12, truncated: false },
  ],
  coverage: coverage(), draft: { present: true, chars: 17 }, limits: { maxMessages: 40, maxChars: 60000, perMessageCap: 20000 }, ...extra,
});

/* ---------------- pure helpers ---------------- */
test('thread references: object form (binding/target) and string form (transcript) read the same, titles are never used', () => {
  assert.equal(ui.threadRef({ thread: threadOf(UUID_A) }), REF_A);
  assert.equal(ui.threadRef({ thread: REF_A }), REF_A);
  for (const none of [null, undefined, {}, { thread: null }, { thread: {} }, { thread: '' }, { title: REF_A }]) assert.equal(ui.threadRef(none), null);
});

test('identity view: bound shows the exact reference; unverified says why reads and sends are off; unbound is plain', () => {
  const bound = ui.identityView(conv());
  assert.equal(bound.show, true); assert.equal(bound.ref, REF_A); assert.equal(bound.chip[0], 'Thread identified'); assert.equal(bound.chip[1], 't-info');
  assert.match(bound.lines.join(' '), /still on this exact chat/);
  const bad = ui.identityView(unverifiedConv());
  assert.equal(bad.ref, null); assert.equal(bad.chip[0], 'Thread not verified'); assert.equal(bad.chip[1], 't-warn');
  assert.match(bad.lines.join(' '), /isn’t on a saved chat that Studio can identify/);
  assert.match(bad.lines.join(' '), /Reading and sending are off\. Studio won’t switch to another chat for you/);
  const fresh = ui.identityView(conv({ binding: { targetId: 'tab', ownedByStudio: true }, identity: { state: 'unbound', reason: 'NEW_CHAT' } }));
  assert.equal(fresh.chip[0], 'No thread identity'); assert.match(fresh.lines.join(' '), /new chat has no thread yet/);
  assert.equal(ui.identityView(conv({ identity: undefined })).show, false, 'an older service without identity shows nothing rather than guessing');
  assert.equal(ui.identityView(null).show, false);
  assert.match(ui.identityView(conv({ identity: { state: 'unverified', reason: 'SOMETHING_NEW' } })).lines[0], /something new/, 'unknown reason codes stay visible as words');
  assert.equal(ui.identityChip({ state: 'weird' })[1], 't-warn', 'unknown state is a warning, never quiet');
});

test('unverified identity turns Send off and explains it; the readiness panel carries the reason', () => {
  const bad = unverifiedConv();
  const c = ui.canSend(bad, { prompt: 'hi' });
  assert.equal(c.ok, false); assert.match(c.reason, /won’t send into a chat it can’t identify/);
  assert.equal(ui.canSend(conv(), { prompt: 'hi' }).ok, true, 'a bound thread does not change single-turn sending');
  assert.equal(ui.canSend(conv({ identity: undefined }), { prompt: 'hi' }).ok, true, 'no identity field behaves as before');
  const panel = ui.readinessPanel(conv({ ...unverifiedConv(), state: 'blocked' }));
  assert.equal(panel.show, true);
  assert.match(panel.lines.join(' '), /Studio can’t tell which chat this tab is showing, so it won’t send/);
  assert.match(panel.lines.join(' '), /isn’t on a saved chat/);
});

test('canRead: needs a live, identified conversation; says why when off; does not need send readiness or an empty draft', () => {
  assert.equal(ui.canRead(conv()).ok, true);
  assert.equal(ui.canRead(conv({ readiness: { ready: false, draft: { present: true, chars: 9 }, reason: 'DRAFT_PRESENT' }, state: 'blocked' })).ok, true, 'a draft in the chat box does not stop a read');
  assert.equal(ui.canRead(conv({ readiness: undefined })).ok, true);
  assert.equal(ui.canRead(conv({ turn: { id: 't', phase: 'observed', send: { state: 'observed' } } })).ok, true, 'one-turn limit does not apply to reading');
  assert.equal(ui.canRead(null).ok, false);
  assert.match(ui.canRead(conv({ state: 'closed' })).reason, /finished/);
  assert.match(ui.canRead(conv({ state: 'finalizing' })).reason, /Finishing/);
  for (const state of ['attaching', 'disconnected']) assert.match(ui.canRead(conv({ state })).reason, /isn’t connected/, state);
  assert.match(ui.canRead(conv({ recovery: { pending: true } })).reason, /recovered after a restart/);
  assert.match(ui.canRead(conv({ limitations: ['Recovered snapshot only; interrupted capture ownership requires reconciliation, never automatic replay'] })).reason, /recovered/);
  const bad = ui.canRead(unverifiedConv());
  assert.equal(bad.ok, false); assert.match(bad.reason, /Reading is off: Studio can’t tell which chat this tab is showing/);
  assert.equal(ui.canRead(conv(), { reading: true }).reason, 'Reading…');
  assert.equal(ui.canRead(conv(), { submitting: true }).ok, false);
  assert.equal(ui.canRead(conv(), { working: true }).ok, false);
});

test('target rows: exact reference when known; unverified and unidentified sites say why, in plain words', () => {
  const t = { site: 'chatgpt', thread: threadOf(UUID_A), identity: { state: 'bound', reason: null } };
  assert.equal(ui.targetThread(t).line, 'Chat thread ' + REF_A);
  assert.match(ui.targetThread(t).note, /only if this tab is still on this exact chat/);
  const bad = ui.targetThread({ site: 'chatgpt', thread: null, identity: { state: 'unverified', reason: 'UNSUPPORTED_PATH' } });
  assert.equal(bad.line, 'Chat thread not verified');
  assert.match(bad.note, /reading and sending stay off, and it won’t switch to a different chat for you/);
  const other = ui.targetThread({ site: 'claude', thread: null, identity: { state: 'unbound', reason: 'SITE_UNSUPPORTED' } });
  assert.equal(other.line, 'Chat thread not identified on this site'); assert.match(other.note, /doesn’t identify individual chats on this site yet/);
  assert.deepEqual(ui.targetThread({ site: 'chatgpt' }), { state: null, ref: null, line: '', note: '' }, 'older service: no claim either way');
});

test('coverage is never described as the whole chat; omissions, cuts, skips and unknown history are all stated', () => {
  const none = ui.coverageLines(coverage());
  assert.equal(none[0], 'This is not a complete copy of the chat.');
  assert.ok(none.includes('Showing 3 of 3 messages the page is displaying now.'));
  assert.ok(none.includes('Studio can’t tell whether older messages exist above what the page has loaded.'));
  assert.ok(none.includes('The page is at the bottom of the messages it has loaded.'));
  assert.match(none.at(-1), /Messages still rendered.*can predate this connection/);
  assert.match(none.at(-1), /Earlier network traffic was not captured/);
  const lots = ui.coverageLines(coverage({ renderedMessages: 12, returnedMessages: 4, omittedMessages: 8, omittedChars: 5000, truncatedMessages: 1, hiddenSkipped: 2, nestedDropped: 1, ambiguousSkipped: 1, invalidMessages: 3,
    olderHistory: 'older-unrendered-likely', newerHistory: 'newer-unrendered-likely' })).join('\n');
  assert.match(lots, /Showing 4 of 12 messages/);
  assert.match(lots, /8 messages were left out .*about 5000 characters/);
  assert.match(lots, /1 message was cut short\. The end of their text is missing\./);
  assert.match(lots, /Skipped on the page: 2 hidden, 1 nested duplicate, 1 of unclear author, 3 unreadable\./);
  assert.match(lots, /Older messages are probably above what the page has loaded/);
  assert.match(lots, /Newer messages may be below/);
  assert.match(ui.coverageLines(coverage({ olderHistory: 'top-reached' })).join(' '), /top of the messages it has loaded\. Older history may still not be loaded/);
  assert.match(ui.coverageLines(coverage({ olderHistory: 'odd-value' })).join(' '), /Older history: odd value/);
  assert.match(ui.coverageLines(null)[0], /Treat it as partial/);
  assert.match(ui.coverageLines({})[0], /not a complete copy/);
  assert.equal(ui.coverageLines(coverage({ complete: true }))[0], 'Studio reports this read as complete.', 'only the service can say complete');
});

test('readView: oldest first by index, roles labelled, cut messages flagged, source/draft/limits plain, untrusted shapes refused', () => {
  const snap = conv();
  const v = ui.readView(transcript(), snap);
  assert.equal(v.ok, true);
  assert.deepEqual(v.messages.map((m) => [m.n, m.label, m.text]), [[3, 'You', 'First question'], [4, 'Assistant', 'First answer'], [5, 'Assistant', 'Second answer']]);
  assert.equal(v.headline, 'Read 3 messages of 3 the page is showing now, oldest first.');
  assert.deepEqual(v.chips[0], ['Source: text visible on the page right now (not the network recording)', 't-mute']);
  assert.deepEqual(v.chips[1], ['Not a complete copy', 't-warn']);
  assert.match(v.draft, /The chat box has text \(17 characters\)\. Studio left it untouched and doesn’t show it here\./);
  assert.match(v.lines.at(-1), /Limits used: up to 40 messages and 60000 characters in total\./);
  assert.equal(v.more, false, 'nothing was left out, so no Read more');
  assert.equal(ui.readAtText('2026-10-23T14:03:22.000Z'), 'Read at 14:03:22 UTC');
  assert.equal(ui.readAtText(undefined), 'Read time not reported');
  const cut = ui.readView(transcript({ messages: [{ index: 0, role: 'assistant', text: 'abc', chars: 50, truncated: true }], coverage: coverage({ renderedMessages: 9, returnedMessages: 1, omittedMessages: 8, truncatedMessages: 1 }) }), snap);
  assert.equal(cut.messages[0].cut, true); assert.equal(cut.more, true, 'omissions below the maximum limits offer Read more');
  assert.equal(ui.readView(transcript({ messages: [], coverage: coverage({ renderedMessages: 0, returnedMessages: 0 }) }), snap).headline, 'Studio found no messages on the page.');
  const mixed = ui.readView(transcript({ messages: [{ index: 0, role: 'user', text: 'ok', chars: 2 }, { role: 'user' }, null] }), snap);
  assert.equal(mixed.messages.length, 1); assert.match(mixed.lines.join(' '), /2 items in the reply couldn’t be read/);
  assert.equal(ui.readView(transcript({ limits: { maxMessages: 200, maxChars: 200000 }, coverage: coverage({ renderedMessages: 300, returnedMessages: 3, omittedMessages: 297 }) }), snap).more, false, 'already at the maximum');
  // Untrusted: wrong conversation, wrong thread, malformed.
  assert.equal(ui.readView(transcript({ conversationId: 'other' }), snap).ok, false);
  assert.match(ui.readView(transcript({ binding: { thread: REF_B } }), snap).text, /different chat than the one you connected/);
  assert.equal(ui.readView(transcript({ binding: { thread: null } }), snap).ok, false);
  for (const bad of [null, undefined, 'x', {}, { messages: 'no' }]) assert.equal(ui.readView(bad, snap).ok, false, String(bad));
  assert.equal(ui.readView(transcript({ binding: { thread: null } }), conv({ binding: { targetId: 'x' }, identity: { state: 'unbound', reason: 'NEW_CHAT' } })).ok, true, 'no thread on either side matches');
});

test('read failures are plain, say nothing was sent or changed, and map the new service codes', () => {
  const fail = (status, code) => ui.readFailure(Object.assign(new Error(code), { status, data: { code } }));
  for (const code of ['BINDING_CHANGED', 'THREAD_IDENTITY_UNVERIFIED', 'READ_REQUIRES_LIVE_CONVERSATION', 'READ_UNAVAILABLE', 'READ_FAILED', 'INVALID_READ', 'CONVERSATION_FINISHED', 'CONVERSATION_NOT_FOUND']) {
    const r = fail(409, code);
    assert.match(r.text, /^Couldn’t read the page: /, code); assert.match(r.text, /Nothing was sent, typed or changed\.$/, code);
    assert.doesNotMatch(r.text, /Studio reported:/, code + ' has its own sentence');
  }
  assert.match(fail(409, 'BINDING_CHANGED').text, /no longer on the chat Studio expected/);
  assert.match(fail(409, 'THREAD_IDENTITY_UNVERIFIED').text, /did not pick another chat/);
  assert.match(fail(503, 'BROWSER_UNAVAILABLE').text, /capture browser/);
  assert.match(ui.readFailure({ status: 0, message: 'Could not reach the Studio.' }).text, /Could not reach the Studio\./);
  assert.match(fail(409, 'SOMETHING_ELSE').text, /something else/, 'unknown codes stay visible');
});

/* ---------------- source and markup contracts ---------------- */
const fnBody = (name) => { const i = source.indexOf(name); assert.ok(i >= 0, name); return source.slice(i, source.indexOf('\n  }\n', i)); };

test('Read is its own explicit control: one click handler, one route, never the composer, draft, snapshot or send path', () => {
  assert.match(source, /\$\('#btnRead'\)\.addEventListener\('click', \(\) => readPage\(\)\)/);
  assert.match(source, /\$\('#btnReadMore'\)\.addEventListener\('click', \(\) => readPage\(\{ maxMessages: READ_MAX\.maxMessages, maxChars: READ_MAX\.maxChars \}\)\)/);
  assert.equal((source.match(/\/read'/g) ?? []).length, 1, 'one place posts to the read route');
  const body = fnBody('async function readPage(');
  assert.match(body, /'\/conversations\/' \+ encodeURIComponent\(id\) \+ '\/read', \{ method: 'POST', body: limits \?\? \{\} \}/);
  assert.doesNotMatch(body, /#prompt|applySnapshot|store\.|savePending|newKey|reconcile|finish|pending/i, 'a read touches none of the draft, snapshot, storage or send state');
  assert.match(body, /canRead\(snap, \{ reading: S\.reading, submitting: S\.submitting, working: S\.working \}\)/);
  // Nothing reads by itself: the only callers are the two buttons.
  assert.equal((source.match(/\breadPage\(/g) ?? []).length, 3, 'definition plus the two click handlers');
  assert.doesNotMatch(source, /setTimeout\([^)]*readPage/);
  // Stale answers: sequence number, same conversation, and the thread is checked again before anything is shown.
  assert.match(body, /if \(!stillOn\(id\) \|\| seq !== S\.readSeq\) return;/);
  assert.match(body, /readView\(data\?\.transcript, S\.snap\)/);
  // The transcript is kept in memory only.
  assert.doesNotMatch(source, /store\.set\([^)]*transcript/i);
});

test('selection never reads or sends; expectedThread comes from the thread reference seen when the tab was chosen', () => {
  assert.match(source, /onchange: \(\) => \{ S\.targetId = t\.id; S\.pickRef = threadRef\(t\); S\.pickNote = ''; renderConnect\(\); \}/);
  assert.match(source, /\.\.\.\(S\.pickRef \? \{ expectedThread: S\.pickRef \} : \{\}\)/);
  const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal((code.match(/expectedThread/g) ?? []).length, 1, 'one use in code, in the connect body');
  const sel = source.slice(source.indexOf('onchange: () => { S.targetId'), source.indexOf('renderConnect(); } });', source.indexOf('onchange: () => { S.targetId')));
  assert.doesNotMatch(sel, /api\(|readPage|fetch/);
  // A refresh clears a choice instead of following the tab to another chat.
  assert.match(source, /\(threadRef\(t\) \?\? null\) !== S\.pickRef\) \{ S\.pickNote = /);
  assert.match(source, /\['BINDING_CHANGED', 'THREAD_IDENTITY_UNVERIFIED', 'TARGET_NOT_FOUND', 'TARGET_SITE_MISMATCH'\]\.includes\(code\)/);
});

test('markup: labelled controls, polite status and alert slots, ordered list, covers disclosure, tab list is not an account chat list', () => {
  for (const id of ['threadStrip', 'identityChips', 'threadRef', 'identityLines', 'readBox', 'btnRead', 'btnReadMore', 'readHint', 'readError', 'readEmpty', 'readResult', 'readHeadline', 'readChips', 'readMeta', 'readDraft', 'readCoverage', 'readMessages', 'targetNote', 'tabsHelp'])
    assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /<button type="button" id="btnRead" aria-describedby="readHint readHelp" disabled>Read what’s on the page<\/button>/);
  assert.match(html, /id="readHint" role="status"/); assert.match(html, /id="readError" role="alert"/); assert.match(html, /id="targetNote" role="status"/);
  assert.match(html, /<ol class="reads" id="readMessages" aria-label="Messages read from the page, oldest first">/);
  assert.match(html, /<details class="blk cov" open>\s*<summary>What this read covers<\/summary>/);
  assert.match(html, /<section class="panel readbox" id="readBox" aria-labelledby="readHeading" aria-busy="false" hidden>/);
  assert.match(html, /never types, sends, clears, scrolls or reloads/);
  assert.match(html, /Studio only reads when you press the button/);
  assert.match(html, /id="tabsLabel" style="margin:0">Open browser tabs<\/span>/);
  assert.match(html, /These are tabs open in the capture browser right now\. It isn’t a list of the chats in your account\./);
  assert.match(html, /aria-describedby="tabsHelp targetNote"/);
  assert.match(html, /user-select: all/, 'the exact reference can be selected in one gesture');
  assert.equal((html.match(/aria-live="polite"/g) ?? []).length, 1, 'still one polite live region');
  assert.doesNotMatch(source, /addEventListener\('keydown'/);
  // Wide-pointer targets and narrow screens.
  assert.match(html, /\.read-actions button \{ width: 100%; \}/);
  assert.match(html, /\.cov > summary \{ min-height: 44px; \}/);
});

test('no real addresses, accounts or private text in the UI source or in this file’s fixtures', () => {
  const realish = new RegExp('https?://(?!studio\\.example\\.test|127\\.0\\.0\\.1|localhost)[a-z0-9.-]+\\.(com|ai|io|net|org)', 'i');
  assert.doesNotMatch(html, realish); assert.doesNotMatch(source, realish);
  assert.doesNotMatch(readFileSync(new URL(import.meta.url), 'utf8'), realish);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});

/* ---------------- the page against a DOM fake ---------------- */
class FakeEl {
  constructor(tag = 'div', id = '') { Object.assign(this, { tag, id, children: [], dataset: {}, listeners: {}, attrs: {}, hidden: false, disabled: false, readOnly: false, value: '', textContent: '', open: false, checked: false, className: '' }); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {}
  async dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, ...event }); }
}
const textNode = () => ({ data: '', appendData(s) { this.data += s; } });
const textOf = (n) => (n == null ? '' : typeof n === 'string' ? n : [n.textContent ?? '', ...(n.children ?? []).map(textOf)].join(' ').replace(/\s+/g, ' ').trim());
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };

const tabBound = { id: 'tab-1', targetId: 'tab-1', site: 'chatgpt', url: 'https://studio.example.test', title: 'chatgpt', thread: threadOf(UUID_A), identity: { state: 'bound', reason: null }, ownedByStudio: false, recorderOwner: null, visibility: 'unknown' };
const tabUnverified = { id: 'tab-2', targetId: 'tab-2', site: 'chatgpt', url: 'https://studio.example.test', title: 'chatgpt', thread: null, identity: { state: 'unverified', reason: 'UNSUPPORTED_PATH' }, ownedByStudio: false, recorderOwner: null, visibility: 'unknown' };

// `routes` can override any answer: ({ method, path, body }) => [status, body] | Promise<...> | undefined.
function fakeStudio({ targets = [tabBound, tabUnverified], routes = () => undefined } = {}) {
  const posts = [];
  const state = { targets, connected: null };
  const answer = (status, body) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body) });
  const fetchStub = async (url, init = {}) => {
    const method = init.method ?? 'GET', path = String(url).replace(/^\/api\/v1/, ''), body = init.body ? JSON.parse(init.body) : null;
    if (method === 'POST') posts.push({ path, body });
    const custom = await routes({ method, path, body, state });
    if (custom) return answer(...custom);
    if (path === '/conversation-targets') return answer(200, { sites: [{ id: 'chatgpt' }], targets: state.targets });
    if (path === '/conversations' && method === 'GET') return answer(200, { conversations: [] });
    if (path === '/conversations' && method === 'POST') { state.connected = body.targetId === 'tab-2' ? unverifiedConv() : conv(); return answer(201, { conversation: state.connected }); }
    if (path === '/conversations/c9' && method === 'GET') return answer(200, { conversation: state.connected ?? conv() });
    if (path === '/conversations/c9/read') return answer(200, { transcript: transcript() });
    return answer(404, { error: 'not found' });
  };
  return { posts, fetchStub, state, of: (suffix) => posts.filter((p) => p.path.endsWith(suffix)) };
}

let bootCount = 0;
async function withPage(options, body) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const byId = new Map(ids.map((id) => [id, new FakeEl('div', id)]));
  const windowListeners = {}, warnings = [], unhandled = [];
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const studio = fakeStudio(options);
  const modes = [byId.get('modeNew'), byId.get('modeExisting')];
  modes[0].value = 'new'; modes[0].checked = true; modes[1].value = 'existing';
  const fakeDocument = {
    hidden: false, getElementById: (id) => byId.get(id) ?? null,
    querySelector: (sel) => (sel.startsWith('#') ? byId.get(sel.slice(1)) ?? null : null),
    querySelectorAll: (sel) => (sel === 'input[name=mode]' ? modes : []),
    createElement: (tag) => new FakeEl(tag), createTextNode: () => textNode(), addEventListener() {},
  };
  const saved = Object.fromEntries(['document', 'window', 'fetch', 'sessionStorage', 'localStorage'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const realWarn = console.warn, onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  Object.assign(globalThis, {
    document: fakeDocument, fetch: studio.fetchStub, sessionStorage: store(), localStorage: store(),
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener: (t, f) => { windowListeners[t] = f; } },
  });
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await import('data:text/javascript;base64,' + Buffer.from(source + '\n// boot ' + (++bootCount)).toString('base64'));
    await settle();
    const choose = async (id) => {
      modes[1].checked = true; modes[0].checked = false; await modes[1].dispatch('change');
      const radio = byId.get('targetList').children.map((label) => label.children[0]).find((input) => input.attrs.value === id);
      assert.ok(radio, 'tab ' + id + ' is listed');
      await radio.dispatch('change');
    };
    const connect = async () => { await byId.get('btnConnect').dispatch('click'); await settle(); };
    return await body({ byId, studio, warnings, unhandled, el: (id) => byId.get(id), choose, connect });
  } finally {
    windowListeners.pagehide?.();
    console.warn = realWarn;
    process.off('unhandledRejection', onUnhandled);
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
}

test('boot: nothing is posted, the read panel and thread strip stay hidden until a conversation exists', async () => {
  await withPage({}, async ({ el, studio, warnings, unhandled }) => {
    assert.deepEqual(studio.posts, []);
    assert.equal(el('readBox').hidden, true); assert.equal(el('threadStrip').hidden, true);
    assert.equal(el('btnRead').listeners.click?.length, 1); assert.equal(el('btnReadMore').listeners.click?.length, 1);
    assert.deepEqual(unhandled, []); assert.deepEqual(warnings, []);
  });
});

test('tab list: labelled as open browser tabs, shows each exact reference or why there is none; choosing posts nothing', async () => {
  await withPage({}, async ({ el, studio, choose }) => {
    await choose('tab-1');
    const list = textOf(el('targetList'));
    assert.match(list, new RegExp('Chat thread ' + REF_A)); assert.match(list, /Chat thread not verified/);
    assert.match(textOf(el('targetNote')), /only if this tab is still on this exact chat/);
    assert.equal(el('btnConnect').disabled, false);
    await choose('tab-2');
    assert.match(textOf(el('targetNote')), /reading and sending stay off, and it won’t switch to a different chat for you/);
    assert.deepEqual(studio.posts, [], 'choosing a tab never posts');
  });
});

test('connect sends expectedThread for an identified tab and shows the bound thread; Read is off until pressed and posts only /read', async () => {
  await withPage({}, async ({ el, studio, choose, connect }) => {
    await choose('tab-1'); await connect();
    assert.deepEqual(studio.of('/conversations')[0].body, { site: 'chatgpt', targetId: 'tab-1', expectedThread: REF_A });
    assert.equal(el('threadStrip').hidden, false); assert.equal(el('threadRef').textContent, REF_A); assert.equal(el('threadRef').hidden, false);
    assert.match(el('threadStrip').className, /\bbound\b/);
    assert.match(textOf(el('identityChips')), /Thread identified/);
    assert.equal(el('readBox').hidden, false); assert.equal(el('btnRead').disabled, false);
    assert.equal(el('readEmpty').hidden, false); assert.equal(el('readResult').hidden, true);
    assert.equal(studio.of('/read').length, 0, 'connecting and selecting never read');
    // A draft in the composer survives a read untouched, and Read does not need Send readiness.
    el('prompt').value = 'half-written'; await el('prompt').dispatch('input');
    const sendBefore = el('btnSend').disabled, before = studio.posts.length;
    await el('btnRead').dispatch('click'); await settle();
    assert.deepEqual(studio.posts.slice(before), [{ path: '/conversations/c9/read', body: {} }], 'exactly one zero-send read');
    assert.equal(el('prompt').value, 'half-written'); assert.equal(el('btnSend').disabled, sendBefore);
    assert.equal(studio.of('/turns').length, 0); assert.equal(studio.of('/reconcile').length, 0);
    // Result: ordered rows, plain roles, coverage and source visible, polite announcement.
    assert.equal(el('readResult').hidden, false); assert.equal(el('readEmpty').hidden, true);
    assert.equal(el('readHeadline').textContent, 'Read 3 messages of 3 the page is showing now, oldest first.');
    const rows = el('readMessages').children;
    assert.deepEqual(rows.map((li) => textOf(li.children[0].children[0])), ['You', 'Assistant', 'Assistant']);
    assert.deepEqual(rows.map((li) => li.children[1].textContent), ['First question', 'First answer', 'Second answer']);
    assert.match(textOf(el('readChips')), /Source: text visible on the page right now.*Not a complete copy/);
    assert.match(el('readCoverage').dataset.sig, /not a complete copy of the chat/);
    assert.match(el('readDraft').textContent, /17 characters/);
    assert.match(el('readMeta').textContent, /conversation revision 3/);
    assert.match(el('announce').textContent, /Read 3 messages from the page\. This is not a complete copy of the chat\./);
    assert.equal(el('btnReadMore').hidden, true);
    assert.equal(el('readBox').attrs['aria-busy'], 'false');
  });
});

test('while a read is running the button is off and says so; a second click posts nothing; the result then replaces the empty state', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withPage({ routes: async ({ path }) => { if (path === '/conversations/c9/read') { await gate; return [200, { transcript: transcript() }]; } } }, async ({ el, studio, choose, connect }) => {
    await choose('tab-1'); await connect();
    const first = el('btnRead').dispatch('click'); await settle();
    assert.equal(el('btnRead').disabled, true); assert.equal(el('btnRead').textContent, 'Reading…'); assert.equal(el('readBox').attrs['aria-busy'], 'true');
    assert.equal(el('readHint').textContent, 'Reading…');
    await el('btnRead').dispatch('click'); await settle();
    assert.equal(studio.of('/read').length, 1, 'no second read while one is running');
    release(); await first; await settle();
    assert.equal(el('btnRead').disabled, false); assert.equal(el('btnRead').textContent, 'Read what’s on the page'); assert.equal(el('readBox').attrs['aria-busy'], 'false');
    assert.equal(el('readResult').hidden, false);
  });
});

test('read failures show a plain alert, keep the page usable, and keep an earlier read visible with its own time', async () => {
  let mode = 'ok';
  await withPage({ routes: ({ path }) => { if (path === '/conversations/c9/read' && mode === 'bad') return [409, { error: 'BINDING_CHANGED', code: 'BINDING_CHANGED' }]; if (path === '/conversations/c9/read' && mode === 'net') throw new TypeError('network down'); } }, async ({ el, choose, connect }) => {
    await choose('tab-1'); await connect();
    await el('btnRead').dispatch('click'); await settle();
    assert.equal(el('readError').textContent, '');
    mode = 'bad';
    await el('btnRead').dispatch('click'); await settle();
    assert.match(el('readError').textContent, /^Couldn’t read the page: This tab is no longer on the chat Studio expected/);
    assert.match(el('readError').textContent, /Nothing was sent, typed or changed\.$/);
    assert.equal(el('readResult').hidden, false, 'the earlier read stays, with its own time line');
    assert.equal(el('btnRead').disabled, false);
    mode = 'net';
    await el('btnRead').dispatch('click'); await settle();
    assert.match(el('readError').textContent, /Could not reach the Studio/);
    mode = 'ok';
    await el('btnRead').dispatch('click'); await settle();
    assert.equal(el('readError').textContent, '', 'a successful read clears the alert');
  });
});

test('a read for another thread or another conversation is refused, not shown', async () => {
  let t = transcript({ binding: { targetId: 'tab-1', origin: 'https://studio.example.test', thread: REF_B } });
  await withPage({ routes: ({ path }) => (path === '/conversations/c9/read' ? [200, { transcript: t }] : undefined) }, async ({ el, choose, connect }) => {
    await choose('tab-1'); await connect();
    await el('btnRead').dispatch('click'); await settle();
    assert.equal(el('readResult').hidden, true);
    assert.match(el('readError').textContent, /different chat than the one you connected, so Studio did not show it/);
    t = { messages: 'nope' };
    await el('btnRead').dispatch('click'); await settle();
    assert.match(el('readError').textContent, /couldn’t understand/);
  });
});

test('Read more appears only when messages were left out, asks for the service maximum once, and never sends', async () => {
  const partial = transcript({ messages: [{ index: 9, role: 'assistant', text: 'Latest', chars: 6 }], coverage: coverage({ renderedMessages: 10, returnedMessages: 1, omittedMessages: 9, omittedChars: 4000 }) });
  await withPage({ routes: ({ path, body }) => (path === '/conversations/c9/read' ? [200, { transcript: body?.maxMessages === 200 ? transcript() : partial }] : undefined) }, async ({ el, studio, choose, connect }) => {
    await choose('tab-1'); await connect();
    await el('btnRead').dispatch('click'); await settle();
    assert.equal(el('btnReadMore').hidden, false);
    assert.match(el('readCoverage').dataset.sig, /9 messages were left out .*about 4000 characters/);
    assert.equal(el('readHeadline').textContent, 'Read 1 message of 10 the page is showing now, oldest first.');
    await el('btnReadMore').dispatch('click'); await settle();
    assert.deepEqual(studio.of('/read').map((p) => p.body), [{}, { maxMessages: 200, maxChars: 200000 }]);
    assert.equal(el('btnReadMore').hidden, true);
    assert.equal(studio.of('/turns').length, 0);
  });
});

test('unverified tab: connect carries no expectedThread, Read and Send explain why they are off, nothing else is chosen', async () => {
  await withPage({}, async ({ el, studio, choose, connect }) => {
    await choose('tab-2'); await connect();
    assert.deepEqual(studio.of('/conversations')[0].body, { site: 'chatgpt', targetId: 'tab-2' });
    assert.match(el('threadStrip').className, /\bunverified\b/);
    assert.equal(el('threadRef').hidden, true);
    assert.match(textOf(el('identityChips')), /Thread not verified/);
    assert.match(el('identityLines').dataset.sig, /Reading and sending are off\. Studio won’t switch to another chat for you/);
    assert.equal(el('btnRead').disabled, true);
    assert.match(el('readHint').textContent, /Reading is off: Studio can’t tell which chat this tab is showing/);
    el('prompt').value = 'hello'; await el('prompt').dispatch('input');
    assert.equal(el('btnSend').disabled, true); assert.match(el('sendHint').textContent, /Sending is off: Studio can’t tell which chat/);
    await el('btnRead').dispatch('click'); await settle();
    assert.equal(studio.of('/read').length, 0, 'a disabled read posts nothing even if clicked');
    assert.equal(studio.of('/turns').length, 0);
  });
});

test('the service refusing the exact chat clears the choice, reloads the tab list, and picks nothing else', async () => {
  const moved = { ...tabBound, thread: threadOf(UUID_B) };
  await withPage({ routes: ({ method, path, state }) => {
    if (method === 'POST' && path === '/conversations') { state.targets = [moved, tabUnverified]; return [409, { error: 'BINDING_CHANGED', code: 'BINDING_CHANGED' }]; }
  } }, async ({ el, studio, choose, connect }) => {
    await choose('tab-1'); await connect();
    assert.equal(studio.of('/conversations')[0].body.expectedThread, REF_A, 'the reference seen when it was chosen, not the refreshed one');
    assert.match(el('connectError').textContent, /^Couldn’t connect: This tab is no longer on the chat Studio expected/);
    assert.match(el('connectError').textContent, /Studio does not retry by itself\./);
    assert.match(textOf(el('targetNote')), /Nothing was connected, and no other tab was chosen for you/);
    assert.equal(el('btnConnect').disabled, true, 'no tab is selected, so Connect is off');
    assert.match(el('connectHint').textContent, /Choose a tab to continue/);
    assert.equal(el('threadStrip').hidden, true);
    assert.match(textOf(el('targetList')), new RegExp(REF_B), 'the tab now shows the thread it is actually on');
    assert.equal(studio.of('/conversations').length, 1, 'no second connect');
  });
});

test('Refresh tabs: a tab that moved to another chat, or closed, is deselected with a plain note', async () => {
  await withPage({}, async ({ el, studio, choose }) => {
    await choose('tab-1');
    studio.state.targets = [{ ...tabBound, thread: threadOf(UUID_B) }, tabUnverified];
    await el('btnTabs').dispatch('click'); await settle();
    assert.match(textOf(el('targetNote')), /now on a different chat\. Nothing is selected/);
    assert.equal(el('btnConnect').disabled, true);
    await choose('tab-1');
    studio.state.targets = [tabUnverified];
    await el('btnTabs').dispatch('click'); await settle();
    assert.match(textOf(el('targetNote')), /no longer open/);
    assert.deepEqual(studio.posts, []);
  });
});

test('tab list states: loading, error and empty are explained', async () => {
  await withPage({ routes: ({ path }) => (path === '/conversation-targets' ? [503, { error: 'BROWSER_UNAVAILABLE', code: 'BROWSER_UNAVAILABLE' }] : undefined) }, async ({ el, choose }) => {
    el('modeExisting').checked = true; await el('modeExisting').dispatch('change');
    assert.match(textOf(el('targetList')), /Could not load tabs: Studio can’t reach the capture browser/);
    assert.match(el('connectHint').textContent, /Sites and tabs didn’t load/);
  });
  await withPage({ targets: [] }, async ({ el }) => {
    el('modeExisting').checked = true; await el('modeExisting').dispatch('change');
    assert.match(textOf(el('targetList')), /No supported tabs found/);
    assert.equal(el('targetNote').textContent, '');
  });
});
