// profile list|show|versions|diff|rollback|apply|export|import|new|clone|set|hosts|match|lint|op ; family list|show|records|new|detect
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { profileDiff } from '../../src/profiles/profiles.mjs';
import { applySuggestion } from '../../src/profiles/apply.mjs';
import { applyModelOp } from '../../src/profiles/model-ops.mjs';
import { listProfileSummaries, explainMatch, lintProfile, applyAssignments, unsetPaths, editHosts, buildProfile, validateImport, isValidProfileName, profileUsage } from '../../src/profiles/manage.mjs';
import { Session } from '../../src/store/session.mjs';
import { formatRows, DATASET_FORMATS } from '../../src/export/export.mjs';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, notFound, CliError, fmtAgo, truncate, oneLine } from '../lib/ui.mjs';
import { needArg } from '../lib/util.mjs';

defineGroup('profile', {
  summary: 'Site profiles: scope, capture policy and record rules (every save is a new version)', section: 'Profiles and families', default: 'list', aliases: ['profiles'],
  description: 'A profile decides which requests a recording keeps, how streams are decoded and which record rules extract data. Profiles are versioned and immutable: edits create a new version and rollback only moves a pointer. Use --dry-run on any editing command to preview the change.',
  subAliases: { ls: 'list', cat: 'show', history: 'versions', add: 'new' },
});
defineGroup('family', {
  summary: 'Provider families: shared data models many sites map into', section: 'Profiles and families', default: 'list', aliases: ['families'],
  subAliases: { ls: 'list' },
});

const dryRun = { 'dry-run': { type: 'boolean', desc: 'Show what would change without saving' } };
const noteFlag = { note: { type: 'string', valueName: 'TEXT', desc: 'Change note stored with the new version' } };

function printDiff(o, diffs) {
  if (!diffs.length) { o.line('  (no changes)'); return; }
  for (const d of diffs) o.line(`  ${o.c.cyan(d.path)}: ${truncate(JSON.stringify(d.from), 70)} => ${truncate(JSON.stringify(d.to), 70)}`);
}

// Save (or preview) an edited profile and report the diff against the current version.
function commit(ctx, name, before, after, note, extra = {}) {
  const diffs = profileDiff(before, after);
  // Block only errors this edit introduces; a profile that was already imperfect can still be repaired.
  const known = new Set(lintProfile(before).filter((i) => i.level === 'error').map((i) => `${i.path}|${i.message}`));
  const errors = lintProfile(after).filter((i) => i.level === 'error' && !known.has(`${i.path}|${i.message}`));
  if (errors.length) throw new CliError(`The edited profile would be invalid:\n  ${errors.map((e) => `${e.path}: ${e.message}`).join('\n  ')}`, { exit: 2, code: 'INVALID_PROFILE' });
  if (ctx.flags['dry-run']) {
    ctx.out.emit({ name, dryRun: true, note, changes: diffs, ...extra }, (o) => { o.result(`Dry run for ${name}: ${note}`); printDiff(o, diffs); });
    return null;
  }
  const store = ctx.profiles();
  const saved = store.save(name, after, ctx.flags.note ?? note);
  if (saved.family && ctx.families().has(saved.family)) ctx.families().addMember(saved.family, name);
  ctx.out.emit({ name, version: saved.version, note: saved.changeNote, changes: diffs, ...extra }, (o) => { o.result(`${saved.changeNote} -> ${name}@v${saved.version}`); printDiff(o, diffs); });
  return saved;
}

const requireProfile = (ctx, idx = 0) => {
  const name = needArg(ctx, idx, 'profile name', 'studio profile show claude');
  const store = ctx.profiles();
  if (!store.has(name)) {
    const names = store.names();
    throw notFound(`No profile "${name}".`, `Available: ${names.join(', ')}.`);
  }
  return name;
};

// ---------------------------------------------------------------------------------------------
define({
  name: 'profile list', section: 'Profiles and families', summary: 'List profiles with version, hosts, family and rule counts',
  flags: { family: { type: 'string', valueName: 'NAME', desc: 'Only profiles linked to this family' }, host: { type: 'string', valueName: 'HOST', desc: 'Only profiles matching this host' }, usage: { type: 'boolean', desc: 'Add how many saved sessions used each profile' } },
  async run(ctx) {
    let rows = listProfileSummaries(ctx.profiles());
    if (ctx.flags.family) rows = rows.filter((r) => r.family === ctx.flags.family);
    if (ctx.flags.host) rows = rows.filter((r) => r.hosts.some((h) => h === '*' || h === ctx.flags.host || (h.startsWith('*.') && ctx.flags.host.endsWith(h.slice(1)))));
    if (ctx.flags.usage || ctx.out.json) { const use = profileUsage(ctx.listSessions()); rows = rows.map((r) => ({ ...r, sessions: use[r.name] ?? 0 })); }
    ctx.out.emit(rows, (o) => o.table(rows, [{ title: 'PROFILE', key: 'name' }, { title: 'VER', get: (r) => `v${r.current}`, align: 'right' }, { title: 'FAMILY', get: (r) => r.family ?? '' }, { title: 'HOSTS', get: (r) => r.hosts.join(', '), max: 36 }, { title: 'RULES', key: 'records', align: 'right' }, { title: 'MAPS', key: 'familyMappings', align: 'right' }, ...(ctx.flags.usage ? [{ title: 'SESSIONS', key: 'sessions', align: 'right' }] : []), { title: 'UPDATED', get: (r) => (r.updatedAt ? fmtAgo(r.updatedAt) : '') }], { empty: 'No profiles.' }));
  },
});

define({
  name: 'profile show', section: 'Profiles and families', usage: '<name> [--version N] [--field PATH]', summary: 'Print a profile as JSON',
  flags: { version: { type: 'number', alias: 'V', valueName: 'N', desc: 'A specific version (default current)' }, field: { type: 'string', valueName: 'PATH', desc: 'Print only this dotted path, e.g. capture.exclude' } },
  async run(ctx) {
    const name = requireProfile(ctx);
    let value = ctx.profiles().load(name, ctx.flags.version);
    if (ctx.flags.field) {
      for (const part of ctx.flags.field.split('.').filter(Boolean)) value = value?.[part];
      if (value === undefined) throw notFound(`${name} has no field "${ctx.flags.field}".`);
    }
    ctx.out.raw(`${JSON.stringify(value, null, 2)}\n`);
  },
});

define({
  name: 'profile versions', section: 'Profiles and families', usage: '<name>', summary: 'Version history with change notes (* marks current)',
  async run(ctx) {
    const name = requireProfile(ctx);
    const store = ctx.profiles();
    const cur = store.current(name);
    const rows = store.versions(name).map((v) => ({ ...v, current: v.version === cur }));
    ctx.out.emit({ name, current: cur, versions: rows }, (o) => o.table(rows, [{ title: 'VER', get: (v) => `v${v.version}${v.current ? ' *' : ''}`, align: 'right' }, { title: 'SAVED', get: (v) => `${v.savedAt} (${fmtAgo(v.savedAt)})` }, { title: 'NOTE', get: (v) => v.note ?? '', max: 80 }]));
  },
});

define({
  name: 'profile diff', section: 'Profiles and families', usage: '<name> [from] [to]', summary: 'What changed between two versions (default: previous vs current)',
  async run(ctx) {
    const name = requireProfile(ctx);
    const store = ctx.profiles();
    const cur = store.current(name);
    const to = ctx.args[2] !== undefined ? Number(ctx.args[2]) : cur;
    const from = ctx.args[1] !== undefined ? Number(ctx.args[1]) : to - 1;
    if (![from, to].every((n) => Number.isInteger(n) && n >= 1)) throw usageError('Versions must be positive integers.', `${name} is at v${cur}.`);
    const diffs = profileDiff(store.load(name, from), store.load(name, to));
    ctx.out.emit({ name, from, to, changes: diffs }, (o) => { o.result(`${name} v${from} -> v${to}`); printDiff(o, diffs); });
  },
});

define({
  name: 'profile rollback', section: 'Profiles and families', usage: '<name> <version>', summary: 'Make an earlier version current again (history is kept)',
  async run(ctx) {
    const name = requireProfile(ctx);
    const v = Number(needArg(ctx, 1, 'version', 'studio profile rollback claude 2'));
    if (!Number.isInteger(v) || v < 1) throw usageError('Version must be a positive integer.');
    const p = ctx.profiles().rollback(name, v);
    ctx.out.emit({ name, version: p.version }, (o) => o.result(`${name} now uses v${p.version}.`));
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'profile apply', section: 'Profiles and families', usage: '<name> --session ID --suggestion SID [--reject]', summary: 'Accept or reject inferred suggestions into a new profile version',
  description: 'Suggestions come from "studio shapes". Use --suggestion repeatedly (or comma-separated) for several, or --all with --min-confidence to accept every suggestion above a threshold in one new version. Decisions also calibrate future confidence.',
  flags: {
    session: { type: 'string', valueName: 'ID', default: 'latest', desc: 'Session the suggestions came from (default latest)' },
    suggestion: { type: 'list', valueName: 'ID,…', desc: 'Suggestion id(s) from "studio shapes"' },
    all: { type: 'boolean', desc: 'Apply every suggestion (combine with --min-confidence)' },
    'min-confidence': { type: 'number', valueName: '0-1', default: 0.8, desc: 'Threshold for --all' },
    reject: { type: 'boolean', desc: 'Reject instead of accept (the suggestion will not be offered again)' },
    ...dryRun, ...noteFlag,
  },
  examples: ['studio shapes latest', 'studio profile apply claude --session latest --suggestion record-message', 'studio profile apply mysite --all --min-confidence 0.9 --dry-run'],
  async run(ctx) {
    const name = requireProfile(ctx);
    const f = ctx.flags;
    if (!f.suggestion?.length && !f.all) throw usageError('Choose suggestions with --suggestion ID (see "studio shapes") or use --all.');
    const s = ctx.session(f.session);
    const store = ctx.profiles();
    await ctx.ensureDerived(s, { need: 'SHAPES', profile: name });
    const rep = s.kv.get('SHAPES');
    const chosen = f.all ? (rep.suggestions ?? []).filter((g) => g.confidence >= f['min-confidence'] && (g.proposal?.op || f.reject)) : f.suggestion.map((id) => {
      const g = (rep.suggestions ?? []).find((x) => x.id === id);
      if (!g) throw notFound(`No suggestion "${id}" in ${s.id}.`, `List them with "studio shapes ${s.id}".`);
      return g;
    });
    if (!chosen.length) { ctx.out.emit({ applied: [] }, (o) => o.result('No suggestions matched.')); return; }
    const before = store.load(name);
    let profile = before; const notes = [];
    for (const g of chosen) { const r = applySuggestion(profile, g, { action: f.reject ? 'reject' : 'accept' }); profile = r.profile; notes.push(r.note); }
    const note = notes.length === 1 ? notes[0] : `${notes.length} suggestions ${f.reject ? 'rejected' : 'accepted'}: ${notes.join('; ')}`;
    const saved = commit(ctx, name, before, profile, note, { applied: chosen.map((g) => g.id) });
    if (saved) {
      const L = ctx.learner();
      let observed = 0;
      for (const g of chosen) if (g.kind && Number.isFinite(Number(g.confidence))) { L.calibrator.observe(`suggestion:${g.kind}`, Number(g.confidence), !f.reject); observed++; }
      if (observed) L.save();
    }
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'profile export', section: 'Profiles and families', usage: '<name> [--out FILE|-]', summary: 'Write a profile to a portable JSON file',
  flags: { out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Output file ("-" for stdout; default <name>.profile.json)' }, version: { type: 'number', alias: 'V', desc: 'A specific version' } },
  async run(ctx) {
    const name = requireProfile(ctx);
    const body = JSON.stringify(ctx.profiles().load(name, ctx.flags.version), null, 2);
    const out = ctx.flags.out ?? `${name}.profile.json`;
    if (out === '-') { ctx.out.raw(`${body}\n`); return; }
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, body);
    ctx.out.emit({ name, file: path.resolve(out) }, (o) => o.result(`Wrote ${path.resolve(out)}`));
  },
});

define({
  name: 'profile import', section: 'Profiles and families', usage: '<file> [--name N]', summary: 'Validate and import a profile file as a new version',
  flags: { name: { type: 'string', valueName: 'NAME', desc: 'Import under this name instead of the one in the file' }, ...dryRun },
  async run(ctx) {
    const file = needArg(ctx, 0, 'profile file', 'studio profile import ./claude.profile.json');
    if (!existsSync(file)) throw notFound(`File not found: ${file}`);
    let p;
    try { p = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw usageError(`${file} is not valid JSON: ${e.message}`); }
    if (ctx.flags.name) p = { ...p, name: ctx.flags.name };
    const warnings = validateImport(p);
    const store = ctx.profiles();
    const existed = store.has(p.name);
    if (ctx.flags['dry-run']) { ctx.out.emit({ name: p.name, existed, warnings, dryRun: true }, (o) => { o.result(`Would import ${p.name} (${existed ? `new version of existing profile` : 'new profile'}).`); for (const w of warnings) o.line(`  ${w.level}: ${w.path}: ${w.message}`); }); return; }
    const saved = store.save(p.name, p, `imported from ${path.basename(file)}`);
    if (saved.family && ctx.families().has(saved.family)) ctx.families().addMember(saved.family, saved.name);
    ctx.out.emit({ name: saved.name, version: saved.version, existed, warnings }, (o) => { o.result(`Imported ${saved.name}@v${saved.version}`); for (const w of warnings) o.line(`  ${o.c.yellow(w.level)}: ${w.path}: ${w.message}`); });
  },
});

define({
  name: 'profile new', section: 'Profiles and families', usage: '<name> --hosts a.com,*.a.com', summary: 'Create a profile for a site from the generic defaults (or another base)',
  flags: { hosts: { type: 'list', valueName: 'H,…', desc: 'Host patterns: example.com, *.example.com, or *' }, from: { type: 'string', valueName: 'PROFILE', default: 'generic', desc: 'Base profile' }, family: { type: 'string', valueName: 'FAMILY', desc: 'Link to a provider family' }, description: { type: 'string', valueName: 'TEXT', desc: 'Description' }, ...dryRun },
  examples: ['studio profile new example --hosts example.com,*.example.com', 'studio profile new mychat --hosts chat.example.com --family ai-chat'],
  async run(ctx) {
    const name = needArg(ctx, 0, 'profile name', 'studio profile new example --hosts example.com');
    const f = ctx.flags;
    const store = ctx.profiles();
    if (store.has(name)) throw new CliError(`Profile "${name}" already exists.`, { exit: 2, code: 'EXISTS', hint: `Edit it with "studio profile set ${name} …" or pick another name.` });
    if (f.family && !ctx.families().has(f.family)) throw notFound(`No family "${f.family}".`, `Known: ${ctx.families().names().join(', ')}.`);
    const p = buildProfile(store.load(f.from), { name, hosts: f.hosts, description: f.description, family: f.family });
    const errors = lintProfile(p).filter((i) => i.level === 'error');
    if (errors.length) throw usageError(`Invalid profile:\n  ${errors.map((e) => `${e.path}: ${e.message}`).join('\n  ')}`);
    if (f['dry-run']) { ctx.out.emit({ name, dryRun: true, profile: p }, (o) => o.result(`Would create ${name} for ${p.match.hosts.join(', ')} from ${f.from}.`)); return; }
    const saved = store.save(name, p, `created from ${f.from}`);
    if (saved.family && ctx.families().has(saved.family)) ctx.families().addMember(saved.family, name);
    ctx.out.emit({ name, version: saved.version, hosts: saved.match.hosts }, (o) => o.result(`Created ${name}@v${saved.version} for ${saved.match.hosts.join(', ')}. Record a session, then "studio shapes latest" and "studio profile apply".`));
  },
});

define({
  name: 'profile clone', section: 'Profiles and families', usage: '<source> <new-name> [--hosts …]', summary: 'Copy a profile under a new name',
  flags: { hosts: { type: 'list', valueName: 'H,…', desc: 'Replace the host patterns' }, ...dryRun },
  async run(ctx) {
    const src = requireProfile(ctx, 0);
    const name = needArg(ctx, 1, 'new profile name', 'studio profile clone claude claude-work');
    if (!isValidProfileName(name)) throw usageError(`Invalid profile name "${name}" (letters, digits, . _ -).`);
    const store = ctx.profiles();
    if (store.has(name)) throw new CliError(`Profile "${name}" already exists.`, { exit: 2, code: 'EXISTS' });
    const base = store.load(src);
    const p = { ...structuredClone(base), name, description: `Copy of ${src}@v${base.version}`, match: { ...base.match, hosts: ctx.flags.hosts?.length ? ctx.flags.hosts : base.match?.hosts } };
    if (ctx.flags['dry-run']) { ctx.out.emit({ name, dryRun: true }, (o) => o.result(`Would clone ${src} to ${name}.`)); return; }
    const saved = store.save(name, p, `cloned from ${src}@v${base.version}`);
    if (saved.family && ctx.families().has(saved.family)) ctx.families().addMember(saved.family, name);
    ctx.out.emit({ name, version: saved.version, from: src }, (o) => o.result(`Cloned ${src} -> ${name}@v${saved.version}`));
  },
});

define({
  name: 'profile set', section: 'Profiles and families', usage: '<name> <path=value|path+=value|path-=value>… [--unset PATH]', summary: 'Edit a profile by path (scalars, lists, nested settings)',
  description: 'Values are parsed as JSON when possible, otherwise taken as text. += appends to a list (no duplicates), -= removes from one.',
  flags: { unset: { type: 'list', valueName: 'PATH,…', desc: 'Remove these paths' }, ...dryRun, ...noteFlag },
  examples: ['studio profile set claude capture.websockets=true', 'studio profile set claude "capture.exclude+=\\.(png|jpg)(\\?|$)"', 'studio profile set claude decode.delta=json-patch', 'studio profile set claude --unset capture.sensitive'],
  async run(ctx) {
    const name = requireProfile(ctx);
    const assigns = ctx.args.slice(1);
    if (!assigns.length && !ctx.flags.unset?.length) throw usageError('Nothing to change.', 'Example: studio profile set claude capture.websockets=true');
    const store = ctx.profiles();
    const before = store.load(name);
    let { profile, changes } = applyAssignments(before, assigns);
    if (ctx.flags.unset?.length) { const r = unsetPaths(profile, ctx.flags.unset); profile = r.profile; changes = [...changes, ...r.changes]; }
    const note = `set ${[...assigns, ...(ctx.flags.unset ?? []).map((u) => `unset ${u}`)].map((a) => truncate(a, 40)).join(', ')}`;
    commit(ctx, name, before, profile, note);
  },
});

define({
  name: 'profile hosts', section: 'Profiles and families', usage: '<name> [--add H,…] [--remove H,…]', summary: 'Show or edit the host patterns a profile matches',
  flags: { add: { type: 'list', valueName: 'H,…', desc: 'Add host patterns' }, remove: { type: 'list', valueName: 'H,…', desc: 'Remove host patterns' }, ...dryRun },
  async run(ctx) {
    const name = requireProfile(ctx);
    const store = ctx.profiles();
    const before = store.load(name);
    if (!ctx.flags.add?.length && !ctx.flags.remove?.length) { const hosts = before.match?.hosts ?? []; ctx.out.emit({ name, hosts }, (o) => hosts.forEach((h) => o.result(h))); return; }
    const { profile, note } = editHosts(before, { add: ctx.flags.add ?? [], remove: ctx.flags.remove ?? [] });
    commit(ctx, name, before, profile, note);
  },
});

define({
  name: 'profile match', section: 'Profiles and families', usage: '<url>', summary: 'Which profile would a recording of this URL use, and why',
  async run(ctx) {
    const url = needArg(ctx, 0, 'URL', 'studio profile match https://claude.ai/chat/abc');
    const r = explainMatch(ctx.profiles(), url);
    ctx.out.emit(r, (o) => {
      o.result(`${r.url}  (host ${r.host}, site ${r.site})`);
      o.result(`Selected: ${r.selected.name}@v${r.selected.version}`);
      o.table(r.candidates, [{ title: 'PROFILE', key: 'name' }, { title: 'PATTERN', key: 'pattern' }, { title: 'SPECIFICITY', key: 'score', align: 'right' }], { indent: 2, empty: 'No host pattern matched; the generic defaults apply.' });
    });
  },
});

define({
  name: 'profile lint', section: 'Profiles and families', usage: '[name|--all]', summary: 'Check profiles for invalid patterns, duplicate rules and risky settings',
  flags: { all: { type: 'boolean', desc: 'Lint every profile' } },
  async run(ctx) {
    const store = ctx.profiles();
    const names = ctx.flags.all || !ctx.args[0] ? store.names() : [requireProfile(ctx)];
    const results = names.map((n) => ({ name: n, version: store.current(n), issues: lintProfile(store.load(n)) }));
    const errors = results.reduce((a, r) => a + r.issues.filter((i) => i.level === 'error').length, 0);
    ctx.out.emit({ ok: errors === 0, results }, (o) => {
      for (const r of results) {
        o.result(`${r.issues.some((i) => i.level === 'error') ? o.c.red('FAIL') : r.issues.length ? o.c.yellow('warn') : o.c.green('ok  ')} ${r.name}@v${r.version}`);
        for (const i of r.issues) o.result(`     ${i.level}: ${i.path}: ${i.message}`);
      }
    });
    if (errors) process.exitCode = 1;
  },
});

define({
  name: 'profile op', section: 'Profiles and families', usage: "<name> '<json operation>'", summary: 'Apply a semantic model operation (rename_field, set_identity, merge_records, …)',
  description: 'The same operations the studio UI model editor uses, driven by a JSON object: {"op":"rename_field","rule":"message","field":"txt","to":"text"}. Operations: rename_record, rename_field, set_field_type, set_field_path, add_field, exclude_field, remove_field, set_identity, set_revisions, set_relationship, merge_records, split_record, remove_record, set_scope, set_capture, set_family, remove_family_mapping.',
  flags: { ...dryRun, ...noteFlag },
  async run(ctx) {
    const name = requireProfile(ctx);
    const raw = needArg(ctx, 1, 'JSON operation', `studio profile op ${name} '{"op":"rename_record","rule":"a","to":"b"}'`);
    let op;
    try { op = JSON.parse(raw); } catch (e) { throw usageError(`Operation is not valid JSON: ${e.message}`, 'Quote the JSON for your shell.'); }
    const before = ctx.profiles().load(name);
    const { profile, note } = applyModelOp(before, op);
    commit(ctx, name, before, profile, note);
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'family list', section: 'Profiles and families', summary: 'List provider families, their entities and member profiles',
  async run(ctx) {
    const store = ctx.families();
    const rows = store.names().map((n) => { const f = store.load(n); return { name: n, version: f.version, description: f.description ?? '', entities: Object.keys(f.entities ?? {}), members: f.members ?? [] }; });
    ctx.out.emit(rows, (o) => o.table(rows, [{ title: 'FAMILY', key: 'name' }, { title: 'VER', get: (r) => `v${r.version}`, align: 'right' }, { title: 'ENTITIES', get: (r) => r.entities.join(', '), max: 30 }, { title: 'MEMBERS', get: (r) => r.members.join(', ') || '-', max: 40 }], { empty: 'No families.' }));
  },
});

define({
  name: 'family show', section: 'Profiles and families', usage: '<name>', summary: 'Print a family definition as JSON',
  async run(ctx) {
    const name = needArg(ctx, 0, 'family name', 'studio family show ai-chat');
    if (!ctx.families().has(name)) throw notFound(`No family "${name}".`, `Known: ${ctx.families().names().join(', ')}.`);
    ctx.out.raw(`${JSON.stringify(ctx.families().load(name), null, 2)}\n`);
  },
});

define({
  name: 'family new', section: 'Profiles and families', usage: '<name> [--from-profile P]', summary: 'Register a new, empty family (optionally seeded with a member profile)',
  flags: { description: { type: 'string', valueName: 'TEXT', desc: 'Description' }, 'from-profile': { type: 'string', valueName: 'PROFILE', desc: 'Member profile' } },
  async run(ctx) {
    const name = needArg(ctx, 0, 'family name', 'studio family new support-desk');
    if (!isValidProfileName(name)) throw usageError(`Invalid family name "${name}".`);
    if (ctx.flags['from-profile']) requireProfile({ ...ctx, args: [ctx.flags['from-profile']] });
    const f = ctx.families().register(name, { description: ctx.flags.description, fromProfile: ctx.flags['from-profile'] });
    ctx.out.emit({ name, version: f.version }, (o) => o.result(`Registered family ${name}@v${f.version}`));
  },
});

define({
  name: 'family records', section: 'Profiles and families', usage: '<name> [--entity message]', summary: 'Canonical records for a family across all sites and sessions',
  flags: { entity: { type: 'string', default: 'message', valueName: 'NAME', desc: 'Family entity (message, row, …)' }, session: { type: 'list', alias: 's', valueName: 'ID,…', desc: 'Only these sessions' }, limit: { type: 'number', alias: 'n', valueName: 'N', desc: 'Stop after N records' }, format: { type: 'string', alias: 'f', choices: DATASET_FORMATS, default: 'jsonl', desc: 'Output format' }, fields: { type: 'list', valueName: 'A,B.C', desc: 'Columns for table-like formats' } },
  async run(ctx) {
    const family = needArg(ctx, 0, 'family name', 'studio family records ai-chat --entity message');
    if (!ctx.families().has(family)) throw notFound(`No family "${family}".`, `Known: ${ctx.families().names().join(', ')}.`);
    const ds = `family-${family}-${ctx.flags.entity}`;
    const sessions = ctx.flags.session?.length ? ctx.flags.session.map((r) => ctx.session(r)) : ctx.listSessions().map((m) => Session.open(ctx.paths.sessions, m.id));
    const limit = ctx.flags.limit ?? Infinity;
    const stream = ctx.flags.format === 'jsonl' && !ctx.out.json;
    const rows = []; let n = 0;
    outer: for (const s of sessions) {
      if (!existsSync(s.dataset(ds).file)) continue;
      for await (const r of s.dataset(ds).iterate()) {
        n++;
        if (stream) ctx.out.raw(`${JSON.stringify(r)}\n`); else rows.push(r);
        if (n >= limit) break outer;
      }
    }
    if (!n) { ctx.out.warn(`No ${ds} records yet. Link a profile to the family (studio profile apply … a link_family suggestion) and derive a session.`); process.exitCode = 1; return; }
    if (stream) return;
    if (ctx.out.json) { ctx.out.emit({ dataset: ds, count: rows.length, rows }); return; }
    ctx.out.raw(await formatRows(rows, ctx.flags.format, { fields: ctx.flags.fields, title: ds }));
  },
});

define({
  name: 'family detect', section: 'Profiles and families', usage: '[id|latest]', summary: 'Which families a session looks like, with the evidence',
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    await ctx.ensureDerived(s, { need: 'SHAPES' });
    const fams = s.kv.get('SHAPES')?.families ?? [];
    ctx.out.emit({ session: s.id, families: fams }, (o) => {
      if (!fams.length) { o.result('No family evidence.'); return; }
      for (const f of fams) {
        o.result(`${String(Math.round(f.score * 100)).padStart(3)}%  ${f.family}  (coverage ${Math.round((f.coverage ?? 0) * 100)}%)`);
        for (const e of f.evidence ?? []) o.line(`       ${e.label ?? e.signal}: ${truncate(oneLine(e.why), 100)}`);
      }
    });
  },
});
