// Thin HTTP client for an ALREADY RUNNING, same-owner Studio. No runtime/CDP/MCP construction.
// One HTTP attempt only, including redirects, timeouts, conflicts and unknown submission outcomes.
import { CONVERSATION_TOOLS, validateConversationTool } from './conversation-tools.mjs';

const failure = (code, status, effect = 'none') => Object.assign(new Error(code), { code, status, effect, retry: false });
const safeCode = (code) => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code);
export function createStudioToolClient(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !['port', 'token', 'fetch', 'timeoutMs'].includes(key))) throw failure('INVALID_STUDIO_CLIENT', 400);
  const { port, token, fetch: request = globalThis.fetch, timeoutMs = 10000 } = options;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof request !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || token !== undefined && (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token))) throw failure('INVALID_STUDIO_CLIENT', 400);
  const origin = `http://127.0.0.1:${port}`;
  async function once(route, body, effect) {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(failure('STUDIO_REQUEST_UNKNOWN', 504, effect));
    }, timeoutMs); });
    const run = (async () => {
      let response, data;
      try {
        response = await request(origin + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { 'x-studio-token': token }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.redirected) throw failure('STUDIO_REDIRECT_REFUSED', 502, effect);
        data = await response.json();
      } catch {
        // Do not retain/print fetch messages, response bodies, tokens, prompts or replies in errors.
        throw failure('STUDIO_REQUEST_UNKNOWN', 503, effect);
      }
      if (!response.ok) throw failure(safeCode(data?.code) ? data.code : 'STUDIO_HTTP_ERROR', response.status, effect);
      return data;
    })();
    try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
  }
  return {
    async list() {
      const manifest = await once('/api/v1/integrations/tools', undefined, 'none');
      if (!Array.isArray(manifest?.tools)) throw failure('STUDIO_INVALID_RESPONSE', 502);
      const allowed = new Set(CONVERSATION_TOOLS.map((tool) => tool.name));
      return { ...manifest, tools: manifest.tools.filter((tool) => allowed.has(tool.name)) };
    },
    async call(name, args = {}) {
      const { definition } = validateConversationTool(name, args);
      const effect = definition.annotations.readOnlyHint ? 'none' : 'unknown';
      const result = await once('/api/v1/integrations/tools/call', { name, arguments: args }, effect);
      if (!result || result.isError !== false || !Object.hasOwn(result, 'structuredContent')) throw failure('STUDIO_INVALID_RESPONSE', 502, effect);
      return result.structuredContent; // Explicit return to the caller, never an incidental diagnostic log.
    },
  };
}
