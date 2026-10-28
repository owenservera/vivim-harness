import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObjectiveSourceCrosswalk } from '../../scripts/objective-source-crosswalk.mjs';

const KEY = 'src/capture/actions.mjs#detectAuthWall';
const symbols = { keys: { [KEY]: { line: 1, kind: 'function', exported: true } } };
const tick = String.fromCharCode(96);
const row = (id, classification = 'partial', key = KEY) =>
  '| ' + id + ' | Outcome ' + id + ' | ' + classification + ' | ' + tick + key + tick + ' | Pending evidence | [Ledger](ledger.json) |';
const fixture = () => Array.from({ length: 100 }, (_, i) => row(String(i + 1).padStart(3, '0'))).join('\n');

test('materializes 100 complete mappings without claiming live proof', () => {
  const result = buildObjectiveSourceCrosswalk(fixture(), symbols);
  assert.equal(result.counts.mapped, 100);
  assert.equal(result.counts.distinctSourceKeys, 1);
  assert.equal(result.counts.partial, 100);
  assert.equal(result.objectives[0].id, '001');
  assert.equal(result.objectives[99].id, '100');
  assert.match(result.evidence, /none establish live provider behavior/);
});

test('rejects missing and duplicate objective IDs', () => {
  assert.throws(() => buildObjectiveSourceCrosswalk(fixture().split('\n').slice(0, -1).join('\n'), symbols), /Missing objective IDs: 100/);
  assert.throws(() => buildObjectiveSourceCrosswalk(fixture() + '\n' + row('001'), symbols), /duplicate objective 001/);
});

test('rejects stale source references and unrecognized classifications', () => {
  assert.throws(() => buildObjectiveSourceCrosswalk(fixture().replace(KEY, 'src/absent.mjs#missing'), symbols), /Unresolved source reference 001/);
  assert.throws(() => buildObjectiveSourceCrosswalk(fixture().replace('partial', 'verified'), symbols), /Invalid source classification for 001/);
});
