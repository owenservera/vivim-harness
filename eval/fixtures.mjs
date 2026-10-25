// Ground-truth fixtures for measuring discovery and learning. Deterministic (seeded).
// split 'dev'      : patterns used while designing the algorithms.
// split 'heldout'  : different conventions and structures, NOT used for tuning.
import { decodeWsPayload } from '../src/decode/decoders.mjs';
import { discriminatorOf } from '../src/intel/corpus.mjs';

export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const uuid = (r) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;
const pick = (r, a) => a[Math.floor(r() * a.length)];
const WORDS = 'data model capture stream entity record field value table chart page user team plan review update report signal layer shape graph event state change system local agent browser profile'.split(' ');
const sentence = (r, n) => Array.from({ length: n }, () => pick(r, WORDS)).join(' ');
const S = (group, value, extra = {}) => ({ value, source: { kind: 'event', group, endpoint: group.split(' :: ')[0], ...extra } });

// ------------------------------------------------------------------ dev
function chatPathOps() {
  const r = rng(11); const convs = [uuid(r), uuid(r)]; const samples = []; const patchGroups = new Set(['POST host/backend/conversation :: (object)']);
  const msgs = [];
  for (let i = 0; i < 6; i++) {
    const id = uuid(r), cid = convs[i % 2], text = sentence(r, 30);
    const doc = { message: { id, author: { role: 'assistant' }, create_time: 1792500000 + i * 60, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully' }, conversation_id: cid };
    samples.push({ value: doc, source: { kind: 'assembled', group: 'POST host/backend/conversation :: (assembled)', sid: `p:${i}`, seq: i * 10, t: 1000 + i * 1000 } });
    samples.push(S('POST host/backend/conversation :: (object)', { p: '/message/content/parts/0', o: 'append', v: text.slice(0, 10) }, { sid: `p:${i}`, seq: i * 10 + 1 }));
    msgs.push({ id, text, sid: `p:${i}` });
  }
  samples.push(S('GET host/backend/conversations :: (object)', { items: convs.map((c, i) => ({ id: c, title: `Conversation about ${sentence(r, 3)}`, update_time: `2026-10-2${i}T10:00:00Z` })), total: 2, limit: 28 }, { seq: 1 }));
  samples.push(S('GET host/backend/conversations :: (object)', { items: convs.map((c, i) => ({ id: c, title: `Conversation about ${sentence(r, 3)}`, update_time: `2026-10-2${i}T11:00:00Z` })), total: 2, limit: 28 }, { seq: 2 }));
  const elements = msgs.map((m, i) => ({ id: `el-${i}`, text: `Assistant said: ${m.text} Copy Share`, firstT: 1000 + i * 1000, lastT: 1400 + i * 1000 }));
  elements.push({ id: 'el-nav', text: 'New chat Search chats Library Settings', firstT: 0, lastT: 0 });
  return {
    name: 'chat-path-ops', split: 'dev', samples, patchGroups,
    gt: {
      types: [
        { name: 'message', key: 'id', fields: { id: { type: 'string', role: 'id' }, author: { type: 'object' }, create_time: { type: 'integer', role: 'timestamp' }, content: { type: 'object' }, status: { type: 'string', role: 'category' } } },
        { name: 'conversation', key: 'id', fields: { id: { type: 'string', role: 'id' }, title: { type: 'string', role: 'title' }, update_time: { type: 'string', role: 'timestamp' } } },
        { name: 'turn', key: null, fields: { message: { type: 'object' }, conversation_id: { type: 'string', role: 'reference' } } },
      ],
      extras: [['content_type', 'parts'], ['items', 'total', 'limit']],
      relationships: [{ from: 'turn', field: 'conversation_id', to: 'conversation' }],
      rendered: msgs.map((m, i) => ({ subject: m.sid, text: m.text, element: `el-${i}` })),
    },
    elements,
  };
}

function dashboardTicks() {
  const r = rng(22); const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']; const samples = [];
  for (let n = 0; n < 60; n++) samples.push(S('WS host/ws-ticks :: tick', { type: 'tick', seq: n, symbol: syms[n % 5], price: +(100 + r() * 50).toFixed(2), ts: 1792500000000 + n * 40 }, { seq: n, t: n * 40 }));
  return {
    name: 'dashboard-ticks', split: 'dev', samples, patchGroups: new Set(),
    gt: { types: [{ name: 'tick', key: 'symbol', fields: { type: { type: 'string', role: 'category' }, seq: { type: 'integer', role: 'count' }, symbol: { type: 'string', role: 'id' }, price: { type: 'number', role: 'measure' }, ts: { type: 'integer', role: 'timestamp' } } }], relationships: [], identity: { tick: 5 } },
  };
}

function feedPages() {
  const r = rng(33); const samples = []; const all = [];
  for (let i = 0; i < 21; i++) all.push({ id: `post-${uuid(r).slice(0, 8)}`, title: `${sentence(r, 6)}`, url: `https://example.org/p/${i}`, published_at: `2026-09-${String(1 + i).padStart(2, '0')}T08:00:00Z`, author: pick(r, ['ana', 'ben', 'cy']), summary: sentence(r, 25) });
  for (let p = 0; p < 4; p++) samples.push(S('GET host/api/posts :: (object)', { page: p + 1, next: p < 3 ? p + 2 : null, results: all.slice(p * 5, p * 5 + 6) }, { seq: p, t: p * 500 }));
  return {
    name: 'feed-pages', split: 'dev', samples, patchGroups: new Set(),
    gt: { types: [{ name: 'post', key: 'id', fields: { id: { type: 'string', role: 'id' }, title: { type: 'string', role: 'title' }, url: { type: 'string', role: 'url' }, published_at: { type: 'string', role: 'timestamp' }, author: { type: 'string', role: 'category' }, summary: { type: 'string', role: 'text' } } }], extras: [['page', 'next', 'results']], relationships: [], identity: { post: 21 } },
  };
}

// ------------------------------------------------------------------ held-out
function workspaceMixed() {
  const r = rng(101); const samples = []; const patchGroups = new Set(['POST app/api/assist :: message_start', 'POST app/api/assist :: content_block_delta']);
  const conv = uuid(r);
  const msgs = [];
  for (let i = 0; i < 4; i++) {
    const text = sentence(r, 28);
    const doc = { message: { id: `msg_${hex(r, 20)}`, role: 'assistant', model: 'model-x', stop_reason: 'end_turn', conversation_uuid: conv }, blocks: { 0: { type: 'text', text } } };
    samples.push({ value: doc, source: { kind: 'assembled', group: 'POST app/api/assist :: (assembled)', sid: `a:${i}`, t: 2000 + i * 900 } });
    samples.push(S('POST app/api/assist :: content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }, { sid: `a:${i}` }));
    msgs.push({ sid: `a:${i}`, text });
  }
  const regions = ['north', 'south', 'east', 'west'];
  for (let poll = 0; poll < 5; poll++) samples.push(S('GET app/api/sheet :: (object)', { rows: regions.map((g, i) => ({ row_key: `R${i + 1}`, region: g, revenue: +(1000 + r() * 900).toFixed(2), units: Math.floor(r() * 90) + 10, updated: `2026-10-21T1${poll}:00:00Z` })) }, { seq: poll, t: poll * 300 }));
  const blocks = () => [{ kind: 'p', text: sentence(r, 20) }, { kind: 'img', src: `/media/${hex(r, 6)}.png`, alt: sentence(r, 3) }, { kind: 'code', lang: 'sql', code: 'select * from t' }, { kind: 'p', text: sentence(r, 18) }];
  samples.push(S('GET app/api/doc :: (object)', { doc: { docId: `d-${hex(r, 10)}`, title: 'Quarterly review', sections: [1, 2, 3].map((n) => ({ sec_id: `s${n}-${hex(r, 6)}`, heading: `Section ${n} ${sentence(r, 2)}`, blocks: blocks() })) } }, { seq: 1 }));
  const services = ['api', 'db', 'cache'];
  for (let n = 0; n < 18; n++) samples.push(S('GET app/api/status :: status', { type: 'status', service: services[n % 3], state: pick(r, ['ok', 'ok', 'degraded']), latency_ms: Math.floor(20 + r() * 200), at: 1792500000 + n }, { seq: n, t: n * 100 }));
  const elements = [
    ...msgs.map((m, i) => ({ id: `m-${i}`, text: m.text, firstT: 2000 + i * 900, lastT: 2500 + i * 900 })),
    { id: 'sheet', text: 'Region Revenue Units north south east west', firstT: 0, lastT: 1500 },
    { id: 'toolbar', text: 'File Edit View Share', firstT: 0, lastT: 0 },
  ];
  return {
    name: 'workspace-mixed', split: 'heldout', samples, patchGroups, elements,
    gt: {
      types: [
        { name: 'message', key: 'id', fields: { id: { type: 'string', role: 'id' }, role: { type: 'string', role: 'category' }, model: { type: 'string', role: 'category' }, stop_reason: { type: 'string', role: 'category' }, conversation_uuid: { type: 'string', role: 'reference' } } },
        { name: 'row', key: 'row_key', fields: { row_key: { type: 'string', role: 'id' }, region: { type: 'string', role: 'title' }, revenue: { type: 'number', role: 'measure' }, units: { type: 'integer', role: 'count' }, updated: { type: 'string', role: 'timestamp' } } },
        { name: 'section', key: 'sec_id', fields: { sec_id: { type: 'string', role: 'id' }, heading: { type: 'string', role: 'title' }, blocks: { type: 'array' } } },
        { name: 'block', key: null, tag: 'kind', fields: { kind: { type: 'string', role: 'category' }, text: { type: 'string', role: 'text' }, src: { type: 'string', role: 'url' }, alt: { type: 'string', role: 'title' }, lang: { type: 'string', role: 'category' }, code: { type: 'string', role: 'text' } } },
        { name: 'status', key: 'service', fields: { type: { type: 'string', role: 'category' }, service: { type: 'string', role: 'id' }, state: { type: 'string', role: 'category' }, latency_ms: { type: 'integer', role: 'measure' }, at: { type: 'integer', role: 'timestamp' } } },
      ],
      extras: [['message', 'blocks'], ['type', 'text'], ['docId', 'title', 'sections']],
      relationships: [],
      rendered: msgs.map((m, i) => ({ subject: m.sid, text: m.text, element: `m-${i}` })),
    },
  };
}

function dynamicSchema() {
  const r = rng(202); const v1 = [], v2 = [];
  for (let i = 0; i < 12; i++) v1.push({ id: `a${hex(r, 8)}`, title: sentence(r, 6), views: Math.floor(r() * 1000) });
  for (let i = 0; i < 12; i++) v2.push({ id: `a${hex(r, 8)}`, headline: sentence(r, 6), view_count: Math.floor(r() * 1000), tags: [pick(r, WORDS)] });
  return { name: 'dynamic-schema', split: 'heldout', v1, v2, gt: { repairs: { title: 'headline', views: 'view_count' } } };
}

function nestedHetero() {
  const r = rng(303); const nodes = []; let k = 0;
  const nid = () => `n${++k}-${hex(r, 4)}`;
  for (let i = 0; i < 4; i++) {
    nodes.push({ nid: nid(), kind: 'heading', level: 2, text: sentence(r, 4) });
    nodes.push({ nid: nid(), kind: 'para', text: sentence(r, 30), marks: ['bold'] });
    nodes.push({ nid: nid(), kind: 'list', items: [{ nid: nid(), kind: 'para', text: sentence(r, 8) }, { nid: nid(), kind: 'para', text: sentence(r, 8) }] });
    nodes.push({ nid: nid(), kind: 'table', cells: [['a', 'b'], ['1', '2']], caption: sentence(r, 3) });
  }
  const comments = Array.from({ length: 6 }, (_, i) => ({ cid: `c-${hex(r, 8)}`, node_ref: nodes[i * 2].nid, author: pick(r, ['ana', 'ben']), body: sentence(r, 15), created: `2026-10-0${i + 1}T09:00:00Z` }));
  const samples = [S('GET docs/api/page :: (object)', { page: { id: `pg-${hex(r, 8)}`, nodes }, comments }, { seq: 1 })];
  return {
    name: 'nested-hetero', split: 'heldout', samples, patchGroups: new Set(),
    gt: {
      types: [
        { name: 'node', key: 'nid', tag: 'kind', fields: { nid: { type: 'string', role: 'id' }, kind: { type: 'string', role: 'category' }, text: { type: 'string', role: 'text' }, level: { type: 'integer', role: 'count' }, marks: { type: 'array' }, items: { type: 'array' }, cells: { type: 'array' }, caption: { type: 'string', role: 'title' } } },
        { name: 'comment', key: 'cid', fields: { cid: { type: 'string', role: 'id' }, node_ref: { type: 'string', role: 'reference' }, author: { type: 'string', role: 'category' }, body: { type: 'string', role: 'text' }, created: { type: 'string', role: 'timestamp' } } },
      ],
      extras: [['page', 'comments'], ['id', 'nodes']],
      relationships: [{ from: 'comment', field: 'node_ref', to: 'node' }],
    },
  };
}

function multiPageWorkflow() {
  const r = rng(404); const samples = []; const steps = ['details', 'documents', 'review'].map((l, i) => ({ step_id: `st_${hex(r, 6)}`, label: l, order: i + 1 }));
  const app = `APP-${Math.floor(r() * 90000) + 10000}`;
  for (let p = 0; p < 3; p++) samples.push(S(`GET forms/api/application/{id} :: (object)`, { application: { app_no: app, status: ['draft', 'draft', 'submitted'][p], current_step: steps[p].step_id, updated_at: `2026-10-21T0${p}:00:00Z` }, steps: steps.map((s, i) => ({ ...s, state: i < p ? 'done' : i === p ? 'active' : 'todo' })) }, { seq: p, t: p * 5000 }));
  return {
    name: 'multi-page-workflow', split: 'heldout', samples, patchGroups: new Set(),
    gt: {
      types: [
        { name: 'application', key: 'app_no', fields: { app_no: { type: 'string', role: 'id' }, status: { type: 'string', role: 'category' }, current_step: { type: 'string', role: 'reference' }, updated_at: { type: 'string', role: 'timestamp' } } },
        { name: 'step', key: 'step_id', fields: { step_id: { type: 'string', role: 'id' }, label: { type: 'string', role: 'title' }, order: { type: 'integer', role: 'count' }, state: { type: 'string', role: 'category' } } },
      ],
      extras: [['application', 'steps']],
      relationships: [{ from: 'application', field: 'current_step', to: 'step' }],
    },
  };
}

function twoSitesSameEntities() {
  const r = rng(505);
  const users = Array.from({ length: 4 }, (_, i) => ({ id: 100 + i, full_name: `User ${pick(r, WORDS)} ${i}`, email: `u${i}@example.org` }));
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: 1000 + i, title: `Task ${sentence(r, 4)}`, due_date: `2026-11-${String(1 + i).padStart(2, '0')}`, assignee_id: users[i % 4].id, project_id: 7, done: i % 3 === 0 }));
  const a = [S('GET a.example/api/tasks :: [array]', tasks, { seq: 1 }), S('GET a.example/api/users :: [array]', users, { seq: 2 })];
  const owners = Array.from({ length: 3 }, (_, i) => ({ uuid: uuid(r), displayName: `Owner ${i}` }));
  const edges = Array.from({ length: 12 }, (_, i) => ({ node: { uuid: uuid(r), name: `Item ${sentence(r, 4)}`, dueAt: `2026-12-${String(1 + i).padStart(2, '0')}T00:00:00Z`, completed: i % 4 === 0, owner: owners[i % 3] } }));
  const b = [S('POST b.example/graphql :: (object)', { data: { tasks: { edges, pageInfo: { hasNextPage: false, endCursor: hex(r, 12) } } } }, { seq: 1 })];
  return {
    name: 'two-sites-same-entities', split: 'heldout', siteA: a, siteB: b,
    gt: {
      a: { types: [{ name: 'task', key: 'id', fields: { id: { type: 'integer', role: 'id' }, title: { type: 'string', role: 'title' }, due_date: { type: 'string', role: 'timestamp' }, assignee_id: { type: 'integer', role: 'reference' }, project_id: { type: 'integer', role: 'reference' }, done: { type: 'boolean', role: 'flag' } } }, { name: 'user', key: 'id', fields: { id: { type: 'integer', role: 'id' }, full_name: { type: 'string', role: 'title' }, email: { type: 'string', role: 'title' } } }], relationships: [{ from: 'task', field: 'assignee_id', to: 'user' }] },
      b: { types: [{ name: 'task', key: 'uuid', fields: { uuid: { type: 'string', role: 'id' }, name: { type: 'string', role: 'title' }, dueAt: { type: 'string', role: 'timestamp' }, completed: { type: 'boolean', role: 'flag' }, owner: { type: 'object' } } }, { name: 'owner', key: 'uuid', fields: { uuid: { type: 'string', role: 'id' }, displayName: { type: 'string', role: 'title' } } }], extras: [['node'], ['hasNextPage', 'endCursor']], relationships: [] },
      alignment: { id: 'uuid', title: 'name', due_date: 'dueAt', done: 'completed' },
    },
  };
}

function unknownFormat() {
  const r = rng(606); const samples = []; const orders = [];
  for (let i = 0; i < 6; i++) orders.push(`ORD-${Math.floor(r() * 900000) + 100000}`);
  let seq = 0;
  for (let n = 0; n < 30; n++) {
    const frame = n % 4 === 3 ? `HB|${1792500000 + n}` : `EVT|order.updated|${JSON.stringify({ order_ref: orders[n % 6], status: pick(r, ['new', 'paid', 'shipped']), total: +(r() * 300).toFixed(2), items: [{ sku: `SKU-${hex(r, 4)}`, qty: 1 + Math.floor(r() * 3), price: +(r() * 100).toFixed(2) }] })}`;
    const ev = decodeWsPayload({ opcode: 1, payload: frame });
    if (ev.json && typeof ev.json === 'object') samples.push({ value: ev.json, source: { kind: 'event', group: `WS shop/live :: ${discriminatorOf(ev)}`, seq: seq++, t: n * 50 } });
  }
  return {
    name: 'unknown-format', split: 'heldout', samples, patchGroups: new Set(),
    gt: {
      types: [
        { name: 'order', key: 'order_ref', fields: { order_ref: { type: 'string', role: 'id' }, status: { type: 'string', role: 'category' }, total: { type: 'number', role: 'measure' }, items: { type: 'array' } } },
        { name: 'item', key: null, fields: { sku: { type: 'string', role: 'id' }, qty: { type: 'integer', role: 'count' }, price: { type: 'number', role: 'measure' } } },
      ],
      relationships: [], identity: { order: 6 },
    },
  };
}

function keylessRerender() {
  const r = rng(707); const base = Array.from({ length: 8 }, () => ({ role: pick(r, ['user', 'assistant']), text: sentence(r, 24) }));
  const samples = []; const truth = [];
  let dom = 0;
  for (let pass = 0; pass < 3; pass++) base.forEach((b, i) => {
    const text = pass === 0 ? b.text.split(' ').slice(0, 20).join(' ') : pass === 1 ? b.text : b.text + ' (edited)';
    samples.push({ value: { role: b.role, text }, source: { kind: 'dom', group: 'page :: turns', domId: ++dom, t: pass * 1000 + i } });
    truth.push(i);
  });
  return { name: 'keyless-rerender', split: 'heldout', samples, patchGroups: new Set(), truth, gt: { types: [{ name: 'turn', key: null, fields: { role: { type: 'string', role: 'category' }, text: { type: 'string', role: 'text' } } }], relationships: [] } };
}

export const FIXTURES = { chatPathOps, dashboardTicks, feedPages, workspaceMixed, dynamicSchema, nestedHetero, multiPageWorkflow, twoSitesSameEntities, unknownFormat, keylessRerender };
