import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { createWorldTransfer } from '../../src/studio/world-transfer.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';

const blocks = [
  { type: 'paragraph', text: 'visible' },
  { type: 'code', language: 'js', text: 'const a = 1' },
  { type: 'table', headers: ['A'], rows: [['1']] },
  { type: 'reasoning', text: 'hidden-thought' },
  { type: 'tool', name: 'search', input: { q: 'x' } },
  { type: 'status', text: 'running' },
  { type: 'future-native', opaque: { kept: true } },
];
function world(t, status = 'complete') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-export-mode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = status; session.saveMeta();
  session.kv.set('DOM_TURNS', [{ role: 'assistant', text: 'answer', blocks }]);
  const service = createWorldService({ paths });
  return { service, id: service.conversations().items[0].id, transfer: createWorldTransfer({ service }) };
}
const conversation = (bundle) => bundle.records.find((record) => record.kind === 'conversation');
const types = (bundle) => conversation(bundle).data.messages[0].blocks.map((block) => block.type);

test('invalid export mode or parts is rejected before any world read', () => {
  let reads = 0;
  const transfer = createWorldTransfer({ service: new Proxy({}, { get: () => () => { reads++; return {}; } }) });
  assert.throws(() => transfer.exportSelection({ ids: ['c-' + 'a'.repeat(40)], mode: 'everything' }), { status: 400, code: 'WORLD_EXPORT_INVALID_INPUT' });
  assert.throws(() => transfer.exportSelection({ ids: ['c-' + 'a'.repeat(40)], mode: 'transcript', parts: { reasoning: 'yes' } }), { status: 400 });
  assert.equal(reads, 0);
});

test('references, transcript and full-saved export modes round-trip through validate and restore', (t) => {
  const source = world(t);
  const cases = {
    references: { request: { mode: 'references' }, text: false, types: [] },
    transcript: { request: { mode: 'transcript' }, text: true, types: ['paragraph', 'code', 'table'] },
    'full-saved': { request: { mode: 'full-saved' }, text: true, types: ['paragraph', 'code', 'table', 'future-native'] },
    'full-saved-parts': { request: { mode: 'full-saved', parts: { reasoning: true, toolActivity: true } }, text: true, types: blocks.map((block) => block.type) },
  };
  for (const [name, spec] of Object.entries(cases)) {
    const bundle = source.transfer.exportSelection({ ids: [source.id], ...spec.request });
    const saved = conversation(bundle);
    assert.equal(bundle.scope.mode, spec.request.mode, name);
    assert.equal(bundle.coverage.complete, true, name);
    assert.equal(saved.custody, 'saved-observation', name);
    if (!spec.text) assert.equal(saved.data.messages, undefined, name);
    else {
      assert.equal(saved.data.messages[0].text, 'answer', name);
      assert.deepEqual(types(bundle), spec.types, name);
      assert.equal(JSON.stringify(saved.data).includes('hidden-thought'), spec.request.parts?.reasoning === true, name);
    }
    if (name === 'transcript' || name === 'full-saved') assert.ok(bundle.omitted.some((item) => item.reason === 'reasoning-blocks-excluded' && item.count === 1 && item.expected === true), name);
    const report = source.transfer.validateBundle({ bundle });
    assert.equal(report.valid, true, name);
    const targetRoot = mkdtempSync(path.join(os.tmpdir(), 'world-export-mode-target-'));
    t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
    const paths = dataPaths(targetRoot); ensureDataDirs(paths);
    const target = createWorldTransfer({ service: createWorldService({ paths }) });
    const restored = target.restoreBundle({ bundle, digest: report.digest, dryRun: false, confirm: true });
    assert.equal(restored.failed.length, 0, name);
    if (spec.text) {
      const opened = createWorldService({ paths }).conversation(report.idMap[saved.id]);
      assert.equal(opened.coverage.state, 'imported-snapshot', name);
      assert.deepEqual(opened.messages[0].blocks.map((block) => block.type), spec.types, name);
    }
  }
  const implicit = source.transfer.exportSelection({ ids: [source.id], includeSources: true });
  assert.deepEqual(types(implicit), blocks.map((block) => block.type));
  const partial = world(t, 'partial');
  const reduced = partial.transfer.exportSelection({ ids: [partial.id], mode: 'transcript' });
  assert.equal(reduced.coverage.complete, false);
});
