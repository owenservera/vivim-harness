import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { packetFromSavedSession } from '../../src/export/saved-session-outcome.mjs';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/value-oracle/demo.json', import.meta.url), 'utf8'));
const create = ({ status = 'complete', acceptance = 'unassessed', derive = 'complete', turn = null, textOnly = false } = {}) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'aion-issue71-home-'));
  const sessionId = fixture.meta.id;
  const dir = path.join(home, 'sessions', sessionId); mkdirSync(path.join(dir, 'kv'), { recursive: true });
  mkdirSync(path.join(dir, 'datasets'), { recursive: true });
  const turns = turn ? [fixture.turns[0], { ...fixture.turns[1], text: turn }] : fixture.turns;
  writeFileSync(path.join(dir, 'kv', 'DOM_TURNS.json'), JSON.stringify(textOnly ? [] : turns));
  const kv = { DOM_TURNS: textOnly ? [] : turns, KNOWLEDGE_STATUS: derive ? { status: derive, entityCount: 0 } : null };
  const transcript = { ...fixture, meta: { ...fixture.meta, status }, turns: textOnly ? [] : turns, streams: textOnly ? [{ sid: 's1', texts: [{ text: 'Summary: From stream fallback.' }] }] : [] };
  const s = { id: sessionId, dir, meta: transcript.meta, kv: { get: (k, fallback = null) => k === 'DOM_TURNS' ? JSON.parse(readFileSync(path.join(dir, 'kv', 'DOM_TURNS.json'), 'utf8')) : (kv[k] ?? fallback) } };
  const core = { defaultDataDir: () => home, open: (_dir, id) => id === sessionId ? s : null, buildTranscript: () => transcript,
    readAcceptance: () => ({ verdict: acceptance, reasons: ['synthetic-contract-fixture'] }) };
  return { home, sessionId, dir, s, core, transcript };
};
test('canonical session: packet files and exact original DOM JSON pointer', async () => {
  const f = create(); const result = await packetFromSavedSession({ sessionId: f.sessionId, home: f.home, core: f.core });
  assert.equal(result.packet.evidence.length, 6);
  assert(result.packet.evidence.every((e) => e.canonical.verified));
  assert(result.packet.evidence.every((e) => e.canonical.local_file === path.join(f.dir, 'kv', 'DOM_TURNS.json')));
  assert(result.packet.evidence.every((e) => e.canonical.json_pointer === '#/1/text'));
  assert(result.packet.evidence.every((e) => e.canonical.ui_href === '/#session=synthetic-session-001'));
  assert(existsSync(result.sourceSnapshot)); assert(existsSync(path.join(result.qa, 'run.json')));
  assert.equal(result.packet.acceptance.verdict, 'unassessed');
});
test('Core acceptance-reader contract is advisory, never user approval', async () => {
  const f = create({ acceptance: 'capture_accepted' });
  const { packet } = await packetFromSavedSession({ sessionId: f.sessionId, home: f.home, core: f.core });
  assert.equal(packet.acceptance.verdict, 'capture_accepted');
  assert(packet.decisions.every((d) => d.confirmation === 'not-user-confirmed'));
  assert(packet.actions.every((a) => a.status === 'proposed-not-executed'));
  assert.equal(packet.delivery.state, 'not-attempted');
});
test('rejected capture and failed derive remain explicit, packet not accepted', async () => {
  const f = create({ acceptance: 'capture_rejected', derive: 'failed', status: 'interrupted' });
  const { packet } = await packetFromSavedSession({ sessionId: f.sessionId, home: f.home, core: f.core });
  assert(packet.unknowns.includes('capture-acceptance-capture_rejected'));
  assert(packet.unknowns.includes('knowledge-derive-failed'));
  assert(packet.unknowns.includes('capture-completeness-not-proven'));
});
test('unattributed stream link is SID-only, never invents event sequence', async () => {
  const f = create({ textOnly: true }); const { packet } = await packetFromSavedSession({ sessionId: f.sessionId, home: f.home, core: f.core });
  assert.equal(packet.evidence.length, 1); assert.equal(packet.evidence[0].canonical.verified, false);
  assert.equal(packet.evidence[0].canonical.ui_href, '/#session=synthetic-session-001&view=streams&sid=s1');
  assert(!packet.evidence[0].canonical.ui_href.includes('seq='));
});
test('missing and mismatched saved sessions fail before any output', async () => {
  const f = create(); const target = path.join(f.home, 'outcome-packets', 'missing');
  await assert.rejects(() => packetFromSavedSession({ sessionId: 'missing', home: f.home, outDir: target, core: f.core }), { code: 'SESSION_MISMATCH' });
  assert(!existsSync(target));
});
test('recording in progress must not become an outcome', async () => {
  const f = create({ status: 'recording' });
  await assert.rejects(() => packetFromSavedSession({ sessionId: f.sessionId, home: f.home, core: f.core }), { code: 'SESSION_NOT_SAVED' });
});
test('modified original DOM text is conservatively marked unverified', async () => {
  const f = create(); writeFileSync(path.join(f.dir, 'kv', 'DOM_TURNS.json'), JSON.stringify([{ role: 'user', text: 'changed' }]));
  const { packet } = await packetFromSavedSession({ sessionId: f.sessionId, home: f.home, core: f.core });
  assert(packet.evidence.every((e) => !e.canonical.verified));
  assert(packet.unknowns.includes('some-original-evidence-locators-unverified-use-local-snapshot'));
});
