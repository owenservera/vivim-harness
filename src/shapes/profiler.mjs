import { SchemaNode, schemaDiff } from '../intel/schema.mjs';

// Window nodes are lazy. A completed window is only ever read as `previous` (and each rollover
// overwrites the one before it), so observing every value into a second SchemaNode is wasted work
// for all but the last two windows. Values of a window are buffered and replayed into a real
// SchemaNode only when something reads `current`/`previous` (describe, toState) - same values,
// same order, so every statistic is identical. Buffering is bounded by an approximate byte budget;
// a window that exceeds it simply switches to an eager node (the previous behaviour).
const WINDOW_BUFFER_BUDGET = 32 * 1024;

function approxSize(source) {
  if (!source || typeof source !== 'object') return 1024;
  if (Array.isArray(source.span) && source.span.length === 2) return Math.max(1, source.span[1] - source.span[0]);
  if (typeof source.data === 'string') return source.data.length;
  if (typeof source.text === 'string') return source.text.length;
  if (Number.isFinite(source.size)) return source.size;
  return 1024;
}

class ProfileEntry {
  constructor(group) {
    this.group = group; this.total = new SchemaNode(); this.windows = 0; this.lastSource = null;
    this._curNode = null; this._curVals = []; this._curBytes = 0; this.curCount = 0;
    this._prev = null; this._prevVals = null;
  }
  observeCurrent(value, source) {
    this.curCount++;
    if (this._curNode) { this._curNode.observe(value); return; }
    this._curBytes += approxSize(source);
    if (this._curBytes > WINDOW_BUFFER_BUDGET) { this._materializeCurrent().observe(value); return; }
    this._curVals.push(value);
  }
  _materializeCurrent() {
    if (!this._curNode) {
      const node = new SchemaNode();
      for (const v of this._curVals) node.observe(v);
      this._curNode = node; this._curVals = [];
    }
    return this._curNode;
  }
  rollWindow() {
    // Equivalent to: previous = current.describe(); current = new SchemaNode(); windows++
    if (this._curNode) { this._prev = this._curNode.describe(); this._prevVals = null; }
    else { this._prevVals = this._curVals; this._prev = null; } // an older unread window is simply dropped
    this._curNode = null; this._curVals = []; this._curBytes = 0; this.curCount = 0;
    this.windows++;
  }
  get current() { return this._materializeCurrent(); }
  set current(node) { this._curNode = node; this._curVals = []; this._curBytes = 0; this.curCount = node.count; }
  get previous() {
    if (this._prevVals) {
      const node = new SchemaNode();
      for (const v of this._prevVals) node.observe(v);
      this._prev = node.describe(); this._prevVals = null;
    }
    return this._prev;
  }
  set previous(v) { this._prev = v ?? null; this._prevVals = null; }
  get hasPrevious() { return !!(this._prevVals || this._prev); }
}

// Cumulative sufficient statistics plus independent fixed-size windows for drift detection.
// Missing fields in a window mean observed schema drift, never deletion of entity state.
export class OnlineSchemaProfiler {
  constructor({ windowSize = 100, minWindow = 10, maxGroups = 256 } = {}) {
    if (!Number.isInteger(windowSize) || windowSize < 2 || !Number.isInteger(maxGroups) || maxGroups < 1) throw new RangeError('Invalid profiler bounds');
    this.windowSize = windowSize; this.minWindow = Math.max(2, Math.min(windowSize, minWindow));
    this.maxGroups = maxGroups; this.groups = new Map(); this.evictedGroups = 0;
  }
  observe(group, value, source = {}) {
    group = String(group);
    let entry = this.groups.get(group);
    if (!entry) {
      if (this.groups.size >= this.maxGroups) { this.groups.delete(this.groups.keys().next().value); this.evictedGroups++; }
      entry = new ProfileEntry(group);
    } else this.groups.delete(group);
    this.groups.set(group, entry);
    if (entry.curCount >= this.windowSize) entry.rollWindow();
    entry.total.observe(value); entry.observeCurrent(value, source);
    entry.lastSource = { session: source.session, sid: source.sid, seq: source.seq, t: source.t };
    return this;
  }
  describe(group) {
    const e = this.groups.get(String(group)); if (!e) return null;
    const current = e.current.describe();
    return { group: e.group, observations: e.total.count, completedWindows: e.windows, windowObservations: e.current.count,
      schema: e.total.describe(), currentSchema: current, source: e.lastSource,
      drift: e.hasPrevious && e.current.count >= this.minWindow ? schemaDiff(e.previous, current) : null,
      driftBasis: e.hasPrevious ? 'adjacent independent observation windows' : 'insufficient windows' };
  }
  report() { return { groups: [...this.groups.keys()].map((key) => this.describe(key)), evictedGroups: this.evictedGroups,
    maxGroups: this.maxGroups, windowSize: this.windowSize, minWindow: this.minWindow }; }
  groupKeys() { return [...this.groups.keys()]; }
  // Resumable state (plain JSON). Group order is LRU order and is preserved.
  toState() {
    return { format: 'capture-studio.schema-profiler/1', windowSize: this.windowSize, minWindow: this.minWindow,
      maxGroups: this.maxGroups, evictedGroups: this.evictedGroups,
      groups: [...this.groups.values()].map((e) => ({ group: e.group, total: e.total.toState(), current: e.current.toState(),
        previous: e.previous ?? null, windows: e.windows, lastSource: e.lastSource ?? null })) };
  }
  static fromState(state, overrides = {}) {
    if (!state || !Array.isArray(state.groups)) throw new TypeError('Invalid schema profiler state');
    const p = new OnlineSchemaProfiler({ windowSize: state.windowSize ?? 100, minWindow: state.minWindow ?? 10,
      maxGroups: Math.max(state.maxGroups ?? 256, overrides.maxGroups ?? 0) });
    p.evictedGroups = state.evictedGroups ?? 0;
    for (const g of state.groups) {
      const group = String(g.group);
      const entry = new ProfileEntry(group);
      entry.total = SchemaNode.fromState(g.total); entry.current = SchemaNode.fromState(g.current);
      entry.previous = g.previous ?? null; entry.windows = g.windows ?? 0; entry.lastSource = g.lastSource ?? null;
      p.groups.set(group, entry);
    }
    return p;
  }
}

// Export a portable draft-2020-12 schema from observed descriptions. Required means observed
// in every sampled object, not a guarantee about future server payloads.
export function toJsonSchema(description, { includeExamples = false } = {}) {
  const convert = (d) => {
    if (!d) return {};
    const out = {}, type = d.type;
    if (type === 'union') {
      const kinds = d.union?.map((v) => v.kind).filter((k) => ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(k)) ?? [];
      if (d.nullable && !kinds.includes('null')) kinds.push('null');
      if (kinds.length) out.type = kinds;
    } else if (['string', 'number', 'integer', 'boolean', 'object', 'array', 'null', 'map'].includes(type)) {
      const actual = type === 'map' ? 'object' : type;
      out.type = d.nullable && actual !== 'null' ? [actual, 'null'] : actual;
    }
    const fields = d.fields ?? d.object?.fields;
    if (fields) {
      out.properties = Object.fromEntries(Object.entries(fields).map(([key, child]) => [key, convert(child)]));
      const required = Object.entries(fields).filter(([, child]) => child.required).map(([key]) => key);
      if (required.length) out.required = required;
      out.additionalProperties = true;
    }
    if (d.array) out.items = convert(d.array.items);
    if (d.map) out.additionalProperties = convert(d.map.values);
    if (d.string) {
      // Enum is descriptive, not a closed server contract; keep it as an annotation.
      if (d.string.enum) out['x-observed-enum'] = d.string.enum.map((item) => item.value);
      const formats = d.string.formats ?? {};
      if (formats.uuid) out.format = 'uuid'; else if (formats.email) out.format = 'email';
      else if (formats.iso_time) out['x-observed-format'] = 'iso_time';
      if (includeExamples) out.examples = d.string.examples;
    }
    if (d.presence !== undefined) out['x-observed-presence'] = d.presence;
    out['x-observations'] = d.count ?? 0;
    return out;
  };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...convert(description) };
}
