import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CdpConnection } from '../../src/cdp/client.mjs';
import { driveSite, findComposer, sendMessage } from '../../src/capture/actions.mjs';

// The real drive runs against a simulated page, isolated lease directory and fake discovery.
function fixture(t, options = {}) {
  const state = { draft: options.draft ?? '', connected: true, reads: 0, typed: 0, sends: 0, clears: 0, selections: 0, turns: 0 };
  const body = { innerText: '', querySelectorAll: () => [] };
  const composer = {
    tagName: 'TEXTAREA', get isConnected() { return state.connected; },
    get value() { return state.draft; },
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, width: 100, height: 30 }),
    getAttribute: () => null, closest: () => null, contains: (el) => el === composer,
    scrollIntoView() {}, focus() { document.activeElement = composer; },
  };
  const button = {
    tagName: 'BUTTON', isConnected: true, disabled: false,
    getBoundingClientRect: () => ({ x: 100, y: 0, width: 50, height: 30 }),
    getAttribute: () => null, closest() { return button; }, scrollIntoView() {},
  };
  const document = {
    body, activeElement: null, hasFocus: () => true,
    querySelector(selector) { return selector.startsWith('textarea,') ? composer : null; },
    querySelectorAll(selector) {
      if (selector === 'textarea') return [composer];
      if (selector === 'button.send') return [button];
      if (selector.includes('[data-message-author-role]') && selector.includes('article')) return Array(state.turns).fill({});
      return [];
    },
  };
  const context = vm.createContext({ document, window: { scrollY: 0 }, navigator: {}, location: { href: 'https://fixture.invalid/' }, URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
  const page = {
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        const expression = params.expression;
        const composerRead = expression.includes('const el = live()') && expression.includes("el.tagName === 'TEXTAREA'");
        if (composerRead) {
          state.reads++;
          if (state.reads === options.reappearAt) state.draft = 'fixture leftover';
          if (state.reads === options.unreadableAt) throw new Error('fixture read failed');
          if (options.unreadableFrom && state.reads >= options.unreadableFrom) throw new Error('fixture read failed');
          if (state.reads === options.undefinedAt) return { result: {} };
          if (state.reads === options.missingAt) state.connected = false;
        }
        if (expression.includes('const TURN_SEL') && !state.preflightChanged) {
          state.preflightChanged = true;
          if (options.mutatePreflight === 'mismatch') state.draft = `extra ${state.draft}`;
          if (options.mutatePreflight === 'whitespace') state.draft = state.draft.replace(' ', '\u00a0\n');
        }
        if (expression.includes('const el = globalThis.__aionSendBtn') && options.mutateButtonBox) state.draft = `extra ${state.draft}`;
        return { result: { value: vm.runInContext(expression, context) } };
      }
      if (method === 'Input.insertText' || (method === 'Input.dispatchKeyEvent' && params.type === 'char' && params.key !== 'Enter')) {
        state.typed++;
        if (options.corruptOnType && !state.corrupted) { state.draft = `extra ${state.draft}`; state.corrupted = true; }
        state.draft += params.text;
      }
      if (method === 'Input.dispatchKeyEvent' && params.key === 'Backspace' && params.type === 'keyDown') {
        state.clears++;
        if (options.clearWorks !== false) state.draft = '';
      }
      if (method === 'Input.dispatchKeyEvent' && params.code === 'KeyA' && params.modifiers === 2 && params.type === 'keyDown') state.selections++;
      const enter = method === 'Input.dispatchKeyEvent' && params.key === 'Enter' && params.type === 'keyDown';
      const click = method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && params.x === 125;
      if (enter || click) {
        state.sends++;
        if (options.lostSendAck) throw new Error('fixture acknowledgement lost');
        state.sentText = state.draft;
        state.draft = '';
        state.turns++;
      }
      return {};
    },
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-draft-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(() => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/json/list') return { ok: true, json: async () => [{ type: 'page', id: 'fixture', url: 'https://fixture.invalid/' }] };
    if (pathname === '/json/version') return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:18991/fixture' }) };
    throw new Error(`unexpected discovery path ${pathname}`);
  });
  t.mock.method(CdpConnection, 'connect', async () => ({ attach: async () => page, close() {} }));

  const events = [];
  return {
    state, events, page,
    run: () => driveSite({ adapter: { id: 'fixture', hosts: ['fixture.invalid'], send: { strategy: options.button ? 'button' : 'enter', buttonSelectors: ['button.send'] } },
      prompt: options.prompt ?? 'x', port: 18991, record: false, freshTab: false, humanPace: options.human ?? false, timeoutMs: 0,
      onEvent: (event) => events.push(event) }),
  };
}

function assertNoSend(state, result, reason) {
  assert.equal(state.sends, 0, 'unsafe composer text must never be submitted');
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assert.notEqual(result.uncertain, true);
  assert.doesNotMatch(JSON.stringify(result.errors), /fixture leftover|extra x/);
}

for (const human of [false, true]) {
  test(`failed draft clear blocks typing and submission (human=${human})`, async (t) => {
    const f = fixture(t, { draft: 'fixture leftover', clearWorks: false, human });
    const result = await f.run();
    assert.equal(f.state.typed, 0, 'must not type into an uncleared draft');
    assert.equal(f.state.clears, 1, 'do not retry the destructive clear');
    assert.equal(f.state.selections, 1);
    assertNoSend(f.state, result, 'draft-not-cleared');
  });

  test(`a transient initial read failure recovers and still sends only the prompt (human=${human})`, async (t) => {
    const f = fixture(t, { draft: 'fixture leftover', unreadableAt: 1, human });
    await f.run();
    assert.ok(f.state.reads > 1, 'the read is retried');
    assert.equal(f.state.sends, 1);
    assert.equal(f.state.sentText, 'x', 'never the leftover draft');
  });

  test(`corrupted typed text is not submitted (human=${human})`, async (t) => {
    const f = fixture(t, { corruptOnType: true, human });
    const result = await f.run();
    assert.ok(f.state.typed > 0, 'the fixture exercises typing');
    assertNoSend(f.state, result, 'prompt-mismatch');
  });

  test(`matching typed text reaches exactly one submission (human=${human})`, async (t) => {
    const f = fixture(t, { human });
    const result = await f.run();
    assert.equal(f.state.sends, 1);
    assert.equal(f.events.find((event) => event.type === 'sent')?.sendStatus, 'observed');
    assert.equal(result.uncertain, true, 'no terminal reply means the send is unresolved');
  });

  test(`a cleared draft permits only the intended prompt (human=${human})`, async (t) => {
    const f = fixture(t, { draft: 'fixture leftover', human });
    await f.run();
    assert.equal(f.state.clears, 1);
    assert.equal(f.state.selections, 1);
    assert.equal(f.state.sends, 1);
    assert.equal(f.state.sentText, 'x');
  });
}

test('a persistently unreadable composer blocks typing and submission', async (t) => {
  const f = fixture(t, { draft: 'fixture leftover', unreadableFrom: 1 });
  const result = await f.run();
  assert.equal(f.state.typed, 0, 'must not type into an unreadable composer');
  assert.equal(f.state.clears, 0, 'must not clear an unreadable draft');
  assertNoSend(f.state, result, 'composer-unreadable');
});

test('a transient readback failure after the single clear still blocks typing', async (t) => {
  const f = fixture(t, { draft: 'fixture leftover', unreadableAt: 2 });
  const result = await f.run();
  assert.equal(f.state.typed, 0);
  assert.equal(f.state.clears, 1);
  assertNoSend(f.state, result, 'composer-unreadable');
});

for (const fault of ['undefinedAt']) {
  test(`${fault} at initial read is retried, then the draft is cleared and only the prompt is sent`, async (t) => {
    const f = fixture(t, { draft: 'fixture leftover', [fault]: 1 });
    const result = await f.run();
    assert.ok(f.state.reads > 1, 'the read is retried');
    assert.equal(f.state.sends, 1);
    assert.equal(f.state.sentText, 'x', 'never the leftover draft');
    assert.equal(result.uncertain, true, 'fixture never produces terminal reply evidence');
  });
}

test('missingAt a disconnected composer at initial read blocks typing', async (t) => {
  const f = fixture(t, { draft: 'fixture leftover', missingAt: 1 });
  const result = await f.run();
  assert.equal(f.state.typed, 0);
  assert.equal(f.state.clears, 0);
  assertNoSend(f.state, result, 'composer-unreadable');
});

test('composer becoming unreadable before typing does not permit typing', async (t) => {
  const f = fixture(t, { unreadableAt: 2 });
  const result = await f.run();
  assert.equal(f.state.typed, 0);
  assertNoSend(f.state, result, 'composer-unreadable');
});

test('a draft reappearing before typing is not appended to or cleared again', async (t) => {
  const f = fixture(t, { reappearAt: 2 });
  const result = await f.run();
  assert.equal(f.state.typed, 0);
  assert.equal(f.state.clears, 0);
  assertNoSend(f.state, result, 'draft-not-cleared');
});

for (const fault of ['unreadableAt', 'undefinedAt']) {
  test(`${fault} at the pre-submit check is retried, then the verified prompt is sent`, async (t) => {
    const f = fixture(t, { [fault]: 3 });
    await f.run();
    assert.ok(f.state.typed > 0);
    assert.equal(f.state.sends, 1);
    assert.equal(f.state.sentText, 'x', 'only the verified prompt is submitted');
  });
}

test('a composer that disconnects at the pre-submit check does not submit', async (t) => {
  const f = fixture(t, { missingAt: 3 });
  const result = await f.run();
  assert.ok(f.state.typed > 0);
  assertNoSend(f.state, result, 'composer-unreadable');
});

test('a composer unreadable from the pre-submit check onwards does not submit', async (t) => {
  const f = fixture(t, { unreadableFrom: 3 });
  const result = await f.run();
  assert.ok(f.state.typed > 0);
  assertNoSend(f.state, result, 'composer-unreadable');
});

test('a draft changed during send preflight is not submitted', async (t) => {
  const f = fixture(t, { mutatePreflight: 'mismatch' });
  const result = await f.run();
  assertNoSend(f.state, result, 'prompt-mismatch');
});

test('a draft changed during the send button box lookup is not clicked', async (t) => {
  const f = fixture(t, { button: true, mutateButtonBox: true });
  const result = await f.run();
  assertNoSend(f.state, result, 'prompt-mismatch');
});

test('matching text can be submitted once with a button', async (t) => {
  const f = fixture(t, { button: true });
  await f.run();
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.sentText, 'x');
  assert.equal(f.events.find((event) => event.type === 'sent')?.sendStatus, 'observed');
});

test('a failed button verification is reported as not attempted', async (t) => {
  const f = fixture(t, { draft: 'x' });
  await findComposer(f.page);
  const result = await sendMessage(f.page, { send: { strategy: 'button', buttonSelectors: ['button.send'] } }, {
    verifyDispatch: async () => { throw new Error('fixture verification failed'); },
  });
  assert.equal(f.state.sends, 0);
  assert.equal(result.dispatched, false);
  assert.equal(result.uncertain, false);
  assert.equal(result.sendStatus, 'not-attempted');
});

test('whitespace-normalized matching text remains eligible for one submission', async (t) => {
  const f = fixture(t, { prompt: 'a b', mutatePreflight: 'whitespace' });
  await f.run();
  assert.equal(f.state.sends, 1);
  assert.equal(f.events.find((event) => event.type === 'sent')?.sendStatus, 'observed');
});

test('a lost send acknowledgement stays uncertain and is never resent', async (t) => {
  const f = fixture(t, { lostSendAck: true });
  const result = await f.run();
  assert.equal(f.state.sends, 1);
  assert.equal(result.reason, 'send-failed');
  assert.equal(result.uncertain, true);
  assert.equal(f.events.find((event) => event.type === 'sent')?.sendStatus, 'uncertain');
});


test('post-dispatch timeout stays uncertain without resending the prompt', async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(f.state.sends, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.uncertain, true);
  assert.equal(result.tabClosed, undefined, 'reused tab remains available for reconciliation');
});
