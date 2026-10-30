// Ledger of prompts VIVIM itself typed into a provider composer.
//
// Why: rich composers (Claude) persist UNSENT composer text in localStorage and restore it into every
// new chat. If one of VIVIM's own typings fails half way, that residue would block every later send as
// DRAFT_PRESENT forever. The ledger lets VIVIM recognise its OWN residue (and only its own) so it can
// clear it. Text that does not match stays protected: user-typed drafts are never touched.
//
// Storage is fingerprints only (never prompt text), last MAX_ENTRIES prompts. A draft is VIVIM's own only
// when its WHOLE loose form equals a prefix of a ledgered prompt (a typing that died at any character):
//   - `head`: 128-bit hash of the first MIN_MATCH_CHARS loose chars (short drafts never match);
//   - `steps`: a chained checksum over every following char, 24 bits kept per position, so the full draft
//     length is verified - text a user appended to or edited inside VIVIM's residue does not match;
//   - `full`: 128-bit hash of the whole prompt.
// A draft longer than MAX_TRACKED_CHARS (and not the full prompt) is never matched: protection wins.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LEDGER_FILE = 'typed-prompt-ledger.json';
export const MIN_MATCH_CHARS = 40;
const MAX_ENTRIES = 50;
const MAX_TRACKED_CHARS = 4000;
const STEP_BYTES = 3;
const SCHEMA = 'vivim.typed-prompt-ledger.v2';
const CHAIN_SEED = createHash('sha256').update(SCHEMA).digest();

// Prompt stems VIVIM has authored in earlier releases (before this ledger existed). They identify
// residue left behind by those versions. Compared on the loose form.
export const LEGACY_PROMPT_STEMS = Object.freeze([
  'You are helping design a small personal mobile app',
  // Harness live-test prompt typed by an earlier session before it was ledgered; ChatGPT restored it
  // into every new chat as DRAFT_PRESENT (seen 2026-10-30, 108 characters).
  'Multiline fidelity retest',
]);

// Quotes, nbsp, zero-width characters and markdown/code-block structure are exactly what rich editors
// rewrite between "typed" and "read back". Loose = lowercase letters and digits only.
export const looseForm = (text) => String(text ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
const ledgerPath = (root) => path.join(root, LEDGER_FILE);

// Chained 64-bit (two 32-bit lanes, FNV-1a style) state over the code points, from a fixed schema seed.
// Not adversarial: it only has to tell "exactly VIVIM's prefix" from "VIVIM's prefix edited by a user"
// once the 128-bit head already matched. (Per-char sha256 costs ~1 s for a long prompt on a loaded PC.)
// Calls visit(position, a, b) after each char past the head (position = chars consumed).
function chain(chars, to, visit) {
  let a = CHAIN_SEED.readUInt32LE(0), b = CHAIN_SEED.readUInt32LE(4);
  for (let i = 0; i < to; i++) {
    const cp = chars[i].codePointAt(0);
    a = Math.imul(a ^ cp, 0x01000193) >>> 0;
    b = Math.imul((b ^ cp) + 0x9e3779b9, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13) ^ a) >>> 0;
    if (i + 1 > MIN_MATCH_CHARS) visit(i + 1, a, b);
  }
}
const stepCode = (a, b) => [(a ^ (b >>> 7)) & 0xff, ((a >>> 8) ^ b) & 0xff, ((a >>> 16) ^ (b >>> 19)) & 0xff];

function fingerprint(loose) {
  const chars = [...loose];
  const tracked = Math.min(chars.length, MAX_TRACKED_CHARS);
  const steps = Buffer.alloc(Math.max(0, tracked - MIN_MATCH_CHARS) * STEP_BYTES);
  chain(chars, tracked, (pos, a, b) => steps.set(stepCode(a, b), (pos - MIN_MATCH_CHARS - 1) * STEP_BYTES));
  return { len: chars.length, full: hash(loose), head: hash(chars.slice(0, MIN_MATCH_CHARS).join('')), steps: steps.toString('base64') };
}

const validEntry = (e) => e && Number.isSafeInteger(e.len) && e.len >= MIN_MATCH_CHARS && typeof e.full === 'string'
  && ((typeof e.head === 'string' && typeof e.steps === 'string') || (e.marks && typeof e.marks === 'object'));

function readLedger(root) {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(root), 'utf8'));
    return Array.isArray(data?.entries) ? data.entries.filter(validEntry).slice(-MAX_ENTRIES) : [];
  } catch { return []; } // missing or corrupt: start over (fewer matches is the safe direction)
}

function writeLedger(root, entries) {
  mkdirSync(root, { recursive: true });
  const target = ledgerPath(root);
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, entries }));
  // Windows refuses a rename over a file another process is reading for a moment (EPERM/EACCES/EBUSY).
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, target); return; } catch (e) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
}

// Called BEFORE any character is typed: a typing that dies half way must already be recognisable.
// Concurrent writers (two processes) can at worst drop one entry: that only means fewer matches.
export function recordTypedPrompt(root, prompt) {
  if (!root) return false;
  const loose = looseForm(prompt);
  if ([...loose].length < MIN_MATCH_CHARS) return false;
  const entry = { ...fingerprint(loose), at: new Date().toISOString() };
  const entries = readLedger(root).filter((e) => e.full !== entry.full);
  entries.push(entry);
  writeLedger(root, entries.slice(-MAX_ENTRIES));
  return true;
}

function entryMatches(e, chars, draft) {
  const n = chars.length;
  if (n > e.len) return false;
  if (n === e.len) return hash(draft) === e.full;
  if (!e.head) return e.marks?.[n] === hash(draft); // v1 entry: only an exactly checkpointed length is provable
  if (n > MAX_TRACKED_CHARS || hash(chars.slice(0, MIN_MATCH_CHARS).join('')) !== e.head) return false;
  if (n === MIN_MATCH_CHARS) return true;
  const steps = Buffer.from(e.steps, 'base64'), at = (n - MIN_MATCH_CHARS - 1) * STEP_BYTES;
  if (at + STEP_BYTES > steps.length) return false;
  let last = null;
  chain(chars, n, (pos, a, b) => { if (pos === n) last = stepCode(a, b); });
  return last.every((byte, k) => byte === steps[at + k]);
}

// True when the WHOLE `draftText` is (a prefix of / equal to) a prompt VIVIM typed, or begins with a legacy stem.
export function matchesTypedPrompt(root, draftText) {
  const draft = looseForm(draftText);
  const chars = [...draft];
  if (chars.length < MIN_MATCH_CHARS) return false;
  for (const stem of LEGACY_PROMPT_STEMS) if (draft.startsWith(looseForm(stem))) return true;
  if (!root) return false;
  return readLedger(root).some((e) => entryMatches(e, chars, draft));
}

// A lagging page drops keystrokes ("VIVIM probe" -> "VVIrobe"). Dropped-character residue is accepted
// only when it is long enough to be identifying and dense in the typed span it covers.
const SUBSEQ_MIN_CHARS = 6;
const SUBSEQ_MIN_DENSITY = 0.6;

// Failure-cleanup rule: the composer text is VIVIM's own when it is a (loose) prefix of what was typed, or
// the typed text with some characters DROPPED. Callers only use this in a Studio-owned, still-threadless
// tab whose composer was verified empty right before typing; the length/density bounds keep a short or
// sparse foreign text (almost anything short is a subsequence of a long prompt) from qualifying.
export const isPrefixOfTyped = (composerText, prompt) => {
  const draft = [...looseForm(composerText)], typed = [...looseForm(prompt)];
  if (!draft.length || draft.length > typed.length) return false;
  if (draft.every((ch, i) => ch === typed[i])) return true;
  if (draft.length < SUBSEQ_MIN_CHARS) return false;
  let i = 0;
  for (let j = 0; j < typed.length; j++) {
    if (typed[j] === draft[i] && ++i === draft.length) return draft.length / (j + 1) >= SUBSEQ_MIN_DENSITY;
  }
  return false;
};
