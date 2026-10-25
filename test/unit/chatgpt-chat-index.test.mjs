// Rendered chat-index foundation: synthetic DOM only. No browser, no network, no real transcript,
// no credentials. Fake anchors log any mutating or navigating call so a regression would be caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chatIndexExpression, normalizeChatIndex, pageOriginCode, CHAT_INDEX_LIMITS, CHATGPT_CANONICAL_ORIGIN } from '../../src/capture/chatgpt-chat-index.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const G = 'abcdef01-2345-4678-8abc-def012345678', GUPPER = 'ABCDEF01-2345-4678-8ABC-DEF012345678';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'SYNTHETIC-SECRET-VALUE-7731';
const FORBIDDEN = ['.click(', '.focus(', '.blur(', 'scrollIntoView', 'scrollTo', 'fetch', 'XMLHttpRequest', 'sendBeacon', '.submit(',
  'dispatchEvent', 'location.assign', 'location.replace', 'location.href', '.value =', '.remove(', 'innerHTML', 'setAttribute', 'dataset', 'data-token', 'history.'];
const ORIGIN = CHATGPT_CANONICAL_ORIGIN;

// Shared spy log: every fake method call lands here, and each observation must leave it empty.
const spyLog = [];
function anchor({ href, text = '', visible = true, inside = [] } = {}) {
  const el = {
    getAttribute: (name) => (name === 'href' ? href : name === 'data-token' ? SECRET : null),
    innerText: text,
    getBoundingClientRect: () => (visible ? { width: 40, height: 16 } : { width: 0, height: 0 }),
    closest: (selector) => (inside.includes(selector) ? el : null),
    dataset: { token: SECRET },
  };
  for (const name of ['click', 'focus', 'blur', 'scrollIntoView', 'dispatchEvent', 'setAttribute', 'remove']) {
    el[name] = () => { spyLog.push(name); };
  }
  return el;
}

// Runs the real in-page expression in an isolated context, then the normaliser on its JSON-cloned result,
// which is what a CDP returnByValue call delivers.
function observe(anchors, options = {}, { origin = ORIGIN } = {}) {
  const sandbox = { document: { querySelectorAll: (sel) => (sel === 'a[href]' ? anchors : []) }, location: { origin } };
  const expression = chatIndexExpression(options);
  spyLog.length = 0;
  const raw = JSON.parse(JSON.stringify(vm.runInNewContext(expression, sandbox)));
  assert.deepEqual(spyLog, [], 'expression must not call any mutating or navigating method');
  return { raw, out: normalizeChatIndex(raw, options) };
}

const ids = (out) => out.entries.map((e) => e.id);
const zeroSkips = (out) => Object.values(out.skipped).every((n) => n === 0);

// ------------------------------------------------------------------ purity of the observation
test('observation expression is pure: static guard finds no action, navigation, network or attribute reads', () => {
  const containers = [{ label: 'rendered-sidebar', selector: 'nav' }];
  const expression = chatIndexExpression({ containers });
  for (const token of FORBIDDEN) assert.equal(expression.includes(token), false, `forbidden token in expression: ${token}`);
  const { raw } = observe([anchor({ href: `/c/${A}`, text: 'Alpha', inside: ['nav'] })], { containers });
  assert.equal(raw.links.length, 1);
  assert.deepEqual(Object.keys(raw.links[0]).sort(), ['container', 'href', 'text', 'visible']);
  assert.equal(JSON.stringify(raw).includes(SECRET), false, 'data attributes are never read');
});

// ------------------------------------------------------------------ page origin is validated first
test('the canonical origin is the only accepted page origin', () => {
  assert.equal(pageOriginCode('https://chatgpt.com'), null);
  assert.equal(CHATGPT_CANONICAL_ORIGIN, 'https://chatgpt.com');
});

test('missing page origin with an absolute canonical href yields no candidates and a coded rejection', () => {
  const out = normalizeChatIndex({ renderedLinks: 1, links: [{ visible: true, href: `https://chatgpt.com/c/${A}`, text: 'x', container: -1 }] }, {});
  assert.equal(out.invalidResult, true); assert.equal(out.code, 'PAGE_ORIGIN_MISSING');
  assert.deepEqual(out.entries, []); assert.ok(zeroSkips(out), 'nothing is even counted: the page was refused first');
});

test('foreign page origin with an absolute canonical href yields no candidates and a coded rejection', () => {
  const out = normalizeChatIndex({ origin: 'https://evil.example', links: [{ visible: true, href: `https://chatgpt.com/c/${A}`, text: 'x', container: -1 }] }, {});
  assert.equal(out.code, 'PAGE_ORIGIN_FOREIGN'); assert.deepEqual(out.entries, []);
});

test('page origin rejection covers www, legacy alias, plain http, port, trailing slash and malformed values', () => {
  const link = [{ visible: true, href: `/c/${A}`, text: 'x', container: -1 }];
  const cases = [
    ['https://www.chatgpt.com', 'PAGE_ORIGIN_FOREIGN'], ['https://chat.openai.com', 'PAGE_ORIGIN_FOREIGN'],
    ['http://chatgpt.com', 'PAGE_ORIGIN_NON_HTTPS'], ['https://chatgpt.com:443', 'PAGE_ORIGIN_NONCANONICAL'],
    ['https://chatgpt.com/', 'PAGE_ORIGIN_NONCANONICAL'], ['not a url', 'PAGE_ORIGIN_MALFORMED'], [42, 'PAGE_ORIGIN_MALFORMED'],
  ];
  for (const [origin, code] of cases) {
    const out = normalizeChatIndex({ origin, links: link }, {});
    assert.equal(out.code, code, origin); assert.deepEqual(out.entries, [], origin); assert.equal(out.invalidResult, true, origin);
  }
});

test('correct exact origin is accepted and every candidate carries it', () => {
  const { out } = observe([anchor({ href: `https://chatgpt.com/c/${A}`, text: 'abs' }), anchor({ href: `/c/${B}`, text: 'rel' })]);
  assert.equal(out.invalidResult, false);
  assert.deepEqual(out.entries.map((e) => e.origin), [ORIGIN, ORIGIN]);
  assert.deepEqual(ids(out), [A, B]);
});

test('a relative link is resolved only against the canonical origin, never a page-supplied host', () => {
  const out = normalizeChatIndex({ origin: ORIGIN, links: [{ visible: true, href: `/c/${A}`, text: 't', container: -1 }] }, {});
  assert.deepEqual(ids(out), [A]);
  assert.equal(out.entries[0].origin, ORIGIN);
});

// ------------------------------------------------------------------ identity: candidates, never a live binding
test('canonical /c/<uuid> links become candidate entries in DOM order, never bound, with untrusted titles', () => {
  const { out } = observe([anchor({ href: `/c/${A}`, text: 'Alpha' }), anchor({ href: `https://chatgpt.com/c/${B}/`, text: 'Beta' })]);
  assert.deepEqual(ids(out), [A, B]);
  assert.deepEqual(out.entries[0], { threadRef: `chatgpt-c:${A}`, id: A, path: `/c/${A}`, origin: ORIGIN,
    displayTitle: { untrusted: true, text: 'Alpha', truncated: false }, titleVariants: 1, container: 'unknown', occurrences: 1,
    project: { state: 'unknown', reason: 'NOT_OBSERVED' }, identity: { state: 'candidate', reason: 'RENDERED_LINK_NOT_LIVE_BOUND' },
    liveBinding: { state: 'not-established', reason: 'NO_M1_BINDING' } });
  assert.equal(out.candidatesOnly, true); assert.equal(out.complete, false); assert.equal(out.scope, 'currently-rendered-links');
});

test('no false bound: no entry or output field ever claims a bound identity or live binding', () => {
  const { out } = observe([anchor({ href: `/c/${A}`, text: 'a' }), anchor({ href: `/c/${B}`, text: 'b' })]);
  assert.ok(out.entries.every((e) => e.identity.state === 'candidate' && e.liveBinding.state === 'not-established'));
  assert.equal(JSON.stringify(out).includes('"bound"'), false);
});

test('thread identity is case-insensitive on the UUID path; duplicates merge by origin and identity, never by title', () => {
  const { out } = observe([anchor({ href: `/c/${GUPPER}`, text: 'Same' }), anchor({ href: `https://chatgpt.com/c/${G}/`, text: 'Other' }),
    anchor({ href: `/c/${B}`, text: 'Same' })]);
  assert.deepEqual(ids(out), [G, B]);
  assert.equal(out.entries[0].threadRef, `chatgpt-c:${G}`);
  assert.equal(out.entries[0].occurrences, 2); assert.equal(out.entries[0].titleVariants, 2); assert.equal(out.entries[0].displayTitle.text, 'Same');
  assert.equal(out.entries[1].occurrences, 1);
  assert.equal(out.coverage.duplicatesMerged, 1); assert.equal(out.coverage.uniqueThreads, 2);
});

test('hidden links are excluded; a visible occurrence of the same thread still counts', () => {
  const { out } = observe([anchor({ href: `/c/${A}`, text: 'Hidden copy', visible: false }), anchor({ href: `/c/${B}`, text: 'Beta' }),
    anchor({ href: `/c/${A}`, text: 'Visible copy' })]);
  assert.deepEqual(ids(out), [B, A]);
  assert.equal(out.entries[1].displayTitle.text, 'Visible copy'); assert.equal(out.entries[1].occurrences, 1);
  assert.equal(out.skipped.HIDDEN_LINK, 1); assert.equal(out.coverage.visibleThreadLinks, 2);
});

test('hidden-only threads are absent entirely', () => {
  const { out } = observe([anchor({ href: `/c/${C}`, text: 'Gone', visible: false })]);
  assert.deepEqual(out.entries, []); assert.equal(out.skipped.HIDDEN_LINK, 1);
});

// ------------------------------------------------------------------ cross-origin and credentials are coded
test('different hostnames are FOREIGN_HOST: evil, lookalike, www and legacy alias are never merged', () => {
  const { out } = observe([
    anchor({ href: `https://evil.example/c/${A}`, text: 'a' }),
    anchor({ href: `https://chatgpt.com.evil.example/c/${B}`, text: 'b' }),
    anchor({ href: `https://www.chatgpt.com/c/${D}`, text: 'www alias' }),
    anchor({ href: `https://chat.openai.com/c/${C}`, text: 'legacy alias' }),
  ]);
  assert.equal(out.skipped.FOREIGN_HOST, 4); assert.deepEqual(out.entries, []);
});

test('same host on another port is CROSS_ORIGIN_LINK; an explicit default port is the same exact origin', () => {
  const { out } = observe([anchor({ href: `https://chatgpt.com:8443/c/${C}`, text: 'port' }), anchor({ href: `https://chatgpt.com:443/c/${A}`, text: 'default port' })]);
  assert.equal(out.skipped.CROSS_ORIGIN_LINK, 1);
  assert.deepEqual(ids(out), [A]);
});

test('protocol-relative links resolve on their own origin: foreign host refused, canonical host accepted', () => {
  const { out } = observe([anchor({ href: `//evil.example/c/${A}`, text: 'evil' }), anchor({ href: `//chatgpt.com/c/${B}`, text: 'same origin' })]);
  assert.equal(out.skipped.FOREIGN_HOST, 1);
  assert.deepEqual(ids(out), [B]);
});

test('credentials in a URL are refused even on the canonical host, and are never echoed', () => {
  const { out } = observe([anchor({ href: `https://synthetic-user:synthetic-pass@chatgpt.com/c/${A}`, text: 'cred' })]);
  assert.equal(out.skipped.CREDENTIALS_IN_URL, 1); assert.deepEqual(out.entries, []);
  const json = JSON.stringify(out);
  assert.equal(json.includes('synthetic-pass'), false); assert.equal(json.includes('synthetic-user'), false);
});

test('plain-http and javascript links are NON_HTTPS; unparseable hrefs are MALFORMED_URL; href-less links are NO_HREF', () => {
  const { out } = observe([anchor({ href: `http://chatgpt.com/c/${A}`, text: 'http' }), anchor({ href: 'javascript:alert(1)', text: 'js' }),
    anchor({ href: 'https://[bad', text: 'bad' }), anchor({ href: null, text: 'none' })]);
  assert.equal(out.skipped.NON_HTTPS, 2); assert.equal(out.skipped.MALFORMED_URL, 1); assert.equal(out.skipped.NO_HREF, 1);
  assert.deepEqual(out.entries, []);
});

test('root, home and new-chat links are never durable threads', () => {
  const { out } = observe([anchor({ href: '/', text: 'New chat' }), anchor({ href: 'https://chatgpt.com/?model=x', text: 'Home' }),
    anchor({ href: '/new', text: 'New' })]);
  assert.deepEqual(out.entries, []); assert.equal(out.skipped.ROOT_OR_HOME, 3);
});

test('project and custom-GPT forms are unsupported: no thread is inferred from them', () => {
  const { out } = observe([anchor({ href: `/g/g-p-abc/c/${A}`, text: 'Project chat' }), anchor({ href: '/g/g-p-abc/project', text: 'Project' })]);
  assert.deepEqual(out.entries, []);
  assert.equal(out.skipped.PROJECT_THREAD_UNSUPPORTED, 1); assert.equal(out.skipped.PROJECT_PAGE_UNSUPPORTED, 1);
  assert.equal(JSON.stringify(out).includes(A), false);
});

test('malformed thread paths and unrelated paths are coded, not guessed', () => {
  const { out } = observe([anchor({ href: '/c/not-a-uuid', text: 'x' }), anchor({ href: `/c/${A}/extra`, text: 'y' }), anchor({ href: '/settings', text: 'z' })]);
  assert.deepEqual(out.entries, []);
  assert.equal(out.skipped.MALFORMED_THREAD_PATH, 2); assert.equal(out.skipped.NOT_THREAD_PATH, 1);
});

// ------------------------------------------------------------------ title handling
test('titles are untrusted text: controls removed, length capped, markup inert, and never an identity input', () => {
  const hostile = `<img src=x onerror=alert(1)>\u0000\u200b /c/${B} ${'z'.repeat(500)}`;
  const { out } = observe([anchor({ href: `/c/${A}`, text: hostile })]);
  assert.deepEqual(ids(out), [A], 'identity comes from the href, not the title');
  const title = out.entries[0].displayTitle;
  assert.equal(title.untrusted, true); assert.equal(title.truncated, true);
  assert.equal(title.text.length, CHAT_INDEX_LIMITS.maxTitleChars.default);
  assert.ok(title.text.startsWith('<img src=x'), 'markup stays inert display text');
  assert.equal(/[\u0000\u200b]/.test(title.text), false);
  assert.equal(out.coverage.titleTruncated, 1);
});

test('an empty title keeps the candidate entry with a null display title', () => {
  const { out } = observe([anchor({ href: `/c/${A}`, text: '   ' })]);
  assert.deepEqual(ids(out), [A]); assert.equal(out.entries[0].displayTitle, null); assert.equal(out.entries[0].titleVariants, 0);
});

// ------------------------------------------------------------------ bounds, large index, determinism
test('large index is bounded by scan limit and entry cap, reports omissions, and is deterministic', () => {
  const anchors = Array.from({ length: 1200 }, (_, n) => anchor({ href: `/c/${uid(n + 1)}`, text: `Chat ${n}` }));
  const options = { scanLimit: 500, maxEntries: 50 };
  const first = observe(anchors, options).out, second = observe(anchors, options).out;
  assert.deepEqual(first, second, 'same input yields identical output');
  assert.equal(first.entries.length, 50);
  assert.equal(first.coverage.renderedLinks, 1200); assert.equal(first.coverage.scannedLinks, 500); assert.equal(first.coverage.truncatedScan, true);
  assert.equal(first.coverage.uniqueThreads, 500); assert.equal(first.coverage.omittedEntries, 450);
  assert.equal(first.entries[0].id, uid(1));
});

test('normaliser ceiling holds even when a hostile page returns far more links than the scan limit', () => {
  const links = Array.from({ length: 5000 }, (_, n) => ({ href: `/c/${uid(n + 1)}`, text: 't', visible: true, container: -1 }));
  const out = normalizeChatIndex({ origin: ORIGIN, renderedLinks: 5000, truncatedScan: false, links }, {});
  assert.equal(out.coverage.scannedLinks, CHAT_INDEX_LIMITS.scanLimit.default);
  assert.equal(out.coverage.truncatedScan, true);
  assert.equal(out.entries.length, CHAT_INDEX_LIMITS.maxEntries.default);
});

test('invalid bounds throw a coded error; invalid page results return a coded rejection instead of throwing', () => {
  for (const bad of [{ maxEntries: 0 }, { maxEntries: 1e9 }, { scanLimit: 1e9 }, { maxTitleChars: -1 }, { maxEntries: 2.5 }]) {
    assert.throws(() => normalizeChatIndex({ origin: ORIGIN, links: [] }, bad), (e) => e.code === 'INVALID_CHAT_INDEX_OPTIONS');
    assert.throws(() => chatIndexExpression(bad), (e) => e.code === 'INVALID_CHAT_INDEX_OPTIONS');
  }
  const hostileLinks = { origin: ORIGIN, links: [null, 5, { visible: true, href: `/c/${A}`, text: 't', container: -1 }] };
  for (const hostile of [null, 'string', { origin: ORIGIN, links: 'not-an-array' }]) {
    const out = normalizeChatIndex(hostile, {});
    assert.equal(out.complete, false); assert.equal(out.invalidResult, true); assert.equal(out.code, 'INVALID_RESULT'); assert.deepEqual(out.entries, []);
  }
  const out = normalizeChatIndex(hostileLinks, {});
  assert.deepEqual(ids(out), [A]); assert.equal(out.skipped.MALFORMED_LINK, 2);
});

// ------------------------------------------------------------------ completeness and scope
test('rendered-only scope is never reported complete, and virtualization is never claimed absent', () => {
  const { out } = observe([anchor({ href: `/c/${A}`, text: 'a' }), anchor({ href: `/c/${B}`, text: 'b' }), anchor({ href: `/c/${C}`, text: 'c' })]);
  assert.equal(out.complete, false); assert.equal(out.pagination, 'not-observed'); assert.equal(out.virtualization, 'unknown');
  assert.ok(out.limitations.some((line) => line.includes('not a complete account chat list')));
  assert.ok(out.limitations.some((line) => line.includes('Open browser tabs are not a chat index')));
  assert.ok(out.limitations.some((line) => line.includes('not a live binding')));
});

test('container labels and project context are unknown unless a verified selector is configured and matches', () => {
  const containers = [{ label: 'rendered-sidebar', selector: 'nav' }];
  const { out } = observe([anchor({ href: `/c/${A}`, text: 'in nav', inside: ['nav'] }), anchor({ href: `/c/${B}`, text: 'no container' })], { containers });
  assert.deepEqual(out.entries.map((e) => e.container), ['rendered-sidebar', 'unknown']);
  assert.ok(out.entries.every((e) => e.project.state === 'unknown'));
  const unconfigured = observe([anchor({ href: `/c/${A}`, text: 'in nav', inside: ['nav'] })]).out;
  assert.equal(unconfigured.entries[0].container, 'unknown', 'no label is invented without configuration');
  assert.throws(() => normalizeChatIndex({ origin: ORIGIN, links: [] }, { containers: [{ label: 'Rendered Sidebar!', selector: 'nav' }] }), (e) => e.code === 'INVALID_CHAT_INDEX_OPTIONS');
  assert.throws(() => normalizeChatIndex({ origin: ORIGIN, links: [] }, { containers: [{ label: 'unknown', selector: 'nav' }] }), (e) => e.code === 'INVALID_CHAT_INDEX_OPTIONS');
});

test('open browser tabs are never a chat index, and a page without a valid origin is refused', () => {
  const out = normalizeChatIndex({ targets: [{ url: `https://chatgpt.com/c/${A}` }], tabs: [{ id: 'tab' }], pages: [{ url: `https://chatgpt.com/c/${B}` }] }, {});
  assert.deepEqual(out.entries, []); assert.equal(out.invalidResult, true); assert.equal(out.code, 'PAGE_ORIGIN_MISSING');
});

test('observation never returns secrets or raw data attributes', () => {
  const { out } = observe([anchor({ href: `/c/${A}`, text: 'Alpha' })]);
  assert.equal(JSON.stringify(out).includes(SECRET), false);
});
