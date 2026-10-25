// Observation corpus: the discovery engine's input, built from any recorded session.
// Every sample keeps provenance back to raw evidence (session, stream, seq, time, DOM node).
import { templateUrl } from '../shapes/infer.mjs';
import { shapeKey } from './schema.mjs';

export { CorpusSearchIndex, indexCorpus, rankCorpus } from './search.mjs';

const PATCH_DIALECTS = new Set(['path-ops', 'json-patch', 'typed-events']);

export function discriminatorOf(ev) {
  if (ev.envelope?.headers?.length) { const h = ev.envelope.headers.filter((x) => !/^\d+$/.test(x)); if (h.length) return h.slice(0, 2).join('|'); }
  if (ev.event && ev.event !== 'message') return ev.event;
  const j = ev.json;
  if (j && typeof j === 'object' && !Array.isArray(j)) for (const k of ['type', 'event', 'kind', 'op', 'action', 'method', 'object', '__typename']) if (typeof j[k] === 'string' && j[k].length <= 48) return j[k];
  return Array.isArray(j) ? '[array]' : '(object)';
}

export function buildCorpus(reducer, { domTurns = [], domItems = [], session, site } = {}) {
  const samples = [];
  const patchGroups = new Set();
  for (const s of reducer.streams.values()) {
    const endpoint = `${s.method ?? (s.kind === 'ws' ? 'WS' : 'GET')} ${templateUrl(s.url)}`;
    const dialects = [...(s._delta?.detected ?? [])];
    const isPatch = dialects.some((d) => PATCH_DIALECTS.has(d));
    for (const e of s._events ?? []) {
      if (e.json === undefined || e.json === null || typeof e.json !== 'object') continue;
      const group = `${endpoint} :: ${discriminatorOf(e)}`;
      if (isPatch) patchGroups.add(group);
      samples.push({ value: e.json, source: { kind: 'event', group, endpoint, sid: s.sid, seq: e.seq, t: e.t, session: session?.id, site } });
    }
    if (s._delta?.revisions > 0 && s._delta.doc && typeof s._delta.doc === 'object' && isPatch) {
      samples.push({ value: s._delta.doc, source: { kind: 'assembled', group: `${endpoint} :: (assembled)`, endpoint, sid: s.sid, seq: null, t: s.endT ?? s.lastChunkT, session: session?.id, site, revisions: s._delta.revisions, final: s.status === 'complete' } });
    }
  }
  for (const t of domTurns) {
    // DOM node handles, positions and capture flags are provenance, not entity data.
    const { blocks, domId, index, roleAttribute, truncated, redactions, ...rest } = t;
    if (rest.id === domId) delete rest.id;
    // One DOM_TURNS capture is a single snapshot: distinct nodes in it are distinct entities.
    samples.push({ value: { ...rest, blockTypes: [...new Set((blocks ?? []).map((b) => b.type))] }, source: { kind: 'dom', group: 'page :: turns', domId, index, session: session?.id, site, snapshot: `${session?.id ?? ''}|dom-turns|${t.capturedAt ?? 'final'}` } });
  }
  for (const it of domItems) samples.push({ value: it.value, source: { kind: 'dom', group: `page :: ${it.group}`, domId: it.domId, session: session?.id, site, snapshot: it.snapshot } });
  return { samples, patchGroups };
}

// ---------------------------------------------------------------------------------------------
// Streaming collector: sees EVERY decoded event as derive processes it, so the corpus is not
// limited to the reducer's bounded in-memory window. When a group exceeds maxPerGroup it is
// thinned deterministically (first occurrence of every shape is always kept, then a stride) and
// the number of observations not kept is reported in stats.dropped, never silently.
// ---------------------------------------------------------------------------------------------
export class CorpusCollector {
  constructor({ session, site, maxPerGroup = 20000 } = {}) {
    this.session = session; this.site = site; this.maxPerGroup = maxPerGroup;
    this.groups = new Map();   // group -> { list, stride, seen, shapes:Set, dropped }
    this.sidGroups = new Map(); // sid -> Set(group)
    this.sidSeq = new Map();    // sid -> { from, to } over events seen
    this.domSamples = [];
  }

  addEvent(ev, stream) {
    if (!ev || ev.json === undefined || ev.json === null || typeof ev.json !== 'object') return;
    const endpoint = `${stream?.method ?? (stream?.kind === 'ws' ? 'WS' : 'GET')} ${templateUrl(stream?.url)}`;
    const group = `${endpoint} :: ${discriminatorOf(ev)}`;
    if (!this.sidGroups.has(ev.sid)) this.sidGroups.set(ev.sid, new Set());
    this.sidGroups.get(ev.sid).add(group);
    const sq = this.sidSeq.get(ev.sid);
    if (!sq) this.sidSeq.set(ev.sid, { from: ev.seq, to: ev.seq });
    else { if (ev.seq < sq.from) sq.from = ev.seq; if (ev.seq > sq.to) sq.to = ev.seq; }

    let g = this.groups.get(group);
    if (!g) { g = { list: [], stride: 1, seen: 0, shapes: new Set(), dropped: 0 }; this.groups.set(group, g); }
    g.seen++;
    const sh = shapeKey(ev.json);
    const newShape = !g.shapes.has(sh);
    if (newShape) g.shapes.add(sh);
    if (!newShape && g.seen % g.stride !== 0) { g.dropped++; return; }
    g.list.push({ value: ev.json, source: { kind: 'event', group, endpoint, sid: ev.sid, seq: ev.seq, t: ev.t, session: this.session?.id, site: this.site } });
    if (g.list.length > this.maxPerGroup) this._thin(g);
  }

  _thin(g) {
    g.stride *= 2;
    const seenShapes = new Set();
    const kept = [];
    g.list.forEach((s, i) => {
      const sh = shapeKey(s.value);
      const first = !seenShapes.has(sh);
      if (first) seenShapes.add(sh);
      if (first || i % 2 === 0) kept.push(s); else g.dropped++;
    });
    g.list = kept;
  }

  addDomTurns(domTurns = []) {
    for (const t of domTurns) {
      const { blocks, domId, index, roleAttribute, truncated, redactions, ...rest } = t;
      if (rest.id === domId) delete rest.id;
      this.domSamples.push({ value: { ...rest, blockTypes: [...new Set((blocks ?? []).map((b) => b.type))] }, source: { kind: 'dom', group: 'page :: turns', domId, index, session: this.session?.id, site: this.site, snapshot: `${this.session?.id ?? ''}|dom-turns|${t.capturedAt ?? 'final'}` } });
    }
  }

  addDomItems(domItems = []) {
    for (const it of domItems) this.domSamples.push({ value: it.value, source: { kind: 'dom', group: `page :: ${it.group}`, domId: it.domId, session: this.session?.id, site: this.site, snapshot: it.snapshot } });
  }

  result(reducer) {
    const samples = [];
    const patchGroups = new Set();
    for (const g of this.groups.values()) samples.push(...g.list);
    for (const s of reducer.streams.values()) {
      const dialects = [...(s._delta?.detected ?? [])];
      const isPatch = dialects.some((d) => PATCH_DIALECTS.has(d));
      if (!isPatch) continue;
      for (const grp of this.sidGroups.get(s.sid) ?? []) patchGroups.add(grp);
      if (s._delta?.revisions > 0 && s._delta.doc && typeof s._delta.doc === 'object') {
        const endpoint = `${s.method ?? (s.kind === 'ws' ? 'WS' : 'GET')} ${templateUrl(s.url)}`;
        const sq = this.sidSeq.get(s.sid);
        samples.push({ value: s._delta.doc, source: { kind: 'assembled', group: `${endpoint} :: (assembled)`, endpoint, sid: s.sid, seq: null, seqFrom: sq?.from ?? null, seqTo: sq?.to ?? null, t: s.endT ?? s.lastChunkT, session: this.session?.id, site: this.site, revisions: s._delta.revisions, final: s.status === 'complete' } });
      }
    }
    samples.push(...this.domSamples);
    const dropped = {};
    for (const [k, g] of this.groups) if (g.dropped > 0) dropped[k] = g.dropped;
    return { samples, patchGroups, stats: { groups: this.groups.size, samples: samples.length, dropped, maxPerGroup: this.maxPerGroup } };
  }
}
