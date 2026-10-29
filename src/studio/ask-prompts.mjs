// Tactical prompt-building for `studio ask` (bin/commands/ask.mjs): turns a developer --role plus
// a free-text question and optional git-diff / file context into ONE bounded, role-specific prompt
// string. That string becomes the "question" posted to the EXISTING /api/v1/compare route
// (src/studio/compare-service.mjs), which hard-caps a question at 10,000 characters — MAX_PROMPT_CHARS
// below stays under that with room for the route's own validation. Pure string building: no
// filesystem, network or git access here, so it is exercised offline by `studio ask --print-prompt`.
// Secret-looking paths (.env, credentials, private keys, …) are refused by the CALLER before their
// content ever reaches this module; isSecretPath/secretPathsInDiff are exported so the CLI and this
// module apply the exact same rule.

const MAX_PROMPT_CHARS = 9000;   // stays under compare-service's hard 10,000-char question cap
const MAX_DIFF_CHARS = 4000;
const MAX_FILES_CHARS = 3500;
const MAX_QUESTION_CHARS = 2000;
const HARD_CUT_MARKER = '\n…(cut off to stay under the size limit)';

export const ROLE_NAMES = ['reviewer', 'implementer', 'explainer', 'copywriter'];

// Each role is a bounded, explicit job: what to do, and EXACTLY what shape the answer must take.
// The output format is deliberately mechanical (findings list / single diff / plain prose / plain
// copy) so a plain-language caller can parse or forward the answer without re-asking the AI.
const ROLES = {
  reviewer: {
    label: 'code reviewer',
    instructions: 'Act as a careful, senior code reviewer for the VIVIM Harness codebase (a local-first AI-browser-automation tool). Review the question and any diff/files below. Report concrete, specific findings only — do not rewrite the code and do not restate the diff back.',
    outputFormat: 'Respond with a numbered list of findings, nothing else. Each line: "N. [SEVERITY] file:line — description", where SEVERITY is one of CRITICAL, HIGH, MEDIUM, LOW, NIT. If a finding has no clear file:line, write "file:?" rather than omitting the field. If there are no findings, respond with exactly: "No findings."',
  },
  implementer: {
    label: 'implementer',
    instructions: 'Act as an implementer for the VIVIM Harness codebase. Make the smallest correct change that satisfies the question, consistent with the existing code shown below.',
    outputFormat: 'Respond with ONE unified diff ONLY (git-style: "diff --git", "---", "+++", "@@" hunks — applyable with "git apply"). No prose before or after it, no explanation, no markdown code fences: output the raw diff text and nothing else.',
  },
  explainer: {
    label: 'explainer',
    instructions: 'Act as an explainer for a developer who does not know this part of the VIVIM Harness codebase yet. Explain the question and any diff/files below clearly and accurately.',
    outputFormat: 'Respond in plain prose: short paragraphs or a short bulleted list. Cover the "why", not only the "what". End with one short summary sentence.',
  },
  copywriter: {
    label: 'copywriter',
    instructions: 'Act as a copywriter for VIVIM, a consumer product. Write the user-facing wording the question asks for.',
    outputFormat: 'Respond in plain consumer wording only: no developer jargon (no "revision", "turn", "capture", "token", "endpoint", "API", "diff", "schema", "payload", etc.), no code, no markdown headers, short sentences. If several short texts are needed, list each on its own line prefixed by its purpose in parentheses, e.g. "(error title) …".',
  },
};

export function roleSpec(role) {
  const spec = ROLES[role];
  if (!spec) throw new RangeError(`Unknown role "${role}". Use one of: ${ROLE_NAMES.join(', ')}.`);
  return spec;
}

// A path that looks like it holds secrets. Checked by the CLI before reading --files content and
// before accepting a --diff range that touches such a path; never relied on as the only safeguard,
// but every such path is kept out of a prompt sent to a third-party AI website.
const SECRET_PATH_RE = /(^|[\\/])(\.env(\..+)?|\.npmrc|\.netrc|id_rsa(\.pub)?|[^\\/]*\.pem|[^\\/]*\.key|[^\\/]*credentials[^\\/]*|[^\\/]*secrets?\.(json|ya?ml|txt)|[^\\/]*\.pfx|[^\\/]*\.p12)$/i;
export const isSecretPath = (p) => SECRET_PATH_RE.test(String(p ?? '').replace(/\\/g, '/'));

// Unified-diff file headers ("diff --git a/X b/Y") -> any touched path that looks secret.
const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)$/gm;
export function secretPathsInDiff(diffText) {
  const found = new Set();
  for (const m of String(diffText ?? '').matchAll(DIFF_HEADER_RE)) {
    if (isSecretPath(m[1])) found.add(m[1]);
    if (isSecretPath(m[2])) found.add(m[2]);
  }
  return [...found];
}

function cap(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? { text: s, trimmed: false } : { text: s.slice(0, max), trimmed: true };
}
function section(title, body) { return body ? `\n\n--- ${title} ---\n${body}` : ''; }

// @serves ask
// Build the bounded, role-specific prompt string. `role` is optional: with no role (but a diff
// and/or files), the question is still assembled with that context and no imposed output format.
// Always returns a prompt under MAX_PROMPT_CHARS, plus the human-readable `warnings` for anything
// that had to be trimmed or dropped to get there (the CLI surfaces these as "warning:" lines).
export function buildPrompt({ role = null, question = '', diff = '', diffRange = null, files = [] } = {}) {
  const spec = role ? roleSpec(role) : null;
  const warnings = [];

  const q = cap(question, MAX_QUESTION_CHARS);
  if (q.trimmed) warnings.push(`Question was trimmed to ${MAX_QUESTION_CHARS} characters.`);

  let diffBlock = '';
  if (typeof diff === 'string' && diff.trim()) {
    const d = cap(diff.trim(), MAX_DIFF_CHARS);
    if (d.trimmed) warnings.push(`--diff${diffRange ? ` ${diffRange}` : ''} output was trimmed to ${MAX_DIFF_CHARS} characters.`);
    diffBlock = section(`DIFF${diffRange ? ` (${diffRange})` : ''}${d.trimmed ? ' — TRIMMED' : ''}`, '```diff\n' + d.text + (d.trimmed ? '\n… (trimmed)' : '') + '\n```');
  }

  let filesBlock = '';
  if (files.length) {
    let budget = MAX_FILES_CHARS;
    const parts = [];
    for (const f of files) {
      if (budget <= 0) { warnings.push(`File "${f.path}" was dropped (the combined --files budget was already used).`); continue; }
      const take = Math.min(budget, f.content.length);
      const trimmed = f.content.length > take;
      if (trimmed) warnings.push(`File "${f.path}" was trimmed to ${take} characters.`);
      parts.push(`### ${f.path}${trimmed ? ' — TRIMMED' : ''}\n\`\`\`\n${f.content.slice(0, take)}${trimmed ? '\n… (trimmed)' : ''}\n\`\`\``);
      budget -= take;
    }
    filesBlock = section('FILES', parts.join('\n\n'));
  }

  const header = spec
    ? `You are acting in the ${spec.label} role for this question. ${spec.instructions}\n\nOutput format (follow exactly): ${spec.outputFormat}`
    : 'Answer the question below, using the attached diff/files as context.';
  let prompt = `${header}\n\nQuestion:\n${q.text}${diffBlock}${filesBlock}`;

  if (prompt.length > MAX_PROMPT_CHARS) {
    // Correctness over completeness: drop content from the END (it was appended last — files, then
    // diff) rather than mangling the role instructions, which define what is actually being asked.
    warnings.push(`Combined prompt exceeded the size limit and was cut off (kept the first ${MAX_PROMPT_CHARS} characters).`);
    prompt = prompt.slice(0, MAX_PROMPT_CHARS - HARD_CUT_MARKER.length) + HARD_CUT_MARKER;
  }
  return { prompt, warnings, role, label: spec?.label ?? null };
}
