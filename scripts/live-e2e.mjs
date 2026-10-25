#!/usr/bin/env node
// Capture Studio — live end-to-end driver.
//
//   node scripts/live-e2e.mjs [--keep] [--no-browser]
//
// The driver spawns the real CLI (bin/studio.mjs) against an isolated data directory and a
// local fixture site (scripts/fixture-site.mjs), then walks the whole product path:
//
//    1  start the fixture site
//    2  studio doctor
//    3  launch a headless Chrome through the CLI (studio launch --headless)
//    4  studio capture <fixture-url> --idle 3 --json              (record + derive in one shot)
//    5  studio session list --json                                 contains the new session
//    6  studio session stats <id> and studio verify <id>
//    7  studio derive <id> --full, then studio kb search "<word>"  >= 1 hit
//    8  studio kb search "<word with a typo>"                     >= 1 hit (fuzzy)
//    9  studio export dataset / export transcript                  the streamed words in order
//   10  studio mirror <id> --port 0                               replayed JSON + replayed SSE
//   11  studio dedupe <id>, studio detect and studio csv on the fixture /data.csv body
//   12  studio integrity build <session dir> then studio integrity verify
//   13  studio serve (studio UI only): GET /api/x/stats and GET /platform
//
// Every step prints PASS / FAIL / SKIP with its duration and a one-line detail. The run stops
// early only when a prerequisite step fails; the remaining steps are then reported as SKIP.
//
// Isolation: the CLI always runs with CAPTURE_STUDIO_HOME set to a fresh temporary data
// directory and CAPTURE_STUDIO_CDP_PORT set to a free port, so the real user data folder and
// the user's own browser are never touched. The Chrome this driver starts is killed at the end.
//
// Flags:
//   --keep         Keep the isolated Chrome profile directory (default: it is removed).
//   --no-browser   Skip every browser-dependent step; no Chrome is started.
//
// A summary table is printed and the machine-readable result is written to
// <data-dir>/live-e2e-result.json. Exit code 0 only when no step failed.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFixture, CHAT_WORDS, CHAT_WORD_TYPO, ITEMS, CSV_TEXT } from './fixture-site.mjs';
import { Session } from '../src/store/session.mjs';
import { readAcceptance, rawDigest } from '../src/capture/acceptance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STUDIO = path.join(ROOT, 'bin', 'studio.mjs');
const KEEP = process.argv.includes('--keep');
const NO_BROWSER = process.argv.includes('--no-browser');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function safeJson(text) {
  try { return JSON.parse(String(text ?? '').trim()); } catch { return null; }
}

// True when the words appear in `text` in this order (not necessarily adjacent).
function wordsInOrder(text, words) {
  let at = -1;
  for (const w of words) {
    const i = text.indexOf(w, at + 1);
    if (i < 0) return false;
    at = i;
  }
  return true;
}

async function main() {
  const startedAt = new Date().toISOString();
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : path.join(os.tmpdir(), 'opencode');
  const dataDir = path.join(base, `cs-live-e2e-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const cdpPort = await freePort();
  const childEnv = {
    ...process.env,
    CAPTURE_STUDIO_HOME: dataDir,
    CAPTURE_STUDIO_CDP_PORT: String(cdpPort),
    NO_COLOR: '1',
  };

  const steps = [];
  const spawned = [];
  let fixture = null;
  let chromePid = null;
  let chromeProfile = null;
  let fatal = false;

  const record = (name, status, ms, detail) => {
    steps.push({ name, status, ms: Math.max(0, Math.round(ms)), detail: oneLine(detail) });
  };

  // Run one step; a thrown error is a FAIL with the error text as detail.
  // Steps that work on a captured session cannot run without one.
  const SESSION_STEPS = /^(5|6|7|8|9|10|12) /;
  const step = async (name, fn, { prereq = false } = {}) => {
    if (fatal) { record(name, 'SKIP', 0, 'skipped: an earlier prerequisite step failed'); return { status: 'SKIP' }; }
    if (SESSION_STEPS.test(name) && !sessionId) { record(name, 'SKIP', 0, 'skipped: no captured session (browser steps skipped)'); return { status: 'SKIP' }; }
    const t0 = Date.now();
    try {
      const r = await fn();
      record(name, r?.status ?? 'PASS', Date.now() - t0, r?.detail ?? '');
      if ((r?.status ?? 'PASS') === 'FAIL' && prereq) fatal = true;
      return r;
    } catch (e) {
      record(name, 'FAIL', Date.now() - t0, String(e?.message ?? e));
      if (prereq) fatal = true;
      return { status: 'FAIL' };
    }
  };

  // Run a CLI command to completion.
  const runCli = (args, { timeoutMs = 240000 } = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [STUDIO, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    spawned.push(child);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr, error: e }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });

  // Start a CLI command that keeps running (mirror, studio) and collect its output.
  const spawnCli = (args) => {
    const child = spawn(process.execPath, [STUDIO, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    spawned.push(child);
    const st = { child, stdout: '', stderr: '' };
    child.stdout.on('data', (d) => { st.stdout += d; });
    child.stderr.on('data', (d) => { st.stderr += d; });
    return st;
  };

  const waitForJson = async (st, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const text = st.stdout.trim();
      if (text) {
        const json = safeJson(text);
        if (json && typeof json === 'object') return json;
      }
      if (st.child.exitCode !== null) break;
      await sleep(100);
    }
    throw new Error(`no JSON result on stdout: ${oneLine(st.stdout).slice(0, 160)} | ${oneLine(st.stderr).slice(0, 160)}`);
  };

  let sessionId = null;
  let sessionDir = null;
  let packetResult = null;
  let acceptance = null;
  let browserSkipReason = NO_BROWSER ? 'browser steps disabled (--no-browser)' : null;

  try {
    // ------------------------------------------------------------------------------------------
    // 1 — fixture site
    // ------------------------------------------------------------------------------------------
    await step('1 fixture site', async () => {
      fixture = await startFixture({ port: 0, outcomeText: [
        'Summary: Synthetic capture preserved a source-linked local answer.',
        'Decision: Keep this demonstration on localhost only.',
        'Action: Review the saved evidence before any real provider test.',
        'Unknown: Real provider behavior was not tested.',
      ].join('\n') });
      return { detail: `${fixture.url} (12 SSE words, 8 items, ndjson, csv)` };
    }, { prereq: true });

    // ------------------------------------------------------------------------------------------
    // 2 — doctor
    // ------------------------------------------------------------------------------------------
    const doctor = await step('2 doctor', async () => {
      const r = await runCli(['doctor', '--json'], { timeoutMs: 60000 });
      const json = safeJson(r.stdout);
      const checks = Array.isArray(json?.checks) ? json.checks : [];
      if (!checks.length) throw new Error(`doctor produced no checks (exit ${r.code}): ${oneLine(r.stderr).slice(0, 200)}`);
      const browserOnly = new Set(['chrome', 'devtools']);
      const hard = checks.filter((c) => c.level === 'fail' && !browserOnly.has(c.name));
      const soft = checks.filter((c) => c.level === 'fail' && browserOnly.has(c.name));
      const chromeOk = checks.find((c) => c.name === 'chrome')?.level === 'ok';
      if (hard.length) throw new Error(`doctor: ${hard.map((c) => `${c.name}: ${c.detail}`).join('; ')}`);
      if (!chromeOk && !browserSkipReason) browserSkipReason = `no Chrome found (doctor: ${checks.find((c) => c.name === 'chrome')?.detail ?? 'chrome check failed'})`;
      const detail = `${checks.length} checks ok` + (chromeOk ? '' : ' (chrome missing: browser steps will be skipped)');
      return { detail };
    }, { prereq: true });

    if (browserSkipReason) browserSkipReason = browserSkipReason === 'browser steps disabled (--no-browser)' ? browserSkipReason : browserSkipReason;

    // ------------------------------------------------------------------------------------------
    // 3 — headless Chrome through the CLI
    // ------------------------------------------------------------------------------------------
    if (browserSkipReason) {
      record('3 launch headless Chrome', 'SKIP', 0, browserSkipReason);
    } else {
      await step('3 launch headless Chrome', async () => {
        const r = await runCli(['launch', '--headless', '--json'], { timeoutMs: 90000 });
        const json = safeJson(r.stdout);
        if (!json || json.alreadyRunning === undefined) throw new Error(`launch produced no result (exit ${r.code}): ${oneLine(r.stderr).slice(0, 200)}`);
        chromePid = json.pid ?? null;
        chromeProfile = json.profileDir ?? null;
        if (json.alreadyRunning || !chromePid || path.resolve(chromeProfile || '.') !== path.join(dataDir, 'chrome-profile')) {
          throw new Error('Disposable Chrome ownership was not established; refusing capture');
        }
        return { detail: `${json.browser ?? 'chrome'} pid ${chromePid ?? 'n/a'} on 127.0.0.1:${cdpPort}` };
      }, { prereq: true });
    }

    // ------------------------------------------------------------------------------------------
    // 4 — capture
    // ------------------------------------------------------------------------------------------
    if (browserSkipReason) {
      record('4 capture fixture page', 'SKIP', 0, browserSkipReason);
    } else {
      await step('4 capture fixture page', async () => {
        const r = await runCli(['capture', fixture.url, '--idle', '3', '--json'], { timeoutMs: 300000 });
        const json = safeJson(r.stdout);
        if (!json?.id) throw new Error(`capture produced no session (exit ${r.code}): ${oneLine(r.stderr).slice(0, 300)}`);
        sessionId = json.id;
        sessionDir = json.dir;
        return { detail: `session ${sessionId} (${json.rawRecords ?? '?'} raw records, ${json.endReason ?? '?'}, integrity ${json.integrityOk ? 'ok' : 'warnings'})` };
      }, { prereq: true });
    }

    // ------------------------------------------------------------------------------------------
    // 5 — session list
    // ------------------------------------------------------------------------------------------
    await step('5 session list contains session', async () => {
      const r = await runCli(['session', 'list', '--json'], { timeoutMs: 60000 });
      const json = safeJson(r.stdout);
      const sessions = Array.isArray(json?.sessions) ? json.sessions : [];
      if (!sessions.some((s) => s.id === sessionId)) throw new Error(`session ${sessionId} not in list (${sessions.length} session(s), exit ${r.code})`);
      return { detail: `${json.total} session(s), ${sessionId} present` };
    });

    // ------------------------------------------------------------------------------------------
    // 6 — session stats and verify
    // ------------------------------------------------------------------------------------------
    await step('6 session stats and verify', async () => {
      const stats = await runCli(['session', 'stats', sessionId, '--json'], { timeoutMs: 60000 });
      const statsJson = safeJson(stats.stdout);
      if (!statsJson) throw new Error(`session stats failed (exit ${stats.code}): ${oneLine(stats.stderr).slice(0, 200)}`);
      const verify = await runCli(['verify', sessionId, '--json'], { timeoutMs: 120000 });
      const verifyJson = safeJson(verify.stdout);
      if (!verifyJson) throw new Error(`verify failed (exit ${verify.code}): ${oneLine(verify.stderr).slice(0, 200)}`);
      if (verifyJson.ok !== true) throw new Error(`verify reported not ok: ${oneLine(JSON.stringify(verifyJson)).slice(0, 200)}`);
      return { detail: `verify ok (${verifyJson.records ?? '?'} records, ${verifyJson.segments?.length ?? '?'} segment(s), ${verifyJson.gapRecords ?? 0} gap(s))` };
    });

    // ------------------------------------------------------------------------------------------
    // 7 — derive --full and exact search
    // ------------------------------------------------------------------------------------------
    await step('7 derive --full and kb search', async () => {
      const d = await runCli(['derive', sessionId, '--full', '--json'], { timeoutMs: 300000 });
      const dj = safeJson(d.stdout);
      if (!dj) throw new Error(`derive produced no result (exit ${d.code}): ${oneLine(d.stderr).slice(0, 300)}`);
      if (dj.ok === false) throw new Error(`derive failed: ${oneLine(dj.error ?? JSON.stringify(dj.manifest ?? {})).slice(0, 200)}`);
      const s = await runCli(['kb', 'search', CHAT_WORDS[0], '--json'], { timeoutMs: 120000 });
      const sj = safeJson(s.stdout);
      const hits = Array.isArray(sj?.rows) ? sj.rows.length : Number(sj?.count ?? 0);
      if (!hits) throw new Error(`kb search "${CHAT_WORDS[0]}" returned no hit (exit ${s.code}): ${oneLine(s.stderr).slice(0, 200)}`);
      return { detail: `derived (${dj.manifest?.status ?? 'ok'}), ${hits} hit(s) for "${CHAT_WORDS[0]}"` };
    });

    // ------------------------------------------------------------------------------------------
    // 8 — fuzzy search
    // ------------------------------------------------------------------------------------------
    await step('8 kb search with a typo', async () => {
      const s = await runCli(['kb', 'search', CHAT_WORD_TYPO, '--json'], { timeoutMs: 120000 });
      const sj = safeJson(s.stdout);
      const hits = Array.isArray(sj?.rows) ? sj.rows.length : Number(sj?.count ?? 0);
      if (!hits) throw new Error(`kb search "${CHAT_WORD_TYPO}" returned no hit (exit ${s.code}): ${oneLine(s.stderr).slice(0, 200)}`);
      return { detail: `${hits} hit(s) for the typo "${CHAT_WORD_TYPO}"` };
    });

    await step('8b bound acceptance and real Core Outcome Packet', async () => {
      if (!sessionId) return { status: 'SKIP', detail: 'no captured session' };
      const session = Session.open(path.join(dataDir, 'sessions'), sessionId);
      acceptance = readAcceptance(session);
      if (acceptance.verdict !== 'capture_incomplete' || ['G1', 'G2', 'G3'].some((id) => acceptance.gates?.[id]?.value !== 'not-checked')) {
        throw new Error('capture without drive context must honestly abstain: ' + JSON.stringify(acceptance));
      }
      if (['G4', 'G5', 'G6', 'G7'].some((id) => acceptance.gates?.[id]?.value !== 'passed')) throw new Error('offline capture gates did not pass');
      const before = rawDigest(session).digest;
      const moduleUrl = pathToFileURL(path.resolve(ROOT, '../../../../../../ops/capture-studio-value-oracle/prototypes/saved-session-outcome.mjs'));
      const { packetFromSavedSession } = await import(moduleUrl.href);
      packetResult = await packetFromSavedSession({ sessionId, home: dataDir, outDir: path.join(dataDir, 'outcome-packet') });
      const p = packetResult.packet;
      if (!p.answer || p.decisions.length !== 1 || p.actions.length !== 1 || p.evidence.length < 4) throw new Error('labelled synthetic answer missing from real Core packet');
      if (p.evidence.some((e) => !e.canonical?.verified || !fs.existsSync(e.canonical.local_file))) throw new Error('canonical original DOM source locator not verified');
      if (p.acceptance.verdict !== acceptance.verdict || !p.unknowns.includes('capture-acceptance-capture_incomplete')) throw new Error('packet lost honest acceptance abstention');
      if (rawDigest(session).digest !== before) throw new Error('packet generation changed captured raw bytes');
      return { detail: `Core readAcceptance=${acceptance.verdict}; G4-G7 passed; ${p.evidence.length} original DOM refs verified; ${packetResult.outDir}; raw digest unchanged` };
    });

    // ------------------------------------------------------------------------------------------
    // 9 — exports contain the streamed words in order
    // ------------------------------------------------------------------------------------------
    await step('9 export dataset and transcript', async () => {
      const exportDir = path.join(dataDir, 'exports');
      fs.mkdirSync(exportDir, { recursive: true });
      const eventsFile = path.join(exportDir, `${sessionId}-events.jsonl`);
      const transcriptFile = path.join(exportDir, `${sessionId}-transcript.md`);
      const e = await runCli(['export', 'dataset', sessionId, '--dataset', 'events', '--format', 'jsonl', '--out', eventsFile], { timeoutMs: 120000 });
      if (!fs.existsSync(eventsFile)) throw new Error(`export dataset wrote no file (exit ${e.code}): ${oneLine(e.stderr).slice(0, 200)}`);
      const t = await runCli(['export', 'transcript', sessionId, '--format', 'md', '--out', transcriptFile], { timeoutMs: 120000 });
      if (!fs.existsSync(transcriptFile)) throw new Error(`export transcript wrote no file (exit ${t.code}): ${oneLine(t.stderr).slice(0, 200)}`);
      const eventsText = fs.readFileSync(eventsFile, 'utf8');
      const transcriptText = fs.readFileSync(transcriptFile, 'utf8');
      const inEvents = wordsInOrder(eventsText, CHAT_WORDS);
      const inTranscript = wordsInOrder(transcriptText, CHAT_WORDS);
      if (!inEvents && !inTranscript) throw new Error('the 12 streamed words are not in order in the exported dataset or transcript');
      const where = inTranscript ? 'transcript' : 'dataset';
      return { detail: `12 streamed words in order in the ${where} (${eventsFile}, ${transcriptFile})` };
    });

    // ------------------------------------------------------------------------------------------
    // 10 — mirror replay
    // ------------------------------------------------------------------------------------------
    if (browserSkipReason) {
      record('10 mirror replay', 'SKIP', 0, browserSkipReason);
    } else {
      await step('10 mirror replay', async () => {
        const st = spawnCli(['mirror', sessionId, '--port', '0', '--json']);
        const info = await waitForJson(st, 30000);
        const baseUrl = String(info.url ?? '').replace(/\/+$/, '');
        if (!baseUrl) throw new Error(`mirror gave no url: ${oneLine(JSON.stringify(info)).slice(0, 200)}`);
        const itemsRes = await fetch(`${baseUrl}/api/items`, { signal: AbortSignal.timeout(30000) });
        const itemsText = await itemsRes.text();
        if (itemsRes.status !== 200) throw new Error(`mirror GET /api/items returned HTTP ${itemsRes.status}: ${oneLine(itemsText).slice(0, 120)}`);
        const itemsJson = safeJson(itemsText);
        if (JSON.stringify(itemsJson) !== JSON.stringify(ITEMS)) throw new Error(`mirror /api/items differs from the fixture: ${oneLine(itemsText).slice(0, 200)}`);
        const chatRes = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hello fixture' }), signal: AbortSignal.timeout(60000) });
        const chatText = await chatRes.text();
        if (chatRes.status !== 200) throw new Error(`mirror POST /api/chat returned HTTP ${chatRes.status}: ${oneLine(chatText).slice(0, 120)}`);
        if (!chatText.includes('[DONE]')) throw new Error(`mirror POST /api/chat did not stream an SSE [DONE] marker: ${oneLine(chatText).slice(0, 200)}`);
        return { detail: `${baseUrl} replayed the fixture JSON list and an SSE stream ending in [DONE]` };
      });
    }

    // ------------------------------------------------------------------------------------------
    // 11 — dedupe, detect and csv
    // ------------------------------------------------------------------------------------------
    await step('11 dedupe, detect and csv', async () => {
      const csvFile = path.join(dataDir, 'fixture-data.csv');
      const csvRes = await fetch(`${fixture.url}data.csv`);
      const csvBody = await csvRes.text();
      fs.writeFileSync(csvFile, csvBody);
      const csv = await runCli(['csv', csvFile, '--json'], { timeoutMs: 60000 });
      const csvJson = safeJson(csv.stdout);
      if (!csvJson) throw new Error(`csv failed (exit ${csv.code}): ${oneLine(csv.stderr).slice(0, 200)}`);
      const columns = (Array.isArray(csvJson.header) ? csvJson.header.length : 0) || (Array.isArray(csvJson.columns) ? csvJson.columns.length : 0);
      const rows = (Array.isArray(csvJson.records) ? csvJson.records.length : 0) || (Array.isArray(csvJson.rows) ? csvJson.rows.length : 0) || Number(csvJson.stats?.rows ?? 0);
      if (!columns || !rows) throw new Error(`csv analysis found ${columns} column(s) / ${rows} row(s)`);
      const detect = await runCli(['detect', csvFile, '--json'], { timeoutMs: 60000 });
      const detectJson = safeJson(detect.stdout);
      if (!detectJson) throw new Error(`detect failed (exit ${detect.code}): ${oneLine(detect.stderr).slice(0, 200)}`);
      const dedupeNote = sessionId && !fatal
        ? `dedupe ${sessionId}: ${(await runCli(['dedupe', sessionId, '--json'], { timeoutMs: 120000 })).code === 0 ? 'ok' : 'failed'}`
        : 'dedupe skipped (no session)';
      return { detail: `csv ${rows} row(s) / ${columns} column(s), detect ok, ${dedupeNote}` };
    });

    // ------------------------------------------------------------------------------------------
    // 12 — integrity manifest
    // ------------------------------------------------------------------------------------------
    await step('12 integrity build and verify', async () => {
      const dir = sessionDir ?? path.join(dataDir, 'sessions', sessionId);
      const b = await runCli(['integrity', 'build', dir, '--json'], { timeoutMs: 120000 });
      const bj = safeJson(b.stdout);
      if (!bj) throw new Error(`integrity build failed (exit ${b.code}): ${oneLine(b.stderr).slice(0, 200)}`);
      const v = await runCli(['integrity', 'verify', dir, '--json'], { timeoutMs: 120000 });
      const vj = safeJson(v.stdout);
      if (!vj) throw new Error(`integrity verify failed (exit ${v.code}): ${oneLine(v.stderr).slice(0, 200)}`);
      if (vj.ok !== true) throw new Error(`integrity verify not ok: ${oneLine(JSON.stringify(vj)).slice(0, 200)}`);
      return { detail: `manifest over ${bj.files ?? '?'} file(s) verified (${dir})` };
    });

    // ------------------------------------------------------------------------------------------
    // 13 — studio HTTP API
    // ------------------------------------------------------------------------------------------
    await step('13 studio api stats and platform', async () => {
      const st = spawnCli(['serve', '--studio-port', '0', '--no-open', '--json']);
      const info = await waitForJson(st, 30000);
      const token = new URL(info.url).searchParams.get('token');
      const headers = token ? { 'x-studio-token': token } : {};
      const origin = `http://127.0.0.1:${info.port}`;
      const statsRes = await fetch(`${origin}/api/x/stats`, { headers, signal: AbortSignal.timeout(30000) });
      const statsText = await statsRes.text();
      if (statsRes.status !== 200) throw new Error(`/api/x/stats returned HTTP ${statsRes.status}: ${oneLine(statsText).slice(0, 160)}`);
      const platformRes = await fetch(`${origin}/platform`, { headers, signal: AbortSignal.timeout(30000) });
      if (platformRes.status !== 200) throw new Error(`/platform returned HTTP ${platformRes.status}`);
      const platformText = await platformRes.text();
      if (!/<html/i.test(platformText)) throw new Error('/platform did not return an HTML page');
      if (sessionId) {
        const get = async (suffix) => {
          const response = await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}${suffix}`, { headers, signal: AbortSignal.timeout(30000) });
          if (response.status !== 200) throw new Error(`saved-session API ${suffix}: HTTP ${response.status}`);
          return response.json();
        };
        const saved = await get('');
        if (saved.meta?.id !== sessionId) throw new Error('saved-session API resolved wrong identity');
        const label = await get('/acceptance');
        if (label.verdict !== acceptance?.verdict) throw new Error('API acceptance differs from canonical reader');
        if ((await get('/knowledge-status'))?.status !== 'complete') throw new Error('API knowledge not complete');
        const turns = await get('/turns');
        for (const e of packetResult?.packet.evidence ?? []) {
          const index = Number(e.canonical.json_pointer.split('/')[1]);
          if (turns[index]?.text.split(/\r?\n/)[e.line - 1] !== e.quote) throw new Error('API source line differs from Outcome Packet');
          const linked = await fetch(new URL(e.canonical.ui_href, origin), { headers });
          if (linked.status !== 200) throw new Error('saved-session UI entry link unavailable');
          await linked.arrayBuffer();
        }
        // Explicit acceptance context over the API (G1-G3 with a pre-send baseline): the fixture
        // capture honestly satisfies it — prompt rendered as the first user turn, reply words in
        // order as the first assistant turn, done record present. The stored label then flips to
        // capture_accepted through the same write path derive uses.
        const postBody = JSON.stringify({ conversation: { prompt: 'hello fixture', expectedReplyWords: [...CHAT_WORDS],
          completionRule: { requireDone: true, stableObserved: true }, baseline: { userTurns: 0, assistantTurns: 0 } } });
        const postRes = await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}/acceptance`, { method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000), body: postBody });
        if (postRes.status !== 200) throw new Error(`POST acceptance returned HTTP ${postRes.status}: ${oneLine(await postRes.text()).slice(0, 200)}`);
        const receipt = await postRes.json();
        if (receipt.verdict !== 'capture_accepted' || receipt.gates.G1 !== 'passed' || receipt.gates.G2 !== 'passed' || receipt.gates.G3 !== 'passed') {
          throw new Error('explicit-context acceptance did not reach capture_accepted: ' + JSON.stringify(receipt).slice(0, 240));
        }
        const after = await get('/acceptance');
        if (after.verdict !== 'capture_accepted' || after.gates?.G1?.evidence?.freshness !== 'pre-send baseline enforced') {
          throw new Error('stored acceptance did not record the enforced pre-send baseline');
        }
        // Durable harness run over the same server and the same runtime: execute, replay, conflict, finish.
        const runsUrl = `${origin}/api/v1/harness/runs`;
        const manifest = await (await fetch(`${origin}/api/v1/integrations/tools`, { headers, signal: AbortSignal.timeout(30000) })).json();
        for (const tool of ['harness_start_run', 'harness_run_step', 'harness_get_run', 'harness_finish_run']) {
          if (!manifest.tools?.some((t) => t.name === tool)) throw new Error(`tool manifest lacks ${tool}`);
        }
        const runRes = await fetch(runsUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ task: 'live-e2e harness verification' }) });
        if (runRes.status !== 201) throw new Error(`harness run create returned HTTP ${runRes.status}`);
        const run = (await runRes.json()).run;
        const stepCall = (key, tool, args) => fetch(`${runsUrl}/${run.id}/steps`, { method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ key, tool, arguments: args }) });
        const exec = await (await stepCall('list-1', 'list_conversations', {})).json();
        if (exec.replayed !== false || exec.step?.status !== 'succeeded' || !Array.isArray(exec.result)) {
          throw new Error('harness step did not execute through the shared runtime: ' + JSON.stringify(exec).slice(0, 200));
        }
        const replay = await (await stepCall('list-1', 'list_conversations', {})).json();
        if (replay.replayed !== true) throw new Error('harness replay did not reuse the recorded outcome');
        const conflict = await stepCall('list-1', 'list_conversations', { differing: true });
        if (conflict.status !== 409) throw new Error('same key with different arguments must be IDEMPOTENCY_CONFLICT');
        const fin = await (await fetch(`${runsUrl}/${run.id}/finish`, { method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'succeeded' }) })).json();
        if (fin.run?.status !== 'succeeded') throw new Error('harness finish did not record the final status');
        // Loss-aware observation envelope over the REAL captured session: identity stays
        // unverified for a non-parser site (no fabrication), streams and DOM turns are projected,
        // and the five completion facts are present and distinct.
        const obsRes = await fetch(`${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}/observation`, { headers, signal: AbortSignal.timeout(30000) });
        if (obsRes.status !== 200) throw new Error(`GET observation returned HTTP ${obsRes.status}: ${oneLine(await obsRes.text()).slice(0, 160)}`);
        const obs = (await obsRes.json()).observation;
        if (obs.schema !== 'aion.web-observation/1') throw new Error('observation envelope has the wrong schema');
        if (obs.conversation.binding !== 'unverified' || obs.conversation.nativeRef !== null) {
          throw new Error('observation fabricated a conversation identity for a non-parser site: ' + JSON.stringify(obs.conversation));
        }
        if (obs.surface !== 'chat' || !Array.isArray(obs.streams) || !obs.streams.length || obs.turns.length < 2) {
          throw new Error('observation missed the captured chat surface: ' + JSON.stringify({ surface: obs.surface, streams: obs.streams?.length, turns: obs.turns?.length }));
        }
        for (const fact of ['providerNetworkEnded', 'pageStable', 'turnAttribution', 'captureFinalized', 'captureAccepted']) {
          if (!(fact in obs.completion)) throw new Error(`observation completion lacks ${fact}`);
        }
        if (obs.completion.captureAccepted !== 'capture_accepted') throw new Error('observation lost the accepted verdict');
        if (!Array.isArray(obs.lossMarkers)) throw new Error('observation lacks loss markers');
        fs.writeFileSync(path.join(dataDir, 'saved-links.json'), JSON.stringify({ sessionId,
          ui: `${origin}/#session=${encodeURIComponent(sessionId)}`, api: `${origin}/api/sessions/${encodeURIComponent(sessionId)}`,
          harnessRun: run.id, observation: { provider: obs.provider, streams: obs.streams.length, turns: obs.turns.length, lossMarkers: obs.lossMarkers.length },
          proof: 'HTTP and exact API source-line checks only; not visual UI proof' }, null, 2));
        return { detail: `studio on port ${info.port}: /api/x/stats ${statsRes.status}, /platform ${platformRes.status}, acceptance=${receipt.verdict} (baseline enforced), harness run ${run.id} succeeded with idempotent replay, observation ${obs.streams.length} stream(s)/${obs.turns.length} turn(s), ${obs.lossMarkers.length} loss marker(s)` };
      }
      return { detail: `studio on port ${info.port}: /api/x/stats ${statsRes.status}, /platform ${platformRes.status}` };
    });
  } finally {
    // ------------------------------------------------------------------------------------------
    // cleanup: every spawned process and the Chrome this driver started
    // ------------------------------------------------------------------------------------------
    for (const child of spawned) { try { child.kill(); } catch { /* already gone */ } }
    if (chromePid) {
      try {
        if (process.platform === 'win32') {
          const info = safeJson(execFileSync('powershell.exe', ['-NoProfile', '-Command',
            `Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(chromePid)}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
          if (!info || !/^(chrome|msedge)\.exe$/i.test(info.Name) || !chromeProfile || !info.CommandLine?.includes(chromeProfile)
            || !info.CommandLine.includes(`--remote-debugging-port=${cdpPort}`)) {
            record('cleanup owned Chrome', 'FAIL', 0, 'PID/profile/port ownership not confirmed; process left untouched');
          } else {
            let killError = null;
            try { execFileSync('taskkill', ['/PID', String(chromePid), '/T', '/F'], { windowsHide: true }); }
            catch (e) { killError = e.message; }
            const remaining = execFileSync('powershell.exe', ['-NoProfile', '-Command',
              `Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(chromePid)}" | Select-Object ProcessId | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }).trim();
            record('cleanup owned Chrome', remaining ? 'FAIL' : 'PASS', 0,
              remaining ? `owned Chrome still running: ${killError ?? remaining}` : 'verified PID/profile/port before termination; confirmed PID absent afterwards');
          }
        }
        else process.kill(-chromePid, 'SIGKILL');
      } catch (e) { record('cleanup owned Chrome', 'FAIL', 0, `cleanup could not be verified: ${e.message}`); }
    }
    if (fixture) { try { await fixture.close(); } catch { /* closed */ } }
    if (!KEEP) { try { fs.rmSync(path.join(dataDir, 'chrome-profile'), { recursive: true, force: true }); } catch { /* nothing to remove */ } }
  }

  // -------------------------------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------------------------------
  const failures = steps.filter((s) => s.status === 'FAIL');
  const skipped = steps.filter((s) => s.status === 'SKIP');
  const passed = steps.filter((s) => s.status === 'PASS');
  const finishedAt = new Date().toISOString();
  const result = {
    startedAt, finishedAt, dataDir, cdpPort, sessionId, sessionDir, keep: KEEP, noBrowser: NO_BROWSER,
    acceptanceVerdict: acceptance?.verdict ?? null, packetDir: packetResult?.outDir ?? null,
    ok: failures.length === 0,
    counts: { pass: passed.length, fail: failures.length, skip: skipped.length, total: steps.length },
    steps,
  };
  fs.writeFileSync(path.join(dataDir, 'live-e2e-result.json'), `${JSON.stringify(result, null, 2)}\n`);

  const width = Math.max(36, ...steps.map((s) => s.name.length));
  console.log('');
  console.log(`Capture Studio live e2e — data dir ${dataDir}`);
  console.log('');
  console.log(`${'STEP'.padEnd(width)}  ${'STATUS'.padEnd(6)}  ${'MS'.padStart(6)}  DETAIL`);
  console.log(`${'-'.repeat(width)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(40)}`);
  for (const s of steps) console.log(`${s.name.padEnd(width)}  ${s.status.padEnd(6)}  ${String(s.ms).padStart(6)}  ${s.detail}`);
  console.log('');
  console.log(`${passed.length} passed, ${failures.length} failed, ${skipped.length} skipped — result written to ${path.join(dataDir, 'live-e2e-result.json')}`);

  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error(`live-e2e crashed: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
