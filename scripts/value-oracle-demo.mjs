#!/usr/bin/env node
// Synthetic-only saved-session demonstration. Uses Core reader doubles; not a live Studio integration test.
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { packetFromSavedSession } from '../src/export/saved-session-outcome.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const tr = JSON.parse(readFileSync(path.join(here, '..', 'test', 'fixtures', 'value-oracle', 'demo.json'), 'utf8'));
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'aion-oracle-71-synthetic-'));
const sessionDir = path.join(dataRoot, 'sessions', tr.meta.id);
mkdirSync(path.join(sessionDir, 'kv'), { recursive: true }); mkdirSync(path.join(sessionDir, 'datasets'), { recursive: true });
writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(tr.meta, null, 2));
writeFileSync(path.join(sessionDir, 'kv', 'DOM_TURNS.json'), JSON.stringify(tr.turns, null, 2));
writeFileSync(path.join(sessionDir, 'kv', 'KNOWLEDGE_STATUS.json'), JSON.stringify({ status: 'complete', entityCount: 0 }, null, 2));
const core = { defaultDataDir: () => dataRoot,
  open: (_dir, id) => ({ id, dir: sessionDir, meta: tr.meta, kv: { get: (k, d) => { try { return JSON.parse(readFileSync(path.join(sessionDir, 'kv', k + '.json'), 'utf8')); } catch { return d; } } } }),
  buildTranscript: () => tr,
  readAcceptance: () => ({ verdict: 'unassessed', reasons: ['synthetic fixture: no canonical acceptance raw digest'] }) };
const result = await packetFromSavedSession({ sessionId: tr.meta.id, home: dataRoot, outDir: path.join(dataRoot, 'output'), core });
console.log(JSON.stringify({ synthetic_mock_core: true, source_session: sessionDir, verified_dom_refs: result.packet.derivation.original_dom_locators_verified,
  acceptance: result.packet.acceptance.verdict, outputs: result.outDir, independent_qa_accepted: false }, null, 2));
