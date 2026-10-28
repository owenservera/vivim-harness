import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildPreview } from '../../ui-preview/build.mjs';

const fixture = readFileSync(new URL('../../ui-preview/preview-fixture.mjs', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8');

test('preview uses exact canonical Chat/World UI modules, with visible demo labeling', (t) => {
  const out = mkdtempSync(path.join(tmpdir(), 'vivim-ui-preview-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  buildPreview(out);
  const html = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /VIVIM UI PREVIEW · DEMO DATA/);
  assert.match(html, /No provider connection or data writes/);
  assert.match(html, /src="\/ui\/preview-fixture\.mjs"/);
  assert.match(html, /src="\/ui\/chat\.mjs"/);
  assert.ok(html.indexOf('preview-fixture.mjs') < html.indexOf('src="/ui/chat.mjs"'));
  assert.match(shell, /<body class="vivim-app">/);
  assert.doesNotMatch(shell, /preview-fixture\.mjs/, 'preview never contaminates production');
  for (const module of ['chat.mjs', 'world-view.mjs', 'universal-chat.mjs']) {
    assert.equal(
      readFileSync(path.join(out, 'ui', module), 'utf8'),
      readFileSync(new URL('../../src/studio/ui/' + module, import.meta.url), 'utf8'),
      module + ' must be byte-identical to canonical source',
    );
  }
  assert.match(html, /Advanced Studio · local only/);
  assert.match(html, /Site calibration · local only/);
});

test('preview synthetic API is read-only and never forwards backend/provider traffic', async () => {
  let networkCalls = 0;
  const context = vm.createContext({
    URL, URLSearchParams, Response,
    location: { href: 'https://preview.example/', origin: 'https://preview.example' },
    fetch: async () => { networkCalls++; throw new Error('network unavailable'); },
  });
  vm.runInContext(fixture.replace(/^export /gm, '') + '\nglobalThis.previewAPI = previewResponse;', context);
  const response = context.previewAPI('/api/v1/world/conversations?limit=50');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.items.length, 2);
  assert.ok(data.items.every(x => x.title.startsWith('DEMO ·')));
  const detail = await context.previewAPI('/api/v1/world/conversations/' + data.items[0].id).json();
  assert.equal(detail.identity.nativeThreadId, null);
  assert.equal(detail.coverage.fullNativeThread, 'unknown');
  assert.equal(detail.source.kind, 'preview-fixture');
  const blocked = await context.fetch('/api/v1/world/projects', { method: 'POST', body: '{}' });
  assert.equal(blocked.status, 405);
  assert.equal((await blocked.json()).code, 'PREVIEW_READ_ONLY');
  const sent = await context.fetch('/api/v1/conversations/123/turns', { method: 'POST' });
  assert.equal(sent.status, 405);
  assert.equal((await sent.json()).code, 'PREVIEW_READ_ONLY');
  const external = await context.fetch('https://chatgpt.com/');
  assert.equal(external.status, 403);
  assert.equal(networkCalls, 0, 'no external or backend request is forwarded');
});

test('core Chat still owns send, World mount and browser connection', () => {
  const source = readFileSync(new URL('../../src/studio/ui/chat.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("$('#btnSend').addEventListener('click', sendMessage)"));
  assert.ok(source.includes("import('./world-view.mjs')"));
  assert.ok(source.includes("$('#btnConnect').addEventListener('click', connect)"));
  assert.doesNotMatch(fixture, /localStorage|sessionStorage|WebSocket|EventSource|XMLHttpRequest/);
});
