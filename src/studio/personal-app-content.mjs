// Durable user-owned content for a personal app. Shares Studio's same-owner HTTP boundary.
// Read is inert; writes use VersionedStore CAS and stable creation keys. No provider dispatch.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VersionedStore } from '../store/versioned.mjs';
import { problem, storeProblem } from './http.mjs';

export const PERSONAL_APP_CONTENT_SCHEMA = 'vivim.personal-app-content/1';
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const ITEM_ID = /^item-[a-f0-9]{32}$/;
const KINDS = new Set(['note', 'task']);
const MAX_ITEMS = 200;
const fail = (status, code, message) => problem(status, message, code);
function clean(value, name, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max ||
      (!allowEmpty && !value.trim()) ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw fail(400, 'PERSONAL_APP_CONTENT_INVALID', name + ' must be printable and at most ' + max + ' characters');
  }
  return value.trim();
}
export function assertPersonalAppContent(content, id) {
  if (!content || content.schema !== PERSONAL_APP_CONTENT_SCHEMA ||
      content.appId !== id || !Number.isSafeInteger(content.version) ||
      content.version < 0 || !Array.isArray(content.items) ||
      content.items.length > MAX_ITEMS) {
    throw fail(500, 'PERSONAL_APP_CONTENT_CORRUPT', 'Stored personal app content has invalid metadata');
  }
  const seen = new Set();
  for (const item of content.items) {
    if (!item || !ITEM_ID.test(item.id) || seen.has(item.id) ||
        !KINDS.has(item.kind) || typeof item.title !== 'string' ||
        !item.title.trim() || item.title.length > 160 ||
        typeof item.body !== 'string' || item.body.length > 4000 ||
        typeof item.completed !== 'boolean' || typeof item.createdAt !== 'string') {
      throw fail(500, 'PERSONAL_APP_CONTENT_CORRUPT', 'Stored app item is invalid');
    }
    seen.add(item.id);
  }
  return content;
}
export function createPersonalAppContentService({ paths, apps, clock = () => new Date().toISOString() } = {}) {
  if (!paths?.root || !path.isAbsolute(paths.root) || typeof apps?.get !== 'function') {
    throw new TypeError('Absolute local paths and personal app owner required');
  }
  const store = new VersionedStore(path.join(paths.root, 'personal-app-content'), { kind: 'personal app content' });
  function get(id) {
    apps.get(id); // Validates id and enforces that the blueprint is owned locally.
    if (!store.has(id)) return { schema: PERSONAL_APP_CONTENT_SCHEMA, appId: id,
      version: 0, items: [], authority: 'local-pc', remoteSync: 'not-configured' };
    return assertPersonalAppContent(store.load(id), id);
  }
  const save = (id, before, next, message) => {
    try {
      return assertPersonalAppContent(store.compareAndSave(id, next, {
        expectedVersion: before.version === 0 ? null : before.version, changeNote: message,
      }), id);
    } catch (error) { throw storeProblem(error); }
  };
  function createItem({ id, expectedVersion, idempotencyKey, kind, title, body = '' } = {}) {
    if (!KEY.test(idempotencyKey ?? '') || !KINDS.has(kind)) {
      throw fail(400, 'PERSONAL_APP_CONTENT_INVALID', 'Valid idempotency key and note/task kind required');
    }
    const name = clean(title, 'title', 160), detail = clean(body, 'body', 4000, true);
    const before = get(id);
    const itemId = 'item-' + createHash('sha256').update(id + ':' + idempotencyKey).digest('hex').slice(0, 32);
    const prior = before.items.find(item => item.id === itemId);
    if (prior) {
      if (prior.title !== name || prior.body !== detail || prior.kind !== kind) {
        throw fail(409, 'PERSONAL_APP_CONTENT_IDEMPOTENCY_CONFLICT', 'Creation key belongs to different content');
      }
      return { content: before, item: prior, replayed: true };
    }
    if (!Number.isSafeInteger(expectedVersion) || before.version !== expectedVersion) {
      throw fail(409, 'PERSONAL_APP_CONTENT_VERSION_CONFLICT', 'App content changed; reload before saving');
    }
    if (before.items.length >= MAX_ITEMS) {
      throw fail(409, 'PERSONAL_APP_CONTENT_LIMIT', 'App content reached its item limit');
    }
    const item = { id: itemId, kind, title: name, body: detail, completed: false,
      createdAt: clock(), updatedAt: clock(), origin: 'explicit-user-input' };
    const content = save(id, before, { ...before, items: [...before.items, item] }, 'Created user-authored ' + kind);
    return { content, item, replayed: false };
  }
  function setTaskComplete({ id, itemId, expectedVersion, completed } = {}) {
    if (!ITEM_ID.test(itemId ?? '') || typeof completed !== 'boolean') {
      throw fail(400, 'PERSONAL_APP_CONTENT_INVALID', 'Valid item ID and completed flag required');
    }
    const before = get(id), old = before.items.find(item => item.id === itemId);
    if (!old || old.kind !== 'task') {
      throw fail(404, 'PERSONAL_APP_CONTENT_NOT_FOUND', 'Local task not found');
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== before.version) {
      throw fail(409, 'PERSONAL_APP_CONTENT_VERSION_CONFLICT', 'App content changed; reload before updating');
    }
    if (old.completed === completed) return { content: before, item: old, changed: false };
    const item = { ...old, completed, updatedAt: clock() };
    const content = save(id, before, { ...before,
      items: before.items.map(value => value.id === itemId ? item : value) }, 'Changed local task completion');
    return { content, item, changed: true };
  }
  return { get, createItem, setTaskComplete };
}
