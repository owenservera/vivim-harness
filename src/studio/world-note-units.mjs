// Atomic note knowledge units (VD-0046). A note keeps its plain-text `body`; authoring may also
// supply discrete `blocks`. Units are the addressable projection of that content:
//   - `path` reuses the existing `[blockIndex]` partPath convention (world-search / selections),
//   - `id` is a local digest of the unit's own text, so an unchanged unit keeps the same address
//     when neighbouring units are edited, inserted or reordered,
//   - a plain note with no block structure is exactly one implicit unit covering the whole body.
// Unit ids never depend on the note id, so they survive export/import re-identification.
import { createHash } from 'node:crypto';
import { problem } from './http.mjs';

export const NOTE_UNIT_SCHEMA = 'vivim.note-units/1';
export const NOTE_BLOCK_TYPES = Object.freeze(['heading', 'paragraph', 'list-item', 'code', 'quote', 'divider']);
export const NOTE_UNIT_LIMITS = Object.freeze({ maxBlocks: 2000, maxBodyChars: 200000, maxBlockTextChars: 200000, maxUnitIdChars: 64 });
const BLOCK_TYPE_RE = /^[a-z][a-z0-9_+#-]{0,63}$/;
const UNIT_ID_RE = /^u-[a-z0-9]{1,60}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => problem(400, message, 'WORLD_INVALID_INPUT');

// Public address form used by relations/export: a note id plus a local unit fragment.
// Computed unit ids may carry an occurrence suffix (`u-<digest>-2`), so the fragment grammar allows it.
export const NOTE_UNIT_REF_RE = /^(n-[a-z0-9-]{1,60})#(u-[a-z0-9]{1,60}(?:-[0-9]{1,6})?)$/;

export function parseNoteUnitRef(value) {
  if (typeof value !== 'string') return null;
  const match = NOTE_UNIT_REF_RE.exec(value);
  return match ? { noteId: match[1], unitId: match[2], ref: value } : null;
}
export const noteUnitRef = (noteId, unitId) => `${noteId}#${unitId}`;

export function validateNoteBlocks(value) {
  if (!Array.isArray(value)) throw fail('Note blocks must be an array');
  if (value.length < 1 || value.length > NOTE_UNIT_LIMITS.maxBlocks) throw fail(`Note blocks must contain 1..${NOTE_UNIT_LIMITS.maxBlocks} units`);
  let total = 0;
  const seen = new Set();
  return value.map((block, index) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw fail(`Note block ${index} must be an object`);
    if (Object.keys(block).some((key) => FORBIDDEN.has(key))) throw fail(`Note block ${index} contains a forbidden key`);
    if (Object.keys(block).some((key) => !['unitId', 'type', 'text', 'label'].includes(key))) throw fail(`Note block ${index} has an unknown field`);
    const type = block.type === undefined ? 'paragraph' : block.type;
    if (typeof type !== 'string' || !BLOCK_TYPE_RE.test(type)) throw fail(`Note block ${index} has an invalid type`);
    const text = block.text === undefined ? '' : block.text;
    if (typeof text !== 'string') throw fail(`Note block ${index} text must be a string`);
    if (text.length > NOTE_UNIT_LIMITS.maxBlockTextChars) throw fail(`Note block ${index} text is too long`);
    total += text.length;
    if (total > NOTE_UNIT_LIMITS.maxBodyChars) throw fail(`Note blocks exceed ${NOTE_UNIT_LIMITS.maxBodyChars} characters of text`);
    let unitId;
    if (block.unitId !== undefined) {
      if (typeof block.unitId !== 'string' || !UNIT_ID_RE.test(block.unitId)) throw fail(`Note block ${index} unitId must look like u-<token>`);
      if (seen.has(block.unitId)) throw fail(`Duplicate note unit id ${block.unitId}`);
      seen.add(block.unitId); unitId = block.unitId;
    }
    const label = block.label === undefined ? null : block.label;
    if (label !== null && (typeof label !== 'string' || label.length > 200)) throw fail(`Note block ${index} label must be a short string`);
    return { unitId, type, text, label };
  });
}

// Canonical plain text of a block note. `body` stays the one stored, searchable, exported text.
export const noteBodyFromBlocks = (blocks) => blocks.map((block) => block.text).filter((text) => typeof text === 'string' && text.length > 0).join('\n\n');

// Stable, content-derived unit id. Identical texts in one note are disambiguated by occurrence, and
// a computed id never takes an id an author already claimed, so every address is unique in its note.
function assignUnitIds(entries, noteId) {
  const taken = new Set(entries.map((entry) => entry.unitId).filter(Boolean));
  const occurrences = new Map();
  return entries.map((entry) => {
    if (entry.unitId) return { ...entry, id: entry.unitId, stability: 'authored' };
    const base = `u-${digest(entry.text).slice(0, 16)}`;
    let seen = occurrences.get(base) ?? 0, id;
    do { seen += 1; id = seen === 1 ? base : `${base}-${seen}`; } while (taken.has(id));
    occurrences.set(base, seen); taken.add(id);
    return { ...entry, id, stability: 'content-digest' };
  }).map((entry, index) => ({ ...entry, noteId, index, path: [index] }));
}

// The addressable units of a note, in body order. Never mutates or re-stores the record.
export function noteUnits(note) {
  const noteId = typeof note?.id === 'string' ? note.id : null;
  const blocks = Array.isArray(note?.blocks) && note.blocks.length ? note.blocks : null;
  if (blocks) {
    const entries = blocks.map((block) => ({
      unitId: typeof block?.unitId === 'string' && UNIT_ID_RE.test(block.unitId) ? block.unitId : null,
      type: typeof block?.type === 'string' && BLOCK_TYPE_RE.test(block.type) ? block.type : 'paragraph',
      text: typeof block?.text === 'string' ? block.text : '',
      label: typeof block?.label === 'string' ? block.label : null,
      implicit: false,
    }));
    return assignUnitIds(entries, noteId).map((unit) => ({ id: unit.id, noteId, path: unit.path, index: unit.index,
      type: unit.type, text: unit.text, textLength: unit.text.length, label: unit.label,
      digest: digest(unit.text).slice(0, 32), implicit: false, stability: unit.stability }));
  }
  const body = typeof note?.body === 'string' ? note.body : '';
  if (!body.length) return [];
  // No block structure: the whole body is one implicit unit, addressed as block 0.
  const [unit] = assignUnitIds([{ unitId: null, type: 'paragraph', text: body, label: null }], noteId);
  return [{ id: unit.id, noteId, path: [0], index: 0, type: 'paragraph', text: body, textLength: body.length,
    label: null, digest: digest(body).slice(0, 32), implicit: true, stability: 'single-implicit-unit' }];
}

// Accepts a unit id, a `[blockIndex]` path, a bare index, or a `b<index>` token.
export function resolveNoteUnit(units, address) {
  if (!Array.isArray(units) || !units.length) return null;
  if (typeof address === 'string' && /^u-/.test(address)) return units.find((unit) => unit.id === address) ?? null;
  let index = null;
  if (typeof address === 'number') index = address;
  else if (typeof address === 'string' && /^b?\d+$/.test(address)) index = Number(address.replace(/^b/, ''));
  else if (Array.isArray(address) && address.length === 1 && Number.isSafeInteger(address[0])) index = address[0];
  else if (address && typeof address === 'object') {
    if (typeof address.unitId === 'string') return units.find((unit) => unit.id === address.unitId) ?? null;
    if (Array.isArray(address.path)) return resolveNoteUnit(units, address.path);
    return null;
  }
  if (index === null || !Number.isSafeInteger(index) || index < 0) return null;
  return units[index] ?? null;
}

// Addressing descriptor surfaced to callers so the convention is explicit, not inferred.
export const noteUnitAddressing = (note) => {
  const units = noteUnits(note);
  return { schema: NOTE_UNIT_SCHEMA, unitCount: units.length, structured: Array.isArray(note?.blocks) && note.blocks.length > 0,
    pathConvention: 'partPath [blockIndex] names note.blocks[i]; unit ids are content-derived local addresses',
    refForm: 'n-<id>#u-<token>', qualification: 'local address inside one user-authored note; not a provider identity' };
};
