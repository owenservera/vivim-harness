// Human-pacing layer for CDP interaction.
//
// Requirement: a real logged-in AI chat app must see a person, not a script. Everything here is
// driven through `page.send(method, params)` on an already-attached target session, exactly like
// actions.mjs, so this module stays self-contained (no project imports, only `node:` builtins).
//
// Ground rules encoded below (verified on a live rich composer):
//  - Never write `.value` / `.textContent`: ProseMirror/Lexical keep their own state, so the app
//    would never believe the text exists and Enter would silently do nothing.
//  - `Input.insertText` updates app state but emits no key events -> only a per-character fallback.
//  - Printable characters go through `Input.dispatchKeyEvent` with a real `text` payload so the
//    page receives keydown/keypress/keyup + `input`, i.e. what a keyboard produces.
//
// Every CDP call is wrapped: a failure is reported in the returned object, never thrown.

// ---------------------------------------------------------------------------------------------
// Pacing profile
// ---------------------------------------------------------------------------------------------
export const DEFAULT_PACE = Object.freeze({
  keyMinMs: 35, keyMaxMs: 110,
  wordPauseMs: [70, 190], sentencePauseMs: [220, 520],
  thinkPauseEveryChars: 24, thinkPauseMs: [300, 800],
  preSendPauseMs: [700, 1900], mouseMoveSteps: [8, 22],
});

const msg = (e) => String(e && e.message ? e.message : e);

function paceOf(pace) {
  return { ...DEFAULT_PACE, ...(pace && typeof pace === 'object' ? pace : {}) };
}

// ---------------------------------------------------------------------------------------------
// Timing primitives
// ---------------------------------------------------------------------------------------------

// Inclusive integer draw from [range[0], range[1]]; order-tolerant, never NaN.
export function jitter(range) {
  const raw = Array.isArray(range) ? range : [0, Number(range)];
  let lo = Number(raw[0]);
  let hi = Number(raw[1]);
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = lo;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const loI = Math.ceil(a);
  const hiI = Math.floor(b);
  if (hiI <= loI) return Math.round(a);
  return loI + Math.floor(Math.random() * (hiI - loI + 1));
}

export function sleepMs(ms) {
  const n = Number(ms);
  const wait = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

// ---------------------------------------------------------------------------------------------
// In-page probes (read-only; never mutate the page)
// ---------------------------------------------------------------------------------------------
const IS_EDITABLE = `(el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true || el.getAttribute('role') === 'textbox')`;
const PICK_EDITABLE = `document.querySelector('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')`;

const READ_COMPOSER = String.raw`(() => {
  const ed = ${IS_EDITABLE};
  let el = globalThis.__aionDrive && globalThis.__aionDrive.el;
  if (!el || !el.isConnected) {
    const a = document.activeElement;
    if (ed(a)) el = a;
  }
  if (!el || !el.isConnected) el = ${PICK_EDITABLE};
  if (!el) return '';
  if (typeof el.value === 'string') return String(el.value);
  return String(el.innerText != null ? el.innerText : (el.textContent != null ? el.textContent : ''));
})()`;

const ENSURE_FOCUS = String.raw`(() => {
  const ed = ${IS_EDITABLE};
  const a = document.activeElement;
  if (ed(a)) return { ok: true, already: true };
  let el = globalThis.__aionDrive && globalThis.__aionDrive.el;
  if (!el || !el.isConnected) el = ${PICK_EDITABLE};
  if (!el) return { ok: false, already: false };
  try { el.focus({ preventScroll: true }); } catch (e) { /* detached or read-only */ }
  const now = document.activeElement;
  return { ok: !!ed(now) && (now === el || el.contains(now)), already: false };
})()`;

const READ_ENV = String.raw`(() => ({
  webdriver: (typeof navigator !== 'undefined' && 'webdriver' in navigator) ? navigator.webdriver : null,
  hasFocus: (typeof document !== 'undefined' && typeof document.hasFocus === 'function') ? document.hasFocus() : null,
  ua: (typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : ''),
}))()`;

async function evaluate(page, expression) {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'Runtime.evaluate failed');
  }
  return r && r.result ? r.result.value : undefined;
}

async function tryEval(page, expression) {
  try { return { ok: true, value: await evaluate(page, expression) }; }
  catch (e) { return { ok: false, error: msg(e) }; }
}

const normText = (v) => String(v == null ? '' : v).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

async function readComposerText(page) {
  const r = await tryEval(page, READ_COMPOSER);
  return r.ok ? String(r.value == null ? '' : r.value) : '';
}

// ---------------------------------------------------------------------------------------------
// Keymap: a printable char -> the CDP key description a physical keyboard would report.
// ---------------------------------------------------------------------------------------------
const PUNCT = {
  '.': { key: '.', code: 'Period', vk: 46 },
  ',': { key: ',', code: 'Comma', vk: 44 },
  '!': { key: '!', code: 'Digit1', vk: 49, shift: true, base: '1' },
  '?': { key: '?', code: 'Slash', vk: 191, shift: true, base: '/' },
  "'": { key: "'", code: 'Quote', vk: 222 },
  '-': { key: '-', code: 'Minus', vk: 189 },
  ':': { key: ':', code: 'Semicolon', vk: 186, shift: true, base: ';' },
  ';': { key: ';', code: 'Semicolon', vk: 186 },
};

function keyFor(ch) {
  if (/^[a-z]$/.test(ch)) {
    return { key: ch, code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), text: ch, unmodifiedText: ch, modifiers: 0 };
  }
  if (/^[A-Z]$/.test(ch)) {
    return { key: ch, code: 'Key' + ch, vk: ch.charCodeAt(0), text: ch, unmodifiedText: ch.toLowerCase(), modifiers: 8 };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: 'Digit' + ch, vk: ch.charCodeAt(0), text: ch, unmodifiedText: ch, modifiers: 0 };
  }
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, text: ' ', unmodifiedText: ' ', modifiers: 0 };
  if (ch === '\n') return { key: 'Enter', code: 'Enter', vk: 13, text: '\r', unmodifiedText: '\r', modifiers: 0 };
  const p = PUNCT[ch];
  if (p) return { key: p.key, code: p.code, vk: p.vk, text: ch, unmodifiedText: p.base || ch, modifiers: p.shift ? 8 : 0 };
  return null;
}

const BACKSPACE = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };

// keyDown (no text) + char (with text) + keyUp.
//
// Measured on Chrome 155 (see scripts/human-check.mjs and the CDP key-event matrix):
//   keyDown{text} + char{text} + keyUp -> the character is inserted TWICE ("TThhee") and a
//                                            prompt is submitted TWICE.
//   keyDown{text} + keyUp              -> letters insert, but punctuation is LOST (the trailing
//                                            "." never reaches the composer).
//   keyDown{no text} + char{text} + keyUp -> exactly one insert, and the page sees the full
//                                            keydown -> keypress -> keyup -> input sequence a
//                                            physical keyboard produces. This is the shape used.
async function dispatchChar(page, ch) {
  const k = keyFor(ch);
  const base = {
    key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    modifiers: k.modifiers,
  };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: k.text, unmodifiedText: k.unmodifiedText });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function dispatchBackspace(page) {
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: BACKSPACE.key, code: BACKSPACE.code,
    windowsVirtualKeyCode: BACKSPACE.windowsVirtualKeyCode, nativeVirtualKeyCode: BACKSPACE.nativeVirtualKeyCode,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: BACKSPACE.key, code: BACKSPACE.code,
    windowsVirtualKeyCode: BACKSPACE.windowsVirtualKeyCode, nativeVirtualKeyCode: BACKSPACE.nativeVirtualKeyCode,
  });
}

// ---------------------------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------------------------
export async function humanType(page, text, { pace = DEFAULT_PACE, human = false, beforeInsert } = {}) {
  const startedAt = Date.now();
  const p = paceOf(pace);
  const s = String(text == null ? '' : text);
  const stats = { chars: s.length, durationMs: 0, pauses: 0, corrections: 0, methodCounts: { key: 0, insertText: 0 } };
  const errors = [];

  if (!s) {
    return { ok: false, typed: '', method: 'none', stats, errors: ['nothing to type'], reason: 'empty text' };
  }

  // A composer must be focused or every key event goes nowhere. Fails soft: the caller may have
  // already focused it, and a detached/absent composer is reported through `ok` after read-back.
  const focus = await tryEval(page, ENSURE_FOCUS);
  if (!focus.ok) errors.push(`focus probe failed: ${focus.error}`);
  else if (!focus.value || !focus.value.ok) errors.push('no focusable composer found; keys may be discarded');

  // Local-owner default: a single CDP insertion, followed by a read-only
  // composer verification. No random pauses, fabricated typos or per-key sleeps.
  // If insertion status is uncertain, do NOT inject again: a second write could
  // double the draft. The caller receives an explicit failure instead.
  if (!human) {
    if (beforeInsert) await beforeInsert();
    try {
      await page.send('Input.insertText', { text: s });
      stats.methodCounts.insertText++;
    } catch (e) {
      errors.push('bulk insertion not confirmed: ' + msg(e));
    }
    const typed = await readComposerText(page);
    const want = normText(s);
    const probe = want.slice(-Math.min(28, want.length));
    const ok = errors.length === 0 && !!probe && normText(typed).includes(probe);
    if (!ok) errors.push('composer did not confirm inserted text; no automatic replay');
    stats.durationMs = Date.now() - startedAt;
    return { ok, typed, method: 'insertText', stats, errors,
      reason: ok ? undefined : 'bulk insertion unconfirmed; inspect the composer before trying again' };
  }

  // One deliberate slip in a longer text: people mistype, notice, and backspace.
  const typoAt = human && s.length >= 20 ? 6 + jitter([0, Math.max(0, Math.floor(s.length * 0.5) - 6)]) : -1;
  let corrected = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (human && i === typoAt && !corrected && !'.!?'.includes(ch)) {
      const pool = 'etaoinshrdlucmfwypvbgkjqxz'.split('').filter((c) => c !== ch.toLowerCase());
      const wrong = pool[jitter([0, pool.length - 1])] || 'x';
      try {
        await dispatchChar(page, wrong);
        stats.methodCounts.key += 1;
        await sleepMs(jitter([120, 260]));
        await dispatchBackspace(page);
        stats.corrections += 1;
        // The person notices the slip before continuing: without this pause the Backspace and the
        // next real character land within a few ms, which reads as machine output.
        await sleepMs(jitter([180, 460]));
      } catch (e) {
        errors.push(`typo simulation failed: ${msg(e)}`);
      }
      corrected = true;
    }

    const mapped = !!keyFor(ch);
    let extra = 0;
    try {
      if (mapped) {
        await dispatchChar(page, ch);
        stats.methodCounts.key += 1;
      } else {
        // No physical key on a US layout maps to this code point: fall back for this single char.
        await page.send('Input.insertText', { text: ch });
        stats.methodCounts.insertText += 1;
      }
    } catch (e) {
      errors.push(`key dispatch failed at char ${i} (${JSON.stringify(ch)}): ${msg(e)}`);
      continue;
    }

    let delay = 15;
    if (human) {
      delay = jitter([p.keyMinMs, p.keyMaxMs]);
      if (ch === ' ') { extra += jitter(p.wordPauseMs); stats.pauses += 1; }
      else if ('.!?'.includes(ch)) { extra += jitter(p.sentencePauseMs); stats.pauses += 1; }
    }
    await sleepMs(delay + extra);

    const every = Number(p.thinkPauseEveryChars) || 0;
    if (human && every > 0 && (i + 1) % every === 0) {
      await sleepMs(jitter(p.thinkPauseMs));
      stats.pauses += 1;
    }
  }

  const typed = await readComposerText(page);
  const want = normText(s);
  const probe = want.slice(-Math.min(28, want.length));
  const ok = !!probe && normText(typed).includes(probe);
  if (!ok) errors.push(`composer does not contain the tail of the typed text (${String(typed).length} chars present)`);
  stats.durationMs = Date.now() - startedAt;

  const key = stats.methodCounts.key;
  const ins = stats.methodCounts.insertText;
  const method = key === 0 && ins === 0 ? 'none' : key >= ins ? 'key' : 'insertText';

  return {
    ok, typed, method, stats, errors,
    reason: ok ? undefined : 'typed text not verified in the composer after typing',
  };
}

// ---------------------------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------------------------
export async function humanClick(page, { x, y } = {}, { pace = DEFAULT_PACE } = {}) {
  const p = paceOf(pace);
  const errors = [];
  const tx = Number(x);
  const ty = Number(y);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return { ok: false, steps: 0, path: [], errors: ['humanClick needs numeric x and y'] };
  }
  const px = Math.round(tx);
  const py = Math.round(ty);

  // Cursor position is not observable, so the approach starts from a plausible off-target point.
  const sx = Math.max(0, px + (Math.random() < 0.5 ? -1 : 1) * jitter([140, 420]));
  const sy = Math.max(0, py + jitter([-90, 90]));
  const cx = (sx + px) / 2 + jitter([-70, 70]);
  const cy = (sy + py) / 2 + jitter([-70, 70]);
  const steps = Math.max(2, jitter(p.mouseMoveSteps));

  const path = [];
  let ok = true;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const qx = Math.round(mt * mt * sx + 2 * mt * t * cx + t * t * px);
    const qy = Math.round(mt * mt * sy + 2 * mt * t * cy + t * t * py);
    path.push({ x: qx, y: qy });
    try {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: qx, y: qy, button: 'none', buttons: 0 });
    } catch (e) {
      ok = false;
      errors.push(`mouseMoved failed at step ${i}: ${msg(e)}`);
      break;
    }
    await sleepMs(jitter([4, 18]));
  }

  if (ok) {
    try {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
      await sleepMs(jitter([35, 110]));
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
    } catch (e) {
      ok = false;
      errors.push(`press/release failed: ${msg(e)}`);
    }
  }

  return { ok, steps: path.length, path, errors };
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------
export async function humanPressEnter(page, { pace = DEFAULT_PACE } = {}) {
  const p = paceOf(pace);
  // A person hesitates before hitting send.
  await sleepMs(jitter(p.preSendPauseMs));

  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  try {
    // keyDown(no text) + char(text '\r') + keyUp. Measured on Chrome 155:
    //   keyDown{text} + char{text} + keyUp submits TWICE (the prompt was posted twice on ChatGPT);
    //   keyDown{text} + keyUp submits once but loses the text payload on some editors;
    //   keyDown(no text) + char{text} + keyUp submits exactly once and still inserts one newline
    //   in a multi-line composer, which is what a real Enter does.
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await page.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r', unmodifiedText: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return { ok: true, method: 'enter-key' };
  } catch (e) {
    return { ok: false, method: 'enter-key', reason: `Enter dispatch failed: ${msg(e)}` };
  }
}

// ---------------------------------------------------------------------------------------------
// Wheel, idle, environment
// ---------------------------------------------------------------------------------------------
export async function humanScroll(page, { deltaY = -240, steps = 6 } = {}) {
  const total = Number(deltaY) || 0;
  const n = Math.max(1, Math.floor(Number(steps) || 1));
  const share = total / n;
  let sent = 0;
  const errors = [];
  for (let i = 0; i < n; i++) {
    const chunk = i === n - 1 ? Math.round(total - share * (n - 1)) : Math.round(share);
    try {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: chunk, button: 'none', buttons: 0 });
      sent += 1;
    } catch (e) {
      errors.push(`mouseWheel failed at step ${i + 1}: ${msg(e)}`);
      break;
    }
    await sleepMs(jitter([25, 90]));
  }
  return { ok: sent === n, steps: sent, errors };
}

// A short "reading" hold so consecutive actions are not back-to-back instantaneous.
// `pace` is accepted for signature symmetry with the other helpers; the reading hold stays inside
// the documented 400-1200 ms band.
export async function humanIdle(page, { pace = DEFAULT_PACE } = {}) {
  void pace;
  const ms = jitter([400, 1200]);
  await sleepMs(ms);
  return { ok: true, ms };
}

// Focus/paint hints that make an attached tab behave like a foreground window, then report what
// the page actually sees. Deliberately does NOT spoof the UA or set automation overrides.
export async function prepareHumanEnvironment(page, { focus = true } = {}) {
  const notes = [];

  if (focus) {
    try { await page.send('Page.bringToFront', {}); }
    catch (e) { notes.push(`Page.bringToFront unavailable: ${msg(e)}`); }

    try { await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
    catch (e) { notes.push(`Emulation.setFocusEmulationEnabled unavailable: ${msg(e)}`); }
  }

  let webdriver = null;
  let hasFocus = null;
  let ua = null;
  const probe = await tryEval(page, READ_ENV);
  if (probe.ok && probe.value) {
    webdriver = probe.value.webdriver === undefined ? null : probe.value.webdriver;
    hasFocus = probe.value.hasFocus === undefined ? null : probe.value.hasFocus;
    ua = probe.value.ua == null ? null : String(probe.value.ua);
  } else if (!probe.ok) {
    notes.push(`environment probe failed: ${probe.error}`);
  }

  if (webdriver === true) notes.push('navigator.webdriver is true: the page can detect automation');
  if (hasFocus === false) notes.push('document.hasFocus() is false: the tab is not the foreground window');

  return { webdriver, hasFocus, ua, notes };
}
