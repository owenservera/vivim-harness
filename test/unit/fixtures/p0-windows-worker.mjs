// Child-process driver for test/unit/p0-windows-probes.test.mjs (issue #81 P0).
// It exercises the REAL production owner (src/store/versioned.mjs and its factory / I1 callers); there is no
// copied lock or CAS logic here. Only the `io` seam is used (documented in the owner) to pause or count calls.
// Protocol: JSON lines on stdout (one event per line); all handshakes with the parent are plain files so no
// synchronous stdin reads are needed:  <ackDir>/go.json (barrier start), <ackDir>/ack-<n> (checkpoint release).
//   node p0-windows-worker.mjs <mode> '<json config>'
// modes: hold | race | loop | ops
import fs from 'node:fs';
import path from 'node:path';
import { VersionedStore } from '../../../src/store/versioned.mjs';
import { createCasVersionedStore } from '../../../src/studio/adapter-learning-pipeline.mjs';
import { createAdapterFactory } from '../../../src/studio/adapter-factory-service.mjs';

const [, , mode, cfgJson] = process.argv;
const cfg = JSON.parse(cfgJson ?? '{}');
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepCell, 0, 0, ms);
const out = (o) => {
  const line = `${JSON.stringify({ pid: process.pid, ...o })}\n`;
  for (let i = 0; ; i++) { try { fs.writeSync(1, line); return; } catch (e) { if (e.code !== 'EAGAIN' || i > 2000) throw e; sleep(2); } }
};
const ro = (n) => ({ schema: 'aion.learned-read-adapter/1', adapter: { n }, readFeatures: [], sendPermission: false });
const classify = (e) => ({ ok: false, code: e?.code ?? 'UNCODED', message: String(e?.message ?? e).slice(0, 120), expected: e?.expected, actual: e?.actual });

// descriptor accounting through the owner's own io seam (supports, never replaces, the OS handle count)
function trackedIo(extra = {}) {
  const open = new Set(); const c = { opens: 0, closes: 0 };
  const io = {
    openSync(p, flags, mode2) { const fd = fs.openSync(p, flags, mode2); open.add(fd); c.opens++; return fd; },
    closeSync(fd) { try { fs.closeSync(fd); } finally { open.delete(fd); c.closes++; } },
    ...extra,
  };
  return { io, snapshot: () => ({ opens: c.opens, closes: c.closes, openNow: open.size }) };
}

function barrier() {
  out({ event: 'ready' });
  const go = path.join(cfg.ackDir, 'go.json');
  while (!fs.existsSync(go)) sleep(2);
  let startAt = 0;
  for (let i = 0; i < 50 && !startAt; i++) { try { startAt = JSON.parse(fs.readFileSync(go, 'utf8')).startAt; } catch { sleep(2); } }
  while (Date.now() < startAt) sleep(1);
}

// ---- shared fixture for the factory entry (small synthetic saved sessions, no browser, no provider)
const ORIGIN = 'https://127.0.0.1:8443';
function fakeSession(id) {
  const url = `${ORIGIN}/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b`;
  const turns = [
    { index: 0, domId: 'div.bubble[data-role=user]', role: 'user', roleAttribute: 'data-role', text: 'prompt text' },
    { index: 1, domId: 'div.bubble[data-role=assistant]', role: 'assistant', roleAttribute: 'data-role', text: 'reply text' },
  ];
  const kv = new Map(Object.entries({ DOM_TURNS: turns, ASSEMBLED: { a: { endpoint: 'POST /api/chat' } }, RECEIPT: { pageUrl: url } }));
  return { id, kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }, meta: { target: { url } } };
}

const store = (extra = {}) => new VersionedStore(cfg.dir, { kind: 'learned adapter', lockWaitMs: cfg.lockWaitMs ?? 500, ...extra });

// ------------------------------------------------------------------------------------------------ hold
// Takes the REAL lock through a real compareAndSave, then blocks inside the critical section (after the lock
// file was written, fsynced and closed, and after the version file was written) so the parent can kill the process.
if (mode === 'hold') {
  const tracked = trackedIo({
    renameSync(a, b) {
      if (/CURRENT\.[0-9a-f]+\.tmp$/.test(String(a))) {
        out({ event: 'holding', lockPath: s.lockPath(cfg.name), fd: tracked.snapshot() });
        for (;;) sleep(1000);
      }
      return fs.renameSync(a, b);
    },
  });
  var s = store({ io: tracked.io });
  try { s.compareAndSave(cfg.name, { held: true }, { expectedVersion: null }); out({ event: 'unexpected-completion' }); }
  catch (e) { out({ event: 'hold-error', ...classify(e) }); }
}

// ------------------------------------------------------------------------------------------------ race
// One barrier-started attempt through ONE entry path: store (compareAndSave null) | factory | i1.
if (mode === 'race') {
  const tracked = trackedIo();
  const s = store({ io: tracked.io });
  let attempt;
  if (cfg.entry === 'factory') {
    const factory = createAdapterFactory({ learnedStore: s });
    const { candidate } = factory.synthesize({ siteId: cfg.name, origin: ORIGIN, sessions: [fakeSession('t1'), fakeSession('t2'), fakeSession('t3')] });
    attempt = () => { const r = factory.promote({ candidate, sessions: [fakeSession('h1')], expectedVersion: null }); return { ok: true, version: r.version }; };
  } else if (cfg.entry === 'i1') {
    const cas = createCasVersionedStore({ store: s });
    attempt = null;
    barrier();
    const t0 = Date.now();
    let res;
    try { const r = await cas.promote(cfg.scope, ro(cfg.id), null); res = { ok: true, version: r.version }; } catch (e) { res = classify(e); }
    out({ event: 'result', id: cfg.id, entry: 'i1', ms: Date.now() - t0, ...res, fd: tracked.snapshot() });
    process.exit(0);
  } else {
    attempt = () => { const r = s.compareAndSave(cfg.name, { id: cfg.id }, { expectedVersion: null }); return { ok: true, version: r.version }; };
  }
  barrier();
  const t0 = Date.now();
  let res;
  try { res = attempt(); } catch (e) { res = classify(e); }
  out({ event: 'result', id: cfg.id, entry: cfg.entry, ms: Date.now() - t0, ...res, fd: tracked.snapshot() });
}

// ------------------------------------------------------------------------------------------------ loop
// Lower-level cross-entry contention on ONE name: `save` (legacy append) and `cas` (read CURRENT, then compareAndSave).
if (mode === 'loop') {
  const tracked = trackedIo();
  const s = store({ io: tracked.io });
  barrier();
  const counts = { ok: 0, conflict: 0, locked: 0, other: 0 }; const others = {}; const written = [];
  for (let i = 0; i < cfg.iterations; i++) {
    try {
      let rec;
      if (cfg.entry === 'save') rec = s.save(cfg.name, { w: cfg.id, i });
      else { const cur = s.current(cfg.name); rec = s.compareAndSave(cfg.name, { w: cfg.id, i }, { expectedVersion: cur }); }
      counts.ok++; written.push({ w: cfg.id, i, version: rec.version });
    } catch (e) {
      if (e.code === 'CAS_VERSION_CONFLICT') counts.conflict++;
      else if (e.code === 'CAS_LOCKED') counts.locked++;
      else { counts.other++; others[e.code ?? e.message.slice(0, 40)] = (others[e.code ?? e.message.slice(0, 40)] ?? 0) + 1; }
    }
  }
  out({ event: 'result', id: cfg.id, entry: cfg.entry, counts, others, written, fd: tracked.snapshot() });
}

// ------------------------------------------------------------------------------------------------ ops
// `total` COMMITTED mutations (never conflicts) alternating the direct owner API and the I1 wrapper, with checkpoints
// at which the parent samples the OS handle count for THIS pid before releasing the worker via an ack file.
if (mode === 'ops') {
  const tracked = trackedIo();
  const s = store({ io: tracked.io, lockWaitMs: 2000 });
  const cas = createCasVersionedStore({ store: s });
  let directCur = null; let scopeCur = null; let committed = 0;
  const lockCount = () => { try { return fs.readdirSync(path.join(cfg.dir, '.locks')).length; } catch { return 0; } };
  const checkpoint = (n) => {
    out({ event: 'checkpoint', n, committed, fd: tracked.snapshot(), locks: lockCount() });
    const ack = path.join(cfg.ackDir, `ack-${n}`);
    while (!fs.existsSync(ack)) sleep(5);
  };
  const t0 = Date.now();
  for (let i = 1; i <= cfg.total; i++) {
    if (i % 2 === 0) {
      const rec = (i % 8 === 0 && directCur >= 1) ? s.compareAndRollback('handles', 1, { expectedVersion: directCur }) : s.compareAndSave('handles', { i }, { expectedVersion: directCur });
      directCur = rec.version;
    } else {
      const r = (i % 8 === 1 && scopeCur >= 1) ? await cas.rollback('scope-handles', 1, scopeCur) : await cas.promote('scope-handles', ro(i), scopeCur);
      scopeCur = r.version;
    }
    committed++;
    if (i === cfg.warmup || (i > cfg.warmup && (i - cfg.warmup) % cfg.checkpointEvery === 0) || i === cfg.total) checkpoint(i);
  }
  const names = s.names();
  out({ event: 'done', committed, ms: Date.now() - t0, directCurrent: s.current('handles'), directVersions: s.versions('handles').length,
    names, scopeVersions: names.filter((n) => n.startsWith('i1-')).map((n) => s.versions(n).length), fd: tracked.snapshot(), locks: lockCount() });
}
