#!/usr/bin/env node
// Native webapp response-shape atlas generator (aion.shape-atlas/1).
//
// Produces a machine-readable, versioned atlas of OBSERVED provider shape evidence from saved
// Capture Studio sessions — the same evidence class docs/AI-CHAT-SHAPES.md is generated from —
// plus the synthetic dialect fixtures the offline suite encodes. Every entry carries an evidence
// label from roles/14-webapp-native-harness/CAPABILITY-LEDGER.md vocabulary:
//   SOURCE (repo/recorded data) | SYNTHETIC (fixtures/tests) | REAL (live page receipt) |
//   PRODUCT (official docs only) | UNKNOWN.
// The atlas describes shapes and counts only; it never embeds transcript text or private ids.
//
// Usage:
//   node scripts/shape-atlas.mjs --sessions <capture-home>/sessions --out docs/shape-atlas
//   node scripts/shape-atlas.mjs --out docs/shape-atlas            (fixtures only)
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../src/store/session.mjs';
import { readAcceptance } from '../src/capture/acceptance.mjs';
import { streamText } from '../src/replay/derive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCHEMA = 'aion.shape-atlas/1';
const ATLAS_VERSION = 1;
const CHAT_ENDPOINT_RE = /conversation|completion|chat|message|generate|stream|reply|timeline|response/i;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const outDir = path.resolve(arg('out', path.join(ROOT, 'docs', 'shape-atlas')));
const sessionsDir = arg('sessions');

// Dialect fixtures encoded in the offline suite: SYNTHETIC evidence of stream shapes.
const FIXTURES = ['chatgpt-pathops.json', 'claude-typedevents.json', 'openai-responses.json'];

async function sessionEntry(dir, id) {
  let s;
  try { s = Session.open(dir, id); } catch { return null; }
  const meta = s.meta ?? {};
  const shapes = s.kv.get('SHAPES', null);
  const endpoints = Array.isArray(shapes?.endpoints) ? shapes.endpoints : [];
  const chatEndpoints = endpoints.filter((e) => CHAT_ENDPOINT_RE.test(e.endpoint ?? ''));
  const components = s.kv.get('STREAM_COMPONENTS', null);
  const domTurns = s.kv.get('DOM_TURNS', null);
  const join = s.kv.get('STREAM_DOM_JOIN', null);
  const knowledge = s.kv.get('KNOWLEDGE_STATUS', null);
  let acceptance = null;
  try { acceptance = readAcceptance(s); } catch { acceptance = null; }
  let replyChars = null;
  try {
    const assembled = s.kv.get('ASSEMBLED', null);
    const sids = assembled && typeof assembled === 'object' ? Object.keys(assembled) : [];
    let best = 0;
    for (const sid of sids) {
      try { const t = await streamText(s, sid, { useLocator: false }); best = Math.max(best, (t.assembledText ?? '').length); } catch { /* stream unreadable */ }
    }
    replyChars = best;
  } catch { replyChars = null; }
  return {
    session: id,
    site: meta.site ?? null,
    origin: meta.target?.origin ?? (meta.target?.url ? new URL(meta.target.url).origin : null),
    recordedAt: id.slice(0, 15).replace(/-/g, '').replace(/^(\d{8})T(\d{6})$/, '$1T$2') || null,
    transports: [...new Set(endpoints.flatMap((e) => Object.keys(e.transports ?? {})))],
    endpoints: { total: endpoints.length, chat: chatEndpoints.length,
      chatList: chatEndpoints.map((e) => e.endpoint).slice(0, 8) },
    streamMaps: [...new Set((components?.streams ?? []).map((x) => x.mapId).filter(Boolean))],
    streamComponentCount: (components?.streams ?? []).reduce((a, x) => a + (x.components?.length ?? 0), 0),
    unmappedEventCount: (components?.streams ?? []).reduce((a, x) => a + (x.unmappedCount ?? 0), 0),
    domTurns: Array.isArray(domTurns) ? domTurns.length : 0,
    joinStatus: join && !join.error ? join.status ?? 'unknown' : join?.error ? 'join-error' : 'not-derived',
    derived: knowledge?.status ?? 'unknown',
    acceptance: acceptance?.verdict ?? 'unassessed',
    assembledReplyChars: replyChars,
  };
}

async function sessionsFromDir(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir).filter((n) => /^\d{8}-\d{6}-/.test(n)).sort()) {
    const entry = await sessionEntry(dir, id);
    if (entry) out.push(entry);
  }
  return out;
}

function fixtureEntries() {
  const out = [];
  for (const f of FIXTURES) {
    const p = path.join(ROOT, 'test', 'fixtures', 'ai-chat-dialects', f);
    if (!existsSync(p)) continue;
    try {
      const fx = JSON.parse(readFileSync(p, 'utf8'));
      out.push({ fixture: f, synthetic: fx._synthetic === true, dialect: fx._dialect ?? fx.note ?? null,
        payloadCount: Array.isArray(fx.payloads) ? fx.payloads.length : (Array.isArray(fx.frames) ? fx.frames.length : null) });
    } catch { /* unreadable fixture is not silently counted */ }
  }
  return out;
}

// Sandbox receipts recorded live this round (REAL). Origins and failure classes only — no
// transcript content, no account data. Each maps to a receipt in the repository worklog.
const SANDBOX_RECEIPTS = [
  { provider: 'duck-ai', surface: 'chat', receipt: 'REAL',
    observed: 'guest dispatch landed (user turn rendered, ?chatID=<uuid> assigned); provider refused generation ("temporarily unavailable", anonymous code 02f8) for a datacenter IP; consent Continue gate once; composer disabled after refusal',
    transport: 'unverified (no reply stream was ever produced)', identity: 'unverified (query-parameter chatID; browser-local recent-chat listing; no durable claim)' },
  { provider: 'zai', surface: 'chat', receipt: 'REAL',
    observed: 'composer found via measured selector, typed and sent through the real composer; site answered "Network error"; page wedges Runtime.evaluate for any CDP client',
    transport: 'unverified', identity: 'unverified' },
  { provider: 'huggingface.co', surface: 'chat', receipt: 'REAL',
    observed: 'composer found, text typed via CDP input pipeline; site send control never enabled (framework state not updated even with real key events); no dispatch',
    transport: 'unverified', identity: 'unverified' },
  { provider: 'claude', surface: 'landing', receipt: 'REAL',
    observed: 'claude.ai reachable (HTTP 302 redirect to the login flow) from the sandbox; no guest chat surface observed; no bypass attempted',
    transport: 'not applicable (login wall)', identity: 'unverified — no durable thread grammar integrated' },
  { provider: 'chatgpt', surface: 'landing', receipt: 'REAL',
    observed: 'chatgpt.com returns HTTP 403 (Cloudflare) from the sandbox datacenter IP; no page observation possible',
    transport: 'not applicable (blocked)', identity: 'SOURCE-supported parser only (no fresh page observation)' },
];

async function main() {
  const sessions = await sessionsFromDir(sessionsDir);
  const byProvider = {};
  for (const s of sessions) {
    const key = s.site ?? 'unknown';
    (byProvider[key] ??= { sessions: 0, transports: new Set(), chatEndpoints: new Set(), streamMaps: new Set(), domTurns: 0, acceptance: {} });
    const b = byProvider[key];
    b.sessions++;
    for (const t of s.transports) b.transports.add(t);
    for (const e of s.endpoints.chatList) b.chatEndpoints.add(e);
    for (const m of s.streamMaps) b.streamMaps.add(m);
    b.domTurns += s.domTurns;
    b.acceptance[s.acceptance] = (b.acceptance[s.acceptance] ?? 0) + 1;
  }
  const atlas = {
    schema: SCHEMA, version: ATLAS_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceVocabulary: 'SOURCE | SYNTHETIC | REAL | PRODUCT | UNKNOWN (roles/14-webapp-native-harness/CAPABILITY-LEDGER.md)',
    sources: {
      sandboxSessions: sessionsDir ?? null,
      recordedOwnerAtlas: 'docs/AI-CHAT-SHAPES.md (generated 2026-10-22 from local capture families; SOURCE)',
      specialistContracts: 'workspace/aion/sessions/roles/14-webapp-native-harness/CONTRACTS.md v0.1',
    },
    sandbox: {
      sessions: sessions,
      providers: Object.fromEntries(Object.entries(byProvider).map(([k, b]) => [k, {
        sessions: b.sessions, transports: [...b.transports], chatEndpoints: [...b.chatEndpoints],
        streamMaps: [...b.streamMaps], domTurns: b.domTurns, acceptance: b.acceptance,
        evidence: 'REAL (sandbox live-browser failure-path captures; no model reply was ever obtained)',
      }])),
      liveReceipts: SANDBOX_RECEIPTS,
    },
    synthetic: { dialectFixtures: fixtureEntries(), evidence: 'SYNTHETIC (test/fixtures/ai-chat-dialects; offline suite)' },
    recordedOwnerFamilies: {
      note: 'Counts from docs/AI-CHAT-SHAPES.md, generated from owner-machine capture families. SOURCE-recorded, not fresh sandbox observation.',
      chatgpt: { sessions: 26, streams: 47, chatEndpoints: 9, transports: ['HTTP', 'HTTP_SSE', 'HTTP_STREAMED', 'UNKNOWN', 'WEBSOCKET'], interestingStream: 'POST /backend-api/f/conversation (path-ops)' },
      claude: { sessions: 11, streams: 31, chatEndpoints: 3, transports: ['EVENT_SOURCE', 'HTTP', 'HTTP_STREAMED'], interestingStream: '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline (Connect/protobuf framing)' },
    },
    identity: {
      chatgpt: { grammar: '/c/<uuid>', parser: 'src/capture/conversation-thread.mjs (THREAD_SITES=[chatgpt])', evidence: 'SOURCE + SYNTHETIC', durable: 'the one source-supported durable thread identity' },
      claude: { grammar: 'not integrated', parser: null, evidence: 'UNKNOWN', durable: 'org-scoped chat_conversations_v2 metadata observed historically; no accepted durable binding' },
      'duck-ai': { grammar: '?chatID=<uuid> query parameter', parser: null, evidence: 'REAL (assigned on first dispatch; browser-local listing)', durable: 'NOT claimed durable — never elevated to identity' },
    },
    gaps: [
      'No verified Claude reply reconstruction from Connect/protobuf traffic (field hypothesis 1.1.5.9 unconfirmed).',
      'Historical ChatGPT DOM old-extractor join 0/60; synthetic extractor fixes are not real-site join proof.',
      'No authenticated ChatGPT/Claude observation from this sandbox (login walls / 403); fresh observations are owner-runtime work.',
      'Artifacts, Work/Cowork tasks, citations and visible thinking summaries: PRODUCT-documented only; no AION-native parse accepted.',
      'Guest providers (duck.ai et al.) blocked at the provider from datacenter IPs; dispatch receipts exist, reply transports remain unverified.',
    ],
  };
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'atlas.json');
  writeFileSync(out, `${JSON.stringify(atlas, null, 2)}\n`);
  console.log(`shape atlas written: ${out} (sessions scanned: ${sessions.length}, sandbox providers: ${Object.keys(byProvider).length})`);
}

main().then(() => process.exit(0), (e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
