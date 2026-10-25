// Imported conversation detail must project message ids from the addressed LOCAL imported
// conversation id (read-time projection), matching search hit ids. Origin ids stay stored bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { createWorldTransfer } from '../../src/studio/world-transfer.mjs';
import { createWorldSearch } from '../../src/studio/world-search.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';

function world(t, text) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-imported-ids-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete'; session.saveMeta();
  session.kv.set('DOM_TURNS', [{ id: 'observed', role: 'assistant', text, blocks: [{ type: 'future-native', opaque: { marker: text } }] }]);
  return { root, paths, session, service: createWorldService({ paths }) };
}
function bundleOf(service) {
  const cid = service.conversations().items[0].id;
  return createWorldTransfer({ service }).exportSelection({ ids: [cid], includeSources: true });
}
function restore(target, bundle) {
  const transfer = createWorldTransfer({ service: target });
  const validated = transfer.validateBundle({ bundle });
  assert.equal(validated.valid, true);
  const restored = transfer.restoreBundle({ bundle, digest: validated.digest, dryRun: false, confirm: true });
  assert.deepEqual(restored.failed, []);
  return validated;
}

test('imported detail projects local message ids matching search hits; re-export still round-trips', (t) => {
  const source = world(t, 'opal-origin-marker');
  const target = world(t, 'opal-origin-marker'); // observed copy of the same origin text in the receiving world
  restore(target.service, bundleOf(source.service));
  const localId = target.service.conversations({ custody: 'imported' }).items[0].id;
  assert.match(localId, /^c-i[a-f0-9]{38}$/);
  const observedId = target.service.conversations({ custody: 'observed' }).items[0].id;

  const detail = target.service.conversation(localId);
  assert.equal(detail.coverage.state, 'imported-snapshot');
  assert.equal(detail.messages.length, 1, 'stored message count is preserved');
  assert.equal(detail.messages[0].id, `${localId}:turn:0`, 'detail message id derives from the local imported id');
  assert.equal(detail.messages[0].id.startsWith(observedId), false);
  assert.equal(detail.messages[0].source.kind, 'imported-reference');
  assert.equal(detail.messages[0].source.sessionId, null);
  if (typeof detail.messages[0].source.messageId === 'string') assert.equal(detail.messages[0].source.messageId, `${localId}:turn:0`);

  const search = createWorldSearch({ service: target.service }).search;
  const result = search({ q: 'opal-origin-marker' });
  const importedHit = result.items.find((hit) => hit.conversation.id === localId);
  const observedHit = result.items.find((hit) => hit.conversation.id === observedId);
  assert.ok(importedHit, 'imported copy is still searchable');
  assert.ok(observedHit, 'observed copy of the same origin keeps its own searchable identity');
  assert.equal(importedHit.id, `${localId}:turn:0`, 'search hit id and detail message id agree');
  assert.equal(importedHit.source.messageId, detail.messages[0].id);
  assert.equal(observedHit.id.startsWith(observedId), true, 'observed hit id keeps the local observed prefix');
  assert.equal(`${observedId}:turn:0`, observedHit.id);

  // Deterministic read-time projection: identical detail twice, unaffected stored bytes.
  assert.deepEqual(target.service.conversation(localId).messages, detail.messages);

  // Export of an imported conversation emits ids consistent with its own record id and still validates/imports.
  const reExport = createWorldTransfer({ service: target.service }).exportSelection({ ids: [localId], includeSources: true });
  const snapshot = reExport.records.find((record) => record.kind === 'conversation');
  assert.equal(snapshot.custody, 'imported-snapshot');
  assert.equal(snapshot.data.messages[0].id, `${snapshot.id}:turn:0`, 're-export ids follow the record id being exported');
  assert.equal(createWorldTransfer({ service: target.service }).validateBundle({ bundle: reExport }).valid, true);

  const third = world(t, 'third world baseline');
  restore(third.service, reExport);
  const thirdLocal = third.service.conversations({ custody: 'imported' }).items[0].id;
  const thirdDetail = third.service.conversation(thirdLocal);
  assert.equal(thirdDetail.messages[0].id, `${thirdLocal}:turn:0`, 're-imported ids re-derive from the new local id');
  assert.deepEqual(thirdDetail.messages[0].blocks, [{ type: 'future-native', opaque: { marker: 'opal-origin-marker' } }]);
});
