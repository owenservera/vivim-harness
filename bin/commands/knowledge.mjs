// knowledge status|sites|types|entities|entity|graph|at|hypotheses|search|query|continuity
import { existsSync } from 'node:fs';
import { Session } from '../../src/store/session.mjs';
import { TemporalGraph } from '../../src/intel/graph.mjs';
import { buildSiteContinuity, siteFromSession, originFromSession } from '../../src/intel/continuity.mjs';
import { formatRows, DATASET_FORMATS } from '../../src/export/export.mjs';
import { schemaForType } from '../../src/export/schemas.mjs';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, notFound, CliError, truncate, oneLine, fmtAgo, fmtPct } from '../lib/ui.mjs';
import { needArg, knowledgeState, siteLabel, parseAt, sessionStartT } from '../lib/util.mjs';
import { parseQuery, matches, attrSummary } from '../lib/query.mjs';
import { capability } from '../lib/capabilities.mjs';

defineGroup('knowledge', {
  summary: 'Query the discovered data model, entities, graph and cross-session continuity', section: 'Knowledge', default: 'status',
  description: 'The knowledge layer is derived from raw captures: discovered types, keyed entities with revision history, a temporal evidence graph and correlation hypotheses. Everything is recomputable with "studio derive". Aliases: kb.',
  aliases: ['kb'], subAliases: { model: 'types', ls: 'entities' },
});

const scopeFlags = {
  session: { type: 'list', alias: 's', valueName: 'ID,…', desc: 'Sessions to search (default: newest sessions)' },
  site: { type: 'string', valueName: 'TEXT', desc: 'Only sessions whose site/URL contains TEXT' },
  sessions: { type: 'number', valueName: 'N', default: 20, desc: 'How many newest sessions to scan when --session is not given' },
};
const tableFlags = {
  limit: { type: 'number', alias: 'n', valueName: 'N', default: 50, desc: 'Show at most N rows' },
  format: { type: 'string', alias: 'f', choices: DATASET_FORMATS, desc: 'Print rows as jsonl|json|csv|tsv|md|html on stdout instead of a table' },
  fields: { type: 'list', valueName: 'A,B.C', desc: 'Columns for --format' },
};

function scopeSessions(ctx) {
  const f = ctx.flags;
  if (f.session?.length) return f.session.map((r) => ctx.session(r));
  let list = ctx.listSessions();
  if (f.site) { const q = f.site.toLowerCase(); list = list.filter((s) => `${siteLabel(s)} ${s.target?.url ?? ''}`.toLowerCase().includes(q)); }
  if (!list.length) throw notFound(f.site ? `No sessions for "${f.site}".` : 'No sessions recorded yet.');
  return list.slice(0, f.sessions ?? 20).map((m) => Session.open(ctx.paths.sessions, m.id));
}

async function* entitiesOf(session) {
  const ds = session.dataset('entities');
  if (!existsSync(ds.file)) return;
  for await (const e of ds.iterate()) yield e;
}

// Single-session commands: knowledge must be derived and healthy.
async function knowledgeOf(ctx, ref) {
  const s = ctx.session(ref);
  if (!s.kv.get('MODEL', null)) await ctx.ensureDerived(s, { need: 'MODEL' });
  const model = s.kv.get('MODEL', null);
  if (!model) throw notFound(`No knowledge for ${s.id}.`, `Run "studio derive ${s.id}".`);
  if (model.error) throw new CliError(`Knowledge derivation failed for ${s.id} at stage ${model.stage ?? '?'}: ${model.error}`, { exit: 4, code: 'KNOWLEDGE_FAILED', hint: `Re-run "studio derive ${s.id}"; raw is intact.` });
  return { s, model, graph: s.kv.get('GRAPH', null), hypotheses: s.kv.get('HYPOTHESES', null), status: s.kv.get('KNOWLEDGE_STATUS', null) };
}

// Print rows as a table, or machine formats. Under --json the result is a JSON document.
async function showRows(ctx, name, rows, columns, extra = {}) {
  const f = ctx.flags;
  if (f.format && !ctx.out.json) { ctx.out.raw(await formatRows(rows, f.format, { fields: f.fields, title: name })); return; }
  ctx.out.emit({ ...extra, count: rows.length, rows }, (o) => o.table(rows, columns, { empty: `No ${name}.` }));
}

// ---------------------------------------------------------------------------------------------
define({
  name: 'knowledge status', section: 'Knowledge', usage: '[id|latest]', summary: 'Knowledge derivation state — for one session, or all of them',
  flags: { site: { type: 'string', valueName: 'TEXT', desc: 'Only sessions of this site (all-sessions view)' }, limit: { type: 'number', alias: 'n', valueName: 'N', desc: 'Limit the all-sessions view' } },
  async run(ctx) {
    if (ctx.args[0]) {
      const s = ctx.session(ctx.args[0]);
      const st = s.kv.get('KNOWLEDGE_STATUS', null);
      const model = s.kv.get('MODEL', null);
      const data = { session: s.id, state: knowledgeState(s), status: st, types: model?.types?.length ?? null, relationships: model?.relationships?.length ?? null, error: model?.error ?? null, stage: model?.stage ?? null };
      ctx.out.emit(data, (o) => {
        o.heading(s.id);
        o.kv([['state', data.state], ['started', st?.startedAt], ['completed', st?.completedAt], ['types', data.types], ['entities', st?.entityCount], ['error', data.error ? `${data.error} (stage ${data.stage})` : ''], ['note', data.state === 'legacy-unverified' ? 'Derived by an older version without an outcome marker; run "studio derive" to verify.' : data.state === 'none' ? `Not derived. Run "studio derive ${s.id}".` : '']]);
      });
      return;
    }
    let list = ctx.listSessions();
    if (ctx.flags.site) { const q = ctx.flags.site.toLowerCase(); list = list.filter((s) => `${siteLabel(s)} ${s.target?.url ?? ''}`.toLowerCase().includes(q)); }
    if (ctx.flags.limit) list = list.slice(0, ctx.flags.limit);
    const rows = list.map((m) => {
      const s = Session.open(ctx.paths.sessions, m.id);
      const st = s.kv.get('KNOWLEDGE_STATUS', null);
      return { session: m.id, site: siteLabel(m), state: knowledgeState(s), types: s.kv.get('MODEL', null)?.types?.length ?? null, entities: st?.entityCount ?? null, completedAt: st?.completedAt ?? null, stage: st?.stage ?? null };
    });
    const tally = {}; for (const r of rows) tally[r.state] = (tally[r.state] ?? 0) + 1;
    ctx.out.emit({ total: rows.length, byState: tally, sessions: rows }, (o) => {
      o.table(rows, [{ title: 'SESSION', key: 'session', max: 44 }, { title: 'SITE', key: 'site', max: 26 }, { title: 'STATE', key: 'state' }, { title: 'TYPES', get: (r) => r.types ?? '-', align: 'right' }, { title: 'ENTITIES', get: (r) => r.entities ?? '-', align: 'right' }, { title: 'WHEN', get: (r) => (r.completedAt ? fmtAgo(r.completedAt) : '-') }], { empty: 'No sessions yet.' });
      o.line(o.c.dim(`Summary: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}. Rebuild missing with "studio derive --missing".`));
    });
  },
});

define({
  name: 'knowledge sites', section: 'Knowledge', summary: 'Sites and origins you have captured, with session and knowledge counts',
  async run(ctx) {
    const by = new Map();
    for (const m of ctx.listSessions()) {
      const site = siteFromSession(m) || '(unknown)';
      const e = by.get(site) ?? { site, origins: new Set(), sessions: 0, derived: 0, newest: m.createdAt };
      e.sessions++; const origin = originFromSession(m); if (origin) e.origins.add(origin);
      if (knowledgeState(Session.open(ctx.paths.sessions, m.id)) === 'complete') e.derived++;
      by.set(site, e);
    }
    const rows = [...by.values()].map((e) => ({ ...e, origins: [...e.origins] })).sort((a, b) => b.sessions - a.sessions);
    ctx.out.emit(rows, (o) => o.table(rows, [{ title: 'SITE', key: 'site' }, { title: 'SESSIONS', key: 'sessions', align: 'right' }, { title: 'KNOWLEDGE', get: (r) => `${r.derived}/${r.sessions}`, align: 'right' }, { title: 'LATEST', get: (r) => fmtAgo(r.newest) }, { title: 'ORIGINS', get: (r) => r.origins.join(' '), max: 60 }], { empty: 'No sessions yet.' }));
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'knowledge types', section: 'Knowledge', aliases: ['model'], usage: '[id|latest]', summary: 'The discovered data model: types, keys, fields, relationships',
  flags: { fields: { type: 'boolean', desc: 'List every field with its inferred role' } },
  async run(ctx) {
    const { s, model } = await knowledgeOf(ctx, ctx.args[0]);
    const counts = {};
    for await (const e of entitiesOf(s)) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const types = model.types.map((t) => ({ id: t.id, name: t.name, key: t.key ? { field: t.key.field, weak: !!t.key.weak } : null, support: t.support, confidence: t.confidence, entities: counts[t.id] ?? 0, fields: (t.fields ?? []).map((x) => ({ name: x.name, type: x.type, role: x.role, roleConfidence: x.roleConfidence })) }));
    const byKind = {}; for (const r of model.relationships ?? []) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const dropped = Object.values(model.corpus?.dropped ?? {}).reduce((a, b) => a + b, 0);
    ctx.out.emit({ session: s.id, types, relationships: model.relationships ?? [], relationshipCounts: byKind, unmodelled: model.unmodelled?.length ?? 0, corpusDropped: dropped }, (o) => {
      o.result(`Model for ${s.id}: ${types.length} type(s), ${(model.relationships ?? []).length} relationship(s)`);
      o.table(types, [{ title: 'TYPE', key: 'name', max: 30 }, { title: 'KEY', get: (t) => (t.key ? `${t.key.field}${t.key.weak ? ' (weak)' : ''}` : '(keyless)'), max: 26 }, { title: 'SUPPORT', key: 'support', align: 'right' }, { title: 'CONF', get: (t) => fmtPct(t.confidence), align: 'right' }, { title: 'ENTITIES', key: 'entities', align: 'right' }], { indent: 2 });
      if (ctx.flags.fields) for (const t of types) { o.line(''); o.heading(`${t.name}`); o.table(t.fields, [{ title: 'FIELD', key: 'name', max: 36 }, { title: 'TYPE', key: 'type' }, { title: 'ROLE', key: 'role' }, { title: 'CONF', get: (x) => (x.roleConfidence === undefined ? '' : fmtPct(x.roleConfidence)), align: 'right' }], { indent: 2 }); }
      if (Object.keys(byKind).length) o.line(`  relationships: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      if (model.unmodelled?.length) o.line(`  unmodelled groups: ${model.unmodelled.length}`);
      if (dropped) o.line(`  corpus thinning: ${dropped} observation(s) not used for discovery (raw and events keep them)`);
    });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'knowledge entities', section: 'Knowledge', usage: '[id|latest] [--type T] [--key K]', summary: 'List keyed entities of one session',
  flags: {
    type: { type: 'string', alias: 't', valueName: 'NAME', desc: 'Only entities of this type (name or id)' },
    key: { type: 'string', valueName: 'VALUE', desc: 'Only entities with this key value' },
    grep: { type: 'string', valueName: 'TEXT', desc: 'Only entities containing TEXT' },
    sort: { type: 'string', choices: ['observations', 'first', 'last', 'type'], default: 'observations', desc: 'Sort order' },
    ...tableFlags,
  },
  async run(ctx) {
    const { s } = await knowledgeOf(ctx, ctx.args[0]);
    const f = ctx.flags;
    const needle = f.grep?.toLowerCase();
    let rows = [];
    for await (const e of entitiesOf(s)) {
      if (f.type && ![e.typeName, e.type].some((x) => String(x).toLowerCase() === f.type.toLowerCase())) continue;
      if (f.key !== undefined && String(e.key) !== f.key) continue;
      if (needle && !JSON.stringify([e.eid, e.typeName, e.key, e.attrs]).toLowerCase().includes(needle)) continue;
      rows.push(e);
    }
    const order = { observations: (a, b) => (b.observations ?? 0) - (a.observations ?? 0), first: (a, b) => (a.first ?? 0) - (b.first ?? 0), last: (a, b) => (b.last ?? 0) - (a.last ?? 0), type: (a, b) => String(a.typeName).localeCompare(String(b.typeName)) };
    rows.sort(order[f.sort]);
    const total = rows.length;
    rows = rows.slice(0, f.limit).map(({ revisions, ...e }) => ({ ...e, revisions: Array.isArray(revisions) ? revisions.length : 0 }));
    await showRows(ctx, 'entities', rows, [{ title: 'EID', key: 'eid', max: 24 }, { title: 'TYPE', key: 'typeName', max: 22 }, { title: 'KEY', get: (e) => e.key ?? '', max: 28 }, { title: 'OBS', key: 'observations', align: 'right' }, { title: 'REV', key: 'revisions', align: 'right' }, { title: 'ATTRIBUTES', get: (e) => attrSummary(e.attrs), max: 70 }], { session: s.id, total });
    if (total > rows.length && !ctx.out.json && !f.format) ctx.out.line(ctx.out.c.dim(`${total - rows.length} more (use --limit).`));
  },
});

define({
  name: 'knowledge entity', section: 'Knowledge', usage: '<id|latest> <eid>', summary: 'One entity: current state, revision history, graph neighbors, cross-session history',
  flags: { across: { type: 'boolean', desc: 'Also join this entity across saved sessions of the same origin (exact-key identities only)' }, history: { type: 'number', valueName: 'N', default: 20, desc: 'Show at most N revisions' } },
  async run(ctx) {
    if (!ctx.args.length) needArg(ctx, 0, 'entity id', 'studio knowledge entity latest e_abc123');
    // "entity <eid>" uses the latest session; "entity <session> <eid>" names one.
    const [a0, a1] = ctx.args;
    const { s, graph } = await knowledgeOf(ctx, a1 === undefined ? undefined : a0);
    const want = a1 ?? a0;
    const all = []; for await (const e of entitiesOf(s)) all.push(e);
    const exact = all.filter((e) => e.eid === want);
    const hits = exact.length ? exact : all.filter((e) => String(e.eid).startsWith(want) || (e.key !== null && e.key !== undefined && String(e.key) === want));
    if (!hits.length) throw notFound(`No entity "${want}" in ${s.id}.`, `List some with "studio knowledge entities ${s.id}".`);
    if (hits.length > 1) throw usageError(`"${want}" matches ${hits.length} entities: ${hits.slice(0, 6).map((e) => e.eid).join(', ')}${hits.length > 6 ? ', …' : ''}.`, 'Use a longer prefix.');
    const e = hits[0];
    const neighbors = (graph?.edges ?? []).filter((x) => x.from === e.eid || x.to === e.eid).map(({ evidence, statusHistory, ...x }) => x);
    let across = null;
    if (ctx.flags.across) {
      const site = siteFromSession(s.meta), origin = originFromSession(s.meta);
      if (!site || !origin) throw new CliError('This session has no verified target origin; cross-session history is unavailable.', { exit: 2, code: 'NO_ORIGIN' });
      const view = await buildSiteContinuity(ctx.paths.sessions, { site, origin, eid: e.eid, limit: 5, includeHistory: true });
      across = view.entities[0] ?? null;
    }
    ctx.out.emit({ session: s.id, entity: e, neighbors, across }, (o) => {
      o.heading(`${e.typeName ?? e.type}  ${e.eid}`);
      o.kv([['key', e.key], ['scope', e.scope], ['identity', e.method ? `${e.method}${e.confidence !== undefined ? ` (${fmtPct(e.confidence)})` : ''}` : ''], ['observations', e.observations], ['first', e.first ? new Date(e.first).toISOString() : ''], ['last', e.last ? new Date(e.last).toISOString() : '']]);
      o.line(''); o.heading('Attributes');
      for (const [k, v] of Object.entries(e.attrs ?? {})) o.line(`  ${o.c.dim(k)}  ${truncate(oneLine(typeof v === 'string' ? v : JSON.stringify(v)), 160)}`);
      const revs = (e.revisions ?? []).slice(-ctx.flags.history);
      if (revs.length) {
        o.line(''); o.heading(`Revisions (${revs.length} of ${(e.revisions ?? []).length})`);
        for (const r of revs) o.line(`  ${r.t ? new Date(r.t).toISOString() : '(untimed)'}  changed ${(r.changed ?? Object.keys(r.values ?? {})).join(', ') || '-'}${r.removed?.length ? `  removed ${r.removed.join(', ')}` : ''}${r.sid ? `  [${r.sid}${r.seq !== undefined && r.seq !== null ? `#${r.seq}` : ''}]` : r.domId ? `  [dom ${r.domId}]` : ''}`);
      }
      if (neighbors.length) { o.line(''); o.heading('Graph neighbors'); o.table(neighbors, [{ title: 'KIND', key: 'kind' }, { title: 'FROM', key: 'from', max: 26 }, { title: 'TO', key: 'to', max: 26 }, { title: 'CONF', get: (x) => fmtPct(x.confidence), align: 'right' }, { title: 'STATUS', key: 'status' }], { indent: 2 }); }
      if (ctx.flags.across) { o.line(''); o.heading('Across sessions'); o.line(across ? `  ${across.sessionCount} session(s), ${across.revisions} revision(s), basis ${across.identityBasis}` : '  not found in other sessions'); }
    });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'knowledge graph', section: 'Knowledge', usage: '[id|latest] [--node EID]', summary: 'Temporal evidence graph: statistics, edges, neighbors',
  flags: {
    node: { type: 'string', valueName: 'EID', desc: 'Only edges touching this node' },
    kind: { type: 'string', valueName: 'KIND', desc: 'Only edges of this kind' },
    status: { type: 'string', choices: ['hypothesis', 'confirmed', 'rejected'], desc: 'Only edges with this status' },
    'min-confidence': { type: 'number', valueName: '0-1', desc: 'Only edges at or above this confidence' },
    ...tableFlags,
  },
  async run(ctx) {
    const { s, graph } = await knowledgeOf(ctx, ctx.args[0]);
    if (!graph) throw notFound(`No graph for ${s.id}.`, `Run "studio derive ${s.id}".`);
    const f = ctx.flags;
    let edges = graph.edges ?? [];
    if (f.node) edges = edges.filter((e) => e.from === f.node || e.to === f.node || e.from.startsWith(f.node) || e.to.startsWith(f.node));
    if (f.kind) edges = edges.filter((e) => e.kind === f.kind);
    if (f.status) edges = edges.filter((e) => e.status === f.status);
    if (f['min-confidence'] !== undefined) edges = edges.filter((e) => e.confidence >= f['min-confidence']);
    edges = [...edges].sort((a, b) => b.confidence - a.confidence);
    const total = edges.length;
    const rows = edges.slice(0, f.limit).map(({ evidence, statusHistory, ...e }) => e);
    if (!f.format && !ctx.out.json) {
      const st = graph.stats ?? {};
      ctx.out.result(`Graph for ${s.id}: ${st.nodes ?? graph.nodes?.length ?? 0} nodes, ${st.edges ?? graph.edges?.length ?? 0} edges, ${st.changes ?? 0} revisions. By kind: ${Object.entries(st.byKind ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}. By status: ${Object.entries(st.byStatus ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}.`);
    }
    await showRows(ctx, 'edges', rows, [{ title: 'KIND', key: 'kind' }, { title: 'FROM', key: 'from', max: 30 }, { title: 'TO', key: 'to', max: 30 }, { title: 'CONF', get: (e) => fmtPct(e.confidence), align: 'right' }, { title: 'STATUS', key: 'status' }], { session: s.id, total, stats: graph.stats });
    if (total > rows.length && !ctx.out.json && !f.format) ctx.out.line(ctx.out.c.dim(`${total - rows.length} more (use --limit, --kind, --min-confidence).`));
  },
});

define({
  name: 'knowledge at', section: 'Knowledge', usage: '[id|latest] --t TIME', summary: 'Entity and edge state at a moment in the session (graph time travel)',
  flags: { t: { type: 'string', valueName: 'TIME', desc: 'ISO date, epoch ms or +SECONDS from the start' }, ...tableFlags },
  async run(ctx) {
    const { s, graph } = await knowledgeOf(ctx, ctx.args[0]);
    if (!graph) throw notFound(`No graph for ${s.id}.`);
    if (!ctx.flags.t) throw usageError('--t is required.', 'Example: studio knowledge at latest --t +12.5');
    const t = parseAt(ctx.flags.t, await sessionStartT(s));
    const g = new TemporalGraph();
    for (const n of graph.nodes ?? []) g.nodes.set(n.eid, n);
    for (const e of graph.edges ?? []) g.edges.set(e.id, e);
    const st = g.stateAt(t);
    const rows = st.nodes.slice(0, ctx.flags.limit).map((n) => ({ ...n, attributes: attrSummary(n.attrs) }));
    if (!ctx.flags.format && !ctx.out.json) ctx.out.result(`State at ${new Date(t).toISOString()}: ${st.nodes.length} entities, ${st.edges.length} edges.`);
    await showRows(ctx, 'entities at that time', rows, [{ title: 'EID', key: 'eid', max: 24 }, { title: 'TYPE', key: 'typeName', max: 22 }, { title: 'KEY', get: (n) => n.key ?? '', max: 24 }, { title: 'REV', key: 'revision', align: 'right' }, { title: 'ATTRIBUTES', key: 'attributes', max: 70 }], { session: s.id, t, edges: st.edges.length, nodesTotal: st.nodes.length });
  },
});

define({
  name: 'knowledge hypotheses', section: 'Knowledge', usage: '[id|latest]', summary: 'Correlation hypotheses: rendered-as and action-to-stream links',
  flags: { kind: { type: 'string', choices: ['rendered', 'actions'], desc: 'Only this family of hypotheses' }, status: { type: 'string', valueName: 'STATUS', desc: 'Only this status (likely, confirmed, rejected, …)' }, 'min-score': { type: 'number', valueName: '0-1', desc: 'Only scores at or above this' }, ...tableFlags },
  async run(ctx) {
    const { s, hypotheses } = await knowledgeOf(ctx, ctx.args[0]);
    if (!hypotheses) throw notFound(`No hypotheses for ${s.id}.`);
    const f = ctx.flags;
    const ref = (x) => (x ? x.entity ?? (x.stream ? `stream:${x.stream}` : x.actionSeq !== undefined ? `action:${x.actionSeq}` : x.sid ? `stream:${x.sid}` : x.element !== undefined ? `dom:${x.element}` : JSON.stringify(x)) : '');
    let rows = [
      ...(f.kind === 'actions' ? [] : (hypotheses.rendered ?? []).map((h) => ({ family: 'rendered', from: ref(h.from), to: ref(h.to), score: h.score, status: h.status, t: h.t ?? null }))),
      ...(f.kind === 'rendered' ? [] : (hypotheses.actions ?? []).map((h) => ({ family: 'actions', from: ref(h.from), to: ref(h.to), score: h.score, status: h.status, relation: h.relation, t: h.t ?? null }))),
    ];
    if (f.status) rows = rows.filter((r) => r.status === f.status);
    if (f['min-score'] !== undefined) rows = rows.filter((r) => r.score >= f['min-score']);
    rows.sort((a, b) => b.score - a.score);
    const total = rows.length;
    rows = rows.slice(0, f.limit);
    await showRows(ctx, 'hypotheses', rows, [{ title: 'FAMILY', key: 'family' }, { title: 'FROM', key: 'from', max: 30 }, { title: 'TO', key: 'to', max: 30 }, { title: 'SCORE', get: (r) => (r.score === undefined ? '' : r.score.toFixed(2)), align: 'right' }, { title: 'STATUS', key: 'status' }], { session: s.id, total, caps: hypotheses.caps });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'knowledge query', section: 'Knowledge', usage: '<term…>', summary: 'Filter entities across sessions: type=Message role=assistant text~hello observations>3',
  description: 'Terms are ANDed. Operators: = (exact, a|b alternatives), != , ~ (contains), >, >=, <, <=, field? (exists); a bare word matches anywhere in the entity. Fields: type, eid, key, scope, method, observations, revisions, confidence, first, last, or any attribute (attrs.role or just role).',
  flags: { ...scopeFlags, ...tableFlags },
  examples: ['studio knowledge query type=Message role=assistant', 'studio kb query "title~release notes" --site example.com --format csv', 'studio kb query observations>5 --json'],
  async run(ctx) {
    if (!ctx.args.length) throw usageError('Give at least one term.', 'Example: studio knowledge query type=Message text~hello');
    const terms = parseQuery(ctx.args);
    const rows = []; let scanned = 0, total = 0;
    for (const s of scopeSessions(ctx)) {
      for await (const e of entitiesOf(s)) {
        total++;
        if (!matches(e, terms)) continue;
        if (rows.length < ctx.flags.limit) { const { revisions, ...rest } = e; rows.push({ session: s.id, ...rest, revisions: Array.isArray(revisions) ? revisions.length : 0 }); }
        scanned++;
      }
    }
    await showRows(ctx, 'matching entities', rows, [{ title: 'SESSION', get: (r) => r.session.slice(0, 22) }, { title: 'EID', key: 'eid', max: 22 }, { title: 'TYPE', key: 'typeName', max: 20 }, { title: 'KEY', get: (r) => r.key ?? '', max: 24 }, { title: 'OBS', key: 'observations', align: 'right' }, { title: 'ATTRIBUTES', get: (r) => attrSummary(r.attrs), max: 60 }], { matched: scanned, scannedEntities: total });
    if (!ctx.out.json && !ctx.flags.format && scanned > rows.length) ctx.out.line(ctx.out.c.dim(`${scanned - rows.length} more match (use --limit).`));
  },
});

define({
  name: 'knowledge search', section: 'Knowledge', aliases: ['search'], usage: '<text…>', summary: 'Ranked search over the derived session corpus',
  flags: { ...scopeFlags, layers: { type: 'list', valueName: 'LIST', desc: 'Where to look: entities, events (L2 decoded), dom (L3 rendered). Default all' }, limit: { type: 'number', alias: 'n', valueName: 'N', default: 50, desc: 'Show at most N hits' }, format: tableFlags.format, fields: tableFlags.fields },
  examples: ['studio search "refund policy"', 'studio search invoice --site example.com --layers entities,dom --json'],
  async run(ctx) {
    const q = ctx.args.join(' ').trim();
    if (!q) throw usageError('Nothing to search for.', 'Example: studio search "release notes" --site example.com');
    if (!Number.isInteger(ctx.flags.limit) || ctx.flags.limit < 1) throw usageError('--limit must be a positive integer.');
    const layers = ctx.flags.layers ? new Set(ctx.flags.layers) : null;
    for (const l of layers ?? []) if (!['entities', 'events', 'dom'].includes(l)) throw usageError(`Unknown layer "${l}" (entities, events, dom).`);
    const { searchSession } = await capability('../../src/replay/derive-all.mjs', ['searchSession'], 'Ranked session search');
    const hits = [];
    const sessions = scopeSessions(ctx);
    for (const s of sessions) {
      const result = await searchSession(s, q, { limit: ctx.flags.limit * (layers ? 4 : 1) });
      const rows = Array.isArray(result) ? result : result.hits ?? result.results ?? result.rows ?? [];
      for (const h of rows) {
        const source = h.source ?? h.document?.source ?? {};
        const rawLayer = h.layer ?? source.layer ?? source.kind ?? (source.domId !== undefined ? 'dom' : source.eid ? 'entities' : 'events');
        const layer = ({ L2: 'events', L3: 'dom', entity: 'entities', event: 'events' })[rawLayer] ?? rawLayer;
        if (layers && !layers.has(layer)) continue;
        hits.push({ ...h, session: s.id, layer, ref: h.ref ?? h.eid ?? source.eid ?? source.sid ?? h.id, snippet: oneLine(h.snippet ?? h.text ?? '') });
      }
    }
    hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const shown = hits.slice(0, ctx.flags.limit);
    await showRows(ctx, 'matches', shown, [{ title: 'SESSION', get: (h) => h.session.slice(0, 22) }, { title: 'SCORE', key: 'score', align: 'right' }, { title: 'LAYER', key: 'layer' }, { title: 'REF', key: 'ref', max: 34 }, { title: 'MATCH', key: 'snippet', max: 90 }], { query: q, sessionsScanned: sessions.length, returnedHits: hits.length, layerFiltering: layers ? 'Applied after per-session ranked retrieval; increase --limit for more candidates.' : undefined });
    if (!hits.length && !ctx.out.json && !ctx.flags.format) process.exitCode = 1;
  },
});

define({
  name: 'knowledge schema', section: 'Knowledge', usage: '<type> [--session ID] [--json-schema]',
  summary: 'Inspect an observed type schema, optionally as portable JSON Schema',
  flags: {
    session: { type: 'string', alias: 's', valueName: 'ID', desc: 'Session reference (default latest)' },
    'json-schema': { type: 'boolean', desc: 'Print a draft-2020-12 JSON Schema document' },
  },
  examples: ['studio kb schema Message --session latest', 'studio kb schema Message --json-schema'],
  async run(ctx) {
    const type = needArg(ctx, 0, 'type', 'studio kb schema Message --json-schema');
    const session = ctx.session(ctx.flags.session);
    const result = await schemaForType(session, type, { jsonSchema: !!ctx.flags['json-schema'] });
    ctx.out.emit(result, (out) => out.result(JSON.stringify(result, null, 2)));
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'knowledge continuity', section: 'Knowledge', aliases: ['continuity'], usage: '[id|latest] [--eid ID] [--at TIME]', summary: 'Join safely keyed entities across saved sessions of the same origin',
  flags: { eid: { type: 'string', valueName: 'ID', desc: 'Show one entity with its full cross-session history' }, at: { type: 'string', valueName: 'TIME', desc: 'As-of ISO time or epoch ms' }, limit: { type: 'number', alias: 'n', valueName: 'N', default: 20, desc: 'Show at most N entities' } },
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    const site = siteFromSession(s.meta), origin = originFromSession(s.meta);
    if (!site || !origin) throw new CliError('This session has no verified target origin; cross-session continuity is unavailable.', { exit: 2, code: 'NO_ORIGIN' });
    const view = await buildSiteContinuity(ctx.paths.sessions, { site, origin, eid: ctx.flags.eid ?? null, asOf: ctx.flags.at ?? null, limit: ctx.flags.limit, includeHistory: !!ctx.flags.eid });
    ctx.out.emit(view, (o) => {
      const st = view.stats;
      o.result(`Continuity for ${origin} (${site}): ${st.sessionsWithDerivedKnowledge}/${st.sessionsDiscovered} derived sessions, ${st.joinedEntities} keyed entities spanning multiple sessions, ${st.entitiesTotal} visible entities.`);
      if (st.sessionsWithoutKnowledge.length || st.sessionsWithDerivationError.length) o.line(`  Unavailable knowledge: ${st.sessionsWithoutKnowledge.length} not derived, ${st.sessionsWithDerivationError.length} derivation errors. Fix with "studio derive --missing".`);
      if (ctx.flags.eid) { o.result(JSON.stringify(view.entities, null, 2)); return; }
      o.table(view.entities, [{ title: 'ENTITY', key: 'id', max: 44 }, { title: 'TYPE', key: 'typeName', max: 20 }, { title: 'SESSIONS', key: 'sessionCount', align: 'right' }, { title: 'REVS', key: 'revisions', align: 'right' }, { title: 'IDENTITY', key: 'identityBasis', max: 24 }], { indent: 2, empty: 'No entities yet.' });
      if (st.truncated) o.line(`  ${st.truncated} more entities (use --limit or --eid).`);
      if (st.typeDriftHintsTotal) {
        o.line(`  Possible type drift: ${st.typeDriftHintsTotal} unconfirmed structural candidate(s), NOT merged.`);
        for (const h of view.typeDriftHints.slice(0, 10)) o.line(`    ${h.origin} key ${h.keyField}=${h.key}  types ${h.candidates.map((c) => c.typeName ?? c.type).join(' / ')}  field overlap ${h.structuralFieldOverlap}`);
      }
      if (st.typeDriftVariantsOmitted) o.line(`  Drift analysis bounded: ${st.typeDriftVariantsOmitted} type variant(s) not compared.`);
      o.line('  Note: only same-origin, exact-key identities join. Type-drift hints do not join; missing observations are not deletions.');
    });
  },
});
