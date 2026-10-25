#!/usr/bin/env node
// Adapter Factory end-to-end demonstration: a previously UNSEEN webapp (scripts/adapter-fixture-site.mjs,
// an unregistered synthetic AI chat host) goes from zero handwritten adapters to a versioned,
// READ-ONLY learned adapter through Capture Studio's own evidence path:
//
//   phase 0  prerequisites: openssl self-signed cert, isolated data dir, headless Chrome
//   phase 1  DISCOVER + INTERACT: four real `studio drive` exchanges on the unseen host, through
//            Studio's single actor with GENERIC heuristics only (no adapter exists for it)
//   phase 2  GENERATE: synthesizeWebappAdapter over the three training captures (saved-evidence probes)
//   phase 3  SHADOW VALIDATE: held-out capture replay -> candidate-read-only-preview
//   phase 4  ACTIVATE (read-only): server-side re-verified promotion -> VersionedStore v1
//   phase 5  READ-ONLY CONVERSATION EXPERIENCE: saved-session transcript + LIVE transcript while
//            a capture is attached, plus the registry read view; the execution path is proven
//            untouched (getAdapter still returns nothing for the learned host)
//   phase 6  DRIFT + RELEARN: the site ships a v2 UI (role attribute renamed); two more drives +
//            a live measurement with prior-selector absence -> drift detected -> v2 promoted
//   phase 7  ROLLBACK safety: pointer moves between v1 and v2
//
// Every step prints PASS/FAIL with a one-line detail. Result JSON: <data-dir>/adapter-factory-demo-result.json
// Evidence classes: the fixture host is synthetic (SANDBOX-DEMO); the captures, probes and
// learned adapter are real products of the real pipeline against that real (local) webapp.
// No third-party provider, authenticated surface or Windows-specific claim is made.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STUDIO = path.join(ROOT, 'bin', 'studio.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const steps = [];
let failed = false;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, status: 'PASS', ms: Date.now() - t0, detail: oneLine(detail) });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)  ${oneLine(detail)}`);
  } catch (e) {
    failed = true;
    steps.push({ name, status: 'FAIL', ms: Date.now() - t0, detail: oneLine(e.message) });
    console.log(`FAIL  ${name}  (${Date.now() - t0} ms)  ${oneLine(e.message)}`);
    throw e;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function findChromeBinary() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const candidates = [];
  try {
    for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium-') && !x.includes('headless'))) {
      for (const layout of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
        candidates.push(path.join(cache, d, layout));
      }
    }
  } catch { /* no cache dir */ }
  candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium');
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function runCli(args, { env = {}, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STUDIO, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 124, stdout, stderr: `${stderr}\ntimeout` }); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }); });
  });
}

async function api(port, method, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${oneLine(text).slice(0, 300)}`);
  return json;
}

// The fixture speaks HTTPS with a self-signed certificate; this client trusts it for the demo only.
function tlsApi(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = https.request({ host: '127.0.0.1', port, method, path: pathname, rejectUnauthorized: false,
      headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }, timeout: 8000 },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* non-JSON */ }
          if (res.statusCode >= 400) reject(new Error(`${method} ${pathname} -> ${res.statusCode}: ${oneLine(text).slice(0, 200)}`));
          else resolve(json);
        });
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('fixture timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function httpApi(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }, timeout: 8000 },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* non-JSON */ }
          if (res.statusCode >= 400) reject(new Error(`${method} ${pathname} -> ${res.statusCode}: ${oneLine(text).slice(0, 200)}`));
          else resolve(json);
        });
      });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// DevTools HTTP endpoint helpers for demo tab lifecycle (the drive/record flow keeps the
// owner's browser clean by closing what it opens, so the demo manages its own tabs).
async function cdpOpenTab(cdpPort, url) {
  const created = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new`, { method: 'PUT' })).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await call('Page.enable');
  await call('Page.navigate', { url });
  ws.close();
  return created.id;
}
async function cdpCloseTab(cdpPort, targetId) {
  try { await fetch(`http://127.0.0.1:${cdpPort}/json/close/${targetId}`); } catch { /* best effort */ }
}
async function waitForTabUrl(cdpPort, targetId, urlPart, { timeoutMs = 20000 } = {}) {
  for (let i = 0; i < timeoutMs / 250; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const hit = list.find((t) => t.id === targetId);
      if (hit && (hit.url ?? '').includes(urlPart)) return hit;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`tab ${targetId} never reached a URL containing ${urlPart}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-adapter-demo-'));
  const resultsFile = path.join(dataDir, 'adapter-factory-demo-result.json');
  const certDir = path.join(dataDir, 'tls');
  fs.mkdirSync(certDir, { recursive: true });
  const keyFile = path.join(certDir, 'key.pem'), certFile = path.join(certDir, 'cert.pem');
  const fixturePort = await freePort(), cdpPort = await freePort(), servePort = await freePort();
  const ORIGIN = `https://127.0.0.1:${fixturePort}`;
  const chromeBin = findChromeBinary();
  const env = {
    CAPTURE_STUDIO_HOME: dataDir,
    CAPTURE_STUDIO_CDP_PORT: String(cdpPort),
    ...(chromeBin ? { CHROME_PATH: chromeBin, CAPTURE_STUDIO_CHROME_ARGS: '--ignore-certificate-errors' } : {}),
  };
  const SITE = 'nimbus-chat'; // unregistered site id for the learned adapter

  console.log(`adapter-factory demo: dataDir=${dataDir} fixture=${ORIGIN} chrome=${chromeBin ?? 'MISSING'}`);

  let fixture = null, serve = null;

  const startFixture = (v2) => {
    const child = spawn(process.execPath, [path.join(HERE, 'adapter-fixture-site.mjs')], {
      env: { ...process.env, FIXTURE_PORT: String(fixturePort), FIXTURE_TLS_KEY_FILE: keyFile, FIXTURE_TLS_CERT_FILE: certFile, ...(v2 ? { FIXTURE_V2: '1' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => console.error(`fixture: ${oneLine(String(d))}`));
    return child;
  };
  const stopFixture = async () => { if (fixture) { fixture.kill('SIGTERM'); await sleep(300); fixture = null; } };

  const tlsOk = spawnSync('openssl', ['version']).status === 0;
  const chromeOk = !!chromeBin;
  const browserPossible = tlsOk && chromeOk;
  const skipNote = !browserPossible ? (tlsOk ? 'no Chrome binary' : 'no openssl') : null;

  try {
    // ---- phase 0: prerequisites ------------------------------------------------------------
    await step('0a self-signed TLS material for the unseen host', () => {
      if (!tlsOk) throw new Error('openssl not available');
      const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile, '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
      if (r.status !== 0) throw new Error(`openssl failed: ${oneLine(String(r.stderr))}`);
      return `cert ${certFile}`;
    });

    await step('0b studio doctor on the isolated data dir', async () => {
      const r = await runCli(['doctor', '--json'], { env });
      const dj = JSON.parse(r.stdout);
      const okCount = (dj.checks ?? []).filter((c) => c.level === 'ok').length;
      if (okCount < 3) throw new Error(`doctor: ${JSON.stringify(dj.checks?.slice(0, 6))}`);
      return `${okCount} checks ok`;
    });

    await step('0c fixture webapp up (v1 UI, unregistered host)', async () => {
      fixture = startFixture(false);
      for (let i = 0; i < 40; i++) {
        try { const h = await tlsApi(fixturePort, 'GET', '/api/health'); if (h.ok) return `fixture v1 on ${ORIGIN}`; } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('fixture did not become healthy');
    });

    if (browserPossible) {
      await step('0d headless capture browser via studio launch', async () => {
        const r = await runCli(['launch', '--headless', '--json'], { env });
        const lj = JSON.parse(r.stdout);
        if (!lj.browser && !lj.alreadyRunning) throw new Error(`launch: ${oneLine(r.stdout + r.stderr).slice(0, 200)}`);
        return `${lj.browser ?? 'chrome'} on 127.0.0.1:${cdpPort}`;
      });
    }

    // ---- phase 1: interact with the unseen webapp through Studio's single actor ------------
    const drives = {};
    const prompts = ['Tell me about the alpha feature.', 'Tell me about the beta feature.', 'Tell me about the gamma feature.', 'Tell me about the delta feature.'];
    if (browserPossible) {
      for (const [i, prompt] of prompts.entries()) {
        await step(`1${i + 1} drive the unseen host with generic heuristics (exchange ${i + 1}/4)`, async () => {
          const r = await runCli(['drive', `${ORIGIN}/`, '--prompt', prompt, '--json', '--timeout', '90'], { env, timeoutMs: 150000 });
          const dj = JSON.parse(r.stdout);
          if (!dj.sessionId) throw new Error(`drive produced no session: ${oneLine(r.stdout + r.stderr).slice(0, 300)}`);
          drives[i + 1] = dj.sessionId;
          return `session ${dj.sessionId} sent=${dj.ok ? 'yes' : `no(${dj.reason})`} reply="${oneLine(dj.reply).slice(0, 60)}"`;
        });
      }
    } else {
      steps.push({ name: 'phase 1 drives', status: 'SKIP', ms: 0, detail: skipNote });
      console.log(`SKIP  phase 1 drives  (${skipNote})`);
    }

    // ---- phases 2-5: factory lifecycle over the saved captures ------------------------------
    if (Object.keys(drives).length >= 4) {
      serve = spawn(process.execPath, [STUDIO, 'serve', '--studio-port', String(servePort), '--no-open'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      serve.stdout.on('data', () => {});
      serve.stderr.on('data', (d) => console.error(`serve: ${oneLine(String(d))}`));
      await step('2a studio serve up', async () => {
        for (let i = 0; i < 60; i++) {
          try { await api(servePort, 'GET', '/api/v1/health'); return `serve on 127.0.0.1:${servePort}`; } catch { await sleep(300); }
        }
        throw new Error('serve did not become healthy');
      });

      let candidate = null, shadow = null;
      await step('2b synthesize candidate from three training captures (zero handwritten adapters)', async () => {
        const out = await api(servePort, 'POST', '/api/v1/adapters/learned/synthesize', { siteId: SITE, origin: ORIGIN, sessionIds: [drives[1], drives[2], drives[3]] });
        candidate = out.candidate;
        if (candidate.authority.sendPermission !== false) throw new Error('candidate authority must forbid send');
        return `probes=${out.evidence.probeCount} user-turn=${candidate.coverage['user-turn']} assistant-turn=${candidate.coverage['assistant-turn']} thread-route=${candidate.coverage['thread-route']} drift=${out.drift.length}`;
      });

      await step('3 shadow-evaluate against the held-out capture', async () => {
        shadow = await api(servePort, 'POST', '/api/v1/adapters/learned/shadow-evaluate', { candidate, sessionIds: [drives[4]] });
        if (shadow.recommendation !== 'candidate-read-only-preview') throw new Error(`shadow recommendation: ${shadow.recommendation}`);
        return `checked=${shadow.checked} positive=${shadow.positive} contradicted=${shadow.contradicted} -> ${shadow.recommendation}`;
      });

      await step('4 promote to versioned READ-ONLY learned adapter (server-side re-verification)', async () => {
        const rec = await api(servePort, 'POST', '/api/v1/adapters/learned/promote', { candidate, sessionIds: [drives[4]], shadow, expectedVersion: null, note: 'v1 from three held training captures' });
        if (rec.adapter?.send?.strategy !== 'learned-readonly') throw new Error('promoted adapter must carry learned-readonly');
        return `v${rec.version} readFeatures=${rec.readFeatures.join('+')}`;
      });

      await step('5a read-only conversation experience from a saved capture', async () => {
        const t = await api(servePort, 'GET', `/api/v1/adapters/learned/${SITE}/transcript?session=${drives[4]}`);
        if (t.items.length < 2) throw new Error(`transcript items: ${t.items.length}`);
        if (t.thread.binding !== 'unverified') throw new Error('fixture identity must stay unverified (no parser for this site)');
        return `${t.items.length} turns, roles=${t.items.map((x) => x.role).join(',')}, thread binding=${t.thread.binding}`;
      });

      if (browserPossible) {
        await step('5b LIVE read-only transcript while the serve process records', async () => {
          // Open a dedicated v1 tab, drive it once (reuse: the tab survives), record THAT tab
          // by id in the serve process, then read the live page through the learned adapter.
          const tabId = await cdpOpenTab(cdpPort, `${ORIGIN}/`);
          await waitForTabUrl(cdpPort, tabId, '127.0.0.1');
          await runCli(['drive', `${ORIGIN}/`, '--prompt', prompts[0], '--no-record', '--reuse-tab', '--timeout', '60'], { env, timeoutMs: 120000 });
          const started = await api(servePort, 'POST', '/api/record/start', { target: tabId });
          try {
            for (let i = 0; i < 40; i++) {
              const st = await api(servePort, 'GET', '/api/status');
              if (st.recorder?.state === 'recording') break;
              await sleep(250);
            }
            await sleep(1500); // dom agent injects; the page keeps its rendered thread
            const t = await api(servePort, 'GET', `/api/v1/adapters/learned/${SITE}/transcript?live=1`);
            if (!Array.isArray(t.items) || t.items.length < 2) throw new Error(`live transcript items: ${t.items?.length}`);
            return `live turns=${t.items.length} roles=${t.items.map((x) => x.role).join(',')} source=${t.source} (record session ${started.id ?? '?'})`;
          } finally {
            try { await api(servePort, 'POST', '/api/record/stop', {}); } catch { /* already stopping */ }
            await sleep(1500);
            await cdpCloseTab(cdpPort, tabId);
          }
        });

        await step('5c registry read view exposes the learned adapter; execution path untouched', async () => {
          const read = await api(servePort, 'GET', `/api/v1/adapters/read/${SITE}`);
          if (!read.adapter?.learned) throw new Error('learned adapter missing from read view');
          const exec = await runCli(['drive', `${ORIGIN}/`, '--dry-run', '--json'], { env });
          const dj = JSON.parse(exec.stdout);
          if (dj.site === SITE) throw new Error('execution path resolved the LEARNED adapter — must never happen');
          return `read view: learned=${read.adapter.id}; execution path resolves "${dj.site}" (generic heuristics, unchanged)`;
        });
      }

      // ---- phase 6: drift + relearn ---------------------------------------------------------
      if (browserPossible) {
        await step('6a site ships a v2 UI (role attribute renamed); three more real exchanges', async () => {
          await stopFixture();
          fixture = startFixture(true);
          for (let i = 0; i < 40; i++) { try { const h = await tlsApi(fixturePort, 'GET', '/api/health'); if (h.ok && h.v2) break; } catch { /* retry */ } await sleep(250); }
          const drives2 = {};
          let i = 0;
          for (const prompt of ['Tell me about the epsilon feature.', 'Tell me about the zeta feature.', 'Tell me about the eta feature.']) {
            const r = await runCli(['drive', `${ORIGIN}/`, '--prompt', prompt, '--json', '--timeout', '90'], { env, timeoutMs: 150000 });
            const dj = JSON.parse(r.stdout);
            if (!dj.sessionId) throw new Error(`v2 drive ${i + 1} produced no session: ${oneLine(r.stdout + r.stderr).slice(0, 200)}`);
            drives2[++i] = dj.sessionId;
          }
          globalThis.__drives2 = drives2;
          return `v2 sessions ${drives2[1]}, ${drives2[2]}, held-out ${drives2[3]}`;
        });

        await step('6b synthesize with prior + live measurement: drift detected, replacement proposed', async () => {
          // A dedicated v2 tab (driven with --reuse-tab so it survives), recorded BY ID in the
          // serve process: the live measurement then sees the CURRENT v2 DOM (no stale tab, no
          // localStorage restore) — old selectors measurably absent, new attribute present.
          const tabId = await cdpOpenTab(cdpPort, `${ORIGIN}/`);
          await waitForTabUrl(cdpPort, tabId, '127.0.0.1');
          await runCli(['drive', `${ORIGIN}/`, '--prompt', 'Tell me about the theta feature.', '--no-record', '--reuse-tab', '--timeout', '60'], { env, timeoutMs: 120000 });
          await api(servePort, 'POST', '/api/record/start', { target: tabId });
          try {
            for (let i = 0; i < 40; i++) {
              const st = await api(servePort, 'GET', '/api/status');
              if (st.recorder?.state === 'recording') break;
              await sleep(250);
            }
            await sleep(1200);
            const drives2 = globalThis.__drives2;
            const out = await api(servePort, 'POST', '/api/v1/adapters/learned/synthesize', {
              siteId: SITE, origin: ORIGIN, sessionIds: [drives2[1], drives2[2]], priorName: SITE, live: true,
            });
            const reasons = [...new Set(out.drift.map((d) => d.reason))];
            if (!reasons.includes('PREVIOUS_CANDIDATE_NEGATIVE_OBSERVATION')) throw new Error(`expected prior-negative drift, got: ${reasons.join(',')}`);
            if (!reasons.includes('PROPOSED_REPLACEMENT_REQUIRES_SHADOW_VALIDATION')) throw new Error(`expected replacement proposal, got: ${reasons.join(',')}`);
            globalThis.__v2candidate = out.candidate;
            return `drift=${reasons.join(' + ')}; live=[${out.evidence.liveCandidates.join('; ')}]; new candidate user-turn=${out.candidate.coverage['user-turn']}`;
          } finally {
            try { await api(servePort, 'POST', '/api/record/stop', {}); } catch { /* already stopping */ }
            await sleep(1500);
            await cdpCloseTab(cdpPort, tabId);
          }
        });

        await step('6c shadow-validate the repaired candidate and promote v2', async () => {
          const drives2 = globalThis.__drives2;
          const shadow2 = await api(servePort, 'POST', '/api/v1/adapters/learned/shadow-evaluate', { candidate: globalThis.__v2candidate, sessionIds: [drives2[3]] });
          if (shadow2.recommendation !== 'candidate-read-only-preview') throw new Error(`shadow2: ${shadow2.recommendation}`);
          const rec2 = await api(servePort, 'POST', '/api/v1/adapters/learned/promote', { candidate: globalThis.__v2candidate, sessionIds: [drives2[3]], shadow: shadow2, expectedVersion: 1, note: 'v2 relearn after UI drift' });
          if (rec2.adapter.userTurn.selectors[0] !== '[data-msg-role="user"]') throw new Error(`v2 selector: ${rec2.adapter.userTurn.selectors[0]}`);
          return `v${rec2.version} userTurn=${rec2.adapter.userTurn.selectors[0]} (was [data-role="user"])`;
        });

        await step('7 versioned rollback safety (restore v1, then restore v2; each appends a new version under strict expectedVersion)', async () => {
          const r1 = await api(servePort, 'POST', `/api/v1/adapters/learned/${SITE}/rollback`, { version: 1, confirm: true, expectedVersion: 2 });
          const a1 = await api(servePort, 'GET', `/api/v1/adapters/learned/${SITE}`);
          const sel1 = a1.adapter?.userTurn?.selectors?.[0];
          const r2 = await api(servePort, 'POST', `/api/v1/adapters/learned/${SITE}/rollback`, { version: 2, confirm: true, expectedVersion: r1.version });
          const a2 = await api(servePort, 'GET', `/api/v1/adapters/learned/${SITE}`);
          const sel2 = a2.adapter?.userTurn?.selectors?.[0];
          if (sel1 !== '[data-role="user"]' || sel2 !== '[data-msg-role="user"]') throw new Error(`rollback pointers: v1=${sel1} v2=${sel2}`);
          return `restored v1=${sel1} (as v${r1.version}) -> restored v2=${sel2} (as v${r2.version}); versions=${a2.versions.length}`;
        });
      }
    } else {
      steps.push({ name: 'phases 2-7', status: 'SKIP', ms: 0, detail: skipNote ?? 'fewer than 4 drive sessions' });
      console.log(`SKIP  phases 2-7  (${skipNote ?? 'no captures'})`);
    }

    await step('8 remaining-gaps ledger written', async () => {
      const gaps = {
        demoScope: 'synthetic unregistered local https host (SANDBOX-DEMO); no third-party provider exercised',
        notImplemented: [
          'automatic extraction from Claude Connect/protobuf native streams stays a specialist decoder path (atlas B03)',
          'scheduled drift sweeps (cron-like re-probes of promoted sites) not built; drift fires on synthesis with a prior',
          'activation for composer/send features: deliberately never (read-only authority); owner-executed effects keep using seed adapters',
          'Windows/NTFS conformance pack for the learned store: owner handoff (same as Round 6 store probe)',
        ],
      };
      fs.writeFileSync(path.join(dataDir, 'adapter-factory-demo-gaps.json'), JSON.stringify(gaps, null, 2));
      return `${gaps.notImplemented.length} named gaps`;
    });
  } finally {
    await stopFixture();
    if (serve) serve.kill('SIGTERM');
    fs.writeFileSync(resultsFile, JSON.stringify({ steps, failed }, null, 2));
    console.log(`\nresult: ${resultsFile}`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
