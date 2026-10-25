// Site adapter contract for the Duck.ai adapter, measured against a live guest session on
// 2026-10-24 (sandbox capture browser, Chrome for Testing 143, loopback CDP only).
// The assertions check the adapter REGISTRY contract and the measured selectors — never that
// duck.ai replied (it did not: the chat API rejected a datacenter IP; see streamHints.notes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, listAdapters, loadAdapter, ADAPTER_IDS } from '../../src/profiles/sites/index.mjs';

test('duck-ai is registered in ADAPTER_IDS and loads from the registry', async () => {
  assert.ok(ADAPTER_IDS.includes('duck-ai'));
  const a = await loadAdapter('duck-ai');
  assert.ok(a, 'duck-ai adapter file failed to load');
  assert.equal(a.id, 'duck-ai');
  assert.equal(a.label, 'Duck.ai');
});

test('duck-ai resolves by id, by host and by URL', async () => {
  for (const ref of ['duck-ai', 'duck.ai', 'https://duck.ai/', 'https://duck.ai/?chatID=d9311b43']) {
    const a = await getAdapter(ref);
    assert.ok(a, `getAdapter(${ref}) returned null`);
    assert.equal(a.id, 'duck-ai');
  }
});

test('duck-ai composer contract uses the measured form textarea selectors', async () => {
  const a = await loadAdapter('duck-ai');
  assert.ok(Array.isArray(a.composer?.selectors) && a.composer.selectors.length > 0);
  // Measured live: the composer is a <textarea> inside a <form> (aria-label "Reply to Duck.ai",
  // placeholder "Reply...", initially "Ask anything privately" on a fresh chat).
  assert.ok(a.composer.selectors.some((s) => s.includes('form textarea')));
  assert.ok(a.composer.selectors.some((s) => /aria-label/i.test(s)));
  assert.equal(a.composer.kind, 'auto');
});

test('duck-ai send contract exposes the measured in-form submit button and Enter strategy', async () => {
  const a = await loadAdapter('duck-ai');
  assert.ok(['enter', 'both', 'button'].includes(a.send?.strategy));
  assert.ok(a.send.buttonSelectors.includes('form button[type="submit"]'));
});

test('duck-ai does not fabricate an assistant test id that was never observed', async () => {
  const a = await loadAdapter('duck-ai');
  // No assistant-side data-testid was rendered in the live probe (the provider rejected the
  // chat), so the adapter must not claim a specific assistant test id. Generic candidates and
  // the actions.mjs heuristic are the declared fallback.
  for (const sel of a.assistant.containerSelectors) {
    assert.ok(!/data-testid="(?!.*\*).*assistant/i.test(sel.replace('\\"', '"')), `assistant selector asserts an unverified test id: ${sel}`);
  }
  assert.ok(a.assistant.streamingSelectors.includes('button[aria-label="Stop generating"]'),
    'the Stop generating button was measured live and must anchor streaming detection');
});

test('duck-ai declares guest access and discloses the unverified reply transport', async () => {
  const a = await loadAdapter('duck-ai');
  assert.equal(a.preflight?.requiresAuth, false);
  assert.equal(typeof a.streamHints?.notes, 'string');
  assert.ok(/unverified/i.test(a.streamHints.notes), 'streamHints.notes must disclose the unverified transport');
  assert.ok(/02f8|temporarily unavailable/i.test(a.streamHints.notes), 'the live probe failure receipt must be recorded');
  assert.ok(/chatID/i.test(a.streamHints.notes), 'the measured ?chatID=<uuid> thread identity must be recorded');
});

test('listAdapters reports duck-ai with a composer', async () => {
  const all = await listAdapters();
  const duck = all.find((a) => a.id === 'duck-ai');
  assert.ok(duck, 'listAdapters did not report duck-ai');
  assert.equal(duck.hasComposer, true);
  assert.equal(duck.requiresAuth, false);
});
