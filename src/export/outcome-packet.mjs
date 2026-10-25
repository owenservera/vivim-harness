#!/usr/bin/env node
// Value Oracle V1: conservative, offline consumer of Studio's export transcript --format json.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_LINE_CHARS = 4000;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const secret = /(?:\b(?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{8,}\b|\bgh[pousr]_[A-Za-z0-9_]{8,}\b)/i;
const clean = (s) => String(s).trim();
const code = (name, details) => Object.assign(new Error(details), { code: name });
const pointer = (parts) => '#' + parts.map((part) => '/' + String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

export function generatePacket(input, sourceFile = 'saved-session.json') {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !input.meta || !Array.isArray(input.turns) || !Array.isArray(input.streams)) {
    throw code('INVALID_TRANSCRIPT', 'Expected Studio transcript JSON with meta, turns[] and streams[]');
  }
  const sessionId = input.meta.id;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw code('INVALID_SESSION', 'Missing/unsafe meta.id');
  const observations = [];
  let total = 0;
  for (let i = 0; i < input.turns.length; i++) {
    const t = input.turns[i];
    if (!t || typeof t.text !== 'string' || !['assistant', 'user'].includes(t.role)) continue;
    total += t.text.length;
    observations.push({ text: t.text, role: t.role, location: pointer(['turns', i, 'text']) });
  }
  // DOM turns are first choice; assembled transport texts are an alternative, not extra evidence.
  if (!observations.some((o) => o.role === 'assistant')) {
    for (let i = 0; i < input.streams.length; i++) {
      const stream = input.streams[i];
      if (!stream || !Array.isArray(stream.texts)) continue;
      for (let j = 0; j < stream.texts.length; j++) {
        const t = stream.texts[j];
        if (typeof t?.text !== 'string') continue;
        total += t.text.length;
        observations.push({ text: t.text, role: 'stream-unattributed', location: pointer(['streams', i, 'texts', j, 'text']) });
      }
    }
  }
  if (total > MAX_TEXT_CHARS) throw code('OVERSIZE_TEXT', 'Transcript text exceeds 200,000 characters; select a smaller saved transcript');
  const entries = { summary: [], decision: [], action: [], question: [], unknown: [] };
  const evidence = [];
  const byKey = new Map();
  let redacted = 0, oversizedLines = 0;
  const matcher = /^\s*(?:[-*]\s*)?(summary|decision|next action|action|unknown|question)\s*:\s*(\S.*)$/i;
  function reference(o, line, quote) {
    const id = `ev-${sha(`${sessionId}|${o.location}|${line}|${quote}`).slice(0, 16)}`;
    evidence.push({ id, session: sessionId, source_file: sourceFile, json_pointer: o.location, line, text_sha256: sha(o.text), quote });
    return id;
  }
  for (const o of observations) {
    const lines = o.text.split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n];
      if (raw.length > MAX_LINE_CHARS) { oversizedLines++; continue; }
      const m = raw.match(matcher);
      if (!m) continue;
      const value = clean(m[2]);
      if (secret.test(value)) { redacted++; continue; }
      const category = m[1].toLowerCase() === 'next action' ? 'action' : m[1].toLowerCase();
      const evidenceId = reference(o, n + 1, raw);
      const key = `${category}|${value.toLowerCase()}`;
      if (byKey.has(key)) { byKey.get(key).source_refs.push(evidenceId); continue; }
      const record = { text: value, evidence_class: 'directly-observed-quote', source_role: o.role, source_refs: [evidenceId] };
      if (category === 'decision') record.confirmation = o.role === 'user' ? 'user-stated-in-capture-not-independently-verified' : 'not-user-confirmed';
      if (category === 'action') { record.status = 'proposed-not-executed'; record.assignee = null; record.destination = null; }
      byKey.set(key, record);
      entries[category].push(record);
    }
  }
  // Conversation content, verbatim: each assistant reply with the user prompt that preceded it.
  // No interpretation; the locator (pointer + SHA-256 of the whole source text) is independently checkable.
  const replies = [];
  let lastUser = null;
  for (const o of observations) {
    if (o.role === 'user') { lastUser = o; continue; }
    if (o.role !== 'assistant' || !o.text.trim() || secret.test(o.text)) continue;
    replies.push({ turn: replies.length + 1, evidence_class: 'directly-observed-verbatim', source_role: 'assistant',
      prompt: lastUser && !secret.test(lastUser.text) ? clean(lastUser.text).slice(0, 1000) : null,
      prompt_pointer: lastUser?.location ?? null, text: o.text.slice(0, 20000), truncated: o.text.length > 20000,
      locator: { json_pointer: o.location, text_sha256: sha(o.text) } });
  }
  const unknowns = [];
  if (!observations.length) unknowns.push('no-observable-turns-or-stream-text');
  if (!entries.summary.length) unknowns.push('no-explicit-summary-in-saved-text');
  if (!entries.decision.length) unknowns.push('no-explicit-decisions-found');
  if (!entries.action.length) unknowns.push('no-explicit-next-actions-found');
  if (!input.meta.status || input.meta.status !== 'complete') unknowns.push('capture-completeness-not-proven');
  unknowns.push('evidence-integrity-and-capture-acceptance-not-independently-verified');
  if (redacted) unknowns.push(`credential-shaped-lines-withheld:${redacted}`);
  if (oversizedLines) unknowns.push(`oversized-lines-skipped:${oversizedLines}`);
  const packet = {
    schema: 'capture-studio.outcome-packet/1', session: sessionId,
    source: { file: sourceFile, representation: 'studio-export-transcript-json', status: input.meta.status ?? null, raw_modified: false },
    answer: entries.summary[0] ?? null,
    replies,
    decisions: entries.decision, actions: entries.action,
    unresolved_questions: entries.question,
    source_stated_unknowns: entries.unknown,
    unknowns, evidence,
    derivation: { method: 'explicit-label-extraction-only', interpreted_decisions: 0, inferred_actions: 0, review_required: true, no_llm: true },
    delivery: { state: 'not-attempted', external_actions: 0 },
    measurement: { baseline_owner_steps: null, new_owner_steps: null, used_by_owner: false, independently_accepted: false }
  };
  return packet;
}

export function renderMarkdown(p) {
  const refs = (r) => r.source_refs.map((id) => ` [${id}]`).join('');
  const section = (title, records, empty) => [
    `## ${title}`, '',
    ...(records.length ? records.map((r) => `- ${r.text} — **${r.evidence_class}**, ${r.source_role}${r.confirmation ? `, ${r.confirmation}` : ''}${r.status ? `, ${r.status}` : ''}${refs(r)}`) : [`- ${empty}`]), ''
  ];
  return [
    `# Outcome Packet — ${p.session}`, '',
    '> Offline synthetic/recorded source transformation; not independent acceptance or user authorization.', '',
    ...section('Useful answer (explicit source summary)', p.answer ? [p.answer] : [], 'No explicit summary; abstaining rather than inventing one.'),
    ...(p.replies?.length ? ['## Conversation (assistant replies, verbatim and unreviewed)', '',
      ...p.replies.flatMap((r) => [`### Turn ${r.turn}`, '', ...(r.prompt ? [`**Prompt:** ${r.prompt}`, ''] : []),
        ...r.text.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')), '',
        `_Source: \`${r.locator.json_pointer}\`, SHA-256 of whole source text \`${r.locator.text_sha256}\`${r.truncated ? ', truncated at 20,000 chars' : ''}._`, '']),
    ] : []),
    ...section('Decisions (recorded claims, not approvals)', p.decisions, 'No explicit decisions identified.'),
    ...section('Next actions (proposals, not completed tasks)', p.actions, 'No explicit next actions identified.'),
    ...section('Unresolved questions', p.unresolved_questions, 'No explicitly labelled questions identified.'),
    ...section('Source-stated unknowns', p.source_stated_unknowns, 'No explicitly labelled unknowns identified.'),
    '## Evidence references', '',
    ...(p.evidence.length ? p.evidence.map((e) => `- **${e.id}**: ${e.source_file} ${e.json_pointer} line ${e.line}; SHA-256 of entire source text: \`${e.text_sha256}\`; exact line: ${JSON.stringify(e.quote)}`) : ['- No extractable cited evidence.']), '',
    '## Verification gaps', '', ...p.unknowns.map((x) => `- ${x}`), '',
    '**Delivery:** not attempted. **Owner use:** unmeasured. **QA acceptance:** not claimed.', ''
  ].join('\n');
}

export function verifyPacket(input, p) {
  for (const r of p.replies ?? []) {
    let value = input;
    for (const part of r.locator.json_pointer.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
      value = value[key];
    }
    if (typeof value !== 'string' || sha(value) !== r.locator.text_sha256 || !value.startsWith(r.text.slice(0, 20000))) return false;
  }
  for (const e of p.evidence) {
    if (!e.json_pointer.startsWith('#/')) return false;
    let value = input;
    for (const part of e.json_pointer.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
      value = value[key];
    }
    if (typeof value !== 'string' || sha(value) !== e.text_sha256 || value.split(/\r?\n/)[e.line - 1] !== e.quote) return false;
  }
  return true;
}

export function writeOutputs(packet, input, outDir, startedAt, sourceSha = null) {
  if (!verifyPacket(input, packet)) throw code('EVIDENCE_MISMATCH', 'Evidence pointers or content hashes failed verification');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString();
  const save = (p, obj) => writeFileSync(path.join(outDir, p), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n', { flag: 'w' });
  save('outcome-packet.json', packet);
  save('outcome-packet.md', renderMarkdown(packet));
  const qa = path.join(outDir, 'qa-v1', 'round-L4');
  mkdirSync(qa, { recursive: true });
  const runId = `value-oracle-${packet.session}`;
  const stepId = `${runId}/round-L4/outcome-packet`;
  const writeQa = (name, data) => writeFileSync(path.join(qa, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
  writeQa('run.json', { run_id: runId, round: 'L4', started_at: startedAt, ended_at: stamp, platform: process.platform, node: process.version, source_sha: sourceSha, fixture_id: packet.session, mode: 'offline-standalone', status: 'PASS', acceptance: 'self-test-only-not-qa-accepted', step_id: stepId });
  writeQa('steps.jsonl', JSON.stringify({ step_id: stepId, action: 'extract-verified-outcome-packet', started_at: startedAt, ended_at: stamp, result: 'PASS', evidence_ref: stepId, effect_class: 'local-file-write-only', known: ['input-shape', 'evidence-pointer-and-hash'], unknown: ['user-consumption', 'windows-integration'] }) + '\n');
  writeQa('metrics.json', { evidence_refs_checked: packet.evidence.length, evidence_refs_verified: packet.evidence.length, decisions_recorded: packet.decisions.length, proposals_recorded: packet.actions.length, questions_recorded: packet.unresolved_questions.length, elapsed_ms: Date.parse(stamp) - Date.parse(startedAt), ui_steps: null, owner_time_ms: null, results_opened: false, sends: 0, bytes_raw: null, recording_gaps: null });
  writeQa('failures.jsonl', '');
  writeQa('summary.md', `# Value Oracle V1 offline evidence receipt\n\nRun: \`${stepId}\` — PASS for local packet generation and source pointer verification only.\n\nOutput: \`outcome-packet.json\`, \`outcome-packet.md\`.\n\nSource: \`${packet.source.file}\`. Source SHA: ${sourceSha ?? 'UNKNOWN'}.\n\nNo Chrome, provider sends, capture acceptance, user use or independent QA acceptance were tested.\n`);
  return { outDir, qa, stepId };
}

export function runCli(args = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  const demo = args.includes('--demo');
  const get = (key) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : null; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const inputFile = demo ? path.join(here, '..', '..', 'test', 'fixtures', 'value-oracle', 'demo.json') : get('--input');
  if (!inputFile || (!demo && args.includes('--input') && !get('--input'))) throw code('USAGE', 'Usage: node outcome-packet.mjs --demo | --input transcript.json [--out LOCAL_FOLDER] [--source-sha SHA]');
  if (statSync(inputFile).size > MAX_INPUT_BYTES) throw code('OVERSIZE_INPUT', 'Input JSON exceeds 2 MiB');
  const input = JSON.parse(readFileSync(inputFile, 'utf8'));
  const packet = generatePacket(input, path.resolve(inputFile));
  const outDir = path.resolve(get('--out') ?? path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AION', 'capture-studio', 'outcome-packets', packet.session));
  const result = writeOutputs(packet, input, outDir, startedAt, get('--source-sha'));
  process.stdout.write(JSON.stringify({ status: 'PASS', session: packet.session, output: [path.join(result.outDir, 'outcome-packet.md'), path.join(result.outDir, 'outcome-packet.json')], qa_receipt: result.qa, evidence_verified: packet.evidence.length, delivery: 'not-attempted' }, null, 2) + '\n');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); } catch (err) { process.stderr.write(JSON.stringify({ status: 'FAIL', code: err.code ?? 'RUNTIME_ERROR', error: err.message }) + '\n'); process.exitCode = 1; }
}
