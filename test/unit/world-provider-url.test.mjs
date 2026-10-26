// Focused regression for the provider-URL leak found by world-import-hardening.test.mjs.
//
// Threat model (fixture level; no live provider, no browser, no HTTP server, no real secret):
// a saved session's meta.target.url can carry a credential-looking query string, userinfo or a
// fragment. That URL used to be projected verbatim into the world (API reads, search hit source,
// relations nodes) and exported verbatim in EVERY export mode. Per the hardening decision the
// world projects providerUrl through a single READ-TIME sanitizer: parse with URL, keep
// http/https origin + pathname only; drop userinfo, query string and fragment; anything
// unparsable or non-http(s) becomes null. Stored session bytes are never rewritten; already-stored
// values are sanitized at projection time; imported bundles are sanitize-and-noted at validate and
// the restored stored record carries the sanitized value.
//
// KNOWN LIMIT (documented, not fixable from stored bytes): the PATH survives. A URL whose secret
// is a path segment cannot be detected locally, so the path is kept for usability and disclosed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stableStringify } from '../../src/intel/similarity.mjs';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { createWorldTransfer } from '../../src/studio/world-transfer.mjs';
import { createWorldSearch } from '../../src/studio/world-search.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';

// Fake fixture values only; nothing here is a real secret.
const TOKEN = 'qwfpgjtoken123';
const TOKEN_URL = `https://chat.example.invalid/session?token=${TOKEN}`;
const USERINFO_URL = 'https://fixtureuser:secretpw@chat.example.invalid/chat/abc?refresh=q#corner';

function targetPaths(t, tag) {
  const targetRoot = mkdtempSync(path.join(os.tmpdir(), `world-purl-${tag}-target-`));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const paths = dataPaths(targetRoot); ensureDataDirs(paths);
  return paths;
}

function fixture(t, tag, url, turns = [{ id: 'purl-0', role: 'user', text: 'needle text', blocks: [] }]) {
  const root = mkdtempSync(path.join(os.tmpdir(), `world-purl-${tag}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete';
  if (url !== undefined && url !== null) session.meta.target = { url, title: 'Provider url fixture' };
  session.saveMeta();
  session.kv.set('DOM_TURNS', turns);
  const world = createWorldService({ paths });
  return { root, paths, session, world, cid: world.conversations().items[0].id };
}

const resign = (bundle) => {
  for (const record of bundle.records ?? []) {
    const { observed, sha256, ...stored } = record;
    record.sha256 = createHash('sha256').update(stableStringify(stored)).digest('hex');
  }
  const { integrity, ...payload } = bundle;
  bundle.integrity = { ...integrity, sha256: createHash('sha256').update(stableStringify(payload)).digest('hex') };
  return bundle;
};

// The sanitizer's contract restated for test expectations.
const expectSanitized = (url) => {
  if (typeof url !== 'string') return null;
  try { const u = new URL(url.trim()); return ['http:', 'https:'].includes(u.protocol) ? u.origin + u.pathname : null; }
  catch { return null; }
};

test('saved url with a credential-looking query is projected as origin+pathname in every world read and in every export mode; the serialized bundle carries no token; stored session bytes keep the original url', (t) => {
  const f = fixture(t, 'query', TOKEN_URL), { cid, world, paths } = f;
  const expected = expectSanitized(TOKEN_URL);
  assert.equal(expected, 'https://chat.example.invalid/session');
  for (const read of [world.conversation(cid), world.conversationMetadata(cid), world.conversations().items[0]]) {
    assert.equal(read.source.providerUrl, expected);
    assert.equal(JSON.stringify(read).includes(TOKEN), false);
  }
  assert.equal(world.conversations({ custody: 'all' }).items[0].source.providerUrl, expected);
  // Stored bytes: the token still lives in session.json — sanitization is projection-time only.
  const sessionDir = readdirSync(paths.sessions).find((name) => name === f.session.id);
  assert.ok(readFileSync(path.join(paths.sessions, sessionDir, 'session.json'), 'utf8').includes(TOKEN),
    'session.json must not be rewritten');
  for (const mode of ['references', 'transcript', 'full-saved']) {
    const project = world.updateProject(world.createProject({ title: 'P', expectedVersion: null }).id,
      { expectedVersion: 1, conversationIds: [cid] });
    const bundle = createWorldTransfer({ service: world }).exportSelection({ ids: [project.id], mode });
    const conv = bundle.records.find((r) => r.kind === 'conversation');
    assert.equal(conv.data.source.providerUrl, expected, `mode ${mode}`);
    assert.equal(JSON.stringify(bundle).includes(TOKEN), false, `token query leaked in ${mode}`);
  }
});

test('userinfo, query and fragment are dropped while origin + pathname survive; non-http(s), unparsable, empty and missing urls project as null', (t) => {
  const f = fixture(t, 'userinfo', USERINFO_URL);
  assert.equal(f.world.conversations().items[0].source.providerUrl, 'https://chat.example.invalid/chat/abc');
  for (const url of ['ftp://host/file', 'javascript:alert(1)', 'not a url', '', '   ']) {
    const g = fixture(t, 'odd', 'https://read.test/x');
    // Overwrite the stored url through the store API used by every other consumer, then read.
    g.session.meta.target = { url }; g.session.saveMeta();
    assert.equal(g.world.conversations().items[0].source.providerUrl, expectSanitized(url), `case ${JSON.stringify(url)}`);
  }
  const g = fixture(t, 'missing');
  assert.equal(g.world.conversations().items[0].source.providerUrl, null, 'missing target url');
});

test('already-stored values are sanitized at projection time: a session written before the hardening reads clean and still never rewrites its stored bytes', (t) => {
  const f = fixture(t, 'legacy', TOKEN_URL);
  assert.equal(f.world.conversations().items[0].source.providerUrl, expectSanitized(TOKEN_URL));
  const sessionDir = readdirSync(f.paths.sessions).find((name) => name === f.session.id);
  assert.ok(readFileSync(path.join(f.paths.sessions, sessionDir, 'session.json'), 'utf8').includes(TOKEN));
});

test('search hit source and relations map nodes carry the sanitized provider url, not the stored one', (t) => {
  const f = fixture(t, 'search', TOKEN_URL), { cid, world } = f;
  const object = world.createObject({ conversationId: cid, expectedVersion: null });
  const search = createWorldSearch({ service: world }).search;
  const refs = search({ q: object.id, kind: 'source-reference' });
  assert.equal(refs.total, 1);
  assert.equal(refs.items[0].source.providerUrl, expectSanitized(TOKEN_URL));
  assert.equal(JSON.stringify(refs.items[0]).includes(TOKEN), false);
  const node = world.map({ limit: 1000 }).nodes.find((n) => n.id === object.id);
  assert.equal(node.source.providerUrl, expectSanitized(TOKEN_URL));
  assert.equal(JSON.stringify(world.map({ limit: 1000 })).includes(TOKEN), false);
});

test('export digest determinism holds after sanitization: two exports of the same source produce the same integrity hash and identical providerUrl', (t) => {
  const f = fixture(t, 'determinism', TOKEN_URL), { cid, world } = f;
  const note = world.writeNote(null, { title: 'n', body: 'b', expectedVersion: null });
  const project = world.updateProject(world.createProject({ title: 'P', expectedVersion: null }).id,
    { expectedVersion: 1, conversationIds: [cid], noteIds: [note.id] });
  const transfer = createWorldTransfer({ service: world });
  const a = transfer.exportSelection({ ids: [project.id], mode: 'full-saved' });
  const b = transfer.exportSelection({ ids: [project.id], mode: 'full-saved' });
  assert.equal(a.integrity.sha256, b.integrity.sha256);
  assert.equal(a.records.find((r) => r.kind === 'conversation').data.source.providerUrl, expectSanitized(TOKEN_URL));
});

test('imported bundles carrying a dirty providerUrl are sanitize-and-NOTED at validate and the restored record keeps the sanitized value; clean bundles stay silent', (t) => {
  const f = fixture(t, 'import', TOKEN_URL), { cid, world } = f;
  const note = world.writeNote(null, { title: 'n', body: 'b', expectedVersion: null });
  const project = world.updateProject(world.createProject({ title: 'P', expectedVersion: null }).id,
    { expectedVersion: 1, conversationIds: [cid], noteIds: [note.id] });
  const bundle = createWorldTransfer({ service: world }).exportSelection({ ids: [project.id], mode: 'full-saved' });
  const target = createWorldService({ paths: targetPaths(t, 'import') });
  const transfer = createWorldTransfer({ service: target });
  // CLEAN bundle (post-fix export): validate stays silent about providerUrl.
  const cleanReport = transfer.validateBundle({ bundle });
  assert.equal(cleanReport.valid, true);
  assert.deepEqual(cleanReport.omitted.filter((o) => String(o.reason).startsWith('provider-url-')), []);
  // DIRTY bundle: hand-edit the conversation record's providerUrl into a credential-looking url.
  const dirty = structuredClone(bundle);
  dirty.records.find((r) => r.kind === 'conversation').data.source.providerUrl = TOKEN_URL;
  resign(dirty);
  const report = transfer.validateBundle({ bundle: dirty });
  assert.equal(report.valid, true, 'sanitize-and-note, not reject');
  const noted = report.omitted.filter((o) => String(o.reason).startsWith('provider-url-'));
  assert.equal(noted.length, 1);
  assert.deepEqual({ ...noted[0] }, { id: cid, reason: 'provider-url-query-removed', aspect: 'source', expected: true, count: 1 });
  assert.equal(report.counts.providerUrlSanitized, 1);
  assert.deepEqual(report.providerUrlSanitized, [cid], 'report names the sanitized original id');
  const restored = transfer.restoreBundle({ bundle: dirty, digest: report.digest, dryRun: false, confirm: true });
  assert.equal(restored.applied.length, 3); // conversation + note + project closure
  assert.deepEqual(restored.failed, []);
  const localCid = report.idMap[cid];
  const stored = target.loadImportRecord(localCid);
  assert.equal(stored.source.providerUrl, expectSanitized(TOKEN_URL), 'restored bytes are sanitized');
  assert.equal(target.conversation(localCid).source.providerUrl, expectSanitized(TOKEN_URL));
  assert.equal(target.conversations({ custody: 'imported' }).items[0].source.providerUrl, expectSanitized(TOKEN_URL));
  assert.equal(JSON.stringify(target.conversations({ custody: 'all' })).includes(TOKEN), false);
  // Re-import of the same dirty bundle is the honest skip (digest-scoped id, already applied).
  const again = transfer.restoreBundle({ bundle: dirty, digest: report.digest, dryRun: false, confirm: true });
  assert.deepEqual(again.applied, []);
  assert.equal(again.skipped.length, 3);
});
