// Platform dashboard for the optional /api/x capabilities.
// Same-origin local Studio requests. Default local access needs no cookie; optional token mode uses one.
// Captured text is rendered with textContent and DOM nodes, never as HTML.

const state = { sessions: [], selected: '' };

const $ = (sel) => document.querySelector(sel);
const out = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}

function clear(node) { node.replaceChildren(); }

function showError(node, result) {
  clear(node);
  const status = result?.status ?? 0;
  const message = result?.data?.error ?? (status ? `HTTP ${status}` : 'request failed');
  node.append(el('p', { class: 'err', text: `${status || 0} — ${message}` }));
}

async function fetchJson(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: options.body ? { 'content-type': 'application/json' } : {},
    });
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e?.message ?? e) } };
  }
  let data = {};
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { error: 'response was not JSON' }; }
  }
  if (!data || typeof data !== 'object') data = { value: data };
  return { ok: res.ok, status: res.status, data };
}

function dl(pairs) {
  const node = el('dl', { class: 'kv' });
  for (const [key, value] of pairs) {
    node.append(el('dt', { text: key }), el('dd', { text: value == null ? '—' : String(value) }));
  }
  return node;
}

function table(headers, rows) {
  const wrap = el('div', { class: 'table-wrap' });
  const t = el('table');
  const head = el('tr');
  for (const h of headers) head.append(el('th', { text: h }));
  t.append(el('thead', {}, [head]));
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      if (cell instanceof Node) td.append(cell);
      else td.textContent = cell == null ? '' : String(cell);
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(body);
  wrap.append(t);
  return wrap;
}

function bar(value) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  return el('div', { class: 'bar' }, [el('span', { style: `width:${(pct * 100).toFixed(1)}%` })]);
}

// Snippet text with <mark> around the reported highlight spans.
function renderSnippet(detail, fallback) {
  const text = typeof detail?.text === 'string' ? detail.text : (typeof fallback === 'string' ? fallback : '');
  const node = el('div', { class: 'snippet' });
  const raw = Array.isArray(detail?.highlights) ? detail.highlights : [];
  const ranges = raw
    .filter((h) => Array.isArray(h) && h.length >= 2)
    .map((h) => [Number(h[0]), Number(h[1])])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s && s >= 0 && e <= text.length)
    .sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  let i = 0;
  while (i < ranges.length) {
    let [s, e] = ranges[i];
    let j = i + 1;
    while (j < ranges.length && ranges[j][0] <= e) { e = Math.max(e, ranges[j][1]); j += 1; }
    if (s > cursor) node.append(document.createTextNode(text.slice(cursor, s)));
    node.append(el('mark', { text: text.slice(s, e) }));
    cursor = e;
    i = j;
  }
  if (cursor < text.length) node.append(document.createTextNode(text.slice(cursor)));
  if (!text) node.append(el('span', { class: 'muted', text: '(no snippet)' }));
  return node;
}

function list(items) {
  const node = el('ul', { class: 'plain' });
  for (const item of items) {
    const li = el('li');
    if (item instanceof Node) li.append(item);
    else li.textContent = item == null ? '' : String(item);
    node.append(li);
  }
  return node;
}

// ---------------------------------------------------------------- sessions

async function loadSessions() {
  const result = await fetchJson('/api/sessions');
  const select = out('session-select');
  const previous = state.selected;
  clear(select);
  if (!result.ok || result.data?.error) {
    select.append(el('option', { value: '', text: 'sessions unavailable' }));
    state.sessions = [];
    return;
  }
  const sessions = Array.isArray(result.data) ? result.data : Array.isArray(result.data?.sessions) ? result.data.sessions : [];
  state.sessions = sessions;
  select.append(el('option', { value: '', text: 'All sessions' }));
  for (const s of sessions) {
    const id = s?.id ?? '';
    const label = s?.label ?? s?.id ?? '(unnamed)';
    const status = s?.status ? ` (${s.status})` : '';
    select.append(el('option', { value: id, text: `${label}${status}` }));
  }
  if (previous && sessions.some((s) => s?.id === previous)) select.value = previous;
  state.selected = select.value;
  syncSessionLabels();
}

function syncSessionLabels() {
  out('graph-session').textContent = state.selected ? `session: ${state.selected}` : 'select a session first';
  out('dedupe-session').textContent = state.selected ? `session: ${state.selected}` : 'select a session first';
}

// ---------------------------------------------------------------- overview

async function loadOverview() {
  const node = out('overview-out');
  const result = await fetchJson('/api/x/stats');
  const badge = out('up-state');
  if (!result.ok || result.data?.error) {
    badge.textContent = 'studio: unavailable';
    badge.className = 'badge bad';
    showError(node, result);
    return;
  }
  const stats = result.data;
  const up = stats?.schema === 'capture-studio.platform-stats/1';
  badge.textContent = up ? 'studio up' : `studio: unexpected schema (${stats?.schema ?? 'none'})`;
  badge.className = up ? 'badge ok' : 'badge warn';
  clear(node);
  const integrity = stats?.integrity ?? {};
  const knowledge = stats?.knowledge ?? {};
  node.append(dl([
    ['schema', stats?.schema],
    ['version', stats?.version],
    ['schemaVersion', stats?.schemaVersion],
    ['dataDir', stats?.dataDir],
    ['sessions', stats?.sessions],
    ['integrity checked', integrity.checked],
    ['integrity ok', integrity.ok],
    ['integrity failed', integrity.failed],
    ['knowledge sessions', knowledge.sessions],
    ['knowledge derived', knowledge.derived],
    ['knowledge failed', knowledge.failed],
    ['knowledge entities', knowledge.entities],
    ['knowledge types', knowledge.types],
  ]));
  node.append(el('h3', { text: 'Migrations' }));
  const migrations = Array.isArray(stats?.migrations) ? stats.migrations : [];
  node.append(migrations.length ? list(migrations.map((m) => (typeof m === 'object' ? JSON.stringify(m) : String(m)))) : el('p', { class: 'muted', text: 'none reported' }));
}

// ---------------------------------------------------------------- search

function hitsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.hits)) return data.hits;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

async function runSearch() {
  const node = out('search-out');
  const query = out('search-q').value.trim();
  const limit = Number(out('search-limit').value) || 20;
  if (!query) { clear(node); node.append(el('p', { class: 'muted', text: 'Enter a query.' })); return; }
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const onlySession = out('search-only-session')?.checked && state.selected;
  if (onlySession) params.set('session', state.selected);
  let result = await fetchJson(`/api/search?${params.toString()}`);
  let source = '/api/search';
  if (result.status === 404) {
    result = await fetchJson(`/api/v1/search?${params.toString()}`);
    source = '/api/v1/search';
  }
  out('search-note').textContent = `source: ${source}`;
  if (!result.ok || result.data?.error) { showError(node, result); return; }
  const hits = hitsOf(result.data);
  clear(node);
  node.append(el('p', { class: 'muted', text: `${hits.length} hit(s)` }));
  for (const hit of hits) {
    const title = el('div', { class: 'muted' });
    const bits = [hit?.layer, hit?.sid ?? hit?.ref ?? hit?.eid, hit?.seq != null ? `seq ${hit.seq}` : null,
      hit?.score != null ? `score ${hit.score}` : null, hit?.session ? `session ${hit.session}` : null].filter(Boolean);
    title.textContent = bits.join(' · ');
    const block = el('div', { class: 'hit' }, [title, renderSnippet(hit?.snippetDetail, hit?.snippet)]);
    const matched = Array.isArray(hit?.matched) ? hit.matched : [];
    const fuzzy = Array.isArray(hit?.fuzzyMatched) ? hit.fuzzyMatched : [];
    if (matched.length || fuzzy.length) {
      const terms = el('div', { class: 'muted' });
      const fuzzyTerms = fuzzy.map((f) => (f && typeof f === 'object' ? (f.to ?? f.term ?? '') : String(f))).filter(Boolean);
      terms.textContent = `matched: ${matched.join(', ') || '—'}${fuzzyTerms.length ? ` · fuzzy: ${fuzzyTerms.join(', ')}` : ''}`;
      block.append(terms);
    }
    node.append(block);
  }
  if (!hits.length) node.append(el('p', { class: 'muted', text: 'No hits.' }));
}

// ---------------------------------------------------------------- autodetect

async function runDetect() {
  const node = out('detect-out');
  const text = out('detect-text').value;
  const result = await fetchJson('/api/x/autodetect', { method: 'POST', body: JSON.stringify({ text }) });
  if (!result.ok || result.data?.error) { showError(node, result); return; }
  const data = result.data;
  clear(node);
  node.append(dl([
    ['format', data?.format],
    ['encoding', data?.encoding],
    ['hasBOM', data?.hasBOM],
    ['newline', data?.newline],
    ['delimiter', data?.delimiter],
  ]));
  node.append(el('h3', { text: 'Candidates' }));
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  if (!candidates.length) node.append(el('p', { class: 'muted', text: 'none reported' }));
  for (const c of candidates) {
    const row = el('div', { class: 'bars' });
    row.append(el('span', { text: c?.format ?? 'unknown' }));
    row.append(el('span', { class: 'muted', text: 'confidence' }));
    row.append(bar(c?.confidence));
    row.append(el('span', { text: String(c?.confidence ?? '') }));
    node.append(row);
    const evidence = Array.isArray(c?.evidence) ? c.evidence : [];
    if (evidence.length) node.append(el('pre', { text: evidence.map((e) => (typeof e === 'object' ? JSON.stringify(e) : String(e))).join('\n') }));
  }
  const scan = data?.securityScan ?? {};
  node.append(el('h3', { text: 'Security scan' }));
  const counts = scan?.counts && typeof scan.counts === 'object' ? scan.counts : {};
  const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  node.append(el('p', { text: total ? `${total} secret hit(s)` : 'no secrets detected' }));
  node.append(dl(Object.entries(counts).map(([kind, n]) => [kind, n])));
  const matches = Array.isArray(scan?.matches) ? scan.matches : [];
  if (matches.length) {
    node.append(el('h3', { text: 'Matches' }));
    node.append(table(['kind', 'offset'], matches.map((m) => [m?.kind, m?.offset])));
  }
}

// ---------------------------------------------------------------- graph

async function runGraph() {
  const node = out('graph-out');
  if (!state.selected) { clear(node); node.append(el('p', { class: 'muted', text: 'Select a session first.' })); return; }
  const result = await fetchJson(`/api/x/graph/${encodeURIComponent(state.selected)}`);
  if (!result.ok || result.data?.error) { showError(node, result); return; }
  const data = result.data;
  const stats = data?.stats ?? {};
  clear(node);
  node.append(dl([
    ['nodes', stats.nodes],
    ['edges', stats.edges],
    ['density', stats.density],
    ['components', stats.components],
    ['communities', stats.communities],
    ['largestComponent', stats.largestComponent],
    ['pagerank iterations', data?.pagerank?.iterations],
    ['pagerank converged', data?.pagerank?.converged],
    ['betweenness sampled', data?.betweenness?.sampled],
  ]));
  const rankRows = (data?.pagerank?.ranked ?? []).map((r) => [r?.id, r?.score, bar(r?.score)]);
  node.append(el('h3', { text: 'PageRank' }));
  node.append(rankRows.length ? table(['id', 'score', ''], rankRows) : el('p', { class: 'muted', text: 'none reported' }));
  const centerRows = (data?.betweenness?.ranked ?? []).map((r) => [r?.id, r?.score]);
  node.append(el('h3', { text: 'Betweenness' }));
  node.append(centerRows.length ? table(['id', 'score'], centerRows) : el('p', { class: 'muted', text: 'none reported' }));
  node.append(el('h3', { text: 'Communities' }));
  const comms = Array.isArray(data?.communities) ? data.communities : [];
  node.append(comms.length ? table(['size', 'members'], comms.map((c) => [c?.size, Array.isArray(c?.members) ? c.members.join(', ') : ''])) : el('p', { class: 'muted', text: 'none reported' }));
  node.append(el('h3', { text: 'Components' }));
  const comps = Array.isArray(data?.components) ? data.components : [];
  node.append(comps.length ? table(['size', 'members'], comps.map((c) => [c?.size, Array.isArray(c?.members) ? c.members.join(', ') : ''])) : el('p', { class: 'muted', text: 'none reported' }));
}

// ---------------------------------------------------------------- dedupe

async function runDedupe() {
  const node = out('dedupe-out');
  if (!state.selected) { clear(node); node.append(el('p', { class: 'muted', text: 'Select a session first.' })); return; }
  const max = Number(out('dedupe-max').value) || 3000;
  const result = await fetchJson(`/api/x/dedupe/${encodeURIComponent(state.selected)}?max=${max}`);
  if (!result.ok || result.data?.error) { showError(node, result); return; }
  const data = result.data;
  const stats = data?.stats ?? {};
  clear(node);
  const wasted = Number(stats?.wastedShare) || 0;
  node.append(dl([
    ['scanned', data?.scanned],
    ['items', stats.items],
    ['clusters', stats.clusters],
    ['itemsInClusters', stats.itemsInClusters],
    ['wastedShare', stats.wastedShare],
  ]));
  if (wasted > 0.1) node.append(el('p', { class: 'badge warn', text: `wastedShare ${wasted} exceeds 0.1 — duplicate-heavy session` }));
  const clusters = Array.isArray(data?.clusters) ? data.clusters : [];
  node.append(el('h3', { text: 'Clusters' }));
  node.append(clusters.length ? table(['id', 'size', 'members'], clusters.map((c) => [c?.id, c?.size, Array.isArray(c?.members) ? c.members.join(', ') : ''])) : el('p', { class: 'muted', text: 'no duplicate clusters' }));
}

// ---------------------------------------------------------------- csv

async function runCsv() {
  const node = out('csv-out');
  const text = out('csv-text').value;
  const result = await fetchJson('/api/x/csv', { method: 'POST', body: JSON.stringify({ text }) });
  if (!result.ok || result.data?.error) { showError(node, result); return; }
  const data = result.data;
  clear(node);
  const headerScore = data?.headerScore ?? {};
  node.append(dl([
    ['delimiter', data?.delimiter],
    ['rows', data?.stats?.rows],
    ['columns', data?.stats?.columns],
    ['header detected', headerScore.isHeader],
    ['header score', headerScore.score],
  ]));
  const header = Array.isArray(data?.header) ? data.header : [];
  const records = Array.isArray(data?.records) ? data.records : [];
  node.append(el('h3', { text: 'Table' }));
  const columns = header.length ? header : (records[0] ? Object.keys(records[0]) : []);
  const rows = records.map((r) => columns.map((c) => {
    if (r && typeof r === 'object') {
      const v = Array.isArray(r) ? r[columns.indexOf(c)] : r[c];
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return '';
  }));
  node.append(columns.length ? table(columns.map(String), rows) : el('p', { class: 'muted', text: 'no columns detected' }));
}

// ---------------------------------------------------------------- registry

async function runRegistry() {
  const node = out('registry-out');
  const result = await fetchJson('/api/x/registry');
  if (!result.ok || result.data?.error) { showError(node, result); return; }
  const kinds = result.data?.kinds ?? {};
  clear(node);
  const names = Object.keys(kinds);
  if (!names.length) { node.append(el('p', { class: 'muted', text: 'registry is empty' })); return; }
  for (const kind of names) {
    const entries = Array.isArray(kinds[kind]?.entries) ? kinds[kind].entries : [];
    node.append(el('h3', { text: kind }));
    node.append(entries.length
      ? table(['name', 'builtin', 'pii'], entries.map((e) => [e?.name, e?.builtin ? 'yes' : 'no', e?.pii ? 'yes' : 'no']))
      : el('p', { class: 'muted', text: 'no entries' }));
  }
}

// ---------------------------------------------------------------- bench

async function runBench() {
  const node = out('bench-out');
  const result = await fetchJson('/api/x/bench');
  if (!result.ok || result.data?.error) { showError(node, result); return; }
  clear(node);
  node.append(pre(result.data));
}

function pre(data) {
  return el('pre', { text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) });
}

// ---------------------------------------------------------------- tabs

function selectTab(name) {
  for (const button of document.querySelectorAll('#tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.id === `panel-${name}`);
  }
  if (name === 'overview') loadOverview();
  if (name === 'graph') runGraph();
  if (name === 'dedupe') runDedupe();
  if (name === 'registry') runRegistry();
}

function init() {
  for (const button of document.querySelectorAll('#tabs button')) {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
  }
  out('session-select').addEventListener('change', (event) => {
    state.selected = event.target.value;
    syncSessionLabels();
  });
  out('reload-sessions').addEventListener('click', loadSessions);
  out('load-overview').addEventListener('click', loadOverview);
  out('run-search').addEventListener('click', runSearch);
  out('run-detect').addEventListener('click', runDetect);
  out('run-graph').addEventListener('click', runGraph);
  out('run-dedupe').addEventListener('click', runDedupe);
  out('run-csv').addEventListener('click', runCsv);
  out('run-registry').addEventListener('click', runRegistry);
  out('run-bench').addEventListener('click', runBench);
  loadSessions();
  loadOverview();
}

init();
