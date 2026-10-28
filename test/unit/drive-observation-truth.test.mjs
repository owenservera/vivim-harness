import test from 'node:test';
import assert from 'node:assert/strict';
import { isStreaming, readTranscript, waitForCompletion } from '../../src/capture/actions.mjs';

// Synthetic CDP responses only: no browser, recorder, network, or provider sends.
function page({ stream = { streaming: false, evidence: 'idle' }, transcript = {
  turns: [{ role: 'assistant', text: 'fresh fixture answer' }],
  last: 'fresh fixture answer', count: 1
}, streamFailure = false, transcriptFailure = false } = {}) {
  let reads = 0;
  return {
    get reads() { return reads; },
    async send(method, { expression } = {}) {
      assert.equal(method, 'Runtime.evaluate');
      reads++;
      if (expression.includes('const stopLabel =')) {
        if (streamFailure) throw new Error('synthetic private streaming failure');
        return { result: { value: stream } };
      }
      if (expression.includes('const turns = []')) {
        if (transcriptFailure) throw new Error('synthetic private transcript failure');
        return { result: { value: transcript } };
      }
      // Site-side failure detection is a distinct positive error signal.
      return { result: { value: { failed: false } } };
    },
  };
}

test('failed streaming observation remains unknown instead of finished', async () => {
  const p = page({ streamFailure: true });
  const result = await isStreaming(p);
  assert.equal(result.observed, false);
  assert.equal(result.streaming, null);
  assert.doesNotMatch(JSON.stringify(result), /synthetic private/);
});

test('failed or invalid transcript observation remains unknown, never empty-success', async () => {
  for (const p of [page({ transcriptFailure: true }), page({ transcript: null }), page({ transcript: { last: 'a', turns: null } })]) {
    const result = await readTranscript(p);
    assert.equal(result.observed, false);
  }
});

test('completion requires both positive streaming and transcript observations', async () => {
  for (const p of [page({ streamFailure: true }), page({ transcriptFailure: true }),
    page({ stream: { evidence: 'not a boolean' } }), page({ transcript: { last: 'x', turns: null } })]) {
    const result = await waitForCompletion(p, null, { stableMs: 0, timeoutMs: 0, pollMs: 0 });
    assert.equal(result.done, false);
    assert.match(result.reason, /observation incomplete/);
  }
  const valid = await waitForCompletion(page(), null, { stableMs: 0, timeoutMs: 0, pollMs: 0 });
  assert.equal(valid.done, true);
  const streaming = await waitForCompletion(page({ stream: { streaming: true, evidence: 'running' } }),
    null, { stableMs: 0, timeoutMs: 0, pollMs: 0 });
  assert.equal(streaming.done, false);
});

test('an explicitly detected provider failure can still stop waiting without a false success', async () => {
  let observations = 0;
  const p = {
    async send(method, { expression }) {
      assert.equal(method, 'Runtime.evaluate');
      observations++;
      if (expression.includes('const stopLabel =')) throw new Error('stream check offline');
      if (expression.includes('const turns = []')) throw new Error('transcript read offline');
      return { result: { value: { failed: true, message: 'Synthetic provider failure' } } };
    },
  };
  const result = await waitForCompletion(p, null, { stableMs: 0, timeoutMs: 0, pollMs: 0 });
  assert.equal(result.done, true);
  assert.equal(result.failed, true);
  assert.ok(observations >= 3);
});
