import { createHash } from 'node:crypto';
import { stableStringify } from '../intel/similarity.mjs';
import { validateStoreName } from '../store/versioned.mjs';
import { storeProblem } from './http.mjs';
import { legacySelectionFingerprint } from './world-relations.mjs';

export const WORLD_EXPORT_LIMITS = Object.freeze({ maxSelected: 100, maxRecords: 256,
  maxDependenciesPerRecord: 3000, maxRecordBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 });
export const IMPORT_CONTENT_LIMITS = Object.freeze({ maxMessages: 200, maxBlocks: 200, maxNodes: 2000, maxDepth: 12, maxTextChars: 262144, maxBlockBytes: 512 * 1024, maxErrors: 100, maxDeps: 1000 });
const BLOCK_TYPE_RE = /^[a-z][a-z0-9_+#-]{0,63}$/;
const FORBIDDEN_KEY = new Set(['__proto__', 'constructor', 'prototype']);
const fail = (code, message) => Object.assign(new Error(message), { code, status: code === 'WORLD_EXPORT_LIMIT' ? 413 : 400 });
const validId = (id) => typeof id === 'string' && (/^c-(?:[a-f0-9]{40}|i[a-f0-9]{38})$/.test(id)
  || /^[npos]-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  || /^[npos]-[a-f0-9]{36}f$/.test(id));
const hash = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
export const importedConversationId = (id) => typeof id === 'string' && /^c-i[a-f0-9]{38}$/.test(id);
const localId = (digest, id) => id.startsWith('c-') ? `c-i${hash([digest, id]).slice(0, 38)}` : `${id[0]}-${hash([digest, id]).slice(0, 36)}f`;
const contentErrors = (record) => {
  const errors = [], messages = record?.data?.messages, state = { nodes: 0, capped: false };
  const push = (message) => { if (errors.length < IMPORT_CONTENT_LIMITS.maxErrors) errors.push({ id: record.id, code: 'WORLD_IMPORT_CONTENT', message }); };
  const walk = (value, depth) => {
    if (state.nodes >= IMPORT_CONTENT_LIMITS.maxNodes) { if (!state.capped) push('imported content exceeds node budget'); state.capped = true; return; }
    if (depth > IMPORT_CONTENT_LIMITS.maxDepth) { push('imported content exceeds depth'); return; }
    state.nodes++;
    if (typeof value === 'string') { if (value.length > IMPORT_CONTENT_LIMITS.maxTextChars) push('imported string exceeds capture text cap'); return; }
    if (value === null || typeof value !== 'object') { if (['function', 'bigint', 'symbol'].includes(typeof value)) push('imported content contains a non-JSON value'); return; }
    if (Array.isArray(value)) { if (value.length > IMPORT_CONTENT_LIMITS.maxBlocks) push('imported array exceeds block cap'); for (const child of value.slice(0, IMPORT_CONTENT_LIMITS.maxBlocks)) walk(child, depth + 1); return; }
    if (Object.keys(value).some((key) => FORBIDDEN_KEY.has(key))) push('imported content contains a forbidden key');
    if (value.type !== undefined && (typeof value.type !== 'string' || !BLOCK_TYPE_RE.test(value.type))) push('imported block type is invalid');
    if (value.text !== undefined && typeof value.text !== 'string') push('imported block text must be a string');
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  if (!Array.isArray(messages)) { push('messages must be an array'); return errors; }
  if (messages.length > IMPORT_CONTENT_LIMITS.maxMessages) push('too many messages');
  for (const message of messages.slice(0, IMPORT_CONTENT_LIMITS.maxMessages)) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) { push('message must be an object'); continue; }
    if (typeof message.text !== 'string' || message.text.length > IMPORT_CONTENT_LIMITS.maxTextChars) push('message text must be a bounded string');
    if (typeof message.role !== 'string' || message.role.length > 64) push('message role must be a string of at most 64 characters');
    if (!Array.isArray(message.blocks)) push('message blocks must be an array');
    walk(message, 0);
  }
  return errors;
};
const inspect = (value, depth, seen) => {
  if (depth > IMPORT_CONTENT_LIMITS.maxDepth + 8) throw fail('WORLD_IMPORT_CONTENT', 'bundle exceeds depth');
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw fail('WORLD_IMPORT_CONTENT', 'bundle contains a cycle');
  seen.add(value);
  for (const child of Object.values(value)) inspect(child, depth + 1, seen);
};
const bytes = (value) => { inspect(value, 0, new WeakSet()); return Buffer.byteLength(stableStringify(value), 'utf8'); };
const list = (value, limit = 100) => Array.isArray(value) ? value.slice(0, limit) : [];
const dependencies = (record, errors) => ['conversationIds', 'noteIds', 'memberIds', 'commentsOn', 'objectId', 'conversationId'].flatMap((key) => {
  const value = record?.data?.[key];
  if (value === undefined) return [];
  if (['objectId', 'conversationId'].includes(key)) return [value];
  if (!Array.isArray(value)) { errors.push({ id: record?.id ?? null, code: 'WORLD_IMPORT_CONTENT', message: `${key} must be an array` }); return []; }
  if (value.length > IMPORT_CONTENT_LIMITS.maxDeps) errors.push({ id: record.id, code: 'WORLD_IMPORT_CONTENT', message: `${key} exceeds dependency cap` });
  return value.slice(0, IMPORT_CONTENT_LIMITS.maxDeps);
});
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const jsonCopy = (value) => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw fail('WORLD_EXPORT_INVALID_RECORD', 'Service returned a non-JSON record'); }
};
const types = { p: ['project', 'project'], n: ['note', 'note'], o: ['object', 'source-reference'],
  s: ['selection', 'selection'], c: ['conversation', 'conversation'] };
const errorReason = (error) => ({ WORLD_NOT_FOUND: 'SOURCE_OR_OBJECT_MISSING', WORLD_SOURCE_ACTIVE: 'SOURCE_ACTIVE',
  STORE_NO_SUCH_ITEM: 'OBJECT_MISSING', STORE_RECORD_CORRUPT: 'OVERLAY_UNREADABLE', STORE_CURRENT_CORRUPT: 'OVERLAY_UNREADABLE' })[error?.code];
export const EXPORT_MODES = Object.freeze(['references', 'transcript', 'full-saved']);
const REASONING_BLOCK = new Set(['reasoning', 'thinking', 'thought']);
const TOOL_BLOCK = new Set(['tool', 'tool_use', 'tool-use', 'tool-activity', 'function', 'function_call', 'function-call', 'tool_call', 'tool-call', 'status', 'status_activity', 'status-activity']);
const TRANSCRIPT_BLOCK = new Set(['text', 'paragraph', 'heading', 'code', 'table', 'list', 'quote', 'blockquote']);
const exclusionReason = (type) => REASONING_BLOCK.has(type) ? 'reasoning-blocks-excluded'
  : TOOL_BLOCK.has(type) ? 'tool-activity-blocks-excluded' : 'non-transcript-blocks-excluded';
// Mode reduction prunes only block objects; plain data (message text, roles, plain objects) is never touched.
const pruneBlocks = (value, depth, keep, stats) => {
  if (depth > IMPORT_CONTENT_LIMITS.maxDepth) { stats.affected++; return undefined; }
  if (Array.isArray(value)) {
    return value.slice(0, IMPORT_CONTENT_LIMITS.maxBlocks)
      .map((child) => pruneBlocks(child, depth + 1, keep, stats)).filter((kept) => kept !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  if (value.type !== undefined) {
    const type = String(value.type).toLowerCase();
    if (!keep(type)) {
      const reason = exclusionReason(type), bin = stats.bins.get(reason) ?? { count: 0 };
      bin.count++; stats.bins.set(reason, bin); stats.affected++; return undefined;
    }
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = Array.isArray(child) ? pruneBlocks(child, depth + 1, keep, stats) : child;
  }
  return out;
};
const reduceMessages = (data, keep, omitted, id) => {
  const stats = { bins: new Map(), affected: 0 };
  data.messages = data.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !Array.isArray(message.blocks)) return message;
    const before = stats.affected;
    message.blocks = pruneBlocks(message.blocks, 1, keep, stats);
    if (stats.affected > before) stats.affected = before + 1; // one affected message per reduction decision
    return message;
  });
  for (const [reason, bin] of stats.bins) omitted.push({ id, reason, aspect: 'content', expected: true, count: bin.count });
};

// Local JSON export only. Reads through world owners, never opens paths, writes state or contacts providers.
export function createWorldTransfer({ service }) {
  if (!service || typeof service.namespace !== 'function') throw new TypeError('World service required');
  return {
    exportSelection(request) {
      const partValid = request === null || request.parts === undefined || (typeof request.parts === 'object' && !Array.isArray(request.parts)
        && Object.keys(request.parts ?? {}).every((key) => ['reasoning', 'toolActivity'].includes(key))
        && Object.values(request.parts ?? {}).every((value) => typeof value === 'boolean'));
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some((key) => !['ids', 'includeSources', 'mode', 'parts'].includes(key))
        || !Array.isArray(request.ids) || request.ids.length < 1 || request.ids.length > WORLD_EXPORT_LIMITS.maxSelected
        || !request.ids.every(validId) || request.includeSources !== undefined && typeof request.includeSources !== 'boolean'
        || request.mode !== undefined && !EXPORT_MODES.includes(request.mode) || !partValid) {
        throw fail('WORLD_EXPORT_INVALID_INPUT', 'Expected 1..100 exact world IDs and optional boolean includeSources, export mode and parts flags');
      }
      // Named mode wins; legacy includeSources keeps the old verbatim full snapshot without content filtering.
      const mode = request.mode ?? (request.includeSources ? 'full-saved' : 'references');
      const legacyFull = request.mode === undefined && request.includeSources === true;
      const parts = { reasoning: request.parts?.reasoning ?? legacyFull, toolActivity: request.parts?.toolActivity ?? legacyFull };
      const keep = mode === 'transcript' ? (type) => TRANSCRIPT_BLOCK.has(type)
        : mode === 'full-saved' ? (type) => (!REASONING_BLOCK.has(type) || parts.reasoning) && (!TOOL_BLOCK.has(type) || parts.toolActivity)
        : null; // legacy full and non-content modes keep every stored block untouched
      const reduce = keep ? (data, omitted, id) => Array.isArray(data.messages) && reduceMessages(data, keep, omitted, id) : null;
      const selected = [...new Set(request.ids)].sort(), includeSources = mode !== 'references';
      const queue = [...selected], discovered = new Set(queue), records = [], omitted = [];
      const namespace = { ...jsonCopy(service.namespace()), role: 'origin-namespace' };
      let payloadBytes = bytes(namespace);
      const omit = (id, reason, aspect = 'record', expected = false) => omitted.push({ id, reason, aspect, expected });
      const enqueue = (dependencies) => {
        if (dependencies.length > WORLD_EXPORT_LIMITS.maxDependenciesPerRecord) throw fail('WORLD_EXPORT_LIMIT', 'Dependency count exceeds export limit');
        for (const id of [...new Set(dependencies)].sort()) {
          if (!validId(id)) throw fail('WORLD_EXPORT_INVALID_RECORD', 'Stored relation contains an invalid world ID');
          if (discovered.has(id)) continue;
          if (discovered.size >= WORLD_EXPORT_LIMITS.maxRecords) throw fail('WORLD_EXPORT_LIMIT', 'Dependency closure exceeds export limit');
          discovered.add(id); queue.push(id);
        }
      };
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index], [method, kind] = types[id[0]];
        let data, observed = null, custody = id.startsWith('c-') ? 'referenced-only' : 'user-overlay';
        try {
          if (kind === 'conversation') {
            data = service.conversationMetadata(id);
            if (data.custody === 'imported') {
              custody = includeSources ? 'imported-snapshot' : 'referenced-only';
              data = includeSources ? service.conversation(id) : data;
              if (!includeSources) omit(id, 'SOURCES_NOT_REQUESTED', 'content', true);
            } else if (data.availability === 'unavailable') omit(id, data.availabilityReason ?? 'SOURCE_UNAVAILABLE', 'content');
            else if (includeSources) {
              const projection = service.conversation(id);
              if (['missing', 'unavailable'].includes(projection.coverage?.state)) {
                omit(id, projection.coverage.reason ?? (projection.coverage.state === 'missing' ? 'EVIDENCE_MISSING' : 'SOURCE_UNAVAILABLE'), 'content');
              } else {
                data = { ...projection, identity: { ...projection.identity, qualification: 'imported-claim-on-restore', account: { state: 'unknown', ref: null } } }; custody = 'saved-observation';
                if (projection.coverage?.state !== 'saved-observation') omit(id, 'PARTIAL_SOURCE_OBSERVATION', 'content');
              }
            } else omit(id, 'SOURCES_NOT_REQUESTED', 'content', true);
          } else if (kind === 'source-reference' || kind === 'selection') {
            const derived = service[method](id), stored = service[kind === 'selection' ? 'storedSelection' : 'storedObject'](id);
            data = stored; observed = { availability: derived.availability, availabilityReason: derived.availabilityReason ?? null, coverage: derived.coverage ?? null };
            if (['missing', 'unavailable', 'stale'].includes(derived.availability)) omit(id, derived.availabilityReason ?? 'SOURCE_UNRESOLVED', 'source');
          } else data = service[method](id);
        } catch (error) {
          const reason = errorReason(error);
          if (!reason) throw error;
          omit(id, id.startsWith('c-') && error.code === 'WORLD_NOT_FOUND' ? 'SOURCE_MISSING' : reason);
          continue;
        }
        data = jsonCopy(data);
        if (data.id !== id || kind !== 'conversation' && data.kind !== kind) throw fail('WORLD_EXPORT_INVALID_RECORD', 'Service record identity/type mismatch');
        if (kind === 'conversation' && reduce) reduce(data, omitted, id);

        if (kind === 'project' && ['conversationIds', 'noteIds', 'memberIds'].some((key) => data[key] !== undefined && !Array.isArray(data[key]))) {
          throw fail('WORLD_EXPORT_INVALID_RECORD', 'Invalid project dependency list');
        }
        const dependencies = kind === 'project' ? [...(data.conversationIds ?? []), ...(data.noteIds ?? []), ...(data.memberIds ?? [])]
          : kind === 'note' ? data.commentsOn ?? [] : kind === 'selection' ? [data.objectId]
            : kind === 'source-reference' ? [data.conversationId] : [];
        if (!Array.isArray(dependencies)) throw fail('WORLD_EXPORT_INVALID_RECORD', 'Invalid dependency list');
        enqueue(dependencies);
        const record = { id, kind, custody, data }, size = bytes(record);
        if (size > WORLD_EXPORT_LIMITS.maxRecordBytes || payloadBytes + size > WORLD_EXPORT_LIMITS.maxTotalBytes) {
          throw fail('WORLD_EXPORT_LIMIT', 'Export payload exceeds byte limit');
        }
        payloadBytes += size;
        records.push({ ...record, ...(observed ? { observed } : {}), sha256: hash(record) });
      }
      const staleObjects = new Set(omitted.filter((item) => item.reason === 'REVISION_CHANGED').flatMap((item) => records.filter((record) => record.id === item.id).map((record) => record.data.objectId)));
      const staleConversations = new Set(records.filter((record) => staleObjects.has(record.id)).map((record) => record.data.conversationId));
      for (const id of staleConversations) {
        const index = records.findIndex((record) => record.id === id && record.custody === 'saved-observation');
        if (index < 0) continue;
        const data = service.conversationMetadata(id); records.splice(index, 1);
        const record = { id, kind: 'conversation', custody: 'referenced-only', data };
        records.push({ ...record, sha256: hash(record) }); omit(id, 'REVISION_CHANGED', 'content');
      }
      records.sort((a, b) => compare(a.id, b.id));
      omitted.sort((a, b) => compare(stableStringify(a), stableStringify(b)));
      const payload = { schema: 'vivim.world-export/1', namespace,
        scope: { ids: selected, includeSources, mode, parts: { reasoning: parts.reasoning, toolActivity: parts.toolActivity }, dependencyClosure: 'outgoing-world-references', limits: WORLD_EXPORT_LIMITS,
          exclusions: ['raw-capture-files', 'browser-profiles', 'credentials-stores', 'provider-network', 'unrelated-world-records', 'external-asset-bytes'] },
        records, omitted,
        coverage: { complete: !omitted.some((o) => !o.expected), declaredScope: 'selected local records and outgoing dependency closure only',
          mode, modeSemantics: legacyFull ? 'legacy includeSources request exported verbatim; named modes filter content per scope.parts'
            : mode === 'references' ? 'metadata only; source conversations may not be present'
            : 'stored record content only; see scope.parts and omitted for what the mode did not include',
          providerCompleteness: 'not-established', recordsIncluded: records.length, referencesDiscovered: discovered.size,
          sourceSnapshotsIncluded: records.filter((r) => r.custody === 'saved-observation').length,
          referenceOnlyRevision: includeSources ? 'not-applicable' : 'selection revisions may point to content absent from this bundle',
          qualification: 'User overlays are not provider assertions; source snapshots retain observed uncertainty. Selected content is not automatically redacted.' } };
      if (bytes(payload) > WORLD_EXPORT_LIMITS.maxTotalBytes) throw fail('WORLD_EXPORT_LIMIT', 'Export envelope exceeds byte limit');
      const bundle = { ...payload, integrity: { algorithm: 'sha256', canonicalization: 'stableStringify',
        recordScope: 'record excluding sha256', bundleScope: 'bundle excluding integrity', sha256: hash(payload),
        purpose: 'integrity only; never object identity or provider verification' } };
      if (bytes(bundle) > WORLD_EXPORT_LIMITS.maxTotalBytes) throw fail('WORLD_EXPORT_LIMIT', 'Export bundle exceeds byte limit');
      return bundle;
    },
    validateBundle(request) {
      if (!request || typeof request !== 'object' || !request.bundle || Object.keys(request).some((key) => key !== 'bundle')) throw fail('WORLD_IMPORT_INVALID_INPUT', 'Expected {bundle}');
      const bundle = request.bundle, errors = [], unresolved = [];
      if (bundle && typeof bundle === 'object' && bytes(bundle) > WORLD_EXPORT_LIMITS.maxTotalBytes) throw fail('WORLD_EXPORT_LIMIT', 'Bundle exceeds byte limit');
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.schema !== 'vivim.world-export/1'
        || !bundle.namespace?.id || !Array.isArray(bundle.records) || bundle.records.length > WORLD_EXPORT_LIMITS.maxRecords
        || !bundle.integrity || bundle.integrity.algorithm !== 'sha256') errors.push({ code: 'WORLD_IMPORT_INVALID_BUNDLE', message: 'Malformed or unsafe bundle' });
      const { integrity, ...payload } = bundle ?? {}, digest = errors.length ? null : hash(payload);
      if (digest && digest !== bundle.integrity.sha256) errors.push({ code: 'WORLD_IMPORT_DIGEST_MISMATCH', message: 'Bundle integrity digest mismatch' });
      if (!Array.isArray(bundle?.omitted) || !bundle?.coverage || typeof bundle.coverage.complete !== 'boolean') errors.push({ code: 'WORLD_IMPORT_COVERAGE_MISSING', message: 'Bundle omitted list and coverage are required' });
      const records = Array.isArray(bundle?.records) ? bundle.records : [];
      const seen = new Set();
      for (const record of records) {
        if (seen.has(record?.id)) errors.push({ id: record?.id ?? null, code: 'WORLD_IMPORT_DUPLICATE_ID', message: 'Duplicate bundle record ID' });
        seen.add(record?.id);
        const prefix = { c: 'conversation', p: 'project', n: 'note', o: 'source-reference', s: 'selection' }[record?.id?.[0]];
        if (record?.kind !== prefix || record?.data?.kind && record.kind !== 'conversation' && record.data.kind !== record.kind) errors.push({ id: record?.id ?? null, code: 'WORLD_IMPORT_RECORD_CONFLICT', message: 'Record ID, envelope kind and data kind disagree' });
      }
      const ids = new Set(records.map((record) => record?.id));
      const idMap = {};
      for (const record of records) if (validId(record?.id) && !Object.hasOwn(idMap, record.id)) idMap[record.id] = localId(digest, record.id);
      const rewrite = (id) => {
        if (!validId(id) || !ids.has(id)) { unresolved.push({ id: id ?? null, reason: 'NOT_IN_BUNDLE' }); return null; }
        return idMap[id];
      };
      for (const record of records) {
        const hashed = (({ observed, sha256, ...stored }) => stored)(record ?? {});
        if (!validId(record?.id) || record.data?.id !== record.id || record.sha256 !== hash(hashed)) errors.push({ id: record?.id ?? null, code: 'WORLD_IMPORT_RECORD_INTEGRITY', message: 'Record integrity mismatch' });
        if (record?.data?.namespaceId && record.data.namespaceId !== bundle.namespace.id) unresolved.push({ id: record.id, reason: 'FOREIGN_NAMESPACE' });
        for (const id of dependencies(record, errors)) if (typeof id === 'string') rewrite(id);
        if (record?.kind === 'conversation' && !['saved-observation', 'imported-snapshot'].includes(record.custody)) unresolved.push({ id: record.id, reason: 'REFERENCE_ONLY' });
      }
      const skipped = new Set(unresolved.filter((item) => item.reason === 'REFERENCE_ONLY').map((item) => item.id));
      for (const record of records) {
        const owner = record?.kind === 'selection' ? records.find((item) => item.id === record.data?.objectId) : null;
        const required = record?.kind === 'selection' ? [record.data?.objectId, owner?.data?.conversationId].filter(Boolean) : record?.kind === 'source-reference' ? [record.data?.conversationId].filter(Boolean) : [];
        if (required.some((id) => skipped.has(id) || !ids.has(id))) { skipped.add(record.id); unresolved.push({ id: record.id, reason: 'DEPENDENT_SKIPPED' }); }
        if (['saved-observation', 'imported-snapshot'].includes(record?.custody)) {
          if (!Array.isArray(record.data?.messages) || bytes(record.data.messages) > WORLD_EXPORT_LIMITS.maxRecordBytes) errors.push({ id: record.id, code: 'WORLD_EXPORT_LIMIT', message: 'Imported snapshot exceeds cap' });
          errors.push(...contentErrors(record));
        }
      }
      try { if (digest) validateStoreName(`i-${digest.slice(0, 40)}`, 'import receipt'); } catch (error) { errors.push({ code: error.code, message: error.message }); }
      const omitted = list(bundle?.omitted), shownErrors = list(errors);
      return { valid: errors.length === 0, digest, counts: { records: records.length, unresolved: unresolved.length, omitted: Array.isArray(bundle?.omitted) ? bundle.omitted.length : 0, errors: errors.length }, idMap, unresolved: list(unresolved), omitted, coverage: bundle?.coverage ?? null, errors: shownErrors };
    },
    restoreBundle(request = {}) {
      const dryRun = request.dryRun ?? true;
      if (typeof dryRun !== 'boolean' || request.confirm !== undefined && typeof request.confirm !== 'boolean' || !dryRun && request.confirm !== true) throw fail('WORLD_IMPORT_CONFIRMATION_REQUIRED', 'Restore writes require dryRun:false and confirm:true');
      const report = this.validateBundle({ bundle: request.bundle });
      if (report.errors.some((error) => error.code === 'WORLD_IMPORT_CONTENT')) throw Object.assign(fail('WORLD_IMPORT_CONTENT', 'Imported message content is invalid'), { report });
      if (!report.valid || request.digest !== report.digest) throw Object.assign(fail('WORLD_IMPORT_DIGEST_MISMATCH', 'Restore digest was not verified'), { report });
      const plan = { ...report, dryRun, applied: [], skipped: [], failed: [], pending: report.valid ? request.bundle.records.map((record) => record.id) : [], partial: report.unresolved.length > 0, receipt: null };
      if (dryRun) return plan;
      const map = report.idMap, rewrite = (values) => (values ?? []).flatMap((id) => map[id] ? [map[id]] : []);
      const ordered = [...request.bundle.records].sort((a, b) => ['conversation', 'source-reference', 'selection', 'project', 'note'].indexOf(a.kind) - ['conversation', 'source-reference', 'selection', 'project', 'note'].indexOf(b.kind));
      const blocked = new Set();
      for (const record of ordered) {
        const id = map[record.id];
        const owner = record.kind === 'selection' ? request.bundle.records.find((item) => item.id === record.data?.objectId) : null;
        const required = record.kind === 'selection' ? [record.data?.objectId, owner?.data?.conversationId].filter(Boolean) : record.kind === 'source-reference' ? [record.data?.conversationId] : [];
        if (required.some((target) => !map[target] || blocked.has(target))) { blocked.add(record.id); plan.skipped.push(record.id); plan.partial = true; plan.pending = plan.pending.filter((item) => item !== record.id); continue; }
        try {
          const existing = service.loadImportRecord(id);
          const importedFrom = { digest: report.digest, originalId: record.id, namespaceId: request.bundle.namespace.id };
          if (existing) {
            if (stableStringify(existing.importedFrom) !== stableStringify(importedFrom)) throw fail('WORLD_IMPORT_COLLISION', `Imported ID ${id} belongs to different content`);
            plan.skipped.push(record.id); plan.pending = plan.pending.filter((item) => item !== record.id); continue;
          }
          const data = jsonCopy(record.data);
          for (const key of ['conversationIds', 'noteIds', 'memberIds', 'commentsOn']) if (Array.isArray(data[key])) data[key] = rewrite(data[key]);
          if (data.objectId) data.objectId = map[data.objectId] ?? null;
          if (data.conversationId) data.conversationId = map[data.conversationId] ?? null;
          if (record.kind === 'conversation' && !['saved-observation', 'imported-snapshot'].includes(record.custody)) { blocked.add(record.id); plan.skipped.push(record.id); plan.partial = true; plan.pending = plan.pending.filter((item) => item !== record.id); continue; }
          if (record.kind !== 'conversation' && ['stale', 'unavailable'].includes(record.observed?.availability)) { blocked.add(record.id); plan.skipped.push(record.id); plan.partial = true; plan.pending = plan.pending.filter((item) => item !== record.id); continue; }
          if (record.kind === 'conversation') {
            const messages = data.messages.map((message) => ({ ...message, source: { ...(message.source ?? {}), kind: 'imported-reference', sessionId: null, originSessionId: message.source?.sessionId ?? null } }));
            service.importRecord(id, { id, kind: 'conversation', custody: 'imported-snapshot', title: data.title ?? record.id, messages, identity: data.identity, source: { ...data.source, kind: 'imported-reference', sessionId: null }, importedFrom });
          } else if (record.kind === 'selection') {
            const owner = service.object(data.objectId), projection = service.conversation(owner.conversationId);
            data.source = { ...data.source, revision: legacySelectionFingerprint(projection.messages), sessionId: null, revisionBasis: 'legacy imported snapshot fingerprint' };
            data.importedFrom = importedFrom; data.custody = 'imported'; service.importRecord(id, { ...data, id, namespaceId: service.namespace().id });
          } else {
            data.importedFrom = importedFrom; data.custody = 'imported'; data.namespaceId = service.namespace().id; data.id = id;
            service.importRecord(id, data);
          }
          plan.applied.push(record.id); plan.pending = plan.pending.filter((item) => item !== record.id);
        } catch (error) {
          plan.failed.push({ id: record.id, code: error.code ?? 'WORLD_IMPORT_FAILED', message: error.message });
          plan.partial = true; break;
        }
      }
      const receiptId = `i-${report.digest.slice(0, 40)}`;
      validateStoreName(receiptId, 'import receipt');
      const receipt = { id: receiptId, kind: 'import-receipt', digest: report.digest, skipped: list(plan.skipped), failed: list(plan.failed), unresolved: list(report.unresolved), partial: plan.partial || plan.failed.length > 0 };
      try { if (!service.loadImportRecord(receiptId)) service.importRecord(receiptId, receipt); }
      catch (error) { throw storeProblem(error); }
      plan.receipt = receiptId; plan.partial = receipt.partial;
      return plan;
    },
  };
}

export function registerWorldTransferRoutes({ add, service }) {
  const transfer = createWorldTransfer({ service });
  const guarded = (fn) => (args) => { try { return fn(args); } catch (error) { throw error.status ? error : storeProblem(error); } };
  add('POST', '/world/transfer/export', 'Export selected local world records without writes', guarded(({ body }) => transfer.exportSelection(body)));
  add('POST', '/world/transfer/validate', 'Validate a world bundle without writing', guarded(({ body }) => transfer.validateBundle(body)));
  add('POST', '/world/transfer/restore', 'Restore validated world records into imported custody', guarded(({ body }) => transfer.restoreBundle(body)));
}
