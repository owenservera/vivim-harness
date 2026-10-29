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
// All six signed-in AI websites the phone may ask directly (same set the backend's create and compare
// routes accept). "Ask my AI" lets the user pick any one of these, remembered on this phone.
const ASK_SITES = { chatgpt: 'ChatGPT', claude: 'Claude', zai: 'Z.ai', qwen: 'Qwen', deepseek: 'DeepSeek', gemini: 'Gemini' };
// "Design with my AI" only reuses the two sites personal-app-ai-design.mjs accepts today; it is not
// widened here even though Ask my AI now offers six.
const DESIGN_SITES = { chatgpt: 'ChatGPT', claude: 'Claude' };
// "Ask several": one question sent to more than one AI at once, through the shared compare job runner
// (src/studio/compare-service.mjs). Same no-resend rule as a single chat: polling only ever re-reads the
// SAME job id; a new question is the only thing that starts a new job.
const COMPARE_API = '/api/v1/compare';
const COMPARE_JOB_ID = /^cmp-[a-f0-9]{24}$/;
const COMPARE_ACTIVE = new Set(['queued', 'running']);
const isCompareActive = job => Boolean(job && typeof job.state === 'string' && COMPARE_ACTIVE.has(job.state));
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
    index: null, content: null, agent: null, notice: '', error: '', busy: false, connection: '', recovering: false,
    templates: [], template: 'notes', appTitle: '', creationKey: null,
    builder: { kind: 'notes', label: '', preview: null, source: null,
      site: 'chatgpt', wish: '', job: null, timer: null, designChecked: false, replies: [], repliesLoaded: false },
    loading: false, draftTitle: '', draftBody: '', pendingKey: null, view: 'index',
    ask: { site: 'chatgpt', mode: 'single', conversationId: null, revision: null, snapshot: null, turns: [],
      pending: null, draft: '', status: '', error: '', notice: '', retry: false,
      busy: false, reading: false, timer: null, pinBottom: false, checkAgain: false },
    compare: { sites: ['chatgpt', 'claude'], question: '', job: null, busy: false, error: '', notice: '', timer: null } };
  let requestTicket = 0;
  let designReadTicket = 0;
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
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 20000) : null;
    try {
      const response = await fetchImpl(path, { credentials: 'same-origin', cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
        ...(options.body ? { headers: { 'content-type': 'application/json' },
          body: JSON.stringify(options.body) } : {}), method: options.method ?? 'GET' });
      let data; try { data = await response.json(); } catch { data = null; }
      state.connection = response.status === 401 || response.status === 403 ? 'approval' : '';
      return { status: response.status, data };
    } catch { state.connection = 'offline'; return { status: 0, data: null }; }
    finally { if (timer) globalThis.clearTimeout(timer); }
  }
  function message(target) {
    if (state.connection) {
      const notice = el('section', undefined, 'notice'); attr(notice, 'role', 'status');
      notice.append(el('p', state.connection === 'approval'
        ? 'Reconnect this phone using the connection link from VIVIM on your PC.'
        : 'Your PC isn’t reachable. Connect to the same WiFi and keep VIVIM open on your PC. Nothing will be sent automatically. If your PC’s address changed, open a new connection link from VIVIM.'));
      const check = btn(state.recovering ? 'Checking connection…' : 'Check connection', () => recoverConnection());
      check.disabled = state.recovering; notice.append(check); target.append(notice);
    }
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
    if (globalThis.isSecureContext === false) target.append(el('p',
      'You can use VIVIM here while connected to your PC. Installing it and opening it offline need a secure connection; a plain WiFi address does not support those features.', 'footer'));
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
      'No apps yet. Choose a starter below to make your first app.', 'muted'));
    target.append(list);
    renderTemplates(target);
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
    const b = state.builder;
    const box = el('section', undefined, 'card');
    box.append(el('h2', 'Build your app'), el('p',
      'Choose a screen, preview it, then tap Add. Your existing notes and tasks stay saved on your PC.', 'muted'));
    box.append(btn('Refresh app', () => refreshBuilder()));
    const kinds = el('div', undefined, 'row');
    for (const [kind, label] of [['notes', 'Notes'], ['tasks', 'Checklist'], ['dashboard', 'Dashboard'], ['blank', 'Blank']]) {
      const choice = btn(label, () => { b.kind = kind; b.preview = null; render(); });
      attr(choice, 'aria-pressed', b.kind === kind); choice.disabled = state.busy; kinds.append(choice);
    }
    box.append(kinds);
    const form = el('form', undefined, 'stack');
    const label = builderField(form, 'Screen name', b.label, 64, value => { b.label = value; b.preview = null; });
    const preview = btn('Preview screen', () => {}); attr(preview, 'type', 'submit');
    preview.disabled = state.busy;
    on(form, 'submit', event => { event.preventDefault(); previewScreen(); });
    attr(label, 'required', ''); form.append(preview); box.append(form);
    box.append(el('h3', 'Design with my AI'), el('p',
      'Ask your own AI account to suggest screens. This sends a request through your PC. You review everything before adding it.', 'muted'));
    const sites = el('div', undefined, 'row');
    for (const site of Object.keys(DESIGN_SITES)) {
      const choice = btn(DESIGN_SITES[site], () => { b.site = site; render(); });
      attr(choice, 'aria-pressed', b.site === site); choice.disabled = state.busy; sites.append(choice);
    }
    box.append(sites);
    builderField(box, 'What would you like to add? (optional)', b.wish, 500, value => { b.wish = value; }, true);
    const design = btn('Design with my AI', () => designAction('start'), 'primary');
    design.disabled = state.busy || !b.designChecked || ['queued', 'asking', 'waiting-reply', 'ready-to-review'].includes(b.job?.state);
    box.append(design);
    if (!b.designChecked) {
      box.append(el('p', 'Check your saved design before starting a new request, so nothing is sent twice.', 'muted'));
      builderButton(box, 'Check design', () => readDesign());
    }
    if (b.job) {
      const job = b.job;
      const status = el('p', job.state === 'ready-to-review' ? 'Your AI has ideas ready to review.' :
        job.state === 'failed' ? (job.error?.message || 'Your AI could not finish. Nothing changed. Check the chat on your PC.') :
        job.state === 'applied' ? 'Your AI’s screens were added.' : job.state === 'discarded' ? 'Design discarded. Your app was not changed.' :
        'Waiting for your AI… You can leave this screen and come back.', 'muted');
      attr(status, 'role', 'status'); box.append(status);
      if (job.state === 'ready-to-review') renderDiff(box, job.preview);
      if (!['applied', 'discarded'].includes(job.state)) {
        if (job.state === 'ready-to-review') builderButton(box, 'Add these screens', () => designAction('approve'), 'primary');
        builderButton(box, 'Discard design', () => designAction('discard'));
        builderButton(box, 'Check design', () => readDesign());
      }
    }
    box.append(el('h3', 'Use a saved AI reply'), el('p',
      'Choose an answer already saved by VIVIM. This never sends a new message. It must contain a screen design for this app.', 'muted'));
    builderButton(box, 'Choose a saved AI reply', () => loadBuilderReplies());
    if (b.repliesLoaded && !b.replies.length) box.append(el('p', 'No finished saved replies found yet.', 'muted'));
    b.replies.forEach((reply, index) => builderButton(box,
      'Preview ' + (ASK_SITES[reply.site] ?? 'AI') + ' answer ' + (index + 1), () => previewSavedReply(reply)));
    if (b.preview) {
      renderDiff(box, b.preview);
      attr(builderButton(box, 'Add these screens', () => applyBuilderPreview(), 'primary'), 'data-builder-apply', '');
      builderButton(box, 'Discard preview', () => { b.preview = null; b.source = null; render(); });
    }
    target.append(box);
  }
  function builderButton(target, text, fn, cls) {
    const button = btn(text, fn, cls); button.disabled = state.busy; target.append(button); return button;
  }
  function builderField(target, text, value, max, change, multiline = false) {
    const label = el('label', text, 'field'), input = el(multiline ? 'textarea' : 'input', undefined, 'field-input');
    attr(input, 'maxlength', max); attr(input, 'aria-label', text); input.value = value;
    input.disabled = state.busy;
    on(input, 'input', () => { change(input.value);
      // An edited draft invalidates the old preview immediately, including its still-visible Add button.
      if (state.builder.preview === null) root.querySelectorAll?.('[data-builder-apply]').forEach(node => { node.disabled = true; });
    });
    label.append(input); target.append(label); return input;
  }
  function renderDiff(target, preview) {
    target.append(el('h3', 'Preview — not added yet'));
    const list = el('ul');
    for (const item of preview?.diff ?? []) list.append(el('li', 'Add ' + item.label + ' (' + item.kind + ')'));
    target.append(list, el('p', 'Only these screens will be added. No code runs and nothing is installed.', 'muted'));
  }
  function renderTemplates(target) {
    const box = el('section', undefined, 'card');
    box.append(el('h2', 'Make an app'), el('p', 'Choose a starter. You can add more screens later.', 'muted'));
    for (const template of state.templates) {
      const choice = builderButton(box, template.title, () => {
        state.template = template.id; state.creationKey = null; render();
      });
      attr(choice, 'aria-pressed', state.template === template.id);
    }
    builderField(box, 'App name (optional)', state.appTitle, 80, value => { state.appTitle = value; state.creationKey = null; });
    const create = builderButton(box, 'Create app', () => createTemplateApp(), 'primary');
    create.disabled = state.busy || !state.templates.length;
    target.append(box);
  }
  function builderError(result) {
    const code = result.data?.code;
    if (code === 'PERSONAL_APP_SCREEN_EXISTS') return 'A screen with that name already exists. Choose another name.';
    if (code === 'PERSONAL_APP_LIMIT') return 'This app is full. Try adding a screen to another app.';
    if (code === 'PERSONAL_APP_VERSION_CONFLICT' || result.status === 409) return 'Your app changed since this preview. Tap Refresh app, then preview again.';
    if (result.status === 401 || result.status === 403) return 'Reconnect this phone using the connection link from VIVIM on your PC.';
    if (result.status === 0 || result.status >= 500) return 'Cannot confirm this with your PC. Check your connection, then refresh before trying again.';
    return 'VIVIM could not use that design. Check the screen name or choose a different saved answer, then preview again.';
  }
  async function builderRequest(suffix, body) {
    if (!state.appId || state.busy) return null;
    const id = state.appId, ticket = requestTicket;
    state.busy = true; state.error = ''; state.notice = ''; render();
    const result = await request(MOBILE_API + '/' + id + suffix, { method: 'POST', body, timeoutMs: 20000 });
    if (ticket !== requestTicket || state.appId !== id) return null;
    state.busy = false;
    if (result.status !== 200) { state.error = builderError(result); render(); return null; }
    return result.data;
  }
  async function createTemplateApp() {
    if (state.busy) return;
    if (!state.creationKey) {
      const key = uuid();
      if (!key) { state.error = 'Your phone cannot create a safe save key. Try another browser.'; render(); return; }
      state.creationKey = 'mobile-app:' + key;
    }
    const ticket = requestTicket;
    state.busy = true; state.error = ''; render();
    const result = await request(MOBILE_API + '/from-template', { method: 'POST', timeoutMs: 20000,
      body: { template: state.template, ...(state.appTitle.trim() ? { title: state.appTitle.trim() } : {}), idempotencyKey: state.creationKey } });
    if (ticket !== requestTicket) return;
    state.busy = false;
    if (result.status === 200 && APP_ID.test(result.data?.app?.id)) {
      state.creationKey = null; state.appTitle = ''; await openApp(result.data.app.id);
    } else { state.error = builderError(result); render(); }
  }
  async function previewScreen() {
    if (!state.builder.label.trim()) return;
    const proposal = { schema: 'vivim.personal-app-change/1', appId: state.appId, baseVersion: state.version,
      operations: [{ type: 'add-screen', kind: state.builder.kind, label: state.builder.label.trim() }] };
    state.builder.preview = null;
    const data = await builderRequest('/preview-change', { proposal });
    if (data) { state.builder.preview = data; state.builder.source = null; render(); }
  }
  async function previewSavedReply(reply) {
    state.builder.preview = null;
    const data = await builderRequest('/preview-provider-reply', { conversation: reply.conversation, turnId: reply.turnId });
    if (data) { state.builder.preview = data; state.builder.source = reply; render(); }
  }
  async function applyBuilderPreview() {
    const b = state.builder, preview = b.preview;
    if (!preview || preview.appId !== state.appId || preview.baseVersion !== state.version) return;
    const body = { expectedVersion: preview.baseVersion, approval: 'user-confirmed' };
    const data = b.source ? await builderRequest('/apply-provider-reply', { ...body,
      conversation: b.source.conversation, turnId: b.source.turnId, replyDigest: preview.provenance?.replyDigest }) :
      await builderRequest('/apply-change', { ...body, proposal: preview.change });
    if (data) { b.preview = null; b.label = ''; await refreshBuilder(); state.notice = 'Your screens were added. Open them above.'; render(); }
  }
  async function refreshBuilder() {
    if (!state.appId || state.busy) return;
    const id = state.appId, ticket = requestTicket;
    state.busy = true; state.builder.preview = null; state.error = ''; render();
    const result = await request(MOBILE_API + '/' + id + '/scaffold', { timeoutMs: 20000 });
    if (ticket !== requestTicket || state.appId !== id) return;
    state.busy = false;
    try {
      if (result.status !== 200) throw new Error(builderError(result));
      state.scaffold = validateMobileScaffold(result.data, id); state.version = result.data.version;
    } catch (error) { state.error = error.message; }
    render();
  }
  function stopDesignPoll() {
    ++designReadTicket;
    if (state.builder.timer) globalThis.clearTimeout(state.builder.timer);
    state.builder.timer = null;
  }
  async function readDesign() {
    stopDesignPoll();
    if (!state.appId || state.view !== 'app' || state.active !== 'builder') return;
    const id = state.appId, ticket = requestTicket, designTicket = designReadTicket, old = state.builder.job;
    const path = old?.id ? '/ai-design/' + encodeURIComponent(old.id) : '/' + id + '/ai-design';
    const result = await request(MOBILE_API + path, { timeoutMs: 20000 });
    if (ticket !== requestTicket || state.appId !== id || designTicket !== designReadTicket) return;
    if (result.status === 200) {
      const wasChecked = state.builder.designChecked;
      state.builder.designChecked = true;
      state.builder.job = result.data?.job ?? null;
      if (!wasChecked || JSON.stringify(old) !== JSON.stringify(state.builder.job)) render();
      if (['queued', 'asking', 'waiting-reply'].includes(state.builder.job?.state) && state.active === 'builder') {
        state.builder.timer = globalThis.setTimeout(readDesign, 2500);
      }
    } else {
      state.builder.designChecked = false;
      state.error = 'Cannot check your AI design right now. Tap Check design when your PC is connected. Nothing was resent.'; render();
    }
  }
  async function designAction(action) {
    if (!state.appId || state.busy) return;
    stopDesignPoll();
    const id = state.appId, ticket = requestTicket, b = state.builder;
    if (action !== 'start' && !b.job?.id) return;
    if (action === 'start' && !b.designChecked) return;
    b.designChecked = false;
    state.busy = true; state.error = ''; render();
    const path = action === 'start' ? '/' + id + '/ai-design' : '/ai-design/' + b.job.id + '/' + action;
    const result = await request(MOBILE_API + path, { method: 'POST', timeoutMs: 20000,
      body: action === 'start' ? { site: b.site, request: b.wish } : {} });
    if (ticket !== requestTicket || state.appId !== id) return;
    state.busy = false;
    if (result.status === 200 && result.data?.job) {
      b.job = result.data.job;
      if (action === 'approve') await refreshBuilder();
    } else { state.error = builderError(result); }
    render(); await readDesign();
  }
  async function loadBuilderReplies() {
    if (state.busy) return;
    const ticket = requestTicket;
    state.busy = true; state.error = ''; render();
    const result = await request(CONVERSATIONS_API, { timeoutMs: 20000 });
    if (ticket !== requestTicket) return;
    state.busy = false;
    if (result.status === 200 && Array.isArray(result.data?.conversations)) {
      state.builder.replies = result.data.conversations.flatMap(conversation =>
        (Array.isArray(conversation.turns) ? conversation.turns : []).filter(turn => turn.reply?.state === 'ready' && typeof turn.id === 'string')
          .map(turn => ({ conversation: conversation.id, turnId: turn.id, site: conversation.site }))).slice(0, 20);
      state.builder.repliesLoaded = true;
    } else state.error = 'Cannot load saved answers. Check your PC connection and try again.';
    render();
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
    stopDesignPoll();
    askStopPolling(); state.view = 'index';
    state.scaffold = null; state.appId = null; state.content = null; state.agent = null;
    state.busy = false; state.pendingKey = null;
    state.notice = ''; state.error = ''; state.loading = true; render();
    const [result, templates] = await Promise.all([
      request(MOBILE_API, { timeoutMs: 20000 }), request(MOBILE_API + '/templates', { timeoutMs: 20000 }),
    ]);
    if (ticket !== requestTicket) return;
    state.loading = false;
    if (templates.status === 200 && Array.isArray(templates.data?.items)) state.templates = templates.data.items;
    if (result.status === 200 && Array.isArray(result.data?.items)) state.index = result.data;
    else state.error = 'Cannot load your apps from your PC. Check the connection, then tap My apps to try again.';
    render();
  }
  async function openApp(id) {
    if (!APP_ID.test(id)) {
      state.error = 'Invalid local app reference'; render(); return;
    }
    const ticket = ++requestTicket;
    stopDesignPoll();
    Object.assign(state.builder, { kind: 'notes', label: '', preview: null, source: null, job: null, designChecked: false, replies: [], repliesLoaded: false });
    askStopPolling(); state.view = 'app';
    state.loading = true; state.busy = false; state.notice = ''; state.error = ''; state.scaffold = null;
    state.appId = id; state.content = null; state.agent = null;
    state.pendingKey = null; state.draftTitle = ''; state.draftBody = ''; render();
    const result = await request(MOBILE_API + '/' + encodeURIComponent(id) + '/scaffold');
    if (ticket !== requestTicket) return;
    state.loading = false;
    try {
      if (result.status !== 200) throw new Error('Cannot open this app from your PC. Check the connection, then choose it again from My apps.');
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
      if (result.status !== 200) throw new Error('Cannot load your saved content from your PC. Check the connection, then tap Reload saved content.');
      state.content = validateMobileContent(result.data, id);
    } catch (error) { state.error = error.message; }
    render();
  }
  function chooseScreen(key) {
    if (!state.scaffold?.screens.some(screen => screen.key === key)) return;
    const priorKind = state.scaffold.screens.find(screen => screen.key === state.active)?.kind;
    state.active = key; state.error = ''; state.notice = '';
    stopDesignPoll();
    const kind = state.scaffold.screens.find(screen => screen.key === key).kind;
    if (priorKind !== kind) { state.draftTitle = ''; state.draftBody = ''; state.pendingKey = null; }
    render();
    if (kind === 'builder') readDesign();
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
      state.error = 'Couldn’t confirm your save. Your draft is still here. Check the connection, then save again; VIVIM will check the same save so it isn’t added twice.';
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
    } else state.error = 'Couldn’t confirm the task changed. Check the connection, then reload saved content before trying again.';
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
    } else state.error = 'Cannot read your Agent’s status from your PC. Check the connection, then try again.';
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
  // A comparison job is only ever trusted once its shape matches what compare-service.mjs returns.
  const compareUnwrap = (data) => {
    const job = data?.job;
    return job && typeof job.id === 'string' && COMPARE_JOB_ID.test(job.id) &&
      typeof job.state === 'string' && Array.isArray(job.results) ? job : null;
  };
  const askTurns = () => (Array.isArray(state.ask.snapshot?.turns) ? state.ask.snapshot.turns : []);
  const askFindTurn = (key) => askTurns().find(turn => turn?.key === key) ?? null;
  function askStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
  // Only what the phone needs to resume: the chat id, the messages typed here (the service never returns prompt
  // text) and the one message key still waiting for an answer.
  function saveAsk() {
    const store = askStorage(); if (!store) return;
    try {
      store.setItem(ASK_STORE, JSON.stringify({ site: state.ask.site, mode: state.ask.mode,
        conversationId: state.ask.conversationId, turns: state.ask.turns.slice(-40), pending: state.ask.pending,
        draft: state.ask.draft, compareSites: state.compare.sites, compareQuestion: state.compare.question,
        compareJobId: state.compare.job?.id ?? null }));
    } catch { /* private mode: the chat works, it just cannot resume after a refresh */ }
  }
  function restoreAsk() {
    const store = askStorage(); if (!store) return;
    try {
      const saved = JSON.parse(store.getItem(ASK_STORE) ?? 'null');
      if (!saved || typeof saved !== 'object') return;
      if (Object.hasOwn(ASK_SITES, saved.site)) state.ask.site = saved.site;
      if (saved.mode === 'several') state.ask.mode = 'several';
      state.ask.conversationId = typeof saved.conversationId === 'string' && saved.conversationId
        ? saved.conversationId : null;
      state.ask.turns = Array.isArray(saved.turns) ? saved.turns.filter(turn => turn &&
        typeof turn.key === 'string' && typeof turn.prompt === 'string').slice(-40) : [];
      state.ask.draft = typeof saved.draft === 'string' ? saved.draft : '';
      state.ask.pending = saved.pending && typeof saved.pending.key === 'string' &&
        typeof saved.pending.prompt === 'string' ? saved.pending : null;
      if (!state.ask.conversationId) state.ask.pending = null;
      if (Array.isArray(saved.compareSites)) {
        const sites = saved.compareSites.filter(site => Object.hasOwn(ASK_SITES, site));
        if (sites.length) state.compare.sites = [...new Set(sites)];
      }
      if (typeof saved.compareQuestion === 'string') state.compare.question = saved.compareQuestion;
      // Only the job id is restored; its real state is always re-read from the PC, never assumed.
      if (typeof saved.compareJobId === 'string' && COMPARE_JOB_ID.test(saved.compareJobId)) {
        state.compare.job = { id: saved.compareJobId };
      }
    } catch { /* a damaged entry is ignored and the chat starts clean */ }
  }
  function askStopPolling() {
    if (state.ask.timer) { globalThis.clearTimeout(state.ask.timer); state.ask.timer = null; }
  }
  // One waiting message at a time. A first answer can take minutes, so the request that started it may already
  // have timed out: the saved chat, never a timer, decides what happened.
  function askSchedulePoll() {
    askStopPolling();
    if (state.view !== 'ask' || !state.ask.pending || state.ask.retry || state.ask.checkAgain) return;
    state.ask.timer = globalThis.setTimeout(() => { state.ask.timer = null; askPoll(); }, ASK_POLL_MS);
  }
  function askSignature() {
    const ask = state.ask;
    return JSON.stringify({ p: ask.pending?.key ?? null, s: ask.status, e: ask.error, n: ask.notice,
      r: ask.retry, c: ask.checkAgain, b: ask.busy, connection: state.connection,
      t: askTurns().map(turn => [turn?.key, turn?.phase, turn?.send?.state, turn?.reply?.state,
        turn?.reply?.text?.length ?? 0]) });
  }
  async function askPoll() {
    const ask = state.ask, pending = ask.pending;
    if (!pending || state.view !== 'ask') return;
    const ticket = requestTicket, before = askSignature();
    pending.polls = (pending.polls ?? 0) + 1;
    const ok = await askRefresh(ticket);
    if (ticket !== requestTicket) return;
    if (state.ask.pending?.key !== pending.key) { render(); return; }
    if (!ok) {
      if (!ask.conversationId || state.connection === 'approval') {
        askStopPolling(); if (askSignature() !== before) render(); return;
      }
      pending.failures = (pending.failures ?? 0) + 1;
      if (pending.failures >= 6) {
        askStopPolling(); ask.status = ''; ask.checkAgain = true;
        ask.error = 'Can’t reach your PC right now. Check that you are on the same WiFi, then tap Check again.';
      } else askSchedulePoll();
      if (askSignature() !== before) render();
      return;
    }
    pending.failures = 0;
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
    if (result.status === 200 && snapshot && snapshot.id === ask.conversationId) {
      askApply(snapshot);
      ask.error = ''; ask.checkAgain = false;
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
      ask.retry = false; ask.checkAgain = false;
      ask.status = ''; ask.error = 'That chat is no longer on your PC. Nothing was resent. Check your AI tab on your PC before starting a new chat.';
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
    if (ask.busy || ask.reading) return 'Checking your chat…';
    if (ask.conversationId && !ask.snapshot) return 'Check your saved chat before sending another message.';
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
    try {
      if (!ask.conversationId && !await askCreate(ticket)) { ask.status = ''; return; }
      if (ticket !== requestTicket) return;
      await askPost(prompt, ticket);
    } finally {
      ask.busy = false;
      if (ticket === requestTicket) { saveAsk(); render(); }
      else if (state.view === 'ask') askLoadOnOpen();
    }
  }
  // The user's own choice after a refusal, with the same key: safe by construction, because the service replays
  // the original message instead of creating a second one.
  async function askRetry() {
    const ask = state.ask, pending = ask.pending;
    if (!pending || ask.busy || ask.reading || !ask.retry) return;
    const ticket = requestTicket;
    ask.busy = true; ask.error = ''; ask.retry = false; ask.status = 'Sending…'; render();
    const ok = await askRefresh(ticket);
    if (ticket !== requestTicket || state.ask.pending?.key !== pending.key) {
      ask.busy = false;
      if (state.view === 'ask') {
        if (ticket !== requestTicket) askLoadOnOpen(); else render();
      }
      return;
    }
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
    ask.busy = false;
    if (ticket !== requestTicket) { if (state.view === 'ask') askLoadOnOpen(); return; }
    saveAsk(); render();
  }
  async function askCheckAgain() {
    const ask = state.ask;
    if (ask.busy || ask.reading || !ask.conversationId) return;
    askStopPolling();
    const ticket = requestTicket;
    ask.busy = true; ask.error = ''; ask.checkAgain = false; ask.status = 'Checking…'; render();
    const ok = await askRefresh(ticket);
    if (ticket !== requestTicket) {
      ask.busy = false; if (state.view === 'ask') askLoadOnOpen(); return;
    }
    ask.busy = false;
    if (ok) {
      ask.status = '';
      if (ask.pending) { ask.pending.polls = 0; ask.pending.failures = 0; }
      if (ask.pending && !askFindTurn(ask.pending.key)) ask.pending.absentAfterPost = true;
      askResolve(); if (ask.pending && !ask.retry) askSchedulePoll();
    }
    else {
      ask.checkAgain = Boolean(ask.conversationId);
      if (!ask.error) ask.error = 'Can’t reach your PC right now. Check your WiFi, then tap Check again.';
    }
    saveAsk(); render();
  }
  async function askNewChat() {
    const ask = state.ask;
    if (ask.busy || ask.reading || ask.pending) return;
    const id = ask.conversationId;
    askStopPolling();
    ask.busy = true; render();
    const ticket = requestTicket;
    const result = id ? await request(CONVERSATIONS_API + '/' + encodeURIComponent(id) + '/finish',
      { method: 'POST', body: { closeTab: true }, timeoutMs: 20000 }) : null;
    if (ticket !== requestTicket) {
      ask.busy = false; if (state.view === 'ask') askLoadOnOpen(); return;
    }
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
  function askSetMode(mode) {
    if (mode !== 'single' && mode !== 'several') return;
    if (state.ask.mode === mode) return;
    state.ask.mode = mode; state.ask.error = ''; state.ask.notice = ''; saveAsk(); render();
  }
  /* ---------------- Ask several ---------------- */
  // One question, several of the user's own AI accounts, through the shared compare job on the PC
  // (src/studio/compare-service.mjs). Each answer is shown as a plain status line as it arrives; the
  // phone never talks to a provider directly and never starts a second job for the same tap.
  function compareToggleSite(site) {
    const c = state.compare;
    if (c.busy || isCompareActive(c.job) || !Object.hasOwn(ASK_SITES, site)) return;
    const picked = new Set(c.sites);
    if (picked.has(site)) picked.delete(site); else picked.add(site);
    c.sites = Object.keys(ASK_SITES).filter(key => picked.has(key));
    c.error = ''; saveAsk(); render();
  }
  function compareStopPolling() {
    if (state.compare.timer) { globalThis.clearTimeout(state.compare.timer); state.compare.timer = null; }
  }
  function compareSchedulePoll() {
    compareStopPolling();
    const c = state.compare;
    if (state.view !== 'ask' || !isCompareActive(c.job)) return;
    c.timer = globalThis.setTimeout(() => { c.timer = null; compareRefresh(); }, ASK_POLL_MS);
  }
  // Read-only: the saved comparison exactly as the PC has it now. Polling only ever re-reads this SAME
  // job id; it never posts anything, so a slow phone connection can never turn into a second question.
  async function compareRefresh() {
    const c = state.compare, jobId = c.job?.id;
    if (!jobId) return;
    const ticket = requestTicket;
    const result = await request(COMPARE_API + '/' + encodeURIComponent(jobId), { timeoutMs: 20000 });
    if (ticket !== requestTicket || state.compare.job?.id !== jobId) return;
    const job = compareUnwrap(result.data);
    if (result.status === 200 && job && job.id === jobId) {
      c.job = job; c.error = ''; saveAsk();
      if (isCompareActive(job)) compareSchedulePoll(); else compareStopPolling();
      render(); return;
    }
    if (result.status === 401 || result.status === 403) {
      compareStopPolling();
      c.error = 'Your phone’s connection needs approval again. Open the connection link from VIVIM on your PC.';
      render(); return;
    }
    if (result.status === 404) {
      compareStopPolling(); c.job = null;
      c.error = 'That comparison is no longer on your PC. Nothing was resent. Ask again.'; saveAsk(); render(); return;
    }
    // Cannot confirm anything right now: keep polling the same job, never start a new one.
    compareSchedulePoll();
  }
  // The only place a comparison is started. A stable question + site set is the user's one tap; the PC
  // itself refuses to start a second job for the same question and sites while one is still active.
  async function compareStart() {
    const c = state.compare, question = c.question.trim();
    if (!question || c.sites.length < 2 || c.busy || isCompareActive(c.job)) return;
    const ticket = requestTicket;
    c.busy = true; c.error = ''; c.notice = ''; render();
    const result = await request(COMPARE_API, { method: 'POST', timeoutMs: 20000, body: { question, sites: c.sites } });
    if (ticket !== requestTicket) return;
    c.busy = false;
    const job = compareUnwrap(result.data);
    if ((result.status === 200 || result.status === 202) && job) {
      c.job = job; c.error = ''; saveAsk(); render();
      if (isCompareActive(job)) compareSchedulePoll();
      return;
    }
    c.error = result.status === 401 || result.status === 403
      ? 'Your phone’s connection needs approval again. Open the connection link from VIVIM on your PC.'
      : result.status === 400 ? 'Choose a question and at least two AIs, then try again.'
      : 'Could not start this with your PC. Check the connection, then try again.';
    render();
  }
  async function compareCancel() {
    const c = state.compare, jobId = c.job?.id;
    if (!jobId || c.busy || !isCompareActive(c.job)) return;
    const ticket = requestTicket;
    c.busy = true; render();
    const result = await request(COMPARE_API + '/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST', timeoutMs: 20000 });
    if (ticket !== requestTicket) return;
    c.busy = false;
    const job = compareUnwrap(result.data);
    if (result.status === 200 && job && job.id === jobId) { c.job = job; compareStopPolling(); saveAsk(); }
    else c.error = 'Could not stop this comparison. Check the connection, then try again.';
    render();
  }
  function compareReset() {
    const c = state.compare;
    if (c.busy || isCompareActive(c.job)) return;
    compareStopPolling(); c.job = null; c.question = ''; c.error = ''; c.notice = ''; saveAsk(); render();
  }
  function openAsk() {
    if (state.view === 'ask') return;
    ++requestTicket;
    stopDesignPoll();
    state.view = 'ask'; state.loading = false; state.error = ''; state.notice = '';
    state.ask.error = ''; state.ask.notice = ''; state.ask.checkAgain = false; state.ask.pinBottom = true;
    render();
    if (state.ask.conversationId) askLoadOnOpen();
    if (state.compare.job?.id) compareRefresh();
  }
  async function askLoadOnOpen() {
    if (state.ask.busy || state.ask.reading) return;
    const ticket = requestTicket;
    state.ask.reading = true; render();
    const ok = await askRefresh(ticket);
    state.ask.reading = false;
    if (ticket !== requestTicket || state.view !== 'ask') {
      if (state.view === 'ask') askLoadOnOpen();
      return;
    }
    if (!ok) {
      state.ask.checkAgain = Boolean(state.ask.conversationId);
      if (!state.ask.error) state.ask.error = 'Can’t reach your PC. Check your WiFi, then tap Check again.';
      render(); return;
    }
    if (state.ask.pending) { state.ask.pending.polls = 0; state.ask.pending.failures = 0; }
    state.ask.status = '';
    askResolve();
    saveAsk(); render();
    if (state.ask.pending) askSchedulePoll();
  }
  // Connectivity events only read the PC. They never create a chat, retry a send or apply a design.
  async function recoverConnection() {
    if (state.recovering || doc.hidden) return;
    state.recovering = true; render();
    const ticket = requestTicket;
    const result = await request(MOBILE_API, { timeoutMs: 10000 });
    state.recovering = false;
    if (ticket !== requestTicket) { render(); return; }
    if (result.status === 200) {
      if (state.view === 'ask' && state.ask.conversationId && !state.ask.busy) {
        await askCheckAgain();
      } else if (state.view === 'index' && !state.busy && !state.loading) await loadIndex();
      else if (state.view === 'app' && state.active === 'builder' && !state.busy) await readDesign();
      if (state.view === 'ask' && isCompareActive(state.compare.job) && !state.compare.busy) await compareRefresh();
    }
    render();
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
    fresh.disabled = ask.busy || ask.reading || Boolean(ask.pending) || !ask.conversationId;
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
  function renderCompare(page) {
    const c = state.compare, active = isCompareActive(c.job);
    const pick = el('section', undefined, 'card');
    pick.append(el('h2', 'Ask several'), el('p',
      'Pick two or more of your AIs. Each one gets the same question, through your own account, at the same time.', 'muted'));
    const grid = el('div', undefined, 'seg');
    attr(grid, 'role', 'group'); attr(grid, 'aria-label', 'Choose which AIs to ask');
    for (const site of Object.keys(ASK_SITES)) {
      const choice = btn(ASK_SITES[site], () => compareToggleSite(site));
      attr(choice, 'aria-pressed', String(c.sites.includes(site)));
      choice.disabled = c.busy || active;
      grid.append(choice);
    }
    pick.append(grid);
    const field = el('label', 'Your question', 'field');
    attr(field, 'for', 'compareQuestion');
    const area = el('textarea', undefined, 'field-input');
    attr(area, 'id', 'compareQuestion'); attr(area, 'rows', '3'); attr(area, 'maxlength', '10000');
    attr(area, 'aria-label', 'Question for several AIs');
    attr(area, 'placeholder', 'Ask the same question to every AI you picked…');
    area.value = c.question; area.disabled = c.busy || active;
    const send = btn('Ask several', () => compareStart(), 'primary');
    send.disabled = c.busy || active || !c.question.trim() || c.sites.length < 2;
    on(area, 'input', () => { c.question = area.value; saveAsk();
      send.disabled = c.busy || active || !c.question.trim() || c.sites.length < 2; });
    field.append(area);
    pick.append(field, send);
    if (c.sites.length < 2) pick.append(el('p', 'Choose at least two AIs to compare.', 'muted'));
    if (c.error) pick.append(el('p', c.error, 'notice error'));
    if (c.notice) pick.append(el('p', c.notice, 'notice'));
    page.append(pick);

    if (!c.job) return;
    const results = el('section', undefined, 'card');
    attr(results, 'aria-live', 'polite');
    results.append(el('h2', 'Answers'));
    if (!Array.isArray(c.job.results)) {
      results.append(el('p', 'Checking your last comparison…', 'muted'));
      page.append(results); return;
    }
    if (typeof c.job.question === 'string' && c.job.question) results.append(el('p', 'Question: ' + c.job.question, 'muted'));
    for (const r of c.job.results) {
      const row = el('article', undefined, 'item');
      row.append(el('strong', ASK_SITES[r?.site] ?? String(r?.site ?? 'AI')));
      row.append(el('p', (typeof r?.message === 'string' && r.message) || (typeof r?.state === 'string' ? r.state : ''),
        r?.state === 'ready' ? 'good' : 'muted'));
      if (r?.state === 'ready') row.append(el('p', typeof r.answer === 'string' && r.answer ? r.answer : 'The answer came back empty.'));
      results.append(row);
    }
    if (active) {
      const stop = btn('Stop waiting', () => compareCancel());
      stop.disabled = c.busy; results.append(stop);
    } else {
      const again = btn('Ask again', () => compareReset());
      results.append(again);
    }
    page.append(results);
  }
  function renderAsk(page) {
    const ask = state.ask;
    const hero = el('section', undefined, 'card hero');
    hero.append(el('div', 'ASK MY AI', 'eyebrow'), el('h1', 'Ask my AI'),
      el('p', 'Runs on your PC using your own AI accounts.', 'muted'));
    const modeRow = el('div', undefined, 'seg');
    attr(modeRow, 'role', 'group'); attr(modeRow, 'aria-label', 'Ask one AI or several at once');
    for (const [key, label] of [['single', 'One AI'], ['several', 'Ask several']]) {
      const choice = btn(label, () => askSetMode(key));
      attr(choice, 'aria-pressed', String(ask.mode === key));
      modeRow.append(choice);
    }
    hero.append(modeRow);
    page.append(hero);

    if (ask.mode === 'several') { renderCompare(page); return; }

    const name = askSite();
    const siteCard = el('section', undefined, 'card');
    siteCard.append(el('h2', 'Which AI'));
    const seg = el('div', undefined, 'seg');
    attr(seg, 'role', 'group'); attr(seg, 'aria-label', 'Which AI to ask');
    for (const site of Object.keys(ASK_SITES)) {
      const choice = btn(ASK_SITES[site], () => askChooseSite(site));
      attr(choice, 'aria-pressed', String(ask.site === site));
      choice.disabled = Boolean(ask.conversationId) || ask.busy;
      seg.append(choice);
    }
    siteCard.append(seg);
    if (ask.conversationId) siteCard.append(el('p', 'Start a new chat to switch.', 'muted'));
    page.append(siteCard);

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
  const view = doc.defaultView;
  view?.addEventListener?.('online', recoverConnection);
  view?.addEventListener?.('offline', () => { state.connection = 'offline'; render(); });
  view?.addEventListener?.('pageshow', event => { if (event.persisted) recoverConnection(); });
  doc.addEventListener?.('visibilitychange', () => { if (!doc.hidden) recoverConnection(); });
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
