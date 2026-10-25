import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCampaign, statePath, defaultPrompt, expectedWords } from '../../src/capture/campaign.mjs';

const good = expectedWords.join(' ');
const bad = 'alpha bravo charlie';

function fakeDrive(reply) {
  return async () => ({ ok: true, blocked: false, sessionId: 'sess-fake', reply, target: { url: 'https://chatgpt.com/' }, errors: [] });
}

async function run(reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-status-'));
  try {
    const res = await runCampaign({
      sites: ['chatgpt'], execute: true, dataDir: dir, prompt: defaultPrompt,
      cooldownMs: 0, resume: false, drive: fakeDrive(reply),
    });
    const state = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    return { res, state };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('reply with all expected words in order is recorded ok/verified, never failed', async () => {
  const { res, state } = await run(good);
  assert.equal(res.sites[0].status, 'ok');
  assert.equal(res.sites[0].verified, true);
  assert.equal(res.totals.ok, 1);
  assert.equal(res.totals.failed, 0);
  assert.equal(res.ok, true);
  assert.equal(state.sites.chatgpt.status, 'ok');
  assert.equal(state.sites.chatgpt.sessionId, 'sess-fake');
});

test('reply missing expected words is recorded unverified', async () => {
  const { res, state } = await run(bad);
  assert.equal(res.sites[0].status, 'unverified');
  assert.equal(res.sites[0].verified, false);
  assert.equal(res.totals.unverified, 1);
  assert.equal(res.totals.ok, 0);
  assert.equal(state.sites.chatgpt.status, 'unverified');
});
