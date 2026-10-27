// Observed-prefix adoption — spec §5.3 prompt resolution tiers A-D.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { workspace, rawPage, PROMPT, REPLY, THREAD, sha } from './conversation-prefix-fixture.mjs';

const pageWithUser = (text) => {
  const base = rawPage();
  return { ...base, messages: [{ ...base.messages[0], text, chars: text.length }, base.messages[1]] };
};

test('tier A: the capture KV prompt corroborates the snapshot digest', async (t) => {
  const f = workspace(t);
  const c = await f.bind();
  assert.equal(c.prefix.prompt.source, 'capture-kv');
  assert.equal(c.prefix.prompt.digest, sha(PROMPT));
  assert.equal(c.prefix.prompt.chars, PROMPT.length);
});

test('tier B: without any KV the page text alone proves the snapshot digest', async (t) => {
  const f = workspace(t, { kv: 'absent' });
  const c = await f.bind();
  assert.equal(c.prefix.prompt.source, 'page+snapshot-digest');
  assert.equal(c.prefix.prompt.digest, sha(PROMPT));
});

test('a .tmp-only KV is an unconfirmed write and is never read as evidence', async (t) => {
  const f = workspace(t, { kv: 'tmp' });
  const kvFile = `${f.paths.sessions}/${f.sessionId}/kv/CONVERSATION_ATTEMPT_${f.attemptId}.json`;
  assert.equal(fs.existsSync(kvFile), false); // only the .tmp remnant exists
  const c = await f.bind();
  assert.equal(c.prefix.prompt.source, 'page+snapshot-digest');
});

test('tier C: an owner-attested prompt whose CRLF bytes hash to the snapshot digest is accepted', async (t) => {
  const crlf = 'Harbor line one\r\nHarbor line two';
  const f = workspace(t, { kv: 'absent', prompt: crlf, digest: sha(crlf), page: pageWithUser('Harbor line one\nHarbor line two') });
  const c = await f.bind({ promptAttestation: crlf });
  assert.equal(c.prefix.prompt.source, 'owner-attested');
  assert.equal(c.prefix.prompt.digest, sha(crlf));
  assert.equal(c.prefix.prompt.chars, crlf.length);
});

test('tier C is not a bypass: an attestation that does not hash to the snapshot digest is refused', async (t) => {
  const f = workspace(t, { kv: 'absent' });
  await assert.rejects(f.bind({ promptAttestation: `${PROMPT} ` }), (e) => e.code === 'PREFIX_PROMPT_UNVERIFIED');
});

test('tier D: no KV, no attestation and a mismatched page text refuses the bind', async (t) => {
  const f = workspace(t, { kv: 'absent', page: pageWithUser('a different prompt') });
  await assert.rejects(f.bind(), (e) => e.code === 'PREFIX_PROMPT_UNVERIFIED');
  assert.equal(f.files().length, 1);
});

test('CRLF in the original prompt cannot be proven by the LF-normalised page text (tier B refuses)', async (t) => {
  const crlf = 'Harbor line one\r\nHarbor line two';
  const f = workspace(t, { kv: 'absent', prompt: crlf, digest: sha(crlf), page: pageWithUser('Harbor line one\nHarbor line two') });
  await assert.rejects(f.bind(), (e) => e.code === 'PREFIX_PROMPT_UNVERIFIED');
});

test('tier A is unavailable when the source capture is terminal-incomplete (page digest stands alone)', async (t) => {
  const f = workspace(t, { sourceStatus: 'incomplete' });
  const c = await f.bind();
  assert.equal(c.prefix.prompt.source, 'page+snapshot-digest');
  assert.equal(c.prefix.capture.status, 'incomplete');
  assert.equal(c.prefix.capture.corroboration, 'terminal-incomplete');
});
