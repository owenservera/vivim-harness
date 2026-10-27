#!/usr/bin/env node
// Value Oracle issue #71: read-only canonical saved-session adapter for existing V1.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePacket, verifyPacket, writeOutputs } from './outcome-packet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(here, '..', '..');
const digest = (text) => createHash('sha256').update(text).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
const ptr = (p) => '#/' + p.map((v) => String(v).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
const valid = (id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
const safeView = (id) => '/#session=' + encodeURIComponent(id);

// Use first-party session, transcript, and bound acceptance readers rather than reimplementing them.
async function canonicalCore() {
  const load = (file) => import(pathToFileURL(path.join(studioRoot, file)).href);
  const [{ Session }, { buildTranscript }, { readAcceptance }, { defaultDataDir }] = await Promise.all([
    load('src/store/session.mjs'), load('src/export/export.mjs'),
    load('src/capture/acceptance.mjs'), load('src/config.mjs'),
  ]);
  return { open: (dir, id) => Session.open(dir, id), buildTranscript, readAcceptance, defaultDataDir };
}

export async function packetFromSavedSession({ sessionId, home, outDir, sourceSha = null, core = null } = {}) {
  if (!valid(sessionId)) throw error('INVALID_SESSION', 'Provide an exact safe saved-session ID');
  const c = core || await canonicalCore();
  const dataHome = path.resolve(home || c.defaultDataDir());
  const s = await c.open(path.join(dataHome, 'sessions'), sessionId);
  if (!s || s.id !== sessionId || !s.dir || !s.kv?.get) throw error('SESSION_MISMATCH', 'Resolved saved session does not match requested ID');
  if (s.meta?.status === 'recording') throw error('SESSION_NOT_SAVED', 'Recording still active; choose an already saved session');
  const transcript = await c.buildTranscript(s); // canonical Studio export transcript shape
  if (transcript?.meta?.id !== sessionId) throw error('TRANSCRIPT_MISMATCH', 'Core transcript session ID mismatch');
  const destination = path.resolve(outDir || path.join(dataHome, 'outcome-packets', sessionId));
  // A private source snapshot is needed to make V1 JSON Pointers independently resolvable.
  const sourceSnapshot = path.join(destination, 'source-transcript.json');
  const p = generatePacket(transcript, sourceSnapshot);
  if (!verifyPacket(transcript, p)) throw error('EVIDENCE_MISMATCH', 'Generated transcript locators failed');
  let a;
  try { a = await c.readAcceptance(s); }
  catch (e) { a = { verdict: 'unassessed', reasons: ['acceptance-reader-error: ' + e.message] }; }
  const verdict = ['capture_accepted', 'capture_rejected', 'capture_incomplete'].includes(a?.verdict) ? a.verdict : 'unassessed';
  const knowledge = s.kv.get('KNOWLEDGE_STATUS', null);
  p.source = { ...p.source, representation: 'canonical-saved-session-transcript', session_dir: s.dir, export_snapshot: sourceSnapshot };
  p.acceptance = { verdict, reader: 'Core readAcceptance(session) with raw-binding verification', reasons: a?.reasons || [], advisory_only: true };
  p.knowledge = { status: knowledge?.status ?? 'unknown', derived_entity_count: Number.isInteger(knowledge?.entityCount) ? knowledge.entityCount : null };
  if (verdict !== 'capture_accepted') p.unknowns.push('capture-acceptance-' + verdict);
  if (knowledge?.status !== 'complete') p.unknowns.push('knowledge-derive-' + (knowledge?.status || 'unknown'));
  // For a genuine accepted verdict, V1's generic caveat is superseded by Core's bound label.
  if (verdict === 'capture_accepted') p.unknowns = p.unknowns.filter((x) => x !== 'evidence-integrity-and-capture-acceptance-not-independently-verified');
  const domTurns = s.kv.get('DOM_TURNS', []);
  const selected = Array.isArray(domTurns) ? domTurns.map((turn, index) => ({ turn, index })).filter(({ turn }) => turn && (turn.text || turn.role)) : [];
  const canonicalDomFile = path.join(s.dir, 'kv', 'DOM_TURNS.json');
  for (const e of p.evidence) {
    const domMatch = /^#\/turns\/(\d+)\/text$/.exec(e.json_pointer);
    if (domMatch) {
      const entry = selected[Number(domMatch[1])];
      const good = entry && typeof entry.turn.text === 'string' && digest(entry.turn.text) === e.text_sha256
        && entry.turn.text.split(/\r?\n/)[e.line - 1] === e.quote && existsSync(canonicalDomFile);
      e.canonical = good ? { verified: true, local_file: canonicalDomFile, json_pointer: ptr([entry.index, 'text']), exact_source_line: e.line,
        ui_href: safeView(sessionId), ui_precision: 'session-only; DOM line navigation is not supported' }
        : { verified: false, reason: 'DOM original could not be checked against canonical saved kv', ui_href: safeView(sessionId), ui_precision: 'session-only' };
    } else {
      const streamMatch = /^#\/streams\/(\d+)\/texts\/(\d+)\/text$/.exec(e.json_pointer);
      const stream = streamMatch && transcript.streams[Number(streamMatch[1])];
      const sid = typeof stream?.sid === 'string' && stream.sid ? stream.sid : null;
      e.canonical = { verified: false, reason: 'assembled text is a selected excerpt; no checked raw event seq', sid,
        ui_href: sid ? safeView(sessionId) + '&view=streams&sid=' + encodeURIComponent(sid) : safeView(sessionId),
        ui_precision: sid ? 'stream-only; UI must verify SID membership' : 'session-only' };
    }
  }
  if (p.evidence.some((e) => !e.canonical?.verified)) p.unknowns.push('some-original-evidence-locators-unverified-use-local-snapshot');
  p.derivation.original_dom_locators_verified = p.evidence.filter((e) => e.canonical?.verified).length;
  p.derivation.original_dom_locators_unverified = p.evidence.length - p.derivation.original_dom_locators_verified;
  // Validation before any write. Never replace or alter canonical session files.
  if (!verifyPacket(transcript, p)) throw error('EVIDENCE_MISMATCH', 'Source text changed before output');
  mkdirSync(destination, { recursive: true });
  writeFileSync(sourceSnapshot, JSON.stringify(transcript, null, 2) + '\n');
  const receipt = writeOutputs(p, transcript, destination, new Date().toISOString(), sourceSha);
  return { ...receipt, packet: p, sourceSnapshot };
}

export async function runSavedCli(args = process.argv.slice(2)) {
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const result = await packetFromSavedSession({ sessionId: get('--session'), home: get('--home'), outDir: get('--out'), sourceSha: get('--source-sha') });
  process.stdout.write(JSON.stringify({ status: 'PASS', session: result.packet.session, acceptance: result.packet.acceptance.verdict,
    packet_md: path.join(result.outDir, 'outcome-packet.md'), packet_json: path.join(result.outDir, 'outcome-packet.json'),
    evidence_refs: result.packet.evidence.length, canonical_dom_refs_verified: result.packet.derivation.original_dom_locators_verified,
    local_only: true, delivery: 'not-attempted' }, null, 2) + '\n');
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSavedCli().catch((e) => { process.stderr.write(JSON.stringify({ status: 'FAIL', code: e.code || 'RUNTIME_ERROR', error: e.message }) + '\n'); process.exitCode = 1; });
}
