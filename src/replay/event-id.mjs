// Stable, addressable ids for decoded stream events.
// Id shape: `${sid}#${seq}.${n}` where seq is the raw record seq and n is the 0-based position of the
// event within that record's emission (see StreamReducer._emitEvents). Legacy events without n get
// `${sid}#${seq}`. sids may contain '#', ':' or '.', so parsing always splits on the LAST '#' and
// the LAST '.' of the remainder; the seq and n parts are digits only, so this is unambiguous.

const SEQ_RE = /^-?\d+$/;
const N_RE = /^\d+$/;

export function eventId(e) {
  const base = `${e.sid}#${e.seq}`;
  return e.n === undefined || e.n === null ? base : `${base}.${e.n}`;
}

export function parseEventId(id) {
  if (typeof id !== 'string') return null;
  const hash = id.lastIndexOf('#');
  if (hash <= 0) return null;
  const sid = id.slice(0, hash);
  const rest = id.slice(hash + 1);
  const dot = rest.lastIndexOf('.');
  const seqStr = dot === -1 ? rest : rest.slice(0, dot);
  const nStr = dot === -1 ? null : rest.slice(dot + 1);
  if (!SEQ_RE.test(seqStr)) return null;
  if (nStr !== null && !N_RE.test(nStr)) return null;
  return { sid, seq: Number(seqStr), n: nStr === null ? null : Number(nStr) };
}

// Total order: seq, then n (legacy events without n sort before n=0), then sid, then the raw id.
// Malformed ids sort after well-formed ones. Accepts ids or event objects.
export function compareEventIds(a, b) {
  const ia = typeof a === 'string' ? a : eventId(a);
  const ib = typeof b === 'string' ? b : eventId(b);
  const pa = parseEventId(ia);
  const pb = parseEventId(ib);
  if (!pa || !pb) {
    if (pa) return -1;
    if (pb) return 1;
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  }
  if (pa.seq !== pb.seq) return pa.seq < pb.seq ? -1 : 1;
  const na = pa.n ?? -1;
  const nb = pb.n ?? -1;
  if (na !== nb) return na < nb ? -1 : 1;
  if (pa.sid !== pb.sid) return pa.sid < pb.sid ? -1 : 1;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
