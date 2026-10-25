// Origin-aware evidence partitioning: pure helper that buckets reducer stream references by
// exact URL.origin relative to the captured page, and reports payload-eligibility flags for
// config/telemetry roles without removing those streams from the buckets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionEvidenceStreams } from '../../src/families/evidence-partitions.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';

const SITE = 'https://shop.example.com:8443/app?tab=chat';
const SITE_ORIGIN = 'https://shop.example.com:8443';

const row = (sid, url, extra = {}) => ({ sid, url, ...extra });
const sids = (refs) => refs.map((r) => r.sid);
const entryOf = (res, sid) => res.streams.find((e) => e.sid === sid);
const classOf = (res, sid) => entryOf(res, sid)?.originClass;

// ---------------------------------------------------------------------------------------------
// 1. Origin is scheme + host + port, exactly.
// ---------------------------------------------------------------------------------------------
test('splits by exact origin: ports, hosts and schemes are compared with URL.origin', () => {
  const rows = [
    row('same', `${SITE_ORIGIN}/api/chat`),
    row('default-port', 'https://shop.example.com/api/chat'),
    row('subdomain', 'https://api.shop.example.com/v1/chat'),
    row('http-scheme', 'http://shop.example.com:8443/api/chat'),
    row('other-port', 'https://shop.example.com:9443/api/chat'),
    row('ws-secure', 'wss://shop.example.com:8443/socket'),
    row('ws-plain', 'ws://shop.example.com:8443/socket'),
  ];
  const res = partitionEvidenceStreams(rows, { siteUrl: SITE });

  assert.equal(res.site.origin, SITE_ORIGIN);
  assert.deepEqual(sids(res.buckets.site.streams), ['same']);
  assert.deepEqual(sids(res.buckets.other.streams), ['default-port', 'subdomain', 'http-scheme', 'other-port', 'ws-secure', 'ws-plain']);
  assert.equal(res.buckets.unknown.streams.length, 0);
  assert.equal(res.buckets.other.streams[0], rows[1], 'bucket holds the input reference, not a copy');
  assert.equal(res.buckets.site.streams[0], rows[0]);
  assert.equal(classOf(res, 'ws-secure'), 'other');
  assert.equal(entryOf(res, 'ws-secure').origin, 'wss://shop.example.com:8443', 'ws/wss origins stay explicit');
  assert.notEqual(entryOf(res, 'ws-secure').origin, entryOf(res, 'ws-plain').origin, 'ws and wss never merge');
  assert.deepEqual(res.buckets.other.origins, [
    'http://shop.example.com:8443',
    'https://api.shop.example.com',
    'https://shop.example.com',
    'https://shop.example.com:9443',
    'ws://shop.example.com:8443',
    'wss://shop.example.com:8443',
  ]);
  assert.equal(res.totals.site, 1);
  assert.equal(res.totals.other, 6);
  assert.equal(res.totals.streams, 7);
});

// ---------------------------------------------------------------------------------------------
// 2. Default-port canonicalization is per scheme; schemes are never merged.
// ---------------------------------------------------------------------------------------------
test('canonicalizes default ports per scheme without merging http/https or ws/wss', () => {
  const rows = [
    row('https-default', 'https://a.test:443/x'),
    row('https-other', 'https://a.test:8443/x'),
    row('wss-default', 'wss://a.test:443/x'),
    row('ws-default', 'ws://a.test:80/x'),
    row('http-default', 'http://a.test:80/x'),
  ];
  const res = partitionEvidenceStreams(rows, { siteUrl: 'https://a.test/page' });

  assert.deepEqual(sids(res.buckets.site.streams), ['https-default']);
  assert.equal(entryOf(res, 'https-default').origin, 'https://a.test');
  assert.equal(entryOf(res, 'https-other').origin, 'https://a.test:8443');
  assert.equal(entryOf(res, 'wss-default').origin, 'wss://a.test');
  assert.equal(entryOf(res, 'ws-default').origin, 'ws://a.test');
  assert.equal(entryOf(res, 'http-default').origin, 'http://a.test');
  assert.equal(res.buckets.site.streams.length, 1, 'only the exact site origin is site');
});

// ---------------------------------------------------------------------------------------------
// 3. Missing / opaque / relative URLs are unknown, never guessed onto the site.
// ---------------------------------------------------------------------------------------------
test('unusable stream URLs are unknown and never assigned to the page', () => {
  const rows = [
    row('no-url', undefined),
    row('null-url', null),
    row('empty-url', ''),
    row('relative', '/api/chat'),
    row('protocol-relative', '//cdn.a.test/x'),
    row('garbage', 'not a url'),
    row('blank', 'about:blank'),
    row('data', 'data:text/plain,hello'),
    row('file', 'file:///c:/secret.txt'),
    row('extension', 'chrome-extension://abc/x'),
    row('blob', `blob:${SITE_ORIGIN}/opaque-id`),
  ];
  const res = partitionEvidenceStreams(rows, { siteUrl: SITE });

  assert.equal(res.buckets.site.streams.length, 0);
  assert.equal(res.totals.unknown, rows.length);
  assert.equal(res.buckets.unknown.streams.length, rows.length);
  for (const e of res.streams) {
    assert.equal(e.originClass, 'unknown', e.sid);
    assert.equal(e.origin, null, e.sid);
  }
  assert.equal(entryOf(res, 'no-url').originReason, 'missing-url');
  assert.equal(entryOf(res, 'relative').originReason, 'relative-url');
  assert.equal(entryOf(res, 'protocol-relative').originReason, 'relative-url');
  assert.equal(entryOf(res, 'garbage').originReason, 'unparseable-url');
  assert.equal(entryOf(res, 'blank').originReason, 'opaque-origin');
  assert.equal(entryOf(res, 'data').originReason, 'opaque-origin');
  assert.equal(entryOf(res, 'extension').originReason, 'opaque-origin', 'non-special schemes have opaque origins');
  assert.equal(entryOf(res, 'blob').originReason, 'unsupported-scheme');
  assert.deepEqual(res.buckets.unknown.reasons.map((r) => r.sid), sids(rows));
});

// ---------------------------------------------------------------------------------------------
// 4. No usable site URL: empty site bucket, valid origins are "other", DOM unattributed.
// ---------------------------------------------------------------------------------------------
test('missing or unusable siteUrl leaves the site bucket empty and DOM unattributed', () => {
  const rows = [row('a', 'https://a.test/x'), row('b', 'https://b.test/y')];
  const turns = [{ role: 'user', text: 'hello' }];

  for (const siteUrl of [undefined, null, '', 'not a url', 'about:blank', 'ws://a.test/socket']) {
    const res = partitionEvidenceStreams(rows, { siteUrl, domTurns: turns });
    assert.equal(res.site.origin, null, String(siteUrl));
    assert.equal(res.buckets.site.streams.length, 0);
    assert.deepEqual(sids(res.buckets.other.streams), ['a', 'b'], 'known origins are not "unknown"');
    assert.equal(res.dom.attributed, false);
    assert.equal(res.dom.turns.length, 0, 'DOM must not be attached to the site without a page origin');
    assert.equal(res.dom.provided, 1);
    assert.equal(res.dom.count, 0);
    assert.equal(res.dom.unattributedCount, 1, 'unknown-origin DOM is retained, not dropped');
    assert.equal(res.dom.unattributedTurns, turns, 'same caller array, by reference');
  }
  assert.equal(partitionEvidenceStreams(rows, {}).site.reason, 'missing-site-url');
});

// ---------------------------------------------------------------------------------------------
// 5. DOM attribution and preservation of unattributed DOM evidence.
// ---------------------------------------------------------------------------------------------
test('page DOM is attributed to the site origin only, while unknown-origin DOM stays inspectable', () => {
  const rows = [row('a', `${SITE_ORIGIN}/api`)];
  const turns = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }];
  Object.freeze(turns);

  const attributed = partitionEvidenceStreams(rows, { siteUrl: SITE, domTurns: turns });
  assert.equal(attributed.dom.attributed, true);
  assert.equal(attributed.dom.origin, SITE_ORIGIN);
  assert.equal(attributed.dom.count, 2);
  assert.equal(attributed.dom.turns, turns, 'attributed DOM is the caller array, not a copy');
  assert.equal(attributed.dom.unattributedCount, 0, 'one DOM list is non-empty, never both');
  assert.equal(attributed.dom.unattributedTurns.length, 0);

  const unattributed = partitionEvidenceStreams(rows, { domTurns: turns });
  assert.equal(unattributed.dom.attributed, false);
  assert.equal(unattributed.dom.turns.length, 0);
  assert.equal(unattributed.dom.count, 0, 'nothing is counted as site-attributed DOM');
  assert.equal(unattributed.dom.reason, 'missing-site-url');
  assert.equal(unattributed.dom.provided, 2);
  assert.equal(unattributed.dom.unattributedCount, 2, 'unattributed DOM is preserved');
  assert.equal(unattributed.dom.unattributedTurns, turns, 'same caller references, not a copy');
  assert.deepEqual(unattributed.buckets.other.streams.map((r) => r.sid), ['a'], 'streams still classify normally');

  const opaqueSite = partitionEvidenceStreams(rows, { siteUrl: 'about:blank', domTurns: turns });
  assert.equal(opaqueSite.dom.attributed, false);
  assert.equal(opaqueSite.dom.unattributedTurns, turns);
  assert.equal(opaqueSite.dom.unattributedCount, 2);
  assert.equal(opaqueSite.dom.reason, 'opaque-site-origin');

  const none = partitionEvidenceStreams(rows, { siteUrl: SITE });
  assert.equal(none.dom.attributed, false);
  assert.equal(none.dom.count, 0);
  assert.equal(none.dom.unattributedCount, 0);
  assert.equal(none.dom.unattributedTurns.length, 0);
  assert.equal(none.dom.reason, 'no-dom');

  for (const res of [attributed, unattributed, opaqueSite, none]) {
    const buckets = [res.buckets.site, res.buckets.other, res.buckets.unknown];
    assert.ok(!buckets.some((b) => b.streams.includes(turns) || b.payloadEligible.includes(turns)), 'DOM never leaks into a bucket');
    assert.ok(!buckets.some((b) => b.streams.includes(res.dom.unattributedTurns)));
  }
  assert.equal(unattributed.dom.unattributedTurns[0], turns[0], 'turn objects are the caller references');
});

// ---------------------------------------------------------------------------------------------
// 6. Role gating: only medium/high config|telemetry are payload-excluded; membership is unchanged.
// ---------------------------------------------------------------------------------------------
test('excludes only medium/high config and telemetry payloads, and keeps them as bucket evidence', () => {
  const rows = [
    row('config-high', `${SITE_ORIGIN}/cfg`, { method: 'GET' }),
    row('config-low', `${SITE_ORIGIN}/cfg2`),
    row('telemetry-med', `${SITE_ORIGIN}/t`),
    row('telemetry-string', `${SITE_ORIGIN}/t2`),
    row('reply-high', `${SITE_ORIGIN}/reply`),
    row('unknown-high', `${SITE_ORIGIN}/u`),
    row('mystery-high', `${SITE_ORIGIN}/m`),
    row('no-role', `${SITE_ORIGIN}/n`),
  ];
  const roles = new Map([
    ['config-high', { role: 'config', confidence: 'high' }],
    ['config-low', { role: 'config', confidence: 'low' }],
    ['telemetry-med', { role: 'telemetry', confidence: 'medium' }],
    ['telemetry-string', 'telemetry'],
    ['reply-high', { role: 'chat-reply', confidence: 'high' }],
    ['unknown-high', { role: 'unknown', confidence: 'high' }],
    ['mystery-high', { role: 'mystery', confidence: 'high' }],
  ]);
  const res = partitionEvidenceStreams(rows, { siteUrl: SITE, roles });

  assert.deepEqual(sids(res.buckets.site.streams), sids(rows), 'excluded streams stay in their bucket');
  assert.deepEqual(sids(res.buckets.site.payloadExcluded), ['config-high', 'telemetry-med']);
  assert.deepEqual(sids(res.buckets.site.payloadEligible), ['config-low', 'telemetry-string', 'reply-high', 'unknown-high', 'mystery-high', 'no-role']);
  assert.equal(res.totals.payloadExcluded, 2);
  assert.equal(entryOf(res, 'config-high').exclusion, 'config:high');
  assert.equal(entryOf(res, 'telemetry-med').exclusion, 'telemetry:medium');
  assert.equal(entryOf(res, 'config-low').exclusion, null);
  assert.equal(entryOf(res, 'telemetry-string').roleConfidence, 'none', 'a bare role string carries no confidence');
  assert.equal(entryOf(res, 'telemetry-string').payloadEligible, true);
  assert.equal(entryOf(res, 'mystery-high').payloadEligible, true, 'unrecognized roles are never excluded');
  assert.equal(entryOf(res, 'no-role').payloadEligible, true);
  assert.equal(entryOf(res, 'no-role').role, null);
  assert.equal(res.roles.applied, 7);
  assert.equal(res.roles.missing, 1);
});

// ---------------------------------------------------------------------------------------------
// 7. Row-carried role fields (e.g. summary({ includeStreamRoles: true })).
// ---------------------------------------------------------------------------------------------
test('reads role fields already present on a row and keeps low/unrecognized/missing roles eligible', () => {
  const rows = [
    row('cfg', `${SITE_ORIGIN}/cfg`, { role: 'config', roleConfidence: 'high' }),
    row('tel', `${SITE_ORIGIN}/tel`, { role: 'telemetry', roleConfidence: 'medium' }),
    row('cfg-low', `${SITE_ORIGIN}/cfg2`, { role: 'config', roleConfidence: 'low' }),
    row('odd', `${SITE_ORIGIN}/odd`, { role: 'mystery', roleConfidence: 'high' }),
    row('plain', `${SITE_ORIGIN}/plain`),
  ];
  const res = partitionEvidenceStreams(rows, { siteUrl: SITE });

  assert.deepEqual(sids(res.buckets.site.payloadExcluded), ['cfg', 'tel']);
  assert.deepEqual(sids(res.buckets.site.payloadEligible), ['cfg-low', 'odd', 'plain']);
  assert.equal(entryOf(res, 'cfg').roleSource, 'row');
  assert.equal(res.roles.source, 'none');
  assert.equal(res.roles.fromRow, 4);
  assert.equal(res.roles.missing, 1);
  assert.equal(res.roles.applied, 0);
});

// ---------------------------------------------------------------------------------------------
// 8. SID collisions never let one origin borrow another origin's role.
// ---------------------------------------------------------------------------------------------
test('ambiguous SIDs do not borrow a role across origins and are reported', () => {
  const rows = [
    row('dup', 'https://a.test/x'),
    row('dup', 'https://evil.test/x'),
    row('same-origin-dup', 'https://a.test/y'),
    row('same-origin-dup', 'https://a.test/y?again'),
    row('clean', 'https://a.test/clean'),
  ];
  const roles = new Map([
    ['dup', { role: 'config', confidence: 'high' }],
    ['same-origin-dup', { role: 'config', confidence: 'high' }],
    ['ghost', { role: 'config', confidence: 'high' }],
  ]);
  const res = partitionEvidenceStreams(rows, { siteUrl: 'https://a.test/page', roles });

  assert.deepEqual(sids(res.buckets.site.payloadExcluded), [], 'no duplicate row may be excluded');
  assert.deepEqual(sids(res.buckets.other.payloadExcluded), []);
  assert.deepEqual(sids(res.buckets.site.payloadEligible), ['dup', 'same-origin-dup', 'same-origin-dup', 'clean']);
  assert.deepEqual(res.roles.ambiguousSids, ['dup', 'same-origin-dup']);
  assert.deepEqual(res.roles.ignoredAmbiguous, ['dup', 'same-origin-dup']);
  assert.equal(res.roles.applied, 0);
  assert.deepEqual(res.roles.unmatchedKeys, ['ghost']);
  for (const e of res.streams.filter((x) => x.sid !== 'clean')) {
    assert.equal(e.roleMapIgnored, 'ambiguous-sid');
    assert.equal(e.payloadEligible, true);
  }
  assert.equal(entryOf(res, 'clean').role, null);
  assert.equal(entryOf(res, 'clean').roleSource, null);
});

// ---------------------------------------------------------------------------------------------
// 9. Frozen inputs, no mutation, deterministic repeated calls.
// ---------------------------------------------------------------------------------------------
test('never mutates frozen inputs and returns identical results across calls', () => {
  const rows = Object.freeze([
    Object.freeze(row('a', `${SITE_ORIGIN}/a`, { role: 'config', roleConfidence: 'high' })),
    Object.freeze(row('b', 'https://other.test/b')),
    Object.freeze(row('c', undefined)),
  ]);
  const turns = Object.freeze([Object.freeze({ role: 'user', text: 'x' })]);
  const roles = new Map([['b', { role: 'telemetry', confidence: 'high' }]]);
  const before = JSON.stringify(rows);

  const project = (res) => ({
    schema: res.schema,
    site: res.site,
    buckets: Object.fromEntries(Object.entries(res.buckets).map(([k, b]) => [k, {
      kind: b.kind,
      origin: b.origin,
      origins: b.origins ?? null,
      streams: sids(b.streams),
      payloadEligible: sids(b.payloadEligible),
      payloadExcluded: sids(b.payloadExcluded),
      reasons: b.reasons ?? null,
    }])),
    streams: res.streams.map(({ ref, ...rest }) => rest),
    dom: { ...res.dom, turns: res.dom.turns.length, unattributedTurns: res.dom.unattributedTurns.length },
    roles: res.roles,
    totals: res.totals,
  });

  const first = partitionEvidenceStreams(rows, { siteUrl: SITE, domTurns: turns, roles });
  const second = partitionEvidenceStreams(rows, { siteUrl: SITE, domTurns: turns, roles });
  assert.deepEqual(project(first), project(second));
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['role', 'roleConfidence', 'sid', 'url']);
  assert.equal(first.streams[0].ref, rows[0]);
});

// ---------------------------------------------------------------------------------------------
// 10. Real reducer contract: streams.values() and summary().streams both work.
// ---------------------------------------------------------------------------------------------
function fixtureReducer() {
  const r = new StreamReducer();
  r.ingestAll([
    { k: 'req', sid: 'http1', seq: 1, t: 1000, url: `${SITE_ORIGIN}/api/chat`, method: 'GET', type: 'Fetch' },
    { k: 'res', sid: 'http1', seq: 2, t: 1001, status: 200, mime: 'application/json' },
    { k: 'chunk', sid: 'http1', seq: 3, t: 1002, b64: Buffer.from('{"ok":true}').toString('base64') },
    { k: 'done', sid: 'http1', seq: 4, t: 1003, encodedDataLength: 11 },
    { k: 'req', sid: 'cdn1', seq: 5, t: 1004, url: 'https://cdn.other.test/app.js', method: 'GET', type: 'Script' },
    { k: 'ws.open', sid: 'ws1', seq: 6, t: 1005, url: 'wss://shop.example.com:8443/socket' },
  ]);
  return r;
}

test('accepts actual reducer stream objects and their summary rows without extra opt-in', () => {
  const reducer = fixtureReducer();
  const turns = [{ role: 'user', text: 'hi' }];

  const live = partitionEvidenceStreams(reducer.streams.values(), { siteUrl: SITE, domTurns: turns });
  assert.deepEqual(sids(live.buckets.site.streams), ['http1']);
  assert.deepEqual(sids(live.buckets.other.streams), ['cdn1', 'ws1']);
  assert.equal(live.buckets.site.streams[0], reducer.streams.get('http1'), 'passes the live stream reference through');
  assert.equal(live.dom.attributed, true);

  const summaryRows = reducer.summary().streams;
  const fromSummary = partitionEvidenceStreams(summaryRows, { siteUrl: SITE });
  assert.deepEqual(sids(fromSummary.buckets.site.streams), ['http1']);
  assert.deepEqual(sids(fromSummary.buckets.other.streams), ['cdn1', 'ws1']);
  assert.equal(fromSummary.buckets.site.streams[0], summaryRows.find((s) => s.sid === 'http1'));
  assert.equal(fromSummary.streams[0].role, null, 'no role classification is requested or performed');

  const asMap = partitionEvidenceStreams(reducer.streams, { siteUrl: SITE });
  assert.deepEqual(sids(asMap.buckets.site.streams), ['http1']);
  assert.deepEqual(sids(asMap.buckets.other.streams), ['cdn1', 'ws1']);
});

// ---------------------------------------------------------------------------------------------
// 11. No hidden payload copies: entries are references plus content-free classification fields.
// ---------------------------------------------------------------------------------------------
test('entries expose references and content-free fields only', () => {
  const rows = [row('a', `${SITE_ORIGIN}/a`), row('b', 'https://x.test/b')];
  const res = partitionEvidenceStreams(rows, { siteUrl: SITE });
  assert.deepEqual(Object.keys(res.streams[0]).sort(), [
    'exclusion', 'exclusionBlocked', 'fullyInspected', 'origin', 'originClass', 'originReason', 'payloadEligible',
    'ref', 'role', 'roleConfidence', 'roleMapIgnored', 'roleSource', 'sid',
  ]);
  assert.equal(res.schema, 'capture-studio.evidence-partitions/1');
  assert.ok(!('json' in res.streams[0]) && !('events' in res.streams[0]));
});

// ---------------------------------------------------------------------------------------------
// 12. No cross-call leakage: the same origin is site in one call and other in another.
// ---------------------------------------------------------------------------------------------
test('classification is per call; no module state carries a previous site origin', () => {
  const rows = [row('a', 'https://a.test/x'), row('b', 'https://b.test/y')];
  const first = partitionEvidenceStreams(rows, { siteUrl: 'https://a.test/page' });
  const second = partitionEvidenceStreams(rows, { siteUrl: 'https://b.test/page' });

  assert.deepEqual(sids(first.buckets.site.streams), ['a']);
  assert.deepEqual(sids(second.buckets.site.streams), ['b']);
  assert.deepEqual(sids(first.buckets.other.streams), ['b']);
  assert.deepEqual(sids(second.buckets.other.streams), ['a']);
  assert.equal(first.site.origin, 'https://a.test');
  assert.equal(second.site.origin, 'https://b.test');
});

// ---------------------------------------------------------------------------------------------
// 13. Graceful, deterministic handling of junk items in the iterable.
// ---------------------------------------------------------------------------------------------
test('skips non-row items without throwing and reports the count', () => {
  const res = partitionEvidenceStreams([row('a', `${SITE_ORIGIN}/a`), null, 7, 'nope'], { siteUrl: SITE });
  assert.deepEqual(sids(res.buckets.site.streams), ['a']);
  assert.equal(res.totals.skipped, 3);
  assert.equal(res.totals.streams, 1);
});

// Role gating needs the classifier's own inspection statement: a config / telemetry label from a stream that
// was NOT fully inspected never removes payload evidence; requireCoverage makes the statement mandatory.
test('payload exclusion honours coverage.fullyInspected (explicit false always blocks; requireCoverage demands true)', () => {
  const mk = (sid, cov) => ({ sid, url: `${SITE_ORIGIN}/${sid}`, role: 'config', roleConfidence: 'high', ...(cov === undefined ? {} : { roleCoverage: { fullyInspected: cov } }) });
  const rows = [mk('full', true), mk('cut', false), mk('none')];
  const legacy = partitionEvidenceStreams(rows, { siteUrl: SITE });
  assert.deepEqual(legacy.buckets.site.payloadExcluded.map((r) => r.sid), ['full', 'none']);
  assert.equal(legacy.streams.find((e) => e.sid === 'cut').exclusionBlocked, 'not-fully-inspected');
  const strict = partitionEvidenceStreams(rows, { siteUrl: SITE, requireCoverage: true });
  assert.deepEqual(strict.buckets.site.payloadExcluded.map((r) => r.sid), ['full']);
  assert.deepEqual(strict.buckets.site.payloadEligible.map((r) => r.sid), ['cut', 'none']);
  assert.equal(strict.totals.payloadKeptNotFullyInspected, 2);
  assert.equal(strict.buckets.site.streams.length, 3, 'membership never changes');
});