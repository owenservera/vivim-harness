// W12 integrated acceptance journeys — HTTP-contract tests over world/* endpoints.
//
// HONEST SCOPE (fixture level only): every case here runs `startStudio` on an ephemeral
// mkdtemp data dir with a stubbed conversation runtime and hand-seeded saved sessions.
// This is NOT live proof, NOT a browser test and NOT a second-OS-process scenario:
// "second Studio/service instance" below means a second startStudio() call on the SAME
// data directory within this test process. No commit/shipping claim may cite this file.
//
// Journeys:
//   J1  return to a saved conversation after a second Studio instance on the same data dir
//   J2  create project, link conversation + note + selection, unlink
//   J3  search finds the exact message; the hit opens the same item; coverage disclosed;
//       a stale selection is reported stale, not deleted
//   J4  export (references|transcript|full-saved) -> restore into a clean second data dir
//       (dry run, then confirm), idempotent repeat, imported-snapshot labelling in list and
//       search, re-export keeps imported-snapshot, nothing under paths.sessions, account unknown
//   N1  tampered bundle digest rejected            N2  restore without confirm refused
//   N3  active-session source reported unavailable, not deleted
// If any journey fails from a real product defect, it must be recorded as a failing case or
// test.todo with the exact repro — do not patch src from this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

// ---------------- helpers (test-local only) ----------------

const snapshot = (root, prefix = '') => {
  const out = {};
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshot(root, name));
    else out[name] = createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex');
  }
  return out;
};

function fixture(t, tag) {
  const root = mkdtempSync(path.join(os.tmpdir(), `world-j-${tag}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root);
  ensureDataDirs(paths);
  return { tag, root, paths };
}

// Saved-session seed: two turns, one text block on turn 0 and one opaque block on turn 1.
const needleFor = (tag) => `w12${tag}needle`;
function savedSession(paths, tag, { status = 'complete' } = {}) {
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = status;
  session.saveMeta();
  const needle = needleFor(tag);
  // The needle appears ONLY in the turn-0 message text (never in blocks) so message-level
  // search expectations stay unambiguous; turn 1 carries the opaque block used for exports.
  session.kv.set('DOM_TURNS', [
    { id: 'w12-turn-0', role: 'user', text: `question containing ${needle}`, blocks: [{ type: 'text', text: `ask about the topic ${tag}` }] },
    { id: 'w12-turn-1', role: 'assistant', text: `answer turn about the topic`, blocks: [{ type: 'future-native', opaque: { x: 1 } }] },
  ]);
  return { session, needle };
}

const runtimeStub = () => ({ isSessionActive: () => false, close: async () => {}, list: async () => [] });
async function start(paths) {
  return startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, conversationRuntime: runtimeStub() });
}

const HTTP = (studio) => {
  const base = `http://127.0.0.1:${studio.port}/api/v1`;
  return async (method, url, body) => {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
};

// Build the standard linkage through the HTTP contract: object -> selection (part of turn 1)
// -> note (comments on the selection) -> project linking all three plus the conversation.
async function linkProject(call, cid, selection) {
  const project = (await call('POST', '/world/projects', { title: 'Project', expectedVersion: null })).data;
  assert.equal(project.version, 1);
  const object = (await call('POST', '/world/objects', { conversationId: cid, expectedVersion: null })).data;
  const sel = (await call('POST', '/world/selections', {
    objectId: object.id, selectionType: selection.selectionType,
    messageIndex: selection.messageIndex, partPath: selection.partPath, expectedVersion: null,
  })).data;
  const note = (await call('POST', '/world/notes', { title: 'Note', body: 'user note', commentsOn: [sel.id], expectedVersion: null })).data;
  const linked = (await call('PUT', `/world/projects/${project.id}`, {
    conversationIds: [cid], noteIds: [note.id], memberIds: [object.id, sel.id], expectedVersion: project.version,
  })).data;
  assert.deepEqual(linked.conversationIds, [cid]);
  assert.deepEqual(linked.noteIds, [note.id]);
  assert.deepEqual(linked.memberIds, [object.id, sel.id]);
  assert.equal(linked.version, project.version + 1);
  return { project, object, selection: sel, note, linked };
}

// ---------------- J1 ----------------

test('J1: a saved conversation reopens identically through a second Studio instance on the same data dir', async (t) => {
  const f = fixture(t, 'j1');
  const { session, needle } = savedSession(f.paths, 'j1');
  const studio1 = await start(f.paths);
  let listed, opened1;
  try {
    const call = HTTP(studio1);
    const list = await call('GET', '/world/conversations');
    assert.equal(list.status, 200);
    assert.equal(list.data.total, 1);
    listed = list.data.items[0];
    assert.match(listed.id, /^c-[a-f0-9]{40}$/);
    assert.equal(listed.custody, 'observed');
    assert.equal(listed.status, 'complete');
    opened1 = await call('GET', `/world/conversations/${listed.id}`);
    assert.equal(opened1.status, 200);
    assert.equal(opened1.data.messages.length, 2);
    assert.equal(opened1.data.messages[0].text.includes(needle), true);
    assert.equal(opened1.data.coverage.state, 'saved-observation');
    assert.equal(opened1.data.source.kind, 'saved-session');
    assert.equal(opened1.data.source.sessionId, session.id);
    // Account identity stays unknown: saved observation, never a provider/account assertion.
    assert.deepEqual(opened1.data.identity.account, { state: 'unknown', ref: null });
  } finally { await studio1.close(); }

  // Second startStudio() on the SAME data dir (same process; not live multi-process proof).
  const studio2 = await start(f.paths);
  try {
    const call = HTTP(studio2);
    const list = await call('GET', '/world/conversations');
    assert.equal(list.status, 200);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.items[0].id, listed.id);
    const opened2 = await call('GET', `/world/conversations/${listed.id}`);
    assert.equal(opened2.status, 200);
    assert.deepEqual(opened2.data.messages, opened1.data.messages);
    assert.deepEqual(opened2.data.coverage, opened1.data.coverage);
    assert.deepEqual(opened2.data.source, opened1.data.source);
    assert.deepEqual(opened2.data.identity.account, { state: 'unknown', ref: null });
  } finally { await studio2.close(); }
});

// ---------------- J2 ----------------

test('J2: create project, link conversation + note + selection, then unlink', async (t) => {
  const f = fixture(t, 'j2');
  savedSession(f.paths, 'j2');
  const studio = await start(f.paths);
  try {
    const call = HTTP(studio);
    const cid = (await call('GET', '/world/conversations')).data.items[0].id;
    const { project, object, selection, note } = await linkProject(call, cid,
      { selectionType: 'message', messageIndex: 0, partPath: [] });

    const objectView = (await call('GET', `/world/objects/${object.id}`)).data;
    assert.equal(objectView.conversationId, cid);
    assert.equal(objectView.availability, 'locally-available');
    const selectionView = (await call('GET', `/world/selections/${selection.id}`)).data;
    assert.equal(selectionView.objectId, object.id);
    assert.equal(selectionView.availability, 'locally-available');
    const noteView = (await call('GET', `/world/notes/${note.id}`)).data;
    assert.deepEqual(noteView.commentsOn, [selection.id]);

    // The map (read-only projection) shows the AssociationEdges from the project.
    const linkedMap = (await call('GET', `/world/map?id=${project.id}`)).data;
    const outbound = linkedMap.edges.filter((e) => e.from === project.id);
    assert.equal(outbound.length, 4);
    assert.deepEqual(new Set(outbound.map((e) => e.kind)), new Set(['associates']));
    assert.deepEqual(new Set(outbound.flatMap((e) => [e.to])), new Set([cid, note.id, object.id, selection.id]));

    // Unlink: empty member lists; unlink stays possible with the current expectedVersion.
    const unlinked = (await call('PUT', `/world/projects/${project.id}`, {
      conversationIds: [], noteIds: [], memberIds: [], expectedVersion: project.version + 1,
    })).data;
    assert.equal(unlinked.version, project.version + 2);
    assert.deepEqual(unlinked.conversationIds, []);
    assert.deepEqual(unlinked.noteIds, []);
    assert.deepEqual(unlinked.memberIds, []);

    const unlinkedMap = (await call('GET', `/world/map?id=${project.id}`)).data;
    assert.equal(unlinkedMap.edges.filter((e) => e.from === project.id).length, 0);
    assert.deepEqual(unlinkedMap.nodes.map((n) => n.id), [project.id]);
  } finally { await studio.close(); }
});

// ---------------- J3 ----------------

test('J3: search finds the exact message, the hit opens the same item, coverage is disclosed, and a stale selection is reported stale not deleted', async (t) => {
  const f = fixture(t, 'j3');
  const { session, needle } = savedSession(f.paths, 'j3');
  const studio = await start(f.paths);
  try {
    const call = HTTP(studio);
    const cid = (await call('GET', '/world/conversations')).data.items[0].id;
    const { object, selection } = await linkProject(call, cid,
      { selectionType: 'part', messageIndex: 0, partPath: [0] });

    // Search finds the exact message: turn 0 is the only message whose text carries the needle.
    const found = await call('GET', `/world/search?q=${needle}`);
    assert.equal(found.status, 200);
    assert.equal(found.data.total === 1, true);
    const hit = found.data.items[0];
    assert.equal(hit.id, `${cid}:turn:0`);
    assert.equal(hit.kind, 'message');
    assert.equal(hit.custody, 'observed');
    assert.deepEqual(hit.conversation, { id: cid, title: hit.conversation.title });

    // The hit opens the same item through the conversation open endpoint.
    const opened = await call('GET', `/world/conversations/${cid}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.data.messages[0].id, hit.id);
    assert.equal(opened.data.messages[0].text.includes(needle), true);

    // Coverage is disclosed: what was scanned and under which guarantee.
    const coverage = found.data.coverage;
    assert.equal(coverage.complete, true);
    assert.equal(coverage.custody, 'all');
    assert.equal(coverage.scanned.observedConversations, 1);
    assert.equal(coverage.scanned.messages, 2);
    assert.equal(typeof coverage.qualification, 'string');
    assert.ok(coverage.qualification.length > 0);
    assert.deepEqual(coverage.failures, []);

    // Ship an extra turn: the selection's pinned revision no longer matches. It must be
    // REPORTED stale (HTTP 200 + availability), never silently deleted (404) or re-anchored.
    session.kv.set('DOM_TURNS', [...session.kv.get('DOM_TURNS'),
      { id: 'w12-turn-2', role: 'user', text: 'appended evidence', blocks: [] }]);
    const stale = await call('GET', `/world/selections/${selection.id}`);
    assert.equal(stale.status, 200);
    assert.equal(stale.data.availability, 'stale');
    assert.equal(stale.data.availabilityReason, 'REVISION_CHANGED');
    // The stale selection stays searchable: metadata-only content (with the pinned turn id and
    // the stale availability) is indexed, and staleness is disclosed, not deleted.
    const staleHit = await call('GET', `/world/search?q=w12-turn-0&kind=selection`);
    assert.equal(staleHit.status, 200);
    assert.equal(staleHit.data.total, 1);
    const staleRow = staleHit.data.items[0];
    assert.equal(staleRow.id, selection.id);
    assert.equal(staleRow.availability, 'stale');
    assert.equal(staleRow.availabilityReason, 'REVISION_CHANGED');
    // The object address itself stays available: losing revision currency is not deletion.
    const objectView = await call('GET', `/world/objects/${object.id}`);
    assert.equal(objectView.data.availability, 'locally-available');
  } finally { await studio.close(); }
});

// ---------------- J4 ----------------

test('J4: export in each mode, restore into a clean second data dir (dry run then confirm), idempotent repeat, imported-snapshot labels, re-export keeps custody, sessions untouched, account unknown', async (t) => {
  const f = fixture(t, 'j4');
  const { needle } = savedSession(f.paths, 'j4');
  const studio = await start(f.paths);
  const sourceSessionsBefore = snapshot(f.paths.sessions);
  const targets = [];
  try {
    const call = HTTP(studio);
    const cid = (await call('GET', '/world/conversations')).data.items[0].id;
    const { project } = await linkProject(call, cid,
      { selectionType: 'part', messageIndex: 1, partPath: [0] });

    for (const mode of ['references', 'transcript', 'full-saved']) {
      // ---- export from the source instance ----
      const exportRes = await call('POST', '/world/transfer/export', { ids: [project.id], mode });
      assert.equal(exportRes.status, 200);
      const bundle = exportRes.data;
      assert.equal(bundle.schema, 'vivim.world-export/1');
      assert.equal(bundle.coverage.mode, mode);
      assert.ok(/^[a-f0-9]{64}$/.test(bundle.integrity.sha256));
      const conversationRecord = bundle.records.find((r) => r.kind === 'conversation' && r.id === cid);
      assert.ok(conversationRecord, `${mode}: conversation record expected in bundle`);

      if (mode === 'references') {
        assert.equal(conversationRecord.custody, 'referenced-only');
        assert.equal('messages' in conversationRecord.data, false);
        assert.ok(bundle.omitted.some((o) => o.id === cid && o.reason === 'SOURCES_NOT_REQUESTED' && o.expected === true));
        assert.equal(bundle.coverage.sourceSnapshotsIncluded, 0);
      } else {
        assert.equal(conversationRecord.custody, 'saved-observation');
        assert.equal(bundle.coverage.sourceSnapshotsIncluded, 1);
        assert.equal(conversationRecord.data.messages[0].text.includes(needle), true);
        if (mode === 'transcript') {
          assert.deepEqual(conversationRecord.data.messages[1].blocks, []);
          assert.deepEqual(conversationRecord.data.messages[0].blocks, [{ type: 'text', text: `ask about the topic j4` }]);
          assert.ok(bundle.omitted.some((o) => o.id === cid && o.reason === 'non-transcript-blocks-excluded'));
        } else {
          assert.deepEqual(conversationRecord.data.messages[1].blocks, [{ type: 'future-native', opaque: { x: 1 } }]);
        }
      }

      // ---- clean second data dir as restore target ----
      const targetRoot = mkdtempSync(path.join(os.tmpdir(), `world-j-${mode}-target-`));
      t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
      const targetPaths = dataPaths(targetRoot);
      ensureDataDirs(targetPaths);
      targets.push(targetPaths);
      assert.deepEqual(snapshot(targetPaths.sessions), {});
      const target = await start(targetPaths);
      try {
        const targetCall = HTTP(target);
        const validated = await targetCall('POST', '/world/transfer/validate', { bundle });
        assert.equal(validated.status, 200);
        assert.equal(validated.data.valid, true);
        const digest = validated.data.digest;
        assert.ok(/^[a-f0-9]{64}$/.test(digest));
        const localCid = validated.data.idMap[cid];
        assert.match(localCid, /^c-i[a-f0-9]{38}$/);

        // Dry run first: computes the plan, applies nothing, writes nothing.
        const dryRun = await targetCall('POST', '/world/transfer/restore', { bundle, digest, dryRun: true });
        assert.equal(dryRun.status, 200);
        assert.equal(dryRun.data.dryRun, true);
        assert.deepEqual(dryRun.data.applied, []);
        assert.equal(dryRun.data.partial, mode === 'references');
        assert.deepEqual(snapshot(targetPaths.sessions), {});

        // Confirm the restore.
        const restored = await targetCall('POST', '/world/transfer/restore', { bundle, digest, dryRun: false, confirm: true });
        assert.equal(restored.status, 200);
        assert.deepEqual(restored.data.failed, []);
        assert.equal(restored.data.applied.length, mode === 'references' ? 2 : 5);
        assert.equal(restored.data.partial, mode === 'references');
        assert.ok(restored.data.receipt);
        assert.deepEqual(snapshot(targetPaths.sessions), {});
        if (mode === 'references') {
          assert.ok(restored.data.skipped.some((id) => validated.data.idMap[id] === localCid));
        }

        // ---- imported content labelling in list and search ----
        const importedList = await targetCall('GET', '/world/conversations?custody=imported');
        assert.equal(importedList.data.total, mode === 'references' ? 0 : 1);
        if (mode === 'references') {
          // references-only import must not fabricate local content...
          const missing = await targetCall('GET', `/world/conversations/${localCid}`);
          assert.equal(missing.status, 404);
          assert.equal(missing.data.code, 'WORLD_NOT_FOUND');
        } else {
          const item = importedList.data.items[0];
          assert.equal(item.id, localCid);
          assert.equal(item.custody, 'imported');
          assert.deepEqual(item.importedFrom.digest, digest);
          const found = await targetCall('GET', `/world/search?q=${needle}&custody=imported`);
          assert.equal(found.data.total, 1);
          const hit = found.data.items[0];
          // Product provenance shape: an imported message hit id is built from the LOCAL imported
          // conversation id (resolvable in this world, distinct from observed copies); origin ids
          // stay only inside importedFrom. hit.conversation.id is the local import.
          assert.equal(hit.id, `${localCid}:turn:0`);
          assert.equal(hit.custody, 'imported-snapshot');
          assert.equal(hit.contentScope, 'imported-snapshot; not observed');
          assert.equal(hit.source.kind, 'imported-reference');
          assert.equal(hit.source.sessionId, null);
          assert.equal(hit.conversation.id, localCid);
          assert.deepEqual(hit.importedFrom.digest, digest);
          // Message-level provenance stays clean through the HTTP boundary...
          assert.equal(hit.source.sessionId, null);
          assert.equal(Object.hasOwn(hit.source, 'originSessionId'), false);
          // Observation (not a failing case): the imported conversation TITLE carries the
          // capture side's local session-id fallback, because that was already the metadata
          // name inside the source bundle. Restore preserves bundle names verbatim.
          assert.equal(item.title, conversationRecord.data.title);
          const opened = await targetCall('GET', `/world/conversations/${localCid}`);
          assert.equal(opened.status, 200);
          assert.equal(opened.data.coverage.state, 'imported-snapshot');
          assert.deepEqual(opened.data.identity.account, { state: 'unknown', ref: null });
          assert.equal(opened.data.messages[0].text.includes(needle), true);
          if (mode === 'full-saved') {
            assert.deepEqual(opened.data.messages[1].blocks, [{ type: 'future-native', opaque: { x: 1 } }]);
          }
        }
        // The restored project points at the imported/local identity map.
        const localProject = validated.data.idMap[project.id];
        const restoredProject = await targetCall('GET', `/world/projects/${localProject}`);
        assert.equal(restoredProject.status, 200);
        assert.deepEqual(restoredProject.data.conversationIds, [localCid]);
        assert.deepEqual(restoredProject.data.noteIds, [validated.data.idMap[(await call('GET', `/world/projects/${project.id}`)).data.noteIds[0]]]);

        // ---- repeat import is idempotent: no new writes, same tree ----
        const targetTreeBefore = snapshot(targetPaths.root);
        const repeat = await targetCall('POST', '/world/transfer/restore', { bundle, digest, dryRun: false, confirm: true });
        assert.equal(repeat.status, 200);
        assert.deepEqual(repeat.data.applied, []);
        assert.deepEqual(repeat.data.failed, []);
        assert.equal(repeat.data.skipped.length, 5);
        assert.deepEqual(snapshot(targetPaths.root), targetTreeBefore);

        // ---- re-export from the target keeps imported-snapshot custody ----
        if (mode !== 'references') {
          const again = await targetCall('POST', '/world/transfer/export', { ids: [localProject], mode: 'full-saved' });
          assert.equal(again.status, 200);
          const reexported = again.data.records.find((r) => r.kind === 'conversation' && r.id === localCid);
          assert.ok(reexported, 're-export must include the imported conversation snapshot');
          assert.equal(reexported.custody, 'imported-snapshot');
          assert.equal(again.data.coverage.sourceSnapshotsIncluded, 0);
          assert.equal(reexported.data.messages[0].source.kind, 'imported-reference');
          assert.equal(reexported.data.messages[0].source.sessionId, null);
        }
      } finally { await target.close(); }
    }
    // Export/restore wrote nothing under sessions on either side.
    assert.deepEqual(snapshot(f.paths.sessions), sourceSessionsBefore);
  } finally { await studio.close(); }
});

// ---------------- negatives ----------------

async function minimalBundle(call) {
  const project = (await call('POST', '/world/projects', { title: 'Negatives', expectedVersion: null })).data;
  const exported = await call('POST', '/world/transfer/export', { ids: [project.id], mode: 'references' });
  assert.equal(exported.status, 200);
  return exported.data;
}

test('N1: tampered bundle digest is rejected by validate and refused on restore', async (t) => {
  const f = fixture(t, 'tamper');
  savedSession(f.paths, 'tamper');
  const studio = await start(f.paths);
  try {
    const call = HTTP(studio);
    const bundle = await minimalBundle(call);
    const digest = bundle.integrity.sha256;
    bundle.records.find((r) => r.kind === 'project').data.title = 'tampered';
    const validation = await call('POST', '/world/transfer/validate', { bundle });
    assert.equal(validation.status, 200);
    assert.equal(validation.data.valid, false);
    // The recomputed digest is still disclosed; it just no longer matches the shipped one.
    assert.match(validation.data.digest, /^[a-f0-9]{64}$/);
    assert.equal(validation.data.digest === digest, false);
    assert.ok(validation.data.errors.some((e) => e.code === 'WORLD_IMPORT_DIGEST_MISMATCH'));
    assert.ok(validation.data.errors.some((e) => e.code === 'WORLD_IMPORT_RECORD_INTEGRITY'));
    const refused = await call('POST', '/world/transfer/restore', { bundle, digest, dryRun: false, confirm: true });
    assert.equal(refused.status, 400);
    assert.equal(refused.data.code, 'WORLD_IMPORT_DIGEST_MISMATCH');
    // Nothing was imported by the refused restore.
    assert.equal((await call('GET', '/world/projects')).data.total, 1);
  } finally { await studio.close(); }
});

test('N2: restore without confirm is refused; dry run stays the safe default', async (t) => {
  const f = fixture(t, 'confirm');
  savedSession(f.paths, 'confirm');
  const targetRoot = mkdtempSync(path.join(os.tmpdir(), 'world-j-confirm-target-'));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const targetPaths = dataPaths(targetRoot);
  ensureDataDirs(targetPaths);
  const sourceStudio = await start(f.paths);
  const targetStudio = await start(targetPaths);
  try {
    const exportCall = HTTP(sourceStudio);
    const bundle = await minimalBundle(exportCall);
    const validated = await (HTTP(targetStudio))('POST', '/world/transfer/validate', { bundle });
    assert.equal(validated.data.valid, true);
    const digest = validated.data.digest;
    const call = HTTP(targetStudio);
    const refused = await call('POST', '/world/transfer/restore', { bundle, digest, dryRun: false });
    assert.equal(refused.status, 400);
    assert.equal(refused.data.code, 'WORLD_IMPORT_CONFIRMATION_REQUIRED');
    assert.equal((await call('GET', '/world/projects')).data.total, 0);
    // Bare restore (no dryRun, no confirm) computes the dry-run plan only.
    const dry = await call('POST', '/world/transfer/restore', { bundle, digest });
    assert.equal(dry.status, 200);
    assert.equal(dry.data.dryRun, true);
    assert.deepEqual(dry.data.applied, []);
    assert.equal((await call('GET', '/world/projects')).data.total, 0);
    assert.deepEqual(snapshot(targetPaths.sessions), {});
  } finally {
    await sourceStudio.close();
    await targetStudio.close();
  }
});

test('N3: active-session source is reported unavailable and excluded, never deleted; it returns when inactive', async (t) => {
  const f = fixture(t, 'active');
  const conversationIdsOf = (ids) => ids.map((id) => `c-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`);
  const other = savedSession(f.paths, 'active-a');
  const pinned = savedSession(f.paths, 'active-b');
  const studio = await start(f.paths);
  const cid = conversationIdsOf([pinned.session.id])[0];
  try {
    const call = HTTP(studio);
    const cidOther = conversationIdsOf([other.session.id])[0];
    assert.equal((await call('GET', '/world/conversations')).data.total, 2);
    const { object, selection } = await linkProject(call, cid,
      { selectionType: 'part', messageIndex: 0, partPath: [0] });

    // Flip the pinned session to recording: source becomes active.
    pinned.session.meta.status = 'recording';
    pinned.session.saveMeta();
    const list = await call('GET', '/world/conversations');
    assert.equal(list.data.total, 1);
    assert.equal(list.data.items[0].id, cidOther);
    const detail = await call('GET', `/world/conversations/${cid}`);
    assert.equal(detail.status, 409);
    assert.equal(detail.data.code, 'WORLD_SOURCE_ACTIVE');
    const objectView = await call('GET', `/world/objects/${object.id}`);
    assert.equal(objectView.status, 200);
    assert.equal(objectView.data.availability, 'unavailable');
    assert.equal(objectView.data.availabilityReason, 'SOURCE_ACTIVE');
    const selectionView = await call('GET', `/world/selections/${selection.id}`);
    assert.equal(selectionView.status, 200);
    assert.equal(selectionView.data.availability, 'unavailable');
    assert.equal(selectionView.data.availabilityReason, 'SOURCE_ACTIVE');

    // Nothing was deleted: deactivating the source restores availability.
    pinned.session.meta.status = 'complete';
    pinned.session.saveMeta();
    assert.equal((await call('GET', `/world/objects/${object.id}`)).data.availability, 'locally-available');
    assert.equal((await call('GET', `/world/selections/${selection.id}`)).data.availability, 'locally-available');
    assert.equal((await call('GET', `/world/conversations`)).data.total, 2);
  } finally { await studio.close(); }
});
