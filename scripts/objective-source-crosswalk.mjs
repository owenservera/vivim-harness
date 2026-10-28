#!/usr/bin/env node
/**
 * Derive a deterministic objective-to-source crosswalk from the canonical
 * Markdown map and symbol index. This is source evidence, NOT live verification.
 *
 * Usage:
 *   node scripts/objective-source-crosswalk.mjs
 *   node scripts/objective-source-crosswalk.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = 'docs/agents/CHATGPT-100-SOURCE-MAP.md';
const SYMBOLS = 'docs/agents/CHATGPT-100-SOURCE-INDEX.json';
const OUTPUT = 'docs/agents/CHATGPT-100-OBJECTIVE-SOURCE-INDEX.json';
const pad = (n) => String(n).padStart(3, '0');

export function buildObjectiveSourceCrosswalk(markdown, symbolIndex) {
  if (typeof markdown !== 'string' || !symbolIndex?.keys || typeof symbolIndex.keys !== 'object') {
    throw new TypeError('A Markdown source map and a symbol index with keys are required');
  }
  const objectives = [];
  const ids = new Set();
  const distinctKeys = new Set();
  const counts = { mapped: 0, supported: 0, partial: 0, unsupported: 0, distinctSourceKeys: 0 };
  const tick = String.fromCharCode(96);
  const keyPattern = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
  for (const [offset, line] of markdown.split(/\r?\n/).entries()) {
    if (!/^\|\s*\d{3}\s*\|/.test(line)) continue;
    const columns = line.split('|').slice(1, -1).map((value) => value.trim());
    if (columns.length !== 6) throw new Error('Malformed objective row at line ' + (offset + 1));
    const [id, title, classification, sourceCell, missingLink] = columns;
    if (Number(id) < 1 || Number(id) > 100 || ids.has(id)) {
      throw new Error('Out-of-range or duplicate objective ' + id + ' at line ' + (offset + 1));
    }
    if (!['supported', 'partial', 'unsupported'].includes(classification)) {
      throw new Error('Invalid source classification for ' + id + ': ' + classification);
    }
    const sourceKeys = [...new Set([...sourceCell.matchAll(keyPattern)].map((match) => match[1]))];
    if (!title || !sourceKeys.length) throw new Error('Missing title or source keys for ' + id);
    for (const key of sourceKeys) {
      if (!Object.hasOwn(symbolIndex.keys, key)) {
        throw new Error('Unresolved source reference ' + id + ': ' + key);
      }
      distinctKeys.add(key);
    }
    ids.add(id);
    counts[classification]++;
    objectives.push({
      id,
      title,
      sourceClassification: classification,
      sourceKeys,
      firstMissingLink: missingLink === '—' ? null : missingLink,
    });
  }
  const missing = Array.from({ length: 100 }, (_, i) => pad(i + 1)).filter((id) => !ids.has(id));
  if (missing.length) throw new Error('Missing objective IDs: ' + missing.join(', '));
  objectives.sort((a, b) => a.id.localeCompare(b.id));
  counts.mapped = objectives.length;
  counts.distinctSourceKeys = distinctKeys.size;
  return {
    schemaVersion: 1,
    sourceMap: MAP,
    symbolIndex: SYMBOLS,
    evidence: 'Source-map references only. Unsupported/partial citations may identify an adjacent primitive or gap; none establish live provider behavior.',
    counts,
    objectives,
  };
}

function main() {
  const mode = process.argv[2];
  if (mode && mode !== '--check') {
    throw new Error('Usage: node scripts/objective-source-crosswalk.mjs [--check]');
  }
  const map = fs.readFileSync(path.join(ROOT, MAP), 'utf8');
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, SYMBOLS), 'utf8'));
  const result = buildObjectiveSourceCrosswalk(map, index);
  const json = JSON.stringify(result, null, 2) + '\n';
  const destination = path.join(ROOT, OUTPUT);
  if (mode === '--check') {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== json) {
      throw new Error('Stale objective-source index: run node scripts/objective-source-crosswalk.mjs');
    }
    console.log('CROSSWALK_OK ' + result.counts.mapped + ' SOURCES ' + result.counts.distinctSourceKeys);
  } else {
    fs.writeFileSync(destination, json);
    console.log('CROSSWALK_WRITTEN ' + result.counts.mapped + ' SOURCES ' + result.counts.distinctSourceKeys + ' -> ' + OUTPUT);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
