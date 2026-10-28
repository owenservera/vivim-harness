#!/usr/bin/env node
/**
 * Stage roadmap objectives 101–200 without conflating candidate source paths
 * with implemented capability or real-world acceptance evidence.
 *
 * Usage:
 *   node scripts/roadmap-source-index.mjs
 *   node scripts/roadmap-source-index.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROADMAP = 'docs/agents/CHATGPT-200-ROADMAP-OBJECTIVES.md';
const SYMBOL_INDEX = 'docs/agents/CHATGPT-100-SOURCE-INDEX.json';
const CANDIDATES = 'docs/agents/CHATGPT-200-SOURCE-CANDIDATES.json';
const OUTPUT = 'docs/agents/CHATGPT-200-ROADMAP-SOURCE-INDEX.json';
const idFor = (n) => String(n).padStart(3, '0');

export function buildRoadmapSourceIndex(markdown, sourceIndex, candidates = {}) {
  if (typeof markdown !== 'string' || !sourceIndex?.keys || typeof sourceIndex.keys !== 'object') {
    throw new TypeError('Roadmap Markdown and source symbol index are required');
  }
  if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)) {
    throw new TypeError('Candidates must be an object keyed by objective ID');
  }
  const objectives = [], ids = new Set(), sections = new Map();
  let section = null, pillar = null;
  for (const [lineNumber, line] of markdown.split(/\r?\n/).entries()) {
    const heading = line.match(/^##\s+(\d{2})\s+—\s+(.+?)\s*$/);
    if (heading) {
      section = { id: heading[1], name: heading[2].trim() };
      pillar = null;
      if (Number(section.id) >= 11 && Number(section.id) <= 20) {
        if (sections.has(section.id)) throw new Error('Duplicate roadmap section ' + section.id);
        sections.set(section.id, section.name);
      }
      continue;
    }
    const pillarMatch = line.match(/^\*Pillar:\s+(.+?)\*\s*$/);
    if (pillarMatch) { pillar = pillarMatch[1].trim(); continue; }
    const objective = line.match(/^\*\*(\d{3})\.\*\*\s+(.+?)\s*$/);
    if (!objective) continue;
    const id = objective[1], number = Number(id), expectedSection = 11 + Math.floor((number - 101) / 10);
    if (number < 101 || number > 200 || ids.has(id)) {
      throw new Error('Out-of-range or duplicate roadmap objective ' + id + ' at line ' + (lineNumber + 1));
    }
    if (!section || Number(section.id) !== expectedSection || !pillar) {
      throw new Error('Missing or incorrect section/pillar for ' + id + ' at line ' + (lineNumber + 1));
    }
    ids.add(id);
    const candidate = candidates[id] ?? null;
    if (candidate !== null && (!candidate || !Array.isArray(candidate.sourceKeys) || !candidate.sourceKeys.length || !candidate.gap)) {
      throw new Error('Invalid candidate entry for ' + id);
    }
    const candidateSourceKeys = candidate ? [...new Set(candidate.sourceKeys)] : [];
    for (const key of candidateSourceKeys) {
      if (typeof key !== 'string' || !Object.hasOwn(sourceIndex.keys, key)) {
        throw new Error('Unresolved candidate source key for ' + id + ': ' + String(key));
      }
    }
    objectives.push({
      id, sectionId: section.id, section: section.name, pillar,
      objective: objective[2].trim(),
      sourceReviewState: candidate ? 'candidate-only' : 'unassessed',
      candidateSourceKeys,
      firstMissingEvidence: candidate?.gap ?? null,
    });
  }
  const missing = Array.from({ length: 100 }, (_, i) => idFor(i + 101)).filter((id) => !ids.has(id));
  if (missing.length) throw new Error('Missing roadmap objectives: ' + missing.join(', '));
  const missingSections = Array.from({ length: 10 }, (_, i) => String(i + 11)).filter((id) => !sections.has(id));
  if (missingSections.length) throw new Error('Missing roadmap sections: ' + missingSections.join(', '));
  const unmatched = Object.keys(candidates).filter((id) => !ids.has(id));
  if (unmatched.length) throw new Error('Unknown candidate IDs: ' + unmatched.join(', '));
  objectives.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1, roadmap: ROADMAP, sourceIndex: SYMBOL_INDEX, candidateFile: CANDIDATES,
    evidence: 'Candidate source keys identify adjacent inspected code only. This index does not establish complete implementation, functional acceptance, or live provider verification.',
    counts: { objectives: objectives.length, sections: sections.size,
      candidateOnly: objectives.filter((o) => o.sourceReviewState === 'candidate-only').length,
      unassessed: objectives.filter((o) => o.sourceReviewState === 'unassessed').length },
    objectives,
  };
}

function main() {
  const mode = process.argv[2];
  if (mode && mode !== '--check') throw new Error('Usage: node scripts/roadmap-source-index.mjs [--check]');
  const roadmap = fs.readFileSync(path.join(ROOT, ROADMAP), 'utf8');
  const symbols = JSON.parse(fs.readFileSync(path.join(ROOT, SYMBOL_INDEX), 'utf8'));
  const candidates = JSON.parse(fs.readFileSync(path.join(ROOT, CANDIDATES), 'utf8'));
  const result = buildRoadmapSourceIndex(roadmap, symbols, candidates);
  const json = JSON.stringify(result, null, 2) + '\n';
  const destination = path.join(ROOT, OUTPUT);
  if (mode === '--check') {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== json) {
      throw new Error('Stale roadmap source index: run node scripts/roadmap-source-index.mjs');
    }
    console.log('ROADMAP_INDEX_OK ' + result.counts.objectives + ' CANDIDATES ' + result.counts.candidateOnly);
  } else {
    fs.writeFileSync(destination, json);
    console.log('ROADMAP_INDEX_WRITTEN ' + result.counts.objectives + ' CANDIDATES ' + result.counts.candidateOnly);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
