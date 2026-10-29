// Provider-reply -> personal app builder bridge. Pure consumption of already-stored replies:
// every test fails if anything other than the stored-snapshot reader is used, or fetch is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { createPersonalAppService } from '../../src/studio/personal-app-service.mjs';
import { createProviderReplyBuilder, extractProposalText } from '../../src/studio/personal-app-provider-reply.mjs';

const CONV = 'conv-abc123', TURN = 'turn-1';
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const storedWith = (replyText, state = 'ready') => ({
  id: CONV, site: 'chatgpt',
  turns: [{ id: TURN, reply: { state, text: replyText, chars: replyText?.length ?? 0 } },
    { id: 'turn-2', reply: { state: 'waiting', text: 'partial' } }],
});
const change = (app, label = 'AI Ideas', kind = 'notes') => JSON.stringify({
  schema: 'vivim.personal-app-change/1', appId: app.id, baseVersion: app.version,
  operations: [{ type: 'add-screen', kind, label }] });

function fixture(t, replyText) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vivim-provider-reply-'));
  const realFetch = globalThis.fetch;
  let networkCalls = 0, reads = 0;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('network forbidden'); };
  t.after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
  const apps = createPersonalAppService({ paths: { root: dir } });
  let stored = storedWith(replyText);
  const builder = createProviderReplyBuilder({ apps,
    readStoredConversation: async id => { reads += 1; assert.equal(id, CONV); return structuredClone(stored); } });
  const { app } = apps.create({ title: 'AI built', intent: 'Let AI propose', idempotencyKey: 'provider-reply-key-1' });
  return { apps, builder, app, setStored: v => { stored = v; }, counters: () => ({ networkCalls, reads }) };
}

test('valid stored provider reply previews with explicit provider-reply provenance and does not save', t => {
  const f = fixture(t, 'placeholder');
  const reply = 'Here is the change:\n```json\n' + change(f.app) + '\n```\nThanks!';
  f.setStored(storedWith(reply));
  return f.builder.preview({ id: f.app.id, conversation: CONV, turnId: TURN }).then(result => {
    assert.equal(result.source, 'provider-reply');
    assert.equal(result.provenance.conversationId, CONV);
    assert.equal(result.provenance.turnId, TURN);
    assert.equal(result.provenance.humanAuthored, false);
    assert.equal(result.provenance.providerCalled, false);
    assert.equal(result.provenance.replyDigest, sha(reply));
    assert.equal(result.schema, 'vivim.personal-app-preview/1');
    assert.equal(result.canApply, true);
    assert.equal(result.approvalRequired, true);
    assert.equal(result.effects, 'none');
    assert.equal(result.externalProvenance, 'not-verified');
    assert.deepEqual(result.diff.map(d => d.label), ['AI Ideas']);
    assert.equal(f.apps.get(f.app.id).version, f.app.version, 'preview must not save');
    assert.deepEqual(f.counters(), { networkCalls: 0, reads: 1 });
  });
});

test('a bare JSON reply works and matches the human preview exactly', async t => {
  const f = fixture(t, 'x');
  f.setStored(storedWith(change(f.app)));
  const viaReply = await f.builder.preview({ id: f.app.id, conversation: CONV, turnId: TURN });
  const human = f.apps.previewChange({ id: f.app.id, proposal: change(f.app) });
  const { source, provenance, ...core } = viaReply;
  assert.deepEqual(core, human, 'compiler output is reused unchanged');
});

test('apply requires explicit approval, matching digest and CAS, then records provenance', async t => {
  const f = fixture(t, 'x');
  const reply = '```\n' + change(f.app, 'Applied By You') + '\n```';
  f.setStored(storedWith(reply));
  const ref = { id: f.app.id, conversation: CONV, turnId: TURN };
  const preview = await f.builder.preview(ref);
  const args = { ...ref, replyDigest: preview.provenance.replyDigest, expectedVersion: f.app.version };
  await assert.rejects(f.builder.apply({ ...args }), { code: 'PERSONAL_APP_APPROVAL_REQUIRED' });
  await assert.rejects(f.builder.apply({ ...args, approval: 'model-approved' }), { code: 'PERSONAL_APP_APPROVAL_REQUIRED' });
  assert.equal(f.apps.get(f.app.id).version, f.app.version, 'no auto-apply without approval');
  await assert.rejects(f.builder.apply({ ...args, replyDigest: '0'.repeat(64), approval: 'user-confirmed' }),
    { code: 'PROVIDER_REPLY_CHANGED' });
  await assert.rejects(f.builder.apply({ ...args, expectedVersion: 99, approval: 'user-confirmed' }),
    { code: 'PERSONAL_APP_VERSION_CONFLICT' });
  const applied = await f.builder.apply({ ...args, approval: 'user-confirmed' });
  assert.equal(applied.source, 'provider-reply');
  assert.equal(applied.provenance.turnId, TURN);
  assert.equal(applied.app.version, f.app.version + 1);
  assert.equal(applied.deployed, false);
  assert.equal(applied.providerExecution, 'not-attempted');
  // A stored reply that changes after preview cannot be applied under the old digest.
  const again = await f.builder.preview({ id: f.app.id, conversation: CONV, turnId: TURN }).catch(e => e);
  assert.equal(again.code, 'PERSONAL_APP_VERSION_CONFLICT', 'reply targeted the old revision');
  assert.deepEqual(f.counters().networkCalls, 0);
});

test('malformed, unsafe or unsettled replies go through the same compiler guards and are rejected', async t => {
  const f = fixture(t, 'x');
  const ref = { id: f.app.id, conversation: CONV, turnId: TURN };
  const base = JSON.parse(change(f.app));
  const bad = {
    prose: ['Sure! I added a screen for you.', 'PERSONAL_APP_INVALID'],
    brokenJson: ['```json\n{"schema": \n```', 'PERSONAL_APP_INVALID'],
    executeField: [JSON.stringify({ ...base, execute: true }), 'PERSONAL_APP_INVALID'],
    codeKind: [JSON.stringify({ ...base, operations: [{ type: 'add-screen', kind: 'javascript', label: 'x' }] }), 'PERSONAL_APP_INVALID'],
    badOp: [JSON.stringify({ ...base, operations: [{ type: 'run-shell', cmd: 'rm -rf /' }] }), 'PERSONAL_APP_INVALID'],
    controlChars: [JSON.stringify({ ...base, operations: [{ type: 'add-screen', kind: 'notes', label: 'a\u0000b' }] }), 'PERSONAL_APP_INVALID'],
    tooManyOps: [JSON.stringify({ ...base, operations: Array.from({ length: 5 }, (_, i) => ({ type: 'add-screen', kind: 'blank', label: 'S' + i })) }), 'PERSONAL_APP_INVALID'],
    oversize: ['{"x":"' + 'a'.repeat(12100) + '"}', 'PERSONAL_APP_INVALID'],
    staleVersion: [JSON.stringify({ ...base, baseVersion: 9 }), 'PERSONAL_APP_VERSION_CONFLICT'],
    otherApp: [JSON.stringify({ ...base, appId: 'app-' + 'a'.repeat(32) }), 'PERSONAL_APP_VERSION_CONFLICT'],
    ambiguous: ['```json\n' + change(f.app, 'One') + '\n```\n```json\n' + change(f.app, 'Two') + '\n```', 'PROVIDER_REPLY_AMBIGUOUS'],
    empty: ['   ', 'PROVIDER_REPLY_EMPTY'],
  };
  for (const [name, [text, code]] of Object.entries(bad)) {
    f.setStored(storedWith(text));
    await assert.rejects(f.builder.preview(ref), { code }, name);
  }
  f.setStored(storedWith(change(f.app), 'streaming'));
  await assert.rejects(f.builder.preview(ref), { code: 'PROVIDER_REPLY_NOT_READY' });
  f.setStored(storedWith(change(f.app)));
  await assert.rejects(f.builder.preview({ ...ref, turnId: 'missing-turn' }), { code: 'PROVIDER_REPLY_NOT_FOUND' });
  await assert.rejects(f.builder.preview({ ...ref, conversation: '../x' }), { code: 'PROVIDER_REPLY_INVALID' });
  await assert.rejects(f.builder.preview({ ...ref, turnId: undefined }), { code: 'PROVIDER_REPLY_INVALID' });
  assert.equal(f.apps.get(f.app.id).version, f.app.version);
  assert.equal(f.counters().networkCalls, 0);
});

test('extractProposalText only trusts one bare/json fence and otherwise passes text through', () => {
  assert.equal(extractProposalText('  {"a":1}  '), '{"a":1}');
  assert.equal(extractProposalText('x\n```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractProposalText('x\n```js\nalert(1)\n```'), 'x\n```js\nalert(1)\n```'.trim());
  assert.throws(() => extractProposalText('```\n{}\n```\n```json\n{}\n```'), { code: 'PROVIDER_REPLY_AMBIGUOUS' });
});

test('module is structurally incapable of provider effects', () => {
  const source = readFileSync(new URL('../../src/studio/personal-app-provider-reply.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.deepEqual([...code.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]).sort(),
    ['./http.mjs', 'node:crypto']);
  assert.doesNotMatch(code, /\bfetch\s*\(|submit|reconcile|connect|\.read\(|http\.request|child_process|WebSocket/);
});

test('HTTP: opt-in routes use only the stored snapshot reader; no send/read/reconcile/fetch from Studio', { timeout: 20000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vivim-provider-reply-http-'));
  const paths = dataPaths(dir); ensureDataDirs(paths);
  const called = [];
  const spy = name => async () => { called.push(name); throw new Error(name + ' must never be called'); };
  let stored = null;
  const runtime = { isSessionActive: () => false, close: async () => {}, targets: async () => ({ sites: [], targets: [] }),
    list: async () => [], get: async id => { called.push('get'); assert.equal(id, CONV); return stored; },
    submit: spy('submit'), read: spy('read'), reconcile: spy('reconcile'), connect: spy('connect'),
    recover: spy('recover'), finish: spy('finish') };
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0,
    token: 'provider-reply-test', accessMode: 'token', conversationRuntime: runtime });
  t.after(async () => { await studio.close(); rmSync(dir, { recursive: true, force: true }); });
  const headers = { 'x-studio-token': 'provider-reply-test', 'content-type': 'application/json' };
  const request = async (route, body) => {
    const res = await fetch('http://127.0.0.1:' + studio.port + '/api/v1/personal-apps' + route, {
      method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const created = await request('', { title: 'HTTP AI app', intent: 'Provider proposals', idempotencyKey: 'http-provider-reply-1' });
  const app = created.data.app;
  const reply = '```json\n' + change(app, 'From Reply') + '\n```';
  stored = storedWith(reply);
  const ref = { conversation: CONV, turnId: TURN };
  const preview = await request('/' + app.id + '/preview-provider-reply', ref);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.source, 'provider-reply');
  assert.equal(preview.data.provenance.conversationId, CONV);
  assert.equal(preview.data.provenance.humanAuthored, false);
  assert.equal((await request('/' + app.id + '/preview-provider-reply', { ...ref, extra: 1 })).status, 400);
  assert.equal((await request('/' + app.id + '/preview-provider-reply', { conversation: CONV })).status, 400);
  const applyBody = { ...ref, replyDigest: preview.data.provenance.replyDigest, expectedVersion: app.version };
  const unapproved = await request('/' + app.id + '/apply-provider-reply', applyBody);
  assert.ok([400, 403].includes(unapproved.status), 'approval is mandatory: ' + unapproved.status);
  const read = await fetch('http://127.0.0.1:' + studio.port + '/api/v1/personal-apps/' + app.id, { headers });
  assert.equal((await read.json()).version, app.version, 'preview alone never mutates');
  const applied = await request('/' + app.id + '/apply-provider-reply', { ...applyBody, approval: 'user-confirmed' });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.source, 'provider-reply');
  assert.equal(applied.data.app.version, app.version + 1);
  assert.equal((await request('/' + app.id + '/apply-provider-reply', { ...applyBody, approval: 'user-confirmed' })).status, 409,
    'replaying an approval never reapplies');
  stored = storedWith('I cannot do JSON.');
  const rejected = await request('/' + app.id + '/preview-provider-reply', ref);
  assert.equal(rejected.status, 400);
  assert.ok(called.length > 0 && called.every(name => name === 'get'), 'only the stored snapshot reader ran: ' + called);
});
