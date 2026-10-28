// Frontend-only preview; generated files always come from the canonical Harness UI.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'src', 'studio', 'ui');
const defaultOutput = path.join(here, 'dist');
const modules = ['chat.mjs', 'world-view.mjs', 'universal-chat.mjs'];
const jsTag = '<script type="module" src="/ui/chat.mjs"></script>';
const css = [
  '.vivim-preview-label { position: fixed; right: 16px; bottom: 16px; z-index: 999; max-width: min(320px, calc(100vw - 32px));',
  'padding: 12px 15px; border: 1px solid #7194c8; border-radius: 12px; background: #081626ef;',
  'color: #e8f1ff; box-shadow: 0 8px 36px #0009; font: 700 12px/1.4 Segoe UI,system-ui,sans-serif; text-align: center; }',
  '.vivim-preview-label span { display: block; color: #a7bddb; font-size: 11px; font-weight: 400; }',
  '.vivim-preview-disabled { color: #8eabc8; font-size: 12px; border: 1px solid #2c3d54; border-radius: 8px; padding: 10px; }',
].join('\n');
const badge = '<aside class="vivim-preview-label" role="status">VIVIM UI PREVIEW · DEMO DATA<span>Read-only sample content. No provider connection or data writes.</span></aside>';

export function buildPreview(outputDir = defaultOutput) {
  let html = readFileSync(path.join(source, 'chat.html'), 'utf8');
  if (!html.includes(jsTag) || !html.includes('<body class="vivim-app">') || !html.includes('</style>'))
    throw new Error('Canonical VIVIM HTML has changed; review the preview builder');
  html = html.replace(jsTag, '<script type="module" src="/ui/preview-fixture.mjs"></script>\n' + jsTag)
    .replace('</style>', css + '\n</style>')
    .replace('<body class="vivim-app">', '<body class="vivim-app vivim-preview">')
    .replace('</body>', badge + '\n</body>')
    .replace('<a href="/">Advanced Studio</a>', '<span class="vivim-preview-disabled">Advanced Studio · local only</span>')
    .replace('<a href="/drive">Calibrate sites</a>', '<span class="vivim-preview-disabled">Site calibration · local only</span>')
    .replace('Connect your AI</button>', 'Explore connection UI</button>');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(path.join(outputDir, 'ui'), { recursive: true });
  writeFileSync(path.join(outputDir, 'index.html'), html);
  for (const name of modules) cpSync(path.join(source, name), path.join(outputDir, 'ui', name));
  cpSync(path.join(here, 'preview-fixture.mjs'), path.join(outputDir, 'ui', 'preview-fixture.mjs'));
  return { outputDir, modules, htmlBytes: Buffer.byteLength(html) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(JSON.stringify(buildPreview()) + '\n');
