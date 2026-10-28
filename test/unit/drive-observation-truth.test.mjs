import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { detectAuthWall, findComposer, isStreaming, readTranscript, sendState, waitForCompletion } from '../../src/capture/actions.mjs';

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

test('sendState trusts the observation flag, not the evidence wording', async () => {
  // The retired guard filtered on the evidence string `streaming check failed:`. Wording is not
  // the contract — `observed` is — so a successful observation must be used whatever it says,
  // and a failed one must never contribute a value. This page reports a boolean with legacy-
  // looking evidence, so an evidence-based guard silently drops a real observation.
  const composer = { evalOk: true, text: 'private draft', turns: 5, bodyLen: 100, sendDisabled: false };
  const page = {
    async send(method, { expression } = {}) {
      assert.equal(method, 'Runtime.evaluate');
      if (expression.includes('const TURN_SEL')) return { result: { value: composer } };
      if (expression.includes('const stopLabel ='))
        return { result: { value: { streaming: true, evidence: 'streaming check failed: legacy wording' } } };
      throw new Error('Unexpected evaluation');
    },
  };
  const before = { evalOk: true, draftChars: 13, turns: 4, bodyLen: 100, streaming: false };
  const after = await sendState(page, null, before);
  assert.equal(after.streaming, true, 'a successful streaming observation is authoritative');
  assert.equal(after.sent, true, 'turn growth plus observed streaming is corroborated delivery');
});

test('an unreadable auth check is unknown, never "not blocked"', async () => {
  const p = { async send() { throw new Error('page not evaluable'); } };
  const result = await detectAuthWall(p);
  assert.equal(result.blocked, null);
  assert.notEqual(result.blocked, false);
  assert.match(result.reason, /auth check unavailable/);
});

test('findComposer writes exactly one page-state handle and clears it when nothing matches', async () => {
  // Pins the write set: the read path is not "no page state" — it leaves a composer handle in
  // `globalThis.__aionDrive`, which sendState/detectAuthWall and human.mjs read back.
  const composer = {
    tagName: 'TEXTAREA', isConnected: true, value: '', disabled: false, readOnly: false,
    getBoundingClientRect: () => ({ width: 50, height: 20 }), getAttribute: () => null, closest: () => null,
  };
  const probe = async (els) => {
    const sandbox = {
      document: { activeElement: null, body: { innerText: '' }, querySelectorAll: (sel) => (sel === 'textarea' ? els : []) },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    };
    const page = { async send(method, { expression }) {
      assert.equal(method, 'Runtime.evaluate');
      return { result: { value: vm.runInNewContext(expression, sandbox) } };
    } };
    return { result: await findComposer(page), handle: sandbox.__aionDrive };
  };
  const found = await probe([composer]);
  assert.equal(found.result.found, true);
  assert.equal(found.handle?.el, composer);
  const missing = await probe([]);
  assert.equal(missing.result.found, false);
  assert.equal(missing.handle, null);
});
