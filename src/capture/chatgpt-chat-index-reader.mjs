// Read-only reader for the rendered ChatGPT chat index. One explicit target, one index expression.
//
// This is a bounded function for the Studio runtime to call later; it is not a driver, recorder or
// capture. It creates no session directory, raw log, lease or snapshot, and never focuses, scrolls,
// clicks, navigates, types or issues a page/private HTTP request. Its only browser operations are:
// list tabs over the loopback DevTools HTTP endpoint, attach ONE flatten session to the exact target,
// evaluate three read-only expressions (page identity, the index, page identity) and detach the session
// it created. It never closes a target. The reader enforces page origin and path itself and treats every
// returned thread as a rendered-link CANDIDATE, never as a verified binding.
import { listTargets as discoveredTargets, browserWsUrl } from '../cdp/discovery.mjs';
import { CdpConnection } from '../cdp/client.mjs';
import { chatIndexExpression, normalizeChatIndex, CHATGPT_CANONICAL_ORIGIN, CHAT_INDEX_IDENTITY, CHAT_INDEX_LIVE_BINDING } from './chatgpt-chat-index.mjs';
import { parseThread } from './conversation-thread.mjs';

// Exactly the canonical origin the shared index module accepts: no www or legacy alias, port or credentials.
const ALLOWED_ORIGINS = Object.freeze([CHATGPT_CANONICAL_ORIGIN]);
const REQUEST_KEYS = ['targetId', 'site', 'maxEntries', 'maxTitleChars', 'scanLimit', 'containers'];
const OPTION_KEYS = ['maxEntries', 'maxTitleChars', 'scanLimit', 'containers'];
const EVAL_TIMEOUT_MS = 5000;

const fail = (status, code) => Object.assign(new Error(code), { code, status });

const IDENTITY_EXPRESSION = '(() => ({ origin: String(location.origin), path: String(location.pathname) }))()';
// The page identity is read in the same synchronous task, on both sides of the index expression.
const wrapIndex = (expression) => `(() => { const id = () => ({ origin: String(location.origin), path: String(location.pathname) });
  const before = id(); const result = ${expression}; const after = id(); return { before, after, result }; })()`;

// Everything that can be rejected without touching the browser is rejected here.
function validate(request, deps) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail(400, 'INVALID_CHAT_INDEX_REQUEST');
  if (Object.keys(request).some((key) => !REQUEST_KEYS.includes(key))) throw fail(400, 'INVALID_CHAT_INDEX_REQUEST');
  const { targetId, site = 'chatgpt' } = request;
  if (site !== 'chatgpt' || typeof targetId !== 'string' || !targetId || targetId.length > 256) throw fail(400, 'INVALID_CHAT_INDEX_REQUEST');
  const port = deps?.port;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw fail(400, 'INVALID_CHAT_INDEX_REQUEST');
  const options = Object.fromEntries(OPTION_KEYS.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]));
  const expression = chatIndexExpression(options); // validates the bounds; throws a coded 400
  normalizeChatIndex(null, options); // same validation for the normaliser, with the same options
  return { targetId, port, options, expression };
}

// Trusted identity of a page: https, one of the allowed ChatGPT origins, and its path. Titles are never read.
function describePage(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !ALLOWED_ORIGINS.includes(parsed.origin)) return null;
  return { origin: parsed.origin, path: parsed.pathname };
}

function classifyTab(tab) {
  if (tab.type && tab.type !== 'page') throw fail(409, 'TARGET_SITE_MISMATCH');
  const page = describePage(tab.url);
  if (!page) throw fail(409, 'TARGET_SITE_MISMATCH');
  return page;
}

function pageIdentity(value) {
  if (!value || typeof value !== 'object' || typeof value.origin !== 'string' || typeof value.path !== 'string') throw fail(409, 'INDEX_READ_FAILED');
  const page = describePage(`${value.origin}${value.path.startsWith('/') ? '' : '/'}${value.path}`);
  if (!page || page.origin !== value.origin) throw fail(409, 'TARGET_SITE_MISMATCH');
  return page;
}

const samePage = (a, b) => a.origin === b.origin && a.path === b.path;
const unchanged = (a, b) => { if (!samePage(a, b)) throw fail(409, 'BINDING_CHANGED'); };

function mapOpenError(error) {
  if (error?.status && error?.code) return error;
  const text = String(error?.message ?? '');
  if (error?.code === -32602 || /no target|target.{0,20}not found|invalid target/i.test(text)) return fail(404, 'TARGET_NOT_FOUND');
  return fail(503, 'BROWSER_UNAVAILABLE');
}

async function defaultEvaluate(session, expression) {
  // No user gesture and no promise awaiting: pure synchronous observation.
  const reply = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, timeout: EVAL_TIMEOUT_MS });
  if (reply?.exceptionDetails) throw fail(409, 'INDEX_EVAL_FAILED');
  return reply?.result?.value;
}

// Opens ONE flatten session on the exact target using the existing CDP client. close() detaches only
// that session and closes only the socket this call opened; it never closes the target.
export function createDefaultOpenSession({ browserWsUrl: resolveWsUrl = browserWsUrl, connect = (url, options) => CdpConnection.connect(url, options) } = {}) {
  return async function openSession({ targetId, port }) {
    const connection = await connect(await resolveWsUrl({ port }), { timeoutMs: 5000, requestTimeoutMs: 8000 });
    let session;
    try { session = await connection.attach(targetId, { timeoutMs: 5000 }); }
    catch (error) { try { connection.close(); } catch { /* already closed */ } throw error; }
    let closed = false;
    return { session, async close() {
      if (closed) return;
      closed = true;
      try { await connection.detach(session.sessionId); } catch { /* session already gone */ } finally { try { connection.close(); } catch { /* already closed */ } }
    } };
  };
}

const pathKind = (page) => (page.path === '/' || page.path === '' || /^\/new\/?$/.test(page.path) ? 'root'
  : parseThread('chatgpt', `${page.origin}${page.path}`) ? 'thread' : 'other');

/**
 * readChatIndex(request, deps)
 *   request: { targetId (required, exact), site?: 'chatgpt', maxEntries?, maxTitleChars?, scanLimit?, containers? }
 *   deps:    { port (required), listTargets?, openSession?, evaluate? }  (defaults use the existing CDP client)
 * Returns { targetId, origin, readAt, index, context }; `index.complete` is always false.
 * Errors (all carry { status, code }, never page text or URLs): 400 INVALID_CHAT_INDEX_REQUEST|OPTIONS,
 * 503 BROWSER_UNAVAILABLE, 404 TARGET_NOT_FOUND, 409 TARGET_SITE_MISMATCH|BINDING_CHANGED|INDEX_EVAL_FAILED|INDEX_READ_FAILED.
 */
export async function readChatIndex(request, deps = {}) {
  const { targetId, port, options, expression } = validate(request, deps);
  const listTargets = deps.listTargets ?? discoveredTargets;
  const evaluate = deps.evaluate ?? defaultEvaluate;
  const open = deps.openSession ?? createDefaultOpenSession();
  const listed = async () => {
    let tabs;
    try { tabs = await listTargets({ port }); } catch { throw fail(503, 'BROWSER_UNAVAILABLE'); }
    const tab = Array.isArray(tabs) ? tabs.find((t) => t && t.id === targetId) : undefined;
    if (!tab) throw fail(404, 'TARGET_NOT_FOUND');
    return classifyTab(tab);
  };
  const run = async (session, source) => {
    try { return await evaluate(session, source); }
    catch (error) {
      if (error?.status && error?.code) throw error;
      throw /closed|detached|disconnected/i.test(String(error?.message ?? '')) ? fail(503, 'BROWSER_UNAVAILABLE') : fail(409, 'INDEX_EVAL_FAILED');
    }
  };

  const listedBefore = await listed(); // preflight: nothing is attached for a missing or foreign target
  let handle;
  try { handle = await open({ targetId, port }); } catch (error) { throw mapOpenError(error); }
  try {
    const session = handle?.session;
    if (!session) throw fail(409, 'INDEX_READ_FAILED');
    const pageBefore = pageIdentity(await run(session, IDENTITY_EXPRESSION));
    unchanged(listedBefore, pageBefore);

    const wrapped = await run(session, wrapIndex(expression)); // the ONE index expression
    if (!wrapped || typeof wrapped !== 'object' || !wrapped.result || typeof wrapped.result !== 'object' || Array.isArray(wrapped.result)) throw fail(409, 'INDEX_READ_FAILED');
    unchanged(pageBefore, pageIdentity(wrapped.before));
    unchanged(pageBefore, pageIdentity(wrapped.after));

    unchanged(pageBefore, pageIdentity(await run(session, IDENTITY_EXPRESSION)));
    unchanged(pageBefore, await listed()); // the exact target is still there, still the same page

    // The expression's own origin is evidence only; the verified origin is the one used downstream.
    if (typeof wrapped.result.origin === 'string' && wrapped.result.origin !== pageBefore.origin) throw fail(409, 'BINDING_CHANGED');
    const normalized = normalizeChatIndex({ ...wrapped.result, origin: pageBefore.origin }, options);
    if (normalized.invalidResult) throw fail(409, 'INDEX_READ_FAILED');

    // Only same-origin links survive; duplicates merge by thread; nothing is a verified binding.
    const merged = new Map();
    let foreignOriginDropped = 0;
    for (const entry of normalized.entries) {
      if (typeof entry.origin === 'string' && entry.origin !== pageBefore.origin) { foreignOriginDropped++; continue; }
      const seen = merged.get(entry.threadRef);
      if (seen) { seen.occurrences += entry.occurrences ?? 0; continue; }
      merged.set(entry.threadRef, { ...entry, identity: { ...CHAT_INDEX_IDENTITY }, liveBinding: { ...CHAT_INDEX_LIVE_BINDING } });
    }
    const entries = [...merged.values()];
    const threadRef = parseThread('chatgpt', `${pageBefore.origin}${pageBefore.path}`)?.ref ?? null;
    return {
      targetId, origin: pageBefore.origin, readAt: new Date().toISOString(),
      index: { ...normalized, complete: false, candidatesOnly: true, entries, coverage: { ...normalized.coverage, returnedEntries: entries.length, foreignOriginDropped } },
      context: { source: 'local-studio-cdp-reader', site: 'chatgpt', page: { origin: pageBefore.origin, pathKind: pathKind(pageBefore), threadRef },
        guards: { listedBefore: true, pageIdentityBefore: true, singleIndexEvaluation: true, pageIdentityDuring: true, pageIdentityAfter: true, listedAfter: true },
        identityPolicy: 'rendered-links-are-candidates-not-verified-bindings', sideEffects: 'none' },
    };
  } finally {
    try { await handle?.close?.(); } catch { /* best-effort cleanup never masks the outcome */ }
  }
}
