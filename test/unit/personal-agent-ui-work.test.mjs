// Standalone Personal Agent inspector behavioral contract — offline fake DOM and local HTTP.
// No Chrome, Playwright, provider sends, network, credentials or second Studio owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../../src/studio/ui/personal-agent.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../src/studio/ui/personal-agent.html', import.meta.url), 'utf8');
const workId = 'work-' + 'a'.repeat(32);

class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {};
    this.style = {}; this.value = ''; this.disabled = false; this.checked = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  set textContent(value) { this.children = [String(value ?? '')]; }
  get textContent() { return this.children.map(x => typeof x === 'string' ? x : x.textContent).join(''); }
  async fire(name) {
    for (const fn of this.listeners[name] ?? []) await fn({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
  }
}
function walk(node, pred) {
  const out = [];
  const visit = n => { if (!(n instanceof Node)) return; if (pred(n)) out.push(n);
    for (const child of n.children) visit(child); };
  visit(node); return out;
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };

function fixture() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Node(id));
    return elements.get(id);
  };
  get('workFilter').value = 'open';
  get('tier').value = 'Immediate';
  get('knowledgeTopic').value = 'all';
  const document = { getElementById: get, createElement: tag => new Node(tag), body: new Node('body') };
  const calls = [];
  const state = { version: 7, items: [
    { id: workId, title: 'Local task', objective: 'Record a next action without execution',
      status: 'queued', nextAction: null, updatedAt: '2026-10-29', events: [], evidence: [] },
    { id: 'work-' + 'b'.repeat(32), title: 'Closed local task', objective: 'Already done',
      status: 'completed', nextAction: null, updatedAt: '2026-10-29', events: [], evidence: [] },
  ], failSave: false };
  const response = (status, data) => ({ ok: status >= 200 && status < 300,
    status, json: async () => data });
  const fetch = async (url, options = {}) => {
    const pathname = url.replace('/api/v1/personal-agent', '');
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ pathname, method, body });
    if (pathname === '/status') return response(200, {
      initialized: true, version: state.version, nextStage: null,
      stages: {}, memoryCounts: { CANON: 0, Immediate: 0, Curated: 0 },
      work: { total: state.items.length, byStatus: { active: 0, blocked: 0, completed: 1 } },
    });
    if (pathname === '/search-memory' && method === 'POST') {
      return response(200, { total: 1, shown: 1, truncated: false, items: [{
        key: 'local_note', tier: body.tier === 'all' ? 'CANON' : body.tier,
        preview: 'PRIVATE_MEMORY_SEARCH_MATCH', match: 'text', source: 'user-authored',
      }] });
    }
    if (pathname === '/work' && method === 'GET') return response(200,
      { version: state.version, items: structuredClone(state.items) });
    if (pathname === '/capabilities') return response(200,
      { skills: { items: [], coverage: { complete: true } }, tools: [], limitations: 'offline only' });
    if (pathname.startsWith('/memory/') && method === 'GET') return response(200, { entries: [] });
    if (pathname === '/self-knowledge?topic=all') return response(200, { answers: {} });
    if (pathname === '/work/' + workId + '/next-action' && method === 'POST') {
      if (state.failSave) return response(409, { code: 'PERSONAL_AGENT_VERSION_CONFLICT', error: 'Refresh state' });
      if (body.expectedVersion !== state.version) return response(409, { code: 'PERSONAL_AGENT_VERSION_CONFLICT' });
      state.items[0].nextAction = body.nextAction;
      state.version++;
      return response(200, { item: structuredClone(state.items[0]), version: state.version });
    }
    throw new Error('Unexpected local route ' + method + ' ' + pathname);
  };
  runInNewContext(script, {
    document, fetch, crypto: { randomUUID: () => 'testuuid' },
    window: { confirm: () => true }, URLSearchParams,
    console, setTimeout, clearTimeout,
  }, { timeout: 1500 });
  const nextField = () => walk(get('workList'), n =>
    n.tag === 'textarea' && n.attrs['aria-label']?.startsWith('Next action for'))[0];
  const savePlan = () => walk(get('workList'), n =>
    n.tag === 'button' && n.textContent === 'Save next action')[0];
  return { get, state, calls, nextField, savePlan };
}

test('standalone inspector exposes user-readable status filters and optional planning', async () => {
  assert.match(html, /id="workFilter"/);
  assert.match(html, /id="workCoverage"/);
  assert.doesNotMatch(html, /<iframe/);
  const f = fixture(); await settle();
  assert.ok(f.nextField(), 'open Work has a next-action editor');
  assert.match(f.get('workCoverage').textContent, /Showing 1 of 2 locally saved/);
  f.get('workFilter').value = 'completed';
  await f.get('workFilter').fire('change');
  assert.equal(f.nextField(), undefined, 'completed Work cannot be modified');
  assert.match(f.get('workCoverage').textContent, /Showing 1 of 2 locally saved/);
  f.get('workFilter').value = 'all'; await f.get('workFilter').fire('change');
  assert.ok(f.nextField(), 'open Work is visible in All mode');
  assert.match(f.get('workCoverage').textContent, /Showing 2 of 2 locally saved/);
});

test('standalone Work plan writes only when explicitly saved; failures preserve draft', async () => {
  const f = fixture(); await settle();
  let field = f.nextField();
  field.value = 'Inspect local source receipts';
  await field.fire('input');
  await f.get('workFilter').fire('change');
  assert.equal(f.nextField().value, 'Inspect local source receipts');
  assert.equal(f.calls.some(call => call.pathname.endsWith('/next-action')), false);
  f.state.failSave = true;
  await f.savePlan().fire('click');
  assert.equal(f.state.items[0].nextAction, null);
  assert.equal(f.nextField().value, 'Inspect local source receipts');
  assert.match(f.get('notice').textContent, /PERSONAL_AGENT_VERSION_CONFLICT/);
  f.state.failSave = false;
  await f.savePlan().fire('click');
  assert.equal(f.state.items[0].nextAction, 'Inspect local source receipts');
  assert.equal(f.calls.filter(call => call.pathname.endsWith('/next-action')).length, 2);
  assert.match(f.get('notice').textContent, /Nothing was executed/);
  assert.equal(f.calls.some(call => /conversation.ask|submit_conversation_turn|chatgpt/.test(call.pathname)), false);
});

test('standalone private memory search is explicit, local-only, and avoids query-string leaks', async () => {
  assert.match(html, /id="memorySearchForm"/);
  assert.match(html, /id="memorySearchResults"/);
  const f = fixture(); await settle();
  assert.equal(f.calls.some(c => c.pathname.includes('search-memory')), false);
  f.get('memorySearchQuery').value = 'PRIVATE';
  f.get('memorySearchTier').value = 'CANON';
  await f.get('memorySearchForm').fire('submit');
  assert.equal(f.calls.filter(c => c.pathname.includes('search-memory')).length, 1);
  const call = f.calls.find(c => c.pathname.includes('search-memory'));
  assert.equal(call.pathname, '/search-memory');
  assert.equal(call.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(call.body)),
    { query: 'PRIVATE', tier: 'CANON', limit: 20 });
  assert.match(f.get('memorySearchResults').textContent, /PRIVATE_MEMORY_SEARCH_MATCH/);
  assert.equal(f.calls.some(c => /chatgpt|conversation\.ask/.test(c.pathname)), false);
});
