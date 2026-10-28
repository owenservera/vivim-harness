// Synthetic structured-capture privacy fixtures: no browser or provider sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubBlocks } from '../../src/capture/dom.mjs';
import { capturePrivacy } from '../../src/capture/privacy.mjs';

const source = () => [
  { type: 'paragraph', inline: [{ t: 'citation', text: 'source', href: 'https://example.test/article?token=secret-citation' }] },
  { type: 'image', src: 'https://example.test/image?api_key=secret-image', alt: 'preview' },
  { type: 'table', headers: ['Header'], rows: [['row']] },
  { type: 'quote', blocks: [{ type: 'paragraph', inline: [{ t: 'link', text: 'nested', href: 'https://example.test/article?password=secret-nested' }] }] },
  { type: 'list', items: [{ blocks: [{ type: 'media', src: 'https://example.test/file?session=secret-file' }] }] },
];

test('filtered capture sanitizes citations, image URLs, nested links and media URLs', () => {
  const blocks = source();
  scrubBlocks(blocks, capturePrivacy({ capture: { privacyMode: 'filtered' } }, {}));
  assert.doesNotMatch(JSON.stringify(blocks), /secret-(citation|image|nested|file)/);
  assert.match(blocks[0].inline[0].href, /token=%5Bredacted%5D/);
  assert.match(blocks[1].src, /api_key=%5Bredacted%5D/);
  assert.match(blocks[3].blocks[0].inline[0].href, /password=%5Bredacted%5D/);
  assert.match(blocks[4].items[0].blocks[0].src, /session=%5Bredacted%5D/);
  assert.deepEqual(blocks[2].headers, ['Header']);
});

test('local-raw capture preserves typed blocks unchanged', () => {
  const before = source(), blocks = structuredClone(before);
  scrubBlocks(blocks, capturePrivacy({ capture: { privacyMode: 'local-raw' } }, {}));
  assert.deepEqual(blocks, before);
});
