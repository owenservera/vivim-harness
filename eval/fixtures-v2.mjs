// Held-out v2: written before measuring, never used to tune. Adversarial by design.
// If any of these is later inspected to fix an algorithm, it must be marked "seen" in results.
import { rng } from './fixtures.mjs';

const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const pick = (r, a) => a[Math.floor(r() * a.length)];
const W = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const words = (r, n) => Array.from({ length: n }, () => pick(r, W)).join(' ');
const S = (group, value, extra = {}) => ({ value, source: { kind: 'event', group, ...extra } });

function shuffle(arr, r) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function crmContacts() {
  const r = rng(9001);
  const accounts = Array.from({ length: 5 }, (_, i) => ({ account_number: `AC-${1001 + i}`, company: `${words(r, 2)} Ltd`, industry: pick(r, ['retail', 'energy', 'media']), arr_usd: Math.floor(r() * 900000) }));
  const contacts = Array.from({ length: 14 }, (_, i) => ({ contactId: 501 + i, account: accounts[i % 5].account_number, first_name: pick(r, W), last_name: pick(r, W), title: pick(r, ['CTO', 'CFO', 'VP Sales', 'Engineer']), last_activity: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}T12:00:00Z` }));
  const samples = [S('GET crm/api/accounts :: (object)', { accounts, total: 5 }, { seq: 1, t: 10 })];
  for (let p = 0; p < 3; p++) samples.push(S('GET crm/api/contacts :: (object)', { page: p + 1, contacts: contacts.slice(p * 5, p * 5 + 6).map((c) => ({ ...c, title: r() < 0.3 ? 'Director' : c.title })) }, { seq: 2 + p, t: 20 + p }));
  return {
    name: 'v2-crm-contacts', split: 'heldout2', samples, patchGroups: new Set(),
    gt: {
      types: [
        { name: 'account', key: 'account_number', fields: { account_number: { type: 'string', role: 'id' }, company: { type: 'string', role: 'title' }, industry: { type: 'string', role: 'category' }, arr_usd: { type: 'integer', role: 'measure' } } },
        { name: 'contact', key: 'contactId', fields: { contactId: { type: 'integer', role: 'id' }, account: { type: 'string', role: 'reference' }, first_name: { type: 'string', role: 'title' }, last_name: { type: 'string', role: 'title' }, title: { type: 'string', role: 'category' }, last_activity: { type: 'string', role: 'timestamp' } } },
      ],
      extras: [['accounts', 'total'], ['page', 'contacts']],
      relationships: [{ from: 'contact', field: 'account', to: 'account' }],
      identity: { contact: 14 },
    },
  };
}

function ticketingSse() {
  const r = rng(9002);
  const tickets = Array.from({ length: 6 }, (_, i) => ({ ticketNo: `T-${70 + i}`, subject: words(r, 5), priority: pick(r, ['low', 'high', 'urgent']), status: 'open', assignee: pick(r, ['ana', 'bo', 'cy']) }));
  const samples = [];
  let seq = 0;
  for (const t of tickets) samples.push(S('GET help/stream :: ticket.created', { event: 'ticket.created', data: { ticket: t } }, { seq: seq++, t: seq * 10 }));
  for (let k = 0; k < 10; k++) { const t = tickets[k % 6]; samples.push(S('GET help/stream :: ticket.updated', { event: 'ticket.updated', data: { ticket: { ...t, status: pick(r, ['pending', 'solved']) } } }, { seq: seq++, t: seq * 10 })); }
  for (let k = 0; k < 9; k++) samples.push(S('GET help/stream :: comment.added', { event: 'comment.added', data: { comment: { commentId: `cm_${hex(r, 10)}`, ticketNo: tickets[k % 6].ticketNo, author: pick(r, ['ana', 'bo', 'customer']), text: words(r, 18) } } }, { seq: seq++, t: seq * 10 }));
  return {
    name: 'v2-ticketing-sse', split: 'heldout2', samples, patchGroups: new Set(),
    gt: {
      types: [
        { name: 'ticket', key: 'ticketNo', fields: { ticketNo: { type: 'string', role: 'id' }, subject: { type: 'string', role: 'title' }, priority: { type: 'string', role: 'category' }, status: { type: 'string', role: 'category' }, assignee: { type: 'string', role: 'category' } } },
        { name: 'comment', key: 'commentId', fields: { commentId: { type: 'string', role: 'id' }, ticketNo: { type: 'string', role: 'reference' }, author: { type: 'string', role: 'category' }, text: { type: 'string', role: 'text' } } },
      ],
      extras: [['event', 'data'], ['ticket'], ['comment']],
      relationships: [{ from: 'comment', field: 'ticketNo', to: 'ticket' }],
      identity: { ticket: 6 },
    },
  };
}

function iotTelemetry() {
  const r = rng(9003);
  const devs = ['sensor-7', 'sensor-9', 'pump-2', 'valve-11'];
  const samples = [];
  for (let n = 0; n < 80; n++) samples.push(S('WS iot/live :: (object)', { d: devs[n % 4], t: 1792600000 + n * 5, v: +(15 + r() * 15).toFixed(2), u: n % 4 === 2 ? 'bar' : 'C' }, { seq: n, t: n * 5 }));
  return {
    name: 'v2-iot-telemetry', split: 'heldout2', samples, patchGroups: new Set(),
    gt: { types: [{ name: 'reading', key: 'd', fields: { d: { type: 'string', role: 'id' }, t: { type: 'integer', role: 'timestamp' }, v: { type: 'number', role: 'measure' }, u: { type: 'string', role: 'category' } } }], relationships: [], identity: { reading: 4 } },
  };
}

function chatNearDuplicates() {
  const r = rng(9004);
  const base = [];
  for (let i = 0; i < 5; i++) base.push({ role: i % 2 ? 'assistant' : 'user', text: words(r, 20) });
  // Two different turns that start identically and differ only at the end.
  const stem = words(r, 14);
  base.push({ role: 'assistant', text: `${stem} ${words(r, 6)}` });
  base.push({ role: 'assistant', text: `${stem} ${words(r, 6)}` });
  const samples = [], truth = [];
  let dom = 0;
  for (let pass = 0; pass < 3; pass++) base.forEach((b, i) => {
    const text = pass === 0 ? b.text.split(' ').slice(0, Math.max(3, b.text.split(' ').length - 4)).join(' ') : b.text;
    samples.push({ value: { role: b.role, text }, source: { kind: 'dom', group: 'page :: turns', domId: ++dom, t: pass * 1000 + i } });
    truth.push(i);
  });
  return { name: 'v2-chat-near-duplicates', split: 'heldout2', samples, patchGroups: new Set(), truth, gt: { types: [{ name: 'turn', key: null, fields: { role: { type: 'string', role: 'category' }, text: { type: 'string', role: 'text' } } }], relationships: [] } };
}

function catalogTwoSites() {
  const r = rng(9005);
  const a = [S('GET shop-a/api/products :: [array]', Array.from({ length: 10 }, (_, i) => ({ sku: `SKU-${3000 + i}`, title: `${words(r, 3)} widget`, price_cents: Math.floor(r() * 9000) + 100, in_stock: r() > 0.3 })), { seq: 1 })];
  const b = [S('POST shop-b/graphql :: (object)', { data: { products: Array.from({ length: 10 }, (_, i) => ({ product: { code: `P${hex(r, 6).toUpperCase()}`, name: `${words(r, 3)} gadget`, pricing: { amount: +(r() * 90 + 1).toFixed(2), currency: 'EUR' }, availability: pick(r, ['in_stock', 'out_of_stock']) } })) } }, { seq: 1 })];
  return {
    name: 'v2-catalog-two-sites', split: 'heldout2', siteA: a, siteB: b,
    gt: {
      a: { types: [{ name: 'product', key: 'sku', fields: { sku: { type: 'string', role: 'id' }, title: { type: 'string', role: 'title' }, price_cents: { type: 'integer', role: 'measure' }, in_stock: { type: 'boolean', role: 'flag' } } }], relationships: [] },
      b: { types: [{ name: 'product', key: 'code', fields: { code: { type: 'string', role: 'id' }, name: { type: 'string', role: 'title' }, pricing: { type: 'object' }, availability: { type: 'string', role: 'category' } } }], extras: [['product'], ['amount', 'currency']], relationships: [] },
      alignment: { sku: 'code', title: 'name' },
    },
  };
}

function rareVariant() {
  const r = rng(9006);
  const items = [];
  for (let i = 0; i < 3000; i++) items.push({ id: `it-${i}`, type: 'line', amount: +(r() * 50).toFixed(2), label: words(r, 2) });
  items[2500] = { id: 'it-2500', type: 'adjustment', reason: words(r, 6), approved_by: 'ana', delta: -4.5 };
  items[2900] = { id: 'it-2900', type: 'adjustment', reason: words(r, 6), approved_by: 'bo', delta: 2.25 };
  return {
    name: 'v2-rare-variant', split: 'heldout2', samples: [S('GET ledger/api/items :: (object)', { items, count: items.length }, { seq: 1 })], patchGroups: new Set(),
    gt: { types: [{ name: 'item', key: 'id', tag: 'type', fields: { id: { type: 'string', role: 'id' }, type: { type: 'string', role: 'category' }, amount: { type: 'number', role: 'measure' }, label: { type: 'string', role: 'title' } } }], extras: [['items', 'count']], relationships: [], mustSeeFields: { item: ['reason', 'approved_by', 'delta'] } },
  };
}

function orderShuffled() {
  const base = crmContacts();
  return { ...base, name: 'v2-order-shuffled', samples: shuffle(base.samples, rng(77)), orderOf: 'v2-crm-contacts' };
}

function driftV2() {
  const r = rng(9008);
  const v1 = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, name: `${words(r, 3)}`, price: +(r() * 40).toFixed(2), category: pick(r, ['a', 'b']) }));
  const v2 = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, title: `${words(r, 3)}`, price: (r() * 40).toFixed(2), tags: [pick(r, W)] }));
  return { name: 'v2-drift', split: 'heldout2', v1, v2, gt: { repairs: { name: 'title' }, typeChanged: ['price'], removed: ['category', 'name'] } };
}

export const FIXTURES_V2 = { crmContacts, ticketingSse, iotTelemetry, chatNearDuplicates, catalogTwoSites, rareVariant, orderShuffled, driftV2 };
