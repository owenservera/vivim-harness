// Offline regression for objective 031: no real Chrome, CDP connection or provider effects.
// Mock ProseMirror's live-observed double-break reaction to Shift+Enter keyDown + literal CR char.
import test from 'node:test';
import assert from 'node:assert/strict';
import { humanType } from '../../src/capture/human.mjs';

const PACE = {
  keyMinMs: 0, keyMaxMs: 0, wordPauseMs: [0, 0], sentencePauseMs: [0, 0],
  thinkPauseEveryChars: 0, thinkPauseMs: [0, 0],
};

function mockComposer() {
  let draft = '';
  const events = [];
  const page = {
    async send(method, params) {
      events.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const isRead = params.expression.includes('return String(el.innerText');
        return { result: { value: isRead ? draft : { ok: true, already: true } } };
      }
      if (method === 'Input.insertText') {
        draft += params.text;
      } else if (method === 'Input.dispatchKeyEvent') {
        if (params.type === 'keyDown' && params.key === 'Enter' && params.modifiers === 8) {
          draft += '\n'; // ProseMirror handles Shift+Enter in its keymap.
        }
        if (params.type === 'char') {
          draft += params.text === '\r' ? '\n' : (params.text ?? '');
        }
        if (params.type === 'keyDown' && params.key === 'Backspace') {
          draft = [...draft].slice(0, -1).join('');
        }
      } else {
        throw Error('Unexpected mock CDP method ' + method);
      }
      return {};
    },
  };
  return { page, events, draft: () => draft };
}

test('031: human multiline typing sends one insertText per LF, not a double-break Shift+Enter', async () => {
  const prompt = 'alpha\n\nbeta';
  const mock = mockComposer();
  let guardCount = 0;
  const result = await humanType(mock.page, prompt, {
    human: true, pace: PACE,
    beforeInsert: () => { guardCount++; assert.equal(mock.draft(), ''); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.typed, prompt);
  assert.equal(mock.draft(), prompt);
  assert.equal(guardCount, 1, 'pre-insertion ownership guard must run once before any text effect');
  const inserts = mock.events.filter(e => e.method === 'Input.insertText');
  assert.deepEqual(inserts.map(e => e.params.text), ['\n', '\n']);
  const keys = mock.events.filter(e => e.method === 'Input.dispatchKeyEvent');
  assert.equal(keys.filter(e => e.params.key === 'Enter').length, 0,
    'no Shift+Enter key events may be used for payload newlines');
  assert.equal(result.stats.methodCounts.insertText, 2);
  assert.equal(result.stats.methodCounts.key, 9, 'all other characters remain human-paced key dispatch');
});

test('031: CRLF and lone CR normalize to a single inserted LF each', async () => {
  const mock = mockComposer();
  const result = await humanType(mock.page, 'a\r\nb\rc', { human: true, pace: PACE });
  assert.equal(result.ok, true);
  assert.equal(mock.draft(), 'a\nb\nc');
  assert.deepEqual(mock.events.filter(e => e.method === 'Input.insertText').map(e => e.params.text), ['\n', '\n']);
});

test('ownership fence: failing beforeInsert refuses all text dispatch in human mode', async () => {
  const mock = mockComposer();
  await assert.rejects(
    humanType(mock.page, 'a\nb', { human: true, pace: PACE,
      beforeInsert: () => { throw Object.assign(new Error('PREEXISTING_THREAD'), { code: 'PREEXISTING_THREAD' }); } }),
    { code: 'PREEXISTING_THREAD' },
  );
  assert.equal(mock.draft(), '');
  assert.equal(mock.events.filter(e => e.method.startsWith('Input.')).length, 0);
});

test('non-human bulk path still checks the same fence and inserts once', async () => {
  const mock = mockComposer();
  let guarded = 0;
  const result = await humanType(mock.page, 'a\n\nb', {
    human: false, pace: PACE, beforeInsert: () => { guarded++; },
  });
  assert.equal(guarded, 1);
  assert.equal(result.ok, true);
  assert.equal(mock.draft(), 'a\n\nb');
  assert.deepEqual(mock.events.filter(e => e.method === 'Input.insertText').map(e => e.params.text), ['a\n\nb']);
});
