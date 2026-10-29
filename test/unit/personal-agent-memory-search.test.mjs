import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPersonalAgentMemory, MEMORY_SEARCH_TIERS } from '../../src/agents/personal-agent-memory-search.mjs';

const original = () => ({
  memory: {
    CANON: [{ key: 'research_priority', text: 'Review local harness receipts', source: 'user-authored', updatedAt: '2026-10-28T12:00:00Z' }],
    Immediate: [
      { key: 'next_step', text: 'Finish Research on Personal Agent', source: 'user-authored', updatedAt: '2026-10-29T12:00:00Z' },
      { key: 'research', text: 'Private token: DO_NOT_SEND', source: 'user-authored', updatedAt: '2026-10-27T12:00:00Z' },
    ],
    Curated: [{ key: 'note', text: 'Researcher should use source evidence', source: 'user-authored', updatedAt: '2026-10-26T12:00:00Z' }],
  },
});
test('read-only local search ranks exact, prefix and text matches without changing state', () => {
  const state = original(), before = JSON.stringify(state);
  const result = searchPersonalAgentMemory(state, { query: 'RESEARCH' });
  assert.deepEqual(result.items.map(hit => hit.key), ['research', 'research_priority', 'next_step', 'note']);
  assert.equal(result.total, 4);
  assert.equal(result.truncated, false);
  assert.equal(result.items[0].source, 'user-authored');
  assert.equal(result.items[0].preview.includes('Private token'), true);
  assert.equal(JSON.stringify(state), before);
  assert.equal(result.execution.includes('no provider'), true);
});
test('tier scope, limits and preview bounds never fabricate results', () => {
  const state = original();
  assert.deepEqual(MEMORY_SEARCH_TIERS, ['CANON', 'Immediate', 'Curated']);
  const only = searchPersonalAgentMemory(state, { query: 'research', tier: 'Immediate', limit: 1 });
  assert.equal(only.total, 2);
  assert.equal(only.shown, 1);
  assert.equal(only.truncated, true);
  assert.equal(only.items[0].tier, 'Immediate');
  state.memory.Immediate.push({ key: 'long', text: 'a'.repeat(1000) + ' needle ' + 'b'.repeat(1000),
    source: 'user-authored', updatedAt: '2026-10-29T00:00:00Z' });
  const found = searchPersonalAgentMemory(state, { query: 'needle' }).items[0];
  assert.ok(found.preview.length <= 242);
  assert.match(found.preview, /needle/);
  assert.equal(found.preview.startsWith('…'), true);
  assert.equal(found.preview.endsWith('…'), true);
});
test('search refuses invalid query, tiers, limits and inconsistent provenance, without leaking private values', () => {
  const state = original();
  for (const query of ['', 'x', 'x'.repeat(121), 'line\nbreak', null]) {
    assert.throws(() => searchPersonalAgentMemory(state, { query }),
      e => e.code === 'PERSONAL_AGENT_MEMORY_SEARCH_INVALID');
  }
  for (const limit of [0, -1, 1.4, 51, '10']) {
    assert.throws(() => searchPersonalAgentMemory(state, { query: 're', limit }),
      e => e.code === 'PERSONAL_AGENT_MEMORY_SEARCH_INVALID');
  }
  assert.throws(() => searchPersonalAgentMemory(state, { query: 're', tier: '../foo' }),
    e => e.code === 'PERSONAL_AGENT_MEMORY_SEARCH_INVALID');
  state.memory.CANON[0].source = 'provider-inferred';
  assert.throws(() => searchPersonalAgentMemory(state, { query: 're' }),
    e => e.code === 'PERSONAL_AGENT_MEMORY_SEARCH_STATE' && !e.message.includes('Review local'));
});
