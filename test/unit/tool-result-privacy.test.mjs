import test from 'node:test';
import assert from 'node:assert/strict';
import { metadataOnly } from '../../src/studio/tool-result.mjs';

test('metadata projection preserves target IDs, provider, origin, evidence without private bodies', () => {
  const source = {
    targets: [{ id: 'target-01', site: 'chatgpt', url: 'https://chatgpt.com',
      title: 'Secret conversation', reply: { state: 'ready', text: 'private reply' } }],
    messages: [{ role: 'user', text: 'private prompt', id: 'message-1' }],
    coverage: { state: 'partial', returnedMessages: 2 },
    body: 'unwanted literal body', content: '<html>private</html>',
  };
  const safe = metadataOnly(source);
  assert.equal(safe.targets[0].id, 'target-01');
  assert.equal(safe.targets[0].site, 'chatgpt');
  assert.equal(safe.targets[0].reply.state, 'ready');
  assert.equal(safe.targets[0].reply.text, undefined);
  assert.equal(safe.targets[0].title, undefined);
  assert.equal(safe.messages[0].id, 'message-1');
  assert.equal(safe.messages[0].text, undefined);
  assert.equal(safe.coverage.returnedMessages, 2);
  assert.equal(safe.body, undefined);
  assert.equal(JSON.stringify(safe).includes('private'), false);
  assert.equal(source.targets[0].title, 'Secret conversation', 'source untouched');
});

test('metadata projection handles empty, nested and bounded inputs', () => {
  assert.deepEqual(metadataOnly([null, 1, true, { revision: 3, prompt: 'private' }]),
    [null, 1, true, { revision: 3 }]);
  let value = { id: 'tail' };
  for (let i = 0; i < 40; i++) value = { child: value };
  let depth = 0, node = metadataOnly(value);
  while (node?.child) { depth++; node = node.child; }
  assert.ok(depth <= 33);
});
