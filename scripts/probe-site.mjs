#!/usr/bin/env node
// Read-only evidence probe for one AI chat site.
//
// Purpose: learn the REAL DOM and transport facts (composer shape, send controls, assistant
// containers, streaming markers, chat/stream endpoints, websockets) so per-site adapters and
// capture profiles are written from evidence instead of guesswork.
//
// Safety contract — this script is read-only:
//   * it never types, never pastes, never sends a message, never clicks a send control,
//     never submits a form and never dispatches input events;
//   * it reuses an existing tab when the host matches (keeping the person's session intact)
//     and otherwise opens one via /json/new;
//   * it closes ONLY the tab it opened, and only when --keep-open was not passed;
//   * it writes exactly one JSON file per site and nothing else.
//
// Reuse: CDP plumbing comes from src/cdp/*; adapter resolution from src/profiles/sites/index.mjs.
// The in-page collector mirrors the heuristics in src/capture/actions.mjs (findComposer generic
// branch, isStreaming, readTranscript) WITHOUT importing the send/type primitives.
//
// Usage: node scripts/probe-site.mjs <site|url> [--port 9222] [--out <dir>] [--wait S]
//                                    [--keep-open] [--reload] [--help]
// Exit:  0 success, 3 site unreachable or login-walled, 5 environment failure (no CDP).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpConnection, sleep } from '../src/cdp/client.mjs';
import { browserWsUrl, isReachable, listTargets } from '../src/cdp/discovery.mjs';
import { getAdapter } from '../src/profiles/sites/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'research', 'probe');

// ---------------------------------------------------------------------------------------------
// In-page collector. Serialized with Function.prototype.toString and evaluated in the page, so it
// must be fully self-contained: no imports, no closures over module scope, no template syntax.
// ---------------------------------------------------------------------------------------------
function collectPageFacts() {
  const normText = (v) => String(v == null ? '' : v).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 1 && r.height > 1)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    return true;
  };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const esc = (s) => {
    const v = String(s);
    try { if (typeof CSS !== 'undefined' && CSS && CSS.escape) return CSS.escape(v); } catch (e) { /* fall through */ }
    return v.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  };

  const unique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  };

  // A readable, mostly-stable CSS path: id or data-testid when unique, else a short ancestor chain
  // with nth-of-type disambiguation, stopping as soon as the path resolves to a single element.
  const stableSelector = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && unique('#' + esc(el.id))) return '#' + esc(el.id);
    for (const attr of ['data-testid', 'data-message-author-role', 'data-placeholder', 'name']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (!v || String(v).length > 80) continue;
      const s = el.tagName.toLowerCase() + '[' + attr + '="' + String(v).replace(/"/g, '\\"') + '"]';
      if (unique(s)) return s;
    }
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 8) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = [];
        for (const c of parent.children) if (c.tagName === cur.tagName) sameTag.push(c);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (unique(candidate)) return candidate;
      cur = parent;
      depth++;
    }
    return parts.join(' > ');
  };

  const describe = (el) => {
    const bits = [];
    for (const attr of ['aria-label', 'placeholder', 'title', 'data-placeholder', 'name', 'id', 'data-testid']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) bits.push(attr + '=' + String(v).slice(0, 100));
    }
    const t = normText(el.innerText || el.textContent || '');
    if (t) bits.push('text=' + t.slice(0, 80));
    return bits.join(' | ').slice(0, 320);
  };

  const isBlocked = (el) => el.disabled === true || el.readOnly === true || el.getAttribute('aria-disabled') === 'true';

  // A sidebar/search input is a textarea too. Counting it as "the chat composer" would both
  // misreport the composer and hide a real login wall, so it is tagged instead of trusted.
  const isSearchLike = (el) => {
    const meta = [
      el.getAttribute && el.getAttribute('name'),
      el.getAttribute && el.getAttribute('placeholder'),
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('id'),
      el.getAttribute && el.getAttribute('type'),
    ].join(' ');
    if (/search|buscar|recherche|suche|suchen|搜索|検索|find/i.test(meta)) return true;
    if (String(el.getAttribute && el.getAttribute('type')) === 'search') return true;
    return !!el.closest('[role="search"], form[action*="search" i], [class*="search" i], [id*="search" i]');
  };

  const composerSelectorList = ['textarea', '[contenteditable]', '[role="textbox"]'];
  const composerCandidates = [];
  const seenComposers = new Set();
  for (const sel of composerSelectorList) {
    let els = [];
    try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { els = []; }
    for (const el of els) {
      if (seenComposers.has(el)) continue;
      seenComposers.add(el);
      if (!vis(el)) continue;
      if (composerCandidates.length >= 25) break;
      const form = el.closest('form');
      composerCandidates.push({
        selector: stableSelector(el),
        matched: sel,
        tag: el.tagName.toLowerCase(),
        contentEditable: el.getAttribute('contenteditable'),
        isContentEditable: el.isContentEditable === true,
        inForm: !!form,
        formAction: form && form.getAttribute('action') ? String(form.getAttribute('action')).slice(0, 120) : null,
        disabled: el.disabled === true,
        readOnly: el.readOnly === true,
        searchLike: isSearchLike(el),
        rect: rectOf(el),
        label: describe(el),
      });
    }
  }

  // Exactly the generic branch of findComposer() in src/capture/actions.mjs.
  const genericSels = ['textarea', '[contenteditable="true"]', '[contenteditable=""]', '[role="textbox"]'];
  const cands = [];
  for (const sel of genericSels) {
    let els = [];
    try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { continue; }
    for (const el of els) {
      if (!vis(el) || isBlocked(el)) continue;
      if (el.closest('dialog,[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      cands.push({ el: el, area: r.width * r.height, sel: sel });
    }
  }
  cands.sort((a, b) => b.area - a.area);
  const genericWinner = cands.length
    ? {
      found: true,
      selector: stableSelector(cands[0].el),
      matched: cands[0].sel,
      tag: cands[0].el.tagName.toLowerCase(),
      area: Math.round(cands[0].area),
      rect: rectOf(cands[0].el),
      label: describe(cands[0].el),
      searchLike: isSearchLike(cands[0].el),
      candidateCount: cands.length,
    }
    : { found: false, selector: null, matched: null, tag: null, area: 0, candidateCount: 0 };

  // Multilingual on purpose: the owner's UI language is not knowable in advance (chatgpt.com
  // renders "Enviar"), and an icon-only control often carries its meaning only in id/data-testid.
  const sendRe = /send|submit|arrow|stop|enviar|envoyer|envoi|senden|absenden|invia|отправ|送信|发送|detener|arr[eê]ter|stoppen|interrump/i;
  const sendControls = [];
  const seenButtons = new Set();
  for (const b of document.querySelectorAll('button,[role="button"],input[type="submit"]')) {
    if (seenButtons.has(b)) continue;
    seenButtons.add(b);
    if (!vis(b)) continue;
    const label = normText(
      (b.getAttribute('aria-label') || '') + ' ' +
      (b.getAttribute('title') || '') + ' ' +
      (b.getAttribute('data-testid') || '') + ' ' +
      (b.getAttribute('data-test-id') || '') + ' ' +
      (b.id || '') + ' ' +
      (b.innerText || b.value || '')
    );
    if (!label || !sendRe.test(label)) continue;
    if (sendControls.length >= 30) break;
    sendControls.push({
      selector: stableSelector(b),
      tag: b.tagName.toLowerCase(),
      label: label.slice(0, 120),
      disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
      type: b.getAttribute('type'),
      isSubmit: String(b.getAttribute('type') || '').toLowerCase() === 'submit',
      inForm: !!b.closest('form'),
      rect: rectOf(b),
    });
  }

  const assistantSels = [
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant"]',
    '[data-testid^="conversation-turn"]',
    '[class*="assistant"]',
    'article',
    '.markdown',
    '[class*="prose"]',
    '[class*="markdown"]',
  ];
  const assistantContainers = [];
  const seenAssist = new Set();
  for (const sel of assistantSels) {
    let els = [];
    try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { els = []; }
    for (const el of els) {
      if (seenAssist.has(el)) continue;
      seenAssist.add(el);
      if (!vis(el)) continue;
      if (assistantContainers.length >= 40) break;
      const text = String(el.innerText || el.textContent || '');
      assistantContainers.push({
        selector: stableSelector(el),
        matched: sel,
        tag: el.tagName.toLowerCase(),
        rect: rectOf(el),
        textLength: text.length,
        text80: normText(text).slice(0, 80),
      });
    }
  }

  const streamingSels = [
    'button[aria-label*="stop" i]',
    '[role="button"][aria-label*="stop" i]',
    '[data-testid="stop-button"]',
    '[data-testid*="stop" i]',
    '[aria-busy="true"]',
  ];
  const streamingMarkers = [];
  for (const sel of streamingSels) {
    let els = [];
    try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { els = []; }
    let visible = 0;
    for (const el of els) if (vis(el)) visible++;
    streamingMarkers.push({
      selector: sel,
      present: els.length > 0,
      count: els.length,
      visibleCount: visible,
      sample: els.length ? stableSelector(els[0]) : null,
    });
  }

  const classCounts = new Map();
  let scanned = 0;
  for (const el of document.querySelectorAll('*')) {
    if (++scanned > 20000) break;
    const cn = String(el.getAttribute('class') || '').trim();
    if (!cn) continue;
    classCounts.set(cn, (classCounts.get(cn) || 0) + 1);
  }
  const pageClasses = Array.from(classCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map((entry) => ({ class: entry[0].slice(0, 200), count: entry[1] }));

  // Login-wall evidence. A usable composer always wins: logged-in pages legitimately carry
  // "Sign in" promo links, so presence of those alone is not evidence of a wall.
  let pathname = '';
  try { pathname = new URL(location.href).pathname.toLowerCase(); } catch (e) { pathname = ''; }
  const urlWall = /(^|\/)(login|log-in|signin|sign-in|auth|authorize|signup|register)(\/|$)/.test(pathname);
  const loginLinks = [];
  for (const sel of ['a[href*="/login" i]', 'a[href*="/signin" i]', 'a[href*="/sign-in" i]', 'a[href*="/auth/" i]', 'a[href*="login?" i]']) {
    let els = [];
    try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { els = []; }
    for (const el of els) {
      if (!vis(el)) continue;
      loginLinks.push({ selector: stableSelector(el), href: String(el.getAttribute('href') || '').slice(0, 120), text: normText(el.innerText).slice(0, 40) });
      if (loginLinks.length >= 5) break;
    }
    if (loginLinks.length >= 5) break;
  }
  const bodyText = String((document.body && document.body.innerText) || '').slice(0, 4000);
  const wallMatch = bodyText.match(/(sign in to continue|log in to continue|you need to sign in|please sign in|you must be signed in|continue with google|continue with email|enter your email|sign up to continue|log in or sign up)/i);
  // Only a genuinely writable control counts: Kimi's editor shell is [contenteditable="false"],
  // so counting it would falsely report a usable composer (and hide a login wall).
  const chatComposers = composerCandidates.filter((c) => !c.searchLike && (
    c.isContentEditable === true || c.tag === 'textarea' || c.tag === 'input' || c.matched === '[role="textbox"]'
  ));
  const hasComposer = chatComposers.length > 0;
  const evidence = [];
  if (urlWall) evidence.push('login URL: ' + location.href);
  if (loginLinks.length) evidence.push('login links: ' + loginLinks.length);
  if (wallMatch) evidence.push('wall text: ' + wallMatch[0]);
  if (hasComposer) evidence.push('chat composer present (' + chatComposers.length + ')');
  if (!hasComposer && composerCandidates.length) evidence.push('only search-like inputs visible (' + composerCandidates.length + ')');
  const loggedOut = !hasComposer && (urlWall || loginLinks.length > 0 || !!wallMatch);

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    login: {
      loggedOut: loggedOut,
      hasComposer: hasComposer,
      chatComposerCount: chatComposers.length,
      urlWall: urlWall,
      loginLinks: loginLinks,
      wallText: wallMatch ? wallMatch[0] : null,
      evidence: evidence,
    },
    composerCandidates: composerCandidates,
    genericWinner: genericWinner,
    sendControls: sendControls,
    assistantContainers: assistantContainers,
    streamingMarkers: streamingMarkers,
    pageClasses: pageClasses,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
function hostMatches(adapter, url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const bare = host.replace(/^www\./, '');
  for (const raw of adapter?.hosts ?? []) {
    const w = String(raw).toLowerCase().replace(/^www\./, '');
    if (w && (bare === w || bare.endsWith('.' + w))) return true;
  }
  return false;
}

function bareHost(value) {
  let v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split('/')[0].split('?')[0].split('#')[0];
  v = v.split('@').pop();
  return v.replace(/:\d+$/, '').replace(/^www\./, '');
}

function slugify(value) {
  return bareHost(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

// Numeric / uuid / long-opaque segments become :id so endpoints across conversations collapse.
function pathPattern(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return String(rawUrl).slice(0, 200); }
  let p = u.pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d{3,}/g, '/:id')
    .replace(/\/[A-Za-z0-9_-]{24,}/g, '/:id');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return u.host + (p || '/');
}

async function evaluate(page, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description ?? d.text ?? 'Runtime.evaluate failed');
  }
  return returnByValue ? r?.result?.value : r?.result;
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

async function waitForLoaded(page, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    let state = null;
    try { state = await evaluate(page, 'document.readyState + "|" + document.title'); } catch { state = null; }
    if (state && String(state).startsWith('complete')) return true;
    if (Date.now() >= deadline) return false;
    await sleep(400);
  }
}

// A draft in the composer is the one thing a reload could destroy, so it gates the reload below.
async function composerHasDraft(page) {
  try {
    const v = await evaluate(page, `(() => {
      for (const el of document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')) {
        const r = el.getBoundingClientRect();
        if (!(r.width > 1 && r.height > 1)) continue;
        const t = String(el.value != null && el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || '')).trim();
        if (t) return t.slice(0, 60);
      }
      return '';
    })()`);
    return String(v || '');
  } catch { return ''; }
}

// ---------------------------------------------------------------------------------------------
// Network recorder (passive: nothing is sent to the site by this script)
// ---------------------------------------------------------------------------------------------
function createNetworkRecorder(page) {
  const requests = new Map();
  const websockets = [];
  let websocketFrames = 0;
  let failed = 0;

  page.on('Network.requestWillBeSent', (p) => {
    if (!p?.request?.url) return;
    requests.set(p.requestId, {
      url: p.request.url,
      method: p.request.method || 'GET',
      resourceType: p.type || 'Other',
      startedAt: Date.now(),
      status: null,
      mimeType: null,
      contentType: null,
    });
  });
  page.on('Network.responseReceived', (p) => {
    const entry = requests.get(p.requestId);
    if (!entry) return;
    entry.status = p.response?.status ?? null;
    entry.mimeType = p.response?.mimeType ?? null;
    const headers = p.response?.headers || {};
    const ct = headers['content-type'] || headers['Content-Type'] || null;
    entry.contentType = ct ? String(ct).slice(0, 120) : (entry.mimeType ? String(entry.mimeType).slice(0, 120) : null);
  });
  page.on('Network.loadingFailed', () => { failed++; });
  page.on('Network.webSocketCreated', (p) => {
    let host = '';
    try { host = new URL(p.url).host; } catch { host = ''; }
    websockets.push({ host, url: String(p.url).split('?')[0].slice(0, 200), createdAt: Date.now() });
  });
  page.on('Network.webSocketFrameReceived', () => { websocketFrames++; });
  page.on('Network.webSocketFrameSent', () => { websocketFrames++; });

  return {
    requests,
    websockets,
    get failures() { return failed; },
    get frameEvents() { return websocketFrames; },
    summary() {
      const list = [];
      for (const entry of requests.values()) {
        if (!entry.url || /^(data|blob|chrome-extension|devtools):/i.test(entry.url)) continue;
        list.push(entry);
      }
      const interesting = /(chat|completion|conversation|message|generate|stream|reply|chat_)/i;
      const byPattern = new Map();
      for (const entry of list) {
        if (!interesting.test(entry.url)) continue;
        if (entry.resourceType === 'Image' || entry.resourceType === 'Font' || entry.resourceType === 'Stylesheet') continue;
        const pattern = pathPattern(entry.url);
        const key = pattern + ' ' + entry.method;
        const prev = byPattern.get(key);
        if (prev) {
          prev.count++;
          if (!prev.contentType && entry.contentType) prev.contentType = entry.contentType;
          continue;
        }
        byPattern.set(key, {
          path: pattern,
          method: entry.method,
          resourceType: entry.resourceType,
          status: entry.status,
          contentType: entry.contentType,
          streamingHint: /text\/event-stream/i.test(String(entry.contentType || '')) || /stream|event/i.test(pattern),
          count: 1,
        });
      }
      return {
        totalRequests: list.length,
        resourceTypes: list.reduce((acc, e) => { const k = e.resourceType || 'Other'; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
        streamCandidates: [...byPattern.values()].sort((a, b) => b.count - a.count),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { input: null, port: 9222, outDir: DEFAULT_OUT, wait: 8, keepOpen: false, reload: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { out.port = Number(argv[++i]); if (!Number.isFinite(out.port)) out.errors.push('--port needs a number'); }
    else if (a === '--out') { const v = argv[++i]; if (!v) out.errors.push('--out needs a directory'); else out.outDir = path.resolve(v); }
    else if (a === '--wait') { out.wait = Number(argv[++i]); if (!Number.isFinite(out.wait) || out.wait < 1) out.errors.push('--wait needs seconds >= 1'); }
    else if (a === '--keep-open') out.keepOpen = true;
    else if (a === '--reload') out.reload = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) out.errors.push(`unknown flag: ${a}`);
    else if (!out.input) out.input = a;
  }
  return out;
}

const HELP = `probe-site — read-only DOM/transport probe for one AI chat site

  node scripts/probe-site.mjs <site|url> [options]

  <site>        adapter id from src/profiles/sites (chatgpt, claude, gemini, deepseek, zai,
                qwen, lmarena, minimax, kimi) or any absolute URL
  --port N      DevTools port (default 9222)
  --out DIR     output directory (default docs/research/probe)
  --wait S      seconds to observe network traffic (default 8)
  --reload      force one reload of a REUSED tab to observe app-load traffic
  --keep-open   leave a tab the probe opened in place (never closes a reused tab either way)

  Exit 0 ok · 3 unreachable / login-walled · 5 no DevTools endpoint
  The probe never types, clicks a send control, or submits anything.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  if (!args.input) { console.error(HELP); return 5; }
  if (args.errors.length) { for (const e of args.errors) console.error(`probe: ${e}`); return 5; }

  const errors = [];
  const port = args.port;

  if (!(await isReachable({ port }))) {
    console.error(`probe: no DevTools endpoint on 127.0.0.1:${port}`);
    return 5;
  }

  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(args.input);
  const adapter = await getAdapter(args.input);
  const site = adapter?.id ?? (isUrl ? slugify(args.input) : slugify(args.input));

  // Existing tab first: the person is already logged in there and nothing is disturbed.
  let targets = [];
  try { targets = await listTargets({ port }); }
  catch (e) { console.error(`probe: cannot list targets: ${String(e?.message ?? e)}`); return 5; }

  const matchFor = (adapter ?? { hosts: [bareHost(args.input)] });
  let target = targets.find((t) => hostMatches(matchFor, t.url)) ?? null;
  const openedByProbe = !target;
  let conn = null;

  try {
    if (!target) {
      const openUrl = adapter?.url ?? (isUrl ? args.input : `https://${bareHost(args.input)}/`);
      try {
        const created = await openTab(port, openUrl);
        target = await waitForTargetId(port, created?.id, { timeoutMs: Math.max(8000, args.wait * 1000) });
      } catch (e) {
        errors.push(`could not open ${openUrl}: ${String(e?.message ?? e)}`);
      }
      if (!target) {
        console.error(`probe: ${site} unreachable (${errors[errors.length - 1] ?? 'no tab'})`);
        return 3;
      }
    }

    conn = await CdpConnection.connect(await browserWsUrl({ port }), { requestTimeoutMs: 20000 });
    const page = await conn.attach(target.id);
    await page.trySend('Page.enable');
    await page.trySend('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    const net = createNetworkRecorder(page);

    // A tab this script opened is refreshed once so its app-load traffic is complete; a reused tab
    // is left exactly as it is (a reload could destroy an unsent draft).
    if (openedByProbe) {
      await page.trySend('Page.reload', { ignoreCache: false });
    }
    await waitForLoaded(page, Math.max(6000, args.wait * 1000));

    // Let a single-page app finish mounting before snapshotting: a composer that exists while
    // readyState is still "interactive" is often the wrong element (DeepSeek's sidebar search box
    // is a textarea too), so a candidate alone is not proof the page has settled.
    let facts = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        facts = await evaluate(page, `(${collectPageFacts.toString()})()`);
      } catch (e) {
        errors.push(`DOM snapshot failed: ${String(e?.message ?? e)}`);
        break;
      }
      const settled = facts?.readyState === 'complete';
      const haveChat = (facts?.login?.chatComposerCount ?? 0) > 0;
      if (settled && (haveChat || facts?.loggedOut)) break;
      if (attempt === 4) break;
      await sleep(1500);
    }
    if (!facts) facts = {};

    // --reload refreshes a REUSED tab, but never when the composer holds a draft: a reload would
    // destroy text the person has not sent.
    if (!openedByProbe && args.reload) {
      const draft = await composerHasDraft(page);
      if (draft) errors.push(`reused tab has a draft ("${draft}"); skipped --reload`);
      else {
        await page.trySend('Page.reload', { ignoreCache: false });
        await waitForLoaded(page, Math.max(6000, args.wait * 1000));
      }
    }

    // Observe the traffic window on the person's tab (passive: nothing is sent).
    await sleep(args.wait * 1000);
    const netSummary = net.summary();

    // A reused tab is often idle: no traffic to observe. Rather than reload (draft risk) or type
    // anything, open a short-lived sidecar tab of the same site — same cookies, still logged in —
    // watch its app-load traffic, then close it. The person's tab is never touched.
    let sidecar = null;
    if (!openedByProbe && netSummary.totalRequests < 5) {
      const sideUrl = adapter?.url ?? facts.url ?? target.url;
      let sideId = null;
      try {
        const created = await openTab(port, sideUrl);
        const sideTarget = await waitForTargetId(port, created?.id, { timeoutMs: 15000 });
        if (!sideTarget) throw new Error('sidecar tab did not appear');
        sideId = sideTarget.id;
        const sidePage = await conn.attach(sideId);
        await sidePage.trySend('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
        const sideNet = createNetworkRecorder(sidePage);
        await waitForLoaded(sidePage, Math.max(6000, args.wait * 1000));
        await sleep(args.wait * 1000);
        sidecar = sideNet.summary();
        for (const ws of sideNet.websockets) {
          if (!net.websockets.some((w) => w.url === ws.url)) net.websockets.push(ws);
        }
      } catch (e) {
        errors.push(`sidecar traffic probe failed for ${sideUrl}: ${String(e?.message ?? e)}`);
      } finally {
        if (sideId) { try { await conn.send('Target.closeTarget', { targetId: sideId }, { timeoutMs: 5000 }); } catch { /* gone */ } }
      }
    }

    // Merge stream candidates from both observations, collapsing equal method+path pairs.
    if (sidecar) {
      for (const c of sidecar.streamCandidates) {
        const hit = netSummary.streamCandidates.find((x) => x.path === c.path && x.method === c.method);
        if (hit) { hit.count += c.count; hit.contentType = hit.contentType ?? c.contentType; hit.status = hit.status ?? c.status; }
        else netSummary.streamCandidates.push(c);
      }
      netSummary.streamCandidates.sort((a, b) => b.count - a.count);
      netSummary.totalRequests += sidecar.totalRequests;
      netSummary.resourceTypes = Object.entries(sidecar.resourceTypes).reduce(
        (acc, [k, v]) => { acc[k] = (acc[k] || 0) + v; return acc; }, { ...netSummary.resourceTypes }
      );
    }
    const login = facts.login ?? { loggedOut: false, hasComposer: false, evidence: [] };
    const loggedOut = !!login.loggedOut;

    const document_ = {
      site,
      probedAt: new Date().toISOString(),
      url: facts.url ?? target.url ?? null,
      title: facts.title ?? target.title ?? null,
      loggedOut,
      composerCandidates: facts.composerCandidates ?? [],
      genericWinner: facts.genericWinner ?? null,
      sendControls: facts.sendControls ?? [],
      assistantContainers: facts.assistantContainers ?? [],
      streamingMarkers: facts.streamingMarkers ?? [],
      pageClasses: facts.pageClasses ?? [],
      streamCandidates: netSummary.streamCandidates,
      websockets: net.websockets,
      errors,
      // Diagnostic extras (not part of the capture contract, useful when writing adapters).
      tab: { id: target.id, openedByProbe, port },
      loginEvidence: login.evidence ?? [],
      network: {
        windowSeconds: args.wait,
        totalRequests: netSummary.totalRequests,
        resourceTypes: netSummary.resourceTypes,
        failures: net.failures,
        websocketFrameEvents: net.frameEvents,
        sidecarTab: !!sidecar,
      },
      readyState: facts.readyState ?? null,
    };

    fs.mkdirSync(args.outDir, { recursive: true });
    const outFile = path.join(args.outDir, `${site}.json`);
    fs.writeFileSync(outFile, JSON.stringify(document_, null, 2) + '\n', 'utf8');

    const compact = (v, n = 96) => (v ? (v.length > n ? v.slice(0, n) + '…' : v) : '—');
    const winner = document_.genericWinner;
    console.log('');
    console.log(`${site} — ${document_.url}`);
    console.log(`  title         : ${compact(document_.title, 80)}`);
    console.log(`  state         : ${loggedOut ? 'LOGIN WALL' : 'reachable'}${login.hasComposer ? ', composer usable' : ', no composer'}; readyState=${document_.readyState}`);
    console.log(`  composers     : ${document_.composerCandidates.length} visible input(s), ${login.chatComposerCount ?? 0} chat composer(s); generic winner=${winner?.found ? `${winner.matched}${winner.searchLike ? ' SEARCH-BOX' : ''} (${winner.selector})` : 'none'} [${winner?.candidateCount ?? 0} candidates]`);
    console.log(`  send controls : ${document_.sendControls.length}${document_.sendControls.length ? ` (e.g. ${compact(document_.sendControls[0].label, 50)})` : ''}`);
    console.log(`  assistant els : ${document_.assistantContainers.length}`);
    console.log(`  requests      : ${netSummary.totalRequests} in ${args.wait}s${sidecar ? ' (incl. sidecar load)' : ''}, ${net.websockets.length} websocket(s)`);
    const top = netSummary.streamCandidates.slice(0, 5);
    console.log(`  stream paths  : ${top.length ? '' : 'none observed'}`);
    for (const c of top) console.log(`    - ${c.method} ${c.path} [${c.resourceType}, ${c.count}x, ${c.contentType ?? '?'}]`);
    console.log(`  written       : ${outFile}`);
    if (errors.length) for (const e of errors) console.log(`  note          : ${e}`);

    if (loggedOut) return 3;
    return 0;
  } finally {
    if (conn) {
      if (openedByProbe && !args.keepOpen) {
        try { await conn.send('Target.closeTarget', { targetId: target.id }, { timeoutMs: 5000 }); } catch { /* already gone */ }
      }
      try { conn.close(); } catch { /* already closed */ }
    }
  }
}

const code = await main().catch((e) => {
  console.error(`probe: ${e?.stack ?? e}`);
  return 5;
});
process.exit(code);
