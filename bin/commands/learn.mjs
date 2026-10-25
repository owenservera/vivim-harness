// learn status|corrections|proposals|audit|calibration|versions|promotions|roles|predict|propose|teach|review|revert|rollback
import { ROLES, SCOPES } from '../../src/intel/learn.mjs';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, notFound, fmtAgo, fmtPct, truncate } from '../lib/ui.mjs';
import { needArg, knowledgeState } from '../lib/util.mjs';
import { Session } from '../../src/store/session.mjs';

defineGroup('learn', {
  summary: 'Inspect and steer the adaptive learner: status, corrections, calibration, history', section: 'Learning', default: 'status', aliases: ['learning'],
  description: 'The learner assigns roles (id, text, timestamp, …) to discovered fields. Models are scoped instance > page > site > account > family > global; every correction is audited and every save is a new immutable revision, so any change can be reviewed, reverted or rolled back.',
  subAliases: { list: 'corrections', history: 'versions' },
});

const SCOPE_CONTEXT = {
  site: { type: 'string', valueName: 'SITE', desc: 'Registrable site (e.g. example.com)' },
  origin: { type: 'string', valueName: 'ORIGIN', desc: 'Exact origin (e.g. https://app.example.com)' },
  account: { type: 'string', valueName: 'ACCOUNT', desc: 'Account label (scope account)' },
  family: { type: 'string', valueName: 'FAMILY', desc: 'Provider family (e.g. ai-chat)' },
  page: { type: 'string', valueName: 'PAGE', desc: 'Page key (scope page)' },
  'type-key': { type: 'string', valueName: 'TYPE', desc: 'Type key (scope instance)' },
};
const FEATURE_FLAGS = {
  kind: { type: 'string', choices: ['string', 'integer', 'number', 'boolean'], default: 'string', desc: 'Value kind of the field (feature input)' },
  format: { type: 'string', valueName: 'FMT', desc: 'Value format hint: iso_time, uuid, url, hex_id, token_id, markdown' },
  'avg-len': { type: 'number', valueName: 'N', desc: 'Average string length (feature input)' },
  unique: { type: 'number', valueName: '0-1', desc: 'Uniqueness ratio (feature input)' },
};

function describeField(f) {
  if (f.kind === 'boolean') return { type: 'boolean', boolean: { trueShare: 0.5 } };
  if (f.kind === 'integer' || f.kind === 'number') return { type: f.kind, number: { format: f.format, uniqueness: f.unique ?? 0.5, changeRate: 0.05, min: 0, max: f.kind === 'integer' ? 100 : 99.5 } };
  return { type: 'string', string: { formats: f.format ? { [f.format]: 1 } : {}, avgLen: f['avg-len'] ?? 12, uniqueness: f.unique ?? 0.5 } };
}
const ctxFromFlags = (f) => ({ site: f.site, origin: f.origin, account: f.account, family: f.family, page: f.page, typeKey: f['type-key'] });

function requireOne(ctx, flag, choices) {
  const v = ctx.flags[flag];
  if (!v) throw usageError(`--${flag} is required.`, choices ? `One of: ${choices.join(', ')}` : undefined);
  return v;
}

function persist(ctx, l, what) {
  const rev = l.save();
  return { revision: rev, saved: rev !== null, what };
}

// ---------------------------------------------------------------------------------------------
define({
  name: 'learn status', section: 'Learning', summary: 'Learner revision, scoped models, corrections, calibration and knowledge health',
  async run(ctx) {
    const l = ctx.learner();
    const accepted = l.corrections.filter((c) => !c.reverted && c.status !== 'rejected');
    const byScope = {}; for (const c of accepted) byScope[c.scope] = (byScope[c.scope] ?? 0) + 1;
    const models = Object.entries(l.models).map(([key, m]) => ({ key, examples: m.examples }));
    const modelScopes = {}; for (const m of models) { const k = m.key.split(':')[0]; modelScopes[k] = (modelScopes[k] ?? 0) + 1; }
    const calibration = Object.keys(l.calibrator.bins).map((kind) => ({ kind, observations: l.calibrator.bins[kind].reduce((a, b) => a + b.n, 0), ece: l.calibrator.ece(kind) }));
    const pending = l.proposals.filter((p) => p.status === 'proposed');
    const sessions = ctx.listSessions();
    const health = {}; for (const m of sessions) { const st = knowledgeState(Session.open(ctx.paths.sessions, m.id)); health[st] = (health[st] ?? 0) + 1; }
    const lastAudit = l.audit.at(-1) ?? null;
    const data = {
      dir: ctx.paths.learner, revision: l.revision, revisions: l.versions().length,
      global: { priorAndLearnedExamples: l.global.examples },
      scopedModels: { count: models.length, byScope: modelScopes, examples: models.reduce((a, m) => a + m.examples, 0) },
      overrides: Object.keys(l.overrides).length,
      corrections: { active: accepted.length, byScope, reverted: l.corrections.filter((c) => c.reverted).length },
      proposals: { pending: pending.length, accepted: l.proposals.filter((p) => p.status === 'accepted').length, rejected: l.proposals.filter((p) => p.status === 'rejected').length },
      calibration, promotionCandidates: l.promotionCandidates().length,
      sessions: { total: sessions.length, knowledge: health }, lastAudit,
    };
    ctx.out.emit(data, (o) => {
      o.heading('Learner');
      o.kv([['state', data.dir], ['revision', `${data.revision} (${data.revisions} stored)`], ['global model', `${data.global.priorAndLearnedExamples} examples (priors + promoted corrections)`],
        ['scoped models', `${data.scopedModels.count} (${Object.entries(modelScopes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ${data.scopedModels.examples} examples`], ['instance overrides', data.overrides],
        ['corrections', `${data.corrections.active} active${Object.keys(byScope).length ? ` (${Object.entries(byScope).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}, ${data.corrections.reverted} reverted`],
        ['proposals', `${data.proposals.pending} pending, ${data.proposals.accepted} accepted, ${data.proposals.rejected} rejected`], ['promotion candidates', data.promotionCandidates]]);
      o.line(''); o.heading('Calibration (does stated confidence match acceptance?)');
      o.table(calibration, [{ title: 'KIND', key: 'kind' }, { title: 'OBSERVATIONS', key: 'observations', align: 'right' }, { title: 'ECE', get: (c) => (c.ece === null ? '-' : c.ece.toFixed(3)), align: 'right' }], { indent: 2, empty: 'No decisions recorded yet; accept or reject suggestions to calibrate.' });
      o.line(''); o.heading('Knowledge across saved sessions');
      o.line(`  ${sessions.length} session(s): ${Object.entries(health).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
      if (health.none || health['legacy-unverified'] || health.failed) o.line(o.c.dim('  Rebuild with "studio derive --missing".'));
      if (lastAudit) { o.line(''); o.line(`Last audit: ${lastAudit.action} ${lastAudit.correctionId ?? ''} by ${lastAudit.actor ?? 'unknown'} ${fmtAgo(lastAudit.at)}`); }
      if (pending.length) o.line(o.c.yellow(`${pending.length} proposal(s) await review: "studio learn proposals".`));
    });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'learn corrections', section: 'Learning', summary: 'Accepted corrections (what the learner has been taught)',
  flags: { scope: { type: 'string', choices: SCOPES, desc: 'Only this scope' }, role: { type: 'string', choices: ROLES, desc: 'Only this role' }, site: { type: 'string', desc: 'Only this site' }, reverted: { type: 'boolean', desc: 'Include reverted corrections' }, limit: { type: 'number', alias: 'n', default: 50, desc: 'Show at most N' } },
  async run(ctx) {
    const f = ctx.flags;
    const rows = ctx.learner().corrections.filter((c) => (f.reverted || !c.reverted) && (!f.scope || c.scope === f.scope) && (!f.role || c.role === f.role) && (!f.site || c.ctx?.site === f.site)).slice(-f.limit).reverse();
    ctx.out.emit({ corrections: rows }, (o) => o.table(rows, [{ title: 'ID', key: 'id' }, { title: 'SCOPE', key: 'scope' }, { title: 'FIELD', key: 'name', max: 30 }, { title: 'ROLE', key: 'role' }, { title: 'SITE', get: (c) => c.ctx?.site ?? c.ctx?.family ?? '', max: 24 }, { title: 'WEIGHT', key: 'weight', align: 'right' }, { title: 'STATE', get: (c) => (c.reverted ? 'reverted' : c.status ?? 'accepted') }, { title: 'WHEN', get: (c) => fmtAgo(c.at) }], { empty: 'No corrections yet.' }));
  },
});

define({
  name: 'learn proposals', section: 'Learning', summary: 'Proposed corrections awaiting review',
  flags: { all: { type: 'boolean', desc: 'Include reviewed proposals' } },
  async run(ctx) {
    const rows = ctx.learner().proposals.filter((p) => ctx.flags.all || p.status === 'proposed');
    ctx.out.emit({ proposals: rows }, (o) => {
      o.table(rows, [{ title: 'ID', key: 'id' }, { title: 'SCOPE', key: 'scope' }, { title: 'FIELD', key: 'name', max: 30 }, { title: 'ROLE', key: 'role' }, { title: 'STATUS', key: 'status' }, { title: 'BY', get: (p) => p.actor ?? '' }, { title: 'NOTE', get: (p) => p.note ?? '', max: 40 }], { empty: 'No proposals pending.' });
      if (rows.some((p) => p.status === 'proposed')) o.line(o.c.dim('Review with: studio learn review <id> accept|reject'));
    });
  },
});

define({
  name: 'learn audit', section: 'Learning', summary: 'Audit trail of proposals, reviews, reverts and rollbacks',
  flags: { limit: { type: 'number', alias: 'n', default: 30, desc: 'Show the last N entries' } },
  async run(ctx) {
    const rows = ctx.learner().audit.slice(-ctx.flags.limit).reverse();
    ctx.out.emit({ audit: rows }, (o) => o.table(rows, [{ title: 'WHEN', get: (a) => fmtAgo(a.at) }, { title: 'ACTION', key: 'action' }, { title: 'ITEM', get: (a) => a.correctionId ?? (a.toRevision !== undefined ? `rev ${a.fromRevision}→${a.toRevision}` : '') }, { title: 'BY', get: (a) => a.actor ?? '' }, { title: 'NOTE', get: (a) => a.note ?? a.reason ?? '', max: 60 }], { empty: 'No audit entries.' }));
  },
});

define({
  name: 'learn calibration', section: 'Learning', summary: 'Confidence calibration per suggestion kind (histogram bins and ECE)',
  flags: { kind: { type: 'string', valueName: 'KIND', desc: 'Only this kind (e.g. suggestion:record_rule, field_role)' } },
  async run(ctx) {
    const cal = ctx.learner().calibrator;
    const kinds = Object.keys(cal.bins).filter((k) => !ctx.flags.kind || k === ctx.flags.kind);
    const data = kinds.map((kind) => ({ kind, ece: cal.ece(kind), bins: cal.bins[kind].map((b, i) => ({ range: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`, n: b.n, acceptRate: b.n ? +(b.pos / b.n).toFixed(3) : null, meanConfidence: b.n ? +(b.psum / b.n).toFixed(3) : null })) }));
    if (ctx.flags.kind && !data.length) throw notFound(`No calibration data for "${ctx.flags.kind}".`, `Known kinds: ${Object.keys(cal.bins).join(', ') || 'none yet'}`);
    ctx.out.emit(data, (o) => {
      if (!data.length) { o.result('No decisions recorded yet; accept or reject suggestions to calibrate.'); return; }
      for (const k of data) {
        o.heading(`${k.kind}   ECE ${k.ece === null ? '-' : k.ece.toFixed(3)}`);
        o.table(k.bins.filter((b) => b.n), [{ title: 'CONFIDENCE', key: 'range' }, { title: 'N', key: 'n', align: 'right' }, { title: 'ACCEPTED', get: (b) => fmtPct(b.acceptRate), align: 'right' }, { title: 'MEAN STATED', get: (b) => fmtPct(b.meanConfidence), align: 'right' }], { indent: 2 });
        o.line('');
      }
    });
  },
});

define({
  name: 'learn versions', section: 'Learning', aliases: [], summary: 'Stored learner revisions (every save is immutable)',
  flags: { limit: { type: 'number', alias: 'n', default: 20, desc: 'Show the newest N revisions' } },
  async run(ctx) {
    const l = ctx.learner();
    const revs = l.versions().slice(-ctx.flags.limit).reverse().map((r) => {
      let savedAt = null, actions = null;
      try { const snap = l.journal.at(r); savedAt = snap.savedAt ?? null; actions = (snap.audit ?? []).length; } catch { /* unreadable snapshot */ }
      return { revision: r, current: r === l.revision, savedAt, auditEntries: actions };
    });
    ctx.out.emit({ current: l.revision, revisions: revs }, (o) => o.table(revs, [{ title: 'REV', get: (r) => `${r.revision}${r.current ? ' *' : ''}`, align: 'right' }, { title: 'SAVED', get: (r) => (r.savedAt ? `${r.savedAt} (${fmtAgo(r.savedAt)})` : '-') }, { title: 'AUDIT', get: (r) => r.auditEntries ?? '-', align: 'right' }], { empty: 'No revisions stored yet.' }));
  },
});

define({
  name: 'learn promotions', section: 'Learning', summary: 'Corrections repeated across sites that could be promoted to family/global scope',
  flags: { 'min-sites': { type: 'number', default: 2, desc: 'Minimum distinct sites' } },
  async run(ctx) {
    const rows = ctx.learner().promotionCandidates(ctx.flags['min-sites']);
    ctx.out.emit({ candidates: rows }, (o) => o.table(rows, [{ title: 'ROLE', key: 'role' }, { title: 'SUGGESTED SCOPE', key: 'suggestedScope' }, { title: 'SITES', get: (r) => r.sites.join(', '), max: 50 }, { title: 'CORRECTIONS', get: (r) => r.corrections.join(' '), max: 30 }], { empty: 'No candidates; no pattern repeats across enough sites yet.' }));
  },
});

define({
  name: 'learn roles', section: 'Learning', summary: 'The roles and scopes the learner works with', noData: true,
  async run(ctx) { ctx.out.emit({ roles: ROLES, scopes: SCOPES }, (o) => o.kv([['roles', ROLES.join(', ')], ['scopes', SCOPES.join(', ')]], 0)); },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'learn predict', section: 'Learning', usage: '--name FIELD [--kind string] [--site S]', summary: 'What role would the learner assign to a field, and why',
  flags: { name: { type: 'string', valueName: 'FIELD', desc: 'Field name (e.g. created_at)' }, ...FEATURE_FLAGS, ...SCOPE_CONTEXT, top: { type: 'number', default: 4, desc: 'Show the top N roles' } },
  examples: ['studio learn predict --name created_at --kind string --format iso_time', 'studio learn predict --name msg_id --site example.com'],
  async run(ctx) {
    const f = ctx.flags;
    requireOne(ctx, 'name');
    const p = ctx.learner().predict(f.name, describeField(f), ctxFromFlags(f));
    const top = Object.entries(p.dist).sort((a, b) => b[1] - a[1]).slice(0, f.top).map(([role, prob]) => ({ role, probability: +prob.toFixed(3) }));
    ctx.out.emit({ field: f.name, role: p.role, confidence: +p.confidence.toFixed(3), calibrated: p.calibrated, source: p.source, entropy: +(p.entropy ?? 0).toFixed(3), top, features: p.features }, (o) => {
      o.result(`${f.name} -> ${p.role} (${fmtPct(p.confidence)}${p.calibrated !== undefined ? `, calibrated ${fmtPct(p.calibrated)}` : ''}; decided by ${p.source})`);
      o.table(top, [{ title: 'ROLE', key: 'role' }, { title: 'P', get: (r) => fmtPct(r.probability, 1), align: 'right' }], { indent: 2 });
      if (p.features) o.line(o.c.dim(`  features: ${truncate(p.features.join(' '), 150)}`));
    });
  },
});

const teachFlags = { name: { type: 'string', valueName: 'FIELD', desc: 'Field name being corrected' }, role: { type: 'string', choices: ROLES, desc: 'Correct role' }, scope: { type: 'string', choices: SCOPES, desc: 'How widely the correction applies' }, weight: { type: 'number', default: 5, desc: 'Strength (1-100)' }, note: { type: 'string', valueName: 'TEXT', desc: 'Why' }, actor: { type: 'string', default: 'cli', desc: 'Who is making the change (audit)' }, evidence: { type: 'string', valueName: 'TEXT', desc: 'Evidence reference (session id, seq…)' }, ...FEATURE_FLAGS, ...SCOPE_CONTEXT };

define({
  name: 'learn propose', section: 'Learning', usage: '--scope S --name FIELD --role R', summary: 'Propose a correction for review (does not train until accepted)',
  flags: teachFlags,
  examples: ['studio learn propose --scope site --site example.com --name ref --role reference --note "points at parent id"'],
  async run(ctx) {
    const f = ctx.flags;
    requireOne(ctx, 'name'); requireOne(ctx, 'role', ROLES); requireOne(ctx, 'scope', SCOPES);
    const l = ctx.learner();
    const proposal = l.proposeCorrection({ scope: f.scope, name: f.name, d: describeField(f), ctx: ctxFromFlags(f), role: f.role, weight: f.weight, note: f.note, actor: f.actor, evidence: f.evidence });
    const saved = persist(ctx, l, 'propose');
    ctx.out.emit({ proposal, ...saved }, (o) => o.result(`Proposed ${proposal.id}: ${f.name} -> ${f.role} (${f.scope}). Review with "studio learn review ${proposal.id} accept". Learner revision ${saved.revision}.`));
  },
});

define({
  name: 'learn teach', section: 'Learning', usage: '--scope S --name FIELD --role R', summary: 'Apply a correction immediately (propose + accept in one step)',
  flags: teachFlags,
  async run(ctx) {
    const f = ctx.flags;
    requireOne(ctx, 'name'); requireOne(ctx, 'role', ROLES); requireOne(ctx, 'scope', SCOPES);
    const l = ctx.learner();
    const entry = l.learn({ scope: f.scope, name: f.name, d: describeField(f), ctx: ctxFromFlags(f), role: f.role, weight: f.weight, note: f.note, actor: f.actor, evidence: f.evidence });
    const saved = persist(ctx, l, 'teach');
    ctx.out.emit({ correction: entry, ...saved }, (o) => o.result(`Learned ${entry.id}: ${f.name} -> ${f.role} (${f.scope}). Learner revision ${saved.revision}. Undo with "studio learn revert ${entry.id}".`));
  },
});

define({
  name: 'learn review', section: 'Learning', usage: '<proposal-id> <accept|reject>', summary: 'Accept or reject a proposed correction',
  flags: { actor: { type: 'string', default: 'cli', desc: 'Reviewer (audit)' }, note: { type: 'string', valueName: 'TEXT', desc: 'Reason' } },
  async run(ctx) {
    const id = needArg(ctx, 0, 'proposal id', 'studio learn review c3 accept');
    const action = needArg(ctx, 1, 'action (accept|reject)', 'studio learn review c3 accept');
    if (!['accept', 'reject'].includes(action)) throw usageError(`Action must be accept or reject (got "${action}").`);
    const l = ctx.learner();
    const p = l.reviewCorrection(id, { action, actor: ctx.flags.actor, note: ctx.flags.note });
    const saved = persist(ctx, l, 'review');
    ctx.out.emit({ proposal: p, ...saved }, (o) => o.result(`${action === 'accept' ? 'Accepted' : 'Rejected'} ${id}. Learner revision ${saved.revision}.`));
  },
});

define({
  name: 'learn revert', section: 'Learning', usage: '<correction-id>', summary: 'Undo an accepted correction (models are retrained without it)',
  flags: { actor: { type: 'string', default: 'cli', desc: 'Who (audit)' }, note: { type: 'string', valueName: 'TEXT', desc: 'Reason' } },
  async run(ctx) {
    const id = needArg(ctx, 0, 'correction id', 'studio learn revert c3');
    const l = ctx.learner();
    if (!l.revert(id, { actor: ctx.flags.actor, note: ctx.flags.note })) throw notFound(`No active correction "${id}".`, 'List them with "studio learn corrections".');
    const saved = persist(ctx, l, 'revert');
    ctx.out.emit({ reverted: id, ...saved }, (o) => o.result(`Reverted ${id}. Learner revision ${saved.revision}.`));
  },
});

define({
  name: 'learn rollback', section: 'Learning', usage: '<revision>', summary: 'Restore an earlier learner revision (recorded as a new revision)',
  flags: { actor: { type: 'string', default: 'cli', desc: 'Who (audit)' }, reason: { type: 'string', valueName: 'TEXT', desc: 'Why' }, yes: { type: 'boolean', alias: 'y', desc: 'Confirm' } },
  async run(ctx) {
    const rev = Number(needArg(ctx, 0, 'revision number', 'studio learn rollback 4 --yes'));
    if (!Number.isInteger(rev) || rev < 0) throw usageError('Revision must be a non-negative integer.');
    const l = ctx.learner();
    if (!l.versions().includes(rev) && rev !== l.revision) throw notFound(`Learner revision ${rev} not found.`, 'List revisions with "studio learn versions".');
    if (!ctx.flags.yes) { ctx.out.emit({ wouldRestore: rev, current: l.revision, confirmed: false }, (o) => o.result(`Would restore learner revision ${rev} (current ${l.revision}) as a new revision. Re-run with --yes to confirm.`)); return; }
    const newRev = l.rollbackTo(rev, { actor: ctx.flags.actor, reason: ctx.flags.reason });
    ctx.out.emit({ restored: rev, revision: newRev, confirmed: true }, (o) => o.result(`Restored revision ${rev} as new revision ${newRev}.`));
  },
});
