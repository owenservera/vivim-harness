// Ledger of prompts VIVIM itself typed into a provider composer.
//
// Why: rich composers (Claude) persist UNSENT composer text in localStorage and restore it into every
// new chat. If one of VIVIM's own typings fails half way, that residue would block every later send as
// DRAFT_PRESENT forever. The ledger lets VIVIM recognise its OWN residue (and only its own) so it can
// clear it. Text that does not match stays protected: user-typed drafts are never touched.
//
// Storage is hashes only (never prompt text): for each prompt, the sha256 of the loosely-normalised text
// at fixed checkpoint lengths plus the full length. A draft matches when it is a prefix of (or equal to)
// a ledgered prompt and is long enough (>= MIN_MATCH_CHARS) to be identifying.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LEDGER_FILE = 'typed-prompt-ledger.json';
export const MIN_MATCH_CHARS = 40;
const MAX_ENTRIES = 50;
const CHECKPOINTS = [40, 80, 160, 320, 640, 1280, 2560];

// Prompt stems VIVIM has authored in earlier releases (before this ledger existed). They identify
// residue left behind by those versions. Compared on the loose form.
export const LEGACY_PROMPT_STEMS = Object.freeze([
  'You are helping design a small personal mobile app',
]);

// Quotes, nbsp, zero-width characters and markdown/code-block structure are exactly what rich editors
// rewrite between "typed" and "read back". Loose = lowercase letters and digits only.
export const looseForm = (text) => String(text ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
const ledgerPath = (root) => path.join(root, LEDGER_FILE);

function readLedger(root) {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(root), 'utf8'));
    return Array.isArray(data?.entries) ? data.entries.filter((e) => e && Number.isSafeInteger(e.len) && e.marks && typeof e.marks === 'object') : [];
  } catch { return []; }
}

function writeLedger(root, entries) {
  mkdirSync(root, { recursive: true });
  const target = ledgerPath(root), tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schema: 'vivim.typed-prompt-ledger.v1', entries }, null, 1));
  renameSync(tmp, target);
}

// Called BEFORE any character is typed: a typing that dies half way must already be recognisable.
export function recordTypedPrompt(root, prompt) {
  if (!root) return false;
  const loose = looseForm(prompt);
  if (loose.length < MIN_MATCH_CHARS) return false;
  const marks = {};
  for (const c of CHECKPOINTS) if (c <= loose.length) marks[c] = hash(loose.slice(0, c));
  const full = hash(loose);
  const entries = readLedger(root).filter((e) => e.full !== full);
  entries.push({ len: loose.length, full, marks, at: new Date().toISOString() });
  writeLedger(root, entries.slice(-MAX_ENTRIES));
  return true;
}

// True when `draftText` is (a prefix of / equal to) a prompt VIVIM typed, or begins with a legacy stem.
export function matchesTypedPrompt(root, draftText) {
  const draft = looseForm(draftText);
  if (draft.length < MIN_MATCH_CHARS) return false;
  for (const stem of LEGACY_PROMPT_STEMS) if (draft.startsWith(looseForm(stem))) return true;
  if (!root) return false;
  for (const e of readLedger(root)) {
    if (draft.length > e.len) continue;
    if (draft.length === e.len) { if (hash(draft) === e.full) return true; continue; }
    const usable = CHECKPOINTS.filter((c) => c <= draft.length && e.marks[c]);
    const c = usable[usable.length - 1];
    if (c && hash(draft.slice(0, c)) === e.marks[c]) return true;
  }
  return false;
}

// Failure-cleanup rule: the composer text is VIVIM's own when it is a (loose) prefix of what was typed, or
// the typed text with some characters DROPPED (a lagging page loses keystrokes: "VIVIM probe" -> "VVIrobe").
// Callers only use this in a Studio-owned tab whose composer was verified empty right before typing, so
// anything that is a subsequence of our prompt is our own residue; foreign text will not be one.
export const isPrefixOfTyped = (composerText, prompt) => {
  const draft = looseForm(composerText), typed = looseForm(prompt);
  if (!draft.length) return false;
  if (typed.startsWith(draft)) return true;
  const want = [...draft];
  let i = 0;
  for (const ch of typed) if (ch === want[i] && ++i === want.length) return true;
  return false;
};
