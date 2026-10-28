// Loopback-only frontend view. No backend proxy, no provider effects and no credentials.
import { createServer } from 'node:http';
import { readFileSync, createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreview } from './build.mjs';

const root = resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
};
export function createPreviewServer() {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      res.writeHead(405, { ...headers, 'content-type': 'text/plain' }); res.end('Read-only preview'); return;
    }
    if (!/^\/(?:index\.html|ui\/[a-z-]+\.mjs)$/.test(path)) {
      res.writeHead(404, headers); res.end(); return;
    }
    const filename = resolve(join(root, path.slice(1)));
    if (!filename.startsWith(root + sep)) { res.writeHead(403, headers); res.end(); return; }
    try {
      const stat = statSync(filename);
      if (!stat.isFile()) throw Error('not a file');
      res.writeHead(200, { ...headers, 'content-type': types[extname(filename)] || 'application/octet-stream',
        'content-length': stat.size });
      if (req.method === 'HEAD') res.end(); else createReadStream(filename).pipe(res);
    } catch {
      res.writeHead(404, headers); res.end();
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPreview(root);
  const raw = Number(process.env.VIVIM_UI_PREVIEW_PORT || 4173);
  if (!Number.isSafeInteger(raw) || raw < 1024 || raw > 65535) throw Error('Invalid preview port');
  createPreviewServer().listen(raw, '127.0.0.1', () =>
    process.stdout.write('VIVIM UI DEMO only — http://127.0.0.1:' + raw + '/\n'));
}
