#!/usr/bin/env node
// Real-session fidelity survey (READ-ONLY).
//
// Replays each saved session's raw log IN MEMORY through the product's own modules and reports,
// per session, how the stream-to-component pipeline sees it: framings, dialects, the detected
// stream map, component/unmapped counts, and the stream-to-DOM join against the saved DOM_TURNS.
//
// Usage:
//   node scripts/fidelity-survey.mjs [--data-dir DIR] (--session ID | --all) [--limit N]
//                                    [--out FILE] [--json] [--diagnose]
//
// Guarantees:
//   * Never writes into the data directory. The session is NOT opened through store/session.mjs,
//     because its constructor creates kv/ and Dataset constructors create folders. Raw segments are
//     read with store/raw-index.mjs iterateRaw (read-only) and kv/DOM_TURNS.json with readFileSync.
//   * Never derives, never opens a browser, never contacts a network.
//   * Snapshots every touched session directory (relative path, kind, size, mtime) before and after
//     the run. Any difference prints "WRITE DETECTED <path>" and exits 4 with no report.
//   * Refuses a data directory that is the repository checkout (or inside one), and refuses an
//     --out file inside the data directory.
//   * The report is shareable: counts, ids, host only, enum labels. No message text, no URL paths
//     or query strings, no titles, no headers, no cookies.
//   * Each session is isolated in try/catch. A bad session becomes status "error" with a class name.
//   * Per stream, at most EVENT_CAP decoded events stay in memory; evictions are reported as
//     eventsOmitted. Raw records are streamed one at a time, never loaded whole.
import { readFileSync, readdirSync, statSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultDataDir, dataPaths, TOOL_ROOT } from '../src/config.mjs';
import { iterateRaw } from '../src/store/raw-index.mjs';
import { StreamReducer } from '../src/replay/reducer.mjs';
import { detectStreamMap, applyStreamMap } from '../src/profiles/stream-map.mjs';
import { buildStreamMessages } from '../src/replay/stream-messages.mjs';
import { joinStreamToDom, normalizeForJoin, normalizeRole, NEAR_THRESHOLD } from '../src/intel/join.mjs';

export const SURVEY_SCHEMA = 'capture-studio.fidelity-survey/1';
export const EVENT_CAP = 20000;
const RANK_LIMIT = 20;
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_WRITE = 4;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
// Reason labels are shown in the shareable report; anything not shaped like a schema label is redacted.
const SAFE_VIEW_PART = /^[A-Za-z_]+=[A-Za-z0-9_.\/*:+-]{1,80}$/;
const SAFE_LABEL = /^[A-Za-z0-9_.:\/=,*+ -]{1,120}$/;

const USAGE = [
  'Usage: node scripts/fidelity-survey.mjs [--data-dir DIR] (--session ID | --all) [--limit N] [--out FILE] [--json] [--diagnose]',
  '  --session ID   survey one session folder (read-only)',
  '  --all          survey every session folder, newest name first; --limit N keeps the first N',
  '  --out FILE     also write the JSON report to FILE (refused inside the data directory)',
  '  --json         print the JSON report to stdout (default: table on stderr)',
  '  --diagnose     add per-assistant-turn join diagnostics (counts and numbers only; no text)',
  '',
].join('\n');

export class UsageError extends Error {}
export class GuardError extends Error {}

// ---------------------------------------------------------------------------------------------
// Path guards
// ---------------------------------------------------------------------------------------------
function canon(p) {
  let r = path.resolve(p);
  try { r = realpathSync(r); } catch {
    try { r = path.join(realpathSync(path.dirname(r)), path.basename(r)); } catch { /* keep resolved */ }
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function isInside(child, parent) {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

export function findGitRoots(start) {
  const out = [];
  let d = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(d, '.git'))) out.push(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

// Refuses a data directory that is the repository checkout, or inside one.
export function assertNotRepoCheckout(dataDir, { toolRoot = TOOL_ROOT, gitRoots = findGitRoots(TOOL_ROOT) } = {}) {
  const target = canon(dataDir);
  for (const repo of [toolRoot, ...gitRoots]) {
    if (isInside(target, canon(repo))) {
      throw new GuardError('refusing: the data directory is the repository checkout or inside it; point --data-dir outside the repo');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Write-detection snapshots over the touched session folders
// ---------------------------------------------------------------------------------------------
function walkInto(out, id, root, dir) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    const rel = `${id}/${path.relative(root, p).split(path.sep).join('/')}`;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (ent.isDirectory()) {
      out.set(`${rel}/`, { kind: 'dir', size: 0, mtimeMs: st.mtimeMs });
      walkInto(out, id, root, p);
    } else if (ent.isFile()) {
      out.set(rel, { kind: 'file', size: st.size, mtimeMs: st.mtimeMs });
    }
  }
}

// sessions: [{ id, dir }] -> Map(relative path -> { kind, size, mtimeMs })
export function snapshotSessionDirs(sessions) {
  const out = new Map();
  for (const { id, dir } of sessions) {
    out.set(`${id}/`, { kind: 'dir', size: 0, mtimeMs: safeMtime(dir) });
    walkInto(out, id, dir, dir);
  }
  return out;
}

function safeMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

export function diffSnapshots(before, after) {
  const changes = [];
  for (const [k, v] of before) {
    if (!after.has(k)) { changes.push({ path: k, change: 'removed' }); continue; }
    const w = after.get(k);
    if (w.kind !== v.kind || w.size !== v.size || w.mtimeMs !== v.mtimeMs) changes.push({ path: k, change: 'modified' });
  }
  for (const k of after.keys()) if (!before.has(k)) changes.push({ path: k, change: 'added' });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Join diagnostics (opt-in: --diagnose). COUNTS AND NUMBERS ONLY: no message text, no DOM text,
// no URL paths or query strings. Every value is a number, a boolean, null, or an enum label below.
//
// Candidates: the messages the join uses (buildStreamMessages), restricted to role 'assistant'
// after normalizeRole, with non-empty normalized text. Every candidate is scored for every
// assistant DOM turn; the best Dice wins (ties: earliest stream message).
//
// Metric: multiset token Dice, copied from join.mjs tokenDice (NOT exported there). Drift risk: if
// join.mjs changes its tokenisation or Dice formula this copy must follow. The threshold is the
// exported NEAR_THRESHOLD, so only the copied formula can drift silently. Normalization is the
// exported normalizeForJoin, so it cannot drift.
//
// Units: "chars" are UTF-16 code units (String.length) of the NORMALIZED text, except
// featureCounts, which count the RAW text (before normalization).
//
// diagnosis (first rule that matches; compares the best candidate with the DOM turn):
//   no_candidate                no candidate message with non-empty normalized text
//   exact_after_normalization   normalized texts are equal
//   prefix                      one normalized text is a strict prefix of the other (DOM non-empty)
//   near                        Dice >= NEAR_THRESHOLD (same tier as the join's near_match)
//   similar                     0.5 <= Dice < NEAR_THRESHOLD
//   different                   Dice < 0.5
//
// likelyCause (first rule that matches; null when there is no candidate):
//   none_detected                       exact_after_normalization, or no asymmetry found
//   private_use_markers_in_stream_only  stream has more U+E000-U+F8FF than DOM
//   citation_markers_in_stream_only     stream has more [1] / [^1] / 【..】 than DOM
//   markdown_syntax_in_stream_only      stream has more links, images, fences, table rows,
//                                       headings or bullet lines than DOM
//   entities_in_stream_only             stream has more HTML entities than DOM
//   zero_width_in_stream_only           stream has more zero-width / soft-hyphen chars than DOM
//   html_tags_in_stream_only            stream has more HTML tags than DOM
//   dom_has_extra_ui_text               normalized stream text is inside the longer DOM text
//   length_ratio_far_from_1             lengthRatio < 0.9 or > 1.1 (or DOM empty)
//
// The asymmetry rules are a best-effort guess from raw counts. They say which gap is present,
// not that it caused the miss.
const DICE_BUCKET_LABELS = ['[0]', '(0,0.5)', '[0.5,0.8)', `[0.8,${NEAR_THRESHOLD})`, `[0.95,1]`];
const DIAGNOSES = ['exact_after_normalization', 'prefix', 'near', 'similar', 'different', 'no_candidate'];
const LIKELY_CAUSES = [
  'none_detected', 'private_use_markers_in_stream_only', 'citation_markers_in_stream_only',
  'markdown_syntax_in_stream_only', 'entities_in_stream_only', 'zero_width_in_stream_only',
  'html_tags_in_stream_only', 'dom_has_extra_ui_text', 'length_ratio_far_from_1',
];
const MARKDOWN_FEATURES = ['markdownLinks', 'markdownImages', 'fenceLines', 'tableRows', 'headingLines', 'bulletLines'];
const PRIVATE_USE_RE = /[\uE000-\uF8FF]/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const MD_LINK_RE = /(?<!!)\[[^\]\n]*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g;
const MD_IMAGE_RE = /!\[[^\]\n]*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g;
const CITATION_RE = /\[\^?\d+\]|【[^】\n]*】/g;
const HTML_ENTITY_RE = /&(?:#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi;
const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;
const URL_RE = /https?:\/\/[^\s<>()[\]"']+/gi;
const NEWLINE_RE = /\r\n|\r|\n/g;
const FENCE_LINE_RE = /^[ \t]*(?:`{3,}|~{3,})/;
const HEADING_LINE_RE = /^[ \t]*#{1,6}[ \t]+/;
const BULLET_LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

const r3 = (x) => Math.round(x * 1000) / 1000;
const countOf = (re, s) => (s.match(re) ?? []).length;

// Local copy of join.mjs tokenDice (see the header note above). Keep in sync.
function diceTokens(a, b) {
  const A = a.split(' ').filter(Boolean);
  const B = b.split(' ').filter(Boolean);
  if (!A.length || !B.length) return 0;
  const counts = new Map();
  for (const t of A) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of B) {
    const c = counts.get(t) ?? 0;
    if (c > 0) { common++; counts.set(t, c - 1); }
  }
  return (2 * common) / (A.length + B.length);
}

function diceBucket(d) {
  if (d === 0) return DICE_BUCKET_LABELS[0];
  if (d < 0.5) return DICE_BUCKET_LABELS[1];
  if (d < 0.8) return DICE_BUCKET_LABELS[2];
  if (d < NEAR_THRESHOLD) return DICE_BUCKET_LABELS[3];
  return DICE_BUCKET_LABELS[4];
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// Raw-text feature counts. Numbers only.
export function featureCounts(raw) {
  const s = String(raw ?? '');
  const lines = s.split(/\r\n|\r|\n/);
  const cps = Array.from(s);
  const nonAscii = cps.filter((c) => c.codePointAt(0) > 0x7f).length;
  return {
    privateUseChars: countOf(PRIVATE_USE_RE, s),
    zeroWidthChars: countOf(ZERO_WIDTH_RE, s),
    markdownLinks: countOf(MD_LINK_RE, s),
    markdownImages: countOf(MD_IMAGE_RE, s),
    citationMarkers: countOf(CITATION_RE, s),
    fenceLines: lines.filter((l) => FENCE_LINE_RE.test(l)).length,
    tableRows: lines.filter((l) => (l.match(/\|/g) ?? []).length >= 2).length,
    headingLines: lines.filter((l) => HEADING_LINE_RE.test(l)).length,
    bulletLines: lines.filter((l) => BULLET_LINE_RE.test(l)).length,
    htmlEntities: countOf(HTML_ENTITY_RE, s),
    htmlTags: countOf(HTML_TAG_RE, s),
    urls: countOf(URL_RE, s),
    nonAsciiRatio: cps.length ? r3(nonAscii / cps.length) : 0,
    newlineCount: countOf(NEWLINE_RE, s),
  };
}

// First matching rule wins (see the header). streamNorm/domNorm are normalized texts.
export function likelyCauseOf({ diagnosis, streamFeat, domFeat, streamNorm, domNorm, lengthRatio }) {
  if (diagnosis === 'exact_after_normalization' || diagnosis === 'no_candidate') return 'none_detected';
  const more = (k) => streamFeat[k] > domFeat[k];
  if (more('privateUseChars')) return 'private_use_markers_in_stream_only';
  if (more('citationMarkers')) return 'citation_markers_in_stream_only';
  if (MARKDOWN_FEATURES.some(more)) return 'markdown_syntax_in_stream_only';
  if (more('htmlEntities')) return 'entities_in_stream_only';
  if (more('zeroWidthChars')) return 'zero_width_in_stream_only';
  if (more('htmlTags')) return 'html_tags_in_stream_only';
  if (streamNorm !== '' && domNorm.length > streamNorm.length && domNorm.includes(streamNorm)) return 'dom_has_extra_ui_text';
  if (lengthRatio === null || lengthRatio < 0.9 || lengthRatio > 1.1) return 'length_ratio_far_from_1';
  return 'none_detected';
}

// One entry per assistant DOM turn. messages: buildStreamMessages output. turns: kv/DOM_TURNS.json.
export function diagnoseAssistantTurns(messages, turns) {
  const cands = [];
  (Array.isArray(messages) ? messages : []).forEach((m, messageIndex) => {
    if (normalizeRole(m?.role) !== 'assistant') return;
    const raw = String(m?.text ?? '');
    const norm = normalizeForJoin(raw);
    if (norm === '') return;
    cands.push({ messageIndex, raw, norm, final: m?.final === true });
  });
  const out = [];
  (Array.isArray(turns) ? turns : []).forEach((t, pos) => {
    if (normalizeRole(t?.role) !== 'assistant') return;
    const raw = String(t?.text ?? '');
    const norm = normalizeForJoin(raw);
    const turnIndex = Number.isInteger(t?.index) ? t.index : pos;
    const domChars = norm.length;
    const blocks = Array.isArray(t?.blocks) ? t.blocks.length : 0;
    const domFeat = featureCounts(raw);
    if (cands.length === 0) {
      out.push({
        turnIndex, domChars, blocks, bestMessage: null, runnerUpScore: null, messagesConsidered: 0,
        featureCounts: { stream: null, dom: domFeat }, diagnosis: 'no_candidate', likelyCause: null,
      });
      return;
    }
    let best = null, runner = null;
    for (const c of cands) {
      const dice = diceTokens(c.norm, norm);
      const s = { c, dice };
      if (!best || dice > best.dice) { runner = best; best = s; }
      else if (!runner || dice > runner.dice) runner = s;
    }
    const streamChars = best.c.norm.length;
    const lengthRatio = domChars > 0 ? r3(streamChars / domChars) : null;
    const streamFeat = featureCounts(best.c.raw);
    let diagnosis;
    if (best.c.norm === norm) diagnosis = 'exact_after_normalization';
    else if (norm !== '' && (best.c.norm.startsWith(norm) || norm.startsWith(best.c.norm))) diagnosis = 'prefix';
    else if (best.dice >= NEAR_THRESHOLD) diagnosis = 'near';
    else if (best.dice >= 0.5) diagnosis = 'similar';
    else diagnosis = 'different';
    out.push({
      turnIndex, domChars, blocks,
      bestMessage: {
        messageIndex: best.c.messageIndex,
        streamChars,
        diceScore: r3(best.dice),
        commonPrefixChars: commonPrefixLen(best.c.norm, norm),
        commonSuffixChars: commonSuffixLen(best.c.norm, norm),
        lengthRatio,
        streamFinal: best.c.final,
      },
      runnerUpScore: runner ? r3(runner.dice) : null,
      messagesConsidered: cands.length,
      featureCounts: { stream: streamFeat, dom: domFeat },
      diagnosis,
      likelyCause: likelyCauseOf({ diagnosis, streamFeat, domFeat, streamNorm: best.c.norm, domNorm: norm, lengthRatio }),
    });
  });
  return out;
}

function median(xs) {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return r3(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

// Aggregate over every session's turnDiagnostics (null entries are sessions without DOM turns).
export function aggregateDiagnostics(sessions) {
  const all = [];
  let sessionsDiagnosed = 0;
  for (const s of sessions) {
    if (!Array.isArray(s.turnDiagnostics)) continue;
    sessionsDiagnosed++;
    all.push(...s.turnDiagnostics);
  }
  const histogram = Object.fromEntries(DICE_BUCKET_LABELS.map((k) => [k, 0]));
  const byDiagnosis = Object.fromEntries(DIAGNOSES.map((k) => [k, 0]));
  const byLikelyCause = Object.fromEntries(LIKELY_CAUSES.map((k) => [k, 0]));
  const ratios = [];
  for (const d of all) {
    byDiagnosis[d.diagnosis]++;
    if (d.likelyCause !== null) byLikelyCause[d.likelyCause]++;
    if (d.bestMessage) {
      histogram[diceBucket(d.bestMessage.diceScore)]++;
      if (d.bestMessage.lengthRatio !== null) ratios.push(d.bestMessage.lengthRatio);
    }
  }
  return {
    sessionsDiagnosed,
    turnsDiagnosed: all.length,
    diceHistogram: histogram,
    exactAfterNormalization: byDiagnosis.exact_after_normalization,
    byDiagnosis,
    byLikelyCause,
    lengthRatio: {
      count: ratios.length,
      mean: ratios.length ? r3(ratios.reduce((a, b) => a + b, 0) / ratios.length) : null,
      median: median(ratios),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Per-session survey
// ---------------------------------------------------------------------------------------------
function bump(obj, key, n = 1) { obj[key] = (obj[key] ?? 0) + n; }

function addInto(total, counts) {
  if (!counts) return;
  for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
}

// Content-free label for an unmapped reason. no_rule_matched carries a describeView
// ("type=... event=... path=... o=..."); keep it only when every part is schema-shaped.
export function reasonLabel(reason) {
  const s = String(reason ?? 'unknown');
  const m = /^no_rule_matched: (.*)$/.exec(s);
  if (m) {
    const parts = m[1].split(' ');
    const ok = parts.every((p) => SAFE_VIEW_PART.test(p));
    return ok ? `no_rule_matched: ${m[1].slice(0, 120)}` : 'no_rule_matched: [redacted-shape]';
  }
  return SAFE_LABEL.test(s) ? s : 'other';
}

export function errorClassOf(e) {
  const code = e?.code;
  if (typeof code === 'string' && /^[A-Z_]{3,40}$|^E[A-Z]{2,30}$/.test(code)) return code;
  const name = e?.name;
  if (typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name)) return name;
  return 'Error';
}

function hostOf(meta) {
  try { return new URL(meta?.target?.url).hostname || null; } catch { return null; }
}

function readSessionMeta(dir) {
  const p = path.join(dir, 'session.json');
  if (!existsSync(p)) { const e = new Error('session.json missing'); e.code = 'SESSION_JSON_MISSING'; throw e; }
  const meta = JSON.parse(readFileSync(p, 'utf8'));
  if (!meta || typeof meta !== 'object') { const e = new Error('session.json not an object'); e.code = 'SESSION_JSON_INVALID'; throw e; }
  return meta;
}

// kv/DOM_TURNS.json, read directly (Session.open would create kv/). Missing -> no turns.
function readDomTurns(dir) {
  const p = path.join(dir, 'kv', 'DOM_TURNS.json');
  if (!existsSync(p)) return [];
  const v = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(v) ? v : [];
}

export async function surveySession(dir, id, { eventCap = EVENT_CAP, diagnose = false } = {}) {
  const meta = readSessionMeta(dir);
  const reducer = new StreamReducer({ deltaDialect: 'auto', keepEvents: true, maxEventsPerStream: eventCap });
  const firstSeqBySid = new Map();
  let rawRecords = 0, corruptRecords = 0, gapRecords = 0, bodyExcluded = 0, bodyTruncated = 0;
  for await (const rec of iterateRaw(path.join(dir, 'raw'), { useIndex: false })) {
    if (!rec || typeof rec !== 'object' || rec.k === 'corrupt') { corruptRecords++; continue; }
    rawRecords++;
    if (rec.k === 'gap') gapRecords++;
    else if (rec.k === 'body.excluded') bodyExcluded++;
    else if (rec.k === 'body.truncated') bodyTruncated++;
    if (rec.sid !== undefined && !firstSeqBySid.has(rec.sid)) firstSeqBySid.set(rec.sid, rec.seq);
    reducer.ingest(rec);
  }
  const summary = reducer.summary();
  const dialects = {}, framings = {}, dialectFailures = {}, unmappedReasons = {};
  const mapIds = new Set();
  const mapCandidates = {};
  let componentCount = 0, unmappedCount = 0, eventsOmitted = 0, messageIdObserved = 0;

  for (const st of summary.streams) {
    const s = reducer.streams.get(st.sid);
    const events = reducer.eventsOf(st.sid);
    bump(framings, st.transportDetail ?? 'unknown');
    for (const d of st.deltaDialects ?? []) bump(dialects, d);
    if ((st.deltaDialects ?? []).length === 0 && events.some((e) => e.json !== undefined)) bump(dialectFailures, 'no_dialect_detected');
    if ((st.deltaUnapplied ?? 0) > 0) bump(dialectFailures, 'deltas_unapplied');
    eventsOmitted += st.eventsOnlyOnDisk ?? 0;
    if (s?._delta?.messageId != null) messageIdObserved++;
    if (st.kind === 'ws' || events.length === 0) continue; // websocket streams are not stream-mapped (as in derive)
    const det = detectStreamMap(events);
    for (const c of det.candidates) if (c.matched > 0) bump(mapCandidates, c.id, c.matched);
    if (det.map) {
      const r = applyStreamMap(det.map, events);
      mapIds.add(det.map.id);
      componentCount += r.components.length;
      unmappedCount += r.unmapped.length;
      for (const u of r.unmapped) bump(unmappedReasons, reasonLabel(u.reason));
    } else {
      unmappedCount += events.length;
      bump(unmappedReasons, 'no_map_detected', events.length);
    }
  }

  const messages = buildStreamMessages(reducer, { firstSeqBySid });
  const assistantTextChars = messages.reduce((a, m) => a + (m.text?.length ?? 0), 0);
  const turns = readDomTurns(dir);
  let joinStatusCounts = null, blockLinkStatusCounts = null;
  if (turns.length > 0) {
    const { summary: js } = joinStreamToDom({ messages, turns });
    joinStatusCounts = { ...js.messageStatus };
    blockLinkStatusCounts = { ...js.blockStatus };
  }
  const mapIdList = [...mapIds];
  const result = {
    id,
    siteHost: hostOf(meta),
    status: 'ok',
    rawRecords,
    complete: gapRecords === 0 && bodyExcluded === 0 && bodyTruncated === 0,
    corruptRecords,
    streams: summary.streams.length,
    dialects,
    framings,
    mapId: mapIdList.length === 1 ? mapIdList[0] : null,
    mapCandidateIds: Object.keys(mapCandidates).sort(),
    componentCount,
    unmappedCount,
    unmappedReasons,
    dialectFailures,
    messageIdObserved,
    domTurns: turns.length,
    joinStatusCounts,
    blockLinkStatusCounts,
    assistantTextChars,
    eventsOmitted,
  };
  if (diagnose) {
    // Only with --diagnose. null when the session has no DOM turns.
    result.turnDiagnostics = turns.length > 0 ? diagnoseAssistantTurns(messages, turns) : null;
  }
  return result;
}

function errorEntry(id, e) {
  return { id, siteHost: null, status: 'error', errorClass: errorClassOf(e) };
}

// ---------------------------------------------------------------------------------------------
// Aggregation and report
// ---------------------------------------------------------------------------------------------
function rank(obj, limit = RANK_LIMIT) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

export function aggregate(sessions, { diagnose = false } = {}) {
  const ok = sessions.filter((s) => s.status === 'ok');
  const sessionsByMapId = {}, dialectCounts = {}, framingCounts = {}, unmapped = {}, failures = {};
  const errorClasses = {};
  let joinStatusTotals = null, blockLinkStatusTotals = null, sessionsWithDomTurns = 0, eventsOmittedTotal = 0;
  for (const s of sessions) if (s.status === 'error') bump(errorClasses, s.errorClass);
  for (const s of ok) {
    bump(sessionsByMapId, s.mapId ?? 'null');
    addInto(dialectCounts, s.dialects);
    addInto(framingCounts, s.framings);
    addInto(unmapped, s.unmappedReasons);
    addInto(failures, s.dialectFailures);
    eventsOmittedTotal += s.eventsOmitted;
    if (s.joinStatusCounts) {
      sessionsWithDomTurns++;
      joinStatusTotals = joinStatusTotals ?? {};
      addInto(joinStatusTotals, s.joinStatusCounts);
      blockLinkStatusTotals = blockLinkStatusTotals ?? {};
      addInto(blockLinkStatusTotals, s.blockLinkStatusCounts);
    }
  }
  const out = {
    sessionsTotal: sessions.length,
    sessionsOk: ok.length,
    sessionsError: sessions.length - ok.length,
    errorClasses,
    sessionsComplete: ok.filter((s) => s.complete).length,
    sessionsByMapId,
    dialectCounts,
    framingCounts,
    sessionsWithDomTurns,
    joinStatusTotals,
    blockLinkStatusTotals,
    eventsOmittedTotal,
    topUnmappedReasons: rank(unmapped),
    topDialectFailures: rank(failures),
  };
  if (diagnose) out.diagnostics = aggregateDiagnostics(ok);
  return out;
}

// Scans the session folders named by targets, then re-scans them. Returns the report, or the list
// of changes when anything in the touched folders changed (then no report is produced).
export async function runSurvey({
  dataDir = defaultDataDir(), session = null, all = false, limit = null, out = null,
  eventCap = EVENT_CAP, diagnose = false, _testHookAfterRead = null,
} = {}) {
  const root = path.resolve(dataDir);
  if ((session === null) === (all === false)) throw new UsageError('choose exactly one of --session ID or --all');
  if (session !== null && !SESSION_ID_RE.test(session)) throw new UsageError('invalid session id');
  if (limit !== null && !all) throw new UsageError('--limit applies to --all');
  if (out !== null && isInside(canon(out), canon(root))) throw new UsageError('refusing --out inside the data directory');
  assertNotRepoCheckout(root);
  if (!existsSync(root)) throw new GuardError('data directory does not exist (the survey never creates it)');
  const sessionsDir = dataPaths(root).sessions;
  let targets;
  if (all) {
    const ids = existsSync(sessionsDir)
      ? readdirSync(sessionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(path.join(sessionsDir, e.name, 'session.json')))
        .map((e) => e.name).sort().reverse()
      : [];
    targets = (limit ? ids.slice(0, limit) : ids).map((id) => ({ id, dir: path.join(sessionsDir, id) }));
  } else {
    const dir = path.join(sessionsDir, session);
    if (!existsSync(dir)) throw new GuardError(`no session folder "${session}"`);
    targets = [{ id: session, dir }];
  }
  const before = snapshotSessionDirs(targets);
  const sessions = [];
  for (const t of targets) {
    try { sessions.push(await surveySession(t.dir, t.id, { eventCap, diagnose })); }
    catch (e) { sessions.push(errorEntry(t.id, e)); }
  }
  if (_testHookAfterRead) _testHookAfterRead(root);
  const after = snapshotSessionDirs(targets);
  const writes = diffSnapshots(before, after);
  if (writes.length) return { writeDetected: writes, report: null };
  const report = {
    schema: SURVEY_SCHEMA,
    generatedAt: new Date().toISOString(),
    selection: { mode: all ? 'all' : 'session', limit: limit ?? null, sessionCount: sessions.length },
    safety: { readOnly: true, sessionFoldersSnapshotted: targets.length, filesSnapshotted: before.size, writeDetected: false },
    aggregate: aggregate(sessions, { diagnose }),
    sessions,
  };
  return { writeDetected: [], report };
}

function renderTable(report) {
  const head = ['ID', 'HOST', 'RAW', 'COMPLETE', 'STREAMS', 'MAP', 'COMP', 'UNMAP', 'JOIN v/p/a', 'STATUS'];
  const rows = [head];
  for (const s of report.sessions) {
    if (s.status !== 'ok') { rows.push([s.id, '-', '-', '-', '-', '-', '-', '-', '-', `error:${s.errorClass}`]); continue; }
    const j = s.joinStatusCounts;
    rows.push([
      s.id, s.siteHost ?? '-', String(s.rawRecords), s.complete ? 'yes' : 'no', String(s.streams),
      s.mapId ?? '-', String(s.componentCount), String(s.unmappedCount),
      j ? `${j.verified ?? 0}/${j.partial ?? 0}/${j.ambiguous ?? 0}` : '-', 'ok',
    ]);
  }
  const widths = head.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
  const a = report.aggregate;
  lines.push('');
  lines.push(`sessions: ${a.sessionsTotal} (ok ${a.sessionsOk}, error ${a.sessionsError}, complete ${a.sessionsComplete}); events omitted: ${a.eventsOmittedTotal}`);
  lines.push(`maps: ${Object.entries(a.sessionsByMapId).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
  lines.push(`top unmapped: ${a.topUnmappedReasons.slice(0, 5).map((r) => `${r.label} (${r.count})`).join('; ') || '-'}`);
  lines.push(`top dialect failures: ${a.topDialectFailures.slice(0, 5).map((r) => `${r.label} (${r.count})`).join('; ') || '-'}`);
  if (a.diagnostics) {
    const d = a.diagnostics;
    lines.push(`diagnostics: ${d.turnsDiagnosed} assistant turns; ${Object.entries(d.byDiagnosis).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    lines.push(`top likely causes: ${Object.entries(d.byLikelyCause).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} (${v})`).join('; ') || '-'}`);
  }
  return lines.join('\n') + '\n';
}

export function parseArgs(argv) {
  const o = { dataDir: null, session: null, all: false, limit: null, out: null, json: false, diagnose: false, help: false };
  const need = (flag, v) => {
    if (v === undefined || v === '') throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    if (a.startsWith('--') && a.includes('=')) { inline = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (a) {
      case '--data-dir': o.dataDir = need(a, val()); break;
      case '--session': o.session = need(a, val()); break;
      case '--all': o.all = true; break;
      case '--limit': {
        const n = Number(need(a, val()));
        if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit expects a positive integer');
        o.limit = n;
        break;
      }
      case '--out': o.out = need(a, val()); break;
      case '--json': o.json = true; break;
      case '--diagnose': o.diagnose = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new UsageError(`unknown argument ${a}`);
    }
  }
  return o;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { stderr.write(`${e.message}\n${USAGE}`); return EXIT_USAGE; }
  if (args.help) { stdout.write(USAGE); return EXIT_OK; }
  let result;
  try {
    result = await runSurvey({
      dataDir: args.dataDir ? path.resolve(args.dataDir) : defaultDataDir(),
      session: args.session, all: args.all, limit: args.limit, out: args.out, diagnose: args.diagnose,
    });
  } catch (e) {
    if (e instanceof UsageError) { stderr.write(`fidelity-survey: ${e.message}\n${USAGE}`); return EXIT_USAGE; }
    stderr.write(`fidelity-survey: ${e.message}\n`);
    return EXIT_ERROR;
  }
  if (result.writeDetected.length) {
    for (const w of result.writeDetected) stderr.write(`WRITE DETECTED ${w.path} (${w.change})\n`);
    stderr.write('fidelity-survey: the touched session folders changed during the run; no report produced\n');
    return EXIT_WRITE;
  }
  const json = `${JSON.stringify(result.report, null, 2)}\n`;
  if (args.out) {
    try { writeFileSync(args.out, json); }
    catch (e) { stderr.write(`fidelity-survey: cannot write --out (${errorClassOf(e)})\n`); return EXIT_ERROR; }
  }
  if (args.json) stdout.write(json);
  else stderr.write(renderTable(result.report));
  return EXIT_OK;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
