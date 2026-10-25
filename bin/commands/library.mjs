// library build|show|list: publish only accepted, same-origin derived sessions as a family
// shape set, persist it through the existing FamilyStore, and inspect what was consolidated.
import path from 'node:path';
import { EXIT } from '../../src/config.mjs';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, notFound, envError } from '../lib/ui.mjs';
import { buildFamily, writeFamily } from '../../src/families/build.mjs';
import { CORE_SITES, buildCoreLibrary, writeCoreLibrary, compareSites } from '../../src/families/core.mjs';

const fieldPathCount = (shapes) => new Set((shapes ?? []).flatMap((s) => (s.fields ?? []).map((f) => f.path))).size;

function coveragePairs(built) {
  return [
    ['members (accepted)', built.family.members.join(', ') || '(none)'],
    ['inspected', String(built.coverage.sessions)],
    ['eligible', String(built.coverage.eligible ?? 0)],
    ['withheld', String(built.coverage.withheld ?? 0)],
    ['exact origin', built.family.origin ?? '(none)'],
    ['hosts', built.family.hosts.join(', ') || '(none)'],
    ['transports', built.coverage.transports.join(', ') || '(none)'],
    ['streams', String(built.coverage.streams)],
    ['field paths', String(fieldPathCount(built.shapes))],
    ['signature', built.family.signature],
  ];
}

defineGroup('library', {
  section: 'Knowledge', default: 'build',
  summary: 'Publish accepted same-origin evidence into site families',
  description: 'Inspects all saved sessions but only publishes verified G1–G7 capture_accepted, complete-knowledge, exact-origin shapes. Unassessed and unverified evidence stays in its original session.',
});

define({
  name: 'library build', section: 'Knowledge', usage: '<host|site> [--min N]',
  summary: 'Build (and save) the family shape set for a site',
  description: 'Exits 0 when an eligible family is published, 3 if no sessions, 4 if none are accepted and eligible for publication.',
  flags: { min: { type: 'number', alias: 'n', valueName: 'N', default: 1, desc: 'Warn unless at least N sessions exist' } },
  examples: ['studio library build chatgpt.com', 'studio library build openai --min 3 --json'],
  async run(ctx) {
    const ref = ctx.args[0];
    if (!ref) throw usageError('Give a host or site to build the family from.', 'Example: studio library build chatgpt.com');
    const built = buildFamily({
      sessionsDir: ctx.paths.sessions, host: ref, site: ref,
      profilesDir: ctx.paths.profiles, minSessions: ctx.flags.min ?? 1,
    });

    if (!built.coverage.sessions) throw notFound(`No sessions for "${ref}".`, 'Record one with "studio capture <url>".');

    if (!built.coverage.withDerived) {
      ctx.out.emit({ ref, ...built, written: null }, (o) => {
        o.result(`No derived sessions for ${ref}: ${built.coverage.sessions} session(s), none derived.`);
        o.line('');
        o.line(`  Run "studio derive ${built.family.members[0]} --full" first.`);
      });
      process.exitCode = EXIT.INTEGRITY;
      return;
    }

    if (!(built.coverage.eligible > 0) || !built.shapes.length) {
      ctx.out.emit({ ref, ...built, written: null }, (o) => {
        o.result(`Family publication withheld for ${ref}: ${built.coverage.sessions} session(s) inspected, ${built.coverage.eligible ?? 0} eligible.`);
        for (const w of built.warnings) o.line(`  ${w}`);
        o.line('  Only an independently traceable capture_accepted G1–G7 verdict permits shape publication.');
      });
      process.exitCode = EXIT.INTEGRITY;
      return;
    }
    const written = writeFamily({ familiesDir: ctx.paths.families, built });
    ctx.out.emit({ ...built, fieldPaths: fieldPathCount(built.shapes), written }, (o) => {
      o.result(`Family ${built.family.id}: ${built.coverage.eligible} accepted contributor(s) of ${built.coverage.sessions} inspected.`);
      o.line('');
      o.kv(coveragePairs(built));
      o.line('');
      o.line(o.c.dim(`saved ${written.store} v${written.version} -> ${written.dir}`));
      if (built.warnings.length) { o.line(''); for (const w of built.warnings) o.line(o.c.dim(`warning: ${w}`)); }
    });
  },
});

define({
  name: 'library show', section: 'Knowledge', usage: '<host|site|id>',
  summary: 'Show a consolidated family',
  examples: ['studio library show chatgpt.com', 'studio library show chatgpt.com --json'],
  async run(ctx) {
    const ref = ctx.args[0];
    if (!ref) throw usageError('Give a family id, host or site.', 'Example: studio library show chatgpt.com');
    const store = ctx.families();
    const want = String(ref).toLowerCase();
    const names = store.names();
    let id = names.find((n) => n.toLowerCase() === want);
    if (!id) {
      id = names.find((n) => {
        if (n.toLowerCase().includes(want)) return true;
        try {
          const f = store.load(n);
          return (f.hosts ?? []).some((h) => String(h).toLowerCase().includes(want)) || String(f.site ?? '').toLowerCase() === want;
        } catch { return false; }
      });
    }
    if (!id) throw notFound(`No family matches "${ref}".`, 'Build one with "studio library build <host|site>".');
    const fam = store.load(id);
    const shapes = fam.shapes ?? [];
    ctx.out.emit({ ...fam, id, fieldPaths: fieldPathCount(shapes) }, (o) => {
      o.result(`Family ${id} (store version ${store.current(id)})`);
      o.line('');
      o.kv([
        ['name', fam.name ?? id],
        ['site', fam.site ?? ''],
        ['hosts', (fam.hosts ?? []).join(', ') || '(none)'],
        ['members', (fam.members ?? []).join(', ') || '(none)'],
        ['transports', (fam.coverage?.transports ?? []).join(', ') || '(none)'],
        ['streams', String(fam.coverage?.streams ?? shapes.length)],
        ['field paths', String(fieldPathCount(shapes))],
        ['signature', fam.signature ?? '(none)'],
      ]);
      if (shapes.length) {
        o.line('');
        o.table(shapes.map((s) => ({ transport: s.transport, endpoint: s.endpoint, fields: (s.fields ?? []).length, deltas: (s.deltas ?? []).join(', ') })), [
          { title: 'TRANSPORT', key: 'transport', max: 18 },
          { title: 'ENDPOINT', key: 'endpoint', max: 60 },
          { title: 'FIELDS', key: 'fields', align: 'right' },
          { title: 'DELTAS', key: 'deltas', max: 30 },
        ]);
      }
      if ((fam.warnings ?? []).length) { o.line(''); for (const w of fam.warnings) o.line(o.c.dim(`warning: ${w}`)); }
    });
  },
});

define({
  name: 'library list', section: 'Knowledge', usage: '',
  summary: 'List consolidated families',
  examples: ['studio library list', 'studio library list --json'],
  async run(ctx) {
    const store = ctx.families();
    const rows = store.names().map((n) => {
      let f = {};
      try { f = store.load(n); } catch { /* unreadable version: list it bare */ }
      return {
        id: n,
        version: store.current(n),
        hosts: (f.hosts ?? []).join(', '),
        members: (f.members ?? []).length,
        sessions: f.coverage?.sessions ?? '',
        derived: f.coverage?.withDerived ?? '',
        streams: f.coverage?.streams ?? (f.shapes ?? []).length,
        signature: f.signature ?? '',
      };
    });
    ctx.out.emit(rows, (o) => {
      o.result(`${rows.length} family/families.`);
      if (rows.length) {
        o.line('');
        o.table(rows, [
          { title: 'FAMILY', key: 'id', max: 30 },
          { title: 'VER', key: 'version', align: 'right' },
          { title: 'HOSTS', key: 'hosts', max: 34 },
          { title: 'MEMBERS', key: 'members', align: 'right' },
          { title: 'SESSIONS', key: 'sessions', align: 'right' },
          { title: 'DERIVED', key: 'derived', align: 'right' },
          { title: 'STREAMS', key: 'streams', align: 'right' },
          { title: 'SIGNATURE', key: 'signature', max: 22 },
        ]);
      }
    });
  },
});

// Environment failures (permissions, missing data dir, full disk) map to exit 5.
const CORE_ENV_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOTDIR', 'ENOENT']);

function renderCoreLibrary(o, library, written) {
  o.result(`Core library ${library.id}: ${library.coverage.sitesWithData}/${library.coverage.sites} site(s) with data, ${library.coverage.withDerived}/${library.coverage.sessions} session(s) derived.`);
  o.line('');
  o.table(library.sites.map((s) => ({
    site: s.id,
    sessions: s.sessions,
    derived: s.withDerived,
    transports: s.transports.join(', ') || '—',
    endpoints: s.endpoints.join(', ') || '—',
    signature: s.signature,
    gaps: library.gaps.filter((g) => g.startsWith(`${s.id}:`)).length,
  })), [
    { title: 'SITE', key: 'site', max: 12 },
    { title: 'SESSIONS', key: 'sessions', align: 'right' },
    { title: 'DERIVED', key: 'derived', align: 'right' },
    { title: 'TRANSPORTS', key: 'transports', max: 22 },
    { title: 'ENDPOINTS', key: 'endpoints', max: 44 },
    { title: 'SIGNATURE', key: 'signature', max: 22 },
    { title: 'GAPS', key: 'gaps', align: 'right' },
  ]);
  o.line('');
  const c = library.core;
  o.kv([
    ['transports', c.transports.join(', ') || '(none)'],
    ['frame kinds', c.frameKinds.join(', ') || '(none)'],
    ['delta fields', c.deltaFields.map((d) => d.name).join(', ') || '(none)'],
    ['terminal markers', c.terminalMarkers.map((t) => t.marker).join(', ') || '(none)'],
    ['envelope fields', c.envelopeFields.map((f) => f.name).join(', ') || '(none)'],
    ['coverage', `${library.coverage.sitesWithData}/${library.coverage.sites} site(s), ${library.coverage.withDerived}/${library.coverage.sessions} session(s), ${library.coverage.streams} stream(s)`],
    ['signature', library.signature],
  ]);
  o.line('');
  o.line(o.c.dim('differences'));
  o.table(compareSites({ library }), [
    { title: 'SITE', key: 'site', max: 12 },
    { title: 'TRANSPORT', key: 'transport', max: 14 },
    { title: 'FRAMING', key: 'framing', max: 14 },
    { title: 'DELTA FIELD', key: 'deltaField', max: 26 },
    { title: 'TERMINAL', key: 'terminalMarker', max: 28 },
  ]);
  if (written) {
    o.line('');
    o.line(o.c.dim(`saved ${written.store} v${written.version} -> ${written.dir}`));
    for (const f of written.files) o.line(o.c.dim(`  ${f}`));
  }
  if (library.gaps.length) { o.line(''); for (const g of library.gaps) o.line(o.c.dim(`gap: ${g}`)); }
}

define({
  name: 'library core', section: 'Knowledge', usage: '[--sites a,b,c] [--out DIR]',
  summary: 'Build (and save) the cross-site core streaming library',
  description: 'Reads the derived sessions of the nine AI chat sites and derives the shared streaming contract (transports, frame kinds, delta fields, terminal markers, envelope fields) from what the captures actually do, plus the per-site dialect that differs. Saves it as family "ai-chat-core" (versioned store + CURRENT) and a plain diffable core.json. Exits 0 on success, 3 when no site has a derived session, 5 on an environment failure.',
  flags: {
    sites: { type: 'string', valueName: 'IDS', desc: `Comma-separated site ids (default ${CORE_SITES.join(', ')})` },
    out: { type: 'string', valueName: 'DIR', desc: 'Write the core library under this families directory instead of the data dir' },
  },
  examples: ['studio library core', 'studio library core --sites chatgpt,claude --json', 'studio library core --out ./families'],
  async run(ctx) {
    const known = new Set(CORE_SITES);
    const wanted = ctx.flags.sites
      ? String(ctx.flags.sites).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [...CORE_SITES];
    if (!wanted.length) throw usageError('No sites selected.', `Known sites: ${CORE_SITES.join(', ')}.`);
    const unknown = wanted.filter((s) => !known.has(s));
    if (unknown.length) throw usageError(`Unknown site(s): ${unknown.join(', ')}.`, `Known sites: ${CORE_SITES.join(', ')}.`);

    const familiesDir = ctx.flags.out ? path.resolve(String(ctx.flags.out)) : ctx.paths.families;
    let library, written;
    try {
      library = buildCoreLibrary({ sessionsDir: ctx.paths.sessions, familiesDir, sites: wanted });
      if (!library.coverage.withDerived) {
        ctx.out.emit(library, (o) => {
          renderCoreLibrary(o, library, null);
          o.line('');
          o.line(`No derived sessions for any selected site. Run "studio derive <id> --full" first.`);
        });
        process.exitCode = EXIT.NOT_FOUND;
        return;
      }
      written = writeCoreLibrary({ familiesDir, library });
    } catch (err) {
      if (CORE_ENV_CODES.has(err?.code)) throw envError(`Cannot build the core library: ${err.message}`, 'Check the data/families directory and free space (--data-dir, --out).');
      throw err;
    }
    ctx.out.emit(library, (o) => renderCoreLibrary(o, library, written));
  },
});
