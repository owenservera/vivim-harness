// Shared integration boundary helpers. No dependency on the UI or a running browser.
export function problem(status, message, code = 'INVALID_REQUEST') {
  return Object.assign(new Error(message), { status, code });
}

// Stable HTTP status for persistence-owner errors (src/store/versioned.mjs and its I1/factory callers).
export const STORE_ERROR_STATUS = Object.freeze({
  STORE_NAME_INVALID: 400, STORE_PATH_ESCAPE: 400, STORE_VERSION_INVALID: 400, CAS_EXPECTED_VERSION_INVALID: 400, INVALID_ROLLBACK_VERSION: 400, RESERVED_NAMESPACE: 400,
  STORE_NO_SUCH_ITEM: 404, STORE_NO_SUCH_VERSION: 404, CAS_VERSION_CONFLICT: 409, CAS_LOCKED: 423,
  CAS_LOCK_RELEASE_UNVERIFIED: 500, STORE_CURRENT_CORRUPT: 500, STORE_RECORD_CORRUPT: 500, STORE_VERSION_EXISTS: 500, STORE_VERSION_LIMIT: 500,
});

// Machine-readable facts that must survive the HTTP boundary: a durable commit whose lock release was unverified
// (committed:true + committedVersion - the client must NOT repeat the mutation) and the CAS conflict operands.
export function storeFields(e) {
  const out = {};
  if (e && e.committed === true) { out.committed = true; out.committedVersion = Number.isSafeInteger(e.committedVersion) ? e.committedVersion : null; }
  if (e && e.code === 'CAS_VERSION_CONFLICT') {
    if (e.expected === null || Number.isSafeInteger(e.expected)) out.expected = e.expected;
    if (e.actual === null || Number.isSafeInteger(e.actual)) out.actual = e.actual;
  }
  return out;
}

/** Map a persistence-owner error to an HTTP problem, keeping its stable code and storeFields(); other errors pass through. */
export function storeProblem(e) {
  if (!e || e.status || !STORE_ERROR_STATUS[e.code]) return e;
  return Object.assign(problem(STORE_ERROR_STATUS[e.code], e.message, e.code), storeFields(e));
}
export function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export function integer(value, fallback, max = 1000, min = 0) {
  if (value === undefined) return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw problem(400, 'Expected an integer');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw problem(400, `Expected an integer between ${min} and ${max}`);
  return n;
}

export function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw problem(400, `${name} must be a nonempty string of at most ${max} characters`);
  return value;
}

export function object(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, `${name} must be a JSON object`);
  return value;
}

export function storageName(value, name = 'name') {
  text(value, name, 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.includes('..')) throw problem(400, `Invalid ${name}`);
  return value;
}

export function timestamp(value, name = 'at') {
  if (value === undefined) return null;
  const t = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(t) || t < 0 || t > 8640000000000000) throw problem(400, `${name} must be epoch milliseconds or an ISO timestamp`);
  return t;
}

export function page(items, q = {}) {
  const offset = integer(q.offset, 0, 1000000), limit = integer(q.limit, 100, 1000, 1);
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, nextOffset: offset + limit < items.length ? offset + limit : null };
}

// Limit returned rows without loading the whole JSONL dataset. Offset counts matching rows.
export async function datasetPage(dataset, q = {}, predicate = () => true, transform = (x) => x) {
  const offset = integer(q.offset, 0, 1000000), limit = integer(q.limit, 100, 1000, 1);
  const items = [];
  let matched = 0, hasMore = false;
  for await (const row of dataset.iterate()) {
    if (!predicate(row)) continue;
    if (matched++ < offset) continue;
    if (items.length === limit) { hasMore = true; break; }
    items.push(transform(row));
  }
  return { items, offset, limit, hasMore, nextOffset: hasMore ? offset + items.length : null };
}
