// Optional /api/x routes. Loopback, Host, Origin, and token checks stay in the studio server.
import { Session } from '../store/session.mjs';
import { problem, json, integer, storageName } from './http.mjs';

const MB = 1024 * 1024;

export async function handlePlatformX(req, res, ctx, url) {
  if (url.pathname !== '/api/x' && !url.pathname.startsWith('/api/x/')) return false;
  let parts;
  try { parts = url.pathname.replace(/\/+$/, '').split('/').map(decodeURIComponent); }
  catch { json(res, 400, { error: 'Malformed path encoding' }); return true; }
  const route = match(parts[3], parts.slice(4));
  if (!route) return false;
  if (req.method !== route.method) {
    res.setHeader('allow', route.method);
    json(res, 405, { error: `${route.method} required` });
    return true;
  }
  try {
    if (route.bench) {
      let mod;
      try { mod = await import('../intel/bench.mjs'); }
      catch (e) { json(res, 501, { error: `bench unavailable: ${String(e?.message ?? e)}` }); return true; }
      const data = await mod.runBench();
      if (!res.headersSent) json(res, 200, data);
      return true;
    }
    const data = await route.run(req, ctx, url);
    if (!res.headersSent) json(res, 200, data);
  } catch (e) {
    if (res.headersSent) res.destroy();
    else json(res, e.status ?? 500, { error: String(e.message ?? e) });
  }
  return true;
}

function match(head, rest) {
  if (rest.length) return sessionRoute(head, rest);
  if (head === 'stats') return { method: 'GET', run: (_req, ctx) => call('platformStats', (fn) => fn({ settings: ctx.settings, dataDir: ctx.dataDir })) };
  if (head === 'registry') return { method: 'GET', run: () => call('registrySnapshot', (fn) => fn()) };
  if (head === 'autodetect') return { method: 'POST', run: (req) => call('detectAndScan', async (fn) => fn(await textBody(req))) };
  if (head === 'csv') return { method: 'POST', run: (req) => call('csvAnalyze', async (fn) => fn(await textBody(req))) };
  if (head === 'bench') return { method: 'GET', bench: true, run: () => {} };
  return null;
}

function sessionRoute(head, rest) {
  if (rest.length !== 1) return null;
  const id = rest[0];
  if (head === 'graph') return { method: 'GET', run: (_req, ctx) => call('analyzeSessionGraph', (fn) => fn(openSession(ctx, id))) };
  if (head === 'dedupe') return { method: 'GET', run: (_req, ctx, url) => call('dedupeSession', (fn) => fn(openSession(ctx, id), dedupeOpts(url))) };
  if (head === 'keyphrases') return { method: 'GET', run: (_req, ctx, url) => call('keyphrasesSession', async (fn) => ({ keyphrases: await fn(openSession(ctx, id), { limit: integer(Object.fromEntries(url.searchParams).limit, 20, 1000, 1) }) })) };
  return null;
}

function openSession(ctx, id) {
  storageName(id, 'session');
  try { return Session.open(ctx.sessionsDir, id); }
  catch (e) {
    if (/matches \d+ sessions/.test(e.message)) throw problem(409, e.message, 'AMBIGUOUS_SESSION');
    if (/No session|No sessions/.test(e.message)) throw problem(404, e.message, 'NOT_FOUND');
    throw e;
  }
}

function dedupeOpts(url) {
  const q = Object.fromEntries(url.searchParams);
  const max = integer(q.max, 3000, 1000000, 1);
  if (q.threshold === undefined) return { max, threshold: 0.8 };
  const threshold = Number(q.threshold);
  if (typeof q.threshold !== 'string' || q.threshold.trim() === '' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw problem(400, 'threshold must be between 0 and 1');
  return { max, threshold };
}

async function textBody(req) {
  const body = await readJson(req, MB);
  if (typeof body.text !== 'string') throw problem(400, 'text must be a string');
  if (Buffer.byteLength(body.text) > MB) throw problem(413, 'body too large');
  return body.text;
}

function readJson(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > max) { reject(problem(413, 'body too large')); req.resume(); return; }
    let n = 0, oversized = false;
    const parts = [];
    req.on('error', reject);
    req.on('aborted', () => reject(problem(400, 'Request body aborted')));
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { if (!oversized) { oversized = true; parts.length = 0; reject(problem(413, 'body too large')); req.destroy(); } return; }
      parts.push(c);
    });
    req.on('end', () => {
      if (oversized) return;
      try {
        const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch (e) { reject(e.status ? e : problem(400, 'Invalid JSON')); }
    });
  });
}

async function call(name, invoke) {
  let mod;
  try { mod = await import('../intel/platform.mjs'); }
  catch { throw problem(501, 'capability unavailable'); }
  const fn = mod?.[name];
  if (typeof fn !== 'function') throw problem(501, 'capability unavailable');
  return invoke(fn);
}
