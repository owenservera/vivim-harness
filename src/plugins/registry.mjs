/**
 * Tiny deterministic plugin registry.
 *
 * Zero dependencies. Kinds are fixed at construction time so a typo can never
 * silently create a new bucket. Entries are stored insertion-independently:
 * `list()` and `snapshot()` always sort by name.
 */

export const DEFAULT_KINDS = Object.freeze([
  'formats',
  'codecs',
  'secretPatterns',
  'migrations',
  'transforms',
]);

function kindLabel(kind) {
  return typeof kind === 'string' ? kind : JSON.stringify(kind);
}

/**
 * @param {string[]} [kinds] kinds the registry accepts; defaults to DEFAULT_KINDS.
 * @returns {{
 *   register: (kind: string, name: string, impl: any, opts?: {replace?: boolean, meta?: any, builtin?: boolean}) => any,
 *   get: (kind: string, name: string) => any,
 *   has: (kind: string, name: string) => boolean,
 *   list: (kind: string) => string[],
 *   unregister: (kind: string, name: string) => boolean,
 *   snapshot: () => Record<string, Array<{name: string, builtin: boolean, meta: any, registeredAt: null}>>,
 *   kinds: () => string[],
 * }}
 */
export function createRegistry(kinds = DEFAULT_KINDS) {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new TypeError('createRegistry: kinds must be a non-empty array');
  }
  const known = new Set();
  const buckets = new Map();
  for (const kind of kinds) {
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new TypeError('createRegistry: every kind must be a non-empty string');
    }
    if (known.has(kind)) throw new Error(`createRegistry: duplicate kind ${kind}`);
    known.add(kind);
    buckets.set(kind, new Map());
  }

  function bucket(kind) {
    if (!known.has(kind)) throw new Error(`unknown registry kind: ${kindLabel(kind)}`);
    return buckets.get(kind);
  }

  function assertName(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('registry: name must be a non-empty string');
    }
    return name;
  }

  const registry = {
    register(kind, name, impl, { replace = false, meta, builtin = false } = {}) {
      const map = bucket(kind);
      assertName(name);
      if (impl === undefined) throw new TypeError(`registry: ${kind}/${name} impl is undefined`);
      if (map.has(name) && !replace) {
        throw new Error(`duplicate ${kind} entry: ${name}`);
      }
      map.set(name, { impl, meta: meta === undefined ? null : meta, builtin: builtin === true });
      return impl;
    },

    get(kind, name) {
      const entry = bucket(kind).get(name);
      return entry === undefined ? undefined : entry.impl;
    },

    has(kind, name) {
      if (!known.has(kind)) return false;
      return buckets.get(kind).has(name);
    },

    list(kind) {
      return [...bucket(kind).keys()].sort();
    },

    unregister(kind, name) {
      return bucket(kind).delete(name);
    },

    snapshot() {
      /** @type {Record<string, any>} */
      const out = {};
      for (const kind of [...known].sort()) {
        out[kind] = [...bucket(kind).entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, entry]) => ({
            name,
            builtin: entry.builtin === true,
            meta: entry.meta === undefined ? null : entry.meta,
            registeredAt: null,
          }));
      }
      // Proves JSON-safety before handing the object out.
      return JSON.parse(JSON.stringify(out));
    },

    kinds() {
      return [...known].sort();
    },
  };

  return registry;
}

/** Shared default registry used by the rest of the studio. */
export const registry = createRegistry();

export default registry;
