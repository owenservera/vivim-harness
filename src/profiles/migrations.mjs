/**
 * Deterministic, versioned profile migration chain.
 *
 * Objects carry `schemaVersion` (missing => 1). Registered steps run in order
 * from the object's version up to the chain's current version. A throwing step
 * leaves the value at the last good step and records `ok: false`.
 */

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function assertVersion(n, label) {
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError(`migration: ${label} must be a positive integer`);
  }
  return n;
}

/**
 * @param {{current?: number}} [opts]
 */
export function createMigrationChain({ current = 2 } = {}) {
  assertVersion(current, 'current');

  /** @type {Map<string, {from: number, to: number, fn: (obj: any) => any, name: string}>} */
  const steps = new Map();
  const key = (from, to) => `${from}->${to}`;

  function register(from, to, fn, { name } = {}) {
    assertVersion(from, 'from');
    assertVersion(to, 'to');
    if (to <= from) throw new RangeError(`migration: to (${to}) must be greater than from (${from})`);
    if (typeof fn !== 'function') throw new TypeError('migration: fn must be a function');
    const k = key(from, to);
    if (steps.has(k)) throw new Error(`duplicate migration: ${k}`);
    steps.set(k, { from, to, fn, name: typeof name === 'string' && name ? name : k });
    return steps.get(k);
  }

  function migrate(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new TypeError('migrate: expected a plain object');
    }
    const log = [];
    let changed = false;
    let value = clone(obj);
    let version =
      Number.isInteger(value.schemaVersion) && value.schemaVersion >= 1 ? value.schemaVersion : 1;

    if (version > current) {
      log.push({
        from: version,
        to: version,
        name: '(none)',
        ok: false,
        error: `newer schemaVersion ${version} > ${current}`,
      });
      return { value, log, changed: false };
    }

    while (version < current) {
      const next = [...steps.values()]
        .filter((step) => step.from === version)
        .sort((a, b) => a.to - b.to)[0];

      if (!next) {
        log.push({
          from: version,
          to: current,
          name: '(none)',
          ok: false,
          error: `no migration registered from v${version}`,
        });
        break;
      }

      try {
        const out = next.fn(clone(value));
        if (out === null || typeof out !== 'object' || Array.isArray(out)) {
          throw new TypeError(`migration ${next.name} must return a plain object`);
        }
        value = out;
        value.schemaVersion = next.to;
        version = next.to;
        changed = true;
        log.push({ from: next.from, to: next.to, name: next.name, ok: true });
      } catch (error) {
        log.push({
          from: next.from,
          to: next.to,
          name: next.name,
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
        return { value, log, changed };
      }
    }

    if (changed && version === current && value.schemaVersion !== current) {
      value.schemaVersion = current;
    }

    return { value, log, changed };
  }

  const chain = {
    register,
    migrate,
    get currentVersion() {
      return current;
    },
  };

  // Built-in v1 -> v2: only stamps the version, every other field is untouched.
  register(
    1,
    2,
    (o) => ({ ...o, schemaVersion: 2 }),
    { name: 'builtin:v1->v2' },
  );

  return chain;
}

/** Default shared chain (current schema version 2). */
export const migrations = createMigrationChain();

export default migrations;
