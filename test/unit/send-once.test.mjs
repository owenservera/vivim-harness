import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { sendMessage, sendState, waitForCompletion } from '../../src/capture/actions.mjs';

const raw = (patch = {}) => ({ evalOk: true, text: 'private draft', turns: 4, bodyLen: 100, sendDisabled: false, ...patch });
const baseline = (patch = {}) => ({ evalOk: true, draftChars: 13, turns: 4, bodyLen: 100, streaming: false, ...patch });
// Exercises the actual sendState/sendMessage implementations. Only the CDP page transport is fake.
function fakePage({ states = [raw()], streams = [false], button = true, box = true, failInput } = {}) {
  const calls = [], expressions = [];
  let stateIndex = 0, streamIndex = 0;
  const page = { async send(method, params) {
    calls.push({ method, ...params });
    if (method !== 'Runtime.evaluate') {
      const failure = failInput?.(method, params);
      if (failure) throw new Error(failure);
      return {};
    }
    expressions.push(params.expression);
    new vm.Script(params.expression); // Parse the real injected source, catching duplicate declarations.
    let value;
    if (params.expression.includes('const TURN_SEL')) {
      value = states[Math.min(stateIndex++, states.length - 1)];
      if (value instanceof Error) throw value;
      if (value?.exceptionDetails) return value;
    } else if (params.expression.includes('const stopLabel')) {
      const streaming = streams[Math.min(streamIndex++, streams.length - 1)];
      if (streaming instanceof Error) throw streaming;
      value = { streaming, evidence: 'fixture' };
    } else if (params.expression.includes('const sels =')) value = { found: button };
    else if (params.expression.includes('const el = globalThis.__aionSendBtn')) value = box ? { x: 10, y: 20, w: 50 } : null;
    else throw new Error('Unexpected evaluation');
    return { result: { value } };
  } };
  return { page, calls, expressions, inputs: () => calls.filter((c) => c.method.startsWith('Input.')) };
}

test('real sendState returns readable baseline without inferring delivery or leaking draft', async () => {
  const f = fakePage(); const state = await sendState(f.page);
  assert.equal(state.evalOk, true); assert.equal(state.draftChars, 13);
  assert.equal(state.sent, false); assert.equal(state.turns, 4); assert.equal(state.streaming, false);
  assert.equal(JSON.stringify(state).includes('private draft'), false);
  assert.equal(f.inputs().length, 0);
});

for (const failed of [new Error('evaluation failed'), { exceptionDetails: { text: 'exception' } }, undefined, { evalOk: false }, raw({ text: null })]) {
  test(`real sendState unreadable composer stays unknown (${String(failed)})`, async () => {
    const f = fakePage({ states: [failed] }); const state = await sendState(f.page, null, baseline());
    assert.equal(state.evalOk, false); assert.equal(state.draftChars, null);
    assert.equal(state.sent, false); assert.equal(state.cleared, false); assert.equal(state.streaming, null);
    assert.match(state.reason, /unknown/); assert.equal(f.inputs().length, 0);
  });
}

for (const [label, state, streaming, before] of [
  ['empty alone', raw({ text: '' }), false, baseline()],
  ['disabled alone', raw({ sendDisabled: true }), false, baseline()],
  ['body growth alone', raw({ bodyLen: 1000 }), false, baseline()],
  ['old streaming', raw({ text: '' }), true, baseline({ streaming: true })],
  ['no baseline', raw({ text: '', turns: 5 }), true, null],
  ['new streaming alone', raw(), true, baseline()],
  ['new turn alone', raw({ turns: 5 }), false, baseline()],
  ['unreadable baseline', raw({ text: '', turns: 5 }), true, baseline({ evalOk: false })],
]) {
  test(`real sendState does not claim delivery from ${label}`, async () => {
    const f = fakePage({ states: [state], streams: [streaming] });
    const result = await sendState(f.page, null, before);
    assert.equal(result.evalOk, true); assert.equal(result.sent, false);
  });
}

for (const [label, state, streaming] of [
  ['cleared with new turn', raw({ text: '', turns: 5 }), false],
  ['retained draft with new turn and streaming', raw({ turns: 5 }), true],
  ['decreased draft with new streaming', raw({ text: 'x' }), true],
]) {
  test(`real sendState observes corroborated transition: ${label}`, async () => {
    const f = fakePage({ states: [state], streams: [streaming] });
    assert.equal((await sendState(f.page, null, baseline())).sent, true);
  });
}

test('real evaluated composer probe distinguishes missing composer from blank and parses helpers', async () => {
  let composer = null;
  const document = { activeElement: null, body: { innerText: '' }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const page = { async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: vm.runInNewContext(params.expression, {
      document, __aionDrive: composer ? { el: composer } : undefined,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    }) } };
  } };
  assert.equal((await sendState(page)).evalOk, false);
  composer = { isConnected: true, value: '', getBoundingClientRect: () => ({ width: 50, height: 20 }) };
  const blank = await sendState(page);
  assert.equal(blank.evalOk, true); assert.equal(blank.draftChars, 0); assert.equal(blank.sent, false);
  Object.defineProperty(composer, 'value', { get() { throw new Error('unreadable'); } });
  assert.equal((await sendState(page)).evalOk, false);
});

test('real sendState streaming evaluation failure is unknown, not a false baseline', async () => {
  const f = fakePage({ states: [raw(), raw({ turns: 5 })], streams: [new Error('stream unreadable'), true] });
  const before = await sendState(f.page);
  assert.equal(before.evalOk, true); assert.equal(before.streaming, null);
  const after = await sendState(f.page, null, before);
  assert.equal(after.sent, false);
});

test('real sendMessage and real sendState integrate: one Enter and delayed observations, no fallback', async () => {
  const f = fakePage({ states: [raw(), raw({ sendDisabled: true }), raw({ text: '' }), raw({ text: '', turns: 5 })] });
  const waits = [];
  const result = await sendMessage(f.page, { send: { strategy: 'both' } }, { sleep: async (ms) => waits.push(ms) });
  assert.equal(result.ok, true); assert.equal(result.sendStatus, 'observed');
  assert.deepEqual(waits, [900, 1200, 1500]);
  assert.deepEqual(f.inputs().map((c) => c.type), ['keyDown', 'char', 'keyUp']);
  assert.equal(f.expressions.some((e) => e.includes('const sels =')), false);
});

for (const text of ['', ' \t\n']) {
  test(`real sendMessage blank draft blocks all input (${JSON.stringify(text)})`, async () => {
    const f = fakePage({ states: [raw({ text })] });
    const result = await sendMessage(f.page, null, { sleep: async () => {} });
    assert.equal(result.sendStatus, 'not-attempted'); assert.equal(result.dispatched, false);
    assert.equal(f.inputs().length, 0);
  });
}

test('real sendMessage unreadable preflight never dispatches', async () => {
  const f = fakePage({ states: [new Error('page gone')] });
  const result = await sendMessage(f.page, null, { sleep: async () => {} });
  assert.equal(result.sendStatus, 'not-attempted'); assert.equal(f.inputs().length, 0);
});

for (const failType of ['keyDown', 'char', 'keyUp']) {
  test(`real Enter ${failType} error releases once where needed and never retries or clicks`, async () => {
    const f = fakePage({ failInput: (method, p) => p.type === failType ? 'lost ack' : null });
    const result = await sendMessage(f.page, null, { sleep: async () => {} });
    assert.equal(result.sendStatus, 'uncertain'); assert.equal(result.dispatched, true);
    assert.match(result.dispatchError, /lost ack/);
    assert.deepEqual(f.inputs().map((c) => c.type), failType === 'keyDown' ? ['keyDown', 'keyUp'] : ['keyDown', 'char', 'keyUp']);
    assert.equal(f.inputs().filter((c) => c.type === 'keyUp').length, 1);
  });
}

test('real button-only path clicks once and does not press Enter', async () => {
  const f = fakePage({ states: [raw(), raw({ text: '', turns: 5 })] });
  const result = await sendMessage(f.page, { send: { strategy: 'button' } }, { sleep: async () => {} });
  assert.equal(result.ok, true); assert.equal(result.method, 'button');
  assert.deepEqual(f.inputs().map((c) => c.type), ['mousePressed', 'mouseReleased']);
});

for (const config of [{ button: false }, { box: false }]) {
  test(`real button-only path has no Enter fallback when unavailable (${JSON.stringify(config)})`, async () => {
    const f = fakePage(config);
    const result = await sendMessage(f.page, { send: { strategy: 'button' } }, { sleep: async () => {} });
    assert.equal(result.sendStatus, 'not-attempted'); assert.equal(f.inputs().length, 0);
  });
}

for (const failType of ['mousePressed', 'mouseReleased']) {
  test(`real click ${failType} error attempts only one release and no other submission`, async () => {
    const f = fakePage({ failInput: (method, p) => p.type === failType ? 'mouse ack lost' : null });
    const result = await sendMessage(f.page, { send: { strategy: 'button' } }, { sleep: async () => {} });
    assert.equal(result.sendStatus, 'uncertain');
    assert.deepEqual(f.inputs().map((c) => c.type), ['mousePressed', 'mouseReleased']);
  });
}

function injected({ states, pressError, clickResult, button = true } = {}) {
  const calls = [], before = baseline(); let i = 0;
  const samples = states ?? [{ evalOk: true, sent: false, reason: 'not observed' }];
  const deps = {
    async sendState(page, adapter, prior) { calls.push(['state', prior]); return prior ? samples[Math.min(i++, samples.length - 1)] : before; },
    async findSendButton() { calls.push(['button']); return { found: button }; },
    async pressEnter() { calls.push(['enter']); if (pressError) throw new Error(pressError); },
    async clickSendButton() { calls.push(['click']); return clickResult ?? { dispatched: true }; },
    async sleep(ms) { calls.push(['wait', ms]); }, observeWaits: [1, 2, 3],
  };
  return { calls, deps, before };
}

test('injected delayed evidence reuses exact baseline and dispatches once', async () => {
  const f = injected({ states: [{ evalOk: true, sent: false }, { evalOk: true, sent: true }] });
  const result = await sendMessage({}, null, f.deps);
  assert.equal(result.ok, true); assert.equal(f.calls.filter(([c]) => c === 'enter').length, 1);
  assert.deepEqual(f.calls.filter(([c]) => c === 'wait'), [['wait', 1], ['wait', 2]]);
  assert.ok(f.calls.filter(([c, prior]) => c === 'state' && prior).every(([, prior]) => prior === f.before));
});

test('injected dispatch error remains uncertain and never invokes button fallback', async () => {
  const f = injected({ pressError: 'unknown effect' });
  const result = await sendMessage({}, { send: { strategy: 'both' } }, f.deps);
  assert.equal(result.uncertain, true); assert.equal(result.ok, false);
  assert.equal(f.calls.filter(([c]) => c === 'enter').length, 1);
  assert.equal(f.calls.some(([c]) => c === 'click' || c === 'button'), false);
});

test('injected button-only missing button and blank draft never dispatch', async () => {
  const f = injected({ button: false });
  assert.equal((await sendMessage({}, { send: { strategy: 'button' } }, f.deps)).dispatched, false);
  assert.equal(f.calls.some(([c]) => c === 'enter' || c === 'click'), false);
  f.before.draftChars = 0;
  assert.equal((await sendMessage({}, null, f.deps)).dispatched, false);
});

test('injected thrown observations cannot escape uncertainty or cause a retry', async () => {
  const f = injected();
  f.deps.sendState = async (p, a, before) => { if (!before) return f.before; throw new Error('read failed'); };
  const result = await sendMessage({}, null, f.deps);
  assert.equal(result.sendStatus, 'uncertain'); assert.equal(result.ok, false);
  assert.equal(f.calls.filter(([c]) => c === 'enter').length, 1);
});

test('injected contradictory observation with evalOk=false cannot claim observed', async () => {
  const f = injected({ states: [{ evalOk: false, sent: true }] });
  const result = await sendMessage({}, null, f.deps);
  assert.equal(result.ok, false); assert.equal(result.sendStatus, 'uncertain');
});

test('final dispatch latch prevents Enter after preflight', async () => {
  const f = injected();
  const result = await sendMessage({}, null, { ...f.deps, canDispatch: () => false });
  assert.equal(result.dispatched, false); assert.equal(result.reason, 'SUBMISSION_STOPPED');
  assert.equal(f.calls.some(([c]) => c === 'enter' || c === 'click'), false);
});

test('real button dispatch rechecks latch after asynchronous box lookup', async () => {
  const f = fakePage(); let allowed = true;
  const original = f.page.send;
  f.page.send = async (method, params) => {
    const result = await original(method, params);
    if (method === 'Runtime.evaluate' && params.expression.includes('const el = globalThis.__aionSendBtn')) allowed = false;
    return result;
  };
  const result = await sendMessage(f.page, { send: { strategy: 'button' } }, { canDispatch: () => allowed, sleep: async () => {} });
  assert.equal(result.dispatched, false); assert.equal(f.inputs().length, 0);
});

test('real wait primitive publishes full partial replacements before completion', async () => {
  const texts = ['part', 'replacement', 'final answer']; let iteration = 0; const updates = [];
  const page = { async send(method, params) {
    assert.equal(method, 'Runtime.evaluate'); let value;
    if (params.expression.includes('const stopLabel')) value = { streaming: iteration < 2, evidence: 'fixture' };
    else if (params.expression.includes('const patterns =')) value = { failed: false };
    else { const text = texts[Math.min(iteration++, 2)]; value = { turns: [{ role: 'assistant', text }], last: text, count: 2 }; }
    return { result: { value } };
  } };
  const result = await waitForCompletion(page, null, { stableMs: 0, pollMs: 0, baseline: 'earlier', baseCount: 1, onUpdate: (u) => updates.push(u.text) });
  assert.equal(result.done, true); assert.equal(result.text, 'final answer'); assert.deepEqual(updates, texts);
});
