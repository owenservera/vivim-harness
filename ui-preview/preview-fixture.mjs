/* VIVIM UI PREVIEW ONLY — synthetic records, no provider accounts, no real browser/CDP.
   Every /api/v1 request is intercepted. Mutations always fail closed. */
const CID = 'c-' + 'a'.repeat(40);
const CID2 = 'c-' + 'b'.repeat(40);
const PID = 'p-11111111-1111-4111-8111-111111111111';
const NID = 'n-22222222-2222-4222-8222-222222222222';
const OID = 'o-33333333-3333-4333-8333-333333333333';
const NOW = '2026-10-28T00:00:00.000Z';
const identity = { nativeThreadId: null, accountId: null, state: 'unknown', accountHint: 'preview data only' };
const source = { kind: 'preview-fixture', sessionId: 'preview-only', providerUrl: null };
const coverage = { state: 'partial', fullNativeThread: 'unknown', richContent: 'as-recorded', acceptance: 'not-assessed' };
const conversations = [
  { id: CID, title: 'DEMO · VIVIM integration plan', status: 'complete', sessionId: 'preview-only', identity, source, createdAt: NOW },
  { id: CID2, title: 'DEMO · Native AI research', status: 'complete', sessionId: 'preview-only', identity, source, createdAt: NOW },
];
const makeMessage = (id, index, role, text, blocks = []) => ({
  id: id + ':turn:' + index, role, text, blocks, redactions: 0, truncated: false,
  source: { kind: 'preview-fixture', sessionId: 'preview-only', key: 'PREVIEW_FIXTURE', index },
});
const details = {
  [CID]: { ...conversations[0], messages: [
    makeMessage(CID, 0, 'user', 'Describe a local-first personal AI world.'),
    makeMessage(CID, 1, 'assistant', 'VIVIM brings your saved AI conversations, local projects, notes, and knowledge relationships together. This text is demonstration data, not a provider reply.', [
      { type: 'heading', level: 2, text: 'Your AI, your world' },
      { type: 'paragraph', text: 'Keep the source evidence, explicit identity and local organization together.' },
    ]),
  ], coverage },
  [CID2]: { ...conversations[1], messages: [
    makeMessage(CID2, 0, 'user', 'How would you preserve code, tables and unknown content?'),
    makeMessage(CID2, 1, 'assistant', 'Render recorded parts without modifying the original evidence. The preview includes a synthetic code block and a synthetic table.', [
      { type: 'code', language: 'js', text: "const vivim = { data: 'local', owner: 'you' };" },
      { type: 'table', rows: [['Type', 'Handling'], ['Code', 'Preserve text'], ['Unknown', 'Keep inert']] },
    ]),
  ], coverage },
};
const projects = [
  { id: PID, kind: 'project', title: 'DEMO · VIVIM Integration', conversationIds: [CID, CID2],
    noteIds: [NID], memberIds: [OID], version: 1, savedAt: NOW },
];
const notes = [
  { id: NID, kind: 'note', title: 'DEMO · Product UX', body: 'A calm dark interface, focused navigation, source-aware AI conversations and local-first trust.',
    commentsOn: [], version: 1, savedAt: NOW },
];
const objects = [{ id: OID, kind: 'source-reference', objectType: 'conversation',
  title: 'DEMO · Source reference', conversationId: CID, source, availability: 'locally-available', version: 1 }];
const collections = { conversations, projects, notes, objects, selections: [] };
const page = (items) => ({ items, total: items.length, offset: 0, limit: 50, nextOffset: null });
const json = (code, value) => new Response(JSON.stringify(value), {
  status: code, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const recordById = (collection, id) => collection.find(x => x.id === id) ?? null;

export function previewResponse(path, method = 'GET') {
  if (typeof path !== 'string' || !path.startsWith('/api/v1/')) return null;
  // Preview is a read-only gallery — even harmless-looking REST POSTs are refused.
  if (method !== 'GET') return json(405, { code: 'PREVIEW_READ_ONLY',
    error: 'This frontend preview is read-only. No provider actions or local writes are available.' });
  if (path === '/api/v1/conversation-targets') return json(200, {
    sites: [
      { id: 'chatgpt', url: 'https://chatgpt.com' },
      { id: 'claude', url: 'https://claude.ai' },
      { id: 'gemini', url: 'https://gemini.google.com' },
    ],
    targets: [],
  });
  if (path === '/api/v1/conversations') return json(200, { conversations: [] });
  const pathname = path.split('?')[0];
  if (pathname === '/api/v1/world/namespace') return json(200, { id: 'w-preview', kind: 'namespace', schema: 'vivim.world/1' });
  for (const [kind, records] of Object.entries(collections)) {
    const base = '/api/v1/world/' + kind;
    if (pathname === base) return json(200, page(records));
    if (pathname.startsWith(base + '/')) {
      const id = decodeURIComponent(pathname.slice(base.length + 1));
      const record = kind === 'conversations' ? details[id] : recordById(records, id);
      return record ? json(200, record) : json(404, { code: 'WORLD_NOT_FOUND', error: 'Demo record missing' });
    }
  }
  if (pathname === '/api/v1/world/search') {
    const args = new URLSearchParams(path.split('?')[1] ?? '');
    const q = (args.get('q') ?? '').toLocaleLowerCase();
    const kind = args.get('kind') ?? '';
    const records = [
      ...conversations.map(c => ({ id: c.id, kind: 'message', title: c.title, snippet: 'Demo saved conversation',
        conversation: { id: c.id, title: c.title }, source: { key: 'PREVIEW_FIXTURE', index: 0 } })),
      ...projects.map(p => ({ id: p.id, kind: 'project', title: p.title, snippet: 'Demo project' })),
      ...notes.map(n => ({ id: n.id, kind: 'note', title: n.title, snippet: n.body })),
    ].filter(v => (!kind || v.kind === kind) && (!q || (v.title + ' ' + v.snippet).toLocaleLowerCase().includes(q)));
    return json(200, { ...page(records), coverage: {
      complete: false, truncated: false, reasons: ['synthetic-preview-only'], failures: [],
      absent: { conversations: 0 }, qualification: 'DEMO DATA only; no live provider or user data',
    } });
  }
  if (pathname === '/api/v1/world/map') return json(200, {
    namespaceId: 'w-preview',
    nodes: [
      { id: PID, kind: 'project', title: projects[0].title, availability: 'locally-available' },
      { id: CID, kind: 'conversation', title: conversations[0].title, availability: 'locally-available' },
      { id: CID2, kind: 'conversation', title: conversations[1].title, availability: 'locally-available' },
      { id: NID, kind: 'note', title: notes[0].title, availability: 'locally-available' },
    ],
    edges: [
      { from: PID, to: CID, kind: 'associates', evidence: { basis: 'synthetic local preview association; not native equality' } },
      { from: PID, to: CID2, kind: 'associates', evidence: { basis: 'synthetic local preview association; not native equality' } },
      { from: PID, to: NID, kind: 'associates', evidence: { basis: 'synthetic local preview association; not native equality' } },
    ],
    coverage: { complete: false, reason: 'synthetic-preview-only' },
  });
  return json(503, { code: 'PREVIEW_BACKEND_UNAVAILABLE', error: 'Local Harness backend is not connected to this preview.' });
}

const actualFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options = {}) => {
  const raw = typeof input === 'string' ? input : input?.url;
  const url = new URL(String(raw), location.href);
  if (url.pathname.startsWith('/api/v1/')) {
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    return Promise.resolve(previewResponse(url.pathname + url.search, method));
  }
  // Only static frontend assets are ever fetched from the hosting origin.
  if (url.origin !== location.origin) return Promise.resolve(json(403, { error: 'External requests disabled in UI preview.' }));
  return actualFetch(input, options);
};
