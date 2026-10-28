import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedFreshTargetIds } from '../../src/capture/conversation-ownership.mjs';

const origin = 'https://chatgpt.com';
const fresh = { id: 'fresh', type: 'page', url: `${origin}/` };
const page = (url = `${origin}/`) => [{ ...fresh, url }];
function entry({ id = 'fresh', provenance = true, storedOwned = true, recovered = false, readOnly = false,
  finishing = false, finishRequested = false, failRead = false } = {}) {
  const value = { freshTargetProvenance: provenance ? { targetId: id, origin } : null,
    recovered, readOnly, finishing, service: { read() {
      if (failRead) throw Error('broken journal');
      return { binding: { targetId: id, origin, ownedByStudio: storedOwned }, finish: { requested: finishRequested } };
    } } };
  return value;
}

test('only this runtime fresh target is owned: foreign same-origin tab stays unowned', () => {
  const created = entry(), foreign = entry({ provenance: false, id: 'foreign' });
  assert.deepEqual([...ownedFreshTargetIds([created, foreign], [fresh, { id: 'foreign', url: `${origin}/c/other` }])], ['fresh']);
});
test('recovered, read-only, finishing and finished targets are unowned', () => {
  for (const options of [{ recovered: true }, { readOnly: true }, { finishing: true }, { finishRequested: true },
    { storedOwned: false }, { provenance: false }, { failRead: true }]) {
    assert.equal(ownedFreshTargetIds([entry(options)], page()).size, 0, JSON.stringify(options));
  }
});
test('absent, duplicate, non-page and foreign-origin targets revoke ephemeral provenance', () => {
  for (const discovered of [[], [fresh, fresh], [{ ...fresh, type: 'other' }], page('https://example.com/')]) {
    const created = entry();
    assert.equal(ownedFreshTargetIds([created], discovered).size, 0);
    assert.equal(created.freshTargetProvenance, null);
  }
});
test('reused target id does not recover ownership after disappearance or origin drift', () => {
  for (const invalid of [[], page('https://example.com/')]) {
    const created = entry();
    assert.equal(ownedFreshTargetIds([created], invalid).size, 0);
    assert.equal(ownedFreshTargetIds([created], page()).size, 0);
  }
});
test('two active claims for one target fail closed', () => {
  assert.equal(ownedFreshTargetIds([entry(), entry()], page()).size, 0);
});
test('read-only reporting never calls effect methods or exposes titles', () => {
  const created = entry();
  created.adapter = { connect() { throw Error('effect'); }, send() { throw Error('effect'); } };
  const claimed = ownedFreshTargetIds([created], [{ ...fresh, title: 'private title' }]);
  assert.deepEqual([...claimed], ['fresh']);
  assert.equal(JSON.stringify([...claimed]).includes('private title'), false);
});
