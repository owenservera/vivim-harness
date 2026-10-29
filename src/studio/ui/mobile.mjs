// VIVIM mobile surface: same owner, same Studio APIs, fixed trusted components only.
// Phone-shaped working view served by the user's own PC: loopback by default, or reachable from a phone on
// the same WiFi only when the PC runs `studio start|serve --lan-pair` (explicit opt-in, token required;
// see docs/architecture/MOBILE-LAN-PAIRING.md). Installable as a PWA (manifest + shell-only service
// worker; the shell opens offline, but data and every mutation always need the live PC). Chrome only
// installs/registers the worker in a secure context (https, localhost, or `adb reverse`); over plain
// http://<LAN-IP> it still works as a normal page. NOT an APK, cloud sync, or offline data/queued writes.
export const MOBILE_API = '/api/v1/personal-apps';
const APP_ID = /^app-[a-f0-9]{32}$/;
const ITEM_ID = /^item-[a-f0-9]{32}$/;
const SCREENS = new Set(['home', 'agent', 'builder', 'notes', 'tasks', 'dashboard', 'blank']);
// "Ask my AI" talks to the same in-process conversation runtime the desktop Chat page uses. Same origin, same
// Studio cookie: the phone never holds a provider credential and never contacts a provider directly.
const CONVERSATIONS_API = '/api/v1/conversations';
const ASK_STORE = 'vivim.mobile.ask.v1';
const ASK_POLL_MS = 2500;
const ASK_SITES = { chatgpt: 'ChatGPT', claude: 'Claude' };
// Recognized refusals get specific advice; every retry still requires a fresh stored read with no matching key.
const ASK_BUSY_CODES = new Set(['DRIVE_LEASE_BUSY', 'CONVERSATION_OWNED_BY_ANOTHER_RUNTIME', 'CONVERSATION_NOT_WRITABLE', 'RUNTIME_CLOSED']);
const ASK_REFUSAL_CODES = new Set([...ASK_BUSY_CODES, 'BROWSER_UNAVAILABLE', 'DRAFT_PRESENT',
  'STALE_REVISION', 'THREAD_IDENTITY_UNVERIFIED', 'BINDING_CHANGED', 'THREAD_FENCED',
  'PRIOR_TURN_CAPTURE_NOT_FINALIZED', 'ONE_TURN_LIMIT', 'CONVERSATION_FINISHED',
  'CONVERSATION_NOT_FOUND', 'INVALID_SUBMISSION']);

export function validateMobileScaffold(payload, id) {
  const value = payload?.scaffold;
  if (!value || value.schema !== 'vivim.personal-mobile-scaffold/1' ||
      value.appId !== id || !APP_ID.test(id) ||
      !Number.isSafeInteger(payload.version) || payload.version < 1 ||
      typeof value.name !== 'string' || value.name.length > 80 ||
      !Array.isArray(value.screens) || value.screens.length < 3 || value.screens.length > 12 ||
      value.runnableCode !== false || value.intelligence?.dispatch !== 'disabled' ||
      value.connection?.paired !== false) throw new Error('Unsupported or unsafe local app scaffold');
  const keys = new Set();
  for (const screen of value.screens) {
    if (!screen || typeof screen.key !== 'string' ||
        !/^[a-z][a-z0-9-]{0,48}$/.test(screen.key) ||
        !SCREENS.has(screen.kind) ||
        typeof screen.label !== 'string' || !screen.label.trim() ||
        screen.label.length > 64 || keys.has(screen.key)) {
      throw new Error('Unsupported mobile screen');
    }
    keys.add(screen.key);
  }
  if (!['home', 'agent', 'builder'].every(key => keys.has(key))) {
    throw new Error('Required VIVIM screens are missing');
  }
  return value;
}
export function validateMobileContent(content, id) {
  if (!content || content.schema !== 'vivim.personal-app-content/1' ||
      content.appId !== id || !Number.isSafeInteger(content.version) ||
      content.version < 0 || !Array.isArray(content.items) || content.items.length > 200 ||
      content.items.some(item => !ITEM_ID.test(item?.id ?? '') ||
        !['note', 'task'].includes(item.kind) ||
        typeof item.title !== 'string' || typeof item.body !== 'string' ||
        typeof item.completed !== 'boolean')) throw new Error('Invalid saved app content');
  return content;
}
export function mountMobile({
  document: doc, root, fetchImpl = globalThis.fetch, search = globalThis.location?.search ?? '',
  uuid = () => globalThis.crypto?.randomUUID?.(),
} = {}) {
  if (!doc || !root || typeof fetchImpl !== 'function') return null;
  const state = { appId: null, scaffold: null, version: null, active: 'home',
    index: null, content: null, agent: null, notice: '', error: '', busy: false,
    loading: false, draftTitle: '', draftBody: '', pendingKey: null, view: 'index',
    ask: { site: 'chatgpt', conversationId: null, revision: null, snapshot: null, turns: [],
      pending: null, draft: '', status: '', error: '', notice: '', retry: false,
      busy: false, timer: null, pinBottom: false, checkAgain: false } };
  let requestTicket = 0;
  function el(tag, text, cls) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function attr(node, key, value) { node.setAttribute(key, String(value)); return node; }
  const on = (node, type, fn) => node.addEventListener(type, fn);
  const btn = (text, fn, cls) => {
    const node = el('button', text, cls);
    node.type = 'button'; attr(node, 'type', 'button'); on(node, 'click', fn);
    return node;
  };
  function link(text, href, cls) {
    const node = el('a', text, cls); attr(node, 'href', href); return node;
  }
  async function request(path, options = {}) {
    const controller = options.timeoutMs && typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? globalThis.setTimeout(() => controller.abort(), options.timeoutMs) : null;
    try {
      const response = await fetchImpl(path, { credentials: 'same-origin', cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
        ...(options.body ? { headers: { 'content-type': 'application/json' },
          body: JSON.stringify(options.body) } : {}), method: options.method ?? 'GET' });
      let data; try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data };
    } catch { return { status: 0, data: null }; }
    finally { if (timer) globalThis.clearTimeout(timer); }
  }
  function message(target) {
    if (state.error) target.append(el('p', state.error, 'notice error'));
    if (state.notice) target.append(el('p', state.notice, 'notice'));
  }
  function header() {
    const top = el('header', undefined, 'top'), name = el('div');
    name.append(el('div', 'VIVIM', 'brand'), el('div', 'MY MOBILE WORLD', 'eyebrow'));
    const actions = el('div', undefined, 'top-actions');
    if (state.view === 'ask') actions.append(btn('My apps', () => loadIndex()));
    else actions.append(btn('Ask my AI', () => openAsk()), btn('My apps', () => loadIndex()));
    actions.append(link('World', '/chat', 'action'));
    top.append(name, actions); return top;
  }
  function privacy(target) {
    target.append(el('footer',
      'VIVIM data is hosted on your PC; this phone connects over your WiFi and saves recent messages to resume your chat. Your chosen AI provider receives messages through your own account.',
      'footer'));
  }
  function renderIndex(target) {
    const hero = el('section', undefined, 'card hero');
    hero.append(el('div', 'YOUR APPS', 'eyebrow'), el('h1', 'A personal world you can shape'),
      el('p', 'Ask your own AI from this phone, or open a locally saved VIVIM app. VIVIM runs on your PC.', 'muted'));
    target.append(hero);
    renderAskEntry(target);
    const list = el('section', undefined, 'card');
    list.append(el('h2', 'My local apps'));
    if (state.index?.items?.length) {
      for (const app of state.index.items) {
        if (!APP_ID.test(app.id)) continue;
        const button = btn(app.title + ' · ' + app.screenCount + ' screens', () => openApp(app.id), 'tile');
        list.append(button);
      }
    } else list.append(el('p', state.loading ? 'Reading local app list…' :
      'No app blueprints yet. Create one in VIVIM World.', 'muted'));
    list.append(link('Build an app in World', '/chat', 'action'));
    target.append(list);
  }
  function renderHome(target) {
    const hero = el('section', undefined, 'card hero');
    hero.append(el('div', 'WELCOME HOME', 'eyebrow'),
      el('h1', state.scaffold.name),
      el('p', 'This is your own local app. Select a screen to start using it.', 'muted'));
    target.append(hero);
    const tiles = el('section', undefined, 'card');
    tiles.append(el('h2', 'Explore your screens'));
    for (const screen of state.scaffold.screens.filter(item => item.key !== 'home')) {
      tiles.append(btn(screen.label, () => chooseScreen(screen.key), 'tile'));
    }
    target.append(tiles);
  }
  function renderAgent(target) {
    const box = el('section', undefined, 'card');
    box.append(el('h2', 'My Agent'), el('p',
      'Your Personal Agent is owned by the local VIVIM service. Status is loaded only when you ask.', 'muted'));
    const read = btn('Read local agent status', () => readAgent(), 'primary');
    read.disabled = state.busy;
    box.append(read);
    if (state.agent) {
      box.append(el('p', state.agent.initialized ?
        'Agent initialized on this PC.' : 'Agent is not initialized on this PC.'));
      if (state.agent.nextStage) box.append(el('p', 'Next bootstrap stage: ' + state.agent.nextStage, 'muted'));
      const counts = state.agent.work?.byStatus;
      if (counts) box.append(el('p', 'Queued work: ' + (counts.queued ?? 0) +
        ' · Active: ' + (counts.active ?? 0), 'muted'));
    }
    box.append(link('Manage Agent in World', '/chat', 'action'));
    target.append(box);
  }
  function renderBuilder(target) {
    const box = el('section', undefined, 'card');
    box.append(el('h2', 'Build'), el('p',
      'This app is generated from a bounded, versioned screen blueprint. Use the VIVIM World builder to propose, preview and explicitly approve changes.', 'muted'),
      el('p', 'Current blueprint revision: ' + state.version, 'muted'),
      link('Edit screens in VIVIM World', '/chat', 'action'));
    target.append(box);
  }
  function renderDataScreen(target, screen) {
    const box = el('section', undefined, 'card');
    const kind = screen.kind === 'notes' ? 'note' : 'task';
    box.append(el('h2', screen.label), el('p', 'Saved on your PC, not in an AI provider account.', 'muted'));
    const refresh = btn('Reload saved content', () => loadContent());
    refresh.disabled = state.busy; box.append(refresh);
    if (!state.content) {
      box.append(el('p', 'Content is not loaded. Select Reload saved content.', 'muted'));
      target.append(box); return;
    }
    const entries = state.content.items.filter(item => item.kind === kind);
    if (!entries.length) box.append(el('p', 'Nothing saved here yet.', 'muted'));
    for (const item of [...entries].reverse()) {
      const row = el('article', undefined, 'item');
      row.append(el('strong', item.title));
      if (item.body) row.append(el('p', item.body, 'muted'));
      if (kind === 'task') {
        const toggle = btn(item.completed ? 'Mark not done' : 'Mark done',
          () => setComplete(item.id, !item.completed));
        toggle.disabled = state.busy;
        row.append(el('p', item.completed ? 'Completed' : 'Open', item.completed ? 'good' : 'muted'), toggle);
      }
      box.append(row);
    }
    const form = el('form', undefined, 'stack');
    const heading = el('label', 'Title', 'field'), title = el('input', undefined, 'field-input');
    attr(title, 'maxlength', 160); attr(title, 'required', ''); attr(title, 'aria-label', 'New ' + kind + ' title');
    title.value = state.draftTitle;
    on(title, 'input', () => { state.draftTitle = title.value; state.pendingKey = null;
      save.disabled = state.busy || !state.draftTitle.trim(); });
    heading.append(title); form.append(heading);
    const bodyLabel = el('label', 'Details (optional)', 'field');
    const body = el('textarea', undefined, 'field-input');
    attr(body, 'maxlength', 4000); attr(body, 'aria-label', 'New ' + kind + ' details');
    body.value = state.draftBody;
    on(body, 'input', () => { state.draftBody = body.value; state.pendingKey = null; });
    bodyLabel.append(body); form.append(bodyLabel);
    const save = btn('Save ' + kind + ' locally', () => {});
    attr(save, 'type', 'submit');
    save.disabled = state.busy || !state.draftTitle.trim();
    form.append(save);
    on(form, 'submit', event => { event.preventDefault(); createItem(kind); });
    box.append(form); target.append(box);
  }
  function renderDashboard(target) {
    const box = el('section', undefined, 'card');
    box.append(el('h2', 'My dashboard'));
    if (!state.content) {
      box.append(el('p', 'No saved content loaded yet.', 'muted'),
        btn('Load local totals', () => loadContent()));
    } else {
      const items = state.content.items;
      box.append(el('p', 'Notes: ' + items.filter(x => x.kind === 'note').length),
        el('p', 'Tasks open: ' + items.filter(x => x.kind === 'task' && !x.completed).length),
        el('p', 'Tasks completed: ' + items.filter(x => x.kind === 'task' && x.completed).length));
      box.append(btn('Refresh totals', () => loadContent()));
    }
    target.append(box);
  }
  function render() {
    const page = el('div');
    page.append(header()); message(page);
    if (state.view === 'ask') {
      renderAsk(page); privacy(page); paint(page); return;
    }
    if (!state.scaffold) {
      renderIndex(page); privacy(page); paint(page); return;
    }
    const meta = el('p', 'On this PC · Blueprint v' + state.version, 'eyebrow');
    page.append(meta);
    const tabs = el('nav', undefined, 'tabs'); attr(tabs, 'aria-label', 'App screens'); attr(tabs, 'role', 'tablist');
    for (const screen of state.scaffold.screens) {
      const control = btn(screen.label, () => chooseScreen(screen.key));
      attr(control, 'role', 'tab');
      attr(control, 'aria-selected', String(screen.key === state.active));
      tabs.append(control);
    }
    page.append(tabs);
    const selected = state.scaffold.screens.find(x => x.key === state.active) ?? state.scaffold.screens[0];
    const area = el('main', undefined, 'screen');
    if (selected.kind === 'home') renderHome(area);
    else if (selected.kind === 'agent') renderAgent(area);
    else if (selected.kind === 'builder') renderBuilder(area);
    else if (selected.kind === 'notes' || selected.kind === 'tasks') renderDataScreen(area, selected);
    else if (selected.kind === 'dashboard') renderDashboard(area);
    else {
      const blank = el('section', undefined, 'card');
      blank.append(el('h2', selected.label), el('p',
        'This screen is an empty user-configured canvas. Add its capabilities through the VIVIM builder.', 'muted'));
      area.append(blank);
    }
    page.append(area); privacy(page); paint(page);
  }
  // Repainting replaces the whole tree (the fixed-component rule keeps rendering simple). The page position is
  // restored so a poll refresh never yanks the reader back to the top; after a new message it follows the end.
  function paint(page) {
    const view = doc.defaultView ?? globalThis;
    const scroller = typeof view?.scrollY === 'number' && typeof view?.scrollTo === 'function' ? view : null;
    const top = scroller ? view.scrollY : null;
    const focused = doc.activeElement;
    const selection = focused?.id === 'askMessage'
      ? { start: focused.selectionStart, end: focused.selectionEnd } : null;
    root.replaceChildren(page);
    if (selection) {
      const box = doc.getElementById('askMessage');
      box?.focus?.({ preventScroll: true });
      if (typeof selection.start === 'number') box?.setSelectionRange?.(selection.start, selection.end);
    }
    if (!scroller) return;
    if (state.view === 'ask' && state.ask.pinBottom) {
      state.ask.pinBottom = false;
      const height = doc.scrollingElement?.scrollHeight ?? doc.documentElement?.scrollHeight ?? 0;
      scroller.scrollTo(0, height);
    } else if (top !== null) scroller.scrollTo(0, top);
  }
  async function loadIndex() {
    const ticket = ++requestTicket;
    askStopPolling(); state.view = 'index';
    state.scaffold = null; state.appId = null; state.content = null; state.agent = null;
    state.busy = false; state.pendingKey = null;
    state.notice = ''; state.error = ''; state.loading = true; render();
    const result = await request(MOBILE_API);
    if (ticket !== requestTicket) return;
    state.loading = false;
    if (result.status === 200 && Array.isArray(result.data?.items)) state.index = result.data;
    else state.error = 'Cannot load local app library (' + (result.data?.code ?? result.status) + ').';
    render();
  }
  async function openApp(id) {
    if (!APP_ID.test(id)) {
      state.error = 'Invalid local app reference'; render(); return;
    }
    const ticket = ++requestTicket;
    askStopPolling(); state.view = 'app';
    state.loading = true; state.busy = false; state.notice = ''; state.error = ''; state.scaffold = null;
    state.appId = id; state.content = null; state.agent = null;
    state.pendingKey = null; state.draftTitle = ''; state.draftBody = ''; render();
    const result = await request(MOBILE_API + '/' + encodeURIComponent(id) + '/scaffold');
    if (ticket !== requestTicket) return;
    state.loading = false;
    try {
      if (result.status !== 200) throw new Error('Local app unavailable (' + (result.data?.code ?? result.status) + ')');
      state.scaffold = validateMobileScaffold(result.data, id);
      state.version = result.data.version; state.active = 'home';
    } catch (error) { state.error = error.message; }
    render();
  }
  async function loadContent() {
    const id = state.appId, ticket = requestTicket;
    if (!id || state.busy) return;
    state.busy = true; state.error = ''; render();
    const result = await request(MOBILE_API + '/' + encodeURIComponent(id) + '/content');
    if (ticket !== requestTicket || state.appId !== id) return;
    state.busy = false;
    try {
      if (result.status !== 200) throw new Error('Local content unavailable (' + (result.data?.code ?? result.status) + ')');
      state.content = validateMobileContent(result.data, id);
    } catch (error) { state.error = error.message; }
    render();
  }
  function chooseScreen(key) {
    if (!state.scaffold?.screens.some(screen => screen.key === key)) return;
    const priorKind = state.scaffold.screens.find(screen => screen.key === state.active)?.kind;
    state.active = key; state.error = ''; state.notice = '';
    const kind = state.scaffold.screens.find(screen => screen.key === key).kind;
    if (priorKind !== kind) { state.draftTitle = ''; state.draftBody = ''; state.pendingKey = null; }
    render();
    if (['notes', 'tasks', 'dashboard'].includes(kind) && !state.content) loadContent();
  }
  async function createItem(kind) {
    const id = state.appId, content = state.content;
    if (!id || !content || state.busy || !state.draftTitle.trim()) return;
    if (!state.pendingKey) {
      const key = uuid();
      if (!key) { state.error = 'Secure creation key unavailable. Nothing saved.'; render(); return; }
      state.pendingKey = 'mobile:' + key;
    }
    const title = state.draftTitle, body = state.draftBody;
    const sentKey = state.pendingKey, ticket = requestTicket;
    state.busy = true; state.error = ''; state.notice = ''; render();
    const result = await request(MOBILE_API + '/' + id + '/content/items', {
      method: 'POST', body: { expectedVersion: content.version, idempotencyKey: state.pendingKey,
        kind, title, body },
    });
    if (id !== state.appId || ticket !== requestTicket) return;
    state.busy = false;
    if (result.status === 200 && result.data?.item &&
        result.data.item.kind === kind && result.data.content?.appId === id) {
      try {
        state.content = validateMobileContent(result.data.content, id);
        if (state.draftTitle === title && state.draftBody === body && state.pendingKey === sentKey) {
          state.draftTitle = ''; state.draftBody = ''; state.pendingKey = null;
        }
        state.notice = result.data.replayed ? 'Recovered the previous local save.' : 'Saved on this PC.';
      } catch (error) { state.error = error.message; }
    } else {
      state.error = (result.data?.code ?? 'SAVE_UNCONFIRMED') +
        ': save unconfirmed. Your draft is retained; retry will reuse its creation key.';
    }
    render();
  }
  async function setComplete(itemId, completed) {
    const id = state.appId, current = state.content, ticket = requestTicket;
    if (!id || !current || !ITEM_ID.test(itemId) || state.busy) return;
    state.busy = true; state.error = ''; state.notice = ''; render();
    const result = await request(MOBILE_API + '/' + id + '/content/items/' + itemId + '/completion', {
      method: 'POST', body: { expectedVersion: current.version, completed },
    });
    if (id !== state.appId || ticket !== requestTicket) return;
    state.busy = false;
    if (result.status === 200 && result.data?.content) {
      try {
        state.content = validateMobileContent(result.data.content, id);
        state.notice = 'Task updated locally.';
      } catch (error) { state.error = error.message; }
    } else state.error = (result.data?.code ?? 'UPDATE_UNCONFIRMED') +
      ': task update not confirmed. Reload saved content before trying again.';
    render();
  }
  async function readAgent() {
    if (state.busy) return;
    const ticket = requestTicket, id = state.appId;
    state.busy = true; state.error = ''; render();
    const result = await request('/api/v1/personal-agent/status');
    if (ticket !== requestTicket || id !== state.appId) return;
    state.busy = false;
    if (result.status === 200 && typeof result.data?.initialized === 'boolean') {
      state.agent = result.data;
      state.notice = 'Read local agent status. No AI provider call was made.';
    } else state.error = 'Agent status unavailable (' + (result.data?.code ?? result.status) + ').';
    render();
  }
  /* ---------------- Ask my AI ---------------- */
  // The phone asks the user's OWN ChatGPT/Claude through the PC: open a fresh chat, post one message, then watch
  // the saved chat until the answer is ready. One message key is made per message and never replaced, so a slow
  // or lost answer can never become a second send. Nothing here talks to a provider or holds a credential.
  const askSite = () => ASK_SITES[state.ask.site] ?? 'your AI';
  const askUnwrap = (data) => {
    const c = data?.conversation ?? data?.resource ?? data;
    return c && typeof c.id === 'string' && c.revision !== undefined ? c : null;
  };
  const askTurns = () => (Array.isArray(state.ask.snapshot?.turns) ? state.ask.snapshot.turns : []);
  const askFindTurn = (key) => askTurns().find(turn => turn?.key === key) ?? null;
  function askStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
  // Only what the phone needs to resume: the chat id, the messages typed here (the service never returns prompt
  // text) and the one message key still waiting for an answer.
  function saveAsk() {
    const store = askStorage(); if (!store) return;
    try {
      store.setItem(ASK_STORE, JSON.stringify({ site: state.ask.site, conversationId: state.ask.conversationId,
        turns: state.ask.turns.slice(-40), pending: state.ask.pending, draft: state.ask.draft }));
    } catch { /* private mode: the chat works, it just cannot resume after a refresh */ }
  }
  function restoreAsk() {
    const store = askStorage(); if (!store) return;
    try {
      const saved = JSON.parse(store.getItem(ASK_STORE) ?? 'null');
      if (!saved || typeof saved !== 'object') return;
      if (saved.site === 'chatgpt' || saved.site === 'claude') state.ask.site = saved.site;
      state.ask.conversationId = typeof saved.conversationId === 'string' && saved.conversationId
        ? saved.conversationId : null;
      state.ask.turns = Array.isArray(saved.turns) ? saved.turns.filter(turn => turn &&
        typeof turn.key === 'string' && typeof turn.prompt === 'string').slice(-40) : [];
      state.ask.draft = typeof saved.draft === 'string' ? saved.draft : '';
      state.ask.pending = saved.pending && typeof saved.pending.key === 'string' &&
        typeof saved.pending.prompt === 'string' ? saved.pending : null;
      if (!state.ask.conversationId) state.ask.pending = null;
    } catch { /* a damaged entry is ignored and the chat starts clean */ }
  }
  function askStopPolling() {
    if (state.ask.timer) { globalThis.clearTimeout(state.ask.timer); state.ask.timer = null; }
  }
  // One waiting message at a time. A first answer can take minutes, so the request that started it may already
  // have timed out: the saved chat, never a timer, decides what happened.
  function askSchedulePoll() {
    askStopPolling();
    if (state.view !== 'ask' || !state.ask.pending) return;
    state.ask.timer = globalThis.setTimeout(() => { state.ask.timer = null; askPoll(); }, ASK_POLL_MS);
  }
  function askSignature() {
    const ask = state.ask;
    return JSON.stringify({ p: ask.pending?.key ?? null, s: ask.status, e: ask.error, n: ask.notice,
      r: ask.retry, c: ask.checkAgain, b: ask.busy,
      t: askTurns().map(turn => [turn?.key, turn?.phase, turn?.send?.state, turn?.reply?.state,
        turn?.reply?.text?.length ?? 0]) });
  }
  async function askPoll() {
    const ask = state.ask, pending = ask.pending;
    if (!pending || state.view !== 'ask') return;
    const ticket = requestTicket, before = askSignature();
    pending.polls = (pending.polls ?? 0) + 1;
    const ok = await askRefresh(ticket);
    if (ticket !== requestTicket || state.ask.pending?.key !== pending.key) return;
    if (!ok) {
      if (!ask.conversationId) { askStopPolling(); if (askSignature() !== before) render(); return; }
      if (pending.polls >= 6) {
        askStopPolling(); ask.status = ''; ask.checkAgain = true;
        ask.error = 'Can’t reach your PC right now. Check that you are on the same WiFi, then tap Check again.';
      } else askSchedulePoll();
      if (askSignature() !== before) render();
      return;
    }
    const outcome = askResolve();
    if (outcome === 'working' || outcome === 'missing') {
      if (pending.polls >= 150) {
        askStopPolling(); ask.status = ''; ask.checkAgain = true;
        ask.error = 'This is taking a long time. Tap Check again in a moment.';
      } else askSchedulePoll();
    } else askStopPolling();
    saveAsk();
    if (askSignature() !== before) render();
  }
  function askApply(snapshot) {
    const ask = state.ask;
    if (!snapshot || snapshot.id !== ask.conversationId) return false;
    if (ask.revision !== null && Number(snapshot.revision) < Number(ask.revision)) return false;
    ask.snapshot = snapshot; ask.revision = snapshot.revision;
    return true;
  }
  // Read-only: the saved chat exactly as the PC has it now. Never posts, never types into the browser tab.
  async function askRefresh(ticket) {
    const ask = state.ask;
    if (!ask.conversationId) return false;
    // runtime.get returns reply.text on each turn (unlike the summary-only list endpoint).
    const result = await request(CONVERSATIONS_API + '/' + encodeURIComponent(ask.conversationId), { timeoutMs: 20000 });
    if (ticket !== requestTicket) return false;
    const snapshot = askUnwrap(result.data);
    if (snapshot && snapshot.id === ask.conversationId) {
      askApply(snapshot);
      if (ask.pending && !ask.busy && !askFindTurn(ask.pending.key)) ask.pending.absentAfterPost = true;
      return true;
    }
    if (result.status === 401 || result.status === 403) {
      ask.error = 'Your phone’s connection needs approval again. Open the connection link from VIVIM on your PC.';
      ask.status = ''; ask.checkAgain = true;
    }
    if (result.status === 404) {
      askStopPolling();
      ask.conversationId = null; ask.snapshot = null; ask.revision = null; ask.pending = null; ask.turns = [];
      ask.status = ''; ask.error = 'That chat is no longer on your PC. Start a new chat.';
      saveAsk();
    }
    return false;
  }
  // What the waiting message's own state is, read from the saved chat. Returns without posting anything.
  function askResolve() {
    const ask = state.ask, pending = ask.pending;
    if (!pending) return 'idle';
    const turn = askFindTurn(pending.key);
    if (!turn) {
      if (pending.absentAfterPost) {
        // The PC refused because its browser was busy and this chat shows no message from this tap: the same
        // key can be offered once, and the service replays it instead of making a second message.
        ask.status = ''; ask.error = ASK_REFUSAL_CODES.has(pending.code) ? askSendError(pending.code)
          : 'Your PC has no saved message from this tap. You can try again with the same message.'; ask.retry = true;
        return 'retry';
      }
      ask.status = 'Waiting for ' + askSite() + '…';
      return 'missing';
    }
    const reply = turn.reply ?? {};
    if (reply.state === 'ready') {
      // The box is left alone: anything typed while waiting is the user's next message.
      ask.pending = null; ask.retry = false; ask.status = ''; ask.error = '';
      return 'ready';
    }
    if (turn.send?.state === 'uncertain' || turn.phase === 'needs-reconciliation' ||
        ask.snapshot?.state === 'needs-reconciliation') {
      ask.retry = false; ask.status = ''; ask.checkAgain = true;
      ask.error = 'We couldn’t confirm your message reached ' + askSite() +
        '. Look at the ' + askSite() + ' tab on your PC before sending again.';
      return 'unsure';
    }
    if (reply.state === 'interrupted' || reply.state === 'unknown') {
      ask.pending = null; ask.retry = false; ask.status = '';
      ask.notice = 'That answer stopped before it finished. You can start a new chat.';
      return 'stopped';
    }
    if (turn.phase === 'blocked' && turn.send?.state === 'not-attempted') {
      ask.pending = null; ask.retry = false; ask.status = '';
      ask.error = askSendError(turn.reason);
      return 'blocked';
    }
    ask.status = 'Waiting for ' + askSite() + '…';
    return 'working';
  }
  function askSendError(code) {
    const name = askSite();
    switch (code) {
      case 'BROWSER_UNAVAILABLE': return 'Your PC’s AI browser isn’t running. Start VIVIM on your PC, then try again.';
      case 'AUTH_REQUIRED': return 'Your phone’s connection needs approval again. Open the connection link from VIVIM on your PC.';
      case 'DRAFT_PRESENT': return 'The ' + name + ' tab on your PC has unsent text. Clear it there, then send again.';
      case 'DRIVE_LEASE_BUSY': return 'Your PC is busy with another chat right now. Nothing was sent.';
      case 'STALE_REVISION': return 'That chat changed on your PC, so nothing was sent. Send again.';
      case 'THREAD_IDENTITY_UNVERIFIED':
      case 'BINDING_CHANGED': return 'The ' + name + ' tab on your PC isn’t on this chat, so nothing was sent. Start a new chat.';
      case 'THREAD_FENCED': return 'The earlier message here isn’t finished yet, so nothing was sent. Wait a moment, then send again.';
      case 'PRIOR_TURN_CAPTURE_NOT_FINALIZED': return 'The earlier answer is still being saved on your PC. Wait a moment, then send again.';
      case 'ONE_TURN_LIMIT': return 'This chat can’t take another message. Start a new chat.';
      case 'CONVERSATION_FINISHED': return 'This chat is finished. Start a new chat.';
      case 'CONVERSATION_NOT_FOUND': return 'That chat is no longer on your PC. Start a new chat.';
      case 'INVALID_SUBMISSION': return 'That message can’t be sent. Try a shorter one.';
      case 'CONVERSATION_OWNED_BY_ANOTHER_RUNTIME':
      case 'CONVERSATION_NOT_WRITABLE': return 'Another VIVIM window on your PC owns this chat. Close it there, then try again.';
      default: return 'Your PC couldn’t send this message. Nothing was sent. Try again.';
    }
  }
  function askCreateError(code) {
    const name = askSite();
    switch (code) {
      case 'BROWSER_UNAVAILABLE': return 'Your PC’s AI browser isn’t running. Start VIVIM on your PC, then try again.';
      case 'DRIVE_LEASE_BUSY': return 'Your PC is busy with another chat right now. Nothing was sent.';
      case 'THREAD_IDENTITY_UNVERIFIED':
      case 'BINDING_CHANGED': return 'Your PC opened ' + name + ' but couldn’t confirm the new chat. Nothing was sent. Try again.';
      default: return 'Your PC couldn’t open ' + name + '. Try again.';
    }
  }
  function askBlocked() {
    const ask = state.ask, name = askSite();
    if (ask.busy) return 'Working…';
    if (ask.pending) return 'Waiting for ' + name + '…';
    const turns = askTurns(), last = turns[turns.length - 1];
    if (ask.snapshot?.state === 'needs-reconciliation' || last?.send?.state === 'uncertain') {
      return 'Check the ' + name + ' tab on your PC before sending again.';
    }
    if (last && !(last.reply?.state === 'ready' ||
        (last.phase === 'blocked' && last.send?.state === 'not-attempted'))) return 'Waiting for ' + name + '…';
    return '';
  }
  // Opening a fresh chat sends no message, so a slow or lost create can never duplicate anything.
  async function askCreate(ticket) {
    const ask = state.ask, site = ask.site;
    const result = await request(CONVERSATIONS_API + '/create',
      { method: 'POST', body: { site }, timeoutMs: 120000 });
    if (ticket !== requestTicket) return false;
    const snapshot = askUnwrap(result.data);
    if (!snapshot) {
      ask.status = '';
      ask.error = result.status === 401 || result.status === 403
        ? askSendError('AUTH_REQUIRED') : askCreateError(result.data?.code ?? null);
      return false;
    }
    ask.conversationId = snapshot.id; ask.revision = snapshot.revision; ask.snapshot = snapshot;
    ask.turns = []; ask.pending = null; ask.status = '';
    saveAsk();
    return true;
  }
  // The only place a message is posted. It runs from Send and from the one "Try again" the user taps, and the
  // message key never changes, so the service treats a repeat as the same message, never as a second one.
  async function askPostPending(ticket) {
    const ask = state.ask, pending = ask.pending;
    if (!pending || !ask.conversationId) return;
    const result = await request(CONVERSATIONS_API + '/' + encodeURIComponent(ask.conversationId) + '/turns', {
      method: 'POST', timeoutMs: 120000,
      body: { key: pending.key, prompt: pending.prompt, confirm: true, expectedRevision: pending.expectedRevision },
    });
    if (ticket !== requestTicket || state.ask.pending?.key !== pending.key) return;
    const snapshot = askUnwrap(result.data);
    if (snapshot && snapshot.id === ask.conversationId) askApply(snapshot);
    else if (result.status === 401 || result.status === 403) {
      ask.status = ''; ask.error = askSendError('AUTH_REQUIRED'); ask.checkAgain = true;
      saveAsk(); return;
    }
    pending.code = result.data?.code ?? null;
    // Even a 409 may mean the effect happened. Only a fresh stored read can permit a same-key retry.
    pending.absentAfterPost = false;
    const refreshed = await askRefresh(ticket);
    if (ticket !== requestTicket || state.ask.pending?.key !== pending.key) return;
    if (refreshed && !askFindTurn(pending.key)) pending.absentAfterPost = true;
    // No answer, a timeout, a 5xx or an unreadable body leaves the message waiting: the saved chat decides, and
    // the phone keeps looking for this exact message key.
    askResolve();
    saveAsk();
    if (!ask.retry) askSchedulePoll();
  }
  async function askPost(prompt, ticket) {
    const ask = state.ask, turns = askTurns();
    const key = uuid() || 'mobile-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 10);
    const pending = { key, prompt, at: Date.now(), polls: 0, code: null,
      expectedRevision: Number(ask.revision ?? ask.snapshot?.revision ?? 0),
      priorTurnId: turns[turns.length - 1]?.id ?? null };
    ask.pending = pending;
    ask.turns = [...ask.turns, { key, prompt, at: pending.at }].slice(-40);
    ask.draft = ''; ask.pinBottom = true; ask.status = 'Waiting for ' + askSite() + '…';
    saveAsk(); render();
    await askPostPending(ticket);
  }
  async function askSend() {
    const ask = state.ask, prompt = ask.draft.replace(/\s+$/, '');
    if (!prompt.trim() || askBlocked()) return;
    const ticket = requestTicket;
    ask.busy = true; ask.error = ''; ask.notice = ''; ask.retry = false; ask.checkAgain = false;
    ask.status = ask.conversationId ? 'Sending…' : 'Opening ' + askSite() + ' on your PC…';
    render();
    if (!ask.conversationId && !await askCreate(ticket)) { ask.busy = false; ask.status = ''; render(); return; }
    if (ticket !== requestTicket) return;
    await askPost(prompt, ticket);
    ask.busy = false;
    if (ticket !== requestTicket) return;
    saveAsk(); render();
  }
  // The user's own choice after a refusal, with the same key: safe by construction, because the service replays
  // the original message instead of creating a second one.
  async function askRetry() {
    const ask = state.ask, pending = ask.pending;
    if (!pending || ask.busy || !ask.retry) return;
    const ticket = requestTicket;
    ask.busy = true; ask.error = ''; ask.retry = false; ask.status = 'Sending…'; render();
    const ok = await askRefresh(ticket);
    if (ticket !== requestTicket || state.ask.pending?.key !== pending.key) { ask.busy = false; return; }
    if (ok) {
      if (askFindTurn(pending.key)) {
        askResolve(); ask.busy = false; if (ask.pending) askSchedulePoll(); saveAsk(); render(); return;
      }
      pending.absentAfterPost = true;
      pending.expectedRevision = Number(ask.revision ?? pending.expectedRevision);
      ask.error = ''; ask.retry = false;
    } else {
      ask.busy = false; ask.status = ''; ask.checkAgain = true;
      if (!ask.error) ask.error = 'Can’t check your saved chat. Check your WiFi, then tap Check again. Nothing was resent.';
      saveAsk(); render(); return;
    }
    await askPostPending(ticket);
    ask.busy = false; saveAsk(); render();
  }
  async function askCheckAgain() {
    const ask = state.ask;
    if (ask.busy || !ask.conversationId) return;
    const ticket = requestTicket;
    ask.busy = true; ask.error = ''; ask.checkAgain = false; ask.status = 'Checking…'; render();
    const ok = await askRefresh(ticket);
    if (ticket !== requestTicket) { ask.busy = false; return; }
    ask.busy = false;
    if (ok) {
      if (ask.pending && !askFindTurn(ask.pending.key)) ask.pending.absentAfterPost = true;
      askResolve(); if (ask.pending && !ask.retry) askSchedulePoll();
    }
    else if (!ask.error) ask.error = 'Can’t reach your PC right now.';
    saveAsk(); render();
  }
  async function askNewChat() {
    const ask = state.ask;
    if (ask.busy || ask.pending) return;
    const id = ask.conversationId;
    askStopPolling();
    ask.busy = true; render();
    const ticket = requestTicket;
    const result = id ? await request(CONVERSATIONS_API + '/' + encodeURIComponent(id) + '/finish',
      { method: 'POST', body: { closeTab: true }, timeoutMs: 20000 }) : null;
    if (ticket !== requestTicket) { ask.busy = false; return; }
    if (state.view !== 'ask') { ask.busy = false; return; }
    if (result && !(result.status >= 200 && result.status < 300)) {
      ask.busy = false;
      ask.error = result.status === 401 || result.status === 403 ? askSendError('AUTH_REQUIRED')
        : 'Couldn’t finish this chat on your PC. Check your WiFi, then tap New chat again.';
      render(); return;
    }
    ask.conversationId = null; ask.snapshot = null; ask.revision = null; ask.turns = []; ask.pending = null;
    ask.draft = ''; ask.status = ''; ask.error = ''; ask.retry = false; ask.checkAgain = false;
    ask.notice = 'Started a new chat.'; ask.busy = false; ask.pinBottom = true;
    saveAsk(); render();
  }
  function askChooseSite(site) {
    const ask = state.ask;
    if (!ASK_SITES[site] || ask.conversationId || ask.busy) return;
    ask.site = site; ask.error = ''; ask.notice = ''; saveAsk(); render();
  }
  function openAsk() {
    if (state.view === 'ask') return;
    ++requestTicket;
    state.view = 'ask'; state.loading = false; state.error = ''; state.notice = '';
    state.ask.error = ''; state.ask.notice = ''; state.ask.checkAgain = false; state.ask.pinBottom = true;
    render();
    if (state.ask.conversationId) askLoadOnOpen();
  }
  async function askLoadOnOpen() {
    const ticket = requestTicket;
    const ok = await askRefresh(ticket);
    if (ticket !== requestTicket || state.view !== 'ask') return;
    if (!ok) {
      state.ask.checkAgain = Boolean(state.ask.conversationId);
      if (!state.ask.error) state.ask.error = 'Can’t reach your PC. Check your WiFi, then tap Check again.';
      render(); return;
    }
    askResolve();
    saveAsk(); render();
    if (state.ask.pending) askSchedulePoll();
  }
  function askRows() {
    const ask = state.ask, local = new Map(ask.turns.map(turn => [turn.key, turn.prompt]));
    const rows = [], seen = new Set();
    for (const turn of askTurns()) {
      const key = typeof turn?.key === 'string' ? turn.key : '';
      seen.add(key);
      rows.push({ role: 'you', key, text: local.get(key) ?? null });
      rows.push({ role: 'ai', key, turn });
    }
    for (const turn of ask.turns) {
      if (seen.has(turn.key)) continue;
      rows.push({ role: 'you', key: turn.key, text: turn.prompt });
      rows.push({ role: 'ai', key: turn.key, turn: null });
    }
    return rows;
  }
  function askDots(name) {
    const dots = el('span', undefined, 'typing');
    attr(dots, 'role', 'img'); attr(dots, 'aria-label', name + ' is writing');
    dots.append(el('i'), el('i'), el('i'));
    return dots;
  }
  function askBubble(row, last) {
    const name = askSite();
    const node = el('div', undefined, 'bubble ' + (row.role === 'you' ? 'you' : 'ai'));
    node.append(el('span', row.role === 'you' ? 'You' : name, 'who'));
    if (row.role === 'you') {
      node.append(el('p', row.text ?? 'Sent from your PC'));
      return node;
    }
    const reply = row.turn?.reply ?? null, text = typeof reply?.text === 'string' ? reply.text : '';
    if (text && (reply.state === 'ready' || reply.state === 'streaming')) {
      node.append(el('p', text));
      if (reply.state !== 'ready') node.append(askDots(name));
      return node;
    }
    if (reply?.state === 'ready') { node.append(el('p', 'The answer came back empty. You can ask again.', 'muted')); return node; }
    if (reply?.state === 'interrupted' || reply?.state === 'unknown') {
      node.append(el('p', 'This answer stopped before it finished.', 'muted')); return node;
    }
    if (row.turn?.phase === 'blocked' && row.turn?.send?.state === 'not-attempted') {
      node.append(el('p', 'Not sent.', 'muted')); return node;
    }
    if (last) { node.append(askDots(name)); return node; }
    node.append(el('p', 'No answer here.', 'muted'));
    return node;
  }
  function renderAskEntry(target) {
    const ask = state.ask;
    const card = el('button', undefined, 'ask-card');
    card.type = 'button'; attr(card, 'type', 'button');
    on(card, 'click', () => openAsk());
    card.append(el('span', 'ASK MY AI', 'eyebrow'), el('span', 'Ask my AI', 'ask-title'),
      el('span', ask.pending ? 'Waiting for ' + askSite() + '… tap to see the answer.'
        : ask.conversationId ? 'Continue your chat with ' + askSite() + '.'
          : 'Talk to your own ' + askSite() + ' from this phone. It runs on your PC.', 'ask-sub'));
    target.append(card);
  }
  function askComposer() {
    const ask = state.ask, name = askSite();
    const form = el('section', undefined, 'card ask-composer');
    const field = el('label', 'Your message', 'field');
    attr(field, 'for', 'askMessage');
    const box = el('textarea', undefined, 'field-input');
    attr(box, 'id', 'askMessage'); attr(box, 'rows', '3'); attr(box, 'maxlength', '4000');
    attr(box, 'aria-label', 'Your message to ' + name);
    attr(box, 'placeholder', 'Ask ' + name + ' anything…');
    box.value = ask.draft;
    const actions = el('div', undefined, 'ask-actions');
    const send = btn('Send', () => askSend(), 'primary');
    send.disabled = Boolean(askBlocked()) || !ask.draft.trim() || ask.busy;
    const fresh = btn('New chat', () => askNewChat());
    fresh.disabled = ask.busy || Boolean(ask.pending) || !ask.conversationId;
    on(box, 'input', () => {
      ask.draft = box.value; saveAsk();
      send.disabled = Boolean(askBlocked()) || !ask.draft.trim() || ask.busy;
    });
    field.append(box);
    actions.append(send, fresh);
    form.append(field, actions);
    const blocked = askBlocked();
    if (blocked) form.append(el('p', blocked, 'muted'));
    return form;
  }
  function renderAsk(page) {
    const ask = state.ask, name = askSite();
    const hero = el('section', undefined, 'card hero');
    hero.append(el('div', 'ASK MY AI', 'eyebrow'), el('h1', 'Ask my AI'),
      el('p', 'Runs on your PC using your own ' + name + ' account.', 'muted'));
    const seg = el('div', undefined, 'seg');
    attr(seg, 'role', 'group'); attr(seg, 'aria-label', 'Which AI to ask');
    for (const site of Object.keys(ASK_SITES)) {
      const choice = btn(ASK_SITES[site], () => askChooseSite(site));
      attr(choice, 'aria-pressed', String(ask.site === site));
      choice.disabled = Boolean(ask.conversationId) || ask.busy;
      seg.append(choice);
    }
    hero.append(seg);
    if (ask.conversationId) hero.append(el('p', 'Start a new chat to switch.', 'muted'));
    page.append(hero);

    const thread = el('section', undefined, 'card');
    thread.append(el('h2', 'Conversation'));
    const rows = askRows();
    if (!rows.length) {
      thread.append(el('p', 'Say hello. Your message opens ' + name +
        ' on your PC, and the answer comes back here.', 'muted'));
    }
    const log = el('div', undefined, 'bubbles');
    attr(log, 'role', 'log'); attr(log, 'aria-live', 'polite');
    attr(log, 'aria-label', 'Messages with ' + name);
    rows.forEach((row, index) => log.append(askBubble(row, index === rows.length - 1)));
    thread.append(log);

    const status = el('div');
    attr(status, 'role', 'status'); attr(status, 'aria-live', 'polite');
    if (ask.error) status.append(el('p', ask.error, 'notice error'));
    if (ask.notice) status.append(el('p', ask.notice, 'notice'));
    if (ask.status) status.append(el('p', ask.status, 'muted'));
    if (ask.retry) {
      const again = btn('Try again', () => askRetry());
      again.disabled = ask.busy;
      status.append(again);
    }
    if (ask.checkAgain) {
      const check = btn('Check again', () => askCheckAgain());
      check.disabled = ask.busy;
      status.append(check);
    }
    thread.append(status);
    page.append(thread);
    page.append(askComposer());
  }
  const app = new URLSearchParams(search).get('app');
  restoreAsk();
  if (app) openApp(app); else loadIndex();
  return { loadIndex, openApp, chooseScreen, loadContent, openAsk, askSend, render, state };
}
// Registers the shell-only service worker (/mobile-sw.js, scope /mobile). Needs a secure context; resolves
// false (never throws) when the browser or origin does not allow it.
export function registerMobileShell(nav = typeof navigator !== 'undefined' ? navigator : null,
  secure = typeof isSecureContext !== 'undefined' && isSecureContext) {
  if (!secure || !nav?.serviceWorker) return Promise.resolve(false);
  return nav.serviceWorker.register('/mobile-sw.js', { scope: '/mobile' }).then(() => true, () => false);
}
if (typeof document !== 'undefined' && document.getElementById('mobileRoot')) {
  mountMobile({ document, root: document.getElementById('mobileRoot') });
  registerMobileShell();
}
