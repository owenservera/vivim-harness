// Per-invocation context: resolved paths/settings, lazily constructed stores, session lookup.
import path from 'node:path';
import { dataPaths, defaultDataDir, ensureDataDirs, resolveSettings } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { FamilyStore } from '../../src/families/families.mjs';
import { Session, listSessions } from '../../src/store/session.mjs';
import { derive } from '../../src/replay/derive.mjs';
import { ScopedLearner } from '../../src/intel/learn.mjs';
import { siteFromSession } from '../../src/intel/continuity.mjs';
import { notFound, usageError, createOutput } from './ui.mjs';

export function buildContext({ def, flags, args, argv }) {
  const paths = dataPaths(flags['data-dir'] ? path.resolve(flags['data-dir']) : defaultDataDir());
  if (!def.noData) ensureDataDirs(paths);
  const { settings, sources, problems } = resolveSettings({
    configFile: paths.config,
    flags: { cdpPort: def.name.startsWith('mirror ') ? undefined : flags.port, json: flags.json, color: flags.color === undefined ? undefined : flags.color ? 'always' : 'never' },
  });
  const out = createOutput({ json: settings.json || !!flags.json, quiet: !!flags.quiet, color: settings.color, verbose: !!flags.verbose });
  for (const p of problems) out.warn(`config: ${p}`);

  let profileStore, familyStore, learnerInst;
  const ctx = {
    def, flags, args, argv, paths, settings, sources, out,
    port: settings.cdpPort,
    profiles() { return (profileStore ??= new ProfileStore(paths.profiles)); },
    families() { return (familyStore ??= new FamilyStore(paths.families)); },
    learner() { return (learnerInst ??= new ScopedLearner(paths.learner)); },
    listSessions() { return listSessions(paths.sessions); },

    // Session references: <id>, unique prefix/suffix/substring, latest, latest~N, latest:<site-substring>.
    session(ref) {
      const list = listSessions(paths.sessions);
      if (!list.length) throw notFound('No sessions recorded yet.', 'Record one with "studio capture <url>" or "studio record".');
      const r = ref === undefined || ref === null || ref === '' ? 'latest' : String(ref);
      const m = /^latest(?:~(\d+))?(?::(.+))?$/.exec(r);
      if (m) {
        const site = m[2]?.toLowerCase();
        const pool = site ? list.filter((s) => siteFromSession(s).includes(site) || String(s.site ?? '').toLowerCase().includes(site) || String(s.target?.url ?? '').toLowerCase().includes(site)) : list;
        const pick = pool[Number(m[1] ?? 0)];
        if (!pick) throw notFound(`No session matches "${r}"${site ? ` (${pool.length} for that site)` : ''}.`, 'List sessions with "studio sessions".');
        return Session.open(paths.sessions, pick.id);
      }
      const exact = list.find((s) => s.id === r);
      if (exact) return Session.open(paths.sessions, exact.id);
      const hits = list.filter((s) => s.id.startsWith(r) || s.id.endsWith(r) || s.id.includes(r));
      if (hits.length === 1) return Session.open(paths.sessions, hits[0].id);
      if (hits.length > 1) throw usageError(`"${r}" matches ${hits.length} sessions: ${hits.slice(0, 5).map((s) => s.id).join(', ')}${hits.length > 5 ? ', …' : ''}.`, 'Use a longer prefix or the full id.');
      throw notFound(`No session "${r}".`, `Newest is ${list[0].id}. List sessions with "studio sessions".`);
    },

    // Profile to derive with: explicit --profile, else the one recorded with the session, else generic.
    profileFor(session, override) {
      const store = ctx.profiles();
      const name = override ?? session.meta.profile?.name ?? 'generic';
      try { return store.load(name); } catch (e) {
        if (override) throw e;
        out.warn(`profile "${name}" is no longer available; deriving with "generic".`);
        return store.load('generic');
      }
    },

    // Derive when outputs are missing (or when forced). Returns the derive result or null if nothing ran.
    async ensureDerived(session, { force = false, profile, need = 'RECEIPT' } = {}) {
      if (!force && session.kv.get(need, null)) return null;
      out.info(`Deriving ${session.id}…`);
      const res = await derive(session, ctx.profileFor(session, profile), {
        families: ctx.families(), learner: ctx.learner(),
        onProgress: (n) => out.progress(`${n} raw records`),
      });
      out.progressDone();
      return res;
    },
  };
  return ctx;
}
