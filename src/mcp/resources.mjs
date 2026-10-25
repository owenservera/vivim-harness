// MCP resources for saved captures. Reads files in place; does not create session directories.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Dataset, listSessions } from '../store/session.mjs';
import { ErrorCode, RpcError } from './jsonrpc.mjs';

const PAGE = 100;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const MAX_TEXT = 1_000_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function sessionPath(sessionsDir, id) {
  if (typeof id !== 'string' || !NAME.test(id)) return null;
  const root = path.resolve(sessionsDir);
  const dir = path.resolve(root, id);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!dir.startsWith(prefix)) return null;
  if (!existsSync(path.join(dir, 'session.json'))) return null;
  return dir;
}

function encodeId(id) {
  return encodeURIComponent(id);
}

export function resourceUri(kind, id, dataset) {
  if (kind === 'sessions') return 'capture-studio://sessions';
  const base = `capture-studio://sessions/${encodeId(id)}`;
  if (kind === 'session') return base;
  if (kind === 'datasets') return `${base}/datasets`;
  if (kind === 'dataset') return `${base}/datasets/${encodeId(dataset)}`;
  if (kind === 'knowledge') return `${base}/knowledge`;
  return base;
}

function datasetsOf(dir) {
  const folder = path.join(dir, 'datasets');
  if (!existsSync(folder)) return [];
  const items = [];
  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.jsonl')) continue;
    const name = file.slice(0, -6);
    if (!NAME.test(name)) continue;
    try { items.push({ name, bytes: statSync(path.join(folder, file)).size }); }
    catch { /* skip a raced delete */ }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

function readJsonFile(file, maxBytes) {
  if (!existsSync(file)) return null;
  let size = 0;
  try { size = statSync(file).size; }
  catch { return { unreadable: true }; }
  if (size > maxBytes) return { truncated: true, bytes: size };
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { unreadable: true }; }
}

function kvFile(dir, key) {
  return path.join(dir, 'kv', `${key}.json`);
}

function boundText(value) {
  const text = JSON.stringify(value);
  if (text.length <= MAX_TEXT) return text;
  return JSON.stringify({
    truncated: true,
    bytes: Buffer.byteLength(text),
    note: 'Resource exceeded the stdio size cap. Read a narrower dataset page or call the matching tool.',
    keys: value && typeof value === 'object' ? Object.keys(value) : [],
  });
}

function parseResourceUri(uri) {
  if (typeof uri !== 'string' || !uri || uri.length > 2048) {
    throw new RpcError(ErrorCode.InvalidParams, 'Resource uri is required');
  }
  let url;
  try { url = new URL(uri); }
  catch { throw new RpcError(ErrorCode.ResourceNotFound, 'Resource not found', { uri: uri.slice(0, 500) }); }
  if (url.protocol !== 'capture-studio:' || url.hostname !== 'sessions' || url.username || url.password) {
    throw new RpcError(ErrorCode.ResourceNotFound, 'Resource not found', { uri: uri.slice(0, 500) });
  }
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part)); }
  catch { throw new RpcError(ErrorCode.ResourceNotFound, 'Resource not found', { uri: uri.slice(0, 500) }); }
  const query = Object.fromEntries(url.searchParams);
  if (!parts.length) return { kind: 'sessions', query };
  const id = parts[0];
  if (parts.length === 1) return { kind: 'session', id, query };
  if (parts[1] === 'datasets' && parts.length === 2) return { kind: 'datasets', id, query };
  if (parts[1] === 'datasets' && parts.length === 3) return { kind: 'dataset', id, dataset: parts[2], query };
  if (parts[1] === 'knowledge' && parts.length === 2) return { kind: 'knowledge', id, query };
  throw new RpcError(ErrorCode.ResourceNotFound, 'Resource not found', { uri: uri.slice(0, 500) });
}

function catalog(sessionsDir) {
  const resources = [{
    uri: resourceUri('sessions'),
    name: 'sessions',
    title: 'Capture sessions',
    description: 'Saved capture sessions on this machine',
    mimeType: 'application/json',
  }];
  if (!existsSync(sessionsDir)) return resources;
  for (const meta of listSessions(sessionsDir)) {
    const id = meta.id;
    const dir = sessionPath(sessionsDir, id);
    if (!dir) continue;
    const when = meta.createdAt ? ` recorded ${meta.createdAt}` : '';
    const site = meta.site ? `${meta.site} ` : '';
    resources.push({
      uri: resourceUri('session', id),
      name: id,
      title: `${site}${id}`.trim(),
      description: `Session metadata${when}`.trim(),
      mimeType: 'application/json',
    });
    const datasets = datasetsOf(dir);
    resources.push({
      uri: resourceUri('datasets', id),
      name: `${id}/datasets`,
      title: `${id} datasets`,
      description: `${datasets.length} derived dataset${datasets.length === 1 ? '' : 's'}`,
      mimeType: 'application/json',
    });
    for (const dataset of datasets) {
      resources.push({
        uri: resourceUri('dataset', id, dataset.name),
        name: `${id}/${dataset.name}`,
        title: dataset.name,
        description: `Dataset ${dataset.name} for session ${id}`,
        mimeType: 'application/json',
        size: dataset.bytes,
      });
    }
    resources.push({
      uri: resourceUri('knowledge', id),
      name: `${id}/knowledge`,
      title: `${id} knowledge`,
      description: 'Derived knowledge summary for this session',
      mimeType: 'application/json',
    });
  }
  return resources;
}

export function listCaptureResources(sessionsDir, cursor) {
  const all = catalog(sessionsDir);
  let offset = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) throw new RpcError(ErrorCode.InvalidParams, 'Invalid resource cursor');
    offset = Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > all.length) throw new RpcError(ErrorCode.InvalidParams, 'Invalid resource cursor');
  }
  const resources = all.slice(offset, offset + PAGE);
  const next = offset + PAGE < all.length ? String(offset + PAGE) : undefined;
  return next ? { resources, nextCursor: next } : { resources };
}

function integerQuery(value, name, fallback, max, min) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new RpcError(ErrorCode.InvalidParams, `${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RpcError(ErrorCode.InvalidParams, `${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function requireSession(sessionsDir, id, uri) {
  const dir = sessionPath(sessionsDir, id);
  if (!dir) throw new RpcError(ErrorCode.ResourceNotFound, 'Resource not found', { uri: String(uri).slice(0, 500) });
  return dir;
}

async function readDataset(dir, name, query, uri) {
  if (!NAME.test(name)) throw new RpcError(ErrorCode.ResourceNotFound, 'Resource not found', { uri: String(uri).slice(0, 500) });
  const file = path.resolve(dir, 'datasets', `${name}.jsonl`);
  const root = path.resolve(dir, 'datasets') + path.sep;
  if (!file.startsWith(root) || !existsSync(file)) {
    throw new RpcError(ErrorCode.ResourceNotFound, 'Resource not found', { uri: String(uri).slice(0, 500) });
  }
  const offset = integerQuery(query.offset, 'offset', 0, 1_000_000, 0);
  const limit = integerQuery(query.limit, 'limit', DEFAULT_LIMIT, MAX_LIMIT, 1);
  const items = [];
  let bytes = 0;
  let truncated = false;
  const dataset = new Dataset(file);
  for await (const row of dataset.iterate({ from: offset })) {
    const encoded = JSON.stringify(row);
    if (items.length >= limit || (items.length && bytes + encoded.length > MAX_TEXT)) { truncated = true; break; }
    items.push(row);
    bytes += encoded.length;
  }
  return {
    session: path.basename(dir),
    dataset: name,
    bytes: statSync(file).size,
    offset,
    limit,
    items,
    truncated,
  };
}

function readKnowledge(dir) {
  const outcome = readJsonFile(kvFile(dir, 'KNOWLEDGE_STATUS'), 256 * 1024);
  const model = readJsonFile(kvFile(dir, 'MODEL'), MAX_TEXT);
  const hypotheses = readJsonFile(kvFile(dir, 'HYPOTHESES'), MAX_TEXT);
  const corpus = readJsonFile(kvFile(dir, 'CORPUS_STATS'), 256 * 1024);
  const graph = readJsonFile(kvFile(dir, 'GRAPH'), 2 * 1024 * 1024);
  const modelValue = model && model.truncated ? { truncated: true, bytes: model.bytes } : model;
  const available = !!modelValue && !modelValue.truncated && !modelValue.unreadable && !modelValue.error
    && (!outcome || outcome.status === 'complete');
  return {
    session: path.basename(dir),
    available,
    outcome,
    model: modelValue,
    hypotheses: hypotheses && hypotheses.truncated ? { truncated: true, bytes: hypotheses.bytes } : hypotheses,
    corpus,
    graphStats: graph && !graph.truncated && !graph.unreadable ? graph.stats ?? null : null,
    graphTruncated: !!(graph && graph.truncated),
  };
}

export async function readCaptureResource(sessionsDir, uri) {
  const parsed = parseResourceUri(uri);
  let value;
  if (parsed.kind === 'sessions') {
    value = { items: existsSync(sessionsDir) ? listSessions(sessionsDir) : [] };
  } else {
    const dir = requireSession(sessionsDir, parsed.id, uri);
    if (parsed.kind === 'session') {
      value = {
        meta: readJsonFile(path.join(dir, 'session.json'), 256 * 1024),
        datasets: datasetsOf(dir),
        knowledgeStatus: readJsonFile(kvFile(dir, 'KNOWLEDGE_STATUS'), 256 * 1024),
        receipt: readJsonFile(kvFile(dir, 'RECEIPT'), MAX_TEXT),
      };
    } else if (parsed.kind === 'datasets') value = { session: parsed.id, items: datasetsOf(dir) };
    else if (parsed.kind === 'dataset') value = await readDataset(dir, parsed.dataset, parsed.query, uri);
    else value = readKnowledge(dir);
  }
  return { contents: [{ uri, mimeType: 'application/json', text: boundText(value) }] };
}
