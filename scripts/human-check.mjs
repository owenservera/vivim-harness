#!/usr/bin/env node
// Capture Studio — human-typing verification harness.
//
//   node scripts/human-check.mjs [--port 9222] [--text "..."] [--json] [--keep-open]
//
// Proves that src/capture/human.mjs types like a person and not like a script, without touching
// a real website. It builds a data-only local fixture page in the OS temp directory, opens it as
// a file:// tab over the project's own CDP plumbing, then measures what the page actually saw.
//
// Measured (each one becomes a check in the receipt):
//   * keydown count on the input  == characters typed + deliberate corrections
//   * the input's value           == the text that was typed (whitespace-normalised)
//   * the contenteditable's text  == the text that was typed (whitespace-normalised)
//   * input events on the input   >= one per typed character
//   * inter-key gaps              min >= 5 ms, max <= 2000 ms, zero gaps < 15 ms
//   * navigator.webdriver         === false
//   * document.hasFocus()         reported; WARN (not a failure) when the OS window is unfocused
//   * user agent                  does not contain "HeadlessChrome"
//
// Output: one JSON receipt on stdout ({ ok, checks, gaps, events, env }). A short human summary
// goes to stderr (suppressed by --json). Exit 0 = all checks passed, 1 = a check failed,
// 2 = environment failure (no CDP on the port, or the sibling module is missing).
//
// Safety: only the local fixture is typed into. Nothing about the person's profile is changed
// beyond opening (and, by default, closing) one file:// tab.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CdpConnection } from '../src/cdp/client.mjs';
import { browserWsUrl, endpointBase, listTargets } from '../src/cdp/discovery.mjs';

const DEFAULT_TEXT = 'The quick brown fox jumps over 13 lazy dogs near the river bank.';
const HOST = '127.0.0.1';
const FIXTURE_NAME = 'aion-human-check.html';

// ---------------------------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { port: 9222, text: DEFAULT_TEXT, json: false, keepOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--keep-open') out.keepOpen = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--text') out.text = String(argv[++i] ?? '');
    else if (a.startsWith('--text=')) out.text = a.slice(7);
    else if (a === '--help' || a === '-h') { out.help = true; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
    throw new Error(`--port must be an integer between 1 and 65535 (got ${out.port})`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const round = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

function stats(values) {
  if (!values.length) return { count: 0, mean: null, median: null, p95: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return {
    count: sorted.length,
    mean: round(sum / sorted.length),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

// The page records every relevant DOM event with its target id, so the receipt can attribute
// each event to the field it landed in instead of guessing.
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AION human-check fixture (local, data only)</title>
<style>body{font:14px system-ui;margin:2rem}input,div{display:block;width:32rem;margin:.5rem 0;padding:.4rem;border:1px solid #bbb}div{min-height:2rem}</style>
</head>
<body>
<form id="f" onsubmit="return false">
  <label for="i">input</label>
  <input id="i" type="text" autocomplete="off" spellcheck="false">
  <label for="e">contenteditable</label>
  <div id="e" contenteditable="true"></div>
</form>
<script>
(function () {
  window.__ev = [];
  window.__env = {
    hasFocusAtLoad: document.hasFocus(),
    webdriverAtLoad: navigator.webdriver,
    uaAtLoad: navigator.userAgent,
    readyStateAtLoad: document.readyState,
    loadedAt: Date.now()
  };
  var TYPES = ['keydown', 'keypress', 'keyup', 'input', 'beforeinput'];
  function targetId(t) {
    if (!t) return 'none';
    if (t.id) return t.id;
    if (t === document) return 'document';
    if (t === window) return 'window';
    return String(t.nodeName || 'unknown').toLowerCase();
  }
  TYPES.forEach(function (type) {
    window.addEventListener(type, function (e) {
      window.__ev.push({
        type: type,
        key: typeof e.key === 'string' ? e.key : null,
        code: typeof e.code === 'string' ? e.code : null,
        target: targetId(e.target),
        t: Math.round(e.timeStamp * 1000) / 1000,
        data: typeof e.data === 'string' ? e.data : null,
        inputType: typeof e.inputType === 'string' ? e.inputType : null,
        isTrusted: !!e.isTrusted
      });
    }, true);
  });
})();
</script>
</body>
</html>
`;

const MEASURE = `(() => {
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const ev = Array.isArray(window.__ev) ? window.__ev : [];
  const TYPES = ['keydown', 'keypress', 'keyup', 'input', 'beforeinput'];
  const counts = (target) => {
    const out = {};
    TYPES.forEach((t) => { out[t] = ev.filter((e) => e.type === t && (target === undefined || e.target === target)).length; });
    return out;
  };
  const input = document.getElementById('i');
  const editable = document.getElementById('e');
  const kd = ev.filter((e) => e.type === 'keydown' && e.target === 'i');
  const gaps = [];
  for (let k = 1; k < kd.length; k++) gaps.push(Math.round((kd[k].t - kd[k - 1].t) * 1000) / 1000);
  const trusted = { keydown: 0, input: 0 };
  ev.forEach((e) => { if (e.isTrusted && trusted[e.type] !== undefined) trusted[e.type]++; });
  return {
    inputValue: input ? input.value : null,
    inputValueNorm: norm(input ? input.value : ''),
    editableTextNorm: norm(editable ? (editable.innerText != null ? editable.innerText : editable.textContent) : ''),
    env: {
      webdriver: navigator.webdriver,
      hasFocus: document.hasFocus(),
      ua: navigator.userAgent,
      readyState: document.readyState,
      activeId: document.activeElement ? (document.activeElement.id || String(document.activeElement.nodeName || '').toLowerCase()) : null,
    },
    counts: { input: counts('i'), editable: counts('e'), all: counts(undefined) },
    trusted: trusted,
    gaps: gaps,
    eventTotal: ev.length,
    loadEnv: window.__env || null
  };
})()`;

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
    userGesture: false,
  });
  if (exceptionDetails) {
    throw new Error(`page evaluation failed: ${exceptionDetails.text ?? 'exception'} ${exceptionDetails.exception?.description ?? ''}`.trim());
  }
  return result?.value;
}

async function waitForPageReady(page, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(page, '({ ready: document.readyState, hasInput: !!document.getElementById("i"), hasEditor: !!document.getElementById("e"), hasRecorder: Array.isArray(window.__ev) })');
      last = state;
      if (state?.ready === 'complete' && state?.hasInput && state?.hasEditor && state?.hasRecorder) return state;
    } catch (e) { last = { error: String(e?.message ?? e) }; }
    await sleep(120);
  }
  throw new Error(`fixture page did not become ready: ${JSON.stringify(last)}`);
}

// Focus the field with a real DOM focus() call. humanType types into whatever is focused, so the
// harness owns focus and the prep function only has to make the environment look untouched.
async function focusField(page, id) {
  await evaluate(page, `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return false;
    if ('value' in el) el.value = '';
    else el.textContent = '';
    el.focus();
    const sel = window.getSelection();
    if (sel && !('value' in el)) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    return document.activeElement === el;
  })()`);
}

function addCheck(checks, name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`human-check: ${e.message}\n`); return 2; }

  if (args.help) {
    process.stderr.write('usage: node scripts/human-check.mjs [--port 9222] [--text "..."] [--json] [--keep-open]\n');
    return 0;
  }

  const say = (line) => { if (!args.json) process.stderr.write(`${line}\n`); };
  const base = endpointBase({ host: HOST, port: args.port });



  // 1. The sibling lane owns src/capture/human.mjs. If it is not there yet, say so plainly.
  let human;
  try {
    human = await import(new URL('../src/capture/human.mjs', import.meta.url).href);
  } catch (e) {
    process.stderr.write(
      `human-check: cannot load ../src/capture/human.mjs (${e?.message ?? e}).\n` +
      `human-check: this harness verifies that module and does not stub it. ` +
      `Expected exports: humanType(page, text, {pace, human}) and prepareHumanEnvironment(page, {focus}).\n`,
    );
    process.stdout.write(`${JSON.stringify({ ok: false, error: `missing module: ../src/capture/human.mjs (${e?.message ?? e})`, checks: [], gaps: {}, events: {}, env: { port: args.port } }, null, 2)}\n`);
    return 2;
  }
  const { humanType, prepareHumanEnvironment } = human;
  if (typeof humanType !== 'function' || typeof prepareHumanEnvironment !== 'function') {
    process.stderr.write('human-check: ../src/capture/human.mjs does not export humanType() and prepareHumanEnvironment().\n');
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'incomplete API in ../src/capture/human.mjs', checks: [], gaps: {}, events: {}, env: { port: args.port } }, null, 2)}\n`);
    return 2;
  }

  // 2. DevTools must be reachable on the port, or this is an environment failure (exit 2).
  let wsUrl;
  try {
    wsUrl = await browserWsUrl({ host: HOST, port: args.port });
  } catch (e) {
    process.stderr.write(
      `human-check: no DevTools endpoint on ${base} (${e?.message ?? e}).\n` +
      `human-check: start Chrome with --remote-debugging-port=${args.port} and retry, or pass --port <n>.\n`,
    );
    process.stdout.write(`${JSON.stringify({ ok: false, error: `CDP unreachable on ${base}`, checks: [], gaps: {}, events: {}, env: { port: args.port, endpoint: base } }, null, 2)}\n`);
    return 2;
  }

  // 3. Local fixture only: a data-only file in the OS temp dir.
  const fixturePath = path.join(os.tmpdir(), FIXTURE_NAME);
  fs.writeFileSync(fixturePath, FIXTURE_HTML, 'utf8');
  const fixtureUrl = pathToFileURL(fixturePath).href;

  let conn = null;
  let targetId = null;
  let page = null;
  const receipt = {
    ok: false,
    checks: [],
    gaps: {},
    events: {},
    env: { port: args.port, endpoint: base, host: HOST, fixtureUrl, tempFile: fixturePath, text: args.text, textChars: Array.from(args.text).length },
  };

  try {
    // 4. Open the fixture tab. Chrome wants PUT for /json/new; older builds accept GET.
    const newUrl = `${base}/json/new?${encodeURIComponent(fixtureUrl)}`;
    let info = null;
    let lastStatus = '';
    for (const method of ['PUT', 'GET']) {
      try {
        const res = await fetch(newUrl, { method });
        lastStatus = `HTTP ${res.status} (${method})`;
        if (res.ok) { info = await res.json(); break; }
        if (res.status !== 404 && res.status !== 405) break;
      } catch (e) { lastStatus = `${method} failed: ${e?.message ?? e}`; }
    }
    targetId = info?.id ?? null;
    if (!targetId) {
      // Fall back to discovery: find the tab by the fixture file name.
      const targets = await listTargets({ host: HOST, port: args.port });
      const hit = targets.find((t) => String(t.url ?? '').includes(FIXTURE_NAME));
      if (!hit) throw new Error(`could not open the fixture tab (${lastStatus || 'no response'})`);
      targetId = hit.id;
    }
    receipt.env.targetId = targetId;

    conn = await CdpConnection.connect(wsUrl, { requestTimeoutMs: 20_000 });
    page = await conn.attach(targetId, { timeoutMs: 20_000 });
    await waitForPageReady(page);
    const ready = await evaluate(page, '({ ready: document.readyState })');
    receipt.env.readyState = ready?.ready ?? null;

    // 5. Make the environment look like a person's browser, then type.
    const prep = await prepareHumanEnvironment(page, { focus: true });
    receipt.env.prepare = prep && typeof prep === 'object'
      ? { webdriver: prep.webdriver ?? null, hasFocus: prep.hasFocus ?? null, ua: prep.ua ?? null, notes: prep.notes ?? null }
      : { raw: prep ?? null };

    const chars = Array.from(args.text).length;

    await focusField(page, 'i');
    let inputResult = null;
    let inputError = null;
    try { inputResult = await humanType(page, args.text, { human: true }); }
    catch (e) { inputError = String(e?.message ?? e); }
    const afterInput = await evaluate(page, MEASURE);

    await focusField(page, 'e');
    let editableResult = null;
    let editableError = null;
    try { editableResult = await humanType(page, args.text, { human: true }); }
    catch (e) { editableError = String(e?.message ?? e); }
    const afterEditable = await evaluate(page, MEASURE);

    // 6. Measure.
    const corrections = Number(inputResult?.stats?.corrections ?? 0);
    // Each deliberate slip costs TWO extra keydowns: the wrong character, then the Backspace
    // that removes it.
    const expectedKeydown = chars + corrections * 2;
    const keydownCount = afterInput?.counts?.input?.keydown ?? 0;
    const inputEvents = afterInput?.counts?.input?.input ?? 0;
    const gapStats = stats(afterEditable && afterInput ? afterInput.gaps ?? [] : []);
    const sub15 = (afterInput?.gaps ?? []).filter((g) => g < 15);
    const gapsBelow5 = (afterInput?.gaps ?? []).filter((g) => g < 5);
    const ua = String(afterEditable?.env?.ua ?? '');
    const webdriver = afterEditable?.env?.webdriver ?? null;
    const hasFocus = afterEditable?.env?.hasFocus ?? null;

    receipt.env = {
      ...receipt.env,
      ua,
      webdriver,
      hasFocus,
      activeId: afterEditable?.env?.activeId ?? null,
      loadEnv: afterEditable?.loadEnv ?? afterInput?.loadEnv ?? null,
      method: inputResult?.method ?? null,
      stats: inputResult?.stats ?? null,
      editableMethod: editableResult?.method ?? null,
      editableStats: editableResult?.stats ?? null,
      typed: inputResult?.typed ?? null,
      editableTyped: editableResult?.typed ?? null,
      inputError,
      editableError,
    };

    receipt.gaps = {
      ...gapStats,
      below5: gapsBelow5.length,
      below15: sub15.length,
      below15Values: sub15.slice(0, 20),
      window: 'keydown-to-keydown on #i',
    };

    receipt.events = {
      expectedKeydown,
      keydownObserved: keydownCount,
      chars,
      corrections,
      input: afterInput?.counts?.input ?? {},
      editable: afterEditable?.counts?.editable ?? {},
      all: afterEditable?.counts?.all ?? {},
      trusted: afterEditable?.trusted ?? afterInput?.trusted ?? {},
      total: afterEditable?.eventTotal ?? afterInput?.eventTotal ?? 0,
    };

    const checks = receipt.checks;
    addCheck(checks, 'humanType(#i) resolved', !inputError && inputResult?.ok !== false,
      inputError ?? `ok=${inputResult?.ok} method=${inputResult?.method} corrections=${corrections}`);
    addCheck(checks, 'keydown count on #i == chars + 2*corrections', keydownCount === expectedKeydown,
      `keydown=${keydownCount} expected=${expectedKeydown} (chars=${chars} corrections=${corrections})`);
    addCheck(checks, 'input value == typed text', afterInput?.inputValueNorm === norm(args.text),
      `value=${JSON.stringify(afterInput?.inputValue)}`);
    addCheck(checks, 'contenteditable text == typed text',
      !editableError && afterEditable?.editableTextNorm === norm(args.text),
      editableError ?? `text=${JSON.stringify((afterEditable?.editableTextNorm ?? '').slice(0, 120))}`);
    addCheck(checks, 'input event fired >= once per char', inputEvents >= chars,
      `input events=${inputEvents} chars=${chars}`);
    addCheck(checks, 'inter-key gaps in [5, 2000] ms with none < 15 ms',
      gapStats.count > 0 && gapStats.min >= 5 && gapStats.max <= 2000 && sub15.length === 0,
      `n=${gapStats.count} min=${gapStats.min} max=${gapStats.max} sub15=${sub15.length} below5=${gapsBelow5.length}`);
    addCheck(checks, 'navigator.webdriver === false', webdriver === false, `webdriver=${JSON.stringify(webdriver)}`);
    addCheck(checks, 'document.hasFocus() after prepare',
      true,
      hasFocus === true ? 'true' : `WARN: false (window not focused; not a failure) value=${JSON.stringify(hasFocus)}`);
    addCheck(checks, 'UA does not contain HeadlessChrome', !/HeadlessChrome/i.test(ua), ua || '(empty)');

    receipt.ok = checks.every((c) => c.pass);

    // 7. Summary. --json keeps stderr silent so stdout is the only channel.
    say('');
    say(`human-check  port ${args.port}  chars ${chars}  corrections ${corrections}`);
    for (const c of checks) say(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  — ${c.detail}`);
    say(`  gaps  n=${gapStats.count} mean=${gapStats.mean} median=${gapStats.median} p95=${gapStats.p95} min=${gapStats.min} max=${gapStats.max} sub15=${sub15.length}`);
    say(`  result: ${receipt.ok ? 'HUMAN-LIKE' : 'NOT HUMAN-LIKE'}`);
    say('');
    return receipt.ok ? 0 : 1;
  } catch (e) {
    receipt.ok = false;
    receipt.error = String(e?.message ?? e);
    receipt.checks.push({ name: 'harness run', pass: false, detail: receipt.error });
    process.stderr.write(`human-check: ${receipt.error}\n`);
    return 1;
  } finally {
    try {
      if (conn && targetId && !args.keepOpen) await conn.send('Target.closeTarget', { targetId });
    } catch { /* tab may be gone already */ }
    try { conn?.close(); } catch { /* ignore */ }
    if (!args.keepOpen) { try { fs.unlinkSync(fixturePath); } catch { /* already removed */ } }
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
}

// Keep the event loop alive for the whole run. discovery.mjs sleeps with unref()'d timers, so
// while a discovery retry is in flight the loop can empty and Node would exit 0 mid-await with
// nothing printed — which would hide a real failure (unreachable port) behind a success code.
const KEEP_ALIVE = setInterval(() => {}, 1000);

main()
  .then((code) => {
    clearInterval(KEEP_ALIVE);
    process.exitCode = Number.isInteger(code) ? code : (code ? 1 : 0);
    // Last-resort nudge in case an unclosed socket outlives the run; unref'd, so it only fires
    // when something else is still holding the loop open.
    setTimeout(() => process.exit(process.exitCode ?? 1), 3000).unref?.();
  })
  .catch((e) => {
    clearInterval(KEEP_ALIVE);
    process.stderr.write(`human-check: unexpected failure: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
