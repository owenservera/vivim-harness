// Offline investigation: adapter multiline typing/readback contract.
//
// Scope: no browser, no provider, no network, no CDP. Owner/editor readbacks are injected
// synthetic values. Every predicate asserted here is EXTRACTED FROM PRODUCTION SOURCE and
// evaluated as-is, so source drift fails this test instead of silently passing a copy.
//
// Fixtures describe contract behaviour only. They do NOT establish a live root cause for any
// observed provider defect.
//
// Guards under test:
//   - `readbackMatches`: a readback equals the CRLF-normalized prompt, or that prompt plus exactly
//     ONE appended newline; tolerance applies to the readback only, the payload is never trimmed.
//   - adapter `type()`: types with the human per-character path, then re-reads the page draft up to
//     TYPING_READBACK_ATTEMPTS times (TYPING_READBACK_DELAY_MS apart) because the composer DOM
//     settles asynchronously for multiline payloads. Acceptance is decided by the freshly read page
//     draft; `!typed.ok` fails immediately. Exhaustion throws TYPING_UNCONFIRMED.
//   - adapter `effectPreflight()`: pre-dispatch readback comparison with the same one-newline
//     tolerance, unchanged by this fix (src/capture/conversation-browser-adapter.mjs).
//   - page probe draft text: contenteditable `innerText`, CRLF-normalized in-page
//     (src/capture/conversation-thread.mjs).
//   - service: any type-step error becomes TYPING_INTERRUPTED, never a dispatch
//     (src/capture/conversation-service.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

const ADAPTER = 'src/capture/conversation-browser-adapter.mjs';
const THREAD = 'src/capture/conversation-thread.mjs';
const SERVICE = 'src/capture/conversation-service.mjs';
const ACTIONS = 'src/capture/actions.mjs';
const HUMAN = 'src/capture/human.mjs';

const adapterSrc = flat(read(ADAPTER));
const threadSrc = flat(read(THREAD));
const serviceSrc = flat(read(SERVICE));
const actionsSrc = flat(read(ACTIONS));
const humanSrc = flat(read(HUMAN));

// --- extraction helpers -------------------------------------------------------------

function sliceBetween(source, head, tail, label) {
  const i = source.indexOf(head);
  assert.notStrictEqual(i, -1, `source drift: ${label} head not found (${head})`);
  const start = i + head.length;
  const end = source.indexOf(tail, start);
  assert.notStrictEqual(end, -1, `source drift: ${label} tail not found (${tail})`);
  return source.slice(start, end);
}

// `head` is the opening text of the `if (...)` statement; the returned condition includes it.
function sliceIncluding(source, head, tail, label) {
  const i = source.indexOf(head);
  assert.notStrictEqual(i, -1, `source drift: ${label} head not found (${head})`);
  const end = source.indexOf(tail, i + head.length);
  assert.notStrictEqual(end, -1, `source drift: ${label} tail not found (${tail})`);
  return source.slice(i, end);
}

function findConditions(source, head, tail, label) {
  const found = [];
  for (let i = source.indexOf(head); i !== -1; i = source.indexOf(head, i + 1)) {
    const end = source.indexOf(tail, i);
    assert.notStrictEqual(end, -1, `source drift: ${label} terminator not found`);
    const start = i + 'if ('.length;
    assert.ok(head.startsWith('if ('), `source drift: ${label} head must be the if-statement opening`);
    assert.ok(start < end, `source drift: ${label} condition bounds`);
    found.push(source.slice(start, end));
  }
  assert.ok(found.length > 0, `source drift: ${label} guard not found`);
  return found;
}

// --- production predicates, evaluated verbatim --------------------------------------

const TYPE_GUARD_HEAD = 'if (!typed.ok';
const TYPE_GUARD_TAIL = ") throw problem('TYPING_UNCONFIRMED');";
const typeGuardSources = findConditions(adapterSrc, TYPE_GUARD_HEAD, TYPE_GUARD_TAIL, 'adapter type() guard');
const READBACK_HEAD = 'const readbackMatches =';
const readbackHelperSource = `${sliceIncluding(adapterSrc, READBACK_HEAD, '};', 'readbackMatches helper')}};`;
// eslint-disable-next-line no-new-func
const readbackMatches = new Function(`${readbackHelperSource}; return readbackMatches;`)();
const typeGuards = typeGuardSources;

const SETTLE_HEAD = 'const settleTypingReadback =';
const settleHelperSource = `${sliceIncluding(adapterSrc, SETTLE_HEAD, '};', 'settleTypingReadback helper')}};`;
const settleAttemptsExpr = sliceBetween(adapterSrc, 'const TYPING_READBACK_ATTEMPTS = ', ';', 'settle attempt count');
const settleDelayExpr = sliceBetween(adapterSrc, 'const TYPING_READBACK_DELAY_MS = ', ';', 'settle delay');
// eslint-disable-next-line no-new-func
const settleAttempts = Number(new Function(`return (${settleAttemptsExpr});`)());
// eslint-disable-next-line no-new-func
const settleDelayMs = Number(new Function(`return (${settleDelayExpr});`)());
// eslint-disable-next-line no-new-func
const settleFactory = new Function('sleep', 'readbackMatches', 'TYPING_READBACK_ATTEMPTS', 'TYPING_READBACK_DELAY_MS',
  `${settleHelperSource}; return settleTypingReadback;`);
function makeSettleCounter() {
  const counter = { delays: 0, delayMs: [] };
  const settle = settleFactory(async (ms) => { counter.delays++; counter.delayMs.push(ms); }, readbackMatches,
    settleAttempts, settleDelayMs);
  return { settle, counter };
}

const PREFLIGHT_HEAD = "if (typeof page.draft?.text !== 'string'";
const PREFLIGHT_TAIL = ") throw problem('COMPOSER_READBACK_MISMATCH');";
const preflightExprs = findConditions(adapterSrc, PREFLIGHT_HEAD, PREFLIGHT_TAIL, 'effectPreflight readback guard');
const trailingArrowSource = sliceBetween(adapterSrc, 'const trailing = ', ';', 'effectPreflight trailing helper');
// eslint-disable-next-line no-new-func
const trailing = new Function(`return (${trailingArrowSource});`)();
const preflights = preflightExprs.map((expr) => ({
  expr,
  // eslint-disable-next-line no-new-func
  run: new Function('trailing', 'page', 'saved', 'empty', `return Boolean(${expr});`),
}));

const DRAFT_READ_HEAD = 'const text=composer?';
// This fragment sits inside a template literal in the source, so its `\\r` / `\\n` escapes only
// become real backslashes once the page script is built. Reproduce that unescape before evaluating.
const draftReadExpr = sliceBetween(threadSrc, DRAFT_READ_HEAD, ':null;', 'thread draft read').replace(/\\\\/g, '\\');
// eslint-disable-next-line no-new-func
const readDraftText = new Function('composer', `return (${draftReadExpr});`);

const NORM_TEXT_HEAD = 'const normText = ';
const normTextArrowSource = sliceBetween(humanSrc, NORM_TEXT_HEAD, ';', 'human normText');
// eslint-disable-next-line no-new-func
const normText = new Function(`return (${normTextArrowSource});`)();
const TAIL_PROBE_HEAD = 'const probe = ';
const tailProbeExpr = sliceBetween(humanSrc, TAIL_PROBE_HEAD, ';', 'human tail probe');
// eslint-disable-next-line no-new-func
const tailProbe = new Function('want', `return (${tailProbeExpr});`);
const HUMAN_OK_HEAD = 'const ok = errors.length === 0';
const humanOkExpr = sliceBetween(humanSrc, HUMAN_OK_HEAD, ';', 'human insertion ok check');
const humanOkFull = sliceIncluding(humanSrc, 'errors.length === 0', ';', 'human insertion ok condition');
// eslint-disable-next-line no-new-func
const humanOk = new Function('errors', 'probe', 'normText', 'typed', `return Boolean(${humanOkFull});`);

// --- synthetic owner/editor readbacks -----------------------------------------------

// Contenteditable (ProseMirror/Lexical) owner readback: actions.mjs composerText uses
// `el.innerText ?? el.textContent`, and thread.mjs draft probe uses the same ladder. Real rich
// editors render each trailing block break as one more line, so a composer holding "a\nb" can
// read back "a\nb\n". `value` is present only for textarea/input composers.
function contenteditableComposer(readbackText) {
  return { value: undefined, innerText: readbackText, textContent: readbackText };
}
function textareaComposer(value) {
  return { value, innerText: undefined, textContent: undefined };
}

// actions.mjs typeText: `typed.typed = res.typed ?? composerText(page)`, where humanType's
// verification is the lenient whitespace-collapsed tail probe (human.mjs). `human: true` is the
// per-character path now used by the adapter; the owner readback shape is identical.
function ownerTypeStep(prompt, { composer, insertionFails = false, ownerReadback = null }) {
  if (insertionFails) return { ok: false, typed: '', method: 'insertText', errors: ['insertion not confirmed: synthetic failure'], reason: 'insertion failure' };
  const typed = ownerReadback ?? (composer.value !== undefined ? composer.value : composer.innerText);
  const want = normText(prompt);
  const probe = tailProbe(want);
  const ok = humanOk([], probe, normText, typed);
  return { ok, typed, method: 'human', errors: [] };
}

// adapter type() body: type step, then the bounded settle loop over page reads.
// `drafts` is the sequence of draft texts the page returns, one per read attempt.
async function adapterTypeStep({ prompt, composer, insertionFails = false, ownerReadback = null, drafts = null }) {
  const typed = ownerTypeStep(prompt, { composer, insertionFails, ownerReadback });
  const queue = drafts ? [...drafts] : null;
  let reads = 0;
  const { settle, counter } = makeSettleCounter();
  const read = async () => {
    reads++;
    const text = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : readDraftText(composer);
    return { draft: { text } };
  };
  if (!typed.ok) return { ok: false, code: 'TYPING_UNCONFIRMED', typed, reads, delays: counter.delays };
  const after = await settle(read, prompt, typed);
  return after
    ? { ok: true, typed, reads, delays: counter.delays, draftText: after.draft.text }
    : { ok: false, code: 'TYPING_UNCONFIRMED', typed, reads, delays: counter.delays };
}

// conversation-service follow-up path: one type step, then dispatch only when it succeeded.
async function followupPath(args) {
  const calls = { type: 0, submit: 0 };
  const result = await adapterTypeStep(args);
  calls.type++;
  if (!result.ok) {
    return { code: 'TYPING_INTERRUPTED', cause: result.code, disposition: 'not-attempted',
      state: 'needs-reconciliation', uncertainty: 'partial-draft-possible', calls, result };
  }
  calls.submit++;
  return { code: 'SUBMITTED', disposition: 'dispatched', calls, result };
}

// ------------------------------------------------------------------------------------

test('contract: both call sites gate on typed.ok and settle through the page draft', () => {
  assert.equal(typeGuardSources.length, 2, 'expected the creation-path and bound-thread-path refusal sites');
  assert.match(readbackHelperSource, /typeof readback !== 'string' \|\| typeof prompt !== 'string'\) return false;/,
    'non-string readbacks must fail closed');
  assert.match(readbackHelperSource, /got === want \|\| got === `\$\{want\}\\n`/,
    'helper accepts the exact payload or the payload plus exactly one appended newline');
  assert.match(readbackHelperSource, /readback\.replace\(\/\\r\\n\/g, '\\n'\)/, 'readback CRLF-normalized');
  assert.match(readbackHelperSource, /prompt\.replace\(\/\\r\\n\/g, '\\n'\)/, 'prompt CRLF-normalized');
  assert.doesNotMatch(readbackHelperSource, /want\.replace\(\/\\n\$\/|want\.slice\(0, -1\)|want\.trimEnd\(\)/,
    'helper must never strip a newline from the payload side');
  for (const expr of typeGuardSources) {
    assert.match(expr, /!typed\.ok/, 'guard must include the owner type-step ok flag');
  }
  // Creation path refuses when the settle loop returns null; the bound path refuses when the settle
  // loop returns null too. Both read the page draft, never a stored snapshot.
  assert.match(typeGuardSources[0], /^!typed\.ok \|\| !after$/);
  assert.match(typeGuardSources[1], /^!typed\.ok \|\| !await settleTypingReadback\(pageState, prompt\)$/);
  assert.match(settleHelperSource, /readbackMatches\(after\?\.draft\?\.text, prompt\)/,
    'settle acceptance is decided by the freshly read page draft');
});

test('contract: readbackMatches tolerates one appended newline only, readback side only', () => {
  assert.equal(readbackMatches('a\nb', 'a\nb'), true, 'exact readback');
  assert.equal(readbackMatches('a\nb\n', 'a\nb'), true, 'one appended newline');
  assert.equal(readbackMatches('a\nb\n\n', 'a\nb'), false, 'two appended newlines fail');
  assert.equal(readbackMatches('a\nB', 'a\nb'), false, 'mid-payload drift fails');
  assert.equal(readbackMatches('xa\nb', 'a\nb'), false, 'leading drift fails');
  assert.equal(readbackMatches('a\nb\n\nc', 'a\nb\nc'), false, 'internal extra newline fails');
  assert.equal(readbackMatches(null, 'a\nb'), false, 'null readback fails closed');
  assert.equal(readbackMatches(undefined, 'a\nb'), false, 'undefined readback fails closed');
  assert.equal(readbackMatches(42, 'a\nb'), false, 'non-string readback fails closed');
  assert.equal(readbackMatches({ text: 'a\nb' }, 'a\nb'), false, 'object readback fails closed');
  assert.equal(readbackMatches('a\nb', 'a\nb\n'), false, 'payload-side newline is never stripped');
  assert.equal(readbackMatches('a\nb\r\n', 'a\nb'), true, 'CRLF readback normalizes before tolerance');
  assert.equal(readbackMatches('a\r\nb', 'a\r\nb'), true, 'CRLF on both sides matches');
});

test('contract: page probe reads contenteditable innerText and normalizes CRLF in-page', () => {
  assert.match(draftReadExpr, /composer\.value\?\?composer\.innerText\?\?composer\.textContent/);
  assert.match(draftReadExpr, /replace\(\/\\r\\n\/g,'\\n'\)/);
  assert.equal(readDraftText(contenteditableComposer('a\r\nb')), 'a\nb', 'CRLF normalized to LF');
  assert.equal(readDraftText(contenteditableComposer('a\nb\n')), 'a\nb\n', 'trailing editor newline preserved');
  assert.equal(readDraftText(textareaComposer('a\r\nb')), 'a\nb');
});

test('contract: pre-dispatch comparison tolerates exactly one trailing editor newline', () => {
  assert.equal(preflightExprs.length, 1);
  assert.match(preflightExprs[0], /trailing\(page\.draft\.text\)/);
  assert.match(preflightExprs[0], /empty \? '' : trailing\(saved\.prompt\)/);
  assert.equal(trailing('a\nb\n'), 'a\nb');
  assert.equal(trailing('a\nb'), 'a\nb');
  assert.notEqual(trailing('a\nb\n\n'), 'a\nb', 'tolerance covers one newline, not a blank line');
});

test('contract: service maps any type-step error to TYPING_INTERRUPTED before dispatch', () => {
  // The creation path has its own type step; scope the ordering assertions to the follow-up path.
  const followupMark = serviceSrc.indexOf("'[conv] followup type-step failed:'");
  assert.notStrictEqual(followupMark, -1, 'follow-up type-step catch present');
  const typeAt = serviceSrc.lastIndexOf('await adapter.type(', followupMark);
  const interruptedAt = serviceSrc.indexOf("'TYPING_INTERRUPTED'", followupMark);
  const submitAt = serviceSrc.indexOf('await adapter.submit(', followupMark);
  assert.ok(typeAt !== -1 && submitAt !== -1 && interruptedAt !== -1, 'type/submit/interrupted sites present');
  assert.ok(typeAt < followupMark && followupMark < interruptedAt && interruptedAt < submitAt,
    'type -> TYPING_INTERRUPTED -> submit ordering');
  const catchBlock = sliceBetween(serviceSrc, "catch (e) { console.error('[conv] followup type-step failed:'", '}', 'type-step catch');
  assert.match(catchBlock, /unknown\(attempt, 'TYPING_INTERRUPTED'\)/);
  assert.match(catchBlock, /uncertainty = 'partial-draft-possible'/);
  assert.match(catchBlock, /updateAttempt\(attempt, 'needs-reconciliation', 'not-attempted'\)/);
  const followupRegion = serviceSrc.slice(serviceSrc.indexOf('markTyping({ turnId: attempt.id'), submitAt);
  assert.equal(followupRegion.split('adapter.type(').length - 1, 1, 'one type step per follow-up turn: no resend loop');
  assert.doesNotMatch(flat(catchBlock), /for \(|while \(|adapter\.type\(/);
  // TYPING_UNCONFIRMED carries no notDispatched proof, so it stays ambiguous, never "not sent".
  assert.match(adapterSrc, /const problem = \(code\) => Object\.assign\(new Error\(code\), \{ code, status: 409 \}\);/);
  assert.match(adapterSrc, /throw problem\('TYPING_UNCONFIRMED'\)/);
  assert.doesNotMatch(adapterSrc, /problem\('TYPING_UNCONFIRMED'\), \{ notDispatched/, 'unconfirmed typing is not proof of non-dispatch');
});

test('fixture: exact match on the first read passes immediately with no extra waits', async () => {
  const prompt = 'line one\nline two\nline three';
  const rich = contenteditableComposer(prompt);
  const step = await adapterTypeStep({ prompt, composer: rich });
  assert.equal(step.ok, true, 'exact innerText matches the prompt');
  assert.equal(step.draftText, prompt);
  assert.equal(step.reads, 1, 'one read is enough');
  assert.equal(step.delays, 0, 'no settle delay when the first read matches');

  const result = await followupPath({ prompt, composer: rich });
  assert.equal(result.code, 'SUBMITTED');
  assert.deepEqual(result.calls, { type: 1, submit: 1 });

  const plain = await adapterTypeStep({ prompt, composer: textareaComposer(prompt) });
  assert.equal(plain.ok, true, 'textarea value readback has no editor artifact');
  assert.equal(plain.reads, 1);
});

test('fixture: CRLF payload is confirmed after normalization', async () => {
  const prompt = 'line one\r\nline two';
  const expected = 'line one\nline two';
  for (const composer of [contenteditableComposer(expected), textareaComposer(prompt)]) {
    const result = await followupPath({ prompt, composer });
    assert.equal(result.code, 'SUBMITTED', `CRLF payload confirmed against ${composer.value === undefined ? 'innerText' : 'value'} readback`);
    assert.equal(result.calls.submit, 1);
  }
  const crlfReadback = await adapterTypeStep({ prompt, composer: contenteditableComposer('line one\r\nline two') });
  assert.equal(crlfReadback.ok, true);
  assert.equal(crlfReadback.reads, 1);
});

test('fixture: transient doubled separators settle on a later read', async () => {
  const prompt = 'para one\n\npara two';
  // Live shape: first read 114 chars / 8 newlines / 4 blank-line breaks (every separator doubled),
  // then 110 / 4 / 2. Same payload, transient render.
  const result = await followupPath({
    prompt,
    composer: contenteditableComposer(prompt),
    drafts: ['para one\n\n\n\npara two\n\n\n\n', prompt],
  });

  assert.equal(result.code, 'SUBMITTED', 'a transient doubled-separator read must not fail the turn');
  assert.deepEqual(result.calls, { type: 1, submit: 1 });
  assert.equal(result.result.reads, 2, 'settles on the second read');
  assert.equal(result.result.delays, 1, 'exactly one short wait');
});

test('fixture: transient dropped separators settle on a later read', async () => {
  const prompt = 'para one\n\npara two';
  const result = await followupPath({
    prompt,
    composer: contenteditableComposer(prompt),
    drafts: ['para one para two', 'para one\npara two', prompt],
  });

  assert.equal(result.code, 'SUBMITTED');
  assert.deepEqual(result.calls, { type: 1, submit: 1 });
  assert.equal(result.result.reads, 3, 'third read is the settled one');
  assert.equal(result.result.delays, 2);
});

test('fixture: settle-retry still fails closed when every read drifts', async () => {
  const prompt = 'line one\nline two';
  const drifted = 'line one\nline TWO';
  const result = await followupPath({ prompt, composer: contenteditableComposer(prompt), drafts: [drifted] });

  assert.equal(result.code, 'TYPING_INTERRUPTED');
  assert.equal(result.cause, 'TYPING_UNCONFIRMED');
  assert.deepEqual(result.calls, { type: 1, submit: 0 }, 'no dispatch after exhausted settle attempts');
  assert.equal(result.disposition, 'not-attempted');
  assert.equal(result.state, 'needs-reconciliation');
  assert.equal(result.uncertainty, 'partial-draft-possible');
  assert.equal(result.result.reads, settleAttempts, 'every attempt was used');
  assert.equal(settleAttempts, 3);
  assert.equal(result.result.delays, settleAttempts - 1);
});

test('fixture: persistent two-newline readback still fails closed', async () => {
  const prompt = 'line one\nline two';
  const result = await followupPath({
    prompt,
    composer: contenteditableComposer(prompt),
    drafts: ['line one\nline two\n\n'],
  });
  assert.equal(result.code, 'TYPING_INTERRUPTED');
  assert.deepEqual(result.calls, { type: 1, submit: 0 });
  assert.equal(preflights[0].run(trailing, { draft: { text: 'line one\nline two\n\n' } }, { prompt }, false), true,
    'the pre-dispatch comparison also rejects two appended newlines');
});

test('fixture: one appended newline is accepted, and pre-dispatch agrees', async () => {
  const prompt = 'line one\nline two';
  const result = await followupPath({ prompt, composer: contenteditableComposer('line one\nline two\n') });

  assert.equal(result.code, 'SUBMITTED', 'a single renderer-appended newline is accepted');
  assert.deepEqual(result.calls, { type: 1, submit: 1 });
  assert.equal(result.result.draftText, 'line one\nline two\n', 'readback preserved as observed');
  assert.equal(result.result.reads, 1);

  for (const preflight of preflights) {
    assert.equal(preflight.run(trailing, { draft: { text: result.result.draftText } }, { prompt }, false), false,
      'effectPreflight unchanged: still tolerates the trailing newline');
  }
  assert.equal(ownerTypeStep(prompt, { composer: contenteditableComposer('line one\nline two\n') }).ok, true,
    'human.mjs tail probe accepts the same readback');
});

test('fixture: mid-payload drift fails on every attempt', async () => {
  const prompt = 'line one\nline two';
  const drifted = 'line one\nline TWO';
  // A matching owner snapshot must not rescue a persistently drifted page draft.
  const viaDrafts = await followupPath({ prompt, composer: contenteditableComposer(prompt), drafts: [drifted] });
  assert.equal(viaDrafts.code, 'TYPING_INTERRUPTED', 'page draft is the authority, even with a clean owner readback');
  assert.equal(viaDrafts.result.reads, settleAttempts);

  const persistent = await adapterTypeStep({
    prompt,
    composer: contenteditableComposer(prompt),
    ownerReadback: prompt,
    drafts: [drifted],
  });
  assert.equal(persistent.ok, false, 'stale matching owner snapshot cannot authorize a send');

  // Owner readback drift fails closed at typed.ok, before the settle loop runs at all: typeText's
  // own verification reads the same editor once, and the adapter must never retype to "fix" it.
  const transientOwner = await adapterTypeStep({
    prompt,
    composer: contenteditableComposer(prompt),
    ownerReadback: 'line one\nline TWO',
  });
  assert.equal(transientOwner.ok, false, 'a mismatching owner snapshot still refuses the turn');
  assert.equal(transientOwner.reads, 0, 'no settle reads once typed.ok is false');
});

test('fixture: non-string readbacks never settle and fail closed', async () => {
  const prompt = 'line one\nline two';
  // A non-string draft can never satisfy readbackMatches, so every attempt refuses.
  for (const bad of [null, undefined, 42, { text: prompt }]) {
    const stuck = await adapterTypeStep({ prompt, composer: contenteditableComposer(prompt), drafts: [bad] });
    assert.equal(stuck.ok, false, `${String(bad)} must not settle`);
    assert.equal(stuck.reads, settleAttempts);
  }
  const absent = await adapterTypeStep({ prompt, composer: contenteditableComposer(prompt), drafts: [[]] });
  assert.equal(absent.ok, false, 'a missing draft object refuses');
});

test('fixture: genuinely different payload fails closed and is never dispatched', async () => {
  const prompt = 'line one\nline two';
  const composer = contenteditableComposer('line one\nline TWO');
  const result = await followupPath({ prompt, composer });

  assert.equal(result.code, 'TYPING_INTERRUPTED');
  assert.equal(result.cause, 'TYPING_UNCONFIRMED');
  assert.deepEqual(result.calls, { type: 1, submit: 0 });
  assert.equal(result.result.typed.typed, composer.innerText, 'mismatched typed text is preserved in the failure');
  assert.equal(preflights[0].run(trailing, { draft: { text: composer.innerText } }, { prompt }, false), true,
    'a different payload is rejected by both readbacks');
});

test('fixture: insertion failure fails immediately with no reads and no dispatch', async () => {
  const prompt = 'line one\nline two';
  const result = await followupPath({ prompt, composer: contenteditableComposer(''), insertionFails: true });

  assert.equal(result.code, 'TYPING_INTERRUPTED');
  assert.equal(result.cause, 'TYPING_UNCONFIRMED');
  assert.deepEqual(result.calls, { type: 1, submit: 0 });
  assert.equal(result.result.typed.typed, '');
  assert.equal(result.result.reads, 0, 'no settle reads when the type step itself failed');
  assert.equal(result.result.delays, 0);
});

test('fixture: internal blank line is preserved; one appended newline is tolerated', async () => {
  const prompt = 'para one\n\npara two';
  const composer = contenteditableComposer('para one\n\npara two\n');
  assert.equal(readDraftText(composer), 'para one\n\npara two\n', 'blank line preserved in readback');
  const blankLine = await followupPath({ prompt, composer });
  assert.equal(blankLine.code, 'SUBMITTED', 'internal blank line plus one appended newline is accepted');
  assert.deepEqual(blankLine.calls, { type: 1, submit: 1 });
  assert.equal(preflights[0].run(trailing, { draft: { text: 'para one\n\npara two\n' } }, { prompt }, false), false,
    'pre-dispatch strips the one trailing newline and keeps the internal blank line');

  const trailingPrompt = 'line one\n';
  const exact = await followupPath({ prompt: trailingPrompt, composer: contenteditableComposer('line one\n') });
  assert.equal(exact.code, 'SUBMITTED', 'exact match passes');
  const oneMore = await followupPath({ prompt: trailingPrompt, composer: contenteditableComposer('line one\n\n') });
  assert.equal(oneMore.code, 'SUBMITTED', 'newline-terminated payload plus one appended newline passes');
  assert.equal(oneMore.calls.submit, 1);
  const twoMore = await followupPath({ prompt: trailingPrompt, composer: contenteditableComposer('line one\n\n\n') });
  assert.equal(twoMore.code, 'TYPING_INTERRUPTED', 'two appended newlines past the payload still fail');
  assert.deepEqual(twoMore.calls, { type: 1, submit: 0 });
});

test('contract: both typeText call sites use the human per-character path', () => {
  const sites = [];
  const marker = 'd.typeText(recorder.page, prompt, ';
  for (let i = adapterSrc.indexOf(marker); i !== -1; i = adapterSrc.indexOf(marker, i + 1)) sites.push(i);
  assert.equal(sites.length, 2, 'creation path and bound-thread path');
  for (const at of sites) {
    const call = adapterSrc.slice(at, adapterSrc.indexOf('});', at));
    assert.match(call, /human: true/, 'human:true (per-character Shift+Enter path) for multiline payloads');
    assert.doesNotMatch(call, /human: false/, 'one-shot Input.insertText must not be used here');
    assert.match(call, /beforeInsert:/, 'insertion guard preserved');
  }
  // The creation-path guard still runs inside beforeInsert, the bound path still runs effectPreflight.
  assert.match(adapterSrc, /beforeInsert: async \(\) => \{ await guard\(\); beforeEffect\?\.\(\); \}/);
  assert.match(adapterSrc, /beforeInsert: \(\) => effectPreflight\(saved, beforeEffect, true\)/);
});

test('contract: settle loop is bounded and reuses the existing sleep', () => {
  assert.equal(settleAttempts, 3, 'three attempts');
  assert.equal(settleDelayMs, 250, '250 ms between attempts');
  assert.ok((settleAttempts - 1) * settleDelayMs <= 1500, 'added wait stays under the 1.5 s envelope');
  assert.match(settleHelperSource, /if \(attempt\) await sleep\(TYPING_READBACK_DELAY_MS\);/);
  assert.match(settleHelperSource, /readbackMatches\(after\?\.draft\?\.text, prompt\)/, 'settles on the page draft');
  assert.doesNotMatch(settleHelperSource, /while \(/, 'bounded for-loop only');
  // No deadline is read or extended by the loop.
  assert.doesNotMatch(settleHelperSource, /Date\.now|deadline|timeout/i);
});

test('fixture: both call-site variants settle identically for the same read sequence', async () => {
  const prompt = 'line one\nline two';
  const drafts = ['line one\nline TWO', prompt];
  for (const composer of [contenteditableComposer(prompt), textareaComposer(prompt)]) {
    const step = await adapterTypeStep({ prompt, composer, drafts });
    assert.equal(step.ok, true, `settles for ${composer.value === undefined ? 'contenteditable' : 'textarea'}`);
    assert.equal(step.reads, 2);
  }
});

test('fixture: no automatic resend on any failure path', async () => {
  const prompt = 'line one\nline two';
  const failures = [
    await followupPath({ prompt, composer: contenteditableComposer(prompt), drafts: ['line one\nline two\n\n'] }),
    await followupPath({ prompt, composer: contenteditableComposer('other') }),
    await followupPath({ prompt, composer: contenteditableComposer(''), insertionFails: true }),
    await followupPath({ prompt, composer: contenteditableComposer(prompt), drafts: ['line one\nline TWO'] }),
  ];
  for (const failure of failures) {
    assert.equal(failure.code, 'TYPING_INTERRUPTED');
    assert.deepEqual(failure.calls, { type: 1, submit: 0 });
    assert.equal(failure.disposition, 'not-attempted');
  }
});

test('contract: the adapter still refuses on a bound-path mismatch after settle exhaustion', () => {
  // Static: the bound path throws TYPING_UNCONFIRMED when settle returns null, and submit remains
  // gated behind the type step throwing, so a failed settle can never reach dispatch.
  assert.match(adapterSrc, /if \(!typed\.ok \|\| !await settleTypingReadback\(pageState, prompt\)\) throw problem\('TYPING_UNCONFIRMED'\);/);
  assert.match(adapterSrc, /if \(!typed\.ok \|\| !after\) throw problem\('TYPING_UNCONFIRMED'\);/);
  assert.doesNotMatch(adapterSrc, /TYPING_UNCONFIRMED'\), \{ notDispatched/);
  // The settle loop is a bounded for-loop, never an unbounded wait.
  assert.match(settleHelperSource, /for \(let attempt = 0; attempt < TYPING_READBACK_ATTEMPTS; attempt\+\+\)/);
});
