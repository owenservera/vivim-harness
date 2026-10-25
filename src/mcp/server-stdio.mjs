#!/usr/bin/env node
// Capture Studio MCP server. Stdout is newline-delimited JSON-RPC 2.0 only; logs go to stderr.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { VERSION, dataPaths, defaultDataDir } from '../config.mjs';
import { ErrorCode, parseMessage, rpcError, rpcResult, RpcError, serialize } from './jsonrpc.mjs';
import { callTool, createRuntime, listTools } from './runtime.mjs';
import { listCaptureResources, readCaptureResource } from './resources.mjs';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 8 * 1024 * 1024;
const INSTRUCTIONS = 'Local Capture Studio MCP server. Tools are the in-process integration hub (derive-all and mirror load on first use and return a tool error if that module is absent). Resources: capture-studio://sessions, capture-studio://sessions/{id}, capture-studio://sessions/{id}/datasets, capture-studio://sessions/{id}/datasets/{name}, capture-studio://sessions/{id}/knowledge. Captured content stays on this machine.';

function log(message) {
  process.stderr.write(`[capture-studio-mcp] ${message}\n`);
}

function negotiate(version) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version) ? version : SUPPORTED_PROTOCOL_VERSIONS[0];
}

function pageTools(tools, cursor) {
  if (cursor === undefined) return { tools };
  if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) throw new RpcError(ErrorCode.InvalidParams, 'Invalid tool cursor');
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > tools.length) throw new RpcError(ErrorCode.InvalidParams, 'Invalid tool cursor');
  const slice = tools.slice(offset, offset + 100);
  const next = offset + 100 < tools.length ? String(offset + 100) : undefined;
  return next ? { tools: slice, nextCursor: next } : { tools: slice };
}

export async function createServer() {
  let runtimePromise = null;
  const state = { phase: 'new' };
  const runtime = () => {
    if (!runtimePromise) {
      runtimePromise = Promise.resolve().then(() => createRuntime()).catch((error) => {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  };

  async function dispatch(message) {
    const { id, method, params } = message;
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'initialize') {
      if (state.phase !== 'new') return rpcError(id, ErrorCode.InvalidRequest, 'Server already initialized');
      if (typeof params.protocolVersion !== 'string' || !params.protocolVersion) {
        return rpcError(id, ErrorCode.InvalidParams, 'protocolVersion is required');
      }
      if (params.capabilities !== undefined && (typeof params.capabilities !== 'object' || Array.isArray(params.capabilities))) {
        return rpcError(id, ErrorCode.InvalidParams, 'capabilities must be an object');
      }
      if (params.clientInfo !== undefined && (typeof params.clientInfo !== 'object' || Array.isArray(params.clientInfo) || params.clientInfo === null)) {
        return rpcError(id, ErrorCode.InvalidParams, 'clientInfo must be an object');
      }
      state.phase = 'ready';
      state.client = params.clientInfo ?? null;
      return rpcResult(id, {
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: 'capture-studio', version: VERSION, title: 'Capture Studio' },
        instructions: INSTRUCTIONS,
      });
    }
    if (state.phase === 'new') return rpcError(id, ErrorCode.InvalidRequest, 'Server not initialized');
    if (method === 'tools/list') return rpcResult(id, pageTools(await listTools(await runtime()), params.cursor));
    if (method === 'tools/call') {
      if (typeof params.name !== 'string') return rpcError(id, ErrorCode.InvalidParams, 'Tool name is required');
      return rpcResult(id, await callTool(await runtime(), params.name, params.arguments));
    }
    if (method === 'resources/list') {
      return rpcResult(id, listCaptureResources(dataPaths(defaultDataDir()).sessions, params.cursor));
    }
    if (method === 'resources/read') {
      if (typeof params.uri !== 'string') return rpcError(id, ErrorCode.InvalidParams, 'Resource uri is required');
      return rpcResult(id, await readCaptureResource(dataPaths(defaultDataDir()).sessions, params.uri));
    }
    return rpcError(id, ErrorCode.MethodNotFound, `Method not found: ${method}`);
  }

  function notify(method) {
    if (method === 'notifications/initialized' || method === 'initialized') {
      if (state.phase === 'ready') state.phase = 'initialized';
      const client = state.client;
      log(client?.name ? `client ready: ${client.name}${client.version ? ` ${client.version}` : ''}` : 'client ready');
      return;
    }
    if (method === 'notifications/cancelled' || method === 'notifications/progress' || method === '$/cancelRequest') return;
    log(`ignored notification ${method}`);
  }

  return {
    state,
    notify,
    dispatch,
    async close() {
      if (!runtimePromise) return;
      try { await (await runtimePromise).close(); }
      catch (error) { log(`shutdown: ${error.message}`); }
    },
  };
}

export async function serveStdio({ input = process.stdin, output = process.stdout } = {}) {
  const server = await createServer();
  let chain = Promise.resolve();
  let stopping = false;
  const write = (message) => {
    output.write(serialize(message));
  };
  const fail = (id, error) => {
    if (error instanceof RpcError) return write(rpcError(id, error.code, error.message, error.data));
    log(error?.stack ?? error?.message ?? String(error));
    if (id !== undefined) write(rpcError(id ?? null, ErrorCode.InternalError, 'Internal error'));
  };
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    chain.then(() => server.close()).catch((error) => log(error?.message ?? error)).finally(() => process.exit(0));
  };
  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  rl.on('line', (line) => {
    chain = chain.then(async () => {
      if (stopping) return;
      if (Buffer.byteLength(line) > MAX_LINE) {
        write(rpcError(null, ErrorCode.ParseError, 'Parse error'));
        return;
      }
      const parsed = parseMessage(line);
      if (parsed.empty) return;
      if (parsed.error) { write(parsed.error); return; }
      if (parsed.notification) {
        if (!parsed.ignore) server.notify(parsed.method);
        return;
      }
      try { write(await server.dispatch(parsed)); }
      catch (error) { fail(parsed.id, error); }
    }).catch((error) => fail(undefined, error));
  });
  rl.on('close', shutdown);
  input.on?.('error', (error) => { log(error.message); shutdown(); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('stdio server ready');
  return { server, shutdown };
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry && entry === fileURLToPath(import.meta.url)) serveStdio();
