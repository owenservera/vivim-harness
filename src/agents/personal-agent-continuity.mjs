// Explicit local continuity packet and portable JSON snapshot. No network, scheduler or tool dispatch.
import { createHash, timingSafeEqual } from 'node:crypto';
import { BOOTSTRAP_STAGES } from './personal-agent-bootstrap.mjs';
import { WORK_STATES, MAX_WORK_ITEMS } from './personal-agent-work.mjs';

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


// Preflight is READ ONLY. A checksum detects accidental edits, not who authored the
// snapshot. Do not infer remote identity, safely import it, or grant execution rights.
export const MAX_AGENT_EXPORT_DOCUMENT_BYTES = MAX_EXPORT_BYTES + 64 * 1024;
export function inspectPortableSnapshot(bundle) {
  const invalid = (message, code = 'PERSONAL_AGENT_EXPORT_INVALID') => fail(message, 400, code);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw invalid('Expected a Personal Agent JSON export envelope');
  }
  let documentJson;
  try { documentJson = JSON.stringify(bundle); }
  catch { throw invalid('Snapshot cannot be serialized'); }
  if (typeof documentJson !== 'string' || Buffer.byteLength(documentJson, 'utf8') > MAX_AGENT_EXPORT_DOCUMENT_BYTES) {
    throw invalid('Snapshot envelope exceeds safety limit', 'PERSONAL_AGENT_EXPORT_LIMIT');
  }
  if (bundle.schema !== EXPORT_SCHEMA || bundle.payload?.schema !== EXPORT_SCHEMA ||
      typeof bundle.payload !== 'object' || Array.isArray(bundle.payload)) {
    throw invalid('Unsupported Personal Agent snapshot schema', 'PERSONAL_AGENT_EXPORT_SCHEMA');
  }
  const payload = bundle.payload;
  const serialized = JSON.stringify(payload);
  const actualBytes = Buffer.byteLength(serialized, 'utf8');
  if (actualBytes > MAX_EXPORT_BYTES || !Number.isSafeInteger(bundle.bytes) || bundle.bytes !== actualBytes) {
    throw invalid('Snapshot size does not match its contents', 'PERSONAL_AGENT_EXPORT_SIZE');
  }
  if (typeof bundle.checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(bundle.checksum)) {
    throw invalid('Missing or invalid SHA-256 checksum', 'PERSONAL_AGENT_EXPORT_CHECKSUM');
  }
  const hash = createHash('sha256').update(serialized).digest('hex');
  if (!timingSafeEqual(Buffer.from(bundle.checksum.slice(7), 'hex'), Buffer.from(hash, 'hex'))) {
    throw invalid('Snapshot checksum does not match its contents', 'PERSONAL_AGENT_EXPORT_CHECKSUM');
  }
  if (bundle.includesPrivateMemory !== true && bundle.includesPrivateMemory !== false ||
      bundle.includesPrivateWorkDetails !== true && bundle.includesPrivateWorkDetails !== false) {
    throw invalid('Privacy inclusion flags must be booleans');
  }
  if (bundle.importSupported !== false || !Number.isSafeInteger(payload.sourceVersion) ||
      payload.sourceVersion < 1 || payload.sourceVersion > 9999 ||
      typeof payload.createdAt !== 'string' || payload.createdAt.length > 64 ||
      payload.identity?.agentId !== 'primary' ||
      payload.identity?.scope !== 'local-data-directory-only' ||
      payload.identity?.providerAccountVerified !== false) {
    throw invalid('Snapshot identity or provenance contract is not supported');
  }
  if (!payload.bootstrap || typeof payload.bootstrap !== 'object' || Array.isArray(payload.bootstrap) ||
      Object.keys(payload.bootstrap).length !== BOOTSTRAP_STAGES.length) {
    throw invalid('Snapshot bootstrap stages are incomplete');
  }
  for (const name of BOOTSTRAP_STAGES) {
    const stage = payload.bootstrap[name];
    if (!stage || !['pending', 'blocked', 'completed'].includes(stage.status) ||
        !Array.isArray(stage.evidence) || stage.evidence.length > 50 ||
        stage.evidence.some(ref => typeof ref !== 'string' || ref.length > 256) ||
        (stage.status === 'completed' && stage.evidence.length === 0)) {
      throw invalid('Snapshot contains invalid bootstrap stage evidence');
    }
  }
  let memoryCounts;
  if (bundle.includesPrivateMemory) {
    if (!payload.memory || typeof payload.memory !== 'object' || Array.isArray(payload.memory) ||
        Object.keys(payload.memory).length !== tiers.length) throw invalid('Private memory tiers are incomplete');
    memoryCounts = {};
    for (const tier of tiers) {
      const entries = payload.memory[tier];
      if (!Array.isArray(entries) || entries.length > 500 ||
          entries.some(item => !item || typeof item.key !== 'string' ||
            !/^[a-z][a-z0-9_-]{0,63}$/.test(item.key) ||
            typeof item.text !== 'string' || !item.text.trim() || item.text.length > 8000 ||
            item.source !== 'user-authored')) {
        throw invalid('Snapshot contains invalid private memory entries');
      }
      memoryCounts[tier] = entries.length;
    }
  } else {
    if (payload.memory?.detailsOmitted !== true || !payload.memory.counts) {
      throw invalid('Expected privacy-preserving memory counts');
    }
    memoryCounts = {};
    for (const tier of tiers) {
      const count = payload.memory.counts[tier];
      if (!Number.isSafeInteger(count) || count < 0 || count > 500) throw invalid('Invalid omitted-memory count');
      memoryCounts[tier] = count;
    }
  }
  let workCount;
  if (bundle.includesPrivateWorkDetails) {
    if (!Array.isArray(payload.work) || payload.work.length > MAX_WORK_ITEMS ||
        payload.work.some(item => !item ||
          !/^work-[a-f0-9]{32}$/.test(item.id ?? '') ||
          typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160 ||
          typeof item.objective !== 'string' || !item.objective.trim() || item.objective.length > 4000 ||
          !WORK_STATES.includes(item.status) || item.source !== 'user-authored' ||
          !Array.isArray(item.events) || item.events.length > 100 || !Array.isArray(item.evidence))) {
      throw invalid('Snapshot contains invalid private Work entries');
    }
    workCount = payload.work.length;
  } else {
    if (payload.work?.detailsOmitted !== true ||
        !Number.isSafeInteger(payload.work.count) || payload.work.count < 0 || payload.work.count > MAX_WORK_ITEMS) {
      throw invalid('Expected privacy-preserving Work count');
    }
    workCount = payload.work.count;
  }
  return {
    schema: EXPORT_SCHEMA, checksumVerified: true, bytes: actualBytes,
    sourceRevision: payload.sourceVersion, memoryCounts, workCount,
    includesPrivateMemory: bundle.includesPrivateMemory,
    includesPrivateWorkDetails: bundle.includesPrivateWorkDetails,
    importSupported: false, imported: false, sourceAuthenticated: false,
    integrity: 'unkeyed-sha256; accidental-tampering-detection-only',
    qualification: 'Snapshot structure and checksum verified, not its author, provider account, or live execution history. Import is unsupported.',
  };
}
