// In-process integration hub. Optional derive-all and mirror modules stay unloaded until a tool calls them.
import { derive } from '../replay/derive.mjs';
import { Recorder } from '../capture/recorder.mjs';
import { ProfileStore } from '../profiles/profiles.mjs';
import { FamilyStore } from '../families/families.mjs';
import { ScopedLearner } from '../intel/learn.mjs';
import { dataPaths, defaultDataDir, ensureDataDirs, resolveSettings } from '../config.mjs';
import { problem, storageName } from '../studio/http.mjs';
import { createIntegrationHub } from '../studio/integration-hub.mjs';
import { ErrorCode, RpcError } from './jsonrpc.mjs';

function previewRecord(record) {
  const out = { seq: record.seq, t: record.t, k: record.k, sid: record.sid };
  for (const key of ['n', 'url', 'method', 'status', 'mime', 'policy', 'kind', 'event', 'reason']) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  if (record.error || record.errorText) out.error = record.error ?? record.errorText;
  if (record.redactions) out.redactions = record.redactions.length;
  if (record.droppedRecords) out.droppedRecords = record.droppedRecords;
  return out;
}

function previewEvent(event) {
  const out = { ...event };
  const cap = (value) => (typeof value === 'string' && value.length > 4000 ? `${value.slice(0, 4000)}… [truncated]` : value);
  out.data = cap(out.data);
  out.text = cap(out.text);
  return out;
}

export function createRuntime({ env = process.env } = {}) {
  const paths = ensureDataDirs(dataPaths(defaultDataDir(env)));
  const { settings } = resolveSettings({ configFile: paths.config, env });
  const profileStore = new ProfileStore(paths.profiles);
  const familyStore = new FamilyStore(paths.families);
  const learner = new ScopedLearner(paths.learner);
  const recorder = new Recorder({
    sessionsDir: paths.sessions, profileStore, familyStore, port: settings.cdpPort, learner,
  });
  const deriving = new Set();
  const replayCache = new Map();
  let hub;
  async function deriveSession(session, profileName) {
    if (deriving.has(session.id)) throw problem(409, 'Session derivation is already running', 'DERIVATION_BUSY');
    if (['recording', 'stopping'].includes(recorder.state) && recorder.session?.id === session.id) {
      throw problem(409, 'Stop capture before deriving this session', 'SESSION_ACTIVE');
    }
    deriving.add(session.id);
    replayCache.delete(session.id);
    try {
      const profile = profileName
        ? profileStore.load(storageName(profileName, 'profile'))
        : session.kv.get('PROFILE_SNAPSHOT') ?? profileStore.load(session.meta.profile?.name ?? 'generic');
      const result = await derive(session, profile, { families: familyStore, learner });
      hub.publish('session.derived', {
        id: session.id, records: result.records, knowledge: result.knowledge,
        recordCounts: result.recordCounts, familyCounts: result.familyCounts,
      }, session.id);
      return result;
    } finally { deriving.delete(session.id); }
  }
  hub = createIntegrationHub({
    paths, profileStore, learner, recorder, deriveSession,
    previewRecord, previewEvent,
    getPort: () => settings.studioPort,
    cdpPort: settings.cdpPort,
    deriving,
    invalidateReplay: (id) => replayCache.delete(id),
  });
  return {
    paths,
    hub,
    close() { return hub.close(); },
  };
}

// Minimal response the hub's HTTP adapter can write without opening a socket.
function captureResponse() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    body: undefined,
    sseEvents: [],
    _sse: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
      if (!String(this.getHeader('content-type') ?? '').includes('text/event-stream')) this.headersSent = true;
    },
    write(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      this._sse += text;
      let split;
      while ((split = this._sse.indexOf('\n\n')) !== -1) {
        const frame = this._sse.slice(0, split);
        this._sse = this._sse.slice(split + 2);
        if (!frame || frame.startsWith(':')) continue;
        let event = 'message', data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try { this.sseEvents.push({ event, data: JSON.parse(data) }); }
        catch { this.sseEvents.push({ event, data }); }
      }
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (String(this.getHeader('content-type') ?? '').includes('text/event-stream')) this.write(text);
        else this.body = text;
      }
      if (!String(this.getHeader('content-type') ?? '').includes('text/event-stream')) this.writableEnded = true;
    },
    destroy() { this.destroyed = true; this.writableEnded = true; },
    once() {},
    on() {},
  };
}

export async function callRoute(hub, method, pathname, body = {}) {
  const res = captureResponse();
  const req = { method, headers: {} };
  const url = new URL(pathname, 'http://127.0.0.1');
  await hub.handle(req, res, url, body);
  return res;
}

function parseBody(res) {
  if (typeof res.body !== 'string' || !res.body.length) return { json: false, value: undefined };
  try { return { json: true, value: JSON.parse(res.body) }; }
  catch { return { json: false, value: res.body }; }
}

export async function listTools(runtime) {
  const res = await callRoute(runtime.hub, 'GET', '/api/v1/integrations/tools');
  const parsed = parseBody(res);
  if (res.statusCode >= 400 || !parsed.json || !Array.isArray(parsed.value?.tools)) {
    throw new RpcError(ErrorCode.InternalError, 'Integration tool manifest is unavailable');
  }
  return parsed.value.tools.map((tool) => {
    const schema = tool.inputSchema && tool.inputSchema.type === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} };
    return {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: schema,
      ...(tool.annotations && typeof tool.annotations === 'object' ? { annotations: tool.annotations } : {}),
    };
  });
}

function protocolArgumentError(res, parsed) {
  const message = parsed.json ? String(parsed.value?.error ?? '') : '';
  const code = parsed.json ? parsed.value?.code : undefined;
  if (res.statusCode === 404 && code === 'NOT_FOUND' && /unknown integration tool/i.test(message)) return message;
  if (res.statusCode === 400 && code === 'INVALID_REQUEST') return message || 'Invalid params';
  return null;
}

function toolError(res, parsed) {
  const payload = parsed.json
    ? { error: parsed.value?.error ?? 'Tool failed', code: parsed.value?.code ?? 'TOOL_ERROR', status: res.statusCode }
    : { error: typeof parsed.value === 'string' && parsed.value ? parsed.value : 'Tool failed', code: 'TOOL_ERROR', status: res.statusCode };
  const sseError = [...res.sseEvents].reverse().find((event) => event.event === 'error');
  const body = sseError && payload.error === 'Tool failed' ? sseError.data : payload;
  const structured = body && typeof body === 'object' ? body : { error: String(body) };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  };
}

export async function callTool(runtime, name, args) {
  if (typeof name !== 'string' || !name.trim()) throw new RpcError(ErrorCode.InvalidParams, 'Tool name is required');
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError(ErrorCode.InvalidParams, 'Tool arguments must be an object');
  const res = await callRoute(runtime.hub, 'POST', '/api/v1/integrations/tools/call', { name, arguments: args });
  const parsed = parseBody(res);
  const argumentError = protocolArgumentError(res, parsed);
  // A hub-rejected tool call is a tool-level failure, not a protocol error.
  if (argumentError && res.statusCode === 400) return { content: [{ type: 'text', text: argumentError }], isError: true };
  if (argumentError) throw new RpcError(ErrorCode.InvalidParams, argumentError);
  if (res.statusCode >= 400 || (parsed.json && parsed.value?.error && !parsed.value?.content)) return toolError(res, parsed);
  if (parsed.json && Array.isArray(parsed.value?.content)) {
    const sseError = [...res.sseEvents].reverse().find((event) => event.event === 'error');
    const text = parsed.value.content.find((item) => item?.type === 'text')?.text;
    if (sseError && (text === undefined || text === '' || text === 'undefined')) return toolError(res, { json: false, value: undefined });
    const result = {
      content: parsed.value.content,
      isError: parsed.value.isError === true,
    };
    if (parsed.value.structuredContent !== undefined) result.structuredContent = parsed.value.structuredContent;
    return result;
  }
  if (!parsed.json && typeof parsed.value === 'string') {
    return { content: [{ type: 'text', text: parsed.value }], isError: false };
  }
  const complete = [...res.sseEvents].reverse().find((event) => event.event === 'complete');
  if (complete) {
    return {
      content: [{ type: 'text', text: JSON.stringify(complete.data) }],
      structuredContent: complete.data,
      isError: false,
    };
  }
  if (res.sseEvents.some((event) => event.event === 'error')) return toolError(res, parsed);
  throw new RpcError(ErrorCode.InternalError, 'Tool returned an empty response');
}
