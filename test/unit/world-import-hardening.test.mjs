// World import/export hardening — fixture-level (T0) gap-closers for docs/FORMAL-TEST-PREP.md gaps 3 and 4.
//
// HONEST SCOPE (fixture level only): every case runs in-process against mkdtemp data dirs with
// hand-seeded saved sessions (fixture pattern copied from world-restore.test.mjs). This is NOT
// live proof, NOT a browser test, NOT an HTTP-contract test (no startStudio) and NOT a secret
// program: all "secret" strings are fake fixture values. No commit/shipping claim may cite this file.
//
// Covered per the code at HEAD (do not patch src from this file; behaviors are asserted as-is):
//
// Gap 3 (conflicting import / changed bundle): import identity is scoped by BUNDLE DIGEST —
//   local id = hash([bundleDigest, originalId]) (src/studio/world-transfer.mjs localId). A second
//   bundle with the same ORIGINAL ids but changed content — or identical record content under a
//   different bundle digest — therefore maps to fresh local ids: both copies coexist, prior stored
//   bytes are untouched (service.importRecord is CAS-null-on-create, expectedVersion:null), and
//   receipts are per-digest. Idempotent re-restore of a digest whose records all exist skips every
//   record. The WORLD_IMPORT_COLLISION guard only fires when a local id was pre-occupied with a
//   different importedFrom (a state plain restore cannot produce; asserted below via importRecord).
//   There is NO 409 path for collisions in the direct service path: the guard is thrown per record,
//   caught, and surfaced as a per-record failed[] entry with partial:true (fail() would even carry
//   status 400, not 409, and the HTTP route returns 200 with the failed[] inside the plan).
//
// Gap 4 (bundle secret scan): there is NO content scanner. Export excludes by construction only
//   (scope.exclusions) and coverage qualification states plainly: "Selected content is not
//   automatically redacted." (plus the providerUrl projection clause). The tests below name the
//   honest current behavior: references carries no message content (so no message-level markers),
//   transcript and full-saved carry message text and kept blocks VERBATIM, secret-looking strings
//   in MESSAGE CONTENT remain included — no redaction exists for message text or block contents.
//   providerUrl (saved meta.target.url) is the one hardening that DID land (2026-10): it is
//   projected through a single read-time sanitizer (src/studio/world-url.mjs) — http/https
//   origin+pathname only; userinfo, query strings and fragments are dropped; unparsable or
//   non-http(s) urls project as null; the pathname itself is kept (a secret that is a path segment
//   cannot be detected from stored bytes). Applied on every API read, in search hit source,
//   relations nodes, export and import (sanitize-and-note at validate, sanitized write at restore).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stableStringify } from '../../src/intel/similarity.mjs';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { createWorldTransfer } from '../../src/studio/world-transfer.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';

// ---------------- fixture helpers (test-local only) ----------------

const resign = (bundle) => {
  // Recompute record + bundle integrity after fixture edits (same math as world-restore.test.mjs).
  for (const record of bundle.records ?? []) {
    const { observed, sha256, ...stored } = record;
    record.sha256 = createHash('sha256').update(stableStringify(stored)).digest('hex');
  }
  const { integrity, ...payload } = bundle;
  bundle.integrity = { ...integrity, sha256: createHash('sha256').update(stableStringify(payload)).digest('hex') };
  return bundle;
};

function targetDirs(t, tag) {
  const targetRoot = mkdtempSync(path.join(os.tmpdir(), `world-imp-sec-${tag}-target-`));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const targetPaths = dataPaths(targetRoot);
  ensureDataDirs(targetPaths);
  return targetPaths;
}

function fixture(t, tag, { turns, targetUrl } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), `world-imp-sec-${tag}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root);
  ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete';
  if (targetUrl !== undefined) session.meta.target = { url: targetUrl, title: 'Fixture secret round trip' };
  session.kv.set('DOM_TURNS', turns ?? [
    { id: 'hard-0', role: 'user', text: 'first question about the topic', blocks: [{ type: 'text', text: 'block for the selection part' }] },
    { id: 'hard-1', role: 'assistant', text: 'answer', blocks: [{ type: 'future-native', opaque: { x: 1 } }] },
  ]);
  session.saveMeta();
  const source = createWorldService({ paths });
  const cid = source.conversations().items[0].id;
  const object = source.createObject({ conversationId: cid, expectedVersion: null });
  const selection = source.createSelection({ objectId: object.id, selectionType: 'part', messageIndex: 0, partPath: [0], expectedVersion: null });
  const note = source.writeNote(null, { title: 'Note', body: 'user', commentsOn: [selection.id], expectedVersion: null });
  let project = source.createProject({ title: 'Project', expectedVersion: null });
  project = source.updateProject(project.id, { expectedVersion: 1, conversationIds: [cid], noteIds: [note.id], memberIds: [object.id, selection.id] });
  const sourceTransfer = createWorldTransfer({ service: source });
  const bundle = sourceTransfer.exportSelection({ ids: [project.id], mode: 'full-saved' });
  return { paths, source, sourceTransfer, bundle, cid, projectId: project.id,
    targetPaths: targetDirs(t, tag), target: null, recs: () => {
      return { cid, oid: object.id, sid: selection.id, nid: note.id, pid: project.id };
    } };
}

const withTarget = (f) => { f.target ??= createWorldService({ paths: f.targetPaths }); return f.target; };

function importBundle(target, bundle) {
  const transfer = createWorldTransfer({ service: target });
  const report = transfer.validateBundle({ bundle });
  assert.equal(report.valid, true);
  const result = transfer.restoreBundle({ bundle, digest: report.digest, dryRun: false, confirm: true });
  return { report, result, ids: report.idMap, digest: report.digest };
}

const receiptOf = (target, digest) => target.loadImportRecord(`i-${digest.slice(0, 40)}`);

// A bundle marker scan over serialized bytes; backslash normalization so Windows paths are found
// whether they are escaped once (JSON) or represent single backslashes in memory.
const bundleContains = (bundle, marker) => JSON.stringify(bundle).replaceAll('\\\\', '\\').includes(marker);

// ---------------- gap 3: conflicting import / changed bundle under the same original ids ----------------

test('conflicting import: same original ids with changed content import as a SECOND distinct set — nothing first-imported is overwritten, receipts stay honest, re-restore of either bundle skips cleanly', (t) => {
  const f = fixture(t, 'changed-sibling'), target = withTarget(f), { cid, nid } = f.recs();
  const first = importBundle(target, f.bundle);
  assert.equal(first.result.partial, false);
  assert.deepEqual(first.result.failed, []);
  const ids1 = first.ids;
  const beforeFirst = new Map(Object.entries(ids1).map(([orig, local]) => [orig, target.loadImportRecord(local)]));

  // SECOND bundle: same original ids, changed note body and changed message text.
  const changed = structuredClone(f.bundle);
  changed.records.find((r) => r.kind === 'note').data.body = 'changed body';
  changed.records.find((r) => r.kind === 'conversation').data.messages[0].text = 'changed question';
  resign(changed);
  const second = importBundle(target, changed);
  assert.equal(second.digest !== first.digest, true);
  assert.equal(second.result.applied.length, 5);
  assert.deepEqual(second.result.skipped, []);
  assert.deepEqual(second.result.failed, []);
  assert.equal(second.result.partial, false);
  // Fresh local ids for every original id: no collision, no overwrite address overlap.
  const values1 = new Set(Object.values(ids1));
  assert.equal(Object.values(second.ids).every((id) => !values1.has(id)), true);

  // Nothing overwritten: every first-import stored record keeps its exact bytes.
  for (const [orig, rec] of beforeFirst) assert.deepEqual(target.loadImportRecord(ids1[orig]), rec);

  // Both copies coexist as distinct imports with honest per-digest provenance.
  const convOrig = f.bundle.records.find((r) => r.kind === 'conversation').id;
  assert.deepEqual(target.notes().items.map((n) => n.id).sort(), [ids1[nid], second.ids[nid]].sort());
  assert.equal(target.conversations({ custody: 'imported' }).total, 2);
  assert.deepEqual(new Set(target.conversations({ custody: 'imported' }).items.map((i) => i.importedFrom.digest)),
    new Set([first.digest, second.digest]));
  assert.equal(target.conversation(second.ids[convOrig]).messages[0].text, 'changed question');
  assert.equal(target.conversation(ids1[convOrig]).messages[0].text, 'first question about the topic');

  // Receipts honest: one per digest, naming exactly its own import outcome.
  const receipt1 = receiptOf(target, first.digest), receipt2 = receiptOf(target, second.digest);
  assert.equal(receipt1.id !== receipt2.id, true);
  assert.equal(receipt1.digest, first.digest);
  assert.equal(receipt2.digest, second.digest);
  assert.deepEqual(receipt1.failed, []);
  assert.deepEqual(receipt2.failed, []);
  assert.deepEqual(receipt1.skipped, []);
  assert.deepEqual(receipt2.skipped, []);
  assert.equal(receipt1.partial, false);
  assert.equal(receipt2.partial, false);

  // Idempotent re-restore of EITHER bundle: digest-scoped skips, no rewrites.
  for (const bundle of [f.bundle, changed]) {
    const again = importBundle(target, bundle);
    assert.deepEqual(again.result.applied, []);
    assert.deepEqual(new Set(again.result.skipped), new Set(bundle.records.map((r) => r.id)));
    assert.equal(again.result.partial, false);
    for (const [orig, rec] of beforeFirst) assert.deepEqual(target.loadImportRecord(ids1[orig]), rec);
  }
});

test('same record content under a DIFFERENT bundle digest imports as a second distinct copy — import identity is digest-scoped, record content alone cannot collide and cannot dedupe', (t) => {
  const f = fixture(t, 'repackaged'), target = withTarget(f), { cid, nid } = f.recs();
  const first = importBundle(target, f.bundle);
  // Identical records, different bundle digest (coverage annotation only; no record changes).
  const repacked = structuredClone(f.bundle);
  repacked.coverage.qualification = `${repacked.coverage.qualification} fixture-note: repackaged without record changes.`;
  resign(repacked);
  const third = importBundle(target, repacked);
  assert.equal(third.digest !== first.digest, true);
  assert.equal(third.result.applied.length, 5);
  assert.deepEqual(third.result.failed, []);
  assert.equal(third.result.partial, false);
  const values1 = new Set(Object.values(first.ids));
  assert.equal(Object.values(third.ids).every((id) => !values1.has(id)), true);

  // Same content: the two conversation copies store byte-identical message projections; the note
  // bodies are equal. (imported From differs by digest — asserted on the conversation record level.)
  const convOrig = f.bundle.records.find((r) => r.kind === 'conversation').id;
  assert.deepEqual(target.loadImportRecord(third.ids[convOrig]).messages, target.loadImportRecord(first.ids[convOrig]).messages);
  assert.equal(target.loadImportRecord(third.ids[nid]).body, 'user');
  assert.equal(target.loadImportRecord(first.ids[nid]).body, 'user');
  assert.equal(target.conversations({ custody: 'imported' }).total, 2);
  assert.equal(target.conversations({ custody: 'imported' }).items[0].id !== target.conversations({ custody: 'imported' }).items[1].id, true);
  assert.deepEqual(new Set(target.conversations({ custody: 'imported' }).items.map((i) => i.importedFrom.digest)),
    new Set([first.digest, third.digest]));
});

test('WORLD_IMPORT_COLLISION is a per-record failure (surfaced in the restore plan with failed[] and partial true — no 409 path exists): the occupied local id is never overwritten and the receipt honestly records the collision', (t) => {
  const f = fixture(t, 'collision'), target = withTarget(f), { nid } = f.recs();
  const transfer = createWorldTransfer({ service: target });
  const report = transfer.validateBundle({ bundle: f.bundle });
  assert.equal(report.valid, true);
  const noteOrig = f.bundle.records.find((r) => r.kind === 'note').id;
  const occupied = report.idMap[nid];
  // Pre-occupy the note's local id with a DIFFERENT importedFrom. Plain restore alone cannot
  // produce this state (local ids are digest-scoped and created with CAS null); the seed stands
  // for an out-of-band/corrupt occupancy.
  const seeded = { id: occupied, kind: 'note', title: 'Occupied', body: 'different content',
    importedFrom: { digest: '0'.repeat(64), originalId: noteOrig, namespaceId: 'w-fixture-other' } };
  target.importRecord(occupied, seeded);
  const occupiedSnapshot = target.loadImportRecord(occupied);

  // Restore order is conversation -> source-reference -> selection -> project -> note, so the four
  // non-confirmed records apply and only the occupied note fails as a PER-RECORD entry.
  const result = transfer.restoreBundle({ bundle: f.bundle, digest: report.digest, dryRun: false, confirm: true });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, noteOrig);
  assert.equal(result.failed[0].code, 'WORLD_IMPORT_COLLISION');
  assert.equal(result.partial, true);
  assert.equal(result.applied.length, 4);
  assert.equal(new Set(result.applied).has(noteOrig), false);
  assert.deepEqual(result.skipped, []); // the non-note records applied; nothing skipped

  // The occupied record keeps its exact bytes; the bundle's note content never overwrote it.
  assert.deepEqual(target.loadImportRecord(occupied), occupiedSnapshot);

  // The receipt for this digest IS this run (first-write): it honestly carries the collision.
  const receipt = receiptOf(target, report.digest);
  assert.equal(receipt.digest, report.digest);
  assert.equal(receipt.partial, true);
  assert.deepEqual(receipt.failed, result.failed);
  assert.equal(result.receipt, `i-${report.digest.slice(0, 40)}`);
});

test('conflicting-import gap: a project imported while its conversation is omitted (referenced-only) stays dangling; a later import of the same original conversation does NOT silently rebind the project or fabricate content at the dangling address', (t) => {
  const f = fixture(t, 'omitted-later'), target = withTarget(f), { cid, oid, sid, nid, pid } = f.recs();
  // 1) references-only bundle: conversation omitted by construction (metadata only).
  const references = f.sourceTransfer.exportSelection({ ids: [pid], mode: 'references' });
  const first = importBundle(target, references);
  const reasons = first.report.unresolved.map((u) => u.reason);
  assert.equal(reasons.includes('REFERENCE_ONLY'), true);
  assert.equal(reasons.includes('DEPENDENT_SKIPPED'), true);
  assert.equal(first.result.partial, true);
  assert.deepEqual(first.result.failed, []);
  assert.equal(first.result.applied.length, 2); // project + note only
  const { [cid]: cLocal1, [oid]: oLocal1, [sid]: sLocal1, [pid]: pLocal1, [nid]: nLocal1 } = first.ids;
  assert.deepEqual(new Set(first.result.skipped), new Set([cid, oid, sid]));
  // The omitted conversation (and its dependents) do NOT exist locally.
  assert.equal(target.loadImportRecord(cLocal1), null);
  assert.equal(target.loadImportRecord(oLocal1), null);
  assert.equal(target.loadImportRecord(sLocal1), null);
  // The imported project and note honestly point at addresses with NO stored record.
  const project1Snapshot = target.loadImportRecord(pLocal1);
  assert.deepEqual(project1Snapshot.conversationIds, [cLocal1]);
  assert.deepEqual(target.loadImportRecord(nLocal1).commentsOn, [sLocal1]);
  assert.throws(() => target.conversation(cLocal1), (e) => e.code === 'WORLD_NOT_FOUND');

  // 2) later: a second bundle carries the SAME original conversation id with real content.
  const second = importBundle(target, f.bundle); // full-saved bundle from the same source project
  assert.equal(second.result.partial, false);
  assert.deepEqual(second.result.failed, []);
  const cLocal2 = second.ids[cid];
  assert.equal(cLocal2 !== cLocal1, true);
  // The dangling address was NOT silently satisfied and the import did not rebind anything:
  assert.equal(target.loadImportRecord(cLocal1), null);
  assert.throws(() => target.conversation(cLocal1), (e) => e.code === 'WORLD_NOT_FOUND');
  assert.equal(target.conversation(cLocal2).coverage.state, 'imported-snapshot');
  assert.deepEqual(target.loadImportRecord(pLocal1), project1Snapshot); // stored bytes unchanged
  assert.deepEqual(target.loadImportRecord(pLocal1).conversationIds, [cLocal1]);
  // The second bundle's own project points at ITS digest-derived conversation copy:
  assert.deepEqual(target.loadImportRecord(second.ids[pid]).conversationIds, [cLocal2]);
  assert.deepEqual(target.conversations({ custody: 'imported' }).items.map((i) => i.id), [cLocal2]);
});

// ---------------- gap 4: bundle secret scan (there is no scanner) ----------------

// Realistic-looking but fully fake fixture values; the header above discloses that no real secret
// is used anywhere in this file.
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.FAKEFIXTURESIGNATURE';
const SK = 'sk-fixture-4f4e4b4a494847464544434241403f3e';
const COOKIE = 'Cookie: sessionid=deadd00dbeefcafe; csrftoken=abcdef0123456789';
const PRIVKEY = '-----BEGIN PRIVATE KEY-----MIIEvQFixtureOnlyNotARealKey-----END PRIVATE KEY-----';
const WINPATH = 'C:\\Users\\fixture-user\\AppData\\Local\\AION\\capture-studio';
const TOKEN_URL = 'https://chat.example.invalid/session?token=qwfpgjtoken123';

function secretFixture(t) {
  const textBlock = { type: 'text', text: `setup log\n${COOKIE}\n${WINPATH}` };
  const opaqueBlock = { type: 'key_backup', opaque: { pem: PRIVKEY } };
  return fixture(t, 'secret', {
    targetUrl: TOKEN_URL,
    turns: [
      { id: 'sec-0', role: 'user', text: `authorize with ${BEARER} and dashboard key ${SK} from ${WINPATH}`,
        blocks: [structuredClone(textBlock), structuredClone(opaqueBlock)] },
      { id: 'sec-1', role: 'assistant', text: 'fixture answer', blocks: [{ type: 'future-native', opaque: { note: COOKIE } }] },
    ],
  });
}

test('no secret scan exists: references export excludes message content by construction and carries NONE of the fixture secret markers — metadata-only is an omission, not a redaction guarantee', (t) => {
  const f = secretFixture(t), { cid, pid } = f.recs();
  const bundle = f.sourceTransfer.exportSelection({ ids: [pid], mode: 'references' });
  const conv = bundle.records.find((r) => r.kind === 'conversation' && r.id === cid);
  assert.equal(conv.custody, 'referenced-only');
  assert.equal('messages' in conv.data, false);
  for (const marker of [BEARER, SK, COOKIE, PRIVKEY, WINPATH]) {
    assert.equal(bundleContains(bundle, marker), false, `references must not carry ${marker.slice(0, 24)}`);
  }
  assert.ok(bundle.omitted.some((o) => o.id === cid && o.reason === 'SOURCES_NOT_REQUESTED' && o.expected === true));
  assert.equal(bundle.coverage.sourceSnapshotsIncluded, 0);
  // The bundle discloses the absence of redaction honestly:
  assert.ok(bundle.coverage.qualification.includes('Selected content is not automatically redacted.'));
});

test('transcript export carries message text verbatim including secret-looking strings: no redaction exists — non-transcript block exclusion is by block TYPE only, not by content', (t) => {
  const f = secretFixture(t), { cid, pid } = f.recs();
  const bundle = f.sourceTransfer.exportSelection({ ids: [pid], mode: 'transcript' });
  const conv = bundle.records.find((r) => r.kind === 'conversation' && r.id === cid);
  const m0 = conv.data.messages[0];
  assert.ok(m0.text.includes(BEARER));
  assert.ok(m0.text.includes(SK));
  assert.ok(bundleContains(bundle, WINPATH)); // local absolute path rides in message text
  assert.ok(bundleContains(bundle, COOKIE)); // rides in the surviving transcript text block
  // The opaque key_backup block is excluded (type-based), so the fake private key does not ship.
  assert.equal(bundleContains(bundle, PRIVKEY), false);
  assert.deepEqual(m0.blocks, [{ type: 'text', text: `setup log\n${COOKIE}\n${WINPATH}` }]);
  assert.deepEqual(conv.data.messages[1].blocks, []);
  const pruned = bundle.omitted.filter((o) => o.reason === 'non-transcript-blocks-excluded');
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].id, cid);
  assert.equal(pruned[0].count, 2); // key_backup + future-native
});

test('full-saved export carries message content verbatim including secret-looking strings: no redaction exists', (t) => {
  const f = secretFixture(t), { cid, pid } = f.recs();
  const bundle = f.sourceTransfer.exportSelection({ ids: [pid], mode: 'full-saved' });
  const conv = bundle.records.find((r) => r.kind === 'conversation' && r.id === cid);
  assert.equal(conv.custody, 'saved-observation');
  for (const marker of [BEARER, SK, COOKIE, PRIVKEY, WINPATH]) {
    assert.equal(bundleContains(bundle, marker), true, `full-saved verbatim carriage of ${marker.slice(0, 24)}`);
  }
  assert.deepEqual(conv.data.messages[0].blocks,
    [{ type: 'text', text: `setup log\n${COOKIE}\n${WINPATH}` }, { type: 'key_backup', opaque: { pem: PRIVKEY } }]);
  assert.deepEqual(conv.data.messages[1].blocks, [{ type: 'future-native', opaque: { note: COOKIE } }]);
  assert.equal(bundle.coverage.sourceSnapshotsIncluded, 1);
});

test('REGRESSION (hardened 2026-10, see test/unit/world-provider-url.test.mjs): a credential-looking query string in the saved provider url no longer reaches ANY export mode — the world projects providerUrl as http/https origin+pathname only; userinfo, query strings and fragments are dropped at read time (single sanitizer src/studio/world-url.mjs); stored session bytes keep the original value and the pathname itself is kept, which is the documented limit', (t) => {
  const f = secretFixture(t), { cid, pid } = f.recs();
  for (const mode of ['references', 'transcript', 'full-saved']) {
    const bundle = f.sourceTransfer.exportSelection({ ids: [pid], mode });
    const conv = bundle.records.find((r) => r.kind === 'conversation' && r.id === cid);
    assert.equal(conv.data.source.providerUrl, 'https://chat.example.invalid/session');
    assert.equal(bundleContains(bundle, 'qwfpgjtoken123'), false, `token query leaked in ${mode}`);
    assert.equal(bundleContains(bundle, 'https://chat.example.invalid/session'), true, `clean url kept in ${mode}`);
  }
  // Message-level markers stay untouched: the hardening is providerUrl-only, no content scanner
  // (full-saved with the KEPT transcript block still rides COOKIE verbatim).
  const fullVacuum = f.sourceTransfer.exportSelection({ ids: [pid], mode: 'full-saved' });
  const convFull = fullVacuum.records.find((r) => r.kind === 'conversation' && r.id === cid);
  assert.equal(convFull.data.source.providerUrl, 'https://chat.example.invalid/session');
  assert.equal(bundleContains(fullVacuum, COOKIE), true, 'no message-text redaction was added');
});
