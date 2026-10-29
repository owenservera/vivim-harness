import { randomUUID, createHash } from 'node:crypto';
import { problem, page } from './http.mjs';
import { TemporalGraph } from '../intel/graph.mjs';
import { sanitizedSource } from './world-url.mjs';
import { parseNoteUnitRef } from './world-note-units.mjs';

const check = (ok, message) => { if (!ok) throw problem(400, message, 'WORLD_INVALID_INPUT'); };
const clean = ({ name, changeNote, ...value }) => value;
// Keep the original selection revision bytes: newly exposed provenance is not a source rewrite.

const fields = (body, keys) => check(body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).every((k) => keys.includes(k)), 'Invalid or unknown field');

// Durable local addresses and user relations; the map is rebuilt through the existing graph owner.
export const legacySelectionFingerprint = (messages) => createHash('sha256').update(JSON.stringify(messages.map(({ domId, roleAttribute, ...legacy }) => {
  const { domId: sourceDomId, ...source } = legacy.source; void sourceDomId; return { ...legacy, source };
}))).digest('hex');
const fingerprint = legacySelectionFingerprint;
export function createWorldRelations({ store, service, save }) {
  let ns;
  try { ns = store.load('world-namespace'); }
  catch (e) {
    if (e.code !== 'STORE_NO_SUCH_ITEM') throw e;
    try { ns = store.compareAndSave('world-namespace', { id: `w-${randomUUID()}`, kind: 'namespace', schema: 'vivim.world/1' }, { expectedVersion: null }); }
    catch (e) { if (e.code !== 'CAS_VERSION_CONFLICT') throw e; ns = store.load('world-namespace'); }
  }
  const loadStored = (id, kind) => {
    const stored = load(id, kind); const { availability, availabilityReason, coverage, identity, qualification, ...data } = stored; void availability;
    return data;
  };
  const load = (id, kind) => {
    check(typeof id === 'string' && new RegExp(`^${kind === 'selection' ? 's' : 'o'}-(?:[a-f0-9-]{36}|[a-f0-9]{36}f)$`).test(id), 'Invalid local object ID');
    let record;
    try { record = store.load(id); } catch (e) { if (e.code !== 'STORE_NO_SUCH_ITEM') throw e; throw problem(404, 'Local object not found', 'WORLD_NOT_FOUND'); }
    check(record.kind === kind, 'Object type mismatch');
    // Read-time projection: a stored record.source.providerUrl is sanitized (origin+pathname),
    // covering object/selection API reads, search hit source and every export of these records.
    return { ...clean(record), source: sanitizedSource(record.source) };
  };
  const context = () => ({ projections: new Map(), fingerprints: new Map() });
  const projection = (id, ctx) => {
    if (!ctx.projections.has(id)) {
      try { ctx.projections.set(id, { value: service.conversation(id) }); }
      catch (error) { ctx.projections.set(id, { error }); }
    }
    const result = ctx.projections.get(id); if (result.error) throw result.error; return result.value;
  };
  const unavailable = (e) => {
    if (e.code === 'WORLD_NOT_FOUND') return { availability: 'missing', availabilityReason: 'SOURCE_MISSING' };
    if (e.code === 'WORLD_SOURCE_ACTIVE') return { availability: 'unavailable', availabilityReason: 'SOURCE_ACTIVE' };
    throw e;
  };
  const evidenceAvailability = (p) => p.coverage.state === 'missing' ? { availability: 'missing', availabilityReason: 'EVIDENCE_MISSING' }
    : p.coverage.state === 'unavailable' ? { availability: 'unavailable', availabilityReason: p.coverage.reason }
      : { availability: 'locally-available', availabilityReason: p.coverage.state === 'partial' ? 'PARTIAL_EVIDENCE' : null };
  const object = (id, ctx = context()) => {
    const record = load(id, 'source-reference');
    try { const p = projection(record.conversationId, ctx); return { ...record, ...evidenceAvailability(p), coverage: p.coverage, identity: p.identity }; }
    catch (e) { return { ...record, ...unavailable(e), identity: record.identity }; }
  };
  const selection = (id, ctx = context()) => {
    const record = load(id, 'selection');
    try {
      const owner = load(record.objectId, 'source-reference'), p = projection(owner.conversationId, ctx), available = evidenceAvailability(p);
      if (available.availability !== 'locally-available') return { ...record, ...available };
      if (!ctx.fingerprints.has(owner.conversationId)) ctx.fingerprints.set(owner.conversationId, fingerprint(p.messages));
      const matches = ctx.fingerprints.get(owner.conversationId) === record.source.revision;
      return { ...record, availability: matches ? 'locally-available' : 'stale', availabilityReason: matches ? available.availabilityReason : 'REVISION_CHANGED',
        qualification: 'Address pinned to saved observation revision; never automatically reanchored' };
    } catch (e) { return { ...record, ...unavailable(e) }; }
  };
  const list = (kind, q, project) => {
    const names = store.names(), selected = page(names.filter((id) => id.startsWith(kind === 'selection' ? 's-' : 'o-')), q), ctx = context();
    return { ...selected, items: selected.items.map((id) => project(id, ctx)), namesEnumerated: names.length };
  };
  const ref = (id) => {
    if (typeof id !== 'string') throw problem(400, 'Invalid reference', 'WORLD_INVALID_INPUT');
    // n-<id>#u-<unit> addresses one atomic unit inside a note (see world-note-units.mjs).
    if (id.startsWith('n-') && id.includes('#')) {
      const parsed = parseNoteUnitRef(id);
      check(parsed, 'Invalid note unit reference');
      return service.noteUnit(parsed.noteId, parsed.unitId);
    }
    if (id.startsWith('c-')) return service.conversation(id);
    if (id.startsWith('p-')) return service.project(id);
    if (id.startsWith('n-')) return service.note(id);
    if (id.startsWith('o-')) return object(id);
    if (id.startsWith('s-')) return selection(id);
    throw problem(400, 'Unknown reference kind', 'WORLD_INVALID_INPUT');
  };
  const validate = (values, previous, selectionsOnly = false) => {
    check(Array.isArray(values) && values.length <= 1000 && values.every((v) => typeof v === 'string' && /^[cnpos]-[a-z0-9-]{1,60}(?:#u-[a-z0-9]{1,60}(?:-[0-9]{1,6})?)?$/.test(v)), 'Invalid references');
    if (selectionsOnly) check(values.every((v) => v.startsWith('s-')), 'commentsOn requires selection IDs');
    for (const id of values) if (!previous.includes(id)) ref(id);
    return [...new Set(values)];
  };
  return {
    namespace: () => clean(ns),
    objects: (q = {}) => list('source-reference', q, object), object, storedObject: (id) => loadStored(id, 'source-reference'), storedSelection: (id) => loadStored(id, 'selection'),
    selections: (q = {}) => list('selection', q, selection), selection,
    validateRefs: (values, previous = []) => validate(values, previous),
    validateSelections: (values, previous = []) => validate(values, previous, true),
    createObject(body) {
      fields(body, ['conversationId', 'expectedVersion']); check(body.expectedVersion === null, 'Create requires expectedVersion:null');
      const source = service.conversation(body.conversationId), id = `o-${randomUUID()}`;
      return save(id, { id, namespaceId: ns.id, kind: 'source-reference', objectType: 'conversation', conversationId: source.id,
        source: source.source, identity: source.identity, provenance: 'user-linked-source' }, null);
    },
    createSelection(body) {
      fields(body, ['objectId', 'selectionType', 'messageIndex', 'partPath', 'expectedVersion']);
      check(body.expectedVersion === null, 'Create requires expectedVersion:null');
      check(['message', 'part', 'artifact'].includes(body.selectionType), 'Invalid selection type');
      const owner = object(body.objectId), projection = service.conversation(owner.conversationId);
      check(Number.isSafeInteger(body.messageIndex) && body.messageIndex >= 0 && body.messageIndex < projection.messages.length, 'Invalid messageIndex');
      const message = projection.messages[body.messageIndex], partPath = body.partPath ?? [];
      check(Array.isArray(partPath) && partPath.length <= 16 && partPath.every((k) => Number.isSafeInteger(k) && k >= 0
        || typeof k === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(k) && !['constructor', 'prototype', '__proto__'].includes(k)), 'Invalid partPath');
      check(body.selectionType === 'message' ? partPath.length === 0 : partPath.length > 0 && Number.isInteger(partPath[0]), 'Part selections require an explicit block path');
      let value = message.blocks;
      for (const key of partPath) { check(value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'Part path not observed'); value = value[key]; }
      const id = `s-${randomUUID()}`;
      return save(id, { id, namespaceId: ns.id, kind: 'selection', selectionType: body.selectionType, objectId: owner.id,
        source: { sessionId: owner.source.sessionId, key: 'DOM_TURNS', messageIndex: body.messageIndex,
          observedTurnId: message.source.observedTurnId, domId: message.source.domId, observedPartId: partPath.length ? value?.id ?? null : null,
          partPath, revision: fingerprint(projection.messages), revisionBasis: 'saved DOM_TURNS projection fingerprint; not object identity' },
        provenance: 'user-selected', coverage: { content: message.truncated ? 'partial' : 'as-recorded', nativeIdentity: 'unknown',
          assetBytes: body.selectionType === 'artifact' ? 'not-established' : 'not-applicable' } }, null);
    },
    map(q = {}) {
      check(q.offset === undefined, 'Map offset is not supported; use id/kind filters and limit');
      check(q.limit === undefined || /^\d+$/.test(String(q.limit)) && Number(q.limit) >= 1 && Number(q.limit) <= 1000, 'limit must be 1..1000');
      check(q.kind === undefined || ['project', 'note', 'selection', 'source-reference', 'conversation'].includes(q.kind), 'Unknown map kind');
      const graph = new TemporalGraph();
      const conversations = service.conversations({ limit: 1000, custody: 'all' }), projects = service.projects({ limit: 1000 }), notes = service.notes({ limit: 1000 });
      const names = store.names(), objectNames = names.filter((id) => id.startsWith('o-')), selectionNames = names.filter((id) => id.startsWith('s-'));
      const mapCtx = context();
      const nodes = [...conversations.items.map((r) => ({ ...r, kind: 'conversation' })), ...projects.items, ...notes.items,
        ...objectNames.slice(0, 1000).map((id) => object(id, mapCtx)), ...selectionNames.slice(0, 1000).map((id) => selection(id, mapCtx))];
      const inputTruncated = conversations.total > 1000 || projects.total > 1000 || notes.total > 1000 || objectNames.length > 1000 || selectionNames.length > 1000;
      const metadataRequest = {};
      let edgesScanned = 0, placeholders = 0, scanTruncated = false;
      const addNode = (record) => graph.upsertEntity({ eid: record.id, type: record.kind, attrs: { id: record.id, kind: record.kind, title: record.title ?? null,
        provenance: record.provenance ?? (record.kind === 'conversation' && record.custody !== 'imported' ? 'source-observation' : record.custody === 'imported' ? 'imported-snapshot' : 'user-authored'),
        ...(record.custody ? { custody: record.custody } : {}), ...(record.importedFrom ? { importedFrom: record.importedFrom } : {}),
        ...(record.identity ? { identity: record.identity } : {}), ...(record.source ? { source: record.source } : {}),
        ...(record.availability ? { availability: record.availability, availabilityReason: record.availabilityReason } : {}),
        ...(record.coverage ? { coverage: record.coverage } : {}) },
        t: Date.parse(record.savedAt ?? record.createdAt) || null, evidence: { namespaceId: ns.id, basis: 'local world overlay or saved observation' } });
      for (const r of nodes) addNode(r);
      const relate = (r, to, kind) => {
        if (edgesScanned >= 10000) { scanTruncated = true; return; }
        edgesScanned++;
        if (!graph.nodes.has(to)) {
          if (placeholders >= 1000) { scanTruncated = true; return; }
          placeholders++;
          const targetKind = ({ c: 'conversation', p: 'project', n: 'note', o: 'source-reference', s: 'selection' })[to[0]] ?? 'unresolved-reference';
          let target = { id: to, kind: targetKind, availability: 'unresolved', availabilityReason: 'NOT_SCANNED' };
          if (to.includes('#')) {
            // A unit reference is its own node: the edge points at the addressed unit, not the whole note.
            try { const unit = ref(to); target = { id: to, kind: 'note-unit', noteId: unit.noteId, unitId: unit.id, path: unit.path,
              provenance: 'user-authored', availability: 'locally-available', availabilityReason: null }; }
            catch (e) { if (!['WORLD_NOT_FOUND', 'WORLD_INVALID_INPUT'].includes(e.code)) throw e; target = { ...target, kind: 'note-unit', availability: 'missing', availabilityReason: 'UNIT_MISSING' }; }
          } else if (targetKind === 'conversation') {
            try { target = { ...target, ...service.conversationMetadata(to, metadataRequest) }; }
            catch (e) { if (e.code !== 'WORLD_NOT_FOUND') throw e; target = { ...target, availability: 'missing', availabilityReason: 'SOURCE_MISSING' }; }
          }
          addNode(target);
        }
        graph.relate({ from: r.id, to, kind, status: 'confirmed', confidence: null,
          evidence: { namespaceId: ns.id, objectId: r.id, version: r.version ?? null, basis: 'local association; not native equality' } });
      };
      relations: for (const r of nodes) {
        const targets = r.kind === 'project' ? new Set([...(r.conversationIds ?? []), ...(r.noteIds ?? []), ...(r.memberIds ?? [])])
          : r.kind === 'note' ? r.commentsOn ?? [] : r.kind === 'selection' ? [r.objectId] : r.kind === 'source-reference' ? [r.conversationId] : [];
        for (const id of targets) {
          if (edgesScanned >= 10000) { scanTruncated = true; break relations; }
          relate(r, id, r.kind === 'project' ? 'associates' : r.kind === 'note' ? 'comments_on' : 'references');
        }
      }
      const matched = [...graph.nodes.values()].filter((n) => (!q.id || n.eid === q.id || [...graph.edges.values()].some((e) => e.from === q.id && e.to === n.eid || e.to === q.id && e.from === n.eid)) && (!q.kind || n.type === q.kind));
      const selected = matched.slice(0, Number(q.limit ?? 100)), included = new Set(selected.map((n) => n.eid));
      return { namespaceId: ns.id, nodes: selected.map((n) => ({ id: n.eid, ...n.attrs })),
        edges: [...graph.edges.values()].filter((e) => included.has(e.from) && included.has(e.to)),
        complete: matched.length <= selected.length && !inputTruncated && !scanTruncated,
        scanned: nodes.length, edgesScanned, truncated: matched.length > selected.length || inputTruncated || scanTruncated,
        inputLimitPerKind: 1000, edgeScanLimit: 10000, placeholderLimit: 1000,
        namesEnumerated: names.length, sourceMetadataEnumerated: conversations.metadataEnumerated,
        metadataLookupEnumerated: metadataRequest.metadata?.length ?? 0,
        enumerationNote: 'Pagination bounds record projection, not directory/name enumeration; source metadata enumeration includes active sources but does not read their content',
        basis: 'derived read-only relational projection; no home, layout or entity priority',
        lenses: ['WHAT', 'HOW', 'WHERE', 'WHEN', 'WHO'] };
    },
  };
}
