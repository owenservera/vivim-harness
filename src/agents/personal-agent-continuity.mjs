// Explicit local continuity packet and portable JSON snapshot. No network, scheduler or tool dispatch.
import { createHash } from 'node:crypto';

export const CONTINUITY_SCHEMA = 'vivim.personal-agent.continuity/1';
export const EXPORT_SCHEMA = 'vivim.personal-agent.export/1';
const MAX_EXPORT_BYTES = 1024 * 1024;
const tiers = ['CANON', 'Immediate', 'Curated'];
const fail = (message, status = 400, code = 'PERSONAL_AGENT_CONTINUITY_INVALID') =>
  Object.assign(new Error(message), { status, code });

export function createContinuityPacket(state, { now }) {
  if (!state || typeof state !== 'object' || !state.agentId || !state.stages) throw fail('Invalid agent state');
  const recent = (tier, limit) => (state.memory?.[tier] ?? []).slice(-limit).map(entry => ({
    key: entry.key, text: entry.text, updatedAt: entry.updatedAt, source: entry.source,
  }));
  const open = (state.work ?? []).filter(item => ['queued', 'active', 'blocked'].includes(item.status));
  return {
    schema: CONTINUITY_SCHEMA, assembledAt: now,
    privacy: 'Private local continuity packet; not published as a tool or sent to an AI provider',
    identity: { agentId: state.agentId, role: state.identity?.role ?? 'personal-agent',
      assurance: 'local-data-directory-only', providerAccountVerified: false },
    localRevision: state.version,
    bootstrap: Object.fromEntries(Object.entries(state.stages).map(([name, stage]) => [name, {
      status: stage.status, evidence: [...stage.evidence], blocker: stage.blocker ?? null,
    }])),
    memory: {
      CANON: recent('CANON', 20),
      Immediate: recent('Immediate', 20),
      Curated: recent('Curated', 10),
      coverage: 'last 20 CANON, last 20 Immediate, last 10 Curated; explicit user-authored content only',
    },
    work: open.slice(-20).map(item => ({
      id: item.id, title: item.title, objective: item.objective,
      status: item.status, nextAction: item.nextAction,
      updatedAt: item.updatedAt, evidence: item.evidence.slice(-10),
    })),
    workCoverage: { openTotal: open.length, included: Math.min(open.length, 20), fullArchive: false },
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

export function createPortableSnapshot(state, { now, includeMemory = false, includeWorkDetails = false } = {}) {
  if (!state || typeof state !== 'object' || !state.agentId || !state.stages) throw fail('Invalid agent state');
  if (typeof includeMemory !== 'boolean' || typeof includeWorkDetails !== 'boolean') throw fail('Export flags must be booleans');
  const payload = {
    schema: EXPORT_SCHEMA, createdAt: now, sourceVersion: state.version,
    identity: { agentId: state.agentId, scope: 'local-data-directory-only',
      providerAccountVerified: false },
    bootstrap: Object.fromEntries(Object.entries(state.stages).map(([name, value]) => [name, {
      status: value.status, updatedAt: value.updatedAt, evidence: [...value.evidence], blocker: value.blocker ?? null,
    }])),
    work: includeWorkDetails ? structuredClone(state.work ?? []) : {
      count: (state.work ?? []).length, detailsOmitted: true,
    },
    memory: includeMemory
      ? Object.fromEntries(tiers.map(tier => [tier, structuredClone(state.memory?.[tier] ?? [])]))
      : { counts: Object.fromEntries(tiers.map(tier => [tier, (state.memory?.[tier] ?? []).length])),
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
