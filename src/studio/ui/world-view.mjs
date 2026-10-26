/** Saved local world inside the existing /chat shell.
 * Conversations, projects and notes are peer views of shared ids.
 * No home object and no second renderer. Reading and local edits only.
 * Importing this file does nothing until mountWorldView runs.
 */

export const WORLD_API = '/api/v1/world';
export const PAGE_LIMIT = 50;
export const VIEWS = Object.freeze(['conversations', 'projects', 'notes']);
export const FIND_KINDS = Object.freeze(['message', 'project', 'note', 'source-reference', 'selection']);
const FIND_LABELS = { message: 'Messages', project: 'Projects', note: 'Notes', 'source-reference': 'Local objects', selection: 'Selections' };
const SHELL_VIEWS = new Set(['capture', 'find', 'transfer', 'relations', 'workspace', ...VIEWS]);
const STANDARD_RELATION_BASIS = 'local association; not native equality';
const EXPORT_MODE_LABEL = { references: 'References only — no message text', transcript: 'Transcript — saved message text and simple formatting', 'full-saved': 'Full saved — every recorded block' };
const EXPORT_OMIT_LABEL = { 'reasoning-blocks-excluded': 'Saved reasoning blocks left out', 'tool-activity-blocks-excluded': 'Tool and status activity blocks left out', 'non-transcript-blocks-excluded': 'Blocks Studio does not recognize left out' };
const ID_RE = { conversations: /^c-[a-z0-9-]{1,60}$/, projects: /^p-[a-z0-9-]{1,60}$/, notes: /^n-[a-z0-9-]{1,60}$/ };

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

export function labelize(key) {
  const spaced = String(key ?? '').replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!spaced) return 'Detail';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatMeta(value) {
  if (value == null) return 'not recorded';
  if (typeof value === 'string') return clip(value, 180);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    return text ? clip(text, 180) : 'recorded';
  } catch { return 'recorded'; }
}

function integerOrNull(value) { return Number.isInteger(value) ? value : null; }

export function problemText(data) {
  const msg = typeof data?.message === 'string' && data.message ? data.message
    : typeof data?.error === 'string' && data.error ? data.error : '';
  return msg || (typeof data?.code === 'string' && data.code ? data.code : 'Studio rejected this.');
}

export function safeHttp(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export function roleLabel(role) {
  if (role === 'user' || role === 'human') return 'You';
  if (role === 'assistant' || role === 'ai' || role === 'model' || role === 'bot') return 'Assistant';
  if (role === 'system') return 'System';
  if (role === 'tool') return 'Tool';
  if (typeof role === 'string' && role.trim()) return role.trim();
  return 'Unknown role';
}

export function redactionNote(redactions) {
  if (redactions == null || redactions === false || redactions === 0) return '';
  if (typeof redactions === 'number') return `Redactions were applied before this was saved (${redactions}). Removed text is not shown.`;
  if (Array.isArray(redactions)) return `Redactions were applied before this was saved (${redactions.length}). Removed text is not shown.`;
  return 'Redactions were applied before this was saved. Removed text is not shown.';
}

export function coverageView(coverage) {
  const c = coverage && typeof coverage === 'object' ? coverage : {};
  const state = typeof c.state === 'string' && c.state ? c.state : 'unknown';
  const labels = {
    missing: ['Saved messages: missing', 't-bad'],
    partial: ['Saved messages: partial', 't-warn'],
    unavailable: ['Saved messages: unavailable', 't-warn'],
    'saved-observation': ['Saved local observation', 't-info'],
    'imported-snapshot': ['Imported snapshot', 't-warn'],
  };
  const chips = [labels[state] ?? [`Coverage: ${state}`, 't-warn']];
  const full = c.fullNativeThread;
  chips.push(full == null || full === 'unknown'
    ? ['Full remote thread: unknown', 't-warn']
    : [`Full remote thread: ${full}`, 't-info']);
  const rich = c.richContent;
  chips.push(rich === 'as-recorded'
    ? ['Rich parts: as recorded', 't-info']
    : rich === 'imported-as-supplied'
      ? ['Rich parts: as supplied in the import', 't-warn']
      : rich === 'missing'
        ? ['Rich parts: missing', 't-warn']
        : [`Rich parts: ${rich ?? 'unknown'}`, 't-warn']);
  const known = new Set(['state', 'fullNativeThread', 'richContent', 'reason']);
  const extra = [];
  for (const [key, value] of Object.entries(c)) {
    if (known.has(key)) continue;
    extra.push({
      label: key === 'acceptance' ? 'Acceptance' : labelize(key),
      value: key === 'acceptance' && value === 'not-assessed' ? 'not assessed' : formatMeta(value),
    });
  }
  const sentence = state === 'saved-observation'
    ? 'This is a saved local observation. It is not a claim that the remote thread is complete.'
    : state === 'partial'
      ? 'Only part of the saved session was usable. The remote thread is still unknown.'
      : state === 'missing'
        ? 'No saved messages were found for this session.'
        : state === 'unavailable'
          ? `Saved messages could not be read${typeof c.reason === 'string' && c.reason ? ` (${c.reason})` : ''}. This is not an empty conversation.`
          : state === 'imported-snapshot'
            ? 'This is an imported snapshot from a JSON bundle, not a recording Studio observed.'
            : 'Coverage is not one of the known states. Nothing here was marked complete.';
  return { chips, extra, sentence };
}

function namedFact(label, node) {
  if (!node || typeof node !== 'object') return { label, value: 'unknown' };
  const value = node.value == null || node.value === '' ? 'not recorded' : formatMeta(node.value);
  const state = typeof node.state === 'string' && node.state ? node.state : 'unknown';
  const basis = typeof node.basis === 'string' && node.basis ? ` Basis: ${node.basis}.` : '';
  return { label, value: `${value} (${state}).${basis}` };
}

export function identityRows(identity) {
  const item = identity && typeof identity === 'object' ? identity : {};
  const state = typeof item.state === 'string' && item.state ? item.state : 'unknown';
  const rows = [
    { label: 'Remote thread', value: state },
    { label: 'Native thread id', value: item.nativeThreadId == null || item.nativeThreadId === '' ? 'not recorded' : formatMeta(item.nativeThreadId) },
    { label: 'Account', value: item.accountId == null || item.accountId === '' ? 'not recorded' : formatMeta(item.accountId) },
  ];
  if (item.provider && typeof item.provider === 'object') rows.push(namedFact('Provider', item.provider));
  if (item.origin && typeof item.origin === 'object') rows.push(namedFact('Origin', item.origin));
  if (item.thread && typeof item.thread === 'object') {
    const threadState = typeof item.thread.state === 'string' && item.thread.state ? item.thread.state : 'unknown';
    rows.push({
      label: 'Thread basis',
      value: threadState === 'qualified-inference'
        ? 'Qualified inference from the saved address. Not account proof, and not a merge with another saved conversation.'
        : threadState,
    });
  }
  if (item.account && typeof item.account === 'object') {
    rows.push({ label: 'Account state', value: typeof item.account.state === 'string' && item.account.state ? item.account.state : 'unknown' });
  }
  if (typeof item.qualification === 'string' && item.qualification) rows.push({ label: 'Qualification', value: item.qualification });
  if (typeof item.observedAt === 'string' && item.observedAt) rows.push({ label: 'Observed at', value: item.observedAt });
  const known = new Set(['state', 'nativeThreadId', 'accountId', 'provider', 'origin', 'thread', 'account', 'qualification', 'observedAt']);
  for (const [key, value] of Object.entries(item)) if (!known.has(key)) rows.push({ label: labelize(key), value: formatMeta(value) });
  if (state === 'unknown') rows.push({ label: 'Meaning', value: 'Unknown is not proof this conversation is only local, and the same title elsewhere is not the same conversation.' });
  else if (state === 'partial') rows.push({ label: 'Meaning', value: 'Partial means a saved address was parsed. It does not prove the account or the full remote thread.' });
  return rows;
}

export function sourceRows(source) {
  const item = source && typeof source === 'object' ? source : {};
  const kind = item.kind === 'saved-session' ? 'Saved session on this computer'
    : typeof item.kind === 'string' && item.kind ? item.kind : 'unknown';
  const rows = [
    { label: 'Where it was saved', value: kind },
    { label: 'Session', value: typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : 'unknown' },
    { label: 'Provider address', value: typeof item.providerUrl === 'string' && item.providerUrl ? item.providerUrl : 'not recorded' },
  ];
  const known = new Set(['kind', 'sessionId', 'providerUrl']);
  for (const [key, value] of Object.entries(item)) if (!known.has(key)) rows.push({ label: labelize(key), value: formatMeta(value) });
  return rows;
}

export function messageSourceRows(source) {
  const item = source && typeof source === 'object' ? source : {};
  const rows = [
    { label: 'Session', value: typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : 'unknown' },
    { label: 'Record', value: item.key === 'DOM_TURNS' ? 'Recorded page turns (DOM_TURNS)' : typeof item.key === 'string' && item.key ? item.key : 'unknown' },
    { label: 'Index', value: Number.isInteger(item.index) ? String(item.index) : 'unknown' },
    { label: 'Observed id', value: item.observedTurnId == null || item.observedTurnId === '' ? 'not recorded' : formatMeta(item.observedTurnId) },
  ];
  const known = new Set(['sessionId', 'key', 'index', 'observedTurnId']);
  for (const [key, value] of Object.entries(item)) if (!known.has(key)) rows.push({ label: labelize(key), value: formatMeta(value) });
  return rows;
}

function fence(lang, text) {
  const body = String(text);
  const runs = body.match(/`+/g) ?? [];
  const width = Math.max(3, ...runs.map((run) => run.length + 1));
  const bar = '`'.repeat(Number.isFinite(width) ? width : 3);
  const safeLang = typeof lang === 'string' && /^[\w+#.-]{1,32}$/.test(lang) ? lang : '';
  return `${bar}${safeLang}\n${body}\n${bar}`;
}

function tableMarkdown(block) {
  const head = Array.isArray(block.headers) ? block.headers : Array.isArray(block.head) ? block.head : null;
  const rows = Array.isArray(block.rows) ? block.rows : null;
  if (!head || !rows || !head.length) return '';
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  const heads = head.map(cell);
  const lines = [
    `| ${heads.join(' | ')} |`,
    `| ${heads.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => {
      const cells = Array.isArray(row) ? row : [];
      return `| ${heads.map((_, index) => cell(cells[index])).join(' | ')} |`;
    }),
  ];
  return lines.join('\n');
}

function unknownPart(type) {
  const label = typeof type === 'string' && /^[a-z0-9][a-z0-9 +_.:-]{0,60}$/i.test(type) ? type : 'unknown';
  return { type: label, note: `Recorded part (${label}). Studio does not know how to format it, so it is not shown as content.` };
}

/** Only links recorded inside this saved paragraph/heading; never inferred citations. */
export function savedInlineLinks(block) {
  if (!['paragraph', 'heading'].includes(block?.type)) return [];
  const seen = new Set(), links = [];
  for (const part of Array.isArray(block.inline) ? block.inline : []) {
    if (part?.t !== 'link' && part?.t !== 'citation') continue;
    const href = safeHttp(part.href);
    const label = typeof part.text === 'string' && part.text.trim() ? clip(part.text.trim(), 120) : 'Recorded link';
    const key = JSON.stringify([part.t, label, href]);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ kind: part.t, label, href, basis: 'link observed in saved page, not source verification' });
  }
  return links;
}

function blockToMarkdown(block, lines, unknowns, depth) {
  if (!block || typeof block !== 'object' || depth > 8) { unknowns.push(unknownPart('unknown')); return; }
  const type = (typeof block.type === 'string' && block.type) || (typeof block.kind === 'string' && block.kind) || 'unknown';
  const text = typeof block.text === 'string' ? block.text : null;
  if (type === 'paragraph') {
    if (text == null) unknowns.push(unknownPart(type)); else lines.push(text, '');
    return;
  }
  if (type === 'heading') {
    if (text == null) { unknowns.push(unknownPart(type)); return; }
    const level = Number.isInteger(block.level) ? Math.min(6, Math.max(1, block.level)) : 2;
    lines.push(`${'#'.repeat(level)} ${text.replace(/\r?\n/g, ' ')}`, '');
    return;
  }
  if (type === 'code') {
    if (text == null) unknowns.push(unknownPart(type)); else lines.push(fence(block.language || block.lang, text), '');
    return;
  }
  if (type === 'table') {
    const markdown = tableMarkdown(block);
    if (!markdown) unknowns.push(unknownPart(type)); else lines.push(markdown, '');
    return;
  }
  if (type === 'list') {
    const items = Array.isArray(block.items) ? block.items : null;
    if (!items) { unknowns.push(unknownPart(type)); return; }
    const start = Number.isInteger(block.start) && block.start > 0 ? block.start : 1;
    items.forEach((item, index) => {
      const nested = [];
      if (item && typeof item.text === 'string') nested.push(item.text);
      else if (item && Array.isArray(item.blocks)) item.blocks.forEach((child) => blockToMarkdown(child, nested, unknowns, depth + 1));
      else unknowns.push(unknownPart('list item'));
      const body = nested.join('\n').trim();
      if (!body) return;
      const marker = block.ordered ? `${start + index}. ` : '- ';
      const parts = body.split('\n');
      lines.push(marker + parts[0]);
      for (const extra of parts.slice(1)) lines.push(`${block.ordered ? '   ' : '  '}${extra}`);
    });
    lines.push('');
    return;
  }
  if (type === 'quote' || type === 'figure' || type === 'details') {
    const nested = [];
    if (typeof block.summary === 'string' && block.summary) nested.push(block.summary, '');
    if (typeof block.caption === 'string' && block.caption) nested.push(block.caption, '');
    const children = Array.isArray(block.blocks) ? block.blocks : [];
    if (!children.length && text != null) nested.push(text, '');
    children.forEach((child) => blockToMarkdown(child, nested, unknowns, depth + 1));
    const body = nested.join('\n').trim();
    if (!body) { unknowns.push(unknownPart(type)); return; }
    lines.push(type === 'quote' ? body.split('\n').map((line) => `> ${line}`).join('\n') : body, '');
    return;
  }
  if (type === 'rule') { lines.push('---', ''); return; }
  if (type === 'equation') {
    if (typeof block.tex === 'string') lines.push(fence('tex', block.tex), ''); else unknowns.push(unknownPart(type));
    return;
  }
  if (type === 'image') {
    const alt = typeof block.alt === 'string' && block.alt ? block.alt : 'Image';
    const href = safeHttp(block.src);
    if (href) lines.push(`![${alt.replace(/[\[\]]/g, '')}](${href})`, '');
    unknowns.push({ type, note: `Image recorded${typeof block.alt === 'string' && block.alt ? ` (${clip(block.alt, 80)})` : ''}. Studio does not load it.` });
    return;
  }
  if (type === 'file') {
    const href = safeHttp(block.href);
    const name = typeof block.name === 'string' && block.name ? clip(block.name, 80) : 'File';
    if (href) lines.push(`[${name.replace(/[\[\]]/g, '')}](${href})`, '');
    unknowns.push({ type, note: `File recorded (${name}). Studio does not download it.` });
    return;
  }
  if (type === 'media') {
    const kind = block.kind === 'audio' || block.kind === 'video' ? block.kind : 'media';
    unknowns.push({ type, note: `Recorded ${kind}. Studio does not play it.` });
    return;
  }
  if (type === 'graphic') { unknowns.push({ type, note: 'Graphic recorded. Studio does not redraw it.' }); return; }
  const label = labelledPart(type);
  if (label) {
    lines.push(`## ${label}`, '');
    const recorded = typeof text === 'string' ? text : (typeof block.summary === 'string' ? block.summary : null);
    if (recorded) lines.push(recorded, '');
    const nested = Array.isArray(block.blocks) ? block.blocks : Array.isArray(block.parts) ? block.parts : [];
    if (nested.length) {
      for (const kid of nested.slice(0, 64)) blockToMarkdown(kid, lines, unknowns, depth + 1);
    } else if (!recorded) {
      unknowns.push({ type, note: `${label}. The details of this part were not formatted and are not shown.` });
    }
    return;
  }
  unknowns.push(unknownPart(type));
}

function labelledPart(type) {
  const key = String(type).toLowerCase().replace(/[_\s]+/g, '-');
  if (['reasoning', 'thinking', 'visible-thinking', 'visible-thinking-summary'].includes(key)) return 'Reasoning (saved)';
  if (['status', 'progress'].includes(key)) return 'Status';
  if (['tool', 'tool-call', 'tool-activity', 'tool-activity-observed'].includes(key)) return 'Tool call: stage as recorded';
  return '';
}

/** Thin adaptation of saved DOM blocks. Unknown parts stay labels; their payloads are not copied into text. */
export function turnPlan(message) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  const lines = [];
  const unknowns = [];
  if (blocks.length) blocks.forEach((block) => blockToMarkdown(block, lines, unknowns, 0));
  let markdown = lines.join('\n').trim();
  let note = '';
  if (!markdown && typeof message?.text === 'string' && message.text) {
    markdown = message.text;
    note = blocks.length
      ? 'Saved text. The recorded parts could not be formatted, so this is the saved text only.'
      : 'Saved text. No separate rich parts were recorded with this turn.';
  } else if (!markdown && !unknowns.length) note = 'No text saved for this turn.';
  return { markdown, note, unknowns, truncated: message?.truncated === true,
    truncatedOriginalLength: Number.isSafeInteger(message?.truncatedOriginalLength) && message.truncatedOriginalLength > 0
      ? message.truncatedOriginalLength : null,
    redactionNote: redactionNote(message?.redactions) };
}

/** One entry per top-level saved block, so a rendered part can carry its own data-part-path marker.
 * The marker value is the same part path the selection API records ([blockIndex]); the path is
 * stringified for the attribute. Blocks that produce no renderable text produce no frame. */
export function planFrames(message) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  return blocks.map((block, index) => {
    const lines = [];
    const unknowns = [];
    blockToMarkdown(block, lines, unknowns, 0);
    return { path: [index], markdown: lines.join('\n').trim(), links: savedInlineLinks(block) };
  });
}

export function searchStatusText({ shown = 0, total = null, coverage = null } = {}) {
  const count = Number.isInteger(total) ? `${shown} of ${total} matches in this scan` : `${shown} matches in this scan`;
  const incomplete = !coverage || coverage.complete === false || coverage.truncated === true;
  return incomplete ? `${count}. This scan is incomplete.` : `${count}.`;
}

export function searchCoverageLines(coverage) {
  if (!coverage || typeof coverage !== 'object') {
    return ['This scan did not report coverage. The match count is not everything that exists.'];
  }
  const lines = [];
  if (coverage.complete !== true) lines.push('This scan is incomplete. The match count is not everything saved here, and it says nothing about remote content.');
  if (coverage.truncated === true) lines.push('The scan stopped before it had read every local record in its bounds.');
  for (const reason of Array.isArray(coverage.reasons) ? coverage.reasons : []) {
    if (typeof reason === 'string' && reason) lines.push(`Stopped because: ${reason}.`);
  }
  const absent = Number.isInteger(coverage.absent?.conversations) ? coverage.absent.conversations : 0;
  if (absent > 0) lines.push(`${absent} saved conversations had no recorded messages in this scan.`);
  const failures = Array.isArray(coverage.failures) ? coverage.failures : [];
  if (failures.length) {
    lines.push(`${failures.length} reads failed.`);
    for (const failure of failures.slice(0, 3)) {
      const message = typeof failure?.message === 'string' && failure.message ? failure.message : failure?.code;
      if (typeof message === 'string' && message) lines.push(message);
    }
  }
  if (typeof coverage.qualification === 'string' && coverage.qualification) lines.push(coverage.qualification);
  return lines;
}

export const IMPORT_BYTE_CAP = 8 * 1024 * 1024;

export function isExportBundle(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data) && data.schema === 'vivim.world-export/1' && Array.isArray(data.records) && typeof data.integrity?.sha256 === 'string';
}

export function validWorldId(id) {
  return typeof id === 'string' && (/^c-(?:[a-f0-9]{40}|i[a-f0-9]{38})$/.test(id)
    || /^[npos]-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    || /^[npos]-[a-f0-9]{36}f$/.test(id));
}

export function custodyChip(item) {
  const custody = item?.custody;
  const coverage = item?.coverage?.state ?? item?.coverageState?.state ?? item?.coverageState;
  if (custody === 'imported' || custody === 'imported-snapshot' || coverage === 'imported-snapshot') return ['Imported snapshot', 't-warn'];
  return null;
}

// Chip for a reading pane or focus header: the map node the user clicked decides first, so the
// pane never contradicts the list; a stored record's custody/coverage can still correct an
// unknown onto Imported snapshot instead of a bare unknown.
export function readerProvenanceChip(node, record) {
  for (const candidate of [node, record]) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (candidate.provenance || candidate.custody) {
      const chip = provenanceChip(candidate);
      if (chip[0] !== 'Provenance unknown') return chip;
    }
    if (custodyChip(candidate) || candidate.coverage?.state === 'imported-snapshot'
      || candidate.coverageState?.state === 'imported-snapshot' || candidate.coverageState === 'imported-snapshot') {
      return ['Imported snapshot', 't-warn'];
    }
  }
  return provenanceChip(node ?? record ?? {});
}

// What a saved object/selection actually addresses, as labelled rows. No payloads, no dumps.
export function referenceReaderRows(item) {
  const source = item?.source && typeof item.source === 'object' ? item.source : null;
  const rows = [];
  if (item?.objectType) rows.push({ label: 'Object type', value: item.objectType });
  if (item?.conversationId) rows.push({ label: 'Source conversation', value: item.conversationId });
  if (item?.selectionType) rows.push({ label: 'Selection type', value: item.selectionType });
  if (item?.objectId) rows.push({ label: 'Parent object', value: item.objectId });
  if (Number.isInteger(source?.messageIndex)) rows.push({ label: 'Message index', value: String(source.messageIndex) });
  if (Array.isArray(source?.partPath) && source.partPath.length) rows.push({ label: 'Part path', value: source.partPath.map((key) => String(key)).join(' > ') });
  if (typeof source?.revision === 'string' && source.revision) rows.push({ label: 'Pinned revision', value: source.revision });
  return rows;
}

export function importedFromLines(importedFrom) {
  if (!importedFrom || typeof importedFrom !== 'object') return [];
  const digest = typeof importedFrom.digest === 'string' ? importedFrom.digest : '';
  const lines = [];
  if (digest) lines.push({ label: 'Import digest', value: digest.slice(0, 12) });
  if (typeof importedFrom.originalId === 'string' && importedFrom.originalId) lines.push({ label: 'Original id', value: importedFrom.originalId });
  return lines;
}

export function custodyCounts(records) {
  const counts = {};
  for (const record of Array.isArray(records) ? records : []) {
    const key = typeof record?.custody === 'string' && record.custody ? record.custody : 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function checkReady(report) {
  return !!(report && report.valid === true && typeof report.digest === 'string' && report.digest);
}

export function restoreSummary(report) {
  if (!report || typeof report !== 'object') return { success: false, text: 'Restore did not return a report. Nothing was marked successful.' };
  const failed = Array.isArray(report.failed) ? report.failed.length : 0;
  const applied = Array.isArray(report.applied) ? report.applied.length : 0;
  const skipped = Array.isArray(report.skipped) ? report.skipped.length : 0;
  const pending = Array.isArray(report.pending) ? report.pending.length : 0;
  if (report.dryRun === true) return { success: false, text: `Dry run only. Nothing was written. ${pending} still pending, ${applied} applied, ${skipped} skipped.` };
  if (report.valid === false) return { success: false, text: 'Not restored. The bundle did not check out.' };
  if (failed > 0) return { success: false, text: `Restore failed for ${failed} records${report.partial === true ? ' and is partial' : ''}. This is not a success.` };
  if (report.partial === true) return { success: false, text: `Restore is partial. ${applied} applied, ${skipped} skipped, ${pending} pending. This is not a complete success.` };
  if (!report.receipt) return { success: false, text: 'Restore did not return a receipt. Nothing was marked successful.' };
  if (applied === 0) return { success: false, text: `Nothing new was written. ${skipped} skipped. This is not a success.` };
  return { success: true, text: `Restore finished. ${applied} applied, ${skipped} skipped. Receipt ${typeof report.receipt === 'string' ? report.receipt : formatMeta(report.receipt)}.` };
}

export function provenanceChip(node) {
  if (node?.availability === 'unresolved' || node?.availabilityReason === 'NOT_SCANNED') return ['Not scanned / unresolved', 't-warn'];
  const provenance = node?.provenance;
  const custody = node?.custody;
  if (provenance === 'imported-snapshot' || custody === 'imported' || custody === 'imported-snapshot') return ['Imported snapshot', 't-warn'];
  if (provenance === 'user-authored' || provenance === 'user-selected' || provenance === 'user-linked-source') return ['Yours', 't-info'];
  if (provenance === 'source-observation') return ['Observed', 't-mute'];
  return ['Provenance unknown', 't-warn'];
}

function relationGroupRank(kind) {
  return kind === 'associates' ? 0 : kind === 'comments_on' ? 1 : kind === 'references' ? 2 : 3;
}
function relationLabel(kind, outgoing) {
  if (kind === 'associates') return 'Associates';
  if (kind === 'comments_on') return outgoing ? 'Comments on' : 'Commented on by';
  if (kind === 'references') return outgoing ? 'References' : 'Referenced by';
  const safe = /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(kind) ? kind : 'unknown';
  return outgoing ? `Unrecognised relation: ${safe}` : `Unrecognised relation: ${safe} (incoming)`;
}

export function relationGroups(focusId, map) {
  const nodes = new Map((Array.isArray(map?.nodes) ? map.nodes : []).filter((node) => node && typeof node.id === 'string').map((node) => [node.id, node]));
  const order = [], byKey = new Map();
  for (const edge of Array.isArray(map?.edges) ? map.edges : []) {
    if (!edge || (edge.from !== focusId && edge.to !== focusId)) continue;
    const outgoing = edge.from === focusId;
    const otherId = outgoing ? edge.to : edge.from;
    if (typeof otherId !== 'string' || !otherId) continue;
    const kind = typeof edge.kind === 'string' && edge.kind ? edge.kind : 'unknown';
    const key = `${kind}:${outgoing ? 'out' : 'in'}`;
    let group = byKey.get(key);
    if (!group) { group = { kind, outgoing, label: relationLabel(kind, outgoing), rows: [] }; byKey.set(key, group); order.push(group); }
    group.rows.push({ id: otherId, node: nodes.get(otherId) ?? { id: otherId },
      basis: typeof edge.evidence?.basis === 'string' ? edge.evidence.basis : '' });
  }
  return order.sort((a, b) => relationGroupRank(a.kind) - relationGroupRank(b.kind));
}

export function relationShown(groups) {
  return (Array.isArray(groups) ? groups : []).reduce((total, group) => total + group.rows.length, 0);
}

export function relationStatus(map, shown) {
  const count = Number.isInteger(shown) ? shown : 0;
  if (map?.truncated === true || map?.complete === false) return `Showing ${count}, more exist.`;
  if (map?.complete === true) return `Showing ${count}.`;
  return `Showing ${count}. Whether more exist was not reported.`;
}

export function availabilityLabel(hit) {
  const value = typeof hit?.availability === 'string' && hit.availability ? hit.availability : '';
  if (!value || value === 'locally-available') return '';
  const reason = typeof hit.availabilityReason === 'string' && hit.availabilityReason ? ` (${hit.availabilityReason})` : '';
  if (value === 'unresolved') return `Not scanned / unresolved${reason}. Studio has not read this record, so there is nothing to open.`;
  if (value === 'missing') return `Missing${reason}. This is not the same as deleted.`;
  if (value === 'stale') return `Stale${reason}. The saved address may no longer match. This is not deleted.`;
  return `Unavailable${reason}. This is not evidence that it was deleted.`;
}

export function readSearch(data) {
  const page = readList(data);
  if (!page.ok) return page;
  return { ...page, coverage: data.coverage && typeof data.coverage === 'object' ? data.coverage : null };
}

export function readList(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.items) || !Number.isInteger(data.total)) {
    return { ok: false, message: 'Studio’s list could not be read.' };
  }
  if (data.nextOffset != null && !Number.isInteger(data.nextOffset)) return { ok: false, message: 'Studio’s list could not be read.' };
  return {
    ok: true, items: data.items, total: data.total,
    offset: Number.isInteger(data.offset) ? data.offset : 0,
    limit: Number.isInteger(data.limit) ? data.limit : data.items.length,
    nextOffset: data.nextOffset ?? null,
  };
}

export function appendPage(previous, page) {
  const items = Array.isArray(previous) ? previous.slice() : [];
  const seen = new Set(items.map((item) => item?.id));
  for (const item of page?.items ?? []) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

const idList = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);

export function draftFromSaved(item) {
  const saved = item && typeof item === 'object' ? item : {};
  if (saved.kind === 'note' || typeof saved.body === 'string') {
    return { title: typeof saved.title === 'string' ? saved.title : '', body: typeof saved.body === 'string' ? saved.body : '', commentsOn: idList(saved.commentsOn) };
  }
  return {
    title: typeof saved.title === 'string' ? saved.title : '',
    conversationIds: idList(saved.conversationIds),
    noteIds: idList(saved.noteIds),
    memberIds: idList(saved.memberIds),
  };
}

export function sameDraft(left, right) {
  if (!left || !right) return false;
  if ((left.title ?? '') !== (right.title ?? '')) return false;
  if ((left.body ?? '') !== (right.body ?? '')) return false;
  const sameList = (a = [], b = []) => a.length === b.length && a.every((id, index) => id === b[index]);
  return sameList(left.conversationIds, right.conversationIds) && sameList(left.noteIds, right.noteIds)
    && sameList(left.memberIds, right.memberIds) && sameList(left.commentsOn, right.commentsOn);
}

export function withId(ids, id) {
  const current = Array.isArray(ids) ? ids.filter((item) => typeof item === 'string') : [];
  if (typeof id !== 'string' || !id || current.includes(id)) return current;
  return [...current, id];
}

export function withoutId(ids, id) {
  return (Array.isArray(ids) ? ids : []).filter((item) => item !== id);
}

export function projectCreateBody(title) { return { title, expectedVersion: null }; }
export function noteCreateBody(title, body) { return { title, body, expectedVersion: null }; }
export function projectPutBody(draft) {
  return {
    expectedVersion: draft.expectedVersion, title: draft.title,
    conversationIds: [...(draft.conversationIds ?? [])], noteIds: [...(draft.noteIds ?? [])],
    memberIds: [...(draft.memberIds ?? [])],
  };
}
export function notePutBody(draft) {
  return { expectedVersion: draft.expectedVersion, title: draft.title, body: draft.body ?? '', commentsOn: [...(draft.commentsOn ?? [])] };
}

function conflictText(data) {
  const expected = integerOrNull(data?.expected);
  const actual = integerOrNull(data?.actual);
  const versions = expected != null && actual != null ? ` This screen had version ${expected}; the saved copy is version ${actual}.` : '';
  return `Not saved. The saved version changed.${versions} Your draft is still here.`;
}

/** A write is saved only on HTTP 200 with an id and integer version. Conflicts keep the same draft object. */
export function interpretWrite(result, draft) {
  const status = Number(result?.status) || 0;
  const data = result?.data;
  if (status === 200 && data && typeof data === 'object' && typeof data.id === 'string' && Number.isInteger(data.version)) {
    return { ok: true, saved: data, draft: draftFromSaved(data), conflict: null, message: 'Saved.' };
  }
  if (data?.committed === true) {
    return { ok: false, saved: null, draft, conflict: null, message: 'Studio may have saved this but did not confirm the lock. Your draft is still here. Load the saved version before saving again.' };
  }
  const conflict = status === 409 || data?.code === 'CAS_VERSION_CONFLICT';
  const message = conflict ? conflictText(data)
    : status === 404 ? 'Not saved. This item is not on this computer anymore. Your draft is still here.'
      : status === 400 ? `Not saved. ${problemText(data)} Your draft is still here.`
        : 'Not saved. Studio did not confirm a save. Your draft is still here.';
  return { ok: false, saved: null, draft, conflict: conflict ? { expected: integerOrNull(data?.expected), actual: integerOrNull(data?.actual) } : null, message };
}

export function interpretCreate(result, form) {
  const written = interpretWrite(result, form);
  if (!written.ok) return { ...written, form, message: written.message.replace('Your draft is still here.', 'What you typed is still here.') };
  return { ok: true, saved: written.saved, form: { title: '', body: '' }, conflict: null, message: 'Saved.' };
}

export function absorbServer(local, item) {
  const remoteDraft = draftFromSaved(item);
  const clean = !local || (local.saved && sameDraft(local.draft, draftFromSaved(local.saved)));
  if (clean) {
    return { saved: item, draft: remoteDraft, expectedVersion: item.version, conflict: null, remote: null, remoteNote: '', notice: local?.notice ?? '', saving: false };
  }
  if (local.expectedVersion === item.version) return { ...local, saved: item, remote: item, remoteNote: '', saving: false };
  return {
    ...local, remote: item, saving: false,
    remoteNote: `A newer saved version (${item.version}) is on this computer. Your unsaved edits were kept and were not written.`,
  };
}

function blankList() { return { items: [], total: 0, nextOffset: null, loaded: false, loading: false, error: '' }; }

function editorFrom(item, notice = '') {
  return {
    saved: item, draft: draftFromSaved(item), expectedVersion: item.version,
    remote: null, remoteNote: '', notice, saving: false,
  };
}

/**
 * Mount peer views into the existing shell. `rich` is the chat renderer's static builder.
 * Drafts live in this tab until a confirmed save. A conflict never copies over the draft.
 */
export function mountWorldView({ document: doc, root, modes, chat, rich = null, announce = () => {}, fetchImpl = globalThis.fetch, storage = null } = {}) {
  if (!doc || !root || !modes || !chat) return null;
  const attr = (node, name) => {
    if (!node) return '';
    if (typeof node.getAttribute === 'function') {
      const value = node.getAttribute(name);
      if (value != null && value !== '') return value;
    }
    return node.attrs?.[name] ?? node.dataset?.[name.replace(/^data-/, '')] ?? '';
  };
  const buttons = typeof modes.querySelectorAll === 'function'
    ? [...modes.querySelectorAll('[data-view]')]
    : [...(modes.children ?? [])].filter((node) => attr(node, 'data-view'));
  const viewOf = (node) => attr(node, 'data-view');

  const state = {
    view: 'capture',
    lists: { conversations: blankList(), projects: blankList(), notes: blankList(), objects: blankList(), selections: blankList() },
    records: new Map(),
    namespace: null,
    namespaceLoaded: false,
    conversations: new Map(),
    editors: new Map(),
    selected: { conversations: null, projects: null, notes: null },
    forms: { project: { title: '' }, note: { title: '', body: '' } },
    formNote: { project: '', note: '' },
    errors: { conversations: '', projects: '', notes: '' },
    creating: false,
    messageNodes: new Map(),
    selectionSave: { projectId: '', newTitle: '', busy: false, notice: '', pending: null, savedKeys: new Set() },
    find: { query: '', kind: '', items: [], total: null, nextOffset: null, coverage: null, error: '', status: '', loading: false, recordId: null },
    custody: 'observed',
    relations: { id: '', typed: '', map: null, error: '', status: '', loading: false, recordId: null },
    workspace: { id: '', typed: '', map: null, error: '', status: '', loading: false, item: null, readingId: '', readingNode: null, readingError: '', readingLoading: false },
    transfer: {
      exportMode: 'references', exportParts: { reasoning: false, toolActivity: false }, selected: {}, bundle: null, blobUrl: '', exportError: '', exportStatus: '',
      importText: '', importError: '', importStatus: '', check: null, checkText: '', dryRun: null, confirm: false, restore: null, loading: '',
    },
  };
  let exportTicket = 0;
  let exportAbort = null;
  let importTicket = 0;
  let importAbort = null;
  let relationsTicket = 0;
  let relationsAbort = null;
  let workspaceReadTicket = 0;
  let workspaceReadAbort = null;
  let readerHeadNode = null, readerStatusNode = null, readerBodyNode = null;

  let searchTicket = 0;
  let searchAbort = null;
  const tickets = {
    conversations: 0, projects: 0, notes: 0,
    list: { conversations: 0, projects: 0, notes: 0, objects: 0, selections: 0 },
  };
  const REF_RE = /^[cnpos]-[a-z0-9-]{1,60}$/;
  const SELECTION_RE = /^s-[a-z0-9-]{1,60}$/;
  let itemsNode = null, moreNode = null, listErrorNode = null, listStatusNode = null, formNoteNode = null, createNode = null, namespaceNode = null;
  let linkConvSelect = null, linkNoteSelect = null, linkMemberSelect = null, linkCommentSelect = null, dirtyNode = null, saveNode = null;
  let framed = false, listPane = null, detailPane = null;

  function draftFingerprint(draft) {
    return JSON.stringify({
      title: typeof draft?.title === 'string' ? draft.title.trim() : '',
      body: draft?.body ?? '',
      conversationIds: draft?.conversationIds ?? [],
      noteIds: draft?.noteIds ?? [],
      memberIds: draft?.memberIds ?? [],
      commentsOn: draft?.commentsOn ?? [],
    });
  }
  function setFail(kind, id, text) { state.errors[kind] = text ? { id, text } : null; }
  function failText(kind, id) {
    const entry = state.errors[kind];
    return entry && entry.id === id ? entry.text : '';
  }
  function el(tag, props = {}, kids = []) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'id') { node.id = value; if (typeof node.setAttribute === 'function') node.setAttribute('id', value); }
      else if (typeof node.setAttribute === 'function') node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of [].concat(kids)) if (kid != null) node.append(kid);
    return node;
  }
  const on = (node, type, fn) => node.addEventListener(type, fn);
  function storeGet(key) { try { return (storage ?? globalThis.sessionStorage).getItem(key); } catch { return null; } }
  function storeSet(key, value) { try { (storage ?? globalThis.sessionStorage).setItem(key, value); } catch { /* this tab will simply not remember the view */ } }
  function remember() {
    storeSet('studio.world.view', state.view);
    storeSet('studio.world.selected', JSON.stringify(state.selected));
  }
  async function call(path, { method = 'GET', body, signal } = {}) {
    try {
      const response = await fetchImpl(WORLD_API + path, {
        method, signal, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data };
    } catch (error) {
      if (error?.name === 'AbortError') return { status: 0, data: null, aborted: true };
      return { status: 0, data: null };
    }
  }
  function applyVisibility() {
    const world = state.view !== 'capture';
    chat.hidden = world;
    root.hidden = !world;
    for (const button of buttons) {
      if (typeof button.setAttribute === 'function') button.setAttribute('aria-pressed', viewOf(button) === state.view ? 'true' : 'false');
    }
  }
  function ensureFrame() {
    if (framed) return;
    framed = true;
    const grid = el('div', { class: 'world-grid', id: 'worldGrid' });
    listPane = el('div', { id: 'worldList' });
    detailPane = el('div', { id: 'worldDetail' });
    grid.append(listPane, detailPane);
    root.replaceChildren(grid);
  }
  function titleFor(kind, id) {
    if (kind === 'conversations') return state.lists.conversations.items.find((item) => item.id === id)?.title || state.conversations.get(id)?.title || '';
    const saved = state.editors.get(id)?.saved;
    return saved?.title || state.lists[kind].items.find((item) => item.id === id)?.title || '';
  }
  function syncDirty(editor) {
    const dirty = !!(editor && editor.saved && !sameDraft(editor.draft, draftFromSaved(editor.saved)));
    if (dirtyNode) dirtyNode.textContent = dirty ? 'Unsaved changes' : '';
    if (saveNode) {
      saveNode.disabled = !dirty || !!editor?.saving;
      saveNode.textContent = editor?.saving ? 'Saving…' : 'Save';
    }
  }
  function syncFormNote() {
    const kind = state.view === 'notes' ? 'note' : 'project';
    if (formNoteNode) formNoteNode.textContent = state.formNote[kind] || '';
    if (createNode) createNode.disabled = state.creating;
  }
  function fillSelect(select, items, used, label) {
    if (!select) return;
    const current = select.value;
    const options = items.filter((item) => item && typeof item.id === 'string' && !(used ?? []).includes(item.id));
    select.replaceChildren(...options.map((item) => el('option', { value: item.id, text: item.title || item.selectionType || item.objectType || item.id })));
    select.value = options.some((item) => item.id === current) ? current : (options[0]?.id ?? '');
    select.disabled = !options.length;
    select.setAttribute?.('aria-label', label);
  }
  function refreshLinkSelects() {
    const project = state.view === 'projects' ? state.editors.get(state.selected.projects) : null;
    if (project && linkConvSelect) {
      fillSelect(linkConvSelect, state.lists.conversations.items, project.draft.conversationIds, 'Saved conversation to add');
      fillSelect(linkNoteSelect, state.lists.notes.items, project.draft.noteIds, 'Note to add');
      fillSelect(linkMemberSelect, [...state.lists.objects.items, ...state.lists.selections.items], project.draft.memberIds, 'Other saved record to add');
    }
    const note = state.view === 'notes' ? state.editors.get(state.selected.notes) : null;
    if (note && linkCommentSelect) fillSelect(linkCommentSelect, state.lists.selections.items, note.draft.commentsOn, 'Selection to comment on');
  }
  function fillItems() {
    if (!itemsNode || !VIEWS.includes(state.view)) return;
    const list = state.lists[state.view];
    if (listStatusNode) {
      listStatusNode.textContent = !list.loaded && list.loading ? 'Loading…'
        : list.loaded ? (list.total ? `Showing ${list.items.length} of ${list.total}.` : '') : '';
    }
    if (listErrorNode) listErrorNode.textContent = list.error || '';
    if (moreNode) { moreNode.hidden = list.nextOffset == null; moreNode.disabled = list.loading; moreNode.textContent = list.loading ? 'Loading…' : 'Load more'; }
    if (list.loading && !list.items.length) { itemsNode.replaceChildren(el('p', { class: 'empty', text: 'Loading…' })); return; }
    if (list.error && !list.items.length) { itemsNode.replaceChildren(); return; }
    if (list.loaded && !list.items.length) {
      const empty = {
        conversations: state.custody === 'imported'
          ? 'No imported snapshots in this list. An import is not an observed recording.'
          : state.custody === 'all'
            ? 'No observed recordings or imported snapshots in this list.'
            : 'No saved conversations on this computer. A session still being recorded is not listed. Nothing here is a sample.',
        projects: 'No projects yet. A project is your own grouping on this computer. It does not create a project on a provider.',
        notes: 'No notes yet. A note is something you write. It does not change a saved message.',
      };
      itemsNode.replaceChildren(el('p', { class: 'empty', text: empty[state.view] }));
      return;
    }
    const ul = el('ul', { class: 'plain' });
    for (const item of list.items) {
      if (!item || typeof item.id !== 'string') continue;
      const current = state.selected[state.view] === item.id;
      const meta = state.view === 'conversations'
        ? `Session status: ${item.status || 'unknown'} · Remote thread ${item.identity?.state || 'unknown'}${custodyChip(item) ? ' · Imported snapshot' : ''}`
        : state.view === 'projects'
          ? `Links ${item.conversationIds?.length ?? 0} saved conversations, ${item.noteIds?.length ?? 0} notes, and ${item.memberIds?.length ?? 0} other records.`
          : `You wrote this${Array.isArray(item.commentsOn) && item.commentsOn.length ? ` · comments on ${item.commentsOn.length}` : ''}${Number.isInteger(item.version) ? ` · version ${item.version}` : ''}.`;
      const button = el('button', { type: 'button', class: 'rowbtn', 'aria-current': current ? 'true' : null }, [
        el('span', { class: 'conv-title', text: item.title || item.id }),
        el('span', { class: 'note', text: meta }),
      ]);
      on(button, 'click', () => openItem(state.view, item.id));
      ul.append(el('li', {}, [button]));
    }
    itemsNode.replaceChildren(ul);
  }
  function renderListPane() {
    ensureFrame();
    itemsNode = el('div', { id: 'worldItems' });
    listStatusNode = el('div', { class: 'note', id: 'worldListStatus', role: 'status' });
    listErrorNode = el('div', { class: 'err', id: 'worldListError', role: 'alert' });
    moreNode = el('button', { type: 'button', id: 'worldMore', text: 'Load more' });
    on(moreNode, 'click', () => fetchList(state.view, { more: true }));
    const head = el('h2', { text: state.view === 'conversations' ? 'Saved conversations' : state.view === 'projects' ? 'Projects' : 'Notes' });
    namespaceNode = el('p', { class: 'note', id: 'worldNamespace' });
    const bits = [head, namespaceNode, listStatusNode, listErrorNode];
    if (state.view === 'conversations') {
      const custody = el('select', { id: 'worldCustody', 'aria-label': 'Which saved conversations to list' });
      for (const [value, label] of [['observed', 'Observed'], ['imported', 'Imported'], ['all', 'All']]) custody.append(el('option', { value, text: label }));
      custody.value = state.custody;
      on(custody, 'change', () => {
        if (!['observed', 'imported', 'all'].includes(custody.value) || custody.value === state.custody) return;
        state.custody = custody.value;
        // Replace the list before the reload. An in-flight observed page must not land in this filter,
        // and the change event has to settle only after the imported or all page is actually shown.
        state.lists.conversations = blankList();
        return fetchList('conversations');
      });
      bits.push(el('p', { class: 'note', text: 'Observed recordings are separate from imported snapshots. Opening one does not connect to a provider or sign you in.' }));
      bits.push(el('label', { class: 'lab', for: 'worldCustody', text: 'Show' }), custody);
    } else {
      const kind = state.view === 'projects' ? 'project' : 'note';
      const title = el('input', { id: 'worldCreateTitle', type: 'text', maxlength: '300', 'aria-label': kind === 'project' ? 'New project title' : 'New note title' });
      title.value = state.forms[kind].title;
      on(title, 'input', () => { state.forms[kind].title = title.value; });
      createNode = el('button', { type: 'button', id: 'worldCreate', text: kind === 'project' ? 'Create project' : 'Create note' });
      on(createNode, 'click', () => create(kind));
      formNoteNode = el('div', { class: 'note', id: 'worldCreateNote', role: 'status' });
      const fields = [el('label', { class: 'lab', for: 'worldCreateTitle', text: 'Title' }), title];
      if (kind === 'note') {
        const body = el('textarea', { id: 'worldCreateBody', rows: '4', 'aria-label': 'New note' });
        body.value = state.forms.note.body;
        on(body, 'input', () => { state.forms.note.body = body.value; });
        fields.push(el('label', { class: 'lab', for: 'worldCreateBody', text: 'Note' }), body);
      }
      bits.push(el('div', { class: 'panel pad' }, [
        ...fields,
        el('div', { class: 'row' }, [createNode]),
        formNoteNode,
        el('p', { class: 'note', text: kind === 'project'
          ? 'Creating a project only saves your grouping here.'
          : 'Creating a note only saves what you wrote. It does not change a saved conversation.' }),
      ]));
    }
    bits.push(itemsNode, moreNode);
    listPane.replaceChildren(...bits);
    fillItems();
    syncFormNote();
    syncNamespace();
  }
  function syncNamespace() {
    if (!namespaceNode) return;
    namespaceNode.textContent = state.namespace?.id
      ? `Shared local namespace ${state.namespace.id}. It addresses these records. It is not a home.`
      : '';
  }
  function findRecord(id) {
    if (state.records.has(id)) return state.records.get(id);
    for (const list of Object.values(state.lists)) {
      const found = list.items.find((item) => item?.id === id);
      if (found) return found;
    }
    return null;
  }
  function recordLabel(id) {
    const record = findRecord(id);
    if (record?.selectionType || record?.kind === 'selection') {
      return `Selection (${record.selectionType || 'unknown'})${record.availability ? ` · ${record.availability}` : ''}`;
    }
    if (record?.kind === 'source-reference' || record?.objectType) return `Local object${record.availability ? ` · ${record.availability}` : ''}`;
    if (record?.title) return record.title;
    if (id.startsWith('o-')) return 'Local object';
    if (id.startsWith('s-')) return 'Selection';
    if (id.startsWith('c-')) return 'Saved conversation';
    if (id.startsWith('n-')) return 'Note';
    if (id.startsWith('p-')) return 'Project';
    return 'Record';
  }
  function sourceJumpProblem(message) {
    if (state.view === 'find') { state.find.error = message; renderFind(); }
    else if (state.view === 'workspace') { state.workspace.readingError = message; renderWorkspaceReading(); }
    else if (state.view === 'projects' || state.view === 'notes') {
      const editor = state.editors.get(state.selected[state.view]);
      if (editor) { editor.notice = message; renderDetailPane(); }
      else announce(message);
    } else announce(message);
  }
  async function followSource(record) {
    if (!record || !/^[os]-[a-z0-9-]{1,60}$/.test(record.id || '')) return;
    if (['missing', 'unavailable', 'stale', 'unresolved'].includes(record.availability)) {
      sourceJumpProblem('The original source is ' + record.availability + '. No other content was substituted.');
      return;
    }
    // A selection's revision can change after the list was loaded. Recheck its
    // current source-bound availability before following, never trust cached labels.
    if (record.id.startsWith('s-')) {
      const fresh = await call('/selections/' + encodeURIComponent(record.id));
      if (fresh.status !== 200 || fresh.data?.id !== record.id
          || fresh.data.availability !== 'locally-available') {
        sourceJumpProblem('The saved selection is stale, missing or unavailable on a fresh read. No source was substituted.');
        return;
      }
      record = fresh.data;
    }
    let conversationId = record.conversationId;
    if (record.id.startsWith('s-')) {
      const parentId = record.objectId;
      if (!/^o-[a-z0-9-]{1,60}$/.test(parentId || '')) {
        sourceJumpProblem('The saved selection has no valid parent source reference.');
        return;
      }
      const object = await call('/objects/' + encodeURIComponent(parentId));
      if (object.status !== 200 || object.data?.id !== parentId
          || ['missing', 'unavailable', 'stale'].includes(object.data?.availability)) {
        sourceJumpProblem('The parent source reference is missing, stale or unavailable. Nothing else was opened.');
        return;
      }
      conversationId = object.data.conversationId;
    }
    if (!ID_RE.conversations.test(conversationId || '')) {
      sourceJumpProblem('This record has no saved local conversation id to follow.');
      return;
    }
    if (record.id.startsWith('s-')) {
      const idx = record.source?.messageIndex;
      if (!Number.isSafeInteger(idx) || idx < 0) {
        sourceJumpProblem('This selection has no usable recorded message index.');
        return;
      }
      return openHit({ kind: 'message', id: conversationId + ':turn:' + idx,
        conversation: { id: conversationId },
        source: { index: idx, partPath: record.source?.partPath ?? [] } });
    }
    return openItem('conversations', conversationId);
  }
  function sourceJumpButton(record) {
    if (!record || !/^[os]-[a-z0-9-]{1,60}$/.test(record.id || '')) return null;
    const button = el('button', { type: 'button', class: 'mini', id: 'worldSourceJump-' + record.id,
      text: 'Open original saved source', 'aria-label': 'Open source for ' + record.id });
    button.disabled = ['missing', 'unavailable', 'stale', 'unresolved'].includes(record.availability);
    on(button, 'click', () => followSource(record));
    return button;
  }

  function memberRow(kind, id) {
    const title = kind === 'members' || kind === 'comments' ? recordLabel(id) : (titleFor(kind, id) || (kind === 'conversations' ? 'Saved conversation' : 'Note'));
    const record = findRecord(id);
    const known = record || (kind === 'conversations'
      ? state.lists.conversations.items.some((item) => item.id === id) || state.conversations.has(id)
      : kind === 'notes'
        ? state.lists.notes.items.some((item) => item.id === id) || state.editors.has(id)
        : false);
    const open = el('button', { type: 'button', text: kind === 'conversations' ? 'Open conversation' : kind === 'notes' ? 'Open note' : 'Read record' });
    on(open, 'click', () => {
      if (kind === 'conversations' || kind === 'notes') return openItem(kind, id);
      return readRecord(id);
    });
    const remove = el('button', { type: 'button', text: 'Remove', 'aria-label': `Remove ${title}` });
    on(remove, 'click', () => {
      const editor = state.editors.get(state.selected[state.view]);
      if (!editor) return;
      if (kind === 'conversations') editor.draft.conversationIds = withoutId(editor.draft.conversationIds, id);
      else if (kind === 'notes') editor.draft.noteIds = withoutId(editor.draft.noteIds, id);
      else if (kind === 'comments') editor.draft.commentsOn = withoutId(editor.draft.commentsOn, id);
      else editor.draft.memberIds = withoutId(editor.draft.memberIds, id);
      renderDetailPane();
    });
    const facts = record ? kv([
      record.availability ? { label: 'Availability', value: String(record.availability) } : null,
      record.availabilityReason ? { label: 'Why', value: String(record.availabilityReason) } : null,
      record.conversationId ? { label: 'Saved conversation', value: record.conversationId } : null,
      record.objectId ? { label: 'Local object', value: record.objectId } : null,
      record.coverage?.assetBytes ? { label: 'File bytes', value: String(record.coverage.assetBytes) } : null,
      typeof record.qualification === 'string' ? { label: 'Qualification', value: record.qualification } : null,
    ]) : null;
    return el('div', { class: 'member' }, [
      el('div', { class: 'grow' }, [
        el('b', { text: title }),
        el('div', { class: 'mono', text: id }),
        known ? null : el('div', { class: 'note', text: 'Not in the loaded list. Removing it is still possible when you save.' }),
        facts,
      ]),
      open, sourceJumpButton(record), remove,
    ]);
  }
  function selectionToolbar(item) {
    if (state.view !== 'conversations' || state.selected.conversations !== item?.id) return null;
    const box = el('section', { class: 'panel pad', id: 'worldSelectionToolbar' });
    box.append(el('h3', { text: 'Keep something from this conversation' }));
    const picker = el('select', { id: 'worldSelectionProject', 'aria-label': 'Project for saved message or part' });
    picker.append(el('option', { value: '', text: 'Choose an existing project' }));
    for (const project of state.lists.projects.items) {
      if (!ID_RE.projects.test(project?.id || '')) continue;
      picker.append(el('option', { value: project.id, text: project.title || project.id }));
    }
    picker.value = state.selectionSave.projectId;
    on(picker, 'change', () => {
      state.selectionSave.projectId = picker.value;
      state.selectionSave.notice = '';
      const line = typeof box.querySelector === 'function' ? box.querySelector('#worldSelectionStatus') : null;
      if (line) line.textContent = '';
    });
    const title = el('input', { type: 'text', id: 'worldSelectionNewTitle', maxlength: '300',
      'aria-label': 'Name for a new project', placeholder: 'New project name' });
    title.value = state.selectionSave.newTitle;
    on(title, 'input', () => { state.selectionSave.newTitle = title.value; });
    const create = el('button', { type: 'button', id: 'worldSelectionNewProject', text: 'Create project here' });
    create.disabled = state.selectionSave.busy;
    on(create, 'click', () => createProjectFromConversation());
    box.append(el('div', { class: 'row' }, [picker]));
    box.append(el('div', { class: 'row' }, [title, create]));
    if (!state.lists.projects.items.length) box.append(el('p', { class: 'note', text: 'Create a project here; your saved conversation stays open.' }));
    box.append(el('p', { class: 'note', text: 'Selections point to recorded content; they do not copy an attachment, edit the recording, or verify a provider account.' }));
    box.append(el('p', { id: 'worldSelectionStatus', role: 'status', text: state.selectionSave.notice }));
    return box;
  }

  /** Create via the same canonical API as Projects, without losing the source reader. */
  async function createProjectFromConversation() {
    const work = state.selectionSave;
    if (work.busy) return;
    const title = validTitle(work.newTitle ?? '');
    if (!title) {
      work.notice = 'Not saved. Enter a project name with 1 to 300 characters.';
      renderDetailPane();
      return;
    }
    work.busy = true;
    work.notice = 'Creating local project…';
    renderDetailPane();
    try {
      const result = await call('/projects', { method: 'POST', body: projectCreateBody(title) });
      const outcome = interpretCreate(result, { title, body: '' });
      if (!outcome.ok || !ID_RE.projects.test(outcome.saved?.id || '')) {
        work.notice = outcome.message || 'No project save was confirmed. Check Projects before trying again.';
        return;
      }
      const saved = outcome.saved;
      const list = state.lists.projects;
      list.items = appendPage([saved], { items: list.items });
      list.total = Math.max(list.total, list.items.length);
      list.loaded = true;
      state.editors.set(saved.id, editorFrom(saved, 'Saved.'));
      work.projectId = saved.id;
      work.newTitle = '';
      work.notice = 'Project ' + (saved.title || title)
        + ' created. Choose Save message or Save this part below to link recorded content.';
      announce('Project created. Saved conversation stays open.');
    } catch (error) {
      work.notice = 'Project save was not confirmed. Check Projects before retrying.';
    } finally {
      work.busy = false;
      if (state.view === 'conversations') renderDetailPane();
    }
  }
  /** Every confirmed source record is discoverable even if the next write fails. */
  function cacheSourceRecord(kind, record) {
    if (!['objects', 'selections'].includes(kind) || !record?.id) return;
    const list = state.lists[kind];
    list.items = appendPage([record], { items: list.items });
    list.total = Math.max(list.total, list.items.length);
    list.loaded = true;
    state.records.set(record.id, record);
  }

  /** Three existing versioned writes; partial failures leave honest local records, never fake an atomic save. */
  async function saveObservedPart(conversationId, messageIndex, partPath = []) {
    const work = state.selectionSave;
    if (work.busy) return;
    const projectId = work.projectId;
    const source = state.conversations.get(conversationId);
    const message = source?.messages?.[messageIndex];
    const validPart = !partPath.length || (partPath.length === 1 && Number.isSafeInteger(partPath[0])
      && partPath[0] >= 0 && Array.isArray(message?.blocks) && partPath[0] < message.blocks.length);
    const key = JSON.stringify([conversationId, messageIndex, partPath, projectId]);
    if (!ID_RE.projects.test(projectId || '') || !message || !validPart) {
      work.notice = 'Nothing saved. Choose a project and a recorded message or part first.';
      renderDetailPane();
      return;
    }
    if (work.savedKeys.has(key)) {
      work.notice = 'This item was already linked to that project in this session.';
      renderDetailPane();
      return;
    }
    const localEditor = state.editors.get(projectId);
    if (localEditor?.saved && !sameDraft(localEditor.draft, draftFromSaved(localEditor.saved))) {
      work.notice = 'Not saved. This project has unsaved edits. Save or discard that draft in Projects first.';
      renderDetailPane();
      return;
    }
    work.busy = true;
    work.notice = 'Saving local source reference, selection and project link…';
    renderDetailPane();
    let object = null, selection = null;
    try {
      const current = await call('/projects/' + encodeURIComponent(projectId));
      if (current.status !== 200 || current.data?.id !== projectId || !Number.isInteger(current.data.version)) {
        work.notice = 'Nothing saved. The selected project could not be read. Choose it again.';
        return;
      }
      const project = current.data;
      const createdObject = await call('/objects', { method: 'POST', body: { conversationId, expectedVersion: null } });
      if (createdObject.status !== 200 || !/^o-[a-z0-9-]+$/.test(createdObject.data?.id || '') || !Number.isInteger(createdObject.data?.version)) {
        work.notice = 'Project unchanged. Studio did not confirm a saved source reference; inspect the saved records before retrying.';
        return;
      }
      object = createdObject.data;
      const createdSelection = await call('/selections', { method: 'POST', body: {
        objectId: object.id, selectionType: partPath.length ? 'part' : 'message',
        messageIndex, partPath, expectedVersion: null,
      } });
      if (createdSelection.status !== 200 || !/^s-[a-z0-9-]+$/.test(createdSelection.data?.id || '') || !Number.isInteger(createdSelection.data?.version)) {
        work.notice = 'Source reference ' + object.id + ' was saved, but selection/project link was NOT confirmed. Inspect local references before retrying.';
        return;
      }
      selection = createdSelection.data;
      const changed = await call('/projects/' + encodeURIComponent(projectId), { method: 'PUT', body: {
        title: project.title,
        conversationIds: withId(project.conversationIds ?? [], conversationId),
        noteIds: [...(project.noteIds ?? [])],
        memberIds: withId(withId(project.memberIds ?? [], object.id), selection.id),
        expectedVersion: project.version,
      } });
      const written = interpretWrite(changed, project);
      if (!written.ok) {
        work.notice = 'Selection ' + selection.id + ' was saved, but the project link was NOT confirmed. '
          + written.message + ' Open Projects to link the selection manually.';
        return;
      }
      work.savedKeys.add(key);
      work.notice = 'Saved this recorded ' + (partPath.length ? 'part' : 'message') + ' in project ' + (project.title || projectId)
        + '. The original conversation was not modified.';
      for (const [kind, record] of [['objects', object], ['selections', selection]]) {
        state.lists[kind].items = appendPage([record], { items: state.lists[kind].items });
        state.lists[kind].loaded = true;
      }
      const list = state.lists.projects.items;
      const at = list.findIndex((p) => p.id === projectId);
      if (at >= 0) list[at] = { ...list[at], ...written.saved };
      if (localEditor) state.editors.set(projectId, editorFrom(written.saved, 'Saved.'));
      announce('Saved part to your project.');
    } catch (error) {
      work.notice = 'The write sequence did not complete. '
        + (selection ? 'Selection ' + selection.id : object ? 'Source reference ' + object.id : 'No source reference')
        + ' may exist locally; check saved records before retrying. '
        + (error?.message ? String(error.message).slice(0, 120) : 'Studio reported an unexpected error.');
    } finally {
      work.busy = false;
      if (state.view === 'conversations' && state.selected.conversations === conversationId) renderDetailPane();
    }
  }

  function renderMessages(item) {
    const list = el('ol', { class: 'reads', id: 'worldMessages' });
    state.messageNodes = new Map();
    const messages = Array.isArray(item.messages) ? item.messages : [];
    if (!messages.length) {
      const coverage = item?.coverage?.state;
      const empty = coverage === 'unavailable' ? 'Saved messages were not shown because this read was unavailable.'
        : coverage === 'missing' ? 'No saved messages were found in this record.'
          : 'No saved messages in this record.';
      list.append(el('li', { class: 'empty', text: empty }));
    }
    messages.forEach((message, index) => {
      const plan = turnPlan(message);
      const body = el('div', { class: 'rich' });
      const canSelect = state.view === 'conversations' && state.selected.conversations === item.id;
      const frames = planFrames(message).filter((frame) => frame.markdown || frame.links.length);
      if (frames.length) {
        for (const frame of frames) {
          const frameBody = el('div', { class: 'rich', 'data-part-path': String(frame.path[0]), tabindex: '-1' });
          if (frame.markdown) {
            if (typeof rich?.renderStatic === 'function') rich.renderStatic(frameBody, frame.markdown);
            else frameBody.textContent = frame.markdown;
          }
          if (frame.links.length) {
            const sources = el('div', { class: 'note', 'aria-label': 'Links observed in saved page' });
            for (const link of frame.links) {
              const title = (link.kind === 'citation' ? 'Recorded citation link: ' : 'Recorded link: ') + link.label;
              sources.append(link.href
                ? el('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer nofollow', text: title })
                : el('span', { text: title + ' (address unavailable)' }));
              sources.append(el('span', { text: ' · ' }));
            }
            frameBody.append(sources);
          }
          if (canSelect) {
            const savePart = el('button', { type: 'button', class: 'mini', id: 'worldSavePart-' + index + '-' + frame.path[0], text: 'Save this part to project' });
            savePart.disabled = state.selectionSave.busy;
            on(savePart, 'click', () => saveObservedPart(item.id, index, frame.path));
            frameBody.append(savePart);
          }
          body.append(frameBody);
        }
      } else if (plan.markdown) {
        if (typeof rich?.renderStatic === 'function') rich.renderStatic(body, plan.markdown);
        else body.textContent = plan.markdown;
      }
      const unknownList = el('div');
      for (const unknown of plan.unknowns) unknownList.append(el('p', { class: 'unknown-part', text: unknown.note }));
      const row = el('li', { class: 'rd', id: 'worldMsg' + index, tabindex: '0' }, [
        el('div', { class: 'rd-head' }, [
          el('b', { text: roleLabel(message?.role) }),
          ...(canSelect ? [(() => {
            const saveMessage = el('button', { type: 'button', class: 'mini', id: 'worldSaveMessage-' + index, text: 'Save message to project' });
            saveMessage.disabled = state.selectionSave.busy;
            on(saveMessage, 'click', () => saveObservedPart(item.id, index, []));
            return saveMessage;
          })()] : []),
          plan.truncated ? el('span', { class: 'pill t-warn', text: 'Marked truncated' }) : null,
        ]),
        plan.note ? el('p', { class: 'note', text: plan.note }) : null,
        body.children?.length || body.textContent ? body : null,
        unknownList.children?.length ? unknownList : null,
        plan.redactionNote ? el('p', { class: 'note', text: plan.redactionNote }) : null,
        plan.truncated ? el('p', { class: 'note', text: plan.truncatedOriginalLength == null
            ? 'This saved turn is not complete.'
            : 'This saved turn is not complete. Original text length observed before truncation: ' + plan.truncatedOriginalLength + ' characters.' }) : null,
        kv(messageSourceRows(message?.source)),
      ]);
      state.messageNodes.set(index, row);
      list.append(row);
    });
    return list;
  }
  function kv(rows) {
    const dl = el('dl', { class: 'kv' });
    for (const row of rows) if (row) dl.append(el('dt', { text: row.label }), el('dd', { text: row.value }));
    return dl;
  }
  function conversationReading(item, error = null, tail = null, chipOverride = null) {
    const coverage = coverageView(item.coverage);
    return el('article', { class: 'panel pad local-mark' }, [
      el('h2', { text: item.title || 'Saved conversation' }),
      el('p', { class: 'note', text: custodyChip(item) || item.coverage?.state === 'imported-snapshot'
        ? 'This is an imported snapshot, not a recording Studio observed. It does not prove a provider still has these messages.'
        : 'Saved on this computer. A remote thread or account is shown only when this record actually has one.' }),
      chips(chipOverride ?? (coverage.chips.some((chip) => chip[0] === custodyChip(item)?.[0]) ? coverage.chips : [...(custodyChip(item) ? [custodyChip(item)] : []), ...coverage.chips])),
      el('p', { text: coverage.sentence }),
      kv([
        { label: 'Session status', value: item.status || 'unknown' },
        ...identityRows(item.identity), ...sourceRows(item.source), ...coverage.extra,
        ...importedFromLines(item.importedFrom),
        typeof item.createdAt === 'string' && item.createdAt ? { label: 'Recorded at', value: item.createdAt } : null,
      ]),
      error, selectionToolbar(item), renderMessages(item), tail,
    ]);
  }
  function renderDetailPane() {
    ensureFrame();
    linkConvSelect = null; linkNoteSelect = null; linkMemberSelect = null; linkCommentSelect = null; dirtyNode = null; saveNode = null;
    const kind = state.view;
    if (!VIEWS.includes(kind)) { detailPane.replaceChildren(); return; }
    const id = state.selected[kind];
    if (!id) {
      detailPane.replaceChildren(el('p', { class: 'empty', text: 'Nothing is open in this view. Pick one from the list, or create a project or a note. Opening one does not make it more important than the others.' }));
      return;
    }
    const error = el('div', { class: 'err', id: 'worldError', role: 'alert' });
    error.textContent = failText(kind, id);
    if (kind === 'conversations') {
      const item = state.conversations.get(id);
      if (!item) {
        detailPane.replaceChildren(el('h2', { text: 'Saved conversation' }), error.textContent ? error : el('p', { class: 'empty', text: 'Loading this saved conversation…' }));
        return;
      }
      detailPane.replaceChildren(
        conversationReading(item, error.textContent ? error : null, linkedProjects(id, 'conversation')),
      );
      return;
    }
    const editor = state.editors.get(id);
    if (!editor) {
      detailPane.replaceChildren(el('h2', { text: kind === 'projects' ? 'Project' : 'Note' }), error.textContent ? error : el('p', { class: 'empty', text: 'Loading…' }));
      return;
    }
    dirtyNode = el('span', { class: 'pill t-warn', id: 'worldDirty' });
    const notice = el('div', { class: 'note', id: 'worldNotice', role: 'status' });
    notice.textContent = [editor.remoteNote, editor.notice].filter(Boolean).join(' ');
    saveNode = el('button', { type: 'button', class: 'primary', id: 'worldSave', text: 'Save' });
    on(saveNode, 'click', () => save(kind, id));
    const useSaved = el('button', { type: 'button', id: 'worldUseSaved', text: 'Load saved version' });
    on(useSaved, 'click', () => loadSaved(kind, id));
    const title = el('input', { id: 'worldTitle', type: 'text', maxlength: '300', 'aria-label': 'Title' });
    title.value = editor.draft.title;
    on(title, 'input', () => { editor.draft.title = title.value; editor.notice = ''; syncDirty(editor); });
    const version = el('p', { class: 'note', id: 'worldVersion', text: Number.isInteger(editor.expectedVersion) ? `Version ${editor.expectedVersion}. Saving sends this version and will not overwrite a newer one.` : 'Version unknown. Load the saved version before saving.' });
    const bodyBits = [
      el('h2', { text: kind === 'projects' ? 'Project' : 'Note' }),
      el('p', { class: 'note', text: kind === 'projects'
        ? 'This project is yours. Linking a saved conversation or a note does not change that conversation, that note, or anything on a provider.'
        : 'You wrote this. Saving it does not change a saved conversation, and it is not a correction of one.' }),
      version, dirtyNode, error, notice,
      el('label', { class: 'lab', for: 'worldTitle', text: 'Title' }), title,
    ];
    if (kind === 'notes') {
      const body = el('textarea', { id: 'worldBody', rows: '8', 'aria-label': 'Note' });
      body.value = editor.draft.body ?? '';
      on(body, 'input', () => { editor.draft.body = body.value; editor.notice = ''; syncDirty(editor); });
      bodyBits.push(el('label', { class: 'lab', for: 'worldBody', text: 'Note' }), body, el('p', { class: 'note', text: editor.saved?.provenance === 'user-authored' ? 'Marked as written by you.' : 'Provenance was not recorded as written by you.' }));
      linkCommentSelect = el('select', { id: 'worldCommentSelect' });
      const addComment = el('button', { type: 'button', id: 'worldAddComment', text: 'Comment on selection' });
      on(addComment, 'click', () => addMember('comments', linkCommentSelect.value));
      bodyBits.push(
        el('h3', { text: 'Comments on' }),
        el('p', { class: 'note', text: 'A comment points at a saved selection. It does not change that conversation, and it is not written back into the recording.' }),
        ...((editor.draft.commentsOn ?? []).length ? editor.draft.commentsOn.map((member) => memberRow('comments', member)) : [el('p', { class: 'note', text: 'This note does not comment on a selection.' })]),
        el('div', { class: 'row' }, [linkCommentSelect, addComment]),
      );
    } else {
      linkConvSelect = el('select', { id: 'worldConvSelect' });
      linkNoteSelect = el('select', { id: 'worldNoteSelect' });
      linkMemberSelect = el('select', { id: 'worldMemberSelect' });
      const addConv = el('button', { type: 'button', id: 'worldAddConversation', text: 'Add to this project' });
      const addNote = el('button', { type: 'button', id: 'worldAddNote', text: 'Add to this project' });
      const addOther = el('button', { type: 'button', id: 'worldAddMember', text: 'Add to this project' });
      on(addConv, 'click', () => addMember('conversations', linkConvSelect.value));
      on(addNote, 'click', () => addMember('notes', linkNoteSelect.value));
      on(addOther, 'click', () => addMember('members', linkMemberSelect.value));
      bodyBits.push(
        el('h3', { text: 'Saved conversations' }),
        ...(editor.draft.conversationIds.length ? editor.draft.conversationIds.map((member) => memberRow('conversations', member)) : [el('p', { class: 'note', text: 'No saved conversation is linked.' })]),
        el('div', { class: 'row' }, [linkConvSelect, addConv]),
        el('h3', { text: 'Notes' }),
        ...(editor.draft.noteIds.length ? editor.draft.noteIds.map((member) => memberRow('notes', member)) : [el('p', { class: 'note', text: 'No note is linked.' })]),
        el('div', { class: 'row' }, [linkNoteSelect, addNote]),
        el('h3', { text: 'Other linked records' }),
        el('p', { class: 'note', text: 'These links stay on this project. They are not a map, and they do not copy a note or a selection into the saved conversation.' }),
        ...((editor.draft.memberIds ?? []).length ? editor.draft.memberIds.map((member) => memberRow('members', member)) : [el('p', { class: 'note', text: 'No other record is linked.' })]),
        el('div', { class: 'row' }, [linkMemberSelect, addOther]),
        el('p', { class: 'note', text: 'Adding and removing wait until you save. Save sends the whole list. New source objects and selections can be created from the Saved conversation reader.' }),
      );
    }
    bodyBits.push(el('div', { class: 'row' }, [saveNode, useSaved]));
    if (kind === 'notes') bodyBits.push(linkedProjects(id, 'note'));
    detailPane.replaceChildren(el('article', { class: 'panel pad local-mark' }, bodyBits));
    refreshLinkSelects();
    syncDirty(editor);
  }
  function chips(list) {
    return el('div', { class: 'chips' }, list.map(([label, tone]) => el('span', { class: `pill ${tone}`, text: label })));
  }
  function linkedProjects(id, noun) {
    const list = state.lists.projects;
    const hits = list.items.filter((item) => {
      const direct = noun === 'conversation' ? item?.conversationIds : item?.noteIds;
      const ids = [...(Array.isArray(direct) ? direct : []), ...(Array.isArray(item?.memberIds) ? item.memberIds : [])];
      return ids.includes(id);
    });
    const box = el('div');
    box.append(el('h3', { text: 'Projects that link here' }));
    if (!list.loaded) box.append(el('p', { class: 'note', text: 'Projects are not loaded yet, so this list may be empty even when a link exists.' }));
    else if (!hits.length) box.append(el('p', { class: 'note', text: list.nextOffset == null ? 'No loaded project links here.' : 'No loaded project links here. More projects are not loaded, so this can be incomplete.' }));
    for (const hit of hits) {
      const button = el('button', { type: 'button', text: hit.title || hit.id });
      on(button, 'click', () => openItem('projects', hit.id));
      box.append(button);
    }
    if (list.nextOffset != null) box.append(el('p', { class: 'note', text: 'More projects are not loaded. This is not the full set of links.' }));
    return box;
  }
  function addMember(kind, id) {
    const editorKind = kind === 'comments' ? 'notes' : 'projects';
    const editor = state.editors.get(state.selected[editorKind]);
    if (!editor) return;
    if (kind === 'comments') {
      if (!SELECTION_RE.test(id || '')) return;
      editor.draft.commentsOn = withId(editor.draft.commentsOn, id);
    } else if (kind === 'members') {
      if (!REF_RE.test(id || '')) return;
      editor.draft.memberIds = withId(editor.draft.memberIds, id);
    } else if (!ID_RE[kind].test(id || '')) return;
    else if (kind === 'conversations') editor.draft.conversationIds = withId(editor.draft.conversationIds, id);
    else editor.draft.noteIds = withId(editor.draft.noteIds, id);
    editor.notice = '';
    renderDetailPane();
  }
  async function fetchList(kind, { more = false } = {}) {
    if (!state.lists[kind]) return;
    const list = state.lists[kind];
    if (list.loading) return;
    if (!more && list.loaded) return;
    if (more && list.nextOffset == null) return;
    const offset = more ? list.nextOffset : 0;
    list.loading = true;
    list.error = '';
    if (kind === state.view) fillItems();
    const mine = ++tickets.list[kind];
    const path = { conversations: '/conversations', projects: '/projects', notes: '/notes', objects: '/objects', selections: '/selections' }[kind];
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), offset: String(offset) });
    if (kind === 'conversations') params.set('custody', ['observed', 'imported', 'all'].includes(state.custody) ? state.custody : 'observed');
    const result = await call(`${path}?${params.toString()}`);
    if (mine !== tickets.list[kind]) return;
    list.loading = false;
    const page = result.status === 200 ? readList(result.data) : { ok: false, message: result.status === 0 ? 'Studio didn’t answer.' : 'The list could not be read.' };
    if (!page.ok) list.error = page.message;
    else {
      const incoming = page.items.filter((item) => item && typeof item.id === 'string');
      // Keep a just-created item if this reply started before the create landed.
      list.items = more ? appendPage(list.items, page) : appendPage(incoming, { items: list.items });
      list.total = Math.max(page.total, list.items.length);
      list.nextOffset = page.nextOffset;
      list.loaded = true;
      list.error = '';
    }
    if (kind === state.view) fillItems();
    if (state.view === 'projects' || state.view === 'notes') refreshLinkSelects();
    const openEditor = state.editors.get(state.selected[state.view]);
    const dirty = openEditor?.saved && !sameDraft(openEditor.draft, draftFromSaved(openEditor.saved));
    if (!dirty && state.view !== 'projects' && kind === 'projects' && state.selected[state.view]) renderDetailPane();
  }
  async function loadNamespace() {
    if (state.namespaceLoaded) return;
    state.namespaceLoaded = true;
    const result = await call('/namespace');
    if (result.status === 200 && result.data && typeof result.data.id === 'string') {
      state.namespace = { id: result.data.id, kind: result.data.kind ?? 'namespace' };
      syncNamespace();
    }
  }
  async function readRecord(id) {
    const path = id.startsWith('o-') ? '/objects/' : id.startsWith('s-') ? '/selections/' : '';
    if (!path || !REF_RE.test(id)) return;
    const result = await call(path + encodeURIComponent(id));
    state.records.set(id, result.status === 200 && result.data?.id === id
      ? result.data
      : { id, availability: 'missing', availabilityReason: result.status === 404 ? 'NOT_FOUND' : 'UNREADABLE' });
    if (state.view === 'projects' || state.view === 'notes') renderDetailPane();
    if (state.view === 'find') renderFind();
    if (state.view === 'relations') renderRelations();
  }
  async function fetchItem(kind, id) {
    const mine = ++tickets[kind];
    const result = await call(`/${kind}/${encodeURIComponent(id)}`);
    if (mine !== tickets[kind]) return;
    const ok = result.status === 200 && result.data && result.data.id === id;
    if (!ok) {
      const cached = kind === 'conversations' && state.conversations.has(id);
      const active = result.status === 409 && result.data?.code === 'WORLD_SOURCE_ACTIVE';
      let text = result.status === 404 ? 'Not on this computer anymore.'
        : active ? 'This recording is still active, so its saved messages are not available yet. Nothing was changed.'
          : result.status === 0 ? 'Studio didn’t answer. Nothing new was shown.'
            : `This could not be read. ${problemText(result.data)}`;
      if (cached) text += ' What was already loaded is still shown and was not replaced.';
      setFail(kind, id, text);
      if (state.view === kind && state.selected[kind] === id) renderDetailPane();
      return;
    }
    setFail(kind, id, '');
    if (kind === 'conversations') state.conversations.set(id, result.data);
    else {
      const existing = state.editors.get(id);
      // A slower read must not roll a confirmed newer save back to an older copy.
      if (existing && Number.isInteger(existing.expectedVersion) && result.data.version < existing.expectedVersion) return;
      state.editors.set(id, absorbServer(existing, result.data));
    }
    if (state.view === kind && state.selected[kind] === id) renderDetailPane();
  }
  async function openItem(kind, id) {
    if (!VIEWS.includes(kind) || !ID_RE[kind].test(id || '')) return;
    state.view = kind;
    state.selected[kind] = id;
    remember();
    applyVisibility();
    renderListPane();
    renderDetailPane();
    const loads = [fetchList(kind), fetchItem(kind, id)];
    if (kind !== 'projects') loads.push(fetchList('projects'));
    if (kind === 'projects') loads.push(fetchList('conversations'), fetchList('notes'), fetchList('objects'), fetchList('selections'));
    if (kind === 'notes') loads.push(fetchList('selections'));
    await Promise.all(loads);
  }
  function validTitle(title) {
    const trimmed = title.trim();
    return trimmed.length > 0 && trimmed.length <= 300 ? trimmed : null;
  }
  async function create(kind) {
    if (state.creating || (kind !== 'project' && kind !== 'note')) return;
    const form = state.forms[kind];
    const title = validTitle(form.title ?? '');
    if (!title) { state.formNote[kind] = 'Not saved. The title needs 1 to 300 characters. What you typed is still here.'; syncFormNote(); return; }
    if (kind === 'note' && (form.body ?? '').length > 200000) { state.formNote[kind] = 'Not saved. The note is too long. What you typed is still here.'; syncFormNote(); return; }
    state.creating = true; syncFormNote();
    const result = await call(kind === 'project' ? '/projects' : '/notes', {
      method: 'POST', body: kind === 'project' ? projectCreateBody(title) : noteCreateBody(title, form.body ?? ''),
    });
    state.creating = false;
    const out = interpretCreate(result, { title: form.title, body: form.body ?? '' });
    if (!out.ok) { state.formNote[kind] = out.message; syncFormNote(); return; }
    state.forms[kind] = { title: '', body: '' };
    state.formNote[kind] = '';
    const listKind = kind === 'project' ? 'projects' : 'notes';
    state.lists[listKind].items = appendPage([out.saved], { items: state.lists[listKind].items });
    state.lists[listKind].total += 1;
    state.lists[listKind].loaded = true;
    state.editors.set(out.saved.id, editorFrom(out.saved, 'Saved.'));
    state.selected[listKind] = out.saved.id;
    setFail(listKind, out.saved.id, '');
    state.view = listKind;
    remember();
    announce('Saved.');
    applyVisibility();
    renderListPane();
    renderDetailPane();
  }
  async function save(kind, id) {
    const editor = state.editors.get(id);
    if (!editor || editor.saving || (kind !== 'projects' && kind !== 'notes')) return;
    if (!editor.saved || sameDraft(editor.draft, draftFromSaved(editor.saved))) { editor.notice = 'Nothing new to save.'; renderDetailPane(); return; }
    const title = validTitle(editor.draft.title ?? '');
    if (!title) { setFail(kind, id, 'Not saved. The title needs 1 to 300 characters. Your draft is still here.'); renderDetailPane(); return; }
    if (kind === 'notes' && (editor.draft.body ?? '').length > 200000) { setFail(kind, id, 'Not saved. The note is too long. Your draft is still here.'); renderDetailPane(); return; }
    if (!Number.isInteger(editor.expectedVersion)) { setFail(kind, id, 'Not saved. This screen has no saved version to check against. Your draft is still here.'); renderDetailPane(); return; }
    const sentPrint = draftFingerprint({ ...editor.draft, title });
    editor.saving = true; syncDirty(editor);
    const body = kind === 'projects'
      ? projectPutBody({ ...editor.draft, title, expectedVersion: editor.expectedVersion })
      : notePutBody({ ...editor.draft, title, expectedVersion: editor.expectedVersion });
    const result = await call(`/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', body });
    editor.saving = false;
    const current = state.editors.get(id) ?? editor;
    const written = interpretWrite(result, current.draft);
    if (!written.ok) {
      current.draft = written.draft;
      current.conflict = written.conflict;
      current.notice = '';
      current.saving = false;
      setFail(kind, id, written.message);
      state.editors.set(id, current);
      if (state.view === kind && state.selected[kind] === id) renderDetailPane();
      return;
    }
    setFail(kind, id, '');
    const later = draftFingerprint(current.draft) !== sentPrint;
    const next = editorFrom(written.saved, later ? 'Saved what was sent. Edits made after that are still here and were not written.' : 'Saved.');
    if (later) next.draft = current.draft;
    state.editors.set(id, next);
    const index = state.lists[kind].items.findIndex((item) => item.id === id);
    if (index >= 0) state.lists[kind].items[index] = { ...state.lists[kind].items[index], ...written.saved };
    announce(next.notice);
    if (state.view === kind && state.selected[kind] === id) { fillItems(); renderDetailPane(); }
  }
  async function loadSaved(kind, id) {
    const result = await call(`/${kind}/${encodeURIComponent(id)}`);
    if (!(result.status === 200 && result.data?.id === id && Number.isInteger(result.data.version))) {
      setFail(kind, id, 'The saved version could not be loaded. Your draft is still here.');
      if (state.view === kind && state.selected[kind] === id) renderDetailPane();
      return;
    }
    setFail(kind, id, '');
    state.editors.set(id, editorFrom(result.data, 'Showing the saved version.'));
    if (state.view === kind && state.selected[kind] === id) renderDetailPane();
  }
  function renderFind() {
    ensureFrame();
    const query = el('input', { id: 'worldFindQuery', type: 'search', role: 'searchbox', 'aria-label': 'Text to find in saved records' });
    query.value = state.find.query;
    on(query, 'input', () => { state.find.query = query.value; });
    on(query, 'keydown', (event) => { if (event.key === 'Enter') { event.preventDefault?.(); return runSearch(); } });
    const kind = el('select', { id: 'worldFindKind', 'aria-label': 'Limit find to one kind of record' });
    kind.append(el('option', { value: '', text: 'Everything saved here' }));
    for (const name of FIND_KINDS) kind.append(el('option', { value: name, text: FIND_LABELS[name] }));
    kind.value = FIND_KINDS.includes(state.find.kind) ? state.find.kind : '';
    on(kind, 'change', () => { state.find.kind = kind.value; });
    const submit = el('button', { type: 'button', id: 'worldFindSubmit', text: state.find.loading ? 'Finding…' : 'Find' });
    submit.disabled = state.find.loading;
    on(submit, 'click', () => runSearch());
    const status = el('div', { id: 'worldFindStatus', role: 'status', 'aria-live': 'polite' });
    status.textContent = state.find.status;
    const error = el('div', { class: 'err', id: 'worldFindError', role: 'alert' });
    error.textContent = state.find.error;
    const coverage = el('div', { id: 'worldFindCoverage' });
    if (state.find.coverage || state.find.items.length) {
      for (const line of searchCoverageLines(state.find.coverage)) coverage.append(el('p', { class: 'note', text: line }));
    }
    const results = el('div', { id: 'worldFindResults' });
    if (!state.find.items.length) results.append(el('p', { class: 'empty', text: state.find.loading ? 'Finding…' : 'No matches shown yet.' }));
    else {
      const list = el('ul', { class: 'plain' });
      for (const hit of state.find.items) {
        const availability = availabilityLabel(hit);
        const button = el('button', { type: 'button', class: 'rowbtn', 'aria-label': `Open ${hit.kind || 'record'} ${hit.id}` }, [
          el('span', { class: 'conv-title', text: hit.title || hit.id }),
          el('span', { class: 'note', text: `${FIND_LABELS[hit.kind] || hit.kind || 'Record'} · ${hit.id}` }),
        ]);
        on(button, 'click', () => openHit(hit));
        const item = el('li', {}, [
          button,
          hit.snippet ? el('p', { class: 'note', text: hit.snippet }) : null,
          custodyChip(hit) ? el('p', { text: custodyChip(hit)[0] }) : null,
          availability ? el('p', { text: availability }) : null,
        ]);
        list.append(item);
      }
      results.append(list);
    }
    const more = el('button', { type: 'button', id: 'worldFindMore', text: 'Load more matches' });
    more.hidden = state.find.nextOffset == null;
    more.disabled = state.find.loading;
    on(more, 'click', () => runSearch({ more: true }));
    listPane.replaceChildren(
      el('h2', { text: 'Find' }),
      el('p', { class: 'note', text: 'Find looks through saved text on this computer. A match count is not everything that exists, and it does not search a provider.' }),
      el('div', { role: 'search', 'aria-label': 'Find saved records' }, [
        el('label', { class: 'lab', for: 'worldFindQuery', text: 'Text' }), query,
        el('label', { class: 'lab', for: 'worldFindKind', text: 'Kind' }), kind,
        el('div', { class: 'row' }, [submit]),
      ]),
      status, error, coverage, results, more,
    );
    const record = state.find.recordId ? findRecord(state.find.recordId) : null;
    detailPane.replaceChildren(record ? el('article', { class: 'panel pad local-mark' }, [
      el('h2', { text: recordLabel(record.id) }),
      el('p', { class: 'mono', text: record.id }),
      availabilityLabel(record) ? el('p', { text: availabilityLabel(record) }) : null,
      kv([
        record.availability ? { label: 'Availability', value: String(record.availability) } : null,
        record.availabilityReason ? { label: 'Why', value: String(record.availabilityReason) } : null,
        record.conversationId ? { label: 'Saved conversation', value: record.conversationId } : null,
        record.objectId ? { label: 'Local object', value: record.objectId } : null,
        typeof record.qualification === 'string' ? { label: 'Qualification', value: record.qualification } : null,
      ]),
      el('p', { class: 'note', text: 'This is the saved record. Opening it does not change the conversation it points at.' }),
      sourceJumpButton(record),
    ]) : el('p', { class: 'empty', text: 'Open a match to see that same saved record. Find is not a home for it.' }));
  }
  async function runSearch({ more = false } = {}) {
    const query = state.find.query.trim();
    if (!query) {
      state.find.error = 'Enter text to find. Nothing was searched.';
      state.find.status = '';
      renderFind();
      return;
    }
    if (more && state.find.nextOffset == null) return;
    const offset = more ? state.find.nextOffset : 0;
    const ticket = ++searchTicket;
    searchAbort?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    searchAbort = controller;
    state.find.loading = true;
    state.find.error = '';
    if (state.view === 'find') renderFind();
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('offset', String(offset));
    params.set('limit', String(PAGE_LIMIT));
    if (FIND_KINDS.includes(state.find.kind)) params.set('kind', state.find.kind);
    const result = await call('/search?' + params.toString(), { signal: controller?.signal });
    if (ticket !== searchTicket || state.view !== 'find') return;
    state.find.loading = false;
    if (result.aborted) return;
    if (result.status !== 200) {
      state.find.items = more ? state.find.items : [];
      state.find.coverage = null;
      state.find.status = '';
      state.find.error = result.status === 400 ? problemText(result.data)
        : result.status === 0 ? 'Studio didn’t answer. Nothing new was shown.'
          : `This could not be read. ${problemText(result.data)}`;
      renderFind();
      return;
    }
    const page = readSearch(result.data);
    if (!page.ok) {
      state.find.error = page.message;
      renderFind();
      return;
    }
    const incoming = page.items.filter((hit) => hit && typeof hit.id === 'string');
    state.find.items = more ? appendPage(state.find.items, page) : incoming;
    state.find.total = page.total;
    state.find.nextOffset = page.nextOffset;
    state.find.coverage = page.coverage;
    state.find.status = searchStatusText({ shown: state.find.items.length, total: page.total, coverage: page.coverage });
    state.find.error = '';
    renderFind();
  }
  /** Same part path rule the selection API enforces: non-negative safe integers or safe object
   * keys, never prototype names, at most 16 steps. Used only to decide whether a hit's partPath is
   * worth looking for in the rendered message. */
  function validPartPath(partPath) {
    return Array.isArray(partPath) && partPath.length >= 1 && partPath.length <= 16
      && partPath.every((key) => Number.isSafeInteger(key) && key >= 0
        || typeof key === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)
          && !['constructor', 'prototype', '__proto__'].includes(key));
  }
  /** Finds a rendered part frame by its data-part-path marker inside one message row. Works with a
   * real querySelector and falls back to a children walk where that is not available. */
  function partFrameOf(row, key) {
    if (!row) return null;
    if (typeof row.querySelector === 'function') {
      try { return row.querySelector(`[data-part-path="${key}"]`) ?? null; } catch { /* fall through to the walk */ }
    }
    let found = null;
    const visit = (node) => {
      if (found || !node || typeof node !== 'object') return;
      const attr = typeof node.getAttribute === 'function' ? node.getAttribute('data-part-path') : node.attrs?.['data-part-path'];
      if (attr === key) { found = node; return; }
      const children = node.children;
      if (Array.isArray(children)) for (const child of children) visit(child);
    };
    visit(row);
    return found;
  }
  async function openHit(hit) {
    if (!hit || typeof hit.id !== 'string') return;
    if (hit.kind === 'message') {
      const id = hit.conversation?.id;
      if (!ID_RE.conversations.test(id || '')) {
        state.find.error = 'This match has no saved conversation id, so it was not opened.';
        if (state.view === 'find') renderFind();
        return;
      }
      const index = Number.isInteger(hit.source?.index) ? hit.source.index : null;
      const partPath = hit.source?.partPath;
      // An empty path is a message-level selection; anything else asks for a specific part.
      const askedPart = partPath !== undefined && partPath !== null && !(Array.isArray(partPath) && partPath.length === 0);
      const partKey = validPartPath(partPath) ? partPath.map((key) => String(key)).join('.') : null;
      await openItem('conversations', id);
      const foundBefore = partKey && index != null ? partFrameOf(state.messageNodes?.get(index) ?? null, partKey) : null;
      if (askedPart && !foundBefore) {
        setFail('conversations', id, 'Opened the message; the matching part could not be located.');
        renderDetailPane();
      }
      const row = index == null ? null : state.messageNodes?.get(index) ?? null;
      const frame = partKey && row ? partFrameOf(row, partKey) : null;
      if (frame) {
        frame.setAttribute('aria-current', 'true');
        frame.append(el('span', { class: 'pill t-info', text: 'Matched part' }));
        frame.focus?.();
        frame.scrollIntoView?.({ block: 'nearest' });
      } else {
        row?.focus?.();
        row?.scrollIntoView?.({ block: 'nearest' });
      }
      return;
    }
    if (hit.kind === 'project' && ID_RE.projects.test(hit.id)) return openItem('projects', hit.id);
    if (hit.kind === 'note' && ID_RE.notes.test(hit.id)) return openItem('notes', hit.id);
    if ((hit.kind === 'source-reference' || hit.kind === 'selection') && REF_RE.test(hit.id)) {
      state.find.recordId = hit.id;
      state.records.set(hit.id, { ...hit, kind: hit.kind === 'selection' ? 'selection' : 'source-reference' });
      await readRecord(hit.id);
      if (state.view === 'find') renderFind();
      return;
    }
    state.find.error = 'This match cannot be opened from here.';
    if (state.view === 'find') renderFind();
  }
  function clearExportBundle() {
    if (state.transfer.blobUrl) {
      try { URL.revokeObjectURL?.(state.transfer.blobUrl); } catch { /* already revoked */ }
      state.transfer.blobUrl = '';
    }
    state.transfer.bundle = null;
  }
  function selectedExportIds() {
    return Object.entries(state.transfer.selected).filter(([, on]) => on).map(([id]) => id).filter(validWorldId);
  }
  function resetImportCheck() {
    state.transfer.check = null;
    state.transfer.checkText = '';
    state.transfer.dryRun = null;
    state.transfer.confirm = false;
    state.transfer.restore = null;
  }
  function textBytes(text) {
    try { return new TextEncoder().encode(text).length; } catch { return text.length; }
  }
  function factList(title, rows) {
    const box = el('div', {}, [el('h3', { text: title })]);
    if (!rows.length) box.append(el('p', { class: 'note', text: 'None.' }));
    else box.append(kv(rows));
    return box;
  }
  function renderTransfer() {
    ensureFrame();
    const t = state.transfer;
    const status = el('div', { id: 'worldTransferStatus', role: 'status', 'aria-live': 'polite', text: t.exportStatus || t.importStatus || '' });
    const exportError = el('div', { class: 'err', id: 'worldExportError', role: 'alert', text: t.exportError });
    const choices = el('div', { id: 'worldExportChoices' });
    const groups = [['Saved conversations', state.lists.conversations], ['Projects', state.lists.projects], ['Notes', state.lists.notes]];
    for (const [label, list] of groups) {
      choices.append(el('h3', { text: label }));
      const items = (list.items ?? []).filter((item) => validWorldId(item?.id));
      if (!items.length) choices.append(el('p', { class: 'note', text: list.loaded ? 'Nothing loaded with an id that can be exported.' : 'Not loaded yet.' }));
      for (const item of items) {
        const box = el('input', { type: 'checkbox', id: 'export-' + item.id });
        box.checked = t.selected[item.id] === true;
        on(box, 'change', () => {
          if (box.checked) t.selected[item.id] = true; else delete t.selected[item.id];
          clearExportBundle(); t.exportStatus = '';
          renderTransfer();
        });
        choices.append(el('label', { class: 'pick', for: 'export-' + item.id }, [box, el('span', {}, [el('b', { text: item.title || item.id }), el('span', { class: 'mono', text: ' ' + item.id })])]));
      }
    }
    const exportMode = t.exportMode === 'transcript' || t.exportMode === 'full-saved' ? t.exportMode : 'references';
    const modePicker = el('div', { id: 'worldExportModes', role: 'radiogroup', 'aria-label': 'What the export includes' });
    for (const [value, label, sentence] of [
      ['references', EXPORT_MODE_LABEL.references, 'Leaves out everything you read: no message text, no reasoning, no tool or status activity.'],
      ['transcript', EXPORT_MODE_LABEL.transcript, 'Leaves out reasoning, tool and status activity, and any block type Studio does not recognize.'],
      ['full-saved', EXPORT_MODE_LABEL['full-saved'], 'Keeps every recorded block Studio has, even ones it does not recognize. Only the two boxes below can leave anything out.'],
    ]) {
      const radio = el('input', { type: 'radio', id: 'worldExportMode-' + value, name: 'worldExportMode', value });
      radio.checked = exportMode === value;
      on(radio, 'change', () => {
        if (!radio.checked || exportMode === value) return;
        t.exportMode = value;
        clearExportBundle();
        t.exportStatus = '';
        renderTransfer();
      });
      modePicker.append(el('label', { class: 'pick', for: 'worldExportMode-' + value }, [radio, el('span', { text: label }), el('span', { class: 'note', text: ' ' + sentence })]));
    }
    const partBox = (key, label) => {
      const box = el('input', { type: 'checkbox', id: 'worldExportPart-' + key });
      box.checked = t.exportParts[key] === true;
      box.disabled = exportMode === 'references';
      on(box, 'change', () => {
        if (box.disabled) return;
        t.exportParts[key] = box.checked;
        clearExportBundle();
        t.exportStatus = '';
        renderTransfer();
      });
      return el('label', { class: 'pick', for: 'worldExportPart-' + key }, [box, el('span', { text: label })]);
    };
    const partsHint = exportMode === 'references'
      ? el('p', { class: 'note', text: 'References only has no message text, so there is nothing to turn on here. Choose Transcript or Full saved first.' })
      : el('p', { class: 'note', text: 'These stay off until you turn them on. What is ticked goes into the file unredacted.' });
    const preview = el('button', { type: 'button', id: 'worldExportPreview', text: t.loading === 'export' ? 'Previewing…' : 'Preview' });
    preview.disabled = t.loading === 'export' || !selectedExportIds().length;
    on(preview, 'click', () => runExport());
    const previewBox = el('div', { id: 'worldExportPreviewOut' });
    if (t.bundle) {
      const scope = t.bundle.scope && typeof t.bundle.scope === 'object' ? t.bundle.scope : null;
      const coverage = t.bundle.coverage && typeof t.bundle.coverage === 'object' ? t.bundle.coverage : null;
      const appliedMode = typeof scope?.mode === 'string' ? scope.mode : null;
      const counts = custodyCounts(t.bundle.records);
      previewBox.append(factList('Records by custody', Object.entries(counts).map(([label, count]) => ({ label, value: String(count) }))));
      previewBox.append(el('p', { text: appliedMode ? `Export used this mode: ${EXPORT_MODE_LABEL[appliedMode] ?? appliedMode}.` : 'The bundle did not say which mode was applied. Check it before you share it.' }));
      if (appliedMode && appliedMode !== exportMode) previewBox.append(el('p', { class: 'err', text: `You asked for ${EXPORT_MODE_LABEL[exportMode] ?? exportMode}, but the bundle says ${EXPORT_MODE_LABEL[appliedMode] ?? appliedMode}. It may not be what you asked for.` }));
      if (scope?.parts && typeof scope.parts === 'object') {
        previewBox.append(el('p', { class: 'note', text: `Saved reasoning included: ${scope.parts.reasoning === true ? 'yes' : 'no'}. Tool and status activity included: ${scope.parts.toolActivity === true ? 'yes' : 'no'}.` }));
      }
      const omitted = Array.isArray(t.bundle.omitted) ? t.bundle.omitted : [];
      previewBox.append(el('h3', { text: 'Left out' }));
      if (!omitted.length) previewBox.append(el('p', { class: 'note', text: 'Nothing was listed as left out.' }));
      else {
        const totals = {};
        for (const item of omitted) {
          const reason = typeof item?.reason === 'string' && item.reason ? item.reason : 'reason not given';
          totals[reason] = (totals[reason] ?? 0) + (Number.isInteger(item?.count) ? item.count : 1);
        }
        for (const [reason, count] of Object.entries(totals)) previewBox.append(el('p', { text: `${EXPORT_OMIT_LABEL[reason] ?? reason}: ${count}` }));
        for (const item of omitted.slice(0, 30)) previewBox.append(el('p', { class: 'note', text: `${item?.id ?? 'record'}: ${EXPORT_OMIT_LABEL[item?.reason] ?? item?.reason ?? 'reason not given'}${Number.isInteger(item?.count) ? ` (${item.count})` : ''}` }));
      }
      previewBox.append(el('p', { class: 'note', text: typeof coverage?.modeSemantics === 'string' ? coverage.modeSemantics : 'The bundle did not say what its mode means.' }));
      previewBox.append(el('p', { text: coverage?.complete === true
        ? 'The bundle calls its declared scope complete. That is about the declared scope and its mode, not about everything, and not a claim about a provider.'
        : 'The bundle does not call its declared scope complete.' }));
      if (appliedMode === 'references') previewBox.append(el('p', { text: 'References only: calling that scope complete does not mean message text is in the file.' }));
      if (typeof coverage?.qualification === 'string' && coverage.qualification) previewBox.append(el('p', { class: 'note', text: coverage.qualification }));
      const strongWarning = scope?.parts && typeof scope.parts === 'object'
        ? scope.parts.reasoning === true || scope.parts.toolActivity === true
        : exportMode !== 'references' && (t.exportParts.reasoning === true || t.exportParts.toolActivity === true);
      previewBox.append(el('p', { class: 'note', text: 'The hash is integrity only. It checks the file, not who wrote it and not that a provider still has it.' }));
      previewBox.append(el('p', { class: 'note', text: strongWarning
        ? 'Selected content is not automatically redacted, and this may contain content you did not mean to share. Read every line before you share it.'
        : 'Selected content is not automatically redacted.' }));
      if (t.bundle.integrity?.sha256) previewBox.append(el('p', { class: 'mono', text: String(t.bundle.integrity.sha256).slice(0, 12) }));
      let href = '';
      try {
        if (t.blobUrl) URL.revokeObjectURL?.(t.blobUrl);
        href = URL.createObjectURL(new Blob([JSON.stringify(t.bundle, null, 2)], { type: 'application/json' }));
        t.blobUrl = href;
      } catch { href = ''; t.blobUrl = ''; }
      if (href) previewBox.append(el('a', { class: 'hit', id: 'worldExportDownload', href, download: 'vivim-world.json' }, ['Download JSON']));
      else previewBox.append(el('p', { class: 'note', text: 'A download link could not be built in this browser. Nothing was saved automatically.' }));
    }
    const importBox = el('textarea', { id: 'worldImportText', rows: '6', 'aria-label': 'Paste a world JSON bundle' });
    importBox.value = t.importText;
    on(importBox, 'input', () => {
      t.importText = importBox.value;
      if (t.importText !== t.checkText) {
        resetImportCheck();
        t.importStatus = '';
        renderTransfer();
      }
    });
    const file = el('input', { type: 'file', id: 'worldImportFile', accept: 'application/json,.json', 'aria-label': 'Choose a world JSON file' });
    on(file, 'change', () => readImportFile(file.files?.[0]));
    const check = el('button', { type: 'button', id: 'worldImportCheck', text: t.loading === 'check' ? 'Checking…' : 'Check' });
    check.disabled = t.loading === 'check';
    on(check, 'click', () => runCheck());
    const ready = checkReady(t.check) && t.checkText === t.importText && t.check.digest;
    const dry = el('button', { type: 'button', id: 'worldImportDry', text: t.loading === 'dry' ? 'Checking dry run…' : 'Dry run' });
    dry.disabled = !ready || t.loading === 'dry';
    on(dry, 'click', () => runRestore({ dryRun: true }));
    const confirm = el('input', { type: 'checkbox', id: 'worldImportConfirm' });
    confirm.checked = t.confirm === true;
    confirm.disabled = !(ready && t.dryRun && t.dryRun.digest === t.check?.digest);
    on(confirm, 'change', () => { t.confirm = confirm.checked; renderTransfer(); });
    const write = el('button', { type: 'button', id: 'worldImportRestore', text: t.loading === 'restore' ? 'Restoring…' : 'Write imported copies' });
    write.disabled = confirm.disabled || !t.confirm || t.loading === 'restore';
    on(write, 'click', () => runRestore({ dryRun: false }));
    const importOut = el('div', { id: 'worldImportOut' });
    const importError = el('div', { class: 'err', id: 'worldImportError', role: 'alert', text: t.importError });
    if (t.check) importOut.append(renderCheck(t.check));
    if (t.dryRun) importOut.append(el('h3', { text: 'Dry run' }), el('p', { text: restoreSummary(t.dryRun).text }), renderOutcome(t.dryRun));
    if (t.restore) {
      const summary = restoreSummary(t.restore);
      importOut.append(el('h3', { text: 'Restore' }), el('p', { text: summary.text }), renderOutcome(t.restore));
      const applied = Array.isArray(t.restore.applied) ? t.restore.applied : [];
      const map = t.restore.idMap && typeof t.restore.idMap === 'object' ? t.restore.idMap : {};
      for (const kind of ['conversations', 'projects', 'notes']) {
        const original = applied.find((id) => typeof id === 'string'
          && (kind === 'conversations' ? id.startsWith('c-') : kind === 'projects' ? id.startsWith('p-') : id.startsWith('n-'))
          && ID_RE[kind].test(map[id] || ''));
        if (!original) continue;
        const target = map[original];
        const open = el('button', { type: 'button', id: 'worldImportOpen-' + kind,
          text: 'Open imported ' + (kind === 'conversations' ? 'conversation' : kind === 'projects' ? 'project' : 'note') });
        on(open, 'click', () => openItem(kind, target));
        importOut.append(open);
      }
    }
    listPane.replaceChildren(
      el('h2', { text: 'Transfer' }),
      el('p', { class: 'note', text: 'Transfer moves a JSON bundle on this computer. It does not send anything to a provider. Export and import are not a home for the records.' }),
      status,
      el('h3', { text: 'Export' }),
      choices,
      modePicker,
      partBox('reasoning', 'Include saved reasoning'),
      partBox('toolActivity', 'Include saved tool and status activity'),
      partsHint,
      el('div', { class: 'row' }, [preview]),
      exportError,
      previewBox,
    );
    detailPane.replaceChildren(
      el('h3', { text: 'Import' }),
      el('label', { class: 'lab', for: 'worldImportText', text: 'Bundle JSON' }),
      importBox,
      el('label', { class: 'lab', for: 'worldImportFile', text: 'Or choose a .json file' }),
      file,
      el('p', { class: 'note', text: 'Files larger than 8 MB are refused here and are not checked.' }),
      el('div', { class: 'row' }, [check, dry]),
      el('label', { class: 'pick', for: 'worldImportConfirm' }, [confirm, el('span', { text: 'I have read the dry run. Write these imported copies on this computer.' })]),
      write,
      importError,
      importOut,
    );
  }
  function renderCheck(report) {
    const box = el('div', { id: 'worldCheckOut' });
    box.append(el('p', { text: report.valid === true ? 'Check passed. This does not write anything.' : 'Check did not pass. Nothing was written.' }));
    if (report.digest) box.append(el('p', { class: 'mono', text: String(report.digest).slice(0, 12) }));
    const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
    box.append(factList('Counts', Object.entries(counts).map(([label, value]) => ({ label: labelize(label), value: formatMeta(value) }))));
    const unresolved = Array.isArray(report.unresolved) ? report.unresolved : [];
    box.append(el('h3', { text: `Unresolved (${unresolved.length})` }));
    for (const item of unresolved.slice(0, 20)) box.append(el('p', { text: typeof item === 'string' ? item : `${item?.id ?? 'unknown id'}: ${item?.reason ?? formatMeta(item)}` }));
    const omitted = Array.isArray(report.omitted) ? report.omitted : [];
    box.append(el('h3', { text: `Left out (${omitted.length})` }));
    for (const item of omitted.slice(0, 20)) box.append(el('p', { text: `${item?.id ?? 'record'}: ${item?.reason ?? 'reason not given'}` }));
    const errors = Array.isArray(report.errors) ? report.errors : [];
    box.append(el('h3', { text: `Errors (${errors.length})` }));
    for (const item of errors.slice(0, 20)) box.append(el('p', { text: `${item?.code ?? 'error'}: ${item?.message ?? formatMeta(item)}` }));
    const mapped = report.idMap && typeof report.idMap === 'object' ? Object.keys(report.idMap).length : 0;
    box.append(el('p', { text: `${mapped} ids would be rewritten on import.` }));
    const known = new Set(['valid', 'digest', 'counts', 'idMap', 'unresolved', 'omitted', 'errors', 'coverage']);
    const extra = Object.entries(report).filter(([key]) => !known.has(key));
    if (extra.length) box.append(factList('Other reported details', extra.map(([key, value]) => ({ label: labelize(key), value: formatMeta(value) }))));
    return box;
  }
  function renderOutcome(report) {
    const box = el('div');
    const lists = [['Applied', report.applied], ['Skipped', report.skipped], ['Pending', report.pending]];
    for (const [label, values] of lists) {
      const ids = Array.isArray(values) ? values : [];
      box.append(el('p', { text: `${label}: ${ids.length ? ids.slice(0, 20).map((id) => typeof id === 'string' ? id : formatMeta(id)).join(', ') : 'none'}` }));
    }
    const failed = Array.isArray(report.failed) ? report.failed : [];
    box.append(el('p', { text: failed.length ? `Failed: ${failed.slice(0, 10).map((item) => `${item?.id ?? 'record'} ${item?.message ?? item?.code ?? ''}`).join('; ')}` : 'Failed: none' }));
    if (report.receipt) box.append(el('p', { text: `Receipt: ${typeof report.receipt === 'string' ? report.receipt : formatMeta(report.receipt)}` }));
    const known = new Set(['valid', 'digest', 'counts', 'idMap', 'unresolved', 'omitted', 'errors', 'coverage', 'dryRun', 'applied', 'skipped', 'failed', 'pending', 'partial', 'receipt']);
    const extra = Object.entries(report).filter(([key]) => !known.has(key));
    if (extra.length) box.append(factList('Other reported details', extra.map(([key, value]) => ({ label: labelize(key), value: formatMeta(value) }))));
    return box;
  }
  async function runExport() {
    const ids = selectedExportIds();
    if (!ids.length) { state.transfer.exportError = 'Choose at least one loaded record. Nothing was exported.'; renderTransfer(); return; }
    const ticket = ++exportTicket;
    exportAbort?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    exportAbort = controller;
    state.transfer.loading = 'export';
    state.transfer.exportError = '';
    if (state.view === 'transfer') renderTransfer();
    const template = state.transfer.exportMode === 'references' || state.transfer.exportMode === 'transcript' || state.transfer.exportMode === 'full-saved'
      ? state.transfer.exportMode : 'references';
    state.transfer.exportMode = template;
    const body = { ids, mode: template };
    if (template !== 'references') body.parts = { reasoning: state.transfer.exportParts.reasoning === true, toolActivity: state.transfer.exportParts.toolActivity === true };
    const result = await call('/transfer/export', { method: 'POST', signal: controller?.signal, body });
    if (ticket !== exportTicket || state.view !== 'transfer') return;
    state.transfer.loading = '';
    if (result.aborted) return;
    if (result.status !== 200 || !isExportBundle(result.data)) {
      clearExportBundle();
      state.transfer.exportError = result.status === 0 ? 'Studio didn’t answer. Nothing was exported.' : (result.status === 200 ? 'Studio did not return an export bundle. Nothing was saved.' : problemText(result.data));
      state.transfer.exportStatus = '';
      renderTransfer();
      return;
    }
    state.transfer.bundle = result.data;
    state.transfer.exportStatus = 'Preview ready. Nothing was saved until you use Download JSON.';
    state.transfer.exportError = '';
    renderTransfer();
  }
  function readImportFile(file) {
    if (!file) return;
    if (file.size > IMPORT_BYTE_CAP) {
      state.transfer.importText = '';
      resetImportCheck();
      state.transfer.importStatus = '';
      state.transfer.importError = 'That file is larger than 8 MB, so it was not read.';
      renderTransfer();
      return;
    }
    if (typeof FileReader !== 'function') {
      state.transfer.importError = 'This browser cannot read the file here. Paste the JSON instead.';
      renderTransfer();
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (textBytes(text) > IMPORT_BYTE_CAP) {
        state.transfer.importText = '';
        resetImportCheck();
        state.transfer.importStatus = '';
        state.transfer.importError = 'That file is larger than 8 MB, so it was not checked.';
      } else {
        state.transfer.importText = text;
        state.transfer.importError = '';
        resetImportCheck();
      }
      if (state.view === 'transfer') renderTransfer();
    });
    reader.addEventListener('error', () => { state.transfer.importError = 'The file could not be read. Nothing was checked.'; if (state.view === 'transfer') renderTransfer(); });
    reader.readAsText(file);
  }
  function parsedBundle() {
    const text = state.transfer.importText;
    if (textBytes(text) > IMPORT_BYTE_CAP) return { error: 'That bundle is larger than 8 MB, so it was not checked.' };
    try { return { bundle: JSON.parse(text) }; }
    catch { return { error: 'That text is not JSON. Nothing was checked.' }; }
  }
  async function runCheck() {
    const parsed = parsedBundle();
    if (parsed.error) { state.transfer.importError = parsed.error; resetImportCheck(); renderTransfer(); return; }
    const ticket = ++importTicket;
    importAbort?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    importAbort = controller;
    state.transfer.loading = 'check';
    state.transfer.importError = '';
    const source = state.transfer.importText;
    if (state.view === 'transfer') renderTransfer();
    const result = await call('/transfer/validate', { method: 'POST', signal: controller?.signal, body: { bundle: parsed.bundle } });
    if (ticket !== importTicket || state.view !== 'transfer') return;
    state.transfer.loading = '';
    if (result.aborted) return;
    if (result.status !== 200 || !result.data || typeof result.data !== 'object') {
      resetImportCheck();
      state.transfer.importError = result.status === 0 ? 'Studio didn’t answer. Nothing was checked.' : problemText(result.data);
      renderTransfer();
      return;
    }
    state.transfer.check = result.data;
    state.transfer.checkText = source;
    state.transfer.dryRun = null;
    state.transfer.confirm = false;
    state.transfer.restore = null;
    state.transfer.importStatus = checkReady(result.data) ? 'Check passed. Nothing was written.' : 'Check did not pass. Nothing was written.';
    state.transfer.importError = '';
    renderTransfer();
  }
  async function runRestore({ dryRun }) {
    if (!checkReady(state.transfer.check) || state.transfer.checkText !== state.transfer.importText) {
      state.transfer.importError = 'Check this bundle again before restoring. Nothing was written.';
      resetImportCheck();
      renderTransfer();
      return;
    }
    if (!dryRun && state.transfer.confirm !== true) {
      state.transfer.importError = 'Confirm the dry run before writing. Nothing was written.';
      renderTransfer();
      return;
    }
    const parsed = parsedBundle();
    if (parsed.error) { state.transfer.importError = parsed.error; resetImportCheck(); renderTransfer(); return; }
    const ticket = ++importTicket;
    importAbort?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    importAbort = controller;
    state.transfer.loading = dryRun ? 'dry' : 'restore';
    const digest = state.transfer.check.digest;
    if (state.view === 'transfer') renderTransfer();
    const result = await call('/transfer/restore', { method: 'POST', signal: controller?.signal, body: { bundle: parsed.bundle, digest, dryRun: dryRun === true, ...(dryRun ? {} : { confirm: true }) } });
    if (ticket !== importTicket || state.view !== 'transfer') return;
    state.transfer.loading = '';
    if (result.aborted) return;
    if (result.status !== 200 || !result.data || typeof result.data !== 'object') {
      state.transfer.importError = result.status === 0 ? 'Studio didn’t answer. Nothing was marked written.' : problemText(result.data);
      state.transfer.importStatus = '';
      renderTransfer();
      return;
    }
    if (dryRun) {
      state.transfer.dryRun = result.data;
      state.transfer.restore = null;
      state.transfer.confirm = false;
      state.transfer.importStatus = restoreSummary(result.data).text;
    } else {
      const summary = restoreSummary(result.data);
      state.transfer.restore = result.data;
      state.transfer.importStatus = summary.text;
      state.custody = 'all';
      // Every affected collection may have changed. Invalidate all pages and any pending
      // older read, so navigation sees imported projects/notes/references without a reload.
      for (const kind of ['conversations', 'projects', 'notes', 'objects', 'selections']) {
        tickets.list[kind] += 1;
        state.lists[kind] = blankList();
      }
      state.records.clear();
      state.find.items = [];
      state.find.coverage = null;
      state.find.nextOffset = null;
      if (summary.success) {
        state.transfer.check = null;
        state.transfer.checkText = '';
        state.transfer.dryRun = null;
        state.transfer.confirm = false;
      }
    }
    state.transfer.importError = '';
    renderTransfer();
  }
  function relationChoices() {
    const rows = [];
    for (const [kind, list] of [['conversation', state.lists.conversations], ['project', state.lists.projects], ['note', state.lists.notes],
      ['source-reference', state.lists.objects], ['selection', state.lists.selections]]) {
      for (const item of list.items ?? []) if (item && validWorldId(item.id)) rows.push({ id: item.id, title: item.title, kind });
    }
    return rows;
  }
  function relationRowElements(group, row, open = openRelation) {
    const node = row.node;
    if (node?.availability === 'unresolved' || node?.availabilityReason === 'NOT_SCANNED') {
      return el('div', { class: 'member' }, [
        el('span', { class: 'conv-title', text: node.title || row.id }),
        el('span', { class: 'pill t-warn', text: 'Not scanned / unresolved' }),
        el('p', { class: 'note', text: `Linked but never read (${node.availabilityReason ?? 'NOT_SCANNED'}). There is nothing to open.` }),
      ]);
    }
    if (!validWorldId(row.id)) {
      return el('div', { class: 'member' }, [
        el('span', { class: 'conv-title', text: node?.title || row.id }),
        el('span', { class: 'note', text: row.id }),
        el('span', { class: 'pill t-warn', text: 'Cannot be opened here: unrecognised id' }),
        el('p', { class: 'note', text: 'This link points at an id this Studio does not recognise, so there is nothing to open.' }),
      ]);
    }
    const chip = provenanceChip(node);
    const availability = availabilityLabel(node);
    const basisLine = row.basis && row.basis !== STANDARD_RELATION_BASIS ? row.basis : null;
    const button = el('button', { type: 'button', class: 'rowbtn', 'aria-label': `Open ${row.id}` }, [
      el('span', { class: 'conv-title', text: node.title || row.id }),
      el('span', { class: 'note', text: row.id }),
      el('span', { class: `pill ${chip[1]}`, text: chip[0] }),
    ]);
    on(button, 'click', () => open(row));
    return el('div', { class: 'member' }, [
      button,
      availability ? el('p', { text: availability }) : null,
      basisLine ? el('p', { class: 'note', text: `Recorded basis: ${basisLine}` }) : null,
    ]);
  }
  function gatherRelations(rel = state.relations) {
    const groups = relationGroups(rel.id, rel.map);
    return { groups, shown: relationShown(groups) };
  }
  function renderRelations(view = 'relations') {
    ensureFrame();
    const workspace = view === 'workspace';
    const rel = state[view];
    const prefix = workspace ? 'worldWorkspace' : 'worldRelation';
    const render = () => renderRelations(view);
    const select = el('select', { id: prefix + 'Start', 'aria-label': 'Record to show relations for' });
    const choices = relationChoices();
    select.append(el('option', { value: '', text: choices.length ? 'Choose a saved record' : 'No saved records loaded' }));
    for (const choice of choices) select.append(el('option', { value: choice.id, text: choice.title && choice.title !== choice.id ? `${choice.title} · ${choice.id}` : choice.id }));
    select.value = choices.some((choice) => choice.id === rel.id) ? rel.id : '';
    on(select, 'change', () => {
      const next = select.value;
      if (next !== rel.id) {
        relationsTicket += 1;
        relationsAbort?.abort();
        relationsAbort = null;
        rel.map = null;
        rel.status = '';
        rel.error = '';
        rel.loading = false;
      }
      rel.id = next;
      if (workspace) clearWorkspaceReading();
      render();
    });
    const typed = el('input', { id: prefix + 'Id', type: 'text', 'aria-label': 'Paste an exact record id',
      placeholder: 'Or paste an exact record id (c-, p-, n-, o-, s-)' });
    typed.value = rel.typed ?? '';
    const show = el('button', { type: 'button', id: prefix + 'Show', text: rel.loading ? 'Loading relations…' : workspace ? 'Explore related items' : 'Show relations' });
    show.disabled = rel.loading || !(select.value || typed.value.trim());
    const status = el('div', { id: prefix + 'Status', role: 'status', 'aria-live': 'polite', text: rel.status });
    const error = el('div', { class: 'err', id: prefix + 'Error', role: 'alert', text: rel.error });
    const results = el('div', { id: prefix + 'Results' });
    const resultsNote = el('p', { class: 'note', text: 'These are local associations kept on this computer. They are not proof that two records are the same thing on a provider.' });
    results.append(resultsNote);
    const focusIdEl = workspace ? el('p', { class: 'mono', id: 'worldWorkspaceFocus', text: rel.id || 'No starting item selected' }) : null;
    const focusChipBox = workspace ? el('div', { id: 'worldWorkspaceFocusChip' }) : null;
    const focusChip = workspace ? workspaceFocusChip(rel) : null;
    if (focusChip && focusChipBox) focusChipBox.append(chips([focusChip]));
    // The typed id updates the shell in place on change. A full re-render would replace the
    // Explore button between mousedown and mouseup and cost a second click in a real browser.
    on(typed, 'change', () => {
      rel.typed = typed.value;
      if (workspace) {
        relationsTicket += 1; relationsAbort?.abort(); relationsAbort = null;
        rel.id = ''; rel.map = null; rel.status = ''; rel.error = ''; rel.loading = false;
        clearWorkspaceReading();
        renderWorkspaceReading();
        results.replaceChildren(resultsNote);
        if (focusIdEl) focusIdEl.textContent = 'No starting item selected';
        if (focusChipBox) focusChipBox.replaceChildren();
      }
      // Mirrors what a full re-render would show for the picker: in Workspace a typed id
      // discards the picked record, in Relations the starting record stays if it still matches.
      select.value = workspace || !choices.some((choice) => choice.id === rel.id) ? '' : rel.id;
      show.disabled = rel.loading || !(select.value || typed.value.trim());
      show.textContent = rel.loading ? 'Loading relations…' : workspace ? 'Explore related items' : 'Show relations';
      status.textContent = rel.status;
      error.textContent = rel.error;
    });
    on(show, 'click', () => runRelations((select.value || typed.value).trim(), view));
    if (rel.map) {
      const { groups, shown } = gatherRelations(rel);
      for (const group of groups) {
        results.append(el('h3', { text: group.label }));
        for (const row of group.rows) results.append(relationRowElements(group, row, workspace ? openWorkspaceItem : openRelation));
      }
      if (!shown) results.append(el('p', { class: 'empty', text: relationEmptyText(rel.map) }));
      const bounds = [];
      if (Number.isInteger(rel.map.inputLimitPerKind)) bounds.push(`records read per kind: up to ${rel.map.inputLimitPerKind}`);
      if (Number.isInteger(rel.map.edgeScanLimit)) bounds.push(`edges scanned: up to ${rel.map.edgeScanLimit}`);
      if (Number.isInteger(rel.map.placeholderLimit)) bounds.push(`unresolved placeholders kept: up to ${rel.map.placeholderLimit}`);
      if (bounds.length) results.append(el('p', { class: 'note', text: `Scan bounds — ${bounds.join(', ')}.` }));
      if (typeof rel.map.enumerationNote === 'string' && rel.map.enumerationNote) results.append(el('p', { class: 'note', text: rel.map.enumerationNote }));
    }
    listPane.replaceChildren(
      el('h2', { text: workspace ? 'Workspace' : 'Relations' }),
      el('p', { class: 'note', text: workspace ? 'Start with any saved item. Read its local associations here, then start from another item. No item is a home or a parent.' : 'Pick one saved record. Relations lists what this computer already links to it. It is not a home, and it does not draw a map.' }),
      el('label', { class: 'lab', for: prefix + 'Start', text: 'Starting record' }),
      select,
      typed,
      el('div', { class: 'row' }, [show]),
      status,
      error,
      ...(workspace ? [el('h3', { text: 'Starting from' }), focusIdEl, focusChipBox] : []),
      results,
    );
    if (workspace) { renderWorkspaceReading(); return; }
    const record = rel.recordId ? findRecord(rel.recordId) : null;
    detailPane.replaceChildren(record ? el('article', { class: 'panel pad local-mark' }, [
      el('h2', { text: record.title || recordLabel(record.id) }),
      el('p', { class: 'mono', text: record.id }),
      availabilityLabel(record) ? el('p', { text: availabilityLabel(record) }) : null,
      el('p', { class: 'note', text: 'Opened from a local association. This does not make the records the same.' }),
    ]) : el('p', { class: 'empty', text: 'Open a related record to see it. Relations does not rank one kind above another.' }));
  }
  function relationEmptyText(map) {
    if (map?.truncated === true || map?.complete === false) {
      return 'No local associations were shown for this record, but the scan stopped early, so more may exist.';
    }
    if (map?.complete === true) return 'No local associations for this record.';
    return 'No local associations were shown for this record. Whether more exist was not reported.';
  }
  async function runRelations(id, view = 'relations') {
    const rel = state[view];
    const render = () => renderRelations(view);
    const raw = typeof id === 'string' ? id.trim() : '';
    if (!raw) { rel.error = 'Choose a saved record or paste an exact id first. Nothing was loaded.'; rel.status = ''; render(); return; }
    if (!validWorldId(raw)) {
      rel.error = 'That is not an id this Studio recognizes. Enter the full id exactly as it was saved (c-, p-, n-, o-, or s-). Nothing was loaded.';
      rel.status = '';
      render();
      return;
    }
    const ticket = ++relationsTicket;
    relationsAbort?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    relationsAbort = controller;
    if (view === 'workspace') { clearWorkspaceReading(); rel.map = null; rel.status = 'Loading local associations…'; }
    rel.id = raw;
    rel.loading = true;
    rel.error = '';
    if (state.view === view) render();
    const params = new URLSearchParams({ id: raw, limit: '100' });
    const result = await call('/map?' + params.toString(), { signal: controller?.signal });
    if (state.view !== view) { rel.loading = false; rel.status = ''; return; }
    if (ticket !== relationsTicket) return;
    rel.loading = false;
    if (result.aborted) { rel.status = ''; return; }
    if (result.status !== 200 || !result.data || !Array.isArray(result.data.nodes) || !Array.isArray(result.data.edges)) {
      rel.map = null;
      rel.status = '';
      rel.error = result.status === 0 ? 'Studio didn’t answer. Nothing new was shown.' : problemText(result.data);
      render();
      return;
    }
    rel.map = result.data;
    const { shown } = gatherRelations(rel);
    rel.status = relationStatus(result.data, shown);
    rel.error = '';
    render();
  }
  function clearWorkspaceReading() {
    workspaceReadTicket += 1;
    workspaceReadAbort?.abort();
    Object.assign(state.workspace, { item: null, readingId: '', readingNode: null, readingError: '', readingLoading: false });
  }
  function findListedRecord(id) {
    for (const kind of ['conversations', 'projects', 'notes', 'objects', 'selections']) {
      const hit = state.lists[kind].items.find((item) => item?.id === id);
      if (hit) return hit;
    }
    return null;
  }
  // Chip for the 'Starting from' header: the map's focus node first, then what the loaded list
  // recorded (custody/coverage). Nothing is claimed when nothing is known.
  function workspaceFocusChip(rel) {
    if (!rel.id) return null;
    const node = (rel.map && Array.isArray(rel.map.nodes) ? rel.map.nodes : []).find((n) => n && n.id === rel.id) ?? null;
    const chip = readerProvenanceChip(node, findListedRecord(rel.id));
    return chip[0] === 'Provenance unknown' ? null : chip;
  }
  function focusReaderHead() {
    if (state.view !== 'workspace' || !readerHeadNode) return;
    try {
      if (typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(max-width: 800px)').matches) {
        readerHeadNode.scrollIntoView?.({ block: 'start' });
      }
    } catch { /* narrow-screen positioning only; focus itself is what matters */ }
    readerHeadNode.focus?.();
  }
  function renderWorkspaceReading() {
    const ws = state.workspace;
    // role=status nodes persist and mutate in place; only the body around them is rebuilt.
    const deployed = readerHeadNode && readerStatusNode
      && [...(detailPane.children ?? [])].includes(readerHeadNode);
    if (!deployed) {
      readerHeadNode = el('h2', { text: 'Reading pane', id: 'worldWorkspaceReadHead', tabindex: '-1' });
      readerStatusNode = el('p', { id: 'worldWorkspaceReadStatus', role: 'status', 'aria-live': 'polite' });
      readerBodyNode = el('div', { id: 'worldWorkspaceReadBody' });
      detailPane.replaceChildren(readerHeadNode, readerStatusNode, readerBodyNode);
    }
    readerStatusNode.textContent = ws.readingLoading ? 'Loading saved item…' : ws.readingError || (ws.item ? 'Saved item opened.' : 'Choose a related item to read here.');
    const children = [];
    if (ws.readingId) children.push(el('p', { class: 'mono', text: ws.readingId }));
    // One chip, derived from the map node that was clicked, corrected by custody/coverage.
    children.push(chips([readerProvenanceChip(ws.readingNode, ws.item ?? null)]));
    if (availabilityLabel(ws.readingNode)) children.push(el('p', { text: availabilityLabel(ws.readingNode) }));
    const item = ws.item;
    if (item) {
      const refocus = el('button', { type: 'button', id: 'worldWorkspaceRefocus', text: 'Start from this item' });
      on(refocus, 'click', () => { ws.typed = ''; return runRelations(item.id, 'workspace').then(() => focusReaderHead()); });
      children.push(refocus);
      if (ID_RE.conversations.test(item.id)) children.push(conversationReading(item, null, null, []));
      else children.push(el('article', { class: 'panel pad local-mark' }, [
        el('h2', { text: item.title || recordLabel(item.id) }),
        availabilityLabel(item) ? el('p', { text: availabilityLabel(item) }) : null,
        ...importedFromLines(item.importedFrom).map((row) => el('p', { class: 'note', text: `${row.label}: ${row.value}` })),
        ...(ID_RE.notes.test(item.id)
          ? [el('div', { class: 'workspace-note', text: typeof item.body === 'string' ? item.body : 'No saved note body was reported.' })]
          : ID_RE.projects.test(item.id)
            ? [kv([
                { label: 'Saved conversations linked', value: String(item.conversationIds?.length ?? 0) },
                { label: 'Notes linked', value: String(item.noteIds?.length ?? 0) },
                { label: 'Other items linked', value: String(item.memberIds?.length ?? 0) },
              ])]
            : [kv(referenceReaderRows(item)),
              el('p', { class: 'note', text: 'Saved reference only. This does not include the source content.' }),
              sourceJumpButton(item)]),
      ]));
    }
    readerBodyNode.replaceChildren(...children);
  }
  async function openWorkspaceItem(row) {
    const id = row?.id, node = row?.node;
    if (!validWorldId(id) || node?.availability === 'unresolved' || node?.availabilityReason === 'NOT_SCANNED') return;
    clearWorkspaceReading();
    const ticket = workspaceReadTicket;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    workspaceReadAbort = controller;
    const ws = state.workspace;
    Object.assign(ws, { readingId: id, readingNode: node, readingLoading: true });
    renderWorkspaceReading();
    const kind = ID_RE.conversations.test(id) ? 'conversations' : ID_RE.projects.test(id) ? 'projects' : ID_RE.notes.test(id) ? 'notes' : id.startsWith('o-') ? 'objects' : 'selections';
    const result = await call(`/${kind}/${encodeURIComponent(id)}`, { signal: controller?.signal });
    if (ticket !== workspaceReadTicket || state.view !== 'workspace') return;
    ws.readingLoading = false;
    if (result.aborted) return;
    if (result.status === 200 && result.data?.id === id) ws.item = result.data;
    else ws.readingError = result.status === 404 ? 'This saved item is missing or stale. That is not proof it was deleted on a provider.'
      : result.status === 409 ? 'This saved item is currently unavailable. It was not marked deleted.'
        : result.status === 0 ? 'Studio didn’t answer. No saved content was opened.' : `This item could not be read. ${problemText(result.data)}`;
    renderWorkspaceReading();
    focusReaderHead();
  }
  async function openRelation(row) {
    const id = row?.id, node = row?.node;
    if (!validWorldId(id)) return;
    if (node && (node.availability === 'unresolved' || node.availabilityReason === 'NOT_SCANNED')) return;
    if (node?.kind === 'project' && ID_RE.projects.test(id)) return openItem('projects', id);
    if (node?.kind === 'note' && ID_RE.notes.test(id)) return openItem('notes', id);
    if ((node?.kind === 'conversation' || id.startsWith('c-')) && ID_RE.conversations.test(id)) return openItem('conversations', id);
    if (REF_RE.test(id) && (id.startsWith('o-') || id.startsWith('s-'))) {
      state.relations.recordId = id;
      await readRecord(id);
      if (state.view === 'relations') renderRelations();
    }
  }
  async function choose(view, { quiet = false } = {}) {
    if (!SHELL_VIEWS.has(view)) return;
    if (state.view !== view) {
      relationsAbort?.abort(); relationsTicket += 1;
      state.relations.loading = false;
      state.workspace.loading = false;
      state.relations.status = '';
      state.workspace.status = '';
      clearWorkspaceReading();
    }
    state.view = view;
    remember();
    applyVisibility();
    if (view !== 'find') { searchAbort?.abort(); searchTicket += 1; state.find.loading = false; }
    if (view !== 'transfer') { exportAbort?.abort(); importAbort?.abort(); exportTicket += 1; importTicket += 1; state.transfer.loading = ''; }
    if (view !== 'relations' && view !== 'workspace') { relationsAbort?.abort(); relationsTicket += 1; state.relations.loading = false; }
    if (view === 'capture') { if (!quiet) announce('Capture.'); return; }
    if (view === 'transfer') {
      loadNamespace();
      renderTransfer();
      await Promise.all([fetchList('conversations'), fetchList('projects'), fetchList('notes')]);
      if (state.view === 'transfer') renderTransfer();
      if (!quiet) announce('Transfer.');
      return;
    }
    if (view === 'relations' || view === 'workspace') {
      loadNamespace();
      renderRelations(view);
      await Promise.all([fetchList('conversations'), fetchList('projects'), fetchList('notes'), fetchList('objects'), fetchList('selections')]);
      if (state.view === view) renderRelations(view);
      if (!quiet) announce(view === 'workspace' ? 'Workspace.' : 'Relations.');
      return;
    }
    if (view === 'find') {
      loadNamespace();
      renderFind();
      if (!quiet) announce('Find.');
      return;
    }
    loadNamespace();
    renderListPane();
    renderDetailPane();
    const loads = [fetchList(view)];
    if (view !== 'projects') loads.push(fetchList('projects'));
    const selected = state.selected[view];
    if (selected) loads.push(fetchItem(view, selected));
    if (!quiet) announce(view === 'conversations' ? 'Saved conversations.' : view === 'projects' ? 'Projects.' : 'Notes.');
    await Promise.all(loads);
  }
  for (const button of buttons) on(button, 'click', () => choose(viewOf(button)));
  let initial = 'capture';
  try {
    const savedView = storeGet('studio.world.view');
    if (SHELL_VIEWS.has(savedView)) initial = savedView;
    const savedSelected = JSON.parse(storeGet('studio.world.selected') || 'null');
    if (savedSelected && typeof savedSelected === 'object') {
      for (const view of VIEWS) if (ID_RE[view].test(savedSelected[view] || '')) state.selected[view] = savedSelected[view];
    }
  } catch { initial = 'capture'; }
  applyVisibility();
  choose(initial, { quiet: true });
  return { choose, view: () => state.view };
}
