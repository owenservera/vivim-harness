// Frontend-only, deterministic Studio contract checks. No browser automation or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../src/studio/ui/index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1]?.split('</script>')[0] ?? '';
const start = script.indexOf('function formatEvidenceTime(');
const end = script.indexOf('/* ---------------- profiles ---------------- */', start);
const escLine = script.split('\n').find((line) => line.startsWith('const esc = '));
const boundary = script.indexOf('/* ---------------- Knowledge workspace', start);
const continuitySource = start >= 0 && end >= 0 ? script.slice(start, boundary > start ? boundary : end) : '';

function harness({ view, detailResponse } = {}) {
  const elements = {
    '#continuityOut': { innerHTML: '', querySelectorAll() { return buttons; } },
    '#continuityDetail': { innerHTML: '', textContent: '', isConnected: true, hidden: true },
  };
  let buttons = [];
  const S = { continuityRequestSeq: 1, sessionRequestSeq: 1 };
  const api = async (path) => typeof detailResponse === 'function' ? detailResponse(path) : detailResponse;
  const context = {
    $: (selector) => elements[selector], S, api, guard: (fn) => fn,
  };
  const functions = runInNewContext(escLine + '\n' + continuitySource + '\n({formatEvidenceTime,renderContinuity})', context, { timeout: 1000 });
  function render(nextView = view) {
    buttons = (nextView.entities || []).map((_, i) => ({ dataset: { index: String(i) } }));
    functions.renderContinuity(nextView, 'sessions/fixture/continuity', '', 1, 1);
    return { output: elements['#continuityOut'].innerHTML, buttons, detail: elements['#continuityDetail'] };
  }
  return { render, functions, S };
}

test('Studio inline script parses without DOM or network', () => {
  assert.ok(script.length > 1000);
  assert.doesNotThrow(() => new Script(script));
  for (const name of ['capture', 'streams', 'shapes', 'sessions', 'profiles', 'search'])
    assert.ok(html.includes('id="v-' + name + '"'), name);
});

test('Sessions remain keyboard-operable with filtering and feedback', () => {
  assert.match(html, /id="sessionFilter"/);
  assert.match(script, /function renderSessions\(\)/);
  assert.match(script, /button\[data-id\]/);
  assert.match(script, /b\.setAttribute\('aria-current', 'page'\)/);
  assert.match(script, /Could not open recording:/);
  assert.match(script, /Selection cleared; no previous evidence is shown as current/);
  assert.match(script, /const requestSeq = \+\+S\.sessionRequestSeq/);
});

test('Continuity view escapes evidence, shows incomplete and truncated scope', () => {
  const h = harness();
  const v = {
    entities: [{ id: 'e1', typeName: '<svg onload=evil()>', key: 'k', identityBasis: 'exact-site-type-key', sessionCount: 2, revisions: 3 }],
    stats: { joinedEntities: 1, sessionsDiscovered: 2, sessionsWithDerivedKnowledge: 1, sessionsWithoutKnowledge: ['s2'], sessionsWithDerivationError: [], entitiesTotal: 4, truncated: 3 },
    asOf: null,
  };
  const { output, buttons } = h.render(v);
  assert.match(output, /cross-session keyed matches/);
  assert.match(output, /may be incomplete/);
  assert.match(output, /additional entries/);
  assert.match(output, /&lt;svg/);
  assert.doesNotMatch(output, /<svg/);
  assert.equal(typeof buttons[0].onclick, 'function');
  assert.equal(h.functions.formatEvidenceTime(null), 'Time unavailable');
});

test('Entity evidence is readable, attributed, and HTML-escaped', async () => {
  const e = { id: 'e1', typeName: 'Item', key: 'k', identityBasis: 'exact-site-type-key', sessionCount: 2, revisions: 2 };
  const full = { entities: [{ ...e, attrs: { value: '<script>alert(1)</script>' }, history: [{ t: 1000, session: 's1', changed: ['value'], provenanceBasis: 'recorded-revision' }] }] };
  const h = harness({ detailResponse: full });
  const { buttons, detail } = h.render({ entities: [e], stats: {}, asOf: null });
  await buttons[0].onclick();
  assert.match(detail.innerHTML, /Observed attributes/);
  assert.match(detail.innerHTML, /Revision provenance/);
  assert.match(detail.innerHTML, /recorded-revision/);
  assert.match(detail.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(detail.innerHTML, /<script>/);
});

test('Continuity does not assert inferred deletion or calibration', () => {
  const h = harness();
  const { output } = h.render({ entities: [], stats: {}, asOf: null });
  assert.match(output, /Missing observations do not mean deletion/);
  assert.match(output, /cross-session confidence is not calibrated/);
  assert.match(output, /No saved entities at this point in time/);
});

test('Late evidence response never replaces a newer selection', async () => {
  let resolveFirst, resolveSecond;
  const responseFor = (path) => new Promise((resolve) => {
    if (path.includes('eid=e1')) resolveFirst = resolve;
    else resolveSecond = resolve;
  });
  const entities = ['e1', 'e2'].map((id) => ({ id, typeName: id, key: id, sessionCount: 1, revisions: 1 }));
  const h = harness({ detailResponse: responseFor });
  const { buttons, detail } = h.render({ entities, stats: {}, asOf: null });
  const first = buttons[0].onclick(), second = buttons[1].onclick();
  resolveSecond({ entities: [{ ...entities[1], attrs: { label: 'newer choice' }, history: [] }] });
  await second;
  resolveFirst({ entities: [{ ...entities[0], attrs: { label: 'stale choice' }, history: [] }] });
  await first;
  assert.match(detail.innerHTML, /newer choice/);
  assert.doesNotMatch(detail.innerHTML, /stale choice/);
});
