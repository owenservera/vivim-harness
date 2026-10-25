// Interaction primitives for driving a live AI web app through CDP.
//
// Design: the generic heuristics below are the primary mechanism and must work with no adapter
// at all; site adapters (src/profiles/sites/<id>.mjs) only refine selector choice. Everything
// here runs over an already-attached page session (the object Recorder exposes as `recorder.page`),
// so `page.send(method, params)` is the only capability assumed.
//
// The chosen composer is remembered in page state (`globalThis.__aionDrive`), never by mutating
// the page's DOM: no marker attributes, no injected elements.
import path from 'node:path';
import { CdpConnection, sleep } from '../cdp/client.mjs';
import { listTargets, browserWsUrl } from '../cdp/discovery.mjs';
import { dataPaths, defaultDataDir, ensureDataDirs } from '../config.mjs';
import { ProfileStore } from '../profiles/profiles.mjs';
import { Recorder } from './recorder.mjs';
import { humanType, humanPressEnter, humanClick, humanIdle, prepareHumanEnvironment, DEFAULT_PACE } from './human.mjs';
import { acquireDriveLease } from './drive-lease.mjs';

// ---------------------------------------------------------------------------------------------
// Shared in-page helpers. Kept free of template-literal syntax so it can be embedded verbatim.
// ---------------------------------------------------------------------------------------------
const IN_PAGE = String.raw`
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 1 && r.height > 1)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    return true;
  };
  const txt = (el) => String(el.innerText ?? el.textContent ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const store = (el, kind, tag) => { globalThis.__aionDrive = { el: el, kind: kind, tag: tag, at: Date.now() }; return globalThis.__aionDrive; };
  const live = () => { const s = globalThis.__aionDrive; return s && s.el && s.el.isConnected ? s.el : null; };
`;

const norm = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------
export async function evaluate(page, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description ?? d.text ?? 'Runtime.evaluate failed');
  }
  return returnByValue ? r?.result?.value : r?.result;
}

async function tryEval(page, expression) {
  try { return { ok: true, value: await evaluate(page, expression) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

// ---------------------------------------------------------------------------------------------
// Composer discovery + focus
// ---------------------------------------------------------------------------------------------
export async function findComposer(page, adapter = null) {
  const selectors = Array.isArray(adapter?.composer?.selectors) ? adapter.composer.selectors : [];
  const expr = String.raw`(() => { ${IN_PAGE}
    const adapterSels = ${JSON.stringify(selectors)};
    const kindOf = (el) => el.tagName === 'TEXTAREA' ? 'textarea'
      : el.tagName === 'INPUT' ? 'input'
      : el.isContentEditable ? 'contenteditable'
      : 'textbox';
    const blocked = (el) => el.disabled === true || el.readOnly === true || el.getAttribute('aria-disabled') === 'true';
    const usable = (el) => vis(el) && !blocked(el);

    for (const sel of adapterSels) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { els = []; }
      for (const el of els) {
        if (!usable(el)) continue;
        store(el, kindOf(el), el.tagName.toLowerCase());
        return { found: true, kind: kindOf(el), tag: el.tagName.toLowerCase(), reason: 'adapter selector: ' + sel };
      }
    }

    const genericSels = ['textarea', '[contenteditable="true"]', '[contenteditable=""]', '[role="textbox"]'];
    const cands = [];
    for (const sel of genericSels) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const el of els) {
        if (!usable(el)) continue;
        if (el.closest('dialog,[aria-hidden="true"]')) continue;
        const r = el.getBoundingClientRect();
        cands.push({ el: el, area: r.width * r.height, sel: sel });
      }
    }
    if (!cands.length) {
      globalThis.__aionDrive = null;
      return { found: false, kind: null, tag: null, reason: 'no visible composer matched (adapter selectors and generic heuristic both failed)' };
    }
    cands.sort((a, b) => b.area - a.area);
    const pick = cands[0].el;
    store(pick, kindOf(pick), pick.tagName.toLowerCase());
    return { found: true, kind: kindOf(pick), tag: pick.tagName.toLowerCase(), reason: 'generic heuristic: ' + cands[0].sel + ' (' + cands.length + ' candidate(s))' };
  })()`;
  const r = await tryEval(page, expr);
  if (!r.ok) return { found: false, kind: null, tag: null, reason: `composer probe failed: ${r.error}` };
  return r.value ?? { found: false, kind: null, tag: null, reason: 'composer probe returned nothing' };
}

// Browsers need a moment after navigation: retry discovery until a deadline instead of failing
// on the first paint (a tab opened with /json/new returns before the app has mounted its composer).
export async function waitForComposer(page, adapter = null, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let last = null;
  for (;;) {
    last = await findComposer(page, adapter);
    if (last?.found) return { ...last, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) };
    if (Date.now() >= deadline) {
      return { ...(last ?? { found: false, kind: null, tag: null }), timedOut: true, reason: `${last?.reason ?? 'no composer'} (waited ${timeoutMs} ms)` };
    }
    await sleep(intervalMs);
  }
}

// `target` may be a findComposer() result, an adapter, or nothing at all.
export async function focusComposer(page, target = null) {
  const found = target && typeof target === 'object' && 'found' in target
    ? target
    : await findComposer(page, target && target.composer ? target : null);
  if (!found?.found) return { ok: false, method: null, reason: found?.reason ?? 'no composer found' };

  const box = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    const el = live(); if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height };
  })()`);

  const b = box.ok ? box.value : null;
  let method = 'focus';
  if (b && b.w > 1) {
    try {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      method = 'click+focus';
    } catch { method = 'focus'; }
  }

  const st = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    const el = live(); if (!el) return { ok: false };
    try { el.focus({ preventScroll: true }); } catch (e) { /* read-only or detached */ }
    const a = document.activeElement;
    const ok = a === el || (a && el.contains(a));
    return { ok: !!ok, tag: el.tagName.toLowerCase() };
  })()`);
  return { ok: !!(st.ok && st.value?.ok), method, tag: st.value?.tag ?? found.tag, reason: st.ok ? undefined : st.error };
}

async function composerText(page) {
  const r = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    const el = live(); if (!el) return '';
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? String(el.value ?? '') : String(el.innerText ?? el.textContent ?? '');
  })()`);
  return r.ok ? String(r.value ?? '') : '';
}

// Clear a composer that still holds a draft (select-all + Backspace as real key input).
export async function clearComposer(page) {
  const before = await composerText(page);
  if (!norm(before)) return { ok: true, cleared: false, before: '' };
  const ctrl = { modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, key: 'a', code: 'KeyA' };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ctrl });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrl });
  await sleep(120);
  const bs = { windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...bs });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...bs });
  await sleep(250);
  const after = await composerText(page);
  return { ok: !norm(after), cleared: true, before, after };
}

// ---------------------------------------------------------------------------------------------
// Typing (human-paced real key input) + sending
// ---------------------------------------------------------------------------------------------
// Human-paced typing. Real key input (Input.dispatchKeyEvent per character, keyDown+keyUp) is
// used instead of setting value/textContent, because rich composers (ProseMirror, Lexical, Slate)
// keep their own editor state: a DOM write shows text the app does not believe exists, so Enter
// silently does nothing. The pacing itself lives in src/capture/human.mjs.
export async function typeText(page, text, { human = true, pace = DEFAULT_PACE, beforeInsert } = {}) {
  const s = String(text ?? '');
  if (!s) return { ok: false, typed: '', method: 'none' };

  const focus = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    let el = live();
    if (!el) {
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable || a.getAttribute('role') === 'textbox')) el = a;
    }
    if (!el) return { ok: false };
    store(el, el.isContentEditable ? 'contenteditable' : 'value', el.tagName.toLowerCase());
    try { el.focus({ preventScroll: true }); } catch (e) { /* read-only or detached */ }
    return { ok: true, kind: el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase() };
  })()`);
  if (!focus.ok || !focus.value?.ok) return { ok: false, typed: '', method: 'none', reason: focus.ok ? 'no composer focused or remembered' : focus.error };

  const before = await composerText(page);
  const res = await humanType(page, s, { pace, human, beforeInsert });
  const after = res.typed ?? await composerText(page);
  return {
    ok: !!res.ok,
    typed: after,
    method: res.method,
    kind: focus.value?.kind ?? null,
    expectedChars: s.length,
    grewBy: String(after ?? '').length - String(before ?? '').length,
    stats: res.stats ?? null,
    reason: res.reason,
    errors: res.errors ?? [],
  };
}

// One click attempt. `dispatched` is true as soon as an input event was handed to the page, so a
// later error means "attempted, outcome unknown" rather than "nothing happened".
async function clickStoredOnce(page, globalName, { canDispatch } = {}) {
  const box = await tryEval(page, String.raw`(() => { const el = globalThis.${globalName}; if (!el || !el.isConnected) return null;
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width }; })()`);
  const b = box.ok ? box.value : null;
  if (!b || !(b.w > 1)) return { dispatched: false, error: box.ok ? 'control has no visible box' : box.error };
  let dispatched = false;
  let dispatchError = null;
  if (canDispatch && !canDispatch()) return { dispatched: false, error: 'SUBMISSION_STOPPED' };
  try {
    dispatched = true;
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  } catch (e) { dispatchError = e; }
  // Release once even when the press acknowledgement was lost. Never press again.
  try {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  } catch (e) { dispatchError ??= e; }
  return { dispatched, ...(dispatchError ? { error: String(dispatchError?.message ?? dispatchError) } : {}) };
}

async function clickStored(page, globalName) {
  const r = await clickStoredOnce(page, globalName);
  return r.dispatched && !r.error;
}

async function pressEnter(page) {
  // keyDown(no text) + char('\r') + keyUp: exactly one submit, and one newline in a multi-line
  // composer. The keyDown{text}+char{text} shape submits twice (ChatGPT received the prompt
  // twice); keyDown{text} alone loses the payload on some editors.
  const base = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' };
  let dispatchError = null;
  try {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await page.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r', unmodifiedText: '\r' });
  } catch (e) { dispatchError = e; }
  // A release carries no text and is cleanup, not another submit attempt. Try it only once.
  try { await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }); }
  catch (e) { dispatchError ??= e; }
  if (dispatchError) throw dispatchError;
}

// Read-only waits (ms) after the single dispatch. They only OBSERVE; nothing is ever sent again.
const SEND_OBSERVE_WAITS = Object.freeze([900, 1200, 1500]);

// Finds a visible, enabled send button from the adapter's selectors and remembers it in page state.
export async function findSendButton(page, adapter = null) {
  const btn = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    const sels = ${JSON.stringify(Array.isArray(adapter?.send?.buttonSelectors) ? adapter.send.buttonSelectors : [])};
    for (const sel of sels) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const el of els) {
        if (!vis(el)) continue;
        const b = el.closest('button,[role="button"],input[type="submit"]') || el;
        if (b.disabled === true) continue;
        if (b.getAttribute('aria-disabled') === 'true') continue;
        globalThis.__aionSendBtn = b;
        return { found: true, selector: sel, tag: b.tagName.toLowerCase() };
      }
    }
    globalThis.__aionSendBtn = null;
    return { found: false };
  })()`);
  return btn.ok ? btn.value : { found: false, error: btn.error };
}

// Submit once. Policy (no retry, no second method):
//   1. PREFLIGHT, read-only: the composer must be readable and hold text. Otherwise nothing is dispatched.
//   2. Choose exactly ONE method: strategy "button" needs a valid, enabled button (no silent Enter);
//      every other strategy ("enter", "both") presses Enter.
//   3. Dispatch it once. An error from the dispatch is NOT proof that nothing was sent (the key or
//      mouse events may have reached the page), so it never triggers another method.
//   4. OBSERVE read-only against the preflight baseline. Lack of attributable evidence is
//      `uncertain`, not "not sent". This reports what was observed, not exactly-once delivery.
// `deps` is an optional seam for deterministic tests; production uses the defaults.
export async function sendMessage(page, adapter = null, deps = {}) {
  const d = {
    sendState, findSendButton, pressEnter, sleep,
    clickSendButton: (p) => clickStoredOnce(p, '__aionSendBtn', { canDispatch: deps.canDispatch }),
    observeWaits: SEND_OBSERVE_WAITS,
    ...deps,
  };
  const strategy = adapter?.send?.strategy ?? 'both';
  const notAttempted = (method, reason) => ({ ok: false, sent: false, method, dispatched: false, sendStatus: 'not-attempted', uncertain: false, reason });
  // Learned (adapter-factory) adapters are data-only and read-only by construction; their
  // strategy is an explicit refusal so they can never become a send path, even by accident.
  if (strategy === 'learned-readonly') return notAttempted('preflight', 'learned data-only adapter does not grant send permission (adapter authority: sendPermission=false)');

  let before;
  try { before = await d.sendState(page, adapter); }
  catch { return notAttempted('preflight', 'composer state unreadable'); }
  if (!before?.evalOk) return notAttempted('preflight', `composer state unreadable: ${before?.reason ?? 'unknown'}`);
  if (!(before.draftChars > 0)) return notAttempted('preflight', 'composer is empty: nothing to send');

  let method = 'enter';
  if (strategy === 'button') {
    let button;
    try { button = await d.findSendButton(page, adapter); }
    catch { return notAttempted('button', 'send button inspection failed'); }
    if (!button?.found) return notAttempted('button', 'strategy is "button" but no visible, enabled send button was found; not falling back to Enter');
    method = 'button';
  }

  let dispatchError = null;
  // Final synchronous latch; button dispatch also rechecks after its asynchronous box lookup.
  if (d.beforeDispatch) await d.beforeDispatch();
  if (d.canDispatch && !d.canDispatch()) return notAttempted(method, 'SUBMISSION_STOPPED');
  try {
    if (method === 'enter') {
      await d.pressEnter(page);
    } else {
      const c = await d.clickSendButton(page);
      if (c?.error) dispatchError = String(c.error);
      if (!c?.dispatched) return notAttempted('button', `send button was not clicked: ${dispatchError ?? 'unknown'}`);
    }
  } catch (e) {
    dispatchError = String(e?.message ?? e); // attempted, outcome unknown: observe, never retry
  }

  let after = null;
  for (const wait of d.observeWaits) {
    try {
      await d.sleep(wait);
      after = await d.sendState(page, adapter, before);
    } catch { after = { sent: false, evalOk: false, reason: 'send observation unavailable' }; }
    if (after?.evalOk && after?.sent) break;
  }
  const observed = !!(after?.evalOk && after?.sent);
  const detail = after?.reason ?? 'no observation';
  return {
    ...after,
    sent: observed,
    ok: observed,
    method,
    dispatched: true,
    sendStatus: observed ? 'observed' : 'uncertain',
    uncertain: !observed,
    ...(dispatchError ? { dispatchError } : {}),
    reason: observed || !dispatchError ? detail : `dispatch error (${dispatchError}); ${detail}`,
  };
}

// Conservative page-level send observation against the actual pre-dispatch snapshot. This is not
// durable turn attribution/acceptance: the conversation adapter must supply that separately.
// Empty composer, disabled controls, body growth or pre-existing streaming alone prove nothing.
export async function sendState(page, adapter = null, before = null) {
  const state = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    let composer = live();
    if (!composer) {
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable)) composer = a;
    }
    // Missing/unreadable composer is unknown, not an empty composer.
    if (!composer || !vis(composer)) return { evalOk: false };
    const text = String(composer.value ?? composer.innerText ?? composer.textContent ?? '');
    const TURN_SEL = [
      '[data-message-author-role]',
      '[data-content-search-unit-key$="user"]',
      '[data-content-search-unit-key$="assistant"]',
      '[data-testid="user-message"]',
      '[data-testid*="assistant" i]',
      '[data-markdown-text-style]',
      'article',
      'div.ds-markdown',
      'div[class*="markdown"]',
    ].join(',');
    let turns = 0;
    turns = document.querySelectorAll(TURN_SEL).length;
    const root = document.querySelector('main') || document.body;
    const bodyLen = String((root && root.innerText) || '').length;
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(vis);
    const sendDisabled = buttons.some((b) => {
      const l = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
      if (!/send|发送|submit|发送消息/.test(l)) return false;
      return b.disabled === true || b.getAttribute('aria-disabled') === 'true';
    });
    return { evalOk: true, text: text, turns: turns, bodyLen: bodyLen, sendDisabled: sendDisabled };
  })()`);
  const s = state.value;
  if (!state.ok || s?.evalOk !== true || typeof s.text !== 'string'
    || !Number.isSafeInteger(s.turns) || s.turns < 0 || !Number.isSafeInteger(s.bodyLen) || s.bodyLen < 0 || typeof s.sendDisabled !== 'boolean') {
    return { evalOk: false, draftChars: null, sent: false, cleared: false, streaming: null,
      turns: null, bodyLen: null, sendDisabled: null, reason: 'composer state unreadable; delivery unknown' };
  }
  const draftChars = norm(s.text).length;
  const cleared = !norm(s.text);
  let streaming = null;
  try {
    const stream = await isStreaming(page, adapter);
    if (!String(stream.evidence ?? '').startsWith('streaming check failed:')) streaming = stream.streaming;
  } catch { /* unreadable streaming state stays unknown, never a false -> true transition */ }
  const baseline = before?.evalOk === true && Number.isSafeInteger(before.draftChars) && before.draftChars > 0
    && Number.isSafeInteger(before.turns) && typeof before.streaming === 'boolean';
  const draftDecreased = baseline && draftChars < before.draftChars;
  const newTurn = baseline && s.turns > before.turns;
  const startedStreaming = baseline && before.streaming === false && streaming;
  const sent = !!(baseline && (newTurn && (draftDecreased || startedStreaming) || startedStreaming && draftDecreased));
  return {
    evalOk: true,
    draftChars,
    sent,
    cleared,
    streaming,
    turns: s.turns,
    bodyLen: s.bodyLen,
    sendDisabled: s.sendDisabled,
    reason: sent
      ? (newTurn ? 'new turn appeared with changed composer or new streaming' : 'response started with changed composer')
      : before ? 'no corroborated change after the send; delivery unknown' : 'preflight snapshot; no submission inferred',
  };
}

// ---------------------------------------------------------------------------------------------
// Transcript + streaming state
// ---------------------------------------------------------------------------------------------
export async function readTranscript(page, adapter = null, { exclude = [] } = {}) {
  const excluded = (Array.isArray(exclude) ? exclude : [exclude])
    .map((x) => String(x ?? '').replace(/\s+/g, ' ').trim())
    .filter((x) => x.length >= 8);
  const r = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    const turns = [];
    const seen = new Set();
    // The prompt we sent is not an answer. Its own text must not count as new content.
    const EXCLUDED = ${JSON.stringify(excluded)};
    const push = (role, text) => {
      const t = String(text || '').trim();
      if (!t) return;
      const key = role + ':' + t.slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      turns.push({ role: role, text: t });
    };
    // The COUNT is how many elements matched, NOT how many distinct texts they had: the
    // calibration prompt always produces the same words, so a new answer can be byte-identical
    // to the previous one and must still be counted as new content.
    // The LAST is the last element with real text: a message is often followed by empty wrapper
    // elements, and taking the literal last one returned an empty reply (Claude) or a button
    // label (Qwen).
    const collect = (els) => {
      const composer = live();
      // The composer's own region is not the answer: Claude's send control is labelled "Reply"
      // and lives inside the composer's form, so it matched the answer container and was read
      // back instead of the reply.
      // The region is the composer's own form ONLY. A loose class match (any ancestor whose
      // class mentions "composer") excluded ChatGPT's whole transcript, because its thread
      // layout carries a Tailwind class that mentions data-composer-expand-toggle.
      const composerForm = composer && composer.closest ? composer.closest('form') : null;
      const inComposer = (el) => {
        if (composer && (el === composer || el.contains(composer) || composer.contains(el))) return true;
        if (composerForm && composerForm.contains(el)) return true;
        return !!(el.closest && el.closest('[data-testid="chat-input"], [data-testid="chat-input-container"]'));
      };
      // The prompt we sent is not an answer either, in any container: z.ai rendered the
      // question inside its answer container and it was read back as the reply. The prompt is
      // STRIPPED rather than the whole block dropped, because ChatGPT renders one turn as
      // "Tú dijiste: <prompt> ChatGPT dijo: <answer>" and the answer must survive.
      // Only the forward direction is safe: the calibration ANSWER is a substring of the
      // PROMPT ("...nothing else: alpha bravo ... lima"), so comparing the other way round
      // would throw the real answer away.
      const stripPrompt = (text) => {
        let flat = String(text || '').replace(/\s+/g, ' ').trim();
        if (!flat) return '';
        for (const x of EXCLUDED) {
          if (flat.includes(x)) flat = flat.split(x).join(' ').replace(/\s+/g, ' ').trim();
        }
        return flat;
      };
      const shown = els.filter((el) => vis(el) && !inComposer(el));
      const texts = shown.map((el) => stripPrompt(txt(el))).filter((t) => t.length >= 4);
      for (const t of texts) push('assistant', t);
      const meaningful = texts.filter((t) => t.length >= 8);
      return {
        count: meaningful.length,
        last: meaningful.length ? meaningful[meaningful.length - 1] : (texts[texts.length - 1] ?? ''),
      };
    };

    const authored = [...document.querySelectorAll('[data-message-author-role]')];
    if (authored.length) {
      const asstEls = authored.filter((el) => {
        const role = el.getAttribute('data-message-author-role');
        return role === 'assistant' && vis(el);
      });
      const asstTexts = asstEls.map((el) => txt(el));
      for (const t of asstTexts) push('assistant', t);
      const meaningful = asstTexts.filter((t) => t.length >= 8);
      if (meaningful.length) {
        return { turns: turns, last: meaningful[meaningful.length - 1], count: meaningful.length, reason: 'data-message-author-role' };
      }
    }
    turns.length = 0; seen.clear();

    for (const sel of ${JSON.stringify(Array.isArray(adapter?.assistant?.containerSelectors) ? adapter.assistant.containerSelectors : [])}) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      const c = collect(els);
      if (c.count) return { turns: turns, last: c.last, count: c.count, reason: 'adapter containers: ' + sel };
    }

    {
      const els = [...document.querySelectorAll('[data-testid*="assistant" i]')];
      const c = collect(els);
      if (c.count) return { turns: turns, last: c.last, count: c.count, reason: 'data-testid assistant' };
    }

    // Modern chat UIs no longer use data-message-author-role. ChatGPT (2026) marks a rendered
    // answer with data-markdown-text-style="assistant-message" and wraps the turn in
    // data-content-search-unit-key="...:assistant"; the user turn uses the same key with
    // ":user". Claude/Gemini style UIs use their own data-testid variants.
    const assistantSels = [
      '[data-markdown-text-style="assistant-message"]',
      '[data-content-search-unit-key$="assistant"]',
      '[data-chatgpt-search-unit-key$="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-testid="assistant-message"]',
      '[data-testid*="assistant-turn" i]',
      '[data-testid*="model-response" i]',
    ];
    for (const sel of assistantSels) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      const c = collect(els);
      if (c.count) return { turns: turns, last: c.last, count: c.count, reason: 'assistant container: ' + sel };
    }

    const userSels = [
      '[data-content-search-unit-key$="user"]',
      '[data-chatgpt-search-unit-key$="user"]',
      '[data-markdown-text-style="user-message"]',
      '[data-testid="user-message"]',
    ];
    for (const sel of userSels) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const el of els) { if (vis(el)) push('user', txt(el)); }
    }
    if (turns.length) {
      const lastA = [...turns].reverse().find((t) => t.role === 'assistant');
      // Only a USER turn matched: the answer container is unknown for this site, so the generic
      // fallback has to run. Returning here produced an empty reply.
      if (lastA) return { turns: turns, last: lastA.text, count: turns.length, reason: 'turn-scoped containers' };
      turns.length = 0; seen.clear();
    }

    const composer = live();
    const root = document.querySelector('main') || document.body;
    if (!root) return { turns: [], last: '', reason: 'no document body' };
    // Chrome is not the answer: a sidebar or a header (Kimi's "New chat / My Kimi / Plugins" menu)
    // is navigation, not the reply.
    // The ancestor test uses TAGS and ROLES only. Matching class names on ancestors killed the
    // answer on ChatGPT, whose transcript container sits under a Tailwind class that contains a
    // chrome word; the class-based test is applied to the element itself instead.
    const CHROME_ANCESTOR = 'nav,aside,header,footer,[role="navigation"],[role="banner"],[role="complementary"]';
    const CHROME_SELF = '[class*="sidebar"],[class*="side-bar"],[class*="navigation"],[class*="menu"],[class*="toolbar"],[class*="breadcrumb"]';
    // A status placeholder is not an answer: Qwen shows "Thinking" while it works.
    const STATUS = /^(thinking|thinking\.{0,3}|generating|generating\.{0,3}|loading|loading\.{0,3}|working|stop|stopping|cancel|思考中|正在思考|思考\.{0,3}|生成中|正在生成|加载中|\.{0,3})$/i;
    // The prompt we sent is not an answer. Its own text must not count as new content.
    const blocks = [];
    const seenText = new Set();
    const BLOCK_SEL = 'p,li,pre,blockquote,h1,h2,h3,h4,td';
    // The answer is ABOVE the composer: the footer notice ("ChatGPT can make mistakes",
    // Kimi's copyright line) sits below it and was read back as the reply.
    let composerTop = Infinity;
    let composerForm = null;
    try {
      if (composer) {
        const cr = composer.getBoundingClientRect();
        if (cr.height > 0) composerTop = cr.top + window.scrollY;
        composerForm = composer.closest ? composer.closest('form') : null;
      }
    } catch (e) { composerTop = Infinity; }
    for (const el of root.querySelectorAll(BLOCK_SEL + ',div')) {
      if (composer && (el === composer || el.contains(composer) || composer.contains(el))) continue;
      if (composerForm && composerForm.contains(el)) continue;
      if (!vis(el)) continue;
      if (composerTop !== Infinity) {
        const top = el.getBoundingClientRect().top + window.scrollY;
        if (top >= composerTop) continue;
      }
      if (el.closest(CHROME_ANCESTOR)) continue;
      if (el.matches(CHROME_SELF)) continue;
      if (el.closest('nav,aside,header,footer,script,style')) continue;
      // Interactive chrome (a "Reply" button, a link) is not the answer: on a page with no
      // recognised assistant container this fallback used to return the last button label.
      if (el.closest('button,a,[role="button"],[role="link"],input,textarea,[contenteditable]')) continue;
      // A div counts only when it is a leaf text block: some sites render the answer in a plain
      // div with a hashed class and no <p> inside (DeepSeek), so only divs that contain no
      // block-level descendant are taken, which keeps the text from being duplicated.
      if (el.tagName === 'DIV' && el.querySelector(BLOCK_SEL)) continue;
      const t = txt(el);
      if (t.length < 8) continue;
      const flat = t.replace(/\s+/g, ' ').trim();
      if (STATUS.test(flat)) continue;
      // The prompt we sent is stripped out of the text rather than the whole block dropped:
      // ChatGPT renders one turn as "Tú dijiste: <prompt> ChatGPT dijo: <answer>".
      let stripped = flat;
      for (const x of EXCLUDED) {
        if (stripped.includes(x)) stripped = stripped.split(x).join(' ').replace(/\s+/g, ' ').trim();
      }
      if (stripped.length < 8) continue;
      // The same text can appear in nested wrappers (z.ai renders the prompt seven times);
      // that is one piece of content, not seven.
      if (seenText.has(flat)) continue;
      seenText.add(flat);
      blocks.push({ t: stripped, top: el.getBoundingClientRect().top + window.scrollY });
    }
    blocks.sort((a, b) => a.top - b.top);
    // The answer is the last thing said: keep the tail of the transcript, not the whole page.
    const tail = blocks.slice(-8).map((b) => b.t).join('\n').slice(-12000);
    const last = blocks.length ? blocks[blocks.length - 1].t : '';
    if (tail) return { turns: [{ role: 'assistant', text: tail }], last: last, texts: blocks.map((b) => b.t), count: blocks.length, reason: 'generic text blocks (no assistant container matched)' };
    return { turns: [], last: '', texts: [], count: 0, reason: 'no assistant text found' };
  })()`);
  if (!r.ok) return { turns: [], last: '', texts: [], count: 0, reason: `transcript read failed: ${r.error}` };
  return { turns: r.value?.turns ?? [], last: r.value?.last ?? '', texts: r.value?.texts ?? [], count: r.value?.count ?? 0, reason: r.value?.reason ?? 'unknown' };
}

// The calibration prompt names the words it wants: "Reply with exactly these 12 words separated
// by single spaces and nothing else: alpha bravo ... lima". The answer can therefore be looked
// for in the visible text, instead of guessing which element holds it.
export function expectedWordsFromPrompt(prompt) {
  const p = String(prompt ?? '');
  const m = p.match(/nothing else:\s*([a-z0-9 ]+?)\s*$/i);
  if (!m) return null;
  const words = m[1].trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length >= 3 ? words : null;
}

// Does a text contain every expected word, in order?
export function containsWords(text, words) {
  if (!Array.isArray(words) || !words.length) return false;
  const flat = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
  let at = 0;
  for (const w of words) {
    const i = flat.indexOf(w, at);
    if (i < 0) return false;
    at = i + w.length;
  }
  return true;
}

export async function isStreaming(page, adapter = null) {
  const r = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    // English and Spanish labels: a localised UI must still be readable as "stop generating".
    const stopLabel = /stop (generating|streaming|responding|response|output|replying)|stop generation|detener (la )?(generaci|respuesta)|parar de generar/i;
    const strong = (el) => {
      const b = el.closest('button,[role="button"]');
      const label = String((b ? (b.getAttribute('aria-label') || b.innerText || '') : (el.getAttribute('aria-label') || '')) || '').trim();
      return !!b && stopLabel.test(label);
    };

    // Turn-state markers are stronger than a button label: ChatGPT marks a finished turn
    // data-talvt-turn-state="complete", so any other value means the turn is still running.
    // The element must be visible: a hidden or detached wrapper would otherwise report
    // "streaming" forever and every run would end in a timeout.
    for (const el of document.querySelectorAll('[data-talvt-turn-state]')) {
      if (!vis(el)) continue;
      const state = String(el.getAttribute('data-talvt-turn-state') || '').trim();
      if (state && state !== 'complete') return { streaming: true, evidence: 'turn state: ' + state };
    }
    for (const el of document.querySelectorAll('[data-turn-state],[data-message-state="streaming"],[data-streaming="true"]')) {
      if (!vis(el)) continue;
      return { streaming: true, evidence: 'stream state attribute: ' + (el.getAttribute('data-turn-state') || el.getAttribute('data-message-state') || el.getAttribute('data-streaming')) };
    }

    const weak = [];
    for (const sel of ${JSON.stringify(Array.isArray(adapter?.assistant?.streamingSelectors) ? adapter.assistant.streamingSelectors : [])}) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const el of els) {
        if (!vis(el)) continue;
        if (strong(el)) return { streaming: true, evidence: 'adapter selector: ' + sel };
        weak.push(sel);
      }
    }

    for (const b of document.querySelectorAll('button,[role="button"]')) {
      if (!vis(b)) continue;
      const label = String((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
      if (stopLabel.test(label)) return { streaming: true, evidence: 'stop control: ' + label.slice(0, 60) };
    }

    for (const el of document.querySelectorAll('[aria-busy="true"]')) { if (vis(el)) return { streaming: true, evidence: 'aria-busy' }; }

    // Weak matches (broad class selectors such as [class*="loading"]) are reported but not counted:
    // they are common on idle pages, and waitForCompletion's text-stability gate is authoritative.
    return { streaming: false, evidence: weak.length ? 'weak match only (' + weak.slice(0, 3).join(', ') + '); text stability decides' : 'none' };
  })()`);
  if (!r.ok) return { streaming: false, evidence: `streaming check failed: ${r.error}` };
  return { streaming: !!r.value?.streaming, evidence: r.value?.evidence ?? 'none' };
}

export async function waitForCompletion(page, adapter = null, { timeoutMs = 120000, stableMs = 2500, pollMs = 400, baseline = null, baseCount = null, exclude = [], signal, onUpdate } = {}) {
  const startedAt = Date.now();
  let lastText = '';
  let lastChangeAt = startedAt;
  let lastStreamingAt = 0;
  let evidence = 'none';
  let text = '';
  let texts = [];
  let publishedText = null;
  const base = baseline == null ? null : norm(baseline);

  for (;;) {
    if (signal?.aborted) return { done: false, interrupted: true, text, texts, reason: 'Local waiting stopped; provider generation status unknown' };
    const now = Date.now();
    const stream = await isStreaming(page, adapter);
    evidence = stream.evidence;
    const tr = await readTranscript(page, adapter, { exclude });
    const last = [...(tr.turns ?? [])].reverse().find((t) => t.role === 'assistant');
    // `last` is the newest content block; `text` is the joined tail. The answer is the newest
    // block, and it is what must change: a page that still shows its greeting has not answered.
    const newest = tr.last || last?.text || '';
    text = newest || last?.text || '';
    if (tr.texts?.length) texts = tr.texts;
    if (text !== publishedText) {
      publishedText = text;
      try { onUpdate?.({ state: text ? 'streaming' : 'waiting', text }); } catch { /* observation listener cannot affect the exchange */ }
    }

    if (text && text !== lastText) { lastText = text; lastChangeAt = now; }
    if (stream.streaming) lastStreamingAt = now;

    // A site-side failure (quota, network error, captcha) is a finished drive, not a timeout:
    // the page will never stream anything, so waiting for the full budget only wastes time.
    const failure = await detectSiteFailure(page, adapter);
    if (failure.failed) {
      return { done: true, failed: true, ms: Date.now() - startedAt, text: text || failure.message, reason: `site failure: ${failure.message}` };
    }

    const quietFor = now - Math.max(lastChangeAt, lastStreamingAt);
    // A NEW answer means new content on the page. Text equality is not enough: the calibration
    // prompt always produces the same 12 words, so a fresh answer can be byte-identical to the
    // previous one. The count of content blocks is what proves something arrived.
    const grew = baseCount === null || (tr.count ?? 0) > baseCount;
    const changed = grew || (base === null || norm(text) !== base);
    if (!stream.streaming && text && changed && quietFor >= stableMs) {
      return { done: true, ms: Date.now() - startedAt, text, texts, reason: `settled: no change for ${quietFor} ms` };
    }
    if (now - startedAt >= timeoutMs) {
      return { done: false, ms: Date.now() - startedAt, text, texts, reason: `timeout after ${timeoutMs} ms (${evidence}${stream.streaming ? ', still streaming' : ''}${changed ? '' : '; no new content since the send'})` };
    }
    await sleep(pollMs);
  }
}

// A page that refuses to answer says so in the UI. Detecting it turns a 2.5-minute timeout into
// an immediate, honest failure with the site's own words.
export async function detectSiteFailure(page, adapter = null) {
  const r = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    const patterns = [
      /network error/i,
      /something went wrong/i,
      /you'?re out of usage credits/i,
      /out of usage credits/i,
      /rate limit(ed)?|too many requests/i,
      /verify you are human|are you a robot|captcha/i,
      /service (is )?unavailable/i,
      /failed to (generate|send|connect)/i,
      /服务(?:暂时)?不可用|网络错误|请求失败|额度不足|超出额度/i,
      // Dialogs that appear AFTER the send. The driver must not answer these on the owner's
      // behalf (an age or a birth year is personal data), so it reports them instead.
      /confirm your age|what year were you born|verify your age|are you over \d{2}/i,
      /log in or create account|sign in to (continue|chat)|please log in|create an account to continue/i,
      /请登录|登录后继续|确认你的年龄|你出生于哪一年/i,
    ];
    const root = document.querySelector('main') || document.body;
    // A blocking dialog is the clearest signal, so it is checked first and on its own: the
    // dialog text is not always inside <main>, and it is often not in the last 4000 chars.
    for (const d of document.querySelectorAll('[role="dialog"],dialog,[class*="modal" i],[class*="dialog" i],[class*="mask" i]')) {
      if (!vis(d)) continue;
      // A real blocking dialog is short. A class-name wildcard can match a layout wrapper that
      // contains the whole sidebar (the owner's chat history), which is not a site failure.
      if (String(d.innerText || '').length > 800) continue;
      const dt = String(d.innerText || '').replace(/\s+/g, ' ').slice(0, 400);
      for (const p of patterns) {
        const m = dt.match(p);
        if (m) return { failed: true, message: m[0].slice(0, 120) };
      }
    }
    // Sidebar/nav chat titles and home-page suggestion chips are the owner's own content, not a
    // site failure. On a page with no conversation turns (a new chat) only alert-like regions are
    // scanned; otherwise <main> is scanned (blocking dialogs were already checked above).
    const mainEl = document.querySelector('main');
    const hasTurns = !!document.querySelector('[data-message-author-role],[data-testid*="conversation-turn"],article');
    let text;
    if (!hasTurns && mainEl) {
      text = [...document.querySelectorAll('[role="alert"],[role="status"],[data-testid*="error" i],[class*="toast" i],[class*="error" i]')]
        .filter((e) => vis(e) && String(e.innerText || '').length <= 800).map((e) => e.innerText).join(' ');
    } else {
      text = mainEl ? String(mainEl.innerText || '').slice(-4000)
        : String((root && root.innerText) || '').slice(-4000) + ' ' + String((document.body && document.body.innerText) || '').slice(0, 4000);
    }
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return { failed: true, message: m[0].slice(0, 120) };
    }
    return { failed: false };
  })()`);
  if (!r.ok) return { failed: false, message: `failure probe failed: ${r.error}` };
  return r.value ?? { failed: false };
}

// ---------------------------------------------------------------------------------------------
// Auth wall
// ---------------------------------------------------------------------------------------------
export async function detectAuthWall(page, adapter = null) {
  const r = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    const composer = live();
    const hasComposer = !!(composer && composer.isConnected);
    const hits = [];
    for (const sel of ${JSON.stringify(Array.isArray(adapter?.preflight?.authWallSelectors) ? adapter.preflight.authWallSelectors : [])}) {
      let els = [];
      try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
      for (const el of els) { if (vis(el)) { hits.push(sel); break; } }
    }

    const url = location.href;
    let pathname = '';
    try { pathname = new URL(url).pathname.toLowerCase(); } catch (e) { pathname = ''; }
    // A login page reached by redirect (MiniMax sends the browser to account.minimax.cn/unified-login)
    // is a wall even though the path is not exactly /login.
    const urlWall = /(^|\/)(login|log-in|signin|sign-in|auth|authorize|signup|register)(\/|$)/.test(pathname)
      || /unified-login|login_redirect|\/sign-?in|\/log-?in|\/auth\/|\/account\/login/.test(String(url).toLowerCase());
    const body = String((document.body && document.body.innerText) || '').slice(0, 4000);
    const wall = /(sign in to continue|log in to continue|you need to sign in|please sign in|you must be signed in|continue with google|continue with email|enter your email|verify you are human|create an account or sign in)/i;
    const m = body.match(wall);

    // A composer that is disabled or read-only is a login wall in disguise: the site renders the
    // input but refuses to accept input until the user signs in.
    const composerUsable = hasComposer && !composer.disabled && !composer.readOnly && composer.getAttribute('aria-disabled') !== 'true';

    // A login MODAL over a usable composer (Kimi shows a WeChat/phone login dialog while the
    // composer looks fine) is still a wall: the message would never be sent.
    let modalWall = null;
    for (const d of document.querySelectorAll('[role="dialog"],dialog,[class*="login-modal" i],[class*="loginMask" i],[class*="signin" i]')) {
      if (!vis(d)) continue;
      const t = String(d.innerText || '').slice(0, 400);
      if (/log ?in|sign ?in|send code|scan.{0,12}(qr|code)|wechat|phone number|password|手机号|扫码|登录/i.test(t)) {
        modalWall = t.replace(/\s+/g, ' ').slice(0, 120);
        break;
      }
    }

    if (composerUsable && !urlWall && !modalWall) return { blocked: false, reason: hits.length ? 'auth-like selectors present but a composer is usable' : 'composer available' };
    if (urlWall) return { blocked: true, reason: 'login URL: ' + url };
    if (modalWall) return { blocked: true, reason: 'login modal open: ' + modalWall };
    if (hits.length && !composerUsable) return { blocked: true, reason: 'auth wall selector matched, no usable composer: ' + hits.slice(0, 3).join(', ') };
    if (m && !composerUsable) return { blocked: true, reason: 'login wall text: ' + m[0] };
    if (hasComposer && !composerUsable) return { blocked: true, reason: 'composer is disabled or read-only (signed out)' };
    return { blocked: false, reason: hasComposer ? 'composer available' : 'no composer found, no login wall detected' };
  })()`);
  if (!r.ok) return { blocked: false, reason: `auth check unavailable: ${r.error}` };
  return { blocked: !!r.value?.blocked, reason: r.value?.reason ?? 'unknown' };
}

// ---------------------------------------------------------------------------------------------
// Cookie consent
// ---------------------------------------------------------------------------------------------
// A person meets a cookie banner before they can chat. The driver dismisses it with the
// LEAST permissive option (necessary / reject / decline) so no tracking consent is given on the
// owner's behalf. If the only offered choice is "accept all", the driver does NOT consent for
// the owner: it reports the banner and lets the drive continue, because a banner does not
// usually block the composer.
export async function dismissCookieBanner(page, adapter = null) {
  const found = await tryEval(page, String.raw`(() => { ${IN_PAGE}
    const cookieish = /cookie|consent|privacy preference|gdpr/i;
    // A link that OPENS the settings modal is not a choice: clicking it leaves a modal open that
    // swallows the next click (arena.ai ends up at ?manage-cookies=true with the chat blocked).
    const settingsish = /setting|manage|configur|customi|preference|policy|more info|learn more/i;
    const cands = [];
    for (const el of document.querySelectorAll('div,section,aside,form,[role="dialog"]')) {
      if (!vis(el)) continue;
      const t = String(el.innerText || '').slice(0, 600);
      if (!cookieish.test(t)) continue;
      if (t.length > 600) continue;
      cands.push(el);
    }
    if (!cands.length) return { found: false };
    // The banner is the smallest element that still mentions cookies.
    cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const banner = cands[0];
    const options = [];
    for (const b of banner.querySelectorAll('button,[role="button"],a.button,input[type="button"]')) {
      if (!vis(b)) continue;
      const label = String((b.innerText || b.value || b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
      if (!label) continue;
      if (settingsish.test(label)) continue;
      const conservative = /necessary|essential only|reject all|declin|deny|only necessary|continue without|reject/i.test(label);
      const permissive = /accept all|allow all|agree/i.test(label);
      if (!conservative && !permissive) continue;
      options.push({ label: label.slice(0, 60), conservative: conservative, tag: b.tagName.toLowerCase() });
    }
    const pick = options.find((o) => o.conservative) || null;
    const permissiveOnly = options.filter((o) => o.permissive).map((o) => o.label);
    if (!pick) return { found: true, dismissible: false, options: permissiveOnly, reason: 'cookie banner offers only permissive choices' };
    globalThis.__aionCookieBtn = null;
    for (const b of banner.querySelectorAll('button,[role="button"],a.button,input[type="button"]')) {
      const label = String((b.innerText || b.value || b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
      if (settingsish.test(label)) continue;
      if (/necessary|essential only|reject all|declin|deny|only necessary|continue without|reject/i.test(label)) {
        globalThis.__aionCookieBtn = b;
        return { found: true, dismissible: true, label: label.slice(0, 60), options: options.map((o) => o.label) };
      }
    }
    return { found: true, dismissible: false, options: permissiveOnly, reason: 'no conservative cookie option found' };
  })()`);
  if (!found.ok) return { found: false, reason: `cookie probe failed: ${found.error}` };
  const info = found.value;
  if (!info?.found || !info?.dismissible) return { found: !!info?.found, dismissed: false, reason: info?.reason ?? 'no cookie banner' };

  const clicked = await clickStored(page, '__aionCookieBtn');
  if (!clicked) return { found: true, dismissed: false, reason: 'cookie option could not be clicked' };
  await sleep(900);
  const closed = await closeCookieModal(page);
  return { found: true, dismissed: true, label: info.label, options: info.options ?? [], closedModal: closed.closed, reason: 'dismissed with the least permissive cookie option' };
}

// Some sites open a cookie SETTINGS modal instead of offering a choice in the banner. Escape
// closes it, and the site leaves the ?manage-cookies=true state behind.
export async function closeCookieModal(page) {
  const probe = String.raw`(() => ({
    url: location.href,
    dialogs: [...document.querySelectorAll('[role="dialog"],dialog')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    }).length,
  }))()`;
  const before = await tryEval(page, probe);
  if (!before.ok) return { closed: false, reason: 'modal probe failed' };
  const b = before.value;
  const looksOpen = /manage-cookies|cookie[-_]?settings/i.test(String(b.url ?? '')) || (b.dialogs ?? 0) > 0;
  if (!looksOpen) return { closed: false, reason: 'no cookie modal open' };

  const esc = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  try {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...esc });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...esc });
  } catch { /* the modal may close on its own */ }
  await sleep(700);

  const after = await tryEval(page, probe);
  const a = after.ok ? after.value : { url: b.url, dialogs: b.dialogs };
  const closed = !/manage-cookies/i.test(String(a.url ?? '')) && (a.dialogs ?? 0) === 0;
  return { closed, url: a.url ?? null, dialogs: a.dialogs ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------
function hostMatches(adapter, url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const bare = host.replace(/^www\./, '');
  for (const raw of adapter?.hosts ?? []) {
    const w = String(raw).toLowerCase().replace(/^www\./, '');
    if (!w) continue;
    if (bare === w || bare.endsWith(`.${w}`)) return true;
  }
  return false;
}

async function openTab(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURI(url)}`;
  let res = await fetch(endpoint, { method: 'PUT' });
  if (res.status === 405) res = await fetch(endpoint);
  if (!res.ok) throw new Error(`HTTP ${res.status} from /json/new`);
  return res.json();
}

async function waitForTargetId(port, id, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const targets = await listTargets({ port }).catch(() => []);
    const hit = id ? targets.find((t) => t.id === id) : null;
    if (hit && hit.url !== 'about:blank') return hit;
    if (Date.now() >= deadline) return hit ?? null;
    await sleep(intervalMs);
  }
}

// Make a target the active tab of its window. A tab that is not active is hidden, and Chrome
// does not deliver synthetic key input to a hidden tab.
async function page_bringToFront(port, targetId) {
  const conn = await CdpConnection.connect(await browserWsUrl({ port }), { requestTimeoutMs: 15000 });
  try {
    const page = await conn.attach(targetId);
    await page.send('Page.bringToFront', {});
  } finally {
    try { conn.close(); } catch { /* already closed */ }
  }
}

// Close a tab the drive opened, so the owner's browser is left as it was found.
async function closeTab(port, targetId) {
  if (!targetId) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
    return res.ok;
  } catch { return false; }
}

// Drive one live site: resolve the tab, check the login wall, record, type, send, wait, read back.
// Site-level problems are returned, never thrown.
export async function driveSite({ adapter, prompt, port = 9222, dataDir, record = true, timeoutMs = 120000, humanPace = true, freshTab = true, onEvent = null } = {}) {
  const lease = acquireDriveLease({ port, holder: { kind: 'drive-job', id: `legacy-${process.pid}` } });
  const startedAt = Date.now();
  const errors = [];
  const result = {
    ok: false, blocked: false, site: adapter?.id ?? null, sessionId: null, ms: 0,
    prompt: String(prompt ?? ''), reply: '', target: null, errors,
  };
  const emit = (ev) => { try { onEvent?.(ev); } catch { /* a listener must never break the drive */ } };

  let recorder = null;
  let conn = null;
  let page = null;
  let openedTabId = null;
  let captureStopFailed = false;

  const cleanup = async () => {
    if (recorder) {
      try { await recorder.stop({ reason: 'drive_complete' }); }
      catch (e) { captureStopFailed = true; result.ok = false; errors.push(`recorder stop failed: ${String(e?.message ?? e)}`); }
      recorder = null;
    }
    if (conn) { try { conn.close(); } catch { /* already closed */ } conn = null; }
    // The tab this drive opened is closed again: the owner's browser keeps only its own tabs.
    if (openedTabId && result.openedTab && !result.uncertain && !captureStopFailed) {
      const closed = await closeTab(port, openedTabId);
      result.tabClosed = closed;
    }
    result.ms = Date.now() - startedAt;
  };

  const openSession = async (target) => {
    if (record) {
      const dir = dataDir ? path.resolve(dataDir) : defaultDataDir();
      const paths = dataPaths(dir);
      ensureDataDirs(paths);
      const store = new ProfileStore(paths.profiles);
      // A site without a matching capture profile still records: 'generic' is the documented fallback.
      let profileName;
      try { profileName = store.selectFor(target.url)?.name; } catch { profileName = 'generic'; }
      recorder = new Recorder({ sessionsDir: paths.sessions, profileStore: store, port, tabs: 'one', follow: false });
      recorder.on('warn', (e) => errors.push(String(e?.message ?? e)));
      const session = await recorder.start({ target: target.id, profile: profileName, label: adapter?.id, tabs: 'one', follow: false });
      result.sessionId = session.id;
      return recorder.page;
    }
    conn = await CdpConnection.connect(await browserWsUrl({ port }), { requestTimeoutMs: 15000 });
    return conn.attach(target.id);
  };

  const run = async () => {
    let targets;
    try { targets = await listTargets({ port }); }
    catch (e) { result.reason = 'no-browser'; errors.push(`DevTools endpoint unreachable on 127.0.0.1:${port}: ${String(e?.message ?? e)}`); return; }

    // A drive happens in its OWN tab. Measured on this machine: a tab that is not the active one
    // reports document.visibilityState === "hidden", and Chrome then drops synthetic key input
    // for it (the composer accepted Input.insertText but no keystroke reached it). A freshly
    // created tab is always visible, so every drive opens one and closes it afterwards.
    let target = null;
    if (freshTab) {
      const openUrl = adapter?.url ?? (adapter?.hosts?.[0] ? `https://${adapter.hosts[0]}/` : null);
      if (!openUrl) { errors.push('adapter has no url or hosts to open'); return; }
      emit({ type: 'tab', opening: openUrl, fresh: true });
      try {
        const created = await openTab(port, openUrl);
        openedTabId = created?.id ?? null;
        target = await waitForTargetId(port, openedTabId, { timeoutMs: 30000 });
        if (!target) { errors.push(`opened ${openUrl} but no page target appeared`); return; }
        try { await page_bringToFront(port, target.id); } catch { /* the tab is already active */ }
      } catch (e) { errors.push(`could not open ${openUrl}: ${String(e?.message ?? e)}`); return; }
      emit({ type: 'target', reused: false, id: target.id, url: target.url });
      result.openedTab = true;
    } else {
      target = targets.find((t) => hostMatches(adapter, t.url)) ?? null;
      if (target) {
        // Synthetic key input only reaches a VISIBLE tab (measured: hidden tabs accept
        // Input.insertText but drop keystrokes), so a reused tab is brought to front first.
        try { await page_bringToFront(port, target.id); } catch { /* best effort */ }
        emit({ type: 'target', reused: true, id: target.id, url: target.url });
      }
      else {
        const openUrl = adapter?.url ?? (adapter?.hosts?.[0] ? `https://${adapter.hosts[0]}/` : null);
        if (!openUrl) { errors.push('adapter has no url or hosts to open'); return; }
        emit({ type: 'tab', opening: openUrl });
        try {
          const created = await openTab(port, openUrl);
          openedTabId = created?.id ?? null;
          target = await waitForTargetId(port, openedTabId);
          if (!target) { errors.push(`opened ${openUrl} but no page target appeared`); return; }
        } catch (e) { errors.push(`could not open ${openUrl}: ${String(e?.message ?? e)}`); return; }
        emit({ type: 'target', reused: false, id: target.id, url: target.url });
      }
    }
    result.target = { id: target.id, url: target.url, title: target.title ?? null };

    // Login wall + composer first, on a short-lived connection, so a blocked or still-loading
    // site never creates an empty session.
    let probe = null;
    let composerFound = null;
    try {
      probe = await CdpConnection.connect(await browserWsUrl({ port }), { requestTimeoutMs: 15000 });
      const probePage = await probe.attach(target.id);
      const auth = await detectAuthWall(probePage, adapter);
      result.authWall = auth;
      emit({ type: 'auth', blocked: auth.blocked, reason: auth.reason });
      if (auth.blocked) { result.blocked = true; result.reason = auth.reason; return; }
      composerFound = await waitForComposer(probePage, adapter, { timeoutMs: 20000 });
      emit({ type: 'composer', ...composerFound });
      if (!composerFound.found) { errors.push(composerFound.reason ?? 'no composer found'); result.reason = 'no-composer'; return; }
    } catch (e) {
      errors.push(`auth probe failed: ${String(e?.message ?? e)}`);
    } finally {
      try { probe?.close(); } catch { /* detached */ }
    }

    page = await openSession(target);
    emit({ type: 'recording', sessionId: result.sessionId, profile: recorder?.profile?.name ?? null });

    // A background tab reports document.hasFocus() === false, which some sites read as
    // "not a real user". Focus emulation + bringToFront makes the page behave like a visible one.
    const env = await prepareHumanEnvironment(page, { focus: true });
    result.env = env;
    emit({ type: 'env', webdriver: env.webdriver, hasFocus: env.hasFocus, notes: env.notes });

    // A person meets a cookie banner before they can chat. Dismissed with the least permissive
    // option, so no tracking consent is given on the owner's behalf.
    try {
      const consent = await dismissCookieBanner(page, adapter);
      result.consent = consent;
      emit({ type: 'consent', ...consent });
    } catch (e) {
      errors.push(`cookie banner handling failed: ${String(e?.message ?? e)}`);
    }

    // Re-derive on the recording connection when the probe did not resolve one; the page-level
    // selection survives, so this is normally a single fast lookup.
    const found = composerFound ?? await findComposer(page, adapter);
    emit({ type: 'composer', ...found });
    if (!found.found) { errors.push(found.reason ?? 'no composer found'); result.reason = 'no-composer'; return; }

    const focus = await focusComposer(page, found);
    emit({ type: 'focus', ...focus });
    if (!focus.ok) errors.push(`could not focus the composer (${focus.reason ?? focus.method ?? 'unknown'})`);

    const cleared = await clearComposer(page);
    emit({ type: 'clear', ...cleared });
    if (!cleared.ok) errors.push('composer still holds a draft after select-all + Backspace');

    // What the page says BEFORE the prompt is sent. The reply is only accepted when new content
    // has appeared since then, so a static greeting is never mistaken for an answer.
    const pre = await readTranscript(page, adapter, { exclude: [result.prompt] });
    const baseline = pre.last || [...(pre.turns ?? [])].reverse().find((t) => t.role === 'assistant')?.text || '';
    const baseCount = pre.count ?? 0;
    result.baseline = baseline ? baseline.slice(0, 200) : '';
    result.baselineCount = baseCount;
    // Pre-send acceptance-freshness cursor (G1/G2): user/assistant counts from the SAME page-agent
    // full-DOM scan that produces DOM_TURNS at stop. null when unmeasurable — evaluation stays
    // honest rather than guessing an empty page.
    try {
      const t0 = await recorder.domTurns();
      result.baselineTurns = { userTurns: t0.filter((x) => x?.role === 'user').length,
        assistantTurns: t0.filter((x) => x?.role === 'assistant').length, sampledAt: new Date().toISOString() };
    } catch { result.baselineTurns = null; }

    const typed = await typeText(page, result.prompt, { human: humanPace });
    emit({ type: 'typed', ok: typed.ok, method: typed.method, chars: String(typed.typed ?? '').length, grewBy: typed.grewBy });
    if (!typed.ok) { errors.push(`typing failed (${typed.method ?? 'unknown'}): ${typed.reason ?? ''}`.trim()); result.reason = 'type-failed'; return; }

    // A person looks at what they typed before pressing send.
    if (humanPace) await humanIdle(page, { pace: DEFAULT_PACE });
    else await sleep(150);

    const sent = await sendMessage(page, adapter);
    if (sent.uncertain) result.uncertain = true;
    emit({ type: 'sent', ...sent });
    if (!sent.ok) { errors.push(`send did not take (${sent.method})`); result.reason = 'send-failed'; return; }

    const wait = await waitForCompletion(page, adapter, { timeoutMs, baseline, baseCount, exclude: [result.prompt] });
    emit({ type: 'completion', done: wait.done, failed: !!wait.failed, ms: wait.ms, reason: wait.reason });
    result.reply = wait.text ?? '';
    result.done = wait.done;
    if (wait.failed) { errors.push(wait.reason); result.reason = 'site-failure'; return; }
    if (!wait.done) { errors.push(wait.reason); result.reason = 'timeout'; return; }

    // The reply is whichever visible text actually contains the answer the prompt asked for.
    // Picking "the last block" gave a footer notice on ChatGPT and a nav item on z.ai.
    const words = expectedWordsFromPrompt(result.prompt);
    if (words) {
      const texts = wait.texts ?? [];
      const hit = [...texts].reverse().find((t) => containsWords(t, words));
      if (hit) result.reply = hit;
      result.verified = !!hit;
    }
    result.ok = true;
  };

  try { await run(); }
  catch (e) { errors.push(String(e?.message ?? e)); result.reason ??= 'drive-error'; }
  finally { try { await cleanup(); } finally { if (!captureStopFailed) lease.release(); } }

  return result;
}
