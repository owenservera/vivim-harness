// Native Personal Agent inside VIVIM World: isolated fake DOM + same-owner HTTP contract.
// No browser, CDP, real provider actions, or network. Uses the production World view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountWorldView, AGENT_API, AGENT_TRANSITIONS, PERSONAL_APPS_API } from '../../src/studio/ui/world-view.mjs';

const html = readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8');

class Txt {
  constructor(data) { this.data = String(data); this.nodeType = 3; }
}
class Node {
  constructor(tag = 'div') {
    Object.assign(this, { tag, id: '', children: [], attrs: {}, listeners: {}, hidden: false,
      disabled: false, value: '', className: '' });
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); }
  set textContent(value) { this.children = value == null || value === '' ? [] : [new Txt(value)]; }
  get textContent() { return this.children.map(c => c?.data ?? c?.textContent ?? '').join(''); }
  async fire(name) {
    for (const handler of this.listeners[name] ?? []) await handler({ preventDefault() {} });
    // UI submit listeners schedule async effects without returning them; settle that microtask chain.
    await new Promise(resolve => setImmediate(resolve));
  }
  async click() { await this.fire('click'); }
}
function nodes(root, predicate) {
  const found = [];
  function visit(node) {
    if (!node || node instanceof Txt) return;
    if (predicate(node)) found.push(node);
    for (const child of node.children ?? []) visit(child);
  }
  visit(root); return found;
}
const byId = (node, id) => nodes(node, n => n.id === id)[0] ?? null;
const inputs = (node) => nodes(node, n => n.tag === 'input' || n.tag === 'textarea');
async function type(node, value) { node.value = value; await node.fire('input'); }

function fixture() {
  const calls = [], state = { initialized: false, version: 1, memory: [], work: [], errors: [], failNextWork: false,
    apps: [], failNextApp: false };
  const document = { createElement: tag => new Node(tag) };
  const root = new Node('main'), chat = new Node('main'), modes = new Node('nav');
  for (const view of ['capture', 'home', 'agent', 'builder', 'conversations', 'settings']) {
    const button = new Node('button');
    button.setAttribute('data-view', view); modes.append(button);
  }
  modes.querySelectorAll = () => modes.children;
  const status = () => state.initialized ? {
    initialized: true, agentId: 'primary', version: state.version, nextStage: null,
    stages: { 'identity-and-sitrep': { status: 'completed', evidence: ['local:identity'] } },
    memoryCounts: { CANON: state.memory.filter(x => x.tier === 'CANON').length,
      Immediate: state.memory.filter(x => x.tier === 'Immediate').length,
      Curated: state.memory.filter(x => x.tier === 'Curated').length },
    work: { total: state.work.length, byStatus: Object.fromEntries(
      ['queued', 'active', 'blocked', 'completed', 'cancelled'].map(status =>
        [status, state.work.filter(item => item.status === status).length])) },
  } : { initialized: false, agentId: 'primary', nextStage: 'identity-and-sitrep' };
  const reply = (code, data) => ({ status: code, json: async () => data });
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const data = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, data });
    if (url.startsWith(PERSONAL_APPS_API)) {
      const route = url.slice(PERSONAL_APPS_API.length);
      const index = () => ({ total: state.apps.length, items: state.apps.map(app => ({
        id: app.id, title: app.title, version: app.version,
        screenCount: app.screens.length, deployStatus: 'not-built', providerExecution: 'not-attempted',
      })) });
      if (route === '' && method === 'GET') return reply(200, index());
      if (route === '' && method === 'POST') {
        const previous = state.apps.find(app => app.idempotencyKey === data.idempotencyKey);
        if (previous) {
          if (previous.title !== data.title || previous.intent !== data.intent) {
            return reply(409, { code: 'PERSONAL_APP_IDEMPOTENCY_CONFLICT' });
          }
          return reply(200, { app: structuredClone(previous), replayed: true });
        }
        const app = { schema: 'vivim.personal-app/1', id: 'app-' + 'a'.repeat(32), version: 1,
          idempotencyKey: data.idempotencyKey, title: data.title, intent: data.intent,
          screens: [
            { key: 'home', label: 'Home', kind: 'home', origin: 'base-scaffold' },
            { key: 'agent', label: 'My Agent', kind: 'agent', origin: 'base-scaffold' },
            { key: 'builder', label: 'Build', kind: 'builder', origin: 'base-scaffold' },
          ] };
        state.apps.push(app);
        if (state.failNextApp) {
          state.failNextApp = false; return reply(503, { code: 'LOST_APP_RESPONSE' });
        }
        return reply(200, { app: structuredClone(app), replayed: false });
      }
      const id = route.split('/')[1];
      const app = state.apps.find(app => app.id === id);
      if (!app) return reply(404, { code: 'PERSONAL_APP_NOT_FOUND' });
      if (route === '/' + id && method === 'GET') return reply(200, structuredClone(app));
      if (route === '/' + id + '/screens' && method === 'POST') {
        if (data.expectedVersion !== app.version) return reply(409, { code: 'PERSONAL_APP_VERSION_CONFLICT' });
        const key = 'custom-' + data.label.toLowerCase().replace(/\s+/g, '-');
        if (app.screens.some(screen => screen.key === key)) return reply(409, { code: 'PERSONAL_APP_SCREEN_EXISTS' });
        app.version++;
        app.screens.push({ key, label: data.label, kind: data.kind, origin: 'explicit-user-customization' });
        return reply(200, { app: structuredClone(app) });
      }
      return reply(404, { code: 'NOT_FOUND' });
    }
    if (url.startsWith('/api/v1/world')) {
      if (url.includes('/namespace')) return reply(200, { id: 'local', kind: 'namespace' });
      return reply(200, { items: [], total: 0, limit: 50, offset: 0, nextOffset: null });
    }
    if (!url.startsWith(AGENT_API)) throw Error('Unexpected route: ' + url);
    const route = url.slice(AGENT_API.length);
    if (route === '/status' && method === 'GET') return state.failStatus ? reply(503, { code: 'LOCAL_UNAVAILABLE' }) : reply(200, status());
    if (route === '/bootstrap' && method === 'POST') {
      if (data.expectedVersion !== (state.initialized ? state.version : null)) return reply(409, { code: 'CAS_VERSION_CONFLICT' });
      state.initialized = true; state.version++; return reply(200, status());
    }
    if (route === '/capabilities' && method === 'GET') return reply(200, {
      tools: [{ name: 'local_source_reader', availability: 'registered; runtime unverified' }],
      skills: { items: [], coverage: { complete: true } },
      limitations: 'No live provider execution was attempted',
    });
    if (route === '/self-knowledge?topic=all' && method === 'GET') return reply(200, {
      schema: 'vivim.personal-agent.self-knowledge/1',
      answers: { privacy: { providerSendsDuringBootstrap: false } },
    });
    if (route === '/sitrep' && method === 'GET') {
      if (state.deferSitrep) await new Promise(resolve => { state.releaseSitrep = resolve; });
      return reply(200, {
      schema: 'vivim.personal-agent.continuity/1',
      memory: { Immediate: [{ text: 'PRIVATE_LOCAL_MEMORY' }] },
      execution: { permittedByThisPacket: false },
    });
    }
    if (route === '/work' && method === 'GET') return reply(200, { version: state.version, items: structuredClone(state.work) });
    if (route === '/work' && method === 'POST') {
      const same = state.work.find(w => w.key === data.idempotencyKey);
      if (same) return reply(200, { version: state.version, item: same, replayed: true });
      if (data.expectedVersion !== state.version) return reply(409, { code: 'PERSONAL_AGENT_VERSION_CONFLICT' });
      const item = { id: 'work-' + 'a'.repeat(32), key: data.idempotencyKey,
        title: data.title, objective: data.objective, status: 'queued', updatedAt: '2026-10-29' };
      state.work.push(item); state.version++;
      if (state.failNextWork) {
        state.failNextWork = false;
        return reply(503, { code: 'LOCAL_RESPONSE_LOST' });
      }
      return reply(200, { version: state.version, item });
    }
    if (route.startsWith('/work/') && route.endsWith('/next-action') && method === 'POST') {
      const item = state.work.find(w => route.includes(w.id));
      if (!item) return reply(404, { code: 'PERSONAL_AGENT_WORK_NOT_FOUND' });
      if (data.expectedVersion !== state.version) return reply(409, { code: 'PERSONAL_AGENT_VERSION_CONFLICT' });
      if (!['queued', 'active', 'blocked'].includes(item.status)) return reply(409, { code: 'PERSONAL_AGENT_WORK_TRANSITION' });
      if (item.status === 'blocked' && !data.nextAction) return reply(400, { code: 'PERSONAL_AGENT_WORK_INVALID' });
      const changed = (item.nextAction ?? null) !== data.nextAction;
      item.nextAction = data.nextAction;
      if (changed) state.version++;
      return reply(200, { version: state.version, item, replayed: !changed });
    }
    if (route.startsWith('/work/') && route.endsWith('/transition') && method === 'POST') {
      const item = state.work.find(w => route.includes(w.id));
      if (!item) return reply(404, { code: 'PERSONAL_AGENT_WORK_NOT_FOUND' });
      if (data.expectedVersion !== state.version) return reply(409, { code: 'PERSONAL_AGENT_VERSION_CONFLICT' });
      item.status = data.to; state.version++; return reply(200, { version: state.version, item });
    }
    if (route === '/search-memory' && method === 'POST') {
      if (state.deferMemorySearch) await new Promise(resolve => { state.releaseMemorySearch = resolve; });
      const all = state.memory.filter(row => data.tier === 'all' || row.tier === data.tier);
      const matches = all.filter(row => (row.key + ' ' + row.text).toLowerCase().includes(data.query.toLowerCase()));
      return reply(200, {
        total: matches.length, shown: Math.min(matches.length, data.limit),
        truncated: matches.length > data.limit,
        items: matches.slice(0, data.limit).map(row => ({ key: row.key, tier: row.tier, preview: row.text,
          match: row.key.includes(data.query) ? 'key' : 'text', source: 'user-authored' })),
      });
    }
    if (route.startsWith('/memory/') && method === 'GET') {
      const tier = route.split('/')[2];
      return reply(200, { version: state.version,
        entries: state.memory.filter(row => row.tier === tier).map(({ key, text }) => ({ key, text })) });
    }
    if (route.endsWith('/remove') && method === 'POST') {
      if (data.expectedVersion !== state.version) return reply(409, { code: 'PERSONAL_AGENT_VERSION_CONFLICT' });
      const [, tier, key] = route.split('/').slice(1);
      state.memory = state.memory.filter(row => row.tier !== tier || row.key !== key);
      state.version++; return reply(200, status());
    }
    if (route.startsWith('/memory/') && method === 'PUT') {
      if (data.expectedVersion !== state.version) return reply(409, { code: 'PERSONAL_AGENT_VERSION_CONFLICT' });
      const [, tier, key] = route.split('/').slice(1);
      state.memory.push({ tier, key, text: data.text }); state.version++;
      return reply(200, status());
    }
    return reply(404, { code: 'NOT_FOUND' });
  };
  const world = mountWorldView({ document, root, modes, chat, fetchImpl,
    storage: { getItem: () => null, setItem: () => {} } });
  return { state, calls, world, root, chat };
}

test('single World shell has a native Agent view; no second renderer or effect permission', () => {
  assert.match(html, /id="viewAgent" data-view="agent"/);
  assert.match(html, /id="worldShell"[^>]*hidden/);
  assert.match(html, /id="viewCapture" data-view="capture"/);
  assert.match(html, /#worldShell\[data-active-view="agent"\]/);
  assert.equal(AGENT_API, '/api/v1/personal-agent');
  assert.deepEqual(AGENT_TRANSITIONS.queued, ['active', 'blocked', 'cancelled']);
  assert.deepEqual(AGENT_TRANSITIONS.completed, []);
});

test('bootstrap and native Work/memory views use the existing local Studio service', async () => {
  const f = fixture();
  assert.equal(f.world.view(), 'capture');
  assert.equal(f.calls.length, 0, 'initial mount does not contact the agent or provider');
  await f.world.choose('agent');
  assert.equal(f.chat.hidden, true);
  assert.equal(f.root.hidden, false);
  assert.match(byId(f.root, 'worldAgentBootstrap').textContent, /not initialized/i);
  assert.equal(byId(f.root, 'worldAgentWorkForm'), null);
  await byId(f.root, 'worldAgentStart').click();
  assert.equal(f.state.initialized, true);
  assert.ok(byId(f.root, 'worldAgentWorkForm'));
  assert.ok(byId(f.root, 'worldAgentMemoryForm'));
  const boot = f.calls.find(c => c.url.endsWith('/bootstrap'));
  assert.deepEqual(boot.data, { expectedVersion: null });
  assert.equal(f.calls.every(c => c.url.startsWith(AGENT_API)), true);
  await f.world.choose('capture');
  assert.equal(f.chat.hidden, false);
  assert.equal(f.root.hidden, true);
});

test('Work queue persists user input and stable key across lost-response retry', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  const work = byId(f.root, 'worldAgentWorkForm');
  const [title, objective] = inputs(work);
  await type(title, 'Local task');
  await type(objective, 'Inspect only; do not send');
  f.state.failNextWork = true;
  await work.fire('submit');
  assert.equal(f.state.work.length, 1, 'the first request committed despite missing response');
  assert.match(byId(f.root, 'worldAgentNotice').textContent, /LOCAL_RESPONSE_LOST/);
  const retry = byId(f.root, 'worldAgentWorkForm');
  assert.equal(inputs(retry)[0].value, 'Local task', 'failed request does not erase draft');
  assert.equal(inputs(retry)[1].value, 'Inspect only; do not send');
  await retry.fire('submit');
  assert.equal(f.state.work.length, 1, 'replayed key cannot create a second Work item');
  const posts = f.calls.filter(c => c.url.endsWith('/work') && c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].data.idempotencyKey, posts[1].data.idempotencyKey);
  assert.equal(inputs(byId(f.root, 'worldAgentWorkForm'))[0].value, '');
  assert.equal(f.state.work[0].status, 'queued');
  assert.equal(f.calls.some(c => /submit_conversation_turn|conversation.ask|chatgpt/.test(c.url)), false);
});

test('memory save requires explicit input, uses CAS version, and updates tier counts', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  const form = byId(f.root, 'worldAgentMemoryForm'), [key, value] = inputs(form);
  await type(key, 'next_step');
  await type(value, 'Review locally only');
  await form.fire('submit');
  assert.equal(f.state.memory.length, 1);
  assert.deepEqual(f.state.memory[0], { tier: 'Immediate', key: 'next_step', text: 'Review locally only' });
  assert.match(byId(f.root, 'worldAgentMemory').textContent, /Immediate: 1 entries/);
  assert.equal(inputs(byId(f.root, 'worldAgentMemoryForm'))[0].value, '');
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.match(byId(f.root, 'worldAgentMemoryEntries').textContent, /Review locally only/);
  const remove = nodes(byId(f.root, 'worldAgentMemoryEntries'), n =>
    n.tag === 'button' && n.textContent === 'Remove from current memory')[0];
  await remove.click();
  assert.equal(f.state.memory.length, 0);
  assert.match(byId(f.root, 'worldAgentMemory').textContent, /Immediate: 0 entries/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/remove')).length, 1);
});

test('Work status transitions are manual and always bound to current local version', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  const form = byId(f.root, 'worldAgentWorkForm'), [title, objective] = inputs(form);
  await type(title, 'Manual Work');
  await type(objective, 'A local plan, not provider execution');
  await form.fire('submit');
  const update = nodes(byId(f.root, 'worldAgentWork'), n => n.tag === 'button' && n.textContent === 'Update Work')[0];
  await update.click();
  assert.equal(f.state.work[0].status, 'active');
  assert.equal(f.calls.filter(c => c.url.endsWith('/transition')).length, 1);
  assert.match(byId(f.root, 'worldAgentWork').textContent, /State: active/);
});

test('self-knowledge, capability discovery and private SITREP require explicit user inspection', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  assert.equal(f.calls.some(c => /capabilities|self-knowledge|sitrep/.test(c.url)), false,
    'private/read-only projections are never auto-loaded');
  await byId(f.root, 'worldAgentInspect_capabilities').click();
  assert.match(byId(f.root, 'worldAgentInsightOutput').textContent, /local_source_reader/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/capabilities')).length, 1);
  await byId(f.root, 'worldAgentInspect_knowledge').click();
  assert.match(byId(f.root, 'worldAgentInsightOutput').textContent, /providerSendsDuringBootstrap/);
  await byId(f.root, 'worldAgentInspect_continuity').click();
  assert.match(byId(f.root, 'worldAgentInsightOutput').textContent, /PRIVATE_LOCAL_MEMORY/);
  await f.world.choose('capture');
  await f.world.choose('agent');
  assert.equal(byId(f.root, 'worldAgentInsightOutput'), null,
    'private SITREP is cleared when leaving and returning to the native Agent view');
  assert.equal(f.calls.filter(c => c.url.endsWith('/sitrep')).length, 1,
    'the view must not fetch the private packet again without a new explicit request');
});

test('late private SITREP response is discarded after navigating away', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  f.state.deferSitrep = true;
  const pending = byId(f.root, 'worldAgentInspect_continuity').click();
  // The request is explicitly in flight but the user leaves the private view.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(typeof f.state.releaseSitrep, 'function');
  await f.world.choose('capture');
  f.state.deferSitrep = false;
  f.state.releaseSitrep();
  await pending;
  await f.world.choose('agent');
  assert.equal(byId(f.root, 'worldAgentInsightOutput'), null,
    'late private data may not reappear when the user returns');
  assert.equal(byId(f.root, 'worldAgentInspect_continuity').disabled, false,
    'a discarded request may not permanently lock the inspector');
});

test('native Work supports next-action editing and manual status changes with CAS', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  const form = byId(f.root, 'worldAgentWorkForm');
  const [name, objective] = inputs(form);
  await type(name, 'Plan next step');
  await type(objective, 'Capture user-authored next action locally');
  await form.fire('submit');
  const work = byId(f.root, 'worldAgentWork');
  const field = nodes(work, n => n.tag === 'textarea' && (n.attrs['aria-label'] ?? '').startsWith('Next action for'))[0];
  assert.ok(field, 'next action input is available for queued Work');
  await type(field, 'Inspect saved evidence');
  const save = nodes(work, n => n.tag === 'button' && n.textContent === 'Save next action')[0];
  assert.ok(save);
  await save.click();
  assert.equal(f.state.work[0].nextAction, 'Inspect saved evidence');
  assert.match(byId(f.root, 'worldAgentWork').textContent, /Next: Inspect saved evidence/);
  const posts = f.calls.filter(c => c.url.endsWith('/next-action'));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].data, { expectedVersion: 3, nextAction: 'Inspect saved evidence' });
  assert.equal(f.calls.some(c => /submit_conversation_turn|conversation.ask/.test(c.url)), false);
});

test('Work list filters open/closed records and progressively exposes older local tasks', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  f.state.work = Array.from({ length: 64 }, (_, i) => ({
    id: 'work-' + i.toString(16).padStart(32, '0'), title: 'Task ' + i,
    objective: 'User directed', status: i < 3 ? 'completed' : 'queued',
    nextAction: null, updatedAt: '2026-10-29',
  }));
  await f.world.choose('agent');
  const summary = () => byId(f.root, 'worldAgentWorkCoverage').textContent;
  const filter = () => byId(f.root, 'worldAgentWorkFilter');
  assert.match(summary(), /Showing 50 of 61 matching local Work items \(64 total\)/);
  assert.equal(nodes(byId(f.root, 'worldAgentWork'), n => n.tag === 'article').length, 50);
  await byId(f.root, 'worldAgentWorkMore').click();
  assert.match(summary(), /Showing 61 of 61 matching/);
  assert.equal(nodes(byId(f.root, 'worldAgentWork'), n => n.tag === 'article').length, 61);
  filter().value = 'completed'; await filter().fire('change');
  assert.match(summary(), /Showing 3 of 3 matching/);
  assert.equal(nodes(byId(f.root, 'worldAgentWork'), n => n.tag === 'article').length, 3);
  assert.equal(byId(f.root, 'worldAgentWorkMore'), null);
  filter().value = 'all'; await filter().fire('change');
  assert.match(summary(), /Showing 50 of 64 matching/);
  assert.equal(nodes(byId(f.root, 'worldAgentWork'), n => n.tag === 'article').length, 50);
});

test('Home projects only status counts; never auto-reads private Agent Work, memory or SITREP', async () => {
  const f = fixture();
  await f.world.choose('home');
  const card = byId(f.root, 'vivimAgentHomeCard');
  assert.ok(card);
  assert.match(card.textContent, /Initialize your local agent/);
  const homeRequests = f.calls.filter(c => c.url.startsWith(AGENT_API));
  assert.deepEqual(homeRequests.map(c => c.url), [AGENT_API + '/status']);
  assert.equal(homeRequests.every(c => c.method === 'GET'), true);
  // Bootstrap is an explicit action in Agent view, then Home reads ONLY status again.
  await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  f.state.work = [
    { status: 'queued' }, { status: 'active' }, { status: 'blocked' }, { status: 'completed' },
  ];
  const before = f.calls.length;
  await f.world.choose('home');
  const onlyHomeAgentRequests = f.calls.slice(before).filter(c => c.url.startsWith(AGENT_API));
  assert.deepEqual(onlyHomeAgentRequests.map(c => c.url), [AGENT_API + '/status']);
  assert.match(byId(f.root, 'vivimAgentHomeCard').textContent, /3Personal Agent/);
  assert.match(byId(f.root, 'vivimAgentHomeCard').textContent, /Open local Work/);
  assert.doesNotMatch(byId(f.root, 'vivimAgentHomeCard').textContent, /PRIVATE_LOCAL_MEMORY|Work objective/);
  await byId(f.root, 'vivimAgentHomeCard').click();
  assert.equal(f.world.view(), 'agent');
});

test('Home falls back to unknown rather than inventing Agent status when Studio is unavailable', async () => {
  const f = fixture();
  f.state.failStatus = true;
  await f.world.choose('home');
  const card = byId(f.root, 'vivimAgentHomeCard');
  assert.match(card.textContent, /Local agent status unavailable/);
  assert.doesNotMatch(card.textContent, /Agent ready locally|Bootstrap complete/);
  assert.match(card.textContent, /—Personal Agent/);
  assert.equal(f.calls.filter(c => c.url.startsWith(AGENT_API)).length, 1);
});

test('unsaved Work next-action drafts survive inspector refresh, filters and status reload', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  const form = byId(f.root, 'worldAgentWorkForm');
  const [name, objective] = inputs(form);
  await type(name, 'Draft-safe local Work');
  await type(objective, 'No autosend or autoexecute');
  await form.fire('submit');
  const actionInput = () => nodes(byId(f.root, 'worldAgentWork'),
    n => n.tag === 'textarea' && (n.attrs['aria-label'] ?? '').startsWith('Next action for'))[0];
  await type(actionInput(), 'UNSAVED_LOCAL_PLAN');
  await byId(f.root, 'worldAgentInspect_capabilities').click();
  assert.equal(actionInput().value, 'UNSAVED_LOCAL_PLAN');
  const filter = byId(f.root, 'worldAgentWorkFilter');
  filter.value = 'all'; await filter.fire('change');
  assert.equal(actionInput().value, 'UNSAVED_LOCAL_PLAN');
  await byId(f.root, 'worldAgentRefresh').click();
  assert.equal(actionInput().value, 'UNSAVED_LOCAL_PLAN');
  assert.equal(f.calls.filter(c => c.url.endsWith('/next-action')).length, 0,
    'draft is not written implicitly during any rerender');
  const save = nodes(byId(f.root, 'worldAgentWork'),
    n => n.tag === 'button' && n.textContent === 'Save next action')[0];
  await save.click();
  assert.equal(f.state.work[0].nextAction, 'UNSAVED_LOCAL_PLAN');
  assert.equal(actionInput().value, 'UNSAVED_LOCAL_PLAN');
  assert.equal(f.calls.filter(c => c.url.endsWith('/next-action')).length, 1);
});

test('native World memory search is opt-in, scoped and does not leak private query in URL', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  f.state.memory.push({ key: 'priority', text: 'PRIVATE_LOCAL_ONLY_SEARCH_MARKER', tier: 'CANON' });
  f.state.memory.push({ key: 'other', text: 'PUBLIC_TEST_NOTE', tier: 'Immediate' });
  await f.world.choose('agent');
  assert.equal(f.calls.some(c => c.url.includes('search-memory')), false,
    'entering World must not search private memory automatically');
  const form = byId(f.root, 'worldAgentMemorySearchForm');
  const query = nodes(form, node => node.tag === 'input')[0];
  const tier = nodes(form, node => node.tag === 'select')[0];
  await type(query, 'LOCAL_ONLY');
  tier.value = 'CANON'; await tier.fire('change');
  await form.fire('submit');
  const searchCalls = f.calls.filter(c => c.url.endsWith('/search-memory'));
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].method, 'POST');
  assert.deepEqual(searchCalls[0].data, { query: 'LOCAL_ONLY', tier: 'CANON', limit: 20 });
  assert.equal(searchCalls[0].url.includes('LOCAL_ONLY'), false, 'search term must stay out of URL');
  assert.match(byId(f.root, 'worldAgentMemorySearchResults').textContent, /PRIVATE_LOCAL_ONLY_SEARCH_MARKER/);
  assert.doesNotMatch(byId(f.root, 'worldAgentMemorySearchResults').textContent, /PUBLIC_TEST_NOTE/);
  assert.equal(f.calls.some(c => /chatgpt|conversation.ask|submit_conversation_turn/.test(c.url)), false);
  await f.world.choose('home');
  await f.world.choose('agent');
  assert.doesNotMatch(byId(f.root, 'worldAgentMemorySearchResults').textContent, /PRIVATE_LOCAL_ONLY_SEARCH_MARKER/);
});

test('late private memory search reply is dropped after leaving World Agent', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  f.state.memory.push({ key: 'secret', text: 'ONLY_WHEN_SEARCHED', tier: 'CANON' });
  f.state.deferMemorySearch = true;
  const form = byId(f.root, 'worldAgentMemorySearchForm');
  await type(nodes(form, node => node.tag === 'input')[0], 'ONLY_WHEN');
  const pending = form.fire('submit');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(typeof f.state.releaseMemorySearch, 'function');
  await f.world.choose('capture');
  f.state.deferMemorySearch = false;
  f.state.releaseMemorySearch();
  await pending;
  await f.world.choose('agent');
  assert.equal(byId(f.root, 'worldAgentMemorySearchResults').textContent.includes('ONLY_WHEN_SEARCHED'), false);
  assert.equal(byId(f.root, 'worldAgentMemorySearchForm').textContent.includes('ONLY_WHEN'), false);
});

test('private memory search results are invalidated after an explicit local memory change', async () => {
  const f = fixture(); await f.world.choose('agent'); await byId(f.root, 'worldAgentStart').click();
  f.state.memory.push({ key: 'old', text: 'OLD_SEARCH_RESULT', tier: 'Immediate' });
  const search = byId(f.root, 'worldAgentMemorySearchForm');
  await type(nodes(search, n => n.tag === 'input')[0], 'OLD_SEARCH');
  await search.fire('submit');
  assert.match(byId(f.root, 'worldAgentMemorySearchResults').textContent, /OLD_SEARCH_RESULT/);
  const memory = byId(f.root, 'worldAgentMemoryForm');
  const [key, text] = inputs(memory);
  await type(key, 'new_note'); await type(text, 'Replace prior work note');
  await memory.fire('submit');
  assert.equal(byId(f.root, 'worldAgentMemorySearchResults').textContent.includes('OLD_SEARCH_RESULT'), false);
  assert.equal(f.calls.filter(c => c.url.endsWith('/search-memory')).length, 1,
    'a memory mutation never silently reruns a private search');
});

test('the existing World shell exposes one native Build my VIVIM journey, no provider effect', async () => {
  assert.match(html, /id="viewBuilder" data-view="builder"/);
  const f = fixture();
  await f.world.choose('builder');
  assert.equal(f.world.view(), 'builder');
  assert.ok(byId(f.root, 'worldBuilderCreateForm'));
  assert.equal(f.calls.filter(c => c.url.startsWith(PERSONAL_APPS_API)).length, 1);
  assert.equal(f.calls.some(c => /conversation|chatgpt/.test(c.url)), false);
  const form = byId(f.root, 'worldBuilderCreateForm');
  const [name, intent] = inputs(form);
  await type(name, 'My private AI');
  await type(intent, 'I want a local-first assistant with tasks and notes');
  await form.fire('submit');
  assert.equal(f.state.apps.length, 1);
  assert.match(byId(f.root, 'worldBuilderPhone').textContent, /My Agent/);
  assert.match(byId(f.root, 'worldBuilderPhone').textContent, /Build/);
  assert.equal(f.state.apps[0].intent, 'I want a local-first assistant with tasks and notes');
  const add = byId(f.root, 'worldBuilderAddScreenForm');
  const label = inputs(add)[0];
  await type(label, 'My Tasks');
  await add.fire('submit');
  assert.equal(f.state.apps[0].version, 2);
  assert.equal(f.state.apps[0].screens[3].kind, 'notes', 'kind defaults to notes until user changes it');
  assert.match(byId(f.root, 'worldBuilderPhone').textContent, /My Tasks/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
  assert.ok(f.calls.filter(c => c.method === 'POST').every(c => c.url.startsWith(PERSONAL_APPS_API)));
});

test('lost create reply reuses original key and preserves the entered intent', async () => {
  const f = fixture(); await f.world.choose('builder');
  const form = byId(f.root, 'worldBuilderCreateForm');
  const [title, intent] = inputs(form);
  await type(title, 'Family assistant');
  await type(intent, 'Keep our shared local notes private');
  f.state.failNextApp = true;
  await form.fire('submit');
  assert.equal(f.state.apps.length, 1, 'the first request committed locally');
  assert.match(byId(f.root, 'worldBuilderNotice').textContent, /LOST_APP_RESPONSE/);
  const retry = byId(f.root, 'worldBuilderCreateForm');
  assert.equal(inputs(retry)[1].value, 'Keep our shared local notes private');
  await retry.fire('submit');
  assert.equal(f.state.apps.length, 1, 'same key must never duplicate the application');
  const posts = f.calls.filter(c => c.url === PERSONAL_APPS_API && c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].data.idempotencyKey, posts[1].data.idempotencyKey);
  assert.equal(inputs(byId(f.root, 'worldBuilderCreateForm'))[0].value, '');
});

test('builder returns a clear CAS failure without losing uncommitted screen edits', async () => {
  const f = fixture(); await f.world.choose('builder');
  const form = byId(f.root, 'worldBuilderCreateForm');
  await type(inputs(form)[0], 'My evolving app');
  await type(inputs(form)[1], 'Add screens carefully');
  await form.fire('submit');
  const add = byId(f.root, 'worldBuilderAddScreenForm');
  await type(inputs(add)[0], 'My Dashboard');
  f.state.apps[0].version = 10;
  await add.fire('submit');
  assert.match(byId(f.root, 'worldBuilderNotice').textContent, /PERSONAL_APP_VERSION_CONFLICT/);
  assert.equal(inputs(byId(f.root, 'worldBuilderAddScreenForm'))[0].value, 'My Dashboard');
  assert.equal(f.state.apps[0].screens.length, 3);
});

test('builder preview renders arbitrary user text as DOM text, not generated HTML or scripts', async () => {
  const f = fixture(); await f.world.choose('builder');
  const form = byId(f.root, 'worldBuilderCreateForm');
  await type(inputs(form)[0], '<img src=x onerror=alert(1)>');
  await type(inputs(form)[1], 'Build a simple personal assistant');
  await form.fire('submit');
  assert.match(byId(f.root, 'worldBuilderPhone').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(nodes(byId(f.root, 'worldBuilderPhone'), n => n.tag === 'img').length, 0);
  assert.equal(f.calls.some(c => /openai|claude|gemini/.test(c.url)), false);
});
