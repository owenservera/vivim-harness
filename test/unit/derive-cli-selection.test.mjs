// `studio derive --all|--missing` target selection. Synthetic sessions in a temp data dir only: no real
// data, no derive runs for the selection tests, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Session, listSessions } from '../../src/store/session.mjs';
import { STREAM_ROLES_SCHEMA, STREAM_ROLE_CLASSIFIER_VERSION } from '../../src/replay/derive.mjs';
import { buildStreamRoles } from '../../src/replay/stream-role.mjs';
import { selectDeriveTargets } from '../../bin/commands/replay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.join(here, '..', '..', 'bin', 'studio.mjs');

const currentRoles = () => buildStreamRoles([{ sid: 's1', role: 'unknown', roleConfidence: 'none', roleEvidence: [{ feature: 'no_structural_evidence', count: 1 }] }]);
const ROLES = {
  current: () => currentRoles(),
  missing: () => null,
  'older classifier': () => { const d = currentRoles(); return { ...d, classifier: { ...d.classifier, version: STREAM_ROLE_CLASSIFIER_VERSION - 1 } }; },
  'older schema': () => ({ ...currentRoles(), schema: 'capture-studio.stream-roles/0' }),
  'previous generation': () => ({ ...currentRoles(), schema: 'capture-studio.stream-roles/1', classifier: { id: 'stream-role', version: 1 } }),
  errored: () => ({ schema: STREAM_ROLES_SCHEMA, error: 'boom' }),
};

// A session folder written by hand: metadata always, kv only when asked (a recording session must be
// able to exist WITHOUT a kv/ folder so "was it opened" is observable).
function makeSession(sessionsDir, id, { status = 'complete', receipt = true, knowledge = 'complete', roles = null, kv = true, ageMs = 0 } = {}) {
  const dir = path.join(sessionsDir, id);
  mkdirSync(path.join(dir, 'raw'), { recursive: true });
  const meta = path.join(dir, 'session.json');
  writeFileSync(meta, JSON.stringify({ id, site: 'synthetic', createdAt: `2026-01-0${(id.length % 8) + 1}T00:00:00.000Z`, status }, null, 2));
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(meta, t, t); }
  if (kv) {
    mkdirSync(path.join(dir, 'kv'), { recursive: true });
    if (receipt) writeFileSync(path.join(dir, 'kv', 'RECEIPT.json'), JSON.stringify({ verdict: 'x' }));
    if (knowledge) writeFileSync(path.join(dir, 'kv', 'KNOWLEDGE_STATUS.json'), JSON.stringify({ status: knowledge }));
    if (roles) writeFileSync(path.join(dir, 'kv', 'STREAM_ROLES.json'), JSON.stringify(roles));
  }
  return dir;
}

function env(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'derive-select-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  return { root, sessionsDir };
}

// Run the selector and record every id that was opened.
function select(sessionsDir, opts) {
  const opened = [];
  const r = selectDeriveTargets(listSessions(sessionsDir), { ...opts, open: (id) => { opened.push(id); return Session.open(sessionsDir, id); } });
  return { ids: r.targets.map((s) => s.id).sort(), opened: opened.sort(), skipped: r.skipped };
}

function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const st = statSync(p);
      out.push([path.relative(dir, p).split(path.sep).join('/'), e.isDirectory() ? 'dir' : 'file', e.isDirectory() ? 0 : st.size, st.mtimeMs]);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

test('--missing: a complete receipt + knowledge but missing / stale / errored roles IS selected; current roles are skipped', (t) => {
  const { sessionsDir } = env(t);
  for (const [name, make] of Object.entries(ROLES)) makeSession(sessionsDir, `done-${name.replace(/\W+/g, '-')}`, { roles: make() });
  const { ids } = select(sessionsDir, { missing: true });
  assert.deepEqual(ids, [
    'done-errored', 'done-missing', 'done-older-classifier', 'done-older-schema', 'done-previous-generation',
  ]);
  assert.ok(!ids.includes('done-current'));
});

test('--missing: no receipt, or incomplete knowledge, is still selected even with current roles', (t) => {
  const { sessionsDir } = env(t);
  makeSession(sessionsDir, 'no-receipt', { receipt: false, roles: currentRoles() });
  makeSession(sessionsDir, 'knowledge-partial', { knowledge: 'partial', roles: currentRoles() });
  makeSession(sessionsDir, 'never-derived', { kv: false });
  makeSession(sessionsDir, 'all-current', { roles: currentRoles() });
  assert.deepEqual(select(sessionsDir, { missing: true }).ids, ['knowledge-partial', 'never-derived', 'no-receipt']);
});

test('--missing respects --stages: a run without the base stage never requires role work', (t) => {
  const { sessionsDir } = env(t);
  makeSession(sessionsDir, 'stale-roles', { roles: null });
  assert.deepEqual(select(sessionsDir, { missing: true, stages: ['schemas'] }).ids, [], 'schemas only: roles are irrelevant');
  assert.deepEqual(select(sessionsDir, { missing: true, stages: ['schemas', 'revisions'] }).ids, []);
  assert.deepEqual(select(sessionsDir, { missing: true, stages: ['base'] }).ids, ['stale-roles']);
  assert.deepEqual(select(sessionsDir, { missing: true, stages: ['schemas', 'base'] }).ids, ['stale-roles']);
  assert.deepEqual(select(sessionsDir, { missing: true }).ids, ['stale-roles'], 'no --stages means every stage, base included');
  // the pre-existing criteria still apply to non-base runs
  makeSession(sessionsDir, 'no-receipt', { receipt: false, roles: currentRoles() });
  assert.deepEqual(select(sessionsDir, { missing: true, stages: ['schemas'] }).ids, ['no-receipt']);
});

test('--all: every non-recording session is selected regardless of role state', (t) => {
  const { sessionsDir } = env(t);
  makeSession(sessionsDir, 'a-current', { roles: currentRoles() });
  makeSession(sessionsDir, 'b-stale', { roles: null });
  assert.deepEqual(select(sessionsDir, {}).ids, ['a-current', 'b-stale']);
});

test('batches always skip metadata status "recording" (any age, even when stale) and never open it', (t) => {
  const { sessionsDir } = env(t);
  const HOUR = 3600 * 1000;
  // old timestamp: looksActive() would say "not active", the metadata still says recording
  const old = makeSession(sessionsDir, 'rec-old', { status: 'recording', kv: false, ageMs: 24 * HOUR });
  const fresh = makeSession(sessionsDir, 'rec-fresh', { status: 'recording', kv: false });
  const staleRoles = makeSession(sessionsDir, 'rec-stale-roles', { status: 'recording', receipt: false, knowledge: null, kv: false, ageMs: 48 * HOUR });
  makeSession(sessionsDir, 'done', { roles: null });
  const before = [tree(old), tree(fresh), tree(staleRoles)];
  for (const opts of [{ missing: true }, {}, { missing: true, stages: ['base'] }]) {
    const r = select(sessionsDir, opts);
    assert.deepEqual(r.ids, ['done']);
    assert.deepEqual(r.opened, ['done'], 'recording sessions are filtered on metadata, before Session.open can create kv/');
    assert.equal(r.skipped.recording, 3);
  }
  assert.deepEqual([tree(old), tree(fresh), tree(staleRoles)], before, 'nothing under a skipped recording session changed');
  for (const d of [old, fresh, staleRoles]) assert.equal(existsSync(path.join(d, 'kv')), false, 'no kv/ was created');
});

test('--force is the only way a batch includes a recording session', (t) => {
  const { sessionsDir } = env(t);
  makeSession(sessionsDir, 'rec-old', { status: 'recording', kv: false, ageMs: 24 * 3600 * 1000 });
  makeSession(sessionsDir, 'done', { roles: currentRoles() });
  assert.deepEqual(select(sessionsDir, { force: true }).ids, ['done', 'rec-old']);
  assert.deepEqual(select(sessionsDir, { force: true, missing: true }).ids, ['rec-old'], '--missing still filters the up-to-date one');
  assert.deepEqual(select(sessionsDir, { force: false, missing: true }).ids, []);
});

test('metadata that cannot be read is skipped, not opened', (t) => {
  const { sessionsDir } = env(t);
  const dir = path.join(sessionsDir, 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'session.json'), '{ not json');
  makeSession(sessionsDir, 'ok', { roles: null });
  const r = select(sessionsDir, { missing: true });
  assert.deepEqual(r.ids, ['ok']);
  assert.equal(r.skipped.unreadable, 1);
  assert.equal(existsSync(path.join(dir, 'kv')), false);
});

test('CLI: `derive --missing` on a data dir holding only a stale recording and a current session derives nothing and writes nothing', (t) => {
  const { root, sessionsDir } = env(t);
  const dataDir = path.join(root, 'data');
  mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  const rec = makeSession(path.join(dataDir, 'sessions'), 'rec-old', { status: 'recording', receipt: false, knowledge: null, kv: false, ageMs: 24 * 3600 * 1000 });
  const done = makeSession(path.join(dataDir, 'sessions'), 'done-current', { roles: currentRoles() });
  const before = [tree(rec), tree(done)];
  const r = spawnSync(process.execPath, [STUDIO, 'derive', '--missing', '--json', '--data-dir', dataDir], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { derived: [] });
  assert.deepEqual([tree(rec), tree(done)], before, 'neither session folder changed');
  assert.equal(existsSync(path.join(rec, 'kv')), false);
  assert.match(r.stderr, /Skipped 1 session\(s\) that are still recording/);
});

test('explicitly naming a session is not a batch: it is derived even when its metadata says recording, with or without --force', (t) => {
  // Documented semantics: `derive <id>` goes through ctx.session() and derives exactly that session; the
  // batch recording guard does not apply and --force is not needed (and changes nothing).
  const { root } = env(t);
  const dataDir = path.join(root, 'data');
  mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  makeSession(path.join(dataDir, 'sessions'), 'rec-named', { status: 'recording', kv: false, ageMs: 24 * 3600 * 1000 });
  const results = ['', '--force'].map((extra) => {
    const r = spawnSync(process.execPath, [STUDIO, 'derive', 'rec-named', '--json', '--data-dir', dataDir, ...(extra ? [extra] : [])], { encoding: 'utf8', timeout: 180000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.session, 'rec-named');
    return out.ok;
  });
  assert.deepEqual(results, [true, true]);
  assert.equal(existsSync(path.join(dataDir, 'sessions', 'rec-named', 'kv', 'STREAM_ROLES.json')), true, 'the named session was derived (synthetic, empty raw log)');
});
