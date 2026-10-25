// Registry read-view tests: learned adapters are reachable ONLY through the read view; the
// execution path (getAdapter) never returns them; listReadAdapters merges both views.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, getReadAdapter, listReadAdapters, setLearnedAdapterProvider, getLearnedAdapterProvider, ADAPTER_IDS } from '../../src/profiles/sites/index.mjs';

const learnedAdapter = () => ({
  id: 'fixture-chat',
  label: 'fixture-chat (learned)',
  hosts: ['127.0.0.1'],
  url: 'https://127.0.0.1:8443',
  learned: true,
  readOnly: true,
  send: { strategy: 'learned-readonly' },
  userTurn: { selectors: ['[data-role="user"]'] },
  assistantTurn: { selectors: ['[data-role="assistant"]'] },
  authority: { browser: 'existing-capture-studio-only', sendPermission: false, autoExecution: false },
  factory: { readFeatures: ['assistant-turn', 'user-turn'] },
});

test('no provider by default; clearing works', async () => {
  setLearnedAdapterProvider(null);
  assert.equal(getLearnedAdapterProvider(), null);
  assert.equal(await getReadAdapter('fixture-chat'), null);
});

test('execution path never sees learned adapters; read view does', async () => {
  const calls = [];
  setLearnedAdapterProvider({
    get: async (id) => { calls.push(id); return String(id).includes('fixture') || String(id).includes('127.0.0.1') ? learnedAdapter() : null; },
    list: async () => [learnedAdapter()],
  });
  try {
    // The drive/send path resolves through getAdapter: learned host must NOT resolve.
    assert.equal(await getAdapter('https://127.0.0.1:8443/chat'), null);
    assert.equal(await getAdapter('fixture-chat'), null);
    // The read view resolves the same identifiers.
    const viaHost = await getReadAdapter('https://127.0.0.1:8443/chat');
    assert.equal(viaHost?.learned, true);
    assert.equal(viaHost.send.strategy, 'learned-readonly');
    assert.equal((await getReadAdapter('fixture-chat'))?.id, 'fixture-chat');

    // Read view listing includes the seeds and the learned adapter, with honest flags.
    const all = await listReadAdapters();
    assert.ok(ADAPTER_IDS.length >= 10);
    const learnedRows = all.filter((a) => a.learned === true);
    assert.equal(learnedRows.length, 1);
    assert.equal(learnedRows[0].hasComposer, false); // a learned adapter never declares a composer
    assert.deepEqual(learnedRows[0].readFeatures, ['assistant-turn', 'user-turn']);
  } finally { setLearnedAdapterProvider(null); }
});

test('static seeds still resolve through both views and take precedence', async () => {
  setLearnedAdapterProvider({ get: async () => learnedAdapter(), list: async () => [learnedAdapter()] });
  try {
    // duck-ai is a handwritten seed: execution path unchanged by the learned provider.
    const duck = await getAdapter('duck-ai');
    assert.equal(duck?.id, 'duck-ai');
    const duckRead = await getReadAdapter('duck-ai');
    assert.equal(duckRead?.id, 'duck-ai');
    assert.notEqual(duckRead?.learned, true);
  } finally { setLearnedAdapterProvider(null); }
});

test('a throwing provider degrades to null, never breaks the registry', async () => {
  setLearnedAdapterProvider({ get: async () => { throw new Error('boom'); }, list: async () => { throw new Error('boom'); } });
  try {
    assert.equal(await getReadAdapter('fixture-chat'), null);
    const all = await listReadAdapters();
    assert.equal(all.filter((a) => a.learned === true).length, 0);
  } finally { setLearnedAdapterProvider(null); }
});
