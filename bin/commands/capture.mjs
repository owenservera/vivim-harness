// start, serve, launch, targets, record, capture
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { launchChrome, findChrome } from '../../src/chrome/launch.mjs';
import { verifyBrowserOwner } from '../../src/chrome/browser-ownership.mjs';
import { listTargets, isReachable, endpointBase } from '../../src/cdp/discovery.mjs';
import { Recorder } from '../../src/capture/recorder.mjs';
import { Session } from '../../src/store/session.mjs';
import { derive } from '../../src/replay/derive.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { acquireCdpOwnerLock, lockPath } from '../../src/studio/cdp-owner-lock.mjs';
import { qrToTerminal, lanAddresses, pickLanAddress, pairingUrl, ensurePairingToken, resetPairingToken } from '../../src/studio/lan-pair.mjs';
import { exportTranscript, exportReport, exportKnowledge, exportBundle, exportSchemas, exportGraphRanked } from '../../src/export/export.mjs';
import { define, defineGroup } from '../lib/registry.mjs';
import { CliError, usageError, envError, fmtBytes } from '../lib/ui.mjs';
import { capability } from '../lib/capabilities.mjs';

function openUrl(url) {
  // Windows: explorer.exe takes the URL directly, so no cmd.exe shell ever parses it.
  const cmd = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    // The URL remains printable even when xdg-open/open/cmd is not installed.
    // Missing helper binaries emit an asynchronous error, not a synchronous throw.
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* the URL is printed anyway */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------------------------
define({
  name: 'launch', section: 'Capture', usage: '[--url URL]', summary: 'Open the dedicated capture browser (loopback DevTools only)',
  description: 'Starts Chrome with a separate profile and a loopback-only DevTools port. Sign in to the sites you want to capture in that window; the profile persists between runs.',
  flags: { url: { type: 'string', valueName: 'URL', desc: 'Page to open (default about:blank)' }, headless: { type: 'boolean', desc: 'Run without a visible window' } },
  async run(ctx) {
    const r = await launchChrome({ profileDir: ctx.paths.chromeProfile, port: ctx.port, url: ctx.flags.url ?? 'about:blank', headless: !!ctx.flags.headless });
    ctx.out.emit(r, (o) => o.result(r.alreadyRunning ? `Capture browser already running (${r.browser}) on port ${ctx.port}.` : `Capture browser opened (${r.browser}). Sign in to the sites you want to capture in this window.`));
  },
});

define({
  name: 'targets', section: 'Capture', usage: '[--filter TEXT]', summary: 'List tabs in the capture browser that can be recorded',
  flags: { filter: { type: 'string', alias: 'f', valueName: 'TEXT', desc: 'Only tabs whose title or URL contains TEXT' } },
  async run(ctx) {
    let ts;
    try {
      await verifyBrowserOwner({ profileDir: ctx.paths.chromeProfile, port: ctx.port });
      ts = await listTargets({ port: ctx.port });
    } catch (e) { throw envError(`Capture browser not available or not verified: ${e.message}`, 'Use "studio start" with the dedicated VIVIM profile.'); }
    if (ctx.flags.filter) { const f = ctx.flags.filter.toLowerCase(); ts = ts.filter((t) => t.url.toLowerCase().includes(f) || (t.title ?? '').toLowerCase().includes(f)); }
    const rows = ts.map((t, i) => ({ index: i, id: t.id, title: t.title, url: t.url }));
    ctx.out.emit(rows, (o) => {
      if (!rows.length) { o.line('No tabs open.'); return; }
      for (const r of rows) o.result(`${String(r.index).padStart(2)}  ${r.id.slice(0, 8)}  ${r.title}\n      ${r.url}`);
    });
  },
});

const studioFlags = {
  'studio-port': { type: 'number', valueName: 'N', desc: 'Port for the studio UI (default 7878)' },
  'no-open': { type: 'boolean', desc: 'Do not open the studio in a browser window' },
  url: { type: 'string', valueName: 'URL', desc: 'Page to open in the capture browser (start only)' },
  'lan-pair': { type: 'boolean', desc: 'OPT-IN: listen on the WiFi/LAN (0.0.0.0) so a phone can open the mobile surface; token required, prints a pairing URL + QR' },
  'lan-host': { type: 'string', valueName: 'IP', desc: 'With --lan-pair: which of this PC\'s IPv4 addresses to put in the pairing URL (default: best guess)' },
};

async function runStudio(ctx, { launch }) {
  const { out, flags } = ctx;
  const lanPair = !!flags['lan-pair'] || process.env.CAPTURE_STUDIO_LAN_PAIR === '1';
  if (flags['lan-host'] && !lanPair) throw usageError('--lan-host only applies together with --lan-pair.');
  // One Studio per CDP port, machine-wide. Taken BEFORE any browser launch so a non-owner can never
  // relaunch or fight over the owner's Chrome.
  const studioPort = Number(flags['studio-port'] ?? ctx.settings.studioPort);
  let cdpLock;
  try { cdpLock = await acquireCdpOwnerLock({ root: ctx.paths.root, cdpPort: ctx.port, studioPort }); }
  catch (e) {
    if (e.code === 'CDP_OWNED') throw envError(e.message, `Only one VIVIM can use the browser at a time. ${e.owner.url ? `Open ${e.owner.url}` : 'Use the VIVIM window that is already open'}, or close it (process ${e.owner.pid}) and try again.`);
    throw envError(e.message, 'Check that the VIVIM data folder is writable, then try again.');
  }
  if (launch) {
    // Always validate the ownership marker, even when the CDP port is already listening.
    let r;
    try { r = await launchChrome({ profileDir: ctx.paths.chromeProfile, port: ctx.port, url: flags.url ?? 'about:blank' }); }
    catch (e) { cdpLock.release(); throw e; }
    if (!r.alreadyRunning) out.info(`Capture browser opened (${r.browser}).`);
  }
  // LAN pairing forces token mode. The token is the one stored in the data folder, so phones stay
  // paired across restarts; CAPTURE_STUDIO_TOKEN still overrides it.
  const lanOptions = lanPair ? { lanPair: true, accessMode: 'token', lanHost: flags['lan-host'], ...(process.env.CAPTURE_STUDIO_TOKEN ? { token: process.env.CAPTURE_STUDIO_TOKEN } : {}) } : { lanPair: false };
  let st;
  try { st = await startStudio({ paths: ctx.paths, profileStore: ctx.profiles(), familyStore: ctx.families(), cdpPort: ctx.port, port: Number(flags['studio-port'] ?? ctx.settings.studioPort), ...lanOptions }); }
  catch (e) { cdpLock.release(); if (lanPair && /LAN pairing|--lan-host/.test(e.message)) throw envError(e.message, 'Check the network connection, or drop --lan-pair to stay loopback-only.'); throw e; }
  cdpLock.update(st.port); // the real listening port is what a second Studio probes and names
  out.emit({ url: st.url, port: st.port, ...(st.lan ? { lanPair: true, pairingUrl: st.pairingUrl, lanAddresses: st.lan.addresses } : {}) }, (o) => {
    o.result(`Capture Studio is running at\n  ${st.url}\nKeep this window open. Press Ctrl+C to stop (an active recording is saved first).`);
    if (!st.lan) return;
    o.result('');
    o.result(`LAN pairing is ON (listening on 0.0.0.0:${st.port}, token required). On your phone, joined to the same WiFi, scan this QR code or open:`);
    o.result(`  ${st.pairingUrl}`);
    if (process.stdout.isTTY) { try { o.result(`\n${qrToTerminal(st.pairingUrl)}\n`); } catch { /* the URL above is enough */ } }
    if (st.lan.addresses.length > 1) o.result(`Other addresses of this PC: ${st.lan.addresses.filter((a) => a !== st.lan.address).join(', ')} (use --lan-host IP if the phone cannot reach ${st.lan.address}).`);
    o.result('Anyone with this URL can control this Studio while it runs; do not share it. Allow the firewall prompt for private networks only.');
  });
  // Keep the desktop window on loopback even when the phone gets the LAN URL.
  if (!flags['no-open']) openUrl(st.url);
  // SIGTERM is the normal Linux service/container stop signal; IPC stop is used
  // by Windows supervisors. Both must close the same sole Studio runtime once.
  let shutdown = null;
  const closeStudio = () => {
    shutdown ??= (async () => {
      try { await st.close(); cdpLock.release(); process.exit(0); }
      catch (error) {
        cdpLock.release();
        console.error('Studio shutdown failed:', error);
        process.exit(1);
      }
    })();
  };
  process.once('SIGINT', closeStudio);
  process.once('SIGTERM', closeStudio);
}

define({ name: 'start', section: 'Get started', summary: 'Open the capture browser and the studio UI (first-run friendly)', flags: studioFlags, async run(ctx) { await runStudio(ctx, { launch: true }); } });
define({ name: 'serve', section: 'Get started', summary: 'Run the studio UI only', flags: studioFlags, async run(ctx) { await runStudio(ctx, { launch: false }); } });

// ---------------------------------------------------------------------------------------------
// Phone pairing: the link/QR the owner asks for, and "remove access from all phones".
// The token lives in <data root>/pairing.json, so a restart keeps every paired phone working.
// ---------------------------------------------------------------------------------------------
const pairFlags = {
  'studio-port': { type: 'number', valueName: 'N', desc: 'Studio port to check (default: the running VIVIM, else the usual studio port)' },
  'lan-host': { type: 'string', valueName: 'IP', desc: 'Which of this PC\'s IPv4 addresses to put in the link (default: best guess)' },
};

function runningStudioPort(ctx) {
  try {
    const lock = JSON.parse(readFileSync(lockPath(ctx.paths.root, ctx.port), 'utf8'));
    if (lock && Number.isSafeInteger(lock.studioPort) && lock.studioPort > 0) return lock.studioPort;
  } catch { /* no Studio owns the browser right now */ }
  return null;
}

// Ask the machine's own LAN address, so "phone reachable" is the real check: a loopback-only
// Studio refuses that connection and this reports not-ready instead of printing a dead link.
async function lanStudioProbe(address, port, token) {
  try {
    const res = await fetch(`http://${address}:${port}/api/v1/health`, { headers: { 'x-studio-token': token }, signal: AbortSignal.timeout(2000) });
    if (res.status === 401) return { state: 'locked' };
    if (!res.ok) return { state: 'other', status: res.status };
    const body = await res.json();
    return body?.apiVersion === 1 ? { state: 'ok' } : { state: 'other', status: res.status };
  } catch { return { state: 'none' }; }
}

function pairingTarget(ctx) {
  const addresses = lanAddresses();
  const chosen = pickLanAddress(addresses, ctx.flags['lan-host']);
  if (!chosen) throw envError('This PC has no WiFi or network address yet.', 'Connect this PC to the same WiFi as your phone, then run the command again.');
  const port = runningStudioPort(ctx) ?? Number(ctx.flags['studio-port'] ?? ctx.settings.studioPort);
  return { address: chosen.address, port, others: addresses.filter((a) => a.address !== chosen.address).map((a) => a.address) };
}

function printPairing(out, { link, others, address }) {
  out.result('');
  out.result('On your phone, joined to the same WiFi, scan this code or open:');
  out.result(`  ${link}`);
  if (process.stdout.isTTY) { try { out.result(`\n${qrToTerminal(link)}\n`); } catch { /* the link above is enough */ } }
  if (others.length) out.result(`Other addresses of this PC: ${others.join(', ')} (use --lan-host IP if the phone cannot reach ${address}).`);
  out.result('Anyone with this link can use your VIVIM while it runs. Do not share it.');
}

defineGroup('pair', { section: 'Get started', default: 'show', summary: 'Show the phone pairing link, or remove access from all phones' });

define({
  name: 'pair show', section: 'Get started', summary: 'Show the phone link and QR code (phones stay paired after a restart)',
  description: 'Prints the pairing link for the running phone-paired VIVIM. The pairing token is kept in this data folder, so restarting VIVIM does not un-pair your phone.',
  flags: pairFlags,
  async run(ctx) {
    const { out } = ctx;
    const stored = ensurePairingToken(ctx.paths.root);
    const target = pairingTarget(ctx);
    const link = pairingUrl({ address: target.address, port: target.port, token: stored.token });
    const probe = await lanStudioProbe(target.address, target.port, stored.token);
    out.emit({ pairingUrl: link, address: target.address, port: target.port, reachable: probe.state === 'ok' }, (o) => {
      if (probe.state === 'ok') { o.result(`Phone pairing is on (VIVIM is running on port ${target.port}).`); printPairing(o, { link, others: target.others, address: target.address }); return; }
      o.result('Phone pairing is not running right now, so this link will not work yet.');
      o.result('Start it with:');
      o.result(`  node bin/studio.mjs serve --lan-pair --studio-port ${target.port}`);
      o.result('or open "VIVIM phone pairing" on Windows. Once it is running, scan this code:');
      printPairing(o, { link, others: target.others, address: target.address });
    });
  },
});

define({
  name: 'pair reset', section: 'Get started', summary: 'Remove access from all phones (a new code is needed to pair again)',
  description: 'Rotates the stored pairing token. Every phone that was paired stops working and shows the pairing screen; scan the new link to pair a phone again. A running VIVIM picks up the new token by itself.',
  flags: pairFlags,
  async run(ctx) {
    const { out } = ctx;
    const rotated = resetPairingToken(ctx.paths.root);
    if (process.env.CAPTURE_STUDIO_TOKEN) out.warn('CAPTURE_STUDIO_TOKEN is set on this PC and overrides the stored code; remove it so the new code is used.');
    const target = pairingTarget(ctx);
    const link = pairingUrl({ address: target.address, port: target.port, token: rotated.token });
    const probe = await lanStudioProbe(target.address, target.port, rotated.token);
    out.emit({ rotated: true, pairingUrl: link, address: target.address, port: target.port, pickedUp: probe.state === 'ok' }, (o) => {
      o.result('Access was removed from all phones. Any phone that was paired now shows the pairing screen.');
      if (probe.state === 'ok') o.result('This running VIVIM already uses the new code; nothing to restart.');
      else if (probe.state === 'locked') o.result('Restart VIVIM to finish removing access.');
      o.result('To pair a phone again, scan this new code:');
      printPairing(o, { link, others: target.others, address: target.address });
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Recording engine shared by `record` and `capture`
// ---------------------------------------------------------------------------------------------
const NET_KINDS = new Set(['req', 'res', 'chunk', 'body', 'es.msg', 'ws.frame', 'ws.open', 'done', 'fail']);
const EXPORT_KINDS = ['transcript', 'report', 'knowledge', 'schemas', 'graph-ranked', 'bundle'];

const recordFlags = {
  live: { type: 'boolean', desc: 'Print live decoded text/events (with --json: NDJSON events followed by a result row)' },
  events: { type: 'boolean', desc: 'With --live, print protocol events instead of text' },
  kinds: { type: 'list', valueName: 'KINDS', desc: 'Filter live tap raw record kinds (comma-separated)' },
  tabs: { type: 'string', choices: ['all', 'one'], default: 'one', desc: 'Record one selected tab or all tabs' },
  follow: { type: 'boolean', desc: 'Follow newly opened tabs/targets while recording' },
  target: { type: 'string', alias: 't', valueName: 'TAB', desc: 'Tab to record: index, id prefix, or URL/title text (see "studio targets")' },
  profile: { type: 'string', alias: 'p', valueName: 'NAME', desc: 'Force a profile (default: best match for the tab URL)' },
  label: { type: 'string', alias: 'l', valueName: 'TEXT', desc: 'Label for the session id' },
  duration: { type: 'number', valueName: 'SECONDS', desc: 'Stop after this many seconds' },
  idle: { type: 'number', valueName: 'SECONDS', desc: 'Stop after this many seconds without network activity' },
  timeout: { type: 'number', valueName: 'SECONDS', desc: 'Hard upper bound on recording time' },
  'max-mb': { type: 'number', valueName: 'MB', desc: 'Stop cleanly when raw data reaches this size' },
  'all-bodies': { type: 'boolean', desc: 'Capture bodies of every in-scope resource type, not only API-like ones' },
  derive: { type: 'boolean', desc: 'Derive datasets and knowledge after stopping (--no-derive to skip)' },
  export: { type: 'list', valueName: 'KINDS', desc: `After deriving, write ${EXPORT_KINDS.join(', ')} (comma-separated)` },
  'out-dir': { type: 'string', valueName: 'DIR', desc: 'Where --export writes (default <data-dir>/exports/<session>)' },
};

function summarizeRecording(stop, derived, exportsWritten) {
  const r = derived?.receipt;
  return {
    id: stop.id, dir: stop.dir, endReason: stop.reason, integrityOk: stop.verify.ok,
    rawRecords: stop.verify.records, gapRecords: stop.verify.gapRecords, droppedRecords: stop.verify.droppedRecords,
    ...(r ? {
      verdict: r.verdict, transport: r.actual_response_transport, chunks: r.raw_chunks_received, bytes: r.raw_bytes_received,
      suggestions: derived.report.suggestions.length, knowledge: derived.knowledge ?? null,
    } : { derived: false }),
    exports: exportsWritten,
  };
}

async function writeExports(ctx, session, kinds, outDirFlag) {
  const dir = path.resolve(outDirFlag ?? path.join(ctx.paths.exports, session.id));
  const written = [];
  for (const kind of kinds) {
    if (!EXPORT_KINDS.includes(kind)) throw usageError(`Unknown export "${kind}" (${EXPORT_KINDS.join('|')}).`);
    try {
      if (kind === 'transcript') written.push((await exportTranscript(session, path.join(dir, 'transcript.md'), { format: 'md' })).file);
      else if (kind === 'report') written.push((await exportReport(session, path.join(dir, 'report.html'))).file);
      else if (kind === 'knowledge') written.push((await exportKnowledge(session, path.join(dir, 'knowledge.json'), { format: 'json' })).file);
      else if (kind === 'schemas') written.push((await exportSchemas(session, path.join(dir, 'schemas.json'))).file);
      else if (kind === 'graph-ranked') written.push((await exportGraphRanked(session, path.join(dir, 'graph-ranked.json'))).file);
      else written.push((await exportBundle(session, path.join(dir, 'bundle'), {})).dir);
    } catch (e) { ctx.out.warn(`export ${kind}: ${e.message}`); }
  }
  return written;
}

async function runRecording(ctx, o) {
  const { out } = ctx;
  const maxMb = o.maxMb ?? ctx.settings.maxMb;
  const liveModule = o.live ? await capability('../../src/capture/live-tap.mjs', ['createLiveTap'], 'Live capture decoding') : null;
  await verifyBrowserOwner({ profileDir: ctx.paths.chromeProfile, port: ctx.port });
  const rec = new Recorder({ sessionsDir: ctx.paths.sessions, profileStore: ctx.profiles(), familyStore: ctx.families(), port: ctx.port, tabs: o.tabs, follow: !!o.follow, allBodies: !!o.allBodies, maxSessionBytes: Number(maxMb) * 1048576, learner: ctx.learner() });
  rec.on('warn', (e) => out.warn(e.message ?? e));
  const tap = liveModule ? await liveModule.createLiveTap(rec, { kinds: o.kinds, decode: true }) : null;
  const liveListeners = [];
  if (tap) for (const kind of ['record', 'stream-open', 'event', 'text', 'stream-close', 'target']) {
    const listener = (data) => {
      if (out.json) { out.ndjson([{ kind, data }]); return; }
      if (kind === 'record') return;
      if (kind === 'text' && !o.events) {
        const text = typeof data === 'string' ? data : data?.delta ?? data?.text ?? data?.value;
        if (text !== undefined) out.result(`[${data?.sid ?? 'live'}] ${String(text)}`);
      } else if (kind === 'event' && o.events) out.result(JSON.stringify(data));
      else if (kind !== 'text' && kind !== 'event') out.info(`[${kind}] ${JSON.stringify(data)}`);
    };
    tap.on(kind, listener); liveListeners.push([kind, listener]);
  }
  const cleanupTap = () => {
    for (const [kind, listener] of liveListeners) tap?.off?.(kind, listener);
    if (typeof tap?.close === 'function') tap.close();
    else tap?.dispose?.();
  };
  const profile = o.profile ?? ctx.settings.defaultProfile ?? undefined;
  let session;
  try { session = await rec.start({ target: o.target, profile, label: o.label, tabs: o.tabs, follow: !!o.follow }); }
  catch (error) { cleanupTap(); throw error; }
  out.info(`Recording ${session.meta.target.title || session.meta.target.url} -> session ${session.id}`);
  out.info(`Profile ${session.meta.profile.name}@v${session.meta.profile.version}. Press Ctrl+C to stop and save.`);

  let lastNet = Date.now();
  rec.on('record', (r) => { if (NET_KINDS.has(r.k)) lastNet = Date.now(); });
  if (o.reload) { try { await rec.reloadPage(); out.info('Reloaded the page so connections opened during load are observed.'); } catch (e) { out.warn(`reload failed: ${e.message}`); } }

  try { return await new Promise((resolve, reject) => {
    let done = false, sigints = 0;
    const timers = [];
    const onSignal = () => { if (++sigints > 1) process.exit(130); stopNow('user_stop'); };
    const clearAll = () => { timers.forEach(clearInterval); timers.forEach(clearTimeout); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); out.progressDone(); };
    const finalize = async (stop) => {
      try {
        let derived = null;
        if (o.derive) {
          const s = Session.open(ctx.paths.sessions, stop.id);
          derived = await derive(s, ctx.profileFor(s, profile), { families: ctx.families(), learner: ctx.learner() });
        }
        const exportsWritten = o.exports?.length ? await writeExports(ctx, Session.open(ctx.paths.sessions, stop.id), o.exports, o.outDir) : [];
        resolve(summarizeRecording(stop, derived, exportsWritten));
      } catch (e) { reject(e); }
    };
    const stopNow = async (reason) => {
      if (done) return;
      done = true; clearAll();
      try { const stop = await rec.stop({ reason }); if (!stop) return reject(new CliError('Recorder was not recording.')); await finalize(stop); } catch (e) { reject(e); }
    };
    rec.on('stopped', (stop) => { if (done) return; done = true; clearAll(); out.info(`Recording ended: ${stop.reason}`); finalize(stop); });

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    timers.push(setInterval(() => {
      const st = rec.status(); if (st.state !== 'recording') return;
      const n = st.stats.network;
      if (!o.live) out.progress(`${n.requests} requests, ${n.streamed} streamed, ${fmtBytes(n.bytes)} received, ${st.openStreams} open, ${st.stats.dom.mutations} page changes, ${st.stats.raw.gaps} gaps   `);
      if (o.idle && st.openStreams === 0 && Date.now() - lastNet > o.idle * 1000) stopNow('idle');
    }, 1000));
    if (o.duration) timers.push(setTimeout(() => stopNow('duration'), o.duration * 1000));
    if (o.timeout) timers.push(setTimeout(() => stopNow('timeout'), o.timeout * 1000));
  }); } finally { cleanupTap(); }
}

function printRecordingSummary(o, s) {
  o.result('');
  o.result(`Saved ${s.id} (${s.endReason}); integrity ${s.integrityOk ? 'verified' : 'WARNINGS — run "studio verify ' + s.id + '"'}.`);
  if (s.verdict) {
    o.result(`Verdict ${s.verdict}: ${s.transport}, ${s.chunks} chunks, ${fmtBytes(s.bytes)}, ${s.gapRecords} gaps.`);
    if (s.knowledge) o.result(s.knowledge.error ? `Knowledge derivation failed at ${s.knowledge.stage}: ${s.knowledge.error}` : `Knowledge: ${s.knowledge.types} type(s), ${s.knowledge.entities} entit${s.knowledge.entities === 1 ? 'y' : 'ies'}, ${s.knowledge.edges} edge(s).`);
    o.result(`${s.suggestions} suggestion(s). Review: "studio shapes ${s.id}" or "studio serve".`);
  } else o.result(`Not derived. Run "studio derive ${s.id}".`);
  for (const f of s.exports) o.result(`Exported ${f}`);
}

const optsFromFlags = (ctx, extra = {}) => ({
  target: ctx.flags.target, profile: ctx.flags.profile, label: ctx.flags.label, duration: ctx.flags.duration, idle: ctx.flags.idle, timeout: ctx.flags.timeout,
  maxMb: ctx.flags['max-mb'], allBodies: ctx.flags['all-bodies'], derive: ctx.flags.derive ?? ctx.settings.autoDerive,
  live: ctx.flags.live, events: ctx.flags.events, kinds: ctx.flags.kinds, tabs: ctx.flags.tabs, follow: ctx.flags.follow,
  exports: ctx.flags.export, outDir: ctx.flags['out-dir'], ...extra,
});

define({
   name: 'record', section: 'Capture', usage: '[--target TAB] [--duration S] [--live --tabs all --follow]', summary: 'Record tabs from the terminal; Ctrl+C stops, saves and derives',
  description: 'Attaches to a tab that is already open in the capture browser. Read-only: observes network, streams and rendered DOM; never intercepts or modifies traffic.',
  flags: recordFlags, forceExit: true,
  examples: ['studio record --target claude.ai --duration 60', 'studio record --target 0 --idle 8 --export report,knowledge', 'studio record --json --duration 30 > result.json'],
  async run(ctx) {
    const s = await runRecording(ctx, optsFromFlags(ctx));
    if (ctx.flags.live && ctx.out.json) { ctx.out.ndjson([{ kind: 'result', data: s }]); return; }
    ctx.out.emit(s, (o) => printRecordingSummary(o, s));
  },
});

// ---------------------------------------------------------------------------------------------
function normalizeUrl(raw) {
  let u = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `${/^(localhost|127\.|\[::1\])/i.test(u) ? 'http' : 'https'}://${u}`;
  let parsed;
  try { parsed = new URL(u); } catch { throw usageError(`"${raw}" is not a valid URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw usageError(`Only http(s) pages can be captured (got ${parsed.protocol}).`);
  return parsed.toString();
}

async function openTab(port, url) {
  const base = endpointBase({ port });
  const target = `${base}/json/new?${encodeURI(url)}`;
  let res = await fetch(target, { method: 'PUT' });
  if (res.status === 405) res = await fetch(target); // older Chrome only accepts GET
  if (!res.ok) throw new CliError(`Could not open a tab in the capture browser (HTTP ${res.status}).`, { exit: 5, code: 'NO_TAB' });
  return res.json();
}

define({
  name: 'capture', section: 'Capture', usage: '<url...>', summary: 'One shot: open the page, record until idle, derive and export',
  description: 'Starts the capture browser if needed, opens each URL in a new tab, records until the network goes quiet (default --idle 5, --timeout 120), derives datasets and knowledge, and optionally exports. The page is reloaded once after attaching (--no-reload to skip) so connections opened during load are observed. Sites that need a login: run "studio launch", sign in once, then capture.',
  flags: { ...recordFlags, reload: { type: 'boolean', desc: 'Reload after attaching (default on; --no-reload to skip)' }, wait: { type: 'number', valueName: 'SECONDS', default: 10, desc: 'How long to wait for the page to appear' }, settle: { type: 'number', valueName: 'MS', default: 1500, desc: 'Pause after the tab loads before attaching' }, 'no-launch': { type: 'boolean', desc: 'Fail instead of starting the capture browser' } },
  forceExit: true,
  examples: ['studio capture https://example.com', 'studio capture example.com --duration 20 --export report,transcript', 'studio capture a.com b.com --idle 8 --json'],
  async run(ctx) {
    const { out, flags } = ctx;
    if (!ctx.args.length) throw usageError('Usage: studio capture <url...>', 'Example: studio capture https://example.com --export report');
    if (flags.live) await capability('../../src/capture/live-tap.mjs', ['createLiveTap'], 'Live capture decoding');
    const urls = ctx.args.map(normalizeUrl);
    if (flags['no-launch'] && !(await isReachable({ port: ctx.port })))
      throw envError(`No capture browser on port ${ctx.port}.`, 'Run "studio start".');
    // One-command capture, but never reuse another browser simply because the port is reachable.
    const r = await launchChrome({ profileDir: ctx.paths.chromeProfile, port: ctx.port, url: 'about:blank' });
    if (!r.alreadyRunning) out.info(`Capture browser opened (${r.browser}).`);
    const results = [];
    for (const url of urls) {
      out.info(`Opening ${url}`);
      const tab = await openTab(ctx.port, url);
      const deadline = Date.now() + (flags.wait ?? 10) * 1000;
      for (;;) {
        const t = (await listTargets({ port: ctx.port })).find((x) => x.id === tab.id);
        if (t && t.url !== 'about:blank' && (t.title ?? '') !== '') break;
        if (Date.now() > deadline) { out.warn('page did not finish loading in time; recording anyway.'); break; }
        await sleep(250);
      }
      await sleep(flags.settle ?? 1500);
      const opts = optsFromFlags(ctx, { target: tab.id, reload: flags.reload !== false });
      if (!opts.duration && !opts.idle) opts.idle = 5;
      if (!opts.timeout) opts.timeout = opts.duration ? undefined : 120;
      results.push(await runRecording(ctx, opts));
      if (urls.length > 1) await sleep(500);
    }
    if (flags.live && out.json) out.ndjson([{ kind: 'result', data: results.length === 1 ? results[0] : results }]);
    else ctx.out.emit(results.length === 1 ? results[0] : results, (o) => results.forEach((s) => printRecordingSummary(o, s)));
  },
});
