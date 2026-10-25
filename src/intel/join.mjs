// Verified stream-to-DOM join: ties each parsed stream message (and its blocks) to the rendered
// DOM turn (and block) it produced. Deterministic, honest: an unmatched element stays unlinked and
// a tie stays ambiguous. Pure functions on plain objects; no I/O; no imports from capture code.
//
// INPUT
//   messages: [{ key, messageId, role, text, final: bool, blocks: [{ key, index, type, text }] }]
//     stream order. key: `${messageId}:${index}`-style string, or null (then joined by text only).
//     blocks[].index: stream block index. type: optional stream block type (paragraph, heading,
//     list, quote, code, ...); when absent, the type check is skipped.
//   turns: [{ index, id, domId, role, text, blocks: [{ ord, type, text }] }]
//     document order. blocks[].ord: 0-based ordinal among sibling blocks in document order.
//
// OUTPUT
//   { links, summary }
//   link = { messageKey, messageIndex, messageId, role, turnIndex, turnId, domId, status,
//            textMatch, blockLinks, evidence }
//   status (message and block level):
//     verified        aligned (order or unique text) AND normalized text equal (final stream)
//     partial         stream text is a strict prefix of rendered text (stream not final, or render
//                     ahead); also an exact match of a stream message still marked not final
//     near_match      aligned or uniquely found, texts NOT equal after normalization, but token
//                     Dice >= NEAR_THRESHOLD. Never verified; never justifies block links; the score
//                     is in evidence.notes. Positional pass: the aligned turn is near. Text-only pass:
//                     exactly one free turn is >= NEAR_THRESHOLD and every other free turn is < 0.8.
//     ambiguous       more than one candidate fits and order/ordinal does not decide; no link
//     text_mismatch   aligned by order but text differs (or render is behind stream); no text
//                     with nothing to verify (both empty) also lands here
//     unlinked_stream a stream element with no candidate
//     unlinked_dom    a DOM element no stream element claimed
//   textMatch: exact | prefix | near | differs | none
//   evidence.rule: order+text (position + text), ordinal (duplicate text decided by position with
//     all earlier messages aligned), text-only (joined by text; order not used), null (unlinked).
//
// RULES
//   Roles: normalizeRole maps role synonyms on BOTH sides. Its table mirrors
//   families/ai-chat.json (normalize map and valueHints); a unit test reads the JSON to stop drift.
//   Per role (user/assistant/...):
//   - Equal role counts and keyed message: positional. Stream i <-> DOM i, then text decides.
//     Duplicate DOM text: ordinal decides only if every earlier message of the role was aligned;
//     otherwise ambiguous.
//   - Otherwise (counts differ, or null key): text only. A message links to a free DOM turn only
//     when exactly one free turn fits (equal or stream-prefix); several fitting turns -> ambiguous.
//     With no fitting turn, the near-match tier may apply (see near_match above).
//     Ordering is not assumed and evidence.notes says so.
//   Blocks: linked only for verified/partial messages, and only when block counts agree. Stream
//     block index -> DOM block with the same ord; type must be compatible (text-like stream types
//     map to paragraph/heading/list/quote/code; equal types always compatible).
//   Near-match metric: multiset Dice coefficient over whitespace tokens of the normalized texts,
//     D = 2 * |A ∩ B| / (|A| + |B|), where |A ∩ B| counts each token min(countA, countB) times.
//     Chosen over containment |A ∩ B| / min(|A|, |B|): containment scores a short stream fragment
//     inside a long render as 1.0, which is the prefix-of-render case that must not read as near.
//     Dice penalises the length gap, so one extra word in a 22-token sentence scores 0.978 (near)
//     and two replaced words score 0.909 (not near).
//   Normalization: see normalizeForJoin (NFKC, entities, zero-width, links, citations, fences, etc.).

const STATUSES = ['verified', 'partial', 'near_match', 'ambiguous', 'text_mismatch', 'unlinked_stream', 'unlinked_dom'];
const TEXT_LIKE = new Set(['paragraph', 'text', 'heading', 'list', 'quote', 'code', 'markdown']);
const DOM_TEXT = new Set(['paragraph', 'heading', 'list', 'quote', 'code']);

export const NEAR_THRESHOLD = 0.95;
const NEAR_OTHER_CEILING = 0.8;

// Role synonyms. Mirrors families/ai-chat.json entities.message.fields.role.normalize (human, ai,
// model, bot) and its valueHints. Extras are common provider labels.
// Explicit provenance fences joins by provider origin, account and native thread.
// Two unscoped legacy inputs remain comparable, but are never source-qualified.
export function sourcesCompatible(a, b) {
  if (a == null && b == null) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  for (const key of ['origin', 'account', 'threadRef']) {
    if (typeof a[key] !== 'string' || !a[key].trim() || a[key] !== b[key]) return false;
  }
  if (a.sessionId != null || b.sessionId != null) return !!a.sessionId && a.sessionId === b.sessionId;
  return true;
}
const pairAllowed = (a, b) => sourcesCompatible(a.source, b.source)
  && (a.nativeMessageId == null || b.nativeMessageId == null
    || (typeof a.nativeMessageId === 'string' && a.nativeMessageId === b.nativeMessageId));

const ROLE_SYNONYMS = {
  user: 'user', human: 'user', me: 'user', customer: 'user',
  assistant: 'assistant', ai: 'assistant', model: 'assistant', bot: 'assistant',
  chatgpt: 'assistant', claude: 'assistant', gemini: 'assistant',
  system: 'system', tool: 'tool', function: 'tool',
};

export function normalizeRole(r) {
  const k = String(r ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_SYNONYMS, k) ? ROLE_SYNONYMS[k] : k;
}

// Regexes and helpers for normalizeForJoin. Prose lines get every rule; fenced code bodies get
// only the legacy marker strip (**, __, `, heading #, quote >, bullet), so code is not rewritten.
const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntity(whole, body) {
  const b = body.toLowerCase();
  if (b[0] === '#') {
    const cp = b[1] === 'x' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
    const valid = Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
    return valid ? String.fromCodePoint(cp) : whole;
  }
  return NAMED_ENTITY[b];
}
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const HR = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const IMG_REF = /!\[([^\]]*)\]\[[^\]]*\]/g;
const IMG_INLINE = /!\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g;
const LINK_REF = /(?<![\w\]])\[([^\]]*[A-Za-z][^\]]*)\]\[[^\]]*\]/g;
const LINK_INLINE = /(?<![\w\]])\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g;
const CITE_SPACED = /(?<=[\p{L}\p{N}.,;:!?"'\]])[ \t]+\[\^?\d+\](?=$|[\s.,;:!?])/gu;
const CITE_ATTACHED = /(?<=[.,;:!?"'])\[\^?\d+\](?=$|[\s.,;:!?])/gu;
const CITE_TOOL = /[ \t]*【\d+(?::\d+)?†[^】]*】/gu;
const STRIKE = /~~([^~\n]+)~~/g;
const EMPH_STAR = /(^|[^\w*])\*(?!\s)([^*\n]*\w)\*(?![\w*])/g;
const EMPH_UNDER = /(^|[^\w_])_(?!\s)([^_\n]*\w)_(?![\w_])/g;
const MARKERS = /\*\*|__|`/g;
const HEADING = /^[ \t]*#{1,6}[ \t]+/;
const QUOTE = /^[ \t]*>[ \t]?/;
const BULLET = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

// A table separator row: every non-empty cell is dashes with optional alignment colons, and the
// line has a pipe. A line of dashes without a pipe is not a table row (it is handled as a rule).
function isTableSeparator(line) {
  if (!line.includes('|')) return false;
  const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function codeLine(line) {
  return line.replace(MARKERS, '').replace(HEADING, '').replace(QUOTE, '').replace(BULLET, '');
}

function proseLine(line) {
  let s = line.replace(MARKERS, '');
  s = s.replace(IMG_REF, '$1').replace(IMG_INLINE, '$1').replace(LINK_REF, '$1').replace(LINK_INLINE, '$1');
  s = s.replace(CITE_SPACED, '').replace(CITE_ATTACHED, '').replace(CITE_TOOL, '');
  s = s.replace(STRIKE, '$1').replace(EMPH_STAR, '$1$2').replace(EMPH_UNDER, '$1$2');
  s = s.replace(/\|/g, ' ');
  return s.replace(HEADING, '').replace(QUOTE, '').replace(BULLET, '');
}

// Normalizes text for comparison between stream markdown and rendered DOM text.
// Order: zero-width and soft-hyphen removal; <br> to space; <https://x> autolink to URL; HTML
// entities decoded once; NFKC; smart quotes to ASCII. Then line by line: fenced code fence lines
// (with their language label) dropped, code bodies kept; horizontal rules and table separator rows
// dropped; prose gets links/images/citations/strike/emphasis/pipe rules; then lowercase and collapse
// whitespace.
export function normalizeForJoin(text) {
  const src = String(text ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<(https?:\/\/[^\s<>]+)>/gi, '$1')
    .replace(ENTITY, decodeEntity)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
  const kept = [];
  let fence = null;
  for (const line of src.split(/\r\n|\r|\n/)) {
    const fm = FENCE.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && fm[2].trim() === '') fence = null;
      else kept.push(codeLine(line));
      continue;
    }
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
      fence = { ch: fm[1][0], len: fm[1].length };
      continue;
    }
    if (HR.test(line) || isTableSeparator(line)) continue;
    kept.push(proseLine(line));
  }
  return kept.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Relation of stream text s to rendered text t (both normalized).
function relate(s, t) {
  if (s === '' && t === '') return 'empty';
  if (s === t) return 'exact';
  if (t.length > s.length && t.startsWith(s)) return 'prefix';
  if (s.length > t.length && s.startsWith(t) && t !== '') return 'render_behind';
  return 'differs';
}
const fitsRel = (rel) => rel === 'exact' || rel === 'prefix';
const textMatchOf = (rel) => (fitsRel(rel) ? rel : rel === 'empty' ? 'none' : 'differs');
const textMatchFor = (status, rel) => (status === 'near_match' ? 'near' : status === 'ambiguous' ? 'none' : textMatchOf(rel));

// Multiset Dice coefficient over whitespace tokens (see RULES). Returns 0 if either side is empty.
function tokenDice(a, b) {
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

// Near only for texts that are neither exact nor prefix-related. Returns the score or null.
function nearScore(s, t, rel) {
  if (rel !== 'differs' && rel !== 'render_behind') return null;
  const d = tokenDice(s, t);
  return d >= NEAR_THRESHOLD ? d : null;
}
const nearNote = (score) => `near_match: token Dice ${score.toFixed(3)} >= ${NEAR_THRESHOLD}; texts differ after normalization, not verified`;

// Text-only near tier: decisive only when exactly one free turn is >= NEAR_THRESHOLD and every
// other free turn is below NEAR_OTHER_CEILING. Returns { turn, note }; note is null when silent.
function nearText(m, free) {
  const scored = free.map((x) => ({ x, score: tokenDice(m.nt, x.nt) }));
  const hits = scored.filter((s) => s.score >= NEAR_THRESHOLD);
  if (hits.length === 0) return { turn: null, note: null };
  if (hits.length > 1) return { turn: null, note: `near_match not used: ${hits.length} free turns score >= ${NEAR_THRESHOLD}` };
  const hit = hits[0];
  const othersLow = scored.every((s) => s === hit || s.score < NEAR_OTHER_CEILING);
  if (!othersLow) return { turn: null, note: `near_match not used: another free turn scores ${NEAR_OTHER_CEILING} or more` };
  return {
    turn: hit.x,
    note: `near_match: exactly one free turn scores >= ${NEAR_THRESHOLD} (token Dice ${hit.score.toFixed(3)}); every other free turn scores below ${NEAR_OTHER_CEILING}; ordering not used`,
  };
}

// Turns a relation into a status. Exact text is verified only for a final stream message.
function decide(rel, final, notes) {
  if (rel === 'exact') {
    if (final === false) { notes.push('stream_not_final'); return 'partial'; }
    return 'verified';
  }
  if (rel === 'prefix') { notes.push(final === false ? 'stream_not_final' : 'stream_prefix_of_render'); return 'partial'; }
  if (rel === 'render_behind') notes.push('rendered_text_behind_stream');
  if (rel === 'empty') notes.push('no_text_to_verify');
  return 'text_mismatch';
}

function blockCompatible(s, d) {
  if (!s.type) return true;
  const st = String(s.type).toLowerCase(), dt = String(d.type ?? '').toLowerCase();
  if (st === dt) return true;
  return TEXT_LIKE.has(st) && DOM_TEXT.has(dt);
}

// Stream block indexes are not DOM ordinals: they can be strings ("0"), composite ("0.0" for an
// OpenAI Responses output_index.content_index) or non-contiguous (a tool block with no text). So
// blocks are paired by RANK ORDER (naturally sorted stream index <-> ascending DOM ord), only when
// the counts agree. A wrong pairing cannot produce a false `verified`: each pair still has to pass
// the type check and the text check, and it inherits the message's finality.
const byNaturalIndex = (a, b) => String(a.index).localeCompare(String(b.index), undefined, { numeric: true });

function linkBlocks(sbs, dbs, final) {
  const out = [];
  if (sbs.length !== dbs.length) {
    const reason = `block counts differ (stream ${sbs.length}, dom ${dbs.length}): no ordinal link`;
    for (const s of sbs) out.push({ blockKey: s.key, ord: null, status: 'unlinked_stream', textMatch: 'none', evidence: { rule: null, reason } });
    for (const d of dbs) out.push({ blockKey: null, ord: d.ord, status: 'unlinked_dom', textMatch: 'none', evidence: { rule: null, reason } });
    return out;
  }
  const ss = [...sbs].sort(byNaturalIndex);
  // DOM blocks are already in document order; sort by ord only when every ord is present.
  const ds = dbs.every((d) => Number.isFinite(d.ord)) ? [...dbs].sort((a, b) => a.ord - b.ord) : dbs;
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i], d = ds[i];
    if (!blockCompatible(s, d)) {
      out.push({ blockKey: s.key, ord: null, status: 'unlinked_stream', textMatch: 'none', evidence: { rule: null, reason: `type ${s.type} incompatible with dom ${d.type}` } });
      out.push({ blockKey: null, ord: d.ord, status: 'unlinked_dom', textMatch: 'none', evidence: { rule: null, reason: `dom type ${d.type} incompatible with stream ${s.type}` } });
      continue;
    }
    const notes = [`paired by rank ${i}: stream index ${JSON.stringify(s.index)} <-> dom ord ${d.ord}`];
    const rel = relate(s.nt, d.nt);
    out.push({ blockKey: s.key, ord: d.ord, status: decide(rel, final, notes), textMatch: textMatchOf(rel), evidence: { rule: 'order+text', ordering: 'rank', notes } });
  }
  return out;
}

export function joinStreamToDom({ messages = [], turns = [] } = {}) {
  const ms = (Array.isArray(messages) ? messages : []).map((m, pos) => {
    const x = m ?? {};
    return {
      pos, key: x.key ?? null, messageId: x.messageId ?? null, role: normalizeRole(x.role), nt: normalizeForJoin(x.text), final: x.final,
      source: x.source ?? null, nativeMessageId: x.nativeMessageId ?? null,
      blocks: (Array.isArray(x.blocks) ? x.blocks : []).map((b, i) => { const y = b ?? {}; return { key: y.key ?? null, index: y.index ?? i, type: y.type ?? null, nt: normalizeForJoin(y.text) }; }),
    };
  });
  const ts = (Array.isArray(turns) ? turns : []).map((t, pos) => {
    const x = t ?? {};
    return {
      pos, index: x.index ?? pos, id: x.id ?? null, domId: x.domId ?? null, role: normalizeRole(x.role), nt: normalizeForJoin(x.text),
      source: x.source ?? null, nativeMessageId: x.nativeMessageId ?? null,
      blocks: (Array.isArray(x.blocks) ? x.blocks : []).map((b) => { const y = b ?? {}; return { ord: y.ord ?? null, type: y.type ?? null, nt: normalizeForJoin(y.text) }; }),
    };
  });

  const res = new Array(ms.length).fill(null); // message pos -> { status, turnPos, textMatch, evidence }
  const claimed = new Map();                    // turn pos -> message pos
  const candidateOf = new Map();                // turn pos -> [message pos] (ambiguous candidacy)
  const addCand = (tp, mp) => { if (!candidateOf.has(tp)) candidateOf.set(tp, []); candidateOf.get(tp).push(mp); };
  const roles = [...new Set([...ms, ...ts].map((x) => x.role))];

  for (const role of roles) {
    const mL = ms.filter((x) => x.role === role);
    const tL = ts.filter((x) => x.role === role);
    const countsEqual = mL.length === tL.length;
    const countNote = countsEqual ? null : `role counts differ (stream ${mL.length}, dom ${tL.length}): aligned by text, ordering not assumed`;
    let aligned = true;

    // Pass 1: positional (equal counts, keyed messages).
    for (let i = 0; i < mL.length; i++) {
      const m = mL[i];
      if (!countsEqual || m.key === null) continue;
      const t = tL[i];
      if (!pairAllowed(m, t)) { aligned = false; continue; }
      const rel = relate(m.nt, t.nt);
      const notes = ['ordering assumed from equal role counts'];
      const fits = tL.filter((x) => pairAllowed(m, x) && fitsRel(relate(m.nt, x.nt)));
      const evidence = { rule: 'order+text', ordering: 'position', notes, candidates: [] };
      let status, turnPos = t.pos;
      if (fitsRel(rel) && fits.length > 1) {
        evidence.rule = 'ordinal';
        evidence.candidates = fits.map((x) => x.index);
        if (aligned) {
          notes.push('duplicate text decided by ordinal: all earlier messages aligned');
          status = decide(rel, m.final, notes);
        } else {
          status = 'ambiguous';
          turnPos = null;
          notes.push('duplicate text and earlier messages not aligned: no ordinal decision');
          for (const c of fits) addCand(c.pos, m.pos);
        }
      } else {
        const score = nearScore(m.nt, t.nt, rel);
        if (score !== null) {
          status = 'near_match';
          notes.push(nearNote(score));
        } else {
          status = decide(rel, m.final, notes);
        }
      }
      res[m.pos] = { status, turnPos, textMatch: textMatchFor(status, rel), evidence };
      if (turnPos !== null) claimed.set(turnPos, m.pos);
      if (status !== 'verified' && status !== 'partial') aligned = false;
    }

    // Pass 2: text only (counts differ, or null key). Ordering is not used.
    for (const m of mL) {
      if (res[m.pos]) continue;
      const notes = countNote ? [countNote] : [];
      if (m.key === null) notes.push('no message key: joined by text');
      if (m.source != null) notes.push('only exact source-qualified candidates may match');
      const evidence = { rule: 'text-only', ordering: 'text', notes, candidates: [] };
      const fits = tL.filter((x) => !claimed.has(x.pos) && pairAllowed(m, x) && fitsRel(relate(m.nt, x.nt)));
      if (!fits.length) {
        const near = nearText(m, tL.filter((x) => !claimed.has(x.pos) && pairAllowed(m, x)));
        if (near.turn) {
          notes.push(near.note);
          evidence.candidates = [near.turn.index];
          res[m.pos] = { status: 'near_match', turnPos: near.turn.pos, textMatch: 'near', evidence };
          claimed.set(near.turn.pos, m.pos);
        } else {
          if (near.note) notes.push(near.note);
          res[m.pos] = { status: 'unlinked_stream', turnPos: null, textMatch: 'none', evidence: { ...evidence, rule: null } };
        }
        continue;
      }
      if (fits.length > 1) {
        evidence.candidates = fits.map((x) => x.index);
        notes.push('several turns fit the text; ordering not used');
        for (const c of fits) addCand(c.pos, m.pos);
        res[m.pos] = { status: 'ambiguous', turnPos: null, textMatch: 'none', evidence };
        continue;
      }
      const t = fits[0];
      const rel = relate(m.nt, t.nt);
      res[m.pos] = { status: decide(rel, m.final, notes), turnPos: t.pos, textMatch: textMatchOf(rel), evidence };
      claimed.set(t.pos, m.pos);
    }
  }

  const links = [];
  for (const m of ms) {
    const r = res[m.pos];
    const t = r.turnPos === null ? null : ts[r.turnPos];
    const blockLinks = t && (r.status === 'verified' || r.status === 'partial') ? linkBlocks(m.blocks, t.blocks, m.final) : [];
    links.push({
      messageKey: m.key, messageIndex: m.pos, messageId: m.messageId, role: m.role,
      turnIndex: t ? t.index : null, turnId: t ? t.id : null, domId: t ? t.domId : null,
      status: r.status, textMatch: r.textMatch, blockLinks,
      evidence: { ...r.evidence, sourceQualified: !!t && m.source != null && sourcesCompatible(m.source, t.source) },
    });
  }
  for (const t of ts) {
    if (claimed.has(t.pos)) continue;
    links.push({
      messageKey: null, messageIndex: null, messageId: null, role: t.role,
      turnIndex: t.index, turnId: t.id, domId: t.domId,
      status: 'unlinked_dom', textMatch: 'none', blockLinks: [],
      evidence: { rule: null, ordering: 'none', notes: [], candidates: [], candidateOf: candidateOf.get(t.pos) ?? [] },
    });
  }

  const messageStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const blockStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const rules = { 'order+text': 0, 'text-only': 0, ordinal: 0 };
  for (const l of links) {
    messageStatus[l.status]++;
    if (l.evidence.rule) rules[l.evidence.rule]++;
    for (const b of l.blockLinks) blockStatus[b.status]++;
  }
  const summary = { messages: ms.length, turns: ts.length, messageStatus, blockStatus, rules,
    sourceQualifiedLinks: links.filter((x) => x.messageIndex !== null && x.evidence.sourceQualified).length,
    unqualifiedLinks: links.filter((x) => x.messageIndex !== null && x.turnIndex !== null && !x.evidence.sourceQualified).length };
  return { links, summary };
}


// Native content relationships from verified fully-qualified joins only.
// They are NOT semantic facts, capture acceptance, or training authorization.
export function verifiedContentRelations({ messages = [], links = [] } = {}) {
  const out = [];
  for (const link of links) {
    if (link.status !== 'verified' || link.evidence?.sourceQualified !== true || link.messageIndex == null) continue;
    const m = messages[link.messageIndex];
    if (!m || m.final !== true || !m.sid || (!m.messageId && !m.key)) continue;
    out.push({
      kind: 'message_rendered_as', status: 'content_verified', captureAccepted: false,
      from: { sid: m.sid, messageId: m.messageId ?? null, messageKey: m.key ?? null },
      to: { turnIndex: link.turnIndex, turnId: link.turnId, domId: link.domId },
      source: { origin: m.source.origin, account: m.source.account, threadRef: m.source.threadRef,
        ...(m.source.sessionId ? { sessionId: m.source.sessionId } : {}) },
      parts: (link.blockLinks ?? []).filter((b) => b.status === 'verified' && b.blockKey != null && b.ord != null)
        .map((b) => ({ blockKey: b.blockKey, domOrd: b.ord })),
    });
  }
  return out;
}
