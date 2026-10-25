// Universality: the same generic engine against substantially different site patterns.
// Real headless Chromium + synthetic fixtures. Run: CHROME_PATH=... npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSite } from '../fixtures/site.mjs';
import { hasChrome, launchHeadless, userDriver, sleep, waitFor } from './helpers.mjs';
import { Recorder } from '../../src/capture/recorder.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { FamilyStore } from '../../src/families/families.mjs';
import { Session } from '../../src/store/session.mjs';
import { derive } from '../../src/replay/derive.mjs';
import { applySuggestion } from '../../src/profiles/apply.mjs';

const PORT = 9800 + Math.floor(Math.random() * 150);
const skip = !hasChrome && 'set CHROME_PATH';
let site, chrome, dataDir, profiles, families, sessionsDir, user;

before(async () => {
  if (!hasChrome) return;
  site = await startSite();
  chrome = await launchHeadless(site.url, PORT);
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'cs-uni-'));
  sessionsDir = path.join(dataDir, 'sessions');
  profiles = new ProfileStore(path.join(dataDir, 'profiles'));
  families = new FamilyStore(path.join(dataDir, 'families'));
  for (const n of ['fixture-chat-a', 'fixture-chat-b', 'fixture-dash', 'fixture-feed', 'fixture-form', 'fixture-article']) profiles.save(n, { ...profiles.load('generic'), name: n, match: { hosts: [] } }, 'test profile');
  const form = profiles.load('fixture-form');
  profiles.save('fixture-form', { ...form, capture: { ...form.capture, privacyMode: 'filtered' } }, 'form privacy assertions require filtered capture');
  user = await userDriver(PORT, '127.0.0.1');
});
after(() => {
  user?.close(); chrome?.kill(); site?.server.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function goto(p) {
  await user.eval(`location.href = ${JSON.stringify(site.url.slice(0, -1) + p)}`);
  await sleep(150);
  await waitFor(async () => (await user.eval('document.readyState').catch(() => '')) === 'complete');
  await sleep(200);
}

async function capture(p, profile, interact, { recorderOpts = {} } = {}) {
  await goto(p);
  const rec = new Recorder({ sessionsDir, profileStore: profiles, familyStore: families, port: PORT, ...recorderOpts });
  const s = await rec.start({ target: user.targetId, profile });
  await interact(rec);
  await sleep(400);
  const result = await rec.stop();
  const sess = Session.open(sessionsDir, s.id);
  const d = await derive(sess, profiles.load(profile), { families });
  return { rec, result, sess, d };
}

function linkFamily(profileName, d) {
  const g = d.report.suggestions.find((x) => x.kind === 'family_membership');
  assert.ok(g, `family suggestion present: ${d.report.suggestions.map((x) => x.kind)}`);
  const { profile, note } = applySuggestion(profiles.load(profileName), g);
  profiles.save(profileName, profile, note);
  families.addMember(g.proposal.family, profileName);
  return g;
}

const files = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });

test('chat A (path-op deltas): detected as ai-chat, linked, canonical messages from network and page', { skip }, async () => {
  const { sess, d } = await capture('/', 'fixture-chat-a', async () => {
    await waitFor(async () => user.eval('!!window.ws && window.ws.readyState === 1'));
    await user.eval('document.getElementById("ask").click()');
    await waitFor(async () => (await user.eval('[...document.querySelectorAll("#thread p")].pop()?.textContent || ""')).includes('correlate'));
  });
  assert.equal(d.report.families[0].family, 'ai-chat', JSON.stringify(d.report.families.slice(0, 2)));
  const g = linkFamily('fixture-chat-a', d);
  const net = g.proposal.mappings.find((m) => m.source.kind === 'assembled');
  assert.equal(net.fields.role.path, '$.message.author.role');
  assert.equal(net.fields.text.path, '$.message.content.parts[*]');
  const d2 = await derive(sess, profiles.load('fixture-chat-a'), { families });
  const msgs = await sess.dataset('family-ai-chat-message').toArray();
  const a = msgs.find((m) => m._provenance.source === 'network');
  assert.equal(a.role, 'assistant');
  assert.equal(a.text, 'Hello from the fixture stream. This sentence is long enough to correlate with the DOM.');
  assert.equal(a.conversation_id, '99999999-8888-7777-6666-555555555555');
  assert.ok(a._provenance.renderedAs, 'network message linked to its rendered turn');
  const dom = msgs.filter((m) => m._provenance.source === 'dom');
  assert.deepEqual([...new Set(dom.map((m) => m.role))].sort(), ['assistant', 'user']);
  assert.ok(d2.familyCounts['family-ai-chat-message'] >= 3);
});

test('chat B (typed-event protocol, different markup): same family model, rich content blocks', { skip }, async () => {
  const { sess, d } = await capture('/claude', 'fixture-chat-b', async () => {
    await user.eval('document.getElementById("send").click()');
    await waitFor(async () => (await user.eval('!!document.querySelector("[data-speaker=assistant] table")')));
  });
  assert.equal(d.report.families[0].family, 'ai-chat');
  const g = linkFamily('fixture-chat-b', d);
  const net = g.proposal.mappings.find((m) => m.source.kind === 'assembled');
  assert.equal(net.fields.role.path, '$.message.role');
  assert.equal(net.fields.text.path, '$.blocks[*].text');
  await derive(sess, profiles.load('fixture-chat-b'), { families });
  const msgs = await sess.dataset('family-ai-chat-message').toArray();
  const a = msgs.find((m) => m._provenance.source === 'network');
  assert.equal(a.text, 'First we collect the data, then we model entities and relations.');
  assert.equal(a.role, 'assistant');
  assert.equal(a.model, 'fixture-model-b');
  assert.equal(a.status, 'end_turn');
  // Rich rendered structure, not a flat string.
  const turn = msgs.find((m) => m._provenance.source === 'dom' && m.role === 'assistant');
  const types = new Set();
  const walk = (bs) => { for (const b of bs ?? []) { types.add(b.type); walk(b.blocks); for (const it of b.items ?? []) walk(it.blocks); for (const i of b.inline ?? []) if (i.t === 'citation') types.add('citation'); } };
  walk(turn.blocks);
  for (const t of ['heading', 'paragraph', 'list', 'table', 'code', 'equation', 'quote', 'citation']) assert.ok(types.has(t), `block ${t}: ${[...types]}`);
  const table = turn.blocks.find((b) => b.type === 'table');
  assert.deepEqual(table.headers, ['Step', 'Owner']);
  assert.deepEqual(table.rows[1], ['Model', 'Ben']);
  const code = turn.blocks.find((b) => b.type === 'code');
  assert.equal(code.language, 'python');
  const eq = turn.blocks.find((b) => b.type === 'equation');
  assert.equal(eq.tex, 'E = mc^2');
  const list = turn.blocks.find((b) => b.type === 'list');
  assert.equal(list.ordered, true);
  assert.ok(list.items[1].blocks.some((b) => b.type === 'list'), 'nested list preserved');
});

test('two providers, one model: canonical messages from both sites in the same family library', { skip }, async () => {
  const fam = families.load('ai-chat');
  assert.ok(fam.members.includes('fixture-chat-a') && fam.members.includes('fixture-chat-b'));
  const all = [];
  for (const d of readdirSync(sessionsDir)) {
    const f = path.join(sessionsDir, d, 'datasets', 'family-ai-chat-message.jsonl');
    try { all.push(...readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))); } catch { /* none */ }
  }
  const sites = new Set(all.filter((m) => m._provenance.source === 'network').map((m) => m._provenance.site));
  assert.ok(sites.has('fixture-chat-a') && sites.has('fixture-chat-b'), [...sites].join(','));
  for (const m of all) for (const k of ['role', 'text', '_family', '_entity', '_provenance']) assert.ok(k in m, `${k} in canonical record`);
});

test('dashboard: data-table family, numeric updates, duplicate and out-of-order frames flagged', { skip }, async () => {
  // The socket opens at page load, before attach. The recorder may join it late from its later frames,
  // but it must never be claimed as observed from the start: URL unknown, flagged late, coverage downgraded.
  const before = await capture('/dashboard', 'fixture-dash', async () => { await sleep(600); });
  const pre = before.d.summary.streams.filter((s) => s.kind === 'ws');
  assert.equal(pre.filter((s) => !s.lateJoin).length, 0, `pre-existing socket is not claimed as captured from its start: ${JSON.stringify(pre.map((s) => [s.sid, s.lateJoin, s.coverage]))}`);
  for (const s of pre) {
    assert.equal(s.urlUnknown, true, 'late-joined socket has no fabricated URL');
    assert.equal(s.url, undefined, 'late-joined socket has no fabricated URL');
    assert.notEqual(s.coverage, 'observed_from_request_start', 'late-joined socket does not claim full coverage');
  }
  // ...and the user-requested reload captures it from the start.
  const { d } = await capture('/dashboard', 'fixture-dash', async (rec) => { await rec.reloadPage(); await sleep(1900); });
  assert.equal(d.report.families[0].family, 'data-table', JSON.stringify(d.report.families.slice(0, 2)));
  const ws = d.summary.streams.find((s) => s.kind === 'ws' && !s.lateJoin);
  assert.ok(ws, 'socket opened after attach is captured from its start');
  assert.equal(ws.coverage, 'observed_from_request_start');
  assert.match(ws.url, /\/ws-ticks$/);
  assert.ok(ws.duplicates >= 1, `duplicates ${ws.duplicates}`);
  assert.ok(ws.outOfOrder >= 1, `outOfOrder ${ws.outOfOrder}`);
  assert.ok(d.report.families[0].evidence.some((e) => e.signal === 'numeric_updates'));
  const polls = d.summary.streams.filter((s) => s.url?.includes('/api/metrics'));
  assert.ok(polls.length >= 3, 'polling requests captured');
});

test('infinite feed: content-feed family from pagination + scrolling', { skip }, async () => {
  const { d } = await capture('/feed', 'fixture-feed', async () => {
    for (let i = 0; i < 4; i++) { await user.eval('window.scrollTo(0, document.body.scrollHeight)'); await sleep(350); }
  });
  assert.equal(d.report.families[0].family, 'content-feed', JSON.stringify(d.report.families.slice(0, 2)));
  const sig = d.report.families[0].evidence.map((e) => e.signal);
  for (const k of ['pagination', 'scroll_then_fetch', 'collection_with']) assert.ok(sig.includes(k), `${k}: ${sig}`);
  assert.ok(d.report.suggestions.some((g) => g.kind === 'collection' && /results/.test(g.title)));
});

test('multi-step form: form-flow family; typed values never stored', { skip }, async () => {
  const SECRET = 'alice.secret.value@example.com';
  const { sess, d } = await capture('/form', 'fixture-form', async () => {
    await user.eval(`(() => { const i = document.querySelector('[name=name]'); i.value = 'Alice Example'; i.dispatchEvent(new Event('input', { bubbles: true })); const e = document.querySelector('[name=email]'); e.value = ${JSON.stringify(SECRET)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(500);
    await user.eval('document.querySelector("[data-step=\\"1\\"] .next").click()'); await sleep(300);
    await user.eval('document.querySelector("[data-step=\\"2\\"] .next").click()'); await sleep(300);
    await user.eval('document.querySelector("[name=terms]").click(); document.getElementById("submit").click()');
    await waitFor(async () => (await user.eval('document.getElementById("status").textContent')).includes('R-000123'));
  });
  assert.equal(d.report.families[0].family, 'form-flow', JSON.stringify(d.report.families.slice(0, 2)));
  const blob = files(sess.dir).map((f) => readFileSync(f).toString('latin1')).join('\n');
  assert.ok(!blob.includes(SECRET), 'typed value leaked');
  assert.ok(!blob.includes('Alice Example'), 'typed name leaked');
  const inputs = (await sess.dataset('timeline').toArray()).filter((e) => e.k === 'action' && e.kind === 'input');
  assert.ok(inputs.length >= 1, 'input activity recorded (length only)');
});

test('static article with mixed media: article family, media inventory, no streaming', { skip }, async () => {
  const { sess, d } = await capture('/article', 'fixture-article', async () => { await sleep(300); });
  assert.equal(d.report.families[0].family, 'article', JSON.stringify(d.report.families.slice(0, 2)));
  const ins = sess.kv.get('DOM_INSPECT');
  const media = ins.proposals.find((p) => p.kind === 'media');
  assert.ok(media.count >= 4, `media ${media?.count}`);
  assert.ok(ins.a11y && ins.a11y.roles && Object.keys(ins.a11y.roles).length > 3, 'accessibility summary present');
  assert.ok(ins.proposals.some((p) => p.kind === 'headings' && p.count >= 4));
});

test('interrupted stream and automatic retry: interruption and reconnect are identified', { skip }, async () => {
  const { d } = await capture('/', 'fixture-chat-a', async () => {
    await user.eval('document.getElementById("ask-flaky").click()');
    await waitFor(async () => (await user.eval('[...document.querySelectorAll("#thread p")].pop()?.textContent || ""')).includes('correlate'));
  });
  const convs = d.summary.streams.filter((s) => s.url?.includes('/api/conversation')).sort((a, b) => a.startedT - b.startedT);
  assert.ok(convs.length >= 2);
  assert.ok(convs[0].interrupted, `first stream interrupted (${convs[0].status})`);
  assert.equal(convs[1].reconnectOf, convs[0].sid);
  assert.equal(convs[1].status, 'complete');
});

test('pause is declared, not mistaken for loss; integrity still verifies', { skip }, async () => {
  const { result, sess } = await capture('/', 'fixture-chat-a', async (rec) => {
    rec.pause();
    await user.eval('document.getElementById("ask").click()');
    await sleep(700);
    rec.resume();
  });
  assert.equal(result.verify.ok, true);
  const tl = await sess.dataset('timeline').toArray();
  const recs = []; for await (const r of sess.records()) recs.push(r);
  const resume = recs.find((r) => r.k === 'resume');
  assert.ok(resume && Object.values(resume.notCaptured).reduce((a, b) => a + b, 0) > 0, 'paused records counted');
  assert.equal(result.verify.gapRecords, 0, 'pause is not a capture gap');
  assert.ok(tl.length > 0);
});
