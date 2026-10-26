import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Session, listSessions } from '../store/session.mjs';
import { VersionedStore } from '../store/versioned.mjs';
import { problem, storeProblem, page } from './http.mjs';
import { buildObservation } from '../shapes/observation.mjs';
import { sanitizeProviderUrl, sanitizedSource } from './world-url.mjs';
import { createWorldRelations } from './world-relations.mjs';
import { registerWorldSearchRoutes } from './world-search.mjs';
import { registerWorldTransferRoutes, importedConversationId } from './world-transfer.mjs';

const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 40);
const conversationId = (session) => `c-${digest(session)}`;
const check = (yes, message) => { if (!yes) throw problem(400, message, 'WORLD_INVALID_INPUT'); };
const fields = (body, allowed) => {
  check(body && typeof body === 'object' && !Array.isArray(body), 'Object required');
  check(Object.keys(body).every((k) => allowed.includes(k)), 'Unknown field');
};
const title = (s) => { check(typeof s === 'string' && s.trim().length > 0 && s.length <= 300, 'title must contain 1..300 characters'); return s.trim(); };
const ids = (value, prefix) => {
  check(Array.isArray(value) && value.length <= 1000 && value.every((s) => typeof s === 'string' && new RegExp(`^${prefix}-[a-z0-9-]{1,60}$`).test(s)), 'Invalid member IDs');
  return [...new Set(value)];
};
const publicRecord = ({ name, changeNote, ...record }) => record;

// Only user-owned overlays live here. Messages remain projections of saved session evidence.
export function createWorldService({ paths, isSessionActive = () => false }) {
  const store = new VersionedStore(path.join(paths.root, 'world'), { kind: 'world item' });
  const load = (id, kind) => {
    check(typeof id === 'string' && new RegExp(`^${kind === 'project' ? 'p' : 'n'}-[a-z0-9-]{1,60}$`).test(id), 'Invalid item ID');
    let value;
    try { value = store.load(id); } catch (e) { if (e.code === 'STORE_NO_SUCH_ITEM') throw problem(404, 'Item not found', 'WORLD_NOT_FOUND'); throw e; }
    if (value.kind !== kind) throw problem(404, 'Item not found', 'WORLD_NOT_FOUND');
    return value;
  };
  const metadata = (m) => {
    const observed = buildObservation({ session: { meta: m } });
    let origin = null; try { origin = new URL(m.target?.url).origin; } catch { /* no observed location */ }
    return ({ id: conversationId(m.id), sessionId: m.id, title: m.target?.title ?? m.label ?? m.id,
    status: m.status ?? 'unknown', createdAt: m.createdAt ?? null,
    identity: { nativeThreadId: observed.conversation.nativeRef, accountId: observed.account.ref,
      state: observed.conversation.nativeRef ? 'partial' : 'unknown',
      provider: { value: observed.provider, state: observed.provider ? 'source-observed' : 'unknown', basis: 'session.json/site' },
      origin: { value: origin, state: origin ? 'source-observed' : 'unknown', basis: 'session.json/target/url' },
      thread: { ...observed.conversation, state: observed.conversation.nativeRef ? 'qualified-inference' : 'unknown' },
      account: observed.account, observedAt: m.createdAt ?? null,
      qualification: 'Saved observation only; URL parsing and runtime ownership do not prove account identity or full archive identity' },
    source: { sessionId: m.id, kind: 'saved-session', providerUrl: sanitizeProviderUrl(m.target?.url ?? null) },
    identityScope: 'source-observation-alias; use world objects for durable local references' });
  };
  const allMetadata = () => listSessions(paths.sessions).filter((m) => typeof m.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(m.id));
  const active = (m) => ['recording', 'stopping'].includes(m.status) || isSessionActive(m.id);
  const importedConversation = (id) => {
    if (!importedConversationId(id)) return null;
    let record;
    try { record = store.load(id); } catch (e) { if (e.code === 'STORE_NO_SUCH_ITEM') return null; throw e; }
    if (record.kind !== 'conversation' || record.custody !== 'imported-snapshot') throw problem(409, 'Imported conversation record is inconsistent', 'WORLD_IMPORT_CORRUPT');
    return publicRecord(record);
  };
  const conversationMetadata = (id, request = {}) => {
    check(typeof id === 'string' && /^c-(?:[a-f0-9]{40}|i[a-f0-9]{38})$/.test(id), 'Invalid conversation ID');
    const imported = importedConversation(id);
    if (imported) return { id: imported.id, sessionId: null, title: imported.title, status: 'imported', createdAt: imported.importedFrom?.observedAt ?? null,
      identity: imported.identity, source: sanitizedSource(imported.source), identityScope: 'imported snapshot; not local capture identity',
      availability: 'imported', availabilityReason: 'IMPORTED_SNAPSHOT', custody: 'imported', importedFrom: imported.importedFrom };
    request.metadata ??= allMetadata();
    const m = request.metadata.find((m) => conversationId(m.id) === id);
    if (!m) throw problem(404, 'Source metadata no longer exists', 'WORLD_NOT_FOUND');
    return { ...metadata(m), availability: active(m) || m.status === 'unreadable_metadata' ? 'unavailable' : 'metadata-only',
      availabilityReason: active(m) ? 'SOURCE_ACTIVE' : m.status === 'unreadable_metadata' ? 'METADATA_UNREADABLE' : 'EVIDENCE_NOT_READ' };
  };
  const resolve = (id) => {
    check(typeof id === 'string' && /^c-(?:[a-f0-9]{40}|i[a-f0-9]{38})$/.test(id), 'Invalid conversation ID');
    const imported = importedConversation(id); if (imported) return imported;
    const m = allMetadata().find((m) => conversationId(m.id) === id);
    if (!m) throw problem(404, 'Saved conversation not found', 'WORLD_NOT_FOUND');
    if (active(m)) throw problem(409, 'Source is active; saved evidence read unavailable', 'WORLD_SOURCE_ACTIVE');
    return m;
  };
  const save = (id, value, expectedVersion) => publicRecord(store.compareAndSave(id, value, { expectedVersion }));
  const list = (kind, query) => {
    const names = store.names(), selected = page(names.filter((id) => id.startsWith(kind === 'project' ? 'p-' : 'n-')), query);
    return { ...selected, items: selected.items.map((id) => publicRecord(load(id, kind))), namesEnumerated: names.length };
  };
  const service = {
    conversationMetadata,
    conversations: (q = {}) => {
      const mode = q.custody ?? 'observed';
      check(['observed', 'imported', 'all'].includes(mode), 'custody must be observed, imported or all');
      const rows = allMetadata(), observed = rows.filter((m) => !active(m)).map((m) => ({ ...metadata(m), custody: 'observed', importedFrom: null }));
      const imported = mode === 'observed' ? [] : store.names().filter(importedConversationId).map(importedConversation)
        .filter(Boolean).map((r) => ({ id: r.id, sessionId: null, title: r.title, status: 'imported', createdAt: r.importedFrom?.observedAt ?? null,
          identity: r.identity, source: sanitizedSource(r.source), custody: 'imported', importedFrom: r.importedFrom }));
      const selected = page(mode === 'imported' ? imported : mode === 'all' ? [...observed, ...imported] : observed, q);
      return { ...selected, metadataEnumerated: rows.length, custody: mode };
    },
    conversation(id) {
      const imported = importedConversation(id);
      if (imported) return { ...conversationMetadata(id),
        messages: imported.messages.map((message, index) => {
          // Read-time projection: message ids derive from the addressed LOCAL imported id, so detail ids,
          // search hit ids and re-export ids agree. Stored bytes (and their origin ids) are never rewritten.
          if (!message || typeof message !== 'object') return message;
          const localId = `${id}:turn:${index}`, source = message.source && typeof message.source === 'object' ? { ...message.source } : {};
          if (typeof source.messageId === 'string') source.messageId = localId;
          return { ...message, id: localId, source };
        }),
        coverage: { state: 'imported-snapshot', reason: null, fullNativeThread: 'unknown', acceptance: 'not-assessed', richContent: 'imported-as-supplied' } };
      const m = resolve(id);
      const unavailable = (reason) => ({ ...metadata(m), messages: [], coverage: { state: 'unavailable', reason,
        fullNativeThread: 'unknown', acceptance: 'not-assessed', richContent: 'unavailable' } });
      if (m.status === 'unreadable_metadata') return unavailable('METADATA_UNREADABLE');
      let session;
      try { session = Session.open(paths.sessions, m.id); }
      catch (e) { if (e instanceof SyntaxError || ['EACCES', 'EPERM'].includes(e.code)) return unavailable('METADATA_UNREADABLE'); throw e; }
      check(session.id === m.id, 'Session metadata identity mismatch');
      let turns;
      try { turns = session.kv.get('DOM_TURNS', null); }
      catch (e) { if (e instanceof SyntaxError || ['EACCES', 'EPERM'].includes(e.code)) return unavailable('EVIDENCE_UNREADABLE'); throw e; }
      const present = Array.isArray(turns);
      const messages = (present ? turns : []).map((turn, index) => ({ id: `${id}:turn:${index}`, role: turn?.role ?? 'unknown',
        text: typeof turn?.text === 'string' ? turn.text : '', blocks: structuredClone(Array.isArray(turn?.blocks) ? turn.blocks : []),
        source: { sessionId: m.id, key: 'DOM_TURNS', index, observedTurnId: turn?.id ?? null, domId: turn?.domId ?? null },
        domId: turn?.domId ?? null, roleAttribute: turn?.roleAttribute ?? null,
        truncated: !!turn?.truncated,
        // Preserve the source scanner's original-length signal without changing Boolean consumers.
        truncatedOriginalLength: Number.isSafeInteger(turn?.truncated) && turn.truncated > 0 ? turn.truncated : null,
        redactions: turn?.redactions ?? null }));
      return { ...metadata(m), messages, coverage: { state: !present ? 'missing' : m.status === 'complete' && !messages.some((t) => t.truncated) ? 'saved-observation' : 'partial',
        fullNativeThread: 'unknown', acceptance: 'not-assessed', richContent: present ? 'as-recorded' : 'missing' } };
    },
    projects: (q = {}) => list('project', q),
    project: (id) => publicRecord(load(id, 'project')),
    createProject(body) {
      fields(body, ['title', 'expectedVersion']); check(body.expectedVersion === null, 'Create requires expectedVersion:null');
      const id = `p-${randomUUID()}`;
      return save(id, { id, namespaceId: relations.namespace().id, kind: 'project', title: title(body.title), conversationIds: [], noteIds: [], memberIds: [] }, null);
    },
    updateProject(id, body) {
      fields(body, ['title', 'conversationIds', 'noteIds', 'memberIds', 'expectedVersion']);
      check(Number.isInteger(body.expectedVersion) && body.expectedVersion > 0, 'Update requires expectedVersion');
      const old = load(id, 'project');
      const conversationIds = body.conversationIds === undefined ? old.conversationIds : ids(body.conversationIds, 'c');
      const noteIds = body.noteIds === undefined ? old.noteIds : ids(body.noteIds, 'n');
      // Removed members need not still exist: unlink must remain possible after source loss.
      for (const cid of conversationIds) if (!old.conversationIds.includes(cid)) resolve(cid);
      for (const nid of noteIds) if (!old.noteIds.includes(nid)) load(nid, 'note');
      const memberIds = body.memberIds === undefined ? old.memberIds ?? [] : relations.validateRefs(body.memberIds, old.memberIds ?? []);
      return save(id, { ...old, title: body.title === undefined ? old.title : title(body.title), conversationIds, noteIds, memberIds }, body.expectedVersion);
    },
    notes: (q = {}) => list('note', q),
    note: (id) => publicRecord(load(id, 'note')),
    writeNote(id, body) {
      fields(body, ['title', 'body', 'commentsOn', 'expectedVersion']);
      const old = id ? load(id, 'note') : null;
      check(old ? Number.isInteger(body.expectedVersion) && body.expectedVersion > 0 : body.expectedVersion === null, 'Invalid expectedVersion');
      check(typeof body.body === 'string' && body.body.length <= 200000, 'Note body must be a string of at most 200000 characters');
      id ??= `n-${randomUUID()}`;
      const commentsOn = body.commentsOn === undefined ? old?.commentsOn ?? [] : relations.validateSelections(body.commentsOn, old?.commentsOn ?? []);
      return save(id, { id, namespaceId: relations.namespace().id, kind: 'note', title: title(body.title), body: body.body, provenance: 'user-authored', commentsOn }, body.expectedVersion);
    },
  };
  const relations = createWorldRelations({ store, service, save });
  return Object.assign(service, relations, { importRecord: (id, value) => save(id, value, null), loadImportRecord: (id) => {
    try { return publicRecord(store.load(id)); } catch (e) { if (e.code === 'STORE_NO_SUCH_ITEM') return null; throw e; }
  } });
}

export function registerWorldRoutes({ add, paths, isSessionActive }) {
  const service = createWorldService({ paths, isSessionActive });
  const route = (method, url, fn) => add(method, '/world' + url, 'Offline personal world', (args) => {
    try { return fn(args); } catch (e) { throw e.status ? e : storeProblem(e); }
  });
  route('GET', '/conversations', ({ q }) => service.conversations(q));
  route('GET', '/conversations/{id}', ({ p }) => service.conversation(p.id));
  route('GET', '/projects', ({ q }) => service.projects(q));
  route('GET', '/projects/{id}', ({ p }) => service.project(p.id));
  route('POST', '/projects', ({ body }) => service.createProject(body));
  route('PUT', '/projects/{id}', ({ p, body }) => service.updateProject(p.id, body));
  route('GET', '/notes', ({ q }) => service.notes(q));
  route('GET', '/notes/{id}', ({ p }) => service.note(p.id));
  route('POST', '/notes', ({ body }) => service.writeNote(null, body));
  route('PUT', '/notes/{id}', ({ p, body }) => service.writeNote(p.id, body));
  route('GET', '/namespace', () => service.namespace());
  route('GET', '/objects', ({ q }) => service.objects(q));
  route('GET', '/objects/{id}', ({ p }) => service.object(p.id));
  route('POST', '/objects', ({ body }) => service.createObject(body));
  route('GET', '/selections', ({ q }) => service.selections(q));
  route('GET', '/selections/{id}', ({ p }) => service.selection(p.id));
  route('POST', '/selections', ({ body }) => service.createSelection(body));
  route('GET', '/map', ({ q }) => service.map(q));
  registerWorldSearchRoutes({ add, service });
  registerWorldTransferRoutes({ add, service });
}
