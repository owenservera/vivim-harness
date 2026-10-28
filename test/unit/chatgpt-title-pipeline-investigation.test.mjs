// Synthetic offline pipeline; hub writes only to a temporary directory removed after the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readChatIndex } from '../../src/capture/chatgpt-chat-index-reader.mjs';
import { createIntegrationHub } from '../../src/studio/integration-hub.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';
import { runToolsCall } from '../../bin/commands/tools.mjs';
import { createOutput } from '../../bin/lib/ui.mjs';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const anchor = (id, text) => ({ getAttribute: () => `/c/${id}`, innerText: text,
  getBoundingClientRect: () => ({ width: 10, height: 10 }) });

test('synthetic titles cross reader, hub and client; CLI redacts by default and explicitly includes content', async (t) => {
  const anchors = [anchor(ids[0], 'Same 🌍'), anchor(ids[1], 'Same 🌍'), anchor(ids[0], 'variant'), anchor(ids[2], ''), anchor(ids[3], '😀abcde')];
  const sandbox = { location: { origin: 'https://chatgpt.com', pathname: '/' }, document: { querySelectorAll: () => anchors } };
  let raw;
  const deps = { port: 1, listTargets: async () => [{ id: 'fake', type: 'page', url: 'https://chatgpt.com/' }],
    openSession: async () => ({ session: {}, close: async () => {} }),
    evaluate: async (_session, expression) => {
      const result = JSON.parse(JSON.stringify(vm.runInNewContext(expression, sandbox)));
      if (result.result) raw = result.result;
      return result;
    } };
  const request = { targetId: 'fake', maxTitleChars: 6, maxEntries: 4, scanLimit: 5 };
  const recorder = new EventEmitter();
  const root = mkdtempSync(path.join(tmpdir(), 'vivim-title-pipeline-'));
  let hub;
  t.after(async () => { try { await hub?.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  hub = createIntegrationHub({ paths: { root }, recorder, getPort: () => 1,
    conversationRuntime: { chatIndex: (body) => readChatIndex(body, deps) } });
  let envelope;
  const fetch = async (_url, options) => {
    let wire = '';
    const res = { headersSent: false, writeHead() { this.headersSent = true; }, setHeader() {}, end(chunk) { wire += chunk ?? ''; } };
    await hub.handle({ method: 'POST' }, res, new URL('http://localhost/api/v1/integrations/tools/call'), JSON.parse(options.body));
    envelope = JSON.parse(wire);
    return { ok: true, redirected: false, json: async () => JSON.parse(wire) };
  };
  const client = createStudioToolClient({ port: 1, fetch });
  {
    const result = await client.call('chat_index', request);
    assert.equal(raw.links[0].text, 'Same 🌍');
    assert.deepEqual(result.index.entries.map((e) => e.displayTitle?.text ?? null), ['Same 🌍', 'Same 🌍', null, '😀abcde']);
    assert.notEqual(result.index.entries[0].threadRef, result.index.entries[1].threadRef);
    assert.equal(result.index.entries[0].occurrences, 2);
    assert.equal(result.index.entries[0].titleVariants, 2);
    assert.deepEqual(JSON.parse(envelope.content[0].text), envelope.structuredContent);
    assert.deepEqual(result, envelope.structuredContent);
    assert.equal(result.index.coverage.duplicatesMerged, 1);
    assert.equal(result.index.complete, false);
    async function cli(include) {
      let output = '';
      const ctx = { args: ['chat_index'], flags: { 'include-content': include }, settings: { studioPort: 1 },
        out: createOutput({ json: true, stdout: { write: (s) => { output += s; } } }) };
      await runToolsCall(ctx, { client: () => client, readInput: () => JSON.stringify(request) });
      return JSON.parse(output);
    }
    const redacted = await cli(false), included = await cli(true);
    assert.deepEqual(redacted.index.entries[0].displayTitle, { untrusted: true, truncated: false });
    assert.equal(included.index.entries[0].displayTitle.text, 'Same 🌍');
    assert.equal(included.index.entries[2].displayTitle, null);
    assert.equal(included.index.entries[3].displayTitle.text, '😀abcde');
    const bounded = await client.call('chat_index', { ...request, maxTitleChars: 3, maxEntries: 2 });
    assert.equal(bounded.index.entries[0].displayTitle.text, 'Sam');
    assert.equal(bounded.index.entries[0].displayTitle.truncated, true);
    assert.equal(bounded.index.coverage.omittedEntries, 2);
    const unicode = await client.call('chat_index', { ...request, maxTitleChars: 2 });
    assert.equal(unicode.index.entries[3].displayTitle.text, '😀a');
    assert.equal(unicode.index.entries[3].displayTitle.truncated, true);
  }
});
