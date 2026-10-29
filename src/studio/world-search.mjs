// Bounded, read-only search adapter over the saved local world. It reuses the existing corpus
// index and rebuilds a transient index from current authoritative service reads on every query,
// so edits are visible and no second persistent store or duplicated content index is created.
// It indexes local saved evidence only: no provider network, no URL/session continuity merging.
import { CorpusSearchIndex } from '../intel/search.mjs';
import { textTokens } from '../intel/similarity.mjs';
import { problem, integer, text, storeProblem } from './http.mjs';

// Kinds are the actual local record families; messages are saved DOM_TURNS projections.
export const WORLD_SEARCH_KINDS = Object.freeze(['message', 'project', 'note', 'source-reference', 'selection']);
export const WORLD_SEARCH_CUSTODY = Object.freeze(['observed', 'imported', 'all']);

// Generous finite scan bounds. They are exposed in coverage so a caller can see what was read.
export const WORLD_SEARCH_LIMITS = Object.freeze({
  conversations: 500, messages: 20000, projects: 500, notes: 500, objects: 500, selections: 500, pageSize: 1000,
});

const BOUND_KEYS = ['conversations', 'messages', 'projects', 'notes', 'objects', 'selections'];
const fail = (list, kind, id, e) => list.push({ kind, id: typeof id === 'string' ? id : null,
  code: typeof e?.code === 'string' ? e.code : null, message: String(e?.message ?? e) });

function boundsWith(overrides) {
  if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) {
    throw new TypeError('limits must be an object');
  }
  const out = { ...WORLD_SEARCH_LIMITS };
  for (const key of BOUND_KEYS) {
    const value = overrides?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`limits.${key} must be a non-negative integer`);
    out[key] = value;
  }
  if (overrides?.pageSize !== undefined) {
    const pageSize = overrides.pageSize;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new TypeError('limits.pageSize must be an integer between 1 and 1000');
    out.pageSize = pageSize;
  }
  return out;
}

// Read a paginated service collection to its cap. The service page default (100) is never relied on.
function collect(list, name, max, pageSize) {
  const items = [];
  if (max <= 0) return { items, total: null, truncated: true };
  let offset = 0, total = null;
  while (items.length < max) {
    const want = Math.min(pageSize, max - items.length);
    const result = list({ offset, limit: want });
    const batch = Array.isArray(result?.items) ? result.items : null;
    if (!batch) throw new Error(`World search: ${name} list returned no items array`);
    if (total === null) total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null;
    items.push(...batch);
    offset += batch.length;
    if (batch.length < want) break;
    if (total !== null && offset >= total) break;
  }
  return { items, total, truncated: total !== null ? offset < total : items.length >= max };
}

// Structural text for rich/unknown blocks. Keys are kept as structure, every scalar leaf becomes searchable text.
function richText(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map((entry) => richText(entry, depth + 1)).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.entries(value).map(([key, entry]) => key + ' ' + richText(entry, depth + 1)).join(' ');
  return '';
}

const scalar = (value) => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') ? String(value) : '';
const metaText = (...values) => values.map(scalar).filter(Boolean).join(' ');
// Only these states are understood local outcomes. Any additive/unknown state (active, excluded, ...)
// is conservatively unavailable: it is not local content and it is not evidence of deletion.
const KNOWN_AVAILABILITY = new Set(['locally-available', 'stale', 'missing', 'unavailable', 'unknown']);
function observedAvailability(value) {
  const observed = typeof value === 'string' && value ? value : null;
  return { observed, availability: observed === null ? 'unknown' : KNOWN_AVAILABILITY.has(observed) ? observed : 'unavailable' };
}
const cleanSnippet = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
// Part refs follow the same top-level [blockIndex] convention as selection part refs and the UI
// planFrames: path [i] names message.blocks[i], rendered as data-part-path="i". Attribution reuses
// the already-flattened block text.
const tokenSet = (value) => new Set(textTokens(value));
// Attribute a ranked message hit to exactly one top-level block. Only a single block that holds
// every matched term is specific enough to be called a part. The message's own saved text usually
// repeats its blocks, so a term found in that text is not by itself a reason to stay message-level;
// matches spread across several blocks, matching several blocks, or landing in a blockless message
// stay message-level instead of guessing.
function attributedPartPath(record, row) {
  if (!record?.blockTokens || !Array.isArray(record.blockTokens)) return null;
  const terms = row?.matchedTerms ?? [];
  if (!terms.length) return null;
  let candidate = null;
  for (const [blockIndex, tokens] of record.blockTokens.entries()) {
    if (!terms.every((term) => tokens.has(term))) continue;
    if (candidate !== null) return null;
    candidate = blockIndex;
  }
  return candidate === null ? null : [candidate];
}
const clip = (value, max = 280) => {
  const snippet = cleanSnippet(value);
  return snippet.length > max ? snippet.slice(0, max - 3) + '...' : snippet;
};

export function createWorldSearch({ service, limits } = {}) {
  if (!service || typeof service.conversations !== 'function' || typeof service.conversation !== 'function') {
    throw new TypeError('createWorldSearch requires a world service with conversations() and conversation(id)');
  }
  const bounds = boundsWith(limits);

  function search(q = {}) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw problem(400, 'Search query must be an object', 'WORLD_INVALID_INPUT');
    const query = text(q.q, 'q', 1000).trim();
    const custody = q.custody === undefined || q.custody === null ? 'all' : q.custody;
    if (!WORLD_SEARCH_CUSTODY.includes(custody)) throw problem(400, 'custody must be observed, imported or all', 'WORLD_INVALID_INPUT');
    const kind = q.kind === undefined || q.kind === null ? null : q.kind;
    if (kind !== null && !WORLD_SEARCH_KINDS.includes(kind)) throw problem(400, `kind must be one of ${WORLD_SEARCH_KINDS.join(', ')}`, 'WORLD_INVALID_INPUT');
    const offset = integer(q.offset, 0, 1000000);
    const limit = integer(q.limit, 100, 1000, 1);

    const index = new CorpusSearchIndex(), hitMeta = new Map();
    const failures = [], reasons = new Set();
    const scanned = { conversations: 0, observedConversations: 0, importedConversations: 0, messages: 0, projects: 0, notes: 0, sourceReferences: 0, selections: 0 };
    // Conversations whose saved or imported content is explicitly absent. Absence is disclosed, never
    // turned into synthetic message content or into an implied successful local match.
    let absentObserved = 0, absentImported = 0;
    // Imported custody comes only from service fields. Conversation id shape, including c-i + 38 hex, is not an identity rule.
    const importProvenance = (record) => record?.importedFrom !== null && record?.importedFrom !== undefined && typeof record.importedFrom === 'object';
    const importedSnapshot = (meta, detail) => ['imported', 'imported-snapshot'].includes(meta?.custody)
      || ['imported', 'imported-snapshot'].includes(detail?.custody) || detail?.coverage?.state === 'imported-snapshot'
      || importProvenance(meta) || importProvenance(detail);
    const put = (id, record, content, source) => {
      if (typeof id !== 'string' || !id) return false;
      if (!String(content ?? '').trim()) return false;
      const key = String(id);
      index.add(key, { kind: record.kind }, { text: content, source });
      hitMeta.set(key, { ...record, source });
      return true;
    };
    const collectRows = (name, reason, list, max, map) => {
      const found = collect((query) => list(query), name, max, bounds.pageSize);
      if (found.truncated) reasons.add(reason);
      const output = [];
      for (const entry of found.items) {
        try { output.push(map(entry)); }
        catch (e) { fail(failures, name, entry?.id, e); }
      }
      return output;
    };

    if (kind === null || kind === 'message') {
      // The service list defaults to observed-only, so the requested custody is always passed explicitly.
      const conversations = collect((query) => service.conversations({ ...query, custody }), 'conversations', bounds.conversations, bounds.pageSize);
      if (conversations.truncated) reasons.add('conversation-scan-limit');
      for (const meta of conversations.items) {
        if (scanned.messages >= bounds.messages) { reasons.add('message-scan-limit'); break; }
        let detail;
        try { detail = service.conversation(meta?.id); }
        catch (e) { fail(failures, 'conversation', meta?.id, e); continue; }
        const imported = importedSnapshot(meta, detail);
        scanned.conversations++;
        if (imported) scanned.importedConversations++; else scanned.observedConversations++;
        if (detail?.coverage?.state === 'unavailable') {
          // Unreadable metadata/evidence is returned, not thrown. It is a failed local read, never an
          // empty successful scan, and its backend reason is preserved verbatim.
          const reason = typeof detail.coverage.reason === 'string' && detail.coverage.reason ? detail.coverage.reason : 'EVIDENCE_UNAVAILABLE';
          fail(failures, 'conversation', meta?.id, Object.assign(new Error(`Saved conversation evidence unavailable: ${reason}`), { code: reason }));
          continue;
        }
        if (!Array.isArray(detail?.messages)) {
          fail(failures, 'conversation', meta?.id, Object.assign(new Error('Conversation projection has no messages array'), { code: 'INVALID_SERVICE_RESULT' }));
          continue;
        }
        if (detail?.coverage?.state === 'missing') { if (imported) absentImported++; else absentObserved++; }
        // A missing DOM_TURNS projection yields no message documents; only recorded messages are searchable.
        for (const [position, message] of detail.messages.entries()) {
          if (scanned.messages >= bounds.messages) { reasons.add('message-scan-limit'); break; }
          scanned.messages++;
          const content = [message?.text, richText(message?.blocks)].filter((part) => typeof part === 'string' && part.trim()).join('\n');
          if (!content) continue;
          const role = typeof message?.role === 'string' ? message.role : 'unknown';
          const recorded = message?.source && typeof message.source === 'object' ? { ...message.source } : {};
          delete recorded.originSessionId;
          const importedFrom = detail?.importedFrom ?? meta?.importedFrom ?? null;
          if (imported) {
            if (recorded.kind === 'saved-observation' || recorded.kind === 'saved-session' || recorded.kind == null) recorded.kind = 'imported-reference';
            recorded.sessionId = null;
          }
          // Imported hit ids are built from the LOCAL imported conversation id so they stay resolvable
          // in this world and distinct from any locally observed copy of the same origin conversation.
          // Origin ids remain only inside importedFrom.
          const id = imported ? `${meta.id}:turn:${position}`
            : typeof message?.id === 'string' && message.id ? message.id : `${meta.id}:turn:${position}`;
          put(id, {
            id, kind: 'message', title: `${role} message ${position + 1}`,
            role, conversation: { id: meta.id, title: meta.title ?? null },
            custody: imported ? 'imported-snapshot' : 'observed',
            ...(imported ? { contentScope: 'imported-snapshot; not observed', importedFrom } : {}),
            truncated: message?.truncated === true, redactions: message?.redactions ?? null,
            // Block attribution inputs (internal; never surfaced in hits): per-block token sets keep
            // partPath attribution bounded within the same per-message caps the scan already paid.
            ...(Array.isArray(message?.blocks)
              ? { blockTokens: message.blocks.map((block) => tokenSet(richText(block))) }
              : {}),
          }, content, {
            ...recorded,
            conversationId: meta.id, messageId: id,
            // Navigation coordinate: the reader keys its message row and part frames by this local
            // projection position, not by any recorded origin index.
            index: position,
            ...(imported ? { importedFrom } : {}),
            identityScope: imported ? 'imported snapshot; not observed; not durable part identity' : 'source-observation-alias; not durable part identity',
          });
        }
      }
    }

    if (kind === null || kind === 'project') {
      for (const record of collectRows('projects', 'project-scan-limit', service.projects, bounds.projects, (entry) => entry)) {
        scanned.projects++;
        const version = Number.isSafeInteger(record?.version) ? record.version : null;
        put(record?.id, {
          id: record.id, kind: 'project', title: record.title ?? record.id, version,
        }, metaText(record?.title), { provenance: 'local-world-overlay', recordId: record.id, version });
      }
    }

    if (kind === null || kind === 'note') {
      for (const record of collectRows('notes', 'note-scan-limit', service.notes, bounds.notes, (entry) => entry)) {
        scanned.notes++;
        const version = Number.isSafeInteger(record?.version) ? record.version : null;
        put(record?.id, {
          id: record.id, kind: 'note', title: record.title ?? record.id, version,
          commentsOn: Array.isArray(record?.commentsOn) ? [...record.commentsOn] : [],
        }, [record?.title, record?.body].filter((part) => typeof part === 'string' && part).join('\n'),
        { provenance: record?.provenance ?? 'user-authored', recordId: record.id, version });
      }
    }

    if (kind === null || kind === 'source-reference') {
      for (const record of collectRows('objects', 'object-scan-limit', service.objects, bounds.objects, (entry) => entry)) {
        scanned.sourceReferences++;
        const { observed: availabilityObserved, availability } = observedAvailability(record?.availability);
        const availabilityReason = record?.availabilityReason;
        put(record?.id, {
          id: record.id, kind: 'source-reference',
          title: record.objectType ? `${record.objectType} reference` : 'source reference',
          objectType: record.objectType ?? null, conversationId: record.conversationId ?? null,
          availability, ...(availabilityObserved ? { availabilityObserved } : {}),
          ...(availabilityReason !== undefined ? { availabilityReason } : {}),
          identity: record.identity ?? null,
          contentScope: 'reference-metadata; remote content not read',
        }, metaText(record?.id, record?.objectType, record?.conversationId, record?.provenance,
          availabilityObserved, availability, availabilityReason, record?.source?.sessionId, record?.source?.kind, record?.source?.providerUrl,
          record?.identity?.state, record?.identity?.provider?.value, record?.identity?.origin?.value,
          record?.identity?.thread?.nativeRef), {
          ...(record?.source && typeof record.source === 'object' ? record.source : {}),
          objectId: record.id, conversationId: record.conversationId ?? null,
          provenance: record?.provenance ?? null, availability,
          ...(availabilityObserved ? { availabilityObserved } : {}),
          ...(availabilityReason !== undefined ? { availabilityReason } : {}),
        });
      }
    }

    if (kind === null || kind === 'selection') {
      for (const record of collectRows('selections', 'selection-scan-limit', service.selections, bounds.selections, (entry) => entry)) {
        scanned.selections++;
        const source = record?.source ?? {};
        const { observed: availabilityObserved, availability } = observedAvailability(record?.availability);
        const availabilityReason = record?.availabilityReason;
        put(record?.id, {
          id: record.id, kind: 'selection',
          title: record.selectionType ? `${record.selectionType} selection` : 'selection',
          selectionType: record.selectionType ?? null, objectId: record.objectId ?? null,
          availability, ...(availabilityObserved ? { availabilityObserved } : {}),
          ...(availabilityReason !== undefined ? { availabilityReason } : {}),
          coverageState: record.coverage ?? null,
          contentScope: 'selection-metadata; selected content not read',
        }, metaText(record?.id, record?.selectionType, record?.objectId, source.sessionId, source.key,
          source.messageIndex, source.observedTurnId, source.observedPartId,
          Array.isArray(source.partPath) ? source.partPath.join(' / ') : null,
          record?.coverage?.content, record?.coverage?.nativeIdentity, availabilityObserved, availability, availabilityReason), {
          ...(typeof source === 'object' ? source : {}), selectionId: record.id, objectId: record.objectId ?? null,
          availability, ...(availabilityObserved ? { availabilityObserved } : {}),
          ...(availabilityReason !== undefined ? { availabilityReason } : {}),
        });
      }
    }

    const tokenTruncated = index.stats().truncatedDocuments;
    if (tokenTruncated > 0) reasons.add('document-token-limit');

    // Kind filtering happens inside the index before its top-N cut, so a kind page cannot be crowded out.
    const limitFilter = hitMeta.size;
    const ranked = index.search(query, {
      limit: Math.max(1, limitFilter),
      ...(kind ? { filter: (document) => document?.kind === kind } : {}),
    });
    const hits = [];
    for (const row of ranked) {
      const record = hitMeta.get(row.id);
      if (!record) continue;
      const partPath = attributedPartPath(record, row);
      hits.push({ id: record.id, kind: record.kind, title: record.title, score: row.score,
        snippet: clip(row.snippet), source: { ...record.source, ...(partPath ? { partPath } : {}) },
        ...(record.role !== undefined ? { role: record.role } : {}),
        ...(record.conversation !== undefined ? { conversation: record.conversation } : {}),
        ...(record.custody !== undefined ? { custody: record.custody } : {}),
        ...(record.importedFrom !== undefined ? { importedFrom: record.importedFrom } : {}),
        ...(record.truncated !== undefined ? { truncated: record.truncated } : {}),
        ...(record.redactions !== undefined ? { redactions: record.redactions } : {}),
        ...(record.version !== undefined ? { version: record.version } : {}),
        ...(record.commentsOn !== undefined ? { commentsOn: record.commentsOn } : {}),
        ...(record.objectType !== undefined ? { objectType: record.objectType } : {}),
        ...(record.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
        ...(record.availability !== undefined ? { availability: record.availability } : {}),
        ...(record.availabilityObserved !== undefined ? { availabilityObserved: record.availabilityObserved } : {}),
        ...(record.availabilityReason !== undefined ? { availabilityReason: record.availabilityReason } : {}),
        ...(record.identity !== undefined ? { identity: record.identity } : {}),
        ...(record.selectionType !== undefined ? { selectionType: record.selectionType } : {}),
        ...(record.objectId !== undefined ? { objectId: record.objectId } : {}),
        ...(record.coverageState !== undefined ? { coverageState: record.coverageState } : {}),
        ...(record.contentScope !== undefined ? { contentScope: record.contentScope } : {}),
      });
    }

    const truncated = reasons.size > 0;
    const coverage = {
      complete: failures.length === 0 && !truncated,
      scope: kind ?? 'all',
      custody,
      scanned,
      absent: { conversations: absentObserved + absentImported, observedConversations: absentObserved, importedConversations: absentImported },
      indexed: hitMeta.size,
      matching: hits.length,
      tokenTruncated,
      failures,
      truncated,
      reasons: [...reasons],
      limits: { ...bounds },
      qualification: 'total counts matches in a transient index built from bounded current local reads; complete describes scan coverage only, not that unread or remote content does not exist; active/excluded or unknown availability is reported as unavailable and is not evidence of deletion',
    };
    return {
      items: hits.slice(offset, offset + limit), total: hits.length, offset, limit,
      nextOffset: offset + limit < hits.length ? offset + limit : null, coverage,
    };
  }

  return { search };
}

// Optional route for the existing Studio hub; the parent registers it after reconciliation.
export function registerWorldSearchRoutes({ add, service }) {
  if (typeof add !== 'function') throw new TypeError('registerWorldSearchRoutes requires the hub add() function');
  const { search } = createWorldSearch({ service });
  add('GET', '/world/search', 'Bounded read-only search across saved messages and local world records', ({ q }) => {
    try { return search(q); } catch (e) { throw e?.status ? e : storeProblem(e); }
  });
}
