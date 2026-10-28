import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createContinuityPacket, createPortableSnapshot, CONTINUITY_SCHEMA, EXPORT_SCHEMA,
} from '../../src/agents/personal-agent-continuity.mjs';

const state = {
  schemaVersion: 1, agentId: 'primary', version: 12,
  identity: { role: 'personal-agent', assurance: 'local-data-directory-only' },
  stages: {
    'identity-and-sitrep': { status: 'completed', evidence: ['local:agent/1'], updatedAt: '2026-10-28', blocker: null },
    'skills-and-capabilities': { status: 'blocked', evidence: [], updatedAt: '2026-10-28', blocker: 'Missing local skill root' },
  },
  memory: {
    CANON: [{ key: 'value', text: 'PRIVATE_CANON_CONTENT', source: 'user-authored', updatedAt: '2026-10-28' }],
    Immediate: [{ key: 'task', text: 'PRIVATE_IMMEDIATE_CONTENT', source: 'user-authored', updatedAt: '2026-10-28' }],
    Curated: [],
  },
  work: [{
    id: 'work-123', title: 'PRIVATE_WORK_TITLE', objective: 'PRIVATE_WORK_OBJECTIVE',
    status: 'blocked', nextAction: 'Resolve identity', updatedAt: '2026-10-28',
    evidence: [{ ref: 'local:receipt', basis: 'user-attested' }],
    events: [],
  }],
};
const now = '2026-10-28T21:00:00.000Z';

test('continuity packet is private, bounded, transparent about communications and no execution', () => {
  const sitrep = createContinuityPacket(state, { now });
  assert.equal(sitrep.schema, CONTINUITY_SCHEMA);
  assert.equal(sitrep.bootstrap['skills-and-capabilities'].blocker, 'Missing local skill root');
  assert.equal(sitrep.memory.Immediate[0].text, 'PRIVATE_IMMEDIATE_CONTENT');
  assert.equal(sitrep.work[0].title, 'PRIVATE_WORK_TITLE');
  assert.equal(sitrep.workCoverage.openTotal, 1);
  assert.equal(sitrep.communications.status, 'not-inspected');
  assert.equal(sitrep.execution.providerSendsPerformed, 0);
  assert.equal(sitrep.identity.providerAccountVerified, false);
});

test('default portable export omits private memory and private Work text', () => {
  const bundle = createPortableSnapshot(state, { now });
  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.schema, EXPORT_SCHEMA);
  assert.equal(bundle.includesPrivateMemory, false);
  assert.equal(bundle.includesPrivateWorkDetails, false);
  assert.equal(bundle.payload.memory.detailsOmitted, true);
  assert.equal(bundle.payload.work.detailsOmitted, true);
  for (const marker of ['PRIVATE_CANON_CONTENT', 'PRIVATE_IMMEDIATE_CONTENT', 'PRIVATE_WORK_TITLE', 'PRIVATE_WORK_OBJECTIVE']) {
    assert.equal(serialized.includes(marker), false);
  }
  assert.equal(bundle.importSupported, false);
});
test('explicit full export includes private state, with verifiable sha256 digest', () => {
  const bundle = createPortableSnapshot(state, { now, includeMemory: true, includeWorkDetails: true });
  assert.equal(bundle.payload.memory.CANON[0].text, 'PRIVATE_CANON_CONTENT');
  assert.equal(bundle.payload.work[0].title, 'PRIVATE_WORK_TITLE');
  const expected = createHash('sha256').update(JSON.stringify(bundle.payload)).digest('hex');
  assert.equal(bundle.checksum, 'sha256:' + expected);
  assert.ok(bundle.bytes > 100);
});
test('invalid flags and excessive export refuse instead of emitting unbounded private data', () => {
  assert.throws(() => createPortableSnapshot(state, { now, includeMemory: 'yes' }),
    e => e.code === 'PERSONAL_AGENT_CONTINUITY_INVALID');
  const huge = structuredClone(state);
  huge.memory.Immediate = Array.from({ length: 200 }, (_, i) => ({ key: 'a' + i, text: 'x'.repeat(8000) }));
  assert.throws(() => createPortableSnapshot(huge, { now, includeMemory: true }),
    e => e.code === 'PERSONAL_AGENT_EXPORT_LIMIT' && e.status === 413);
});
