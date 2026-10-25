// Offline acceptance label for one saved capture session (DESIGN-live-drive-studio.md section 5,
// the clean-data gate G1-G7). This is a label, not a gate: nothing in the product blocks on it.
//
//   Offline gates, computed from the saved session alone:  G4 G5 G6 G7
//   Context gates, need the optional `conversation` input:  G1 G2 G3 (not-checked without it)
//
// Verdicts (exact names; "accepted"/"rejected" are reserved by the exchange vocabulary):
//   capture_accepted   all seven gates passed
//   capture_rejected   any gate failed
//   capture_incomplete no gate failed, at least one unknown or not-checked
//   unassessed         binding mismatch, unreadable evidence, unknown recipe, or legacy (no file)
//
// Binding: rawDigest = sha256 over the canonical list of raw/manifest.json and every raw segment
// file (name, bytes, sha256), using the same sha256Hex/canonicalJson primitives as store/integrity.mjs
// and the same per-segment sha256 that raw/manifest.json records. Derived index files are excluded
// because they are rebuildable. Any byte change to raw evidence changes the digest.
// DOM_TURNS is also bound by canonical SHA-256, because G1/G2/G7 inspect rendered
// evidence and rawDigest alone does not detect an edited KV DOM projection.
//
// Only writeAcceptance writes, and only <session>/acceptance.json (temp file + fsync + rename).
// Raw logs and session.json are read, never modified.
import { existsSync, readFileSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256Hex, canonicalJson } from '../store/integrity.mjs';
import { reconcileFinal } from '../intel/correlate.mjs';
import { streamText } from '../replay/derive.mjs';

export const ACCEPTANCE_SCHEMA = 'capture-studio.acceptance/1';
// 1.1.0: G1/G2 gained pre-send baseline freshness. A text match without a baseline is now
// 'unknown' (capture_incomplete), never 'passed', so prior accepted documents are not reused
// across the semantic change (reuseAcceptedContext refuses version mismatches).
export const EVALUATOR_VERSION = '1.1.0';
export const DEFAULT_RECIPE = Object.freeze({ id: 'clean-data-gate', version: 1 });
export const GATE_IDS = Object.freeze(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
export const VERDICTS = Object.freeze(['capture_accepted', 'capture_rejected', 'capture_incomplete', 'unassessed']);
const GATE_VALUES = new Set(['passed', 'failed', 'not-checked', 'unknown']);
const ACCEPTANCE_FILE = 'acceptance.json';
const RAW_SEGMENT = /^\d{6}\.jsonl$/;

const gate = (value, reason, evidence = {}) => ({ value, reason, evidence });
const notChecked = (reason, evidence) => gate('not-checked', reason, evidence);
const unknown = (reason, evidence) => gate('unknown', reason, evidence);

const isKnownRecipe = (recipe) => !!recipe && recipe.id === DEFAULT_RECIPE.id && recipe.version === DEFAULT_RECIPE.version;

// ---- binding -------------------------------------------------------------------------------------

// Throws if the raw directory is missing or unreadable. Reads only.
export function domDigest(session) {
  return sha256Hex(canonicalJson(session.kv.get('DOM_TURNS', null)));
}

export function rawDigest(session) {
  const rawDir = session.rawDir;
  if (!existsSync(rawDir)) throw new Error('raw directory missing');
  const names = readdirSync(rawDir).filter((f) => RAW_SEGMENT.test(f) || f === 'manifest.json').sort();
  const files = names.map((file) => {
    const buf = readFileSync(path.join(rawDir, file));
    return { file, bytes: buf.length, sha256: sha256Hex(buf) };
  });
  return { digest: sha256Hex(canonicalJson(files)), files: files.length };
}

// ---- evidence scans --------------------------------------------------------------------------------

// One pass over raw records: seq range, gap/body counters, per-stream terminal records.
async function scanRaw(session) {
  const out = { records: 0, firstSeq: null, lastSeq: null, gapRecords: 0, bodyExcluded: 0, bodyTruncated: 0, corrupt: 0, streams: new Map() };
  const stream = (sid) => { let e = out.streams.get(sid); if (!e) out.streams.set(sid, (e = { done: false, fail: false })); return e; };
  for await (const r of session.records()) {
    out.records++;
    if (typeof r.seq === 'number') { out.firstSeq ??= r.seq; out.lastSeq = r.seqTo ?? r.seq; }
    if (r.k === 'corrupt') out.corrupt++;
    else if (r.k === 'gap') out.gapRecords++;
    else if (r.k === 'body.excluded') out.bodyExcluded++;
    else if (r.k === 'body.truncated') out.bodyTruncated++;
    else if (r.k === 'done' && r.sid) stream(r.sid).done = true;
    else if (r.k === 'fail' && r.sid) stream(r.sid).fail = true;
  }
  return out;
}

// The L2 reply: assembled text of the derived stream(s). Picks the longest non-empty assembled text.
async function replyText(session) {
  const assembled = session.kv.get('ASSEMBLED', null);
  const sids = assembled && typeof assembled === 'object' ? Object.keys(assembled) : [];
  let best = null;
  const errors = [];
  for (const sid of sids) {
    try {
      const t = await streamText(session, sid, { useLocator: false });
      const text = typeof t.assembledText === 'string' ? t.assembledText : '';
      // Streams that were actually patched (more than one revision) outrank single-shot JSON
      // documents (tokens, model lists), which can be far longer than the reply and are not it.
      const streamed = (assembled[sid]?.revisions ?? 0) > 1;
      if (text.length && (!best || (streamed && !best.streamed) || (streamed === best.streamed && text.length > best.text.length))) best = { sid, text, streamed };
    } catch (e) {
      errors.push({ sid, error: String(e?.message ?? e) });
    }
  }
  return { best, considered: sids.length, errors };
}

// ---- helpers for context gates ---------------------------------------------------------------------

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const tokens = (s) => String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const turnsOf = (dom, role) => (Array.isArray(dom) ? dom : []).filter((t) => t && t.role === role && typeof t.text === 'string');
// The pre-send freshness cursor: counts of user/assistant turns rendered in the SAME full-DOM
// scan the DOM_TURNS projection uses, sampled before the send. The drive supplies it from the
// page-agent store before typing (creation paths measure an empty page: 0/0).
const isBaseline = (b) => !!b && typeof b === 'object'
  && Number.isSafeInteger(b.userTurns) && b.userTurns >= 0
  && Number.isSafeInteger(b.assistantTurns) && b.assistantTurns >= 0;

// ---- gates -----------------------------------------------------------------------------------------

// G1: the sent prompt is a NEW user turn rendered after the pre-send baseline. With a baseline,
// the first user turn after it must exist (growth) and equal the prompt — a historical transcript
// that merely re-rendered cannot pass. Without a baseline a text match alone proves nothing about
// freshness (Core #68): matched text is 'unknown', so the verdict is capture_incomplete, never
// accepted; a mismatch is still a definite failure.
function gateG1(conv, dom) {
  if (!conv) return notChecked('no conversation context supplied');
  if (typeof conv.prompt !== 'string') return unknown('conversation.prompt missing');
  const users = turnsOf(dom, 'user');
  if (!users.length) return unknown('no user turn captured in DOM_TURNS');
  const baseline = conv.baseline;
  if (baseline !== undefined && baseline !== null) {
    if (!isBaseline(baseline)) return unknown('conversation.baseline is malformed; freshness cannot be judged', { userTurns: users.length });
    if (users.length <= baseline.userTurns) {
      return gate('failed', 'no user turn rendered after the pre-send baseline',
        { userTurns: users.length, baselineUserTurns: baseline.userTurns, freshness: 'pre-send baseline enforced' });
    }
    const matched = norm(users[baseline.userTurns].text) === norm(conv.prompt);
    return gate(matched ? 'passed' : 'failed',
      matched ? 'the first user turn after the pre-send baseline equals the sent prompt'
        : 'the first user turn after the pre-send baseline differs from the sent prompt',
      { userTurns: users.length, baselineUserTurns: baseline.userTurns, matched, freshness: 'pre-send baseline enforced' });
  }
  const matched = norm(users.at(-1).text) === norm(conv.prompt);
  return gate(matched ? 'unknown' : 'failed',
    matched ? 'newest user turn equals the sent prompt, but no pre-send baseline was supplied, so freshness is unproven'
      : 'newest user turn differs from the sent prompt',
    { userTurns: users.length, matched, freshness: 'unproven (no baseline supplied)' });
}

// G2: the expected reply words appear in order in the FIRST assistant turn rendered after the
// pre-send baseline. With a baseline this performs the historical "count grew after send" check
// (Core #68): no growth is a definite failure, and the matched turn is the new one, not merely
// the newest. Without a baseline a match alone is 'unknown' (capture_incomplete, never accepted).
function gateG2(conv, dom) {
  if (!conv) return notChecked('no conversation context supplied');
  if (!Array.isArray(conv.expectedReplyWords)) return notChecked('no expectedReplyWords supplied (calibration-only check)');
  const replies = turnsOf(dom, 'assistant');
  if (!replies.length) return unknown('no assistant turn captured in DOM_TURNS');
  const words = conv.expectedReplyWords.flatMap((w) => tokens(w));
  const baseline = conv.baseline;
  if (baseline !== undefined && baseline !== null) {
    if (!isBaseline(baseline)) return unknown('conversation.baseline is malformed; freshness cannot be judged', { assistantTurns: replies.length });
    if (replies.length <= baseline.assistantTurns) {
      return gate('failed', 'no assistant turn rendered after the pre-send baseline',
        { assistantTurns: replies.length, baselineAssistantTurns: baseline.assistantTurns, expectedWords: words.length, freshness: 'pre-send baseline enforced' });
    }
    const seen = tokens(replies[baseline.assistantTurns].text);
    let i = 0;
    for (const t of seen) if (i < words.length && t === words[i]) i++;
    const ok = i === words.length;
    return gate(ok ? 'passed' : 'failed',
      ok ? 'expected reply words appear in order in the first assistant turn after the pre-send baseline'
        : 'expected reply words not found in order in the first assistant turn after the pre-send baseline',
      { assistantTurns: replies.length, baselineAssistantTurns: baseline.assistantTurns, expectedWords: words.length, matchedInOrder: i, freshness: 'pre-send baseline enforced' });
  }
  const seen = tokens(replies.at(-1).text);
  let i = 0;
  for (const t of seen) if (i < words.length && t === words[i]) i++;
  const ok = i === words.length;
  return gate(ok ? 'unknown' : 'failed',
    ok ? 'expected reply words appear in order in the newest assistant turn, but no pre-send baseline was supplied, so freshness is unproven'
      : 'expected reply words not found in order in the newest assistant turn',
    { expectedWords: words.length, matchedInOrder: i, freshness: 'unproven (no baseline supplied)' });
}

// G3: completion. The caller attests drive-time stability (stableObserved, from waitForCompletion);
// the saved raw log supplies the terminal record. Neither alone is enough, and a missing flag is never a pass.
function gateG3(conv, reply, scan) {
  if (!conv) return notChecked('no conversation context supplied');
  const rule = conv.completionRule;
  if (!rule || typeof rule !== 'object') return unknown('no completionRule supplied; completion cannot be judged');
  if (typeof rule.stableObserved !== 'boolean') return unknown('completionRule.stableObserved is not a boolean; drive-time stability unknown');
  if (rule.stableObserved === false) return gate('failed', 'reply was not observed stable at drive time', { stableObserved: false });
  if (rule.requireDone === false) return gate('passed', 'drive-time stability observed; terminal record not required by rule', { requireDone: false });
  if (!reply.best) return unknown('no reply stream to check for a terminal record');
  const s = scan.streams.get(reply.best.sid) ?? { done: false, fail: false };
  const evidence = { sid: reply.best.sid, done: s.done, fail: s.fail };
  if (s.done) return gate('passed', 'drive-time stability observed and reply stream has a done record', evidence);
  if (s.fail) return gate('failed', 'reply stream ended with a fail record', evidence);
  return unknown('reply stream has no done or fail record', evidence);
}

// G4: recorder stopped and session status is exactly complete.
function gateG4(session) {
  const status = session.meta?.status;
  if (status === undefined || status === null) return unknown('session.json has no status');
  if (status === 'complete') return gate('passed', 'session status is complete', { status });
  return gate('failed', `session status is ${status}, not complete`, { status });
}

// G5: verify passes with no gaps, no dropped records, no body.excluded and no body.truncated.
function gateG5(v, scan) {
  const why = [];
  if (!v.ok) why.push('verify reports not ok');
  if (v.unexplainedSeqGaps) why.push(`${v.unexplainedSeqGaps} unexplained seq gap(s)`);
  if (v.gapRecords) why.push(`${v.gapRecords} gap record(s)`);
  if (v.droppedRecords) why.push(`${v.droppedRecords} dropped record(s)`);
  if (scan.bodyExcluded) why.push(`${scan.bodyExcluded} body.excluded`);
  if (scan.bodyTruncated) why.push(`${scan.bodyTruncated} body.truncated`);
  const evidence = {
    verifyOk: v.ok, records: v.records, gapRecords: v.gapRecords, droppedRecords: v.droppedRecords,
    unexplainedSeqGaps: v.unexplainedSeqGaps, bodyExcluded: scan.bodyExcluded, bodyTruncated: scan.bodyTruncated,
  };
  if (why.length) return gate('failed', why.join('; '), evidence);
  return gate('passed', 'verify ok; no gaps, no dropped records, no body.excluded or body.truncated', evidence);
}

// G6: derive completed. Zero entities is a valid complete result when the entities dataset is absent.
function gateG6(session) {
  const ks = session.kv.get('KNOWLEDGE_STATUS', null);
  if (!ks) return notChecked('derive has not written KNOWLEDGE_STATUS');
  if (ks.status === 'failed') return gate('failed', `derive failed at stage ${ks.stage ?? '?'}`, { status: ks.status });
  if (ks.status !== 'complete') return unknown(`derive status is ${ks.status ?? 'missing'}; not finished`, { status: ks.status ?? null });
  const datasetPresent = session.dataset('entities').exists();
  const evidence = { status: ks.status, entityCount: ks.entityCount ?? null, entitiesDatasetPresent: datasetPresent };
  if (typeof ks.entityCount !== 'number') return unknown('KNOWLEDGE_STATUS has no entityCount', evidence);
  if (ks.entityCount > 0) {
    return datasetPresent
      ? gate('passed', 'derive complete; entity dataset present', evidence)
      : gate('failed', 'derive complete with entities but entity dataset is missing', evidence);
  }
  return datasetPresent
    ? gate('failed', 'derive reports 0 entities but an entity dataset exists (stale)', evidence)
    : gate('passed', 'derive complete with explicit 0 entities', evidence);
}

// G7: assembled L2 reply text reconciles with the newest DOM assistant turn (reconcileFinal).
// reconcileFinal status: consistent -> passed; partially_rendered or diverges -> failed;
// insufficient_evidence -> unknown. Both containment directions are recorded in evidence.
function gateG7(reply, dom) {
  const replies = turnsOf(dom, 'assistant');
  if (!replies.length) return notChecked('no DOM assistant turns captured; reconciliation not attempted');
  if (!reply.best) return unknown('no assembled reply text from derived streams', { considered: reply.considered, errors: reply.errors.length });
  const r = reconcileFinal(reply.best.text, replies.at(-1).text);
  const value = r.status === 'consistent' ? 'passed' : r.status === 'insufficient_evidence' ? 'unknown' : 'failed';
  return gate(value, `reconcileFinal status ${r.status}`, {
    sid: reply.best.sid, status: r.status, agreement: r.agreement, payloadInUi: r.payloadInUi, uiInPayload: r.uiInPayload,
    payloadChars: reply.best.text.length, uiChars: replies.at(-1).text.length,
  });
}

// ---- verdict ---------------------------------------------------------------------------------------

function deriveVerdict(gates) {
  const values = GATE_IDS.map((id) => gates?.[id]?.value);
  if (values.includes('failed')) return 'capture_rejected';
  if (values.every((v) => v === 'passed')) return 'capture_accepted';
  return 'capture_incomplete';
}

function unassessedGates(reason) {
  return Object.fromEntries(GATE_IDS.map((id) => [id, unknown(`not evaluated: ${reason}`)]));
}

function unassessedDoc({ evaluatedAt, binding, reasons }) {
  const why = reasons.join('; ');
  return {
    schema: ACCEPTANCE_SCHEMA, evaluator: { version: EVALUATOR_VERSION }, evaluatedAt, binding,
    gates: unassessedGates(why), verdict: 'unassessed', reasons,
  };
}

// ---- public API ------------------------------------------------------------------------------------

/**
 * @param {{session: object, conversation?: {prompt: string, expectedReplyWords?: string[], completionRule?: {requireDone?: boolean, stableObserved: boolean}, baseline?: {userTurns: number, assistantTurns: number, sampledAt?: string}|null}|null, recipe?: object}} input
 *   conversation.completionRule.stableObserved is attested by the live driver (waitForCompletion);
 *   it is context, not something the saved session can prove.
 *   conversation.baseline is the pre-send freshness cursor: user/assistant turn counts sampled by
 *   the SAME full-DOM scan that later produces DOM_TURNS, before the send. With a baseline, G1/G2
 *   enforce post-send growth and match the FIRST new turn; without one, a text match alone stays
 *   'unknown' so the verdict can never be capture_accepted on historical text (Core #68).
 * @returns {Promise<object>} acceptance document (not written)
 */
export async function evaluateAcceptance({ session, conversation = null, recipe = DEFAULT_RECIPE } = {}) {
  if (!session) throw new TypeError('evaluateAcceptance: session is required');
  if (conversation !== null && typeof conversation !== 'object') throw new TypeError('evaluateAcceptance: conversation must be an object or null');
  const evaluatedAt = new Date().toISOString();
  const recipeBinding = { id: recipe?.id ?? null, version: recipe?.version ?? null };
  const emptyBinding = { rawDigest: null, seqRange: [null, null], recipe: recipeBinding };
  if (!isKnownRecipe(recipe)) {
    return unassessedDoc({ evaluatedAt, binding: emptyBinding, reasons: [`recipe ${recipeBinding.id}@${recipeBinding.version} is not a known recipe`] });
  }

  let before, domBefore;
  try { before = rawDigest(session); domBefore = domDigest(session); } catch (e) {
    return unassessedDoc({ evaluatedAt, binding: emptyBinding, reasons: [`raw evidence unreadable: ${e.message}`] });
  }
  let scan, verify, reply;
  try {
    scan = await scanRaw(session);
    verify = await session.verify();
    reply = await replyText(session);
  } catch (e) {
    return unassessedDoc({ evaluatedAt, binding: { ...emptyBinding, rawDigest: before.digest }, reasons: [`raw evidence unreadable during evaluation: ${e.message}`] });
  }
  let after, domAfter;
  try { after = rawDigest(session); domAfter = domDigest(session); } catch (e) {
    return unassessedDoc({ evaluatedAt, binding: { ...emptyBinding, rawDigest: before.digest }, reasons: [`raw evidence unreadable after evaluation: ${e.message}`] });
  }
  if (after.digest !== before.digest || domAfter !== domBefore) {
    return unassessedDoc({ evaluatedAt, binding: { ...emptyBinding, rawDigest: before.digest },
      reasons: ['raw or DOM_TURNS changed during evaluation; binding mismatch'] });
  }

  const dom = session.kv.get('DOM_TURNS', null);
  const gates = {
    G1: gateG1(conversation, dom),
    G2: gateG2(conversation, dom),
    G3: gateG3(conversation, reply, scan),
    G4: gateG4(session),
    G5: gateG5(verify, scan),
    G6: gateG6(session),
    G7: gateG7(reply, dom),
  };
  const verdict = deriveVerdict(gates);
  const reasons = GATE_IDS.filter((id) => gates[id].value !== 'passed').map((id) => `${id} ${gates[id].value}: ${gates[id].reason}`);
  return {
    schema: ACCEPTANCE_SCHEMA, evaluator: { version: EVALUATOR_VERSION }, evaluatedAt,
    binding: { rawDigest: before.digest, domDigest: domBefore,
      seqRange: [scan.firstSeq, scan.lastSeq], recipe: recipeBinding },
    gates, verdict, reasons,
  };
}

function acceptancePath(session) {
  return path.join(session.dir, ACCEPTANCE_FILE);
}

function assertWritable(doc) {
  if (!doc || doc.schema !== ACCEPTANCE_SCHEMA) throw new TypeError(`writeAcceptance: schema must be ${ACCEPTANCE_SCHEMA}`);
  if (!VERDICTS.includes(doc.verdict)) throw new TypeError(`writeAcceptance: unknown verdict ${doc.verdict}`);
  if (doc.verdict === 'unassessed') return;
  if (!GATE_IDS.every((id) => GATE_VALUES.has(doc.gates?.[id]?.value))) throw new TypeError('writeAcceptance: every gate needs a valid value');
  if (deriveVerdict(doc.gates) !== doc.verdict) throw new TypeError(`writeAcceptance: verdict ${doc.verdict} does not follow from the gates`);
}

/** Atomically writes <session>/acceptance.json. The only write this module performs. */
export function writeAcceptance(session, doc) {
  assertWritable(doc);
  const p = acceptancePath(session);
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try { renameSync(tmp, p); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  return p;
}

/**
 * Returns the stored document only if its binding still matches the session. Fails closed: any
 * mismatch, unreadable evidence, unknown recipe, or internal inconsistency returns verdict unassessed.
 */
export function readAcceptance(session, { recipe = DEFAULT_RECIPE } = {}) {
  const unassessed = (reason, extra = {}) => ({
    schema: ACCEPTANCE_SCHEMA, evaluator: { version: EVALUATOR_VERSION }, evaluatedAt: null,
    binding: null, gates: null, verdict: 'unassessed', reasons: [reason], ...extra,
  });
  if (!isKnownRecipe(recipe)) return unassessed(`recipe ${recipe?.id}@${recipe?.version} is not a known recipe`);
  const p = acceptancePath(session);
  if (!existsSync(p)) return unassessed('no acceptance.json: legacy or never evaluated (unassessed, not rejected)');
  let stored;
  try { stored = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return unassessed(`acceptance.json unreadable: ${e.message}`); }
  if (!stored || stored.schema !== ACCEPTANCE_SCHEMA) return unassessed('acceptance.json has an unsupported schema');
  const sb = stored.binding ?? null;
  if (!sb || sb.recipe?.id !== recipe.id || sb.recipe?.version !== recipe.version) {
    return unassessed(`recipe mismatch: stored ${sb?.recipe?.id}@${sb?.recipe?.version}, current ${recipe.id}@${recipe.version}`);
  }
  if (stored.verdict === 'unassessed') return stored;
  if (!VERDICTS.includes(stored.verdict) || deriveVerdict(stored.gates) !== stored.verdict) {
    return unassessed('stored verdict does not follow from stored gates');
  }
  let current;
  try { current = rawDigest(session); } catch (e) { return unassessed(`raw evidence unreadable: ${e.message}`); }
  if (current.digest !== sb.rawDigest) return unassessed('raw digest changed since evaluation; re-evaluate');
  if (typeof sb.domDigest !== 'string') return unassessed('legacy acceptance has no DOM_TURNS binding; re-evaluate');
  let domNow;
  try { domNow = domDigest(session); }
  catch (e) { return unassessed(`DOM_TURNS unreadable: ${e.message}`); }
  if (domNow !== sb.domDigest) return unassessed('DOM_TURNS changed since evaluation; re-evaluate');
  return stored;
}

// Re-derivation cannot recover the original drive-time completion attestation
// from raw alone. Reuse G1–G3 only from a previously accepted and revalidated
// document with the SAME raw + rendered evidence and recipe. Re-evaluate G4–G7
// from current derive output; this never upgrades an unassessed source.
export function reuseAcceptedContext(previous, current) {
  if (previous?.verdict !== 'capture_accepted' || current?.verdict === 'unassessed'
    || previous.schema !== ACCEPTANCE_SCHEMA || current.schema !== ACCEPTANCE_SCHEMA
    || previous.binding?.rawDigest !== current.binding?.rawDigest
    || previous.binding?.domDigest !== current.binding?.domDigest
    || previous.binding?.recipe?.id !== current.binding?.recipe?.id
    || previous.binding?.recipe?.version !== current.binding?.recipe?.version
    || previous.evaluator?.version !== current.evaluator?.version
    || !['G1', 'G2', 'G3'].every((id) => previous.gates?.[id]?.value === 'passed')) {
    return current;
  }
  const gates = { ...current.gates, G1: previous.gates.G1,
    G2: previous.gates.G2, G3: previous.gates.G3 };
  const verdict = deriveVerdict(gates);
  const reasons = GATE_IDS.filter((id) => gates[id].value !== 'passed')
    .map((id) => `${id} ${gates[id].value}: ${gates[id].reason}`);
  return { ...current, gates, verdict, reasons,
    contextualEvidence: { kind: 'revalidated-prior-acceptance',
      previousEvaluatedAt: previous.evaluatedAt ?? null } };
}
