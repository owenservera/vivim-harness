// Native Personal Agent inside VIVIM World: isolated fake DOM + same-owner HTTP contract.
// No browser, CDP, real provider actions, or network. Uses the production World view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountWorldView, AGENT_API, AGENT_TRANSITIONS } from '../../src/studio/ui/world-view.mjs';

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
  const calls = [], state = { initialized: false, version: 1, memory: [], work: [], errors: [], failNextWork: false };
  const document = { createElement: tag => new Node(tag) };
  const root = new Node('main'), chat = new Node('main'), modes = new Node('nav');
  for (const view of ['capture', 'home', 'agent', 'conversations', 'settings']) {
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
    work: { total: state.work.length, byStatus: {} },
  } : { initialized: false, agentId: 'primary', nextStage: 'identity-and-sitrep' };
  const reply = (code, data) => ({ status: code, json: async () => data });
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const data = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, data });
    if (!url.startsWith(AGENT_API)) throw Error('Unexpected route: ' + url);
    const route = url.slice(AGENT_API.length);
    if (route === '/status' && method === 'GET') return reply(200, status());
    if (route === '/bootstrap' && method === 'POST') {
      if (data.expectedVersion !== (state.initialized ? state.version : null)) return reply(409, { code: 'CAS_VERSION_CONFLICT' });
      state.initialized = true; state.version++; return reply(200, status());
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
    if (route.startsWith('/work/') && route.endsWith('/transition') && method === 'POST') {
      const item = state.work.find(w => route.includes(w.id));
      if (!item) return reply(404, { code: 'PERSONAL_AGENT_WORK_NOT_FOUND' });
      if (data.expectedVersion !== state.version) return reply(409, { code: 'PERSONAL_AGENT_VERSION_CONFLICT' });
      item.status = data.to; state.version++; return reply(200, { version: state.version, item });
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
