// Structural feature extractor over ordered, ALREADY-DECOMPRESSED protobuf payload frames.
// Pure and deterministic: no I/O, no Date, no random, zero dependencies beyond the existing
// schema-less decoder (src/decode/protobuf.mjs). Does NOT duplicate inflate / envelope framing
// and never re-parses payload bytes; callers hand in per-stream payloads (Buffer/Uint8Array)
// or frame records {payload, complete?}.
//
// WHAT IS MEASURED:
// - STRING PREFIX OBSERVATION (per path, adjacent frames only): retained previous string at a
//   same numerically-identical, NON-positional unindexed path vs current string.
//     current.startsWith(previous) -> prefixExtensions + prefixAddedChars (cumulative counts)
//     previous.startsWith(current) -> prefixShrinks; otherwise plain valueChanged, NOT delta
//   Identical strings/frames are legitimate equal transitions, counted, never deduplicated.
//   Strictly observational: no snapshot/delta dialect, no concatenation authorization, no
//   reply/role/timestamp attribution; values are never emitted.
// - SUPPRESSION: positional identities (any [i] index segment) never get prefix attribution;
//   their textual changes stay valueChanged and the suppressed observation is counted
//   (attributionSuppressed). Cardinality/order changes to a repeated family rename [i] paths
//   entirely; unique paths are identity-stable regardless of document order. Frames whose
//   flatten contains indexed paths surface in sequence.containsPositionalPathsFrames.
// - FRAME STRUCTURE EXTENSION (frameStructureExtensions): separately-named, structure-only
//   view over the FLATTENED ENTRY LIST (paths/kinds/ambiguous, no values): the current entry
//   list strictly extends the previous one. A shape observation only, NOT a payload delta
//   claim; suppressed when the previous structure contains positional paths.
// - Ambiguity: decoder ambiguous flags (string that also parses as a ONE-field message) are
//   counted per frame and per path. DOCUMENTED LIMIT (no alternate parser): a wire-type-2
//   blob parsing as a MULTI-field message is silently classified 'message' even for printable
//   text; features reflect the tree as decoded, un-recoverable from the tree.
// - Budget honesty: frame cap / per-frame byte cap / decoder maxFields abort / path-state cap
//   / retention refusals / oversize strings are budget conditions in their own counters,
//   NEVER "corrupt", never a complete proof of absence (integrity.completeProof stays false).
//   Retention budget preventing comparison marks it unverified — never guessed.
//
// RETENTION BOUNDS (explicit, enforced; no unbounded payload history or distinct sets):
// - Per-path retained last-string budget: maxStringCharsPerPath (UTF-16 units);
//   total retained last-value chars: maxTotalRetainedChars.
// - One retained previous payload copy (<= maxBytesPerFrame) for exact identical-frame
//   detection; one retained previous structure list (paths/kinds/len, bounded by maxFields);
//   corrupt-reason histogram capped at 32 distinct + overflow.

import { decodeProtobuf, flattenProtobuf } from './protobuf.mjs';

// THE shared contract constants. The schema string and the integer version describe the same contract
// ('proto-features/<version>') and are the ONLY values consumers (stream-role coverage, scoreboard,
// tests) may compare against; nobody re-types them. A snapshot whose schema or version differs from these
// is UNSUPPORTED and must be treated conservatively (opaque), never interpreted.
export const PROTO_FEATURES_VERSION = 1;
export const PROTO_FEATURES_SCHEMA = `proto-features/${PROTO_FEATURES_VERSION}`;

export const PROTO_FEATURE_DEFAULTS = Object.freeze(
  Object.assign(Object.create(null), {
    maxFrames: 4096, // analyzed records; further records are counted, not examined
    maxBytesPerFrame: 262144, // larger payloads are skipped (budget, not corruption)
    maxPaths: 2048, // per-path state slots; extra entries only counted
    maxDepth: 6, // message nesting cap passed through to the decoder
    maxFields: 20000, // decoder field budget per frame (also bounds structure lists)
    maxStringCharsPerPath: 512, // per-path retained last-string budget in UTF-16 units
    maxTotalRetainedChars: 65536, // total retained last-value chars across all paths
  }),
);

const MAX_DISTINCT_REASONS = 32;
const VALUE_KINDS = new Set(['varint', 'fixed32', 'fixed64', 'string']);

export function resolveProtoFeatureOptions(opts) {
  const o = opts ?? {};
  if (typeof o !== 'object' || Array.isArray(o)) {
    throw new TypeError(`opts must be an object or omitted, got ${typeof opts}`);
  }
  const resolved = {};
  for (const key of Object.keys(PROTO_FEATURE_DEFAULTS)) {
    const raw = o[key];
    if (raw === undefined) {
      resolved[key] = PROTO_FEATURE_DEFAULTS[key];
      continue;
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || !Number.isFinite(raw) || raw < 1) {
      throw new TypeError(`option ${key} must be a finite positive integer, got ${String(raw)}`);
    }
    resolved[key] = raw;
  }
  for (const key of Object.keys(o)) {
    if (!(key in PROTO_FEATURE_DEFAULTS)) throw new TypeError(`unknown option: ${key}`);
  }
  return resolved;
}

function newMissTracker() {
  return { gap: 0, oversizeCurrent: 0, oversizePrevious: 0, retentionBudget: 0, interrupted: 0 };
}

function newPathState(path) {
  return {
    path,
    positional: path.includes('['),
    fields: 0,
    kinds: Object.assign(Object.create(null), {}),
    ambiguous: 0,
    valueEqual: 0,
    valueChanged: 0,
    kindChanges: 0,
    prefixExtensions: 0,
    prefixAddedChars: 0,
    prefixShrinks: 0,
    valueUnverified: 0,
    oversizeValues: 0,
    retainedChars: 0,
    stale: false, // an unanalyzed frame intervened; the next transition is not adjacent
    everValued: false, // any value-bearing leaf ever arrived at this path
    value: null, // retained previous string/value (bounded; equality + prefix observation only)
    valueKind: null,
    adjacency: 'fresh', // fresh | ok | oversize | broken | denied
    retentionDenied: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Stream extractor factory
// ---------------------------------------------------------------------------------------------
export function createProtoFeatureExtractor(opts) {
  const o = resolveProtoFeatureOptions(opts);

  // Input-level counters
  let recordsSeen = 0;
  let analyzed = 0;
  let ignoredBeyondCap = 0;
  let invalidRecords = 0;
  let incompleteRecords = 0;
  let skippedOversize = 0;

  // Decode-level counters
  let corruptFrames = 0;
  let budgetFrames = 0; // decoder maxFields abort: budget, not corruption
  let partialTopLevelEntries = 0;
  let ambiguousEntries = 0;
  let fieldsTotal = 0;
  let messageEntries = 0;
  let maxDepthObserved = 0;
  const corruptReasons = new Map();
  let corruptReasonOther = 0;
  let framesWithPositionalPaths = 0;

  // Frame-sequence counters
  let atomsIdentical = 0;
  let identicalStreak = 0;
  let identicalStreakMax = 0;
  let structurallySame = 0;
  let changedTransitions = 0;
  let frameShrunk = 0;
  let frameStructureExtensions = 0;
  let frameStructureExtensionSuppressed = 0;
  let identityInterruptions = 0;

  // String prefix observation (global rollup of per-path adjacent comparisons)
  let prefixExtensions = 0;
  let prefixAddedChars = 0;
  let prefixShrinks = 0;
  let prefixAttributionSuppressed = 0;

  // Global kind/value counters
  const scalarKinds = { varint: 0, fixed64: 0, fixed32: 0 };
  let stringEntries = 0;
  let bytesEntries = 0;
  let bytesLenTotal = 0;
  let bytesLenMax = 0;
  const valueEqual = { varint: 0, fixed64: 0, fixed32: 0, string: 0 };
  const valueChanged = { varint: 0, fixed64: 0, fixed32: 0, string: 0 };
  let valueUnverified = 0;
  const valueUnverifiedBy = newMissTracker();
  let oversizeStringValues = 0;

  // Per-path state
  const pathStates = new Map();
  let pathStatesSkippedEntries = 0;

  // Retention bookkeeping
  let retainedChars = 0;
  let retentionBudgetRefusals = 0;

  let prev = null; // { structure, payload } of the last analyzed frame

  // What happened to the MOST RECENT record (compact, counts/enums only). Feeds snapshot().
  let lastObs = { status: 'none', fields: 0, depth: 0, ambiguous: 0, identical: false, structure: 'none', prefixExtensions: 0, prefixAddedChars: 0 };
  const setObs = (status) => { lastObs = { status, fields: 0, depth: 0, ambiguous: 0, identical: false, structure: 'none', prefixExtensions: 0, prefixAddedChars: 0 }; };

  // Unanalyzed record: sequence identity resets; per-path string adjacency goes stale.
  const interrupt = () => {
    if (prev !== null) {
      identityInterruptions++;
      prev = null;
      for (const st of pathStates.values()) st.stale = true;
    }
  };

  const bumpReason = (reason) => {
    if (corruptReasons.has(reason)) corruptReasons.set(reason, corruptReasons.get(reason) + 1);
    else if (corruptReasons.size < MAX_DISTINCT_REASONS) corruptReasons.set(reason, 1);
    else corruptReasonOther++;
  };

  const countUnverifiedAt = (st, reason) => {
    st.valueUnverified++;
    valueUnverified++;
    valueUnverifiedBy[reason]++;
  };

  // A message or bytes leaf at a path breaks string adjacency (no retained string in between).
  const breakValueAdjacency = (st) => {
    if (st.stale && st.everValued) countUnverifiedAt(st, 'gap');
    st.stale = false;
    if (st.everValued && st.adjacency === 'ok') st.adjacency = 'broken';
  };

  // Called for each value leaf (varint / fixed32 / fixed64 / string).
  const recordValue = (st, kind, text) => {
    const oversize = kind === 'string' && text.length > o.maxStringCharsPerPath;
    let reason = null;
    if (!st.everValued) {
      // baseline: first value observation at this path — not a transition
    } else if (st.stale) reason = 'gap';
    else if (st.adjacency === 'broken') reason = 'interrupted';
    else if (st.adjacency === 'denied') reason = 'retentionBudget';
    else if (oversize) reason = 'oversizeCurrent';
    else if (st.adjacency === 'oversize') reason = 'oversizePrevious';
    else if (st.valueKind !== kind) {
      st.kindChanges++;
      st.valueChanged++;
      valueChanged[kind]++;
    } else if (text === st.value) {
      st.valueEqual++;
      valueEqual[kind]++;
    } else if (kind === 'string') {
      // Same-kind string change: only here is ordered (startsWith) observation meaningful,
      // using the already-retained previous string. Positional paths never get attribution.
      if (st.positional) {
        st.valueChanged++;
        valueChanged[kind]++;
        prefixAttributionSuppressed++;
      } else if (text.startsWith(st.value)) {
        const added = text.length - st.value.length;
        st.prefixExtensions++;
        st.prefixAddedChars += added;
        prefixExtensions++;
        prefixAddedChars += added;
      } else if (st.value.startsWith(text)) {
        st.prefixShrinks++;
        prefixShrinks++;
      } else {
        st.valueChanged++;
        valueChanged[kind]++;
      }
    } else {
      st.valueChanged++;
      valueChanged[kind]++;
    }
    if (reason !== null) countUnverifiedAt(st, reason);
    st.everValued = true;
    st.stale = false;
    if (oversize) {
      st.oversizeValues++;
      oversizeStringValues++;
      retainedChars -= st.retainedChars;
      st.retainedChars = 0;
      st.value = null;
      st.valueKind = null;
      st.adjacency = 'oversize';
      return;
    }
    if (!st.retentionDenied && retainedChars - st.retainedChars + text.length <= o.maxTotalRetainedChars) {
      retainedChars += text.length - st.retainedChars;
      st.retainedChars = text.length;
      st.value = text;
      st.valueKind = kind;
      st.adjacency = 'ok';
    } else {
      if (!st.retentionDenied) {
        st.retentionDenied = true;
        retentionBudgetRefusals++;
      }
      retainedChars -= st.retainedChars;
      st.retainedChars = 0;
      st.value = null;
      st.valueKind = null;
      st.adjacency = 'denied';
      if (reason === null) countUnverifiedAt(st, 'retentionBudget');
    }
  };

  const updatePathState = (e) => {
    let st = pathStates.get(e.path);
    if (st === undefined) {
      if (pathStates.size >= o.maxPaths) {
        pathStatesSkippedEntries++;
        return;
      }
      st = newPathState(e.path);
      pathStates.set(e.path, st);
    }
    st.fields++;
    st.kinds[e.kind] = (st.kinds[e.kind] ?? 0) + 1;
    if (e.ambiguous) st.ambiguous++;
    if (e.kind === 'bytes') {
      bytesEntries++;
      bytesLenTotal += e.len;
      if (e.len > bytesLenMax) bytesLenMax = e.len;
      breakValueAdjacency(st); // bytes leaf: counts as kind evidence, no string adjacency
    } else if (VALUE_KINDS.has(e.kind)) {
      recordValue(st, e.kind, e.value);
    } else {
      breakValueAdjacency(st); // message leaf
    }
  };

  // Structure-only entry list retained until the next frame is analyzed (no values kept).
  const buildStructure = (flat) => {
    const out = new Array(flat.length);
    for (let k = 0; k < flat.length; k++) {
      const e = flat[k];
      out[k] = { path: e.path, kind: e.kind, len: e.kind === 'bytes' ? e.len : -1, ambiguous: e.ambiguous === true };
    }
    return out;
  };

  const sameStructureAt = (a, b) => a.path === b.path && a.kind === b.kind && a.len === b.len && a.ambiguous === b.ambiguous;

  const analyzeFrame = (buf) => {
    const res = decodeProtobuf(buf, { maxDepth: o.maxDepth, maxFields: o.maxFields });
    if (!res.ok) {
      if (res.reason === 'max-fields') budgetFrames++;
      else corruptFrames++;
      bumpReason(res.reason);
      partialTopLevelEntries += res.partial.length;
      setObs(res.reason === 'max-fields' ? 'budget' : 'corrupt');
      interrupt();
      return;
    }
    const px0 = prefixExtensions; const pa0 = prefixAddedChars; const amb0 = ambiguousEntries;
    let rel = 'first'; let identical = false;
    analyzed++;
    const flat = flattenProtobuf(res.tree);
    fieldsTotal += flat.length;
    if (res.stats.depth > maxDepthObserved) maxDepthObserved = res.stats.depth;
    const structure = buildStructure(flat);
    let anyPositional = false;
    for (const e of flat) {
      updatePathState(e);
      if (e.ambiguous) ambiguousEntries++;
      if (e.kind === 'message') messageEntries++;
      else if (e.kind === 'string') stringEntries++;
      else if (e.kind !== 'bytes') scalarKinds[e.kind]++;
      if (e.path.includes('[')) anyPositional = true;
    }
    if (anyPositional) framesWithPositionalPaths++;

    if (prev !== null) {
      const P = prev.structure;
      const C = structure;
      const n = Math.min(P.length, C.length);
      let same = true;
      for (let k = 0; k < n; k++) {
        if (!sameStructureAt(P[k], C[k])) {
          same = false;
          break;
        }
      }
      const payloadIdentical = prev.payload.equals(buf);
      identical = payloadIdentical;
      if (C.length > P.length && same) {
        if (anyPositional || P.some((x) => x.path.includes('['))) { frameStructureExtensionSuppressed++; rel = 'suppressed'; }
        else { frameStructureExtensions++; rel = 'extended'; }
      } else if (C.length < P.length && same) {
        frameShrunk++;
        rel = 'shrunk';
      } else if (C.length === P.length && same) {
        structurallySame++; // structural shape repeats; values may still differ (per-path counts)
        rel = 'same';
      } else {
        changedTransitions++;
        rel = 'changed';
      }
      if (payloadIdentical) {
        atomsIdentical++;
        identicalStreak++;
        if (identicalStreak > identicalStreakMax) identicalStreakMax = identicalStreak;
      } else {
        identicalStreak = 0;
      }
    } else {
      identicalStreak = 0;
    }
    prev = { structure, payload: Buffer.from(buf) };
    lastObs = {
      status: 'analyzed', fields: flat.length, depth: res.stats.depth, ambiguous: ambiguousEntries - amb0, identical, structure: rel,
      prefixExtensions: prefixExtensions - px0, prefixAddedChars: prefixAddedChars - pa0,
    };
  };

  return {
    add(item) {
      recordsSeen++;
      if (analyzed >= o.maxFrames) {
        ignoredBeyondCap++;
        setObs('beyond-cap');
        return;
      }
      let payload;
      let complete = true;
      if (item instanceof Uint8Array) {
        payload = item;
      } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        if (item.complete === false) {
          complete = false;
        } else {
          payload = item.payload;
          if (!(payload instanceof Uint8Array)) {
            invalidRecords++;
            setObs('invalid');
            interrupt();
            return;
          }
        }
      } else {
        invalidRecords++;
        setObs('invalid');
        interrupt();
        return;
      }
      if (complete === false) {
        incompleteRecords++;
        setObs('incomplete');
        interrupt();
        return;
      }
      if (payload.length > o.maxBytesPerFrame) {
        skippedOversize++;
        setObs('oversize');
        interrupt();
        return;
      }
      analyzeFrame(payload);
    },

    // A record that is not a protobuf frame (a JSON data frame between protobuf frames) was seen: adjacency
    // of per-path observations is no longer guaranteed. Not counted as an incomplete or invalid record.
    gap() { interrupt(); },

    // COMPACT snapshot for attaching to a decoded event: constant size, counts / enums / booleans only. It
    // never carries paths, strings, retained values or the accumulator, so attaching it to every event does
    // not make the events dataset grow quadratically. `frame` describes the most recent record,
    // `cumulative` everything so far. integrity.completeProof stays false (budget exhaustion or a clean run
    // is never a proof of absence); `incomplete` is the separate, honest "something was not analyzed" flag.
    snapshot() {
      const inspectionTruncated =
        ignoredBeyondCap > 0 || skippedOversize > 0 || budgetFrames > 0 || pathStatesSkippedEntries > 0 || retentionBudgetRefusals > 0 || oversizeStringValues > 0;
      return {
        schema: PROTO_FEATURES_SCHEMA,
        version: PROTO_FEATURES_VERSION,
        frame: { ...lastObs },
        cumulative: {
          records: recordsSeen, analyzed, corrupt: corruptFrames, budget: budgetFrames, incomplete: incompleteRecords, invalid: invalidRecords,
          oversize: skippedOversize, beyondCap: ignoredBeyondCap, fields: fieldsTotal, messages: messageEntries, strings: stringEntries,
          identicalTransitions: atomsIdentical, structurallyIdenticalTransitions: structurallySame, changedTransitions,
          structureExtensions: frameStructureExtensions, shrunkTransitions: frameShrunk, interruptions: identityInterruptions,
          prefixExtensions, prefixAddedChars, prefixShrinks, attributionSuppressed: prefixAttributionSuppressed,
        },
        integrity: {
          inspectionTruncated,
          incomplete: incompleteRecords + invalidRecords + corruptFrames + budgetFrames + skippedOversize + ignoredBeyondCap > 0,
          completeProof: false,
        },
      };
    },

    result() {
      const paths = [];
      for (const st of pathStates.values()) {
        paths.push({
          path: st.path,
          positional: st.positional,
          fields: st.fields,
          kinds: { ...st.kinds },
          ambiguous: st.ambiguous,
          valueEqual: st.valueEqual,
          valueChanged: st.valueChanged,
          kindChanges: st.kindChanges,
          prefixExtensions: st.prefixExtensions,
          prefixAddedChars: st.prefixAddedChars,
          prefixShrinks: st.prefixShrinks,
          valueUnverified: st.valueUnverified,
          oversizeValues: st.oversizeValues,
          retainedChars: st.retainedChars,
          retentionDenied: st.retentionDenied,
        });
      }
      const inspectionTruncated =
        ignoredBeyondCap > 0 ||
        skippedOversize > 0 ||
        budgetFrames > 0 ||
        pathStatesSkippedEntries > 0 ||
        retentionBudgetRefusals > 0 ||
        oversizeStringValues > 0;
      return {
        schema: PROTO_FEATURES_SCHEMA,
        options: { ...o },
        records: {
          input: recordsSeen,
          analyzed,
          ignoredBeyondCap,
          invalid: invalidRecords,
          incomplete: incompleteRecords,
          skippedOversize,
        },
        decode: {
          corruptFrames,
          corruptReasons: Object.fromEntries(corruptReasons),
          corruptReasonOther,
          budgetFrames,
          partialTopLevelEntries,
          ambiguousEntries,
          fieldsTotal,
          messageEntries,
          maxDepthObserved,
        },
        sequence: {
          payloadIdenticalTransitions: atomsIdentical,
          maxConsecutiveIdenticalStreak: identicalStreakMax,
          structurallyIdenticalTransitions: structurallySame,
          changedTransitions,
          frameShrunkTransitions: frameShrunk,
          frameStructureExtensions,
          frameStructureExtensionSuppressed,
          containsPositionalPathsFrames: framesWithPositionalPaths,
          identityInterruptions,
        },
        strings: {
          // Cumulative observational counts of adjacent same-path string-prefix behavior.
          // Observational only: no delta/snapshot dialect is declared or attributed.
          prefixExtensions,
          prefixAddedChars,
          prefixShrinks,
          attributionSuppressed: prefixAttributionSuppressed,
        },
        kinds: {
          scalars: { ...scalarKinds },
          strings: stringEntries,
          messages: messageEntries,
          bytes: { entries: bytesEntries, lenTotal: bytesLenTotal, lenMax: bytesLenMax },
        },
        values: {
          equalTransitions: { ...valueEqual },
          changedTransitions: { ...valueChanged },
          unverifiedTransitions: valueUnverified,
          unverifiedByReason: { ...valueUnverifiedBy },
          oversizeStringValues,
        },
        paths,
        pathsOverflowEntries: pathStatesSkippedEntries,
        retention: {
          retainedChars,
          totalBudget: o.maxTotalRetainedChars,
          perPathBudget: o.maxStringCharsPerPath,
          lastPayloadRetainedBytes: prev !== null ? prev.payload.length : 0,
          lastPayloadBoundBytes: o.maxBytesPerFrame,
          retentionBudgetRefusals,
        },
        integrity: {
          inspectionTruncated,
          completeProof: false, // budget exhaustion is never proof of absence of other behavior
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// One-shot convenience API
// ---------------------------------------------------------------------------------------------
export function extractProtoFeatures(records, opts) {
  const ex = createProtoFeatureExtractor(opts);
  if (records != null) {
    for (const rec of records) ex.add(rec);
  }
  return ex.result();
}
