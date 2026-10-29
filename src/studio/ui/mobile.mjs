// VIVIM mobile surface: same owner, same Studio APIs, fixed trusted components only.
// Phone-shaped working view on the PC's loopback origin. NOT pairing, APK, sync or offline PWA.
export const MOBILE_API = '/api/v1/personal-apps';
const APP_ID = /^app-[a-f0-9]{32}$/;
const ITEM_ID = /^item-[a-f0-9]{32}$/;
const SCREENS = new Set(['home', 'agent', 'builder', 'notes', 'tasks', 'dashboard', 'blank']);

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
    loading: false, draftTitle: '', draftBody: '', pendingKey: null };
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
    try {
      const response = await fetchImpl(path, { credentials: 'same-origin', cache: 'no-store',
        ...(options.body ? { headers: { 'content-type': 'application/json' },
          body: JSON.stringify(options.body) } : {}), method: options.method ?? 'GET' });
      let data; try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data };
    } catch { return { status: 0, data: null }; }
  }
  function message(target) {
    if (state.error) target.append(el('p', state.error, 'notice error'));
    if (state.notice) target.append(el('p', state.notice, 'notice'));
  }
  function header() {
    const top = el('header', undefined, 'top'), name = el('div');
    name.append(el('div', 'VIVIM', 'brand'), el('div', 'MY MOBILE WORLD', 'eyebrow'));
    const actions = el('div', undefined, 'top-actions');
    actions.append(btn('My apps', () => loadIndex()), link('World', '/chat', 'action'));
    top.append(name, actions); return top;
  }
  function privacy(target) {
    target.append(el('footer',
      'PC-hosted and local only · No phone pairing, offline sync, generated-code execution or APK is active.',
      'footer'));
  }
  function renderIndex(target) {
    const hero = el('section', undefined, 'card hero');
    hero.append(el('div', 'YOUR APPS', 'eyebrow'), el('h1', 'A personal world you can shape'),
      el('p', 'Choose a locally saved VIVIM app. Your screens and content stay on this PC until a future secure mobile connection is configured.', 'muted'));
    target.append(hero);
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
    if (!state.scaffold) {
      renderIndex(page); privacy(page); root.replaceChildren(page); return;
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
    page.append(area); privacy(page); root.replaceChildren(page);
  }
  async function loadIndex() {
    const ticket = ++requestTicket;
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
  const app = new URLSearchParams(search).get('app');
  if (app) openApp(app); else loadIndex();
  return { loadIndex, openApp, chooseScreen, loadContent, render, state };
}
if (typeof document !== 'undefined' && document.getElementById('mobileRoot')) {
  mountMobile({ document, root: document.getElementById('mobileRoot') });
}
