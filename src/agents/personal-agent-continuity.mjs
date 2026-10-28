// Explicit local continuity packet and portable JSON snapshot. No network, scheduler or tool dispatch.
import { createHash } from 'node:crypto';

export const CONTINUITY_SCHEMA = 'vivim.personal-agent.continuity/1';
export const EXPORT_SCHEMA = 'vivim.personal-agent.export/1';
const MAX_EXPORT_BYTES = 1024 * 1024;
const tiers = ['CANON', 'Immediate', 'Curated'];
const fail = (message, status = 400, code = 'PERSONAL_AGENT_CONTINUITY_INVALID') =>
  Object.assign(new Error(message), { status, code });
// A corrupt tier must fail with a stable machine code, never an uncaught TypeError through the HTTP boundary.
const tierEntries = (state, tier) => {
  const value = state.memory?.[tier] ?? [];
  if (!Array.isArray(value)) throw fail(`Stored memory tier is not an array: ${tier}`, 500, 'PERSONAL_AGENT_STATE_CORRUPT');
  return value;
};
const list = (value) => (Array.isArray(value) ? value : []);

export function createContinuityPacket(state, { now, scopeFingerprint = null } = {}) {
  if (!state || typeof state !== 'object' || !state.agentId || !state.stages) throw fail('Invalid agent state');
  // Most recently updated first: continuity must surface the freshest user-authored memory, not insertion order.
  const recent = (tier, limit) => tierEntries(state, tier).map(entry => ({
    key: entry.key, text: entry.text, updatedAt: entry.updatedAt, source: entry.source,
  })).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).slice(0, limit);
  const open = list(state.work).filter(item => ['queued', 'active', 'blocked'].includes(item?.status));
  return {
    schema: CONTINUITY_SCHEMA, assembledAt: now,
    privacy: 'Private local continuity packet; not published as a tool or sent to an AI provider',
    identity: { agentId: state.agentId, role: state.identity?.role ?? 'personal-agent',
      scope: 'local-data-directory', scopeFingerprint,
      assurance: 'local-data-directory-only', providerAccountVerified: false },
    localRevision: state.version,
    bootstrap: Object.fromEntries(Object.entries(state.stages).map(([name, stage]) => [name, {
      status: stage.status, evidence: [...list(stage.evidence)], blocker: stage.blocker ?? null,
    }])),
    memory: {
      CANON: recent('CANON', 20),
      Immediate: recent('Immediate', 20),
      Curated: recent('Curated', 10),
      coverage: 'most recently updated first: up to 20 CANON, 20 Immediate, 10 Curated; explicit user-authored content only',
    },
    work: open.slice(-20).map(item => ({
      id: item.id, title: item.title, objective: item.objective,
      status: item.status, nextAction: item.nextAction,
      updatedAt: item.updatedAt, evidence: list(item.evidence).slice(-10),
    })),
    workCoverage: { openTotal: open.length, included: Math.min(open.length, 20), fullArchive: false,
      selection: 'open Work in creation order; the newest 20 are retained' },
    communications: {
      status: 'not-inspected', note: 'AION peer communications are not automatically imported into local Work',
    },
    execution: {
      permittedByThisPacket: false,
      effectsDuringPacketAssembly: 'none',
      providerActivityOutsideThisPacket: 'not-inspected',
      toolExecutionOutsideThisPacket: 'not-inspected',
    },
  };
}

export function createPortableSnapshot(state, { now, includeMemory = false, includeWorkDetails = false, scopeFingerprint = null } = {}) {
  if (!state || typeof state !== 'object' || !state.agentId || !state.stages) throw fail('Invalid agent state');
  if (typeof includeMemory !== 'boolean' || typeof includeWorkDetails !== 'boolean') throw fail('Export flags must be booleans');
  const payload = {
    schema: EXPORT_SCHEMA, createdAt: now, sourceVersion: state.version,
    identity: { agentId: state.agentId, scope: 'local-data-directory-only', scopeFingerprint,
      providerAccountVerified: false },
    bootstrap: Object.fromEntries(Object.entries(state.stages).map(([name, value]) => [name, {
      status: value.status, updatedAt: value.updatedAt, evidence: [...list(value.evidence)], blocker: value.blocker ?? null,
    }])),
    work: includeWorkDetails ? structuredClone(list(state.work)) : {
      count: list(state.work).length, detailsOmitted: true,
    },
    memory: includeMemory
      ? Object.fromEntries(tiers.map(tier => [tier, structuredClone(tierEntries(state, tier))]))
      : { counts: Object.fromEntries(tiers.map(tier => [tier, tierEntries(state, tier).length])),
        detailsOmitted: true },
    provenance: 'Exported user-owned local state; no remote conversation history or credentials were accessed',
  };
  const serialized = JSON.stringify(payload);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_EXPORT_BYTES) throw fail('Snapshot exceeds 1 MiB export limit; reduce local content or export sections separately', 413, 'PERSONAL_AGENT_EXPORT_LIMIT');
  return {
    schema: EXPORT_SCHEMA, payload,
    checksum: 'sha256:' + createHash('sha256').update(serialized).digest('hex'),
    bytes, includesPrivateMemory: includeMemory, includesPrivateWorkDetails: includeWorkDetails,
    importSupported: false,
    warning: 'Retain this JSON locally. Explicitly included memory and Work data can contain sensitive personal information.',
  };
}
