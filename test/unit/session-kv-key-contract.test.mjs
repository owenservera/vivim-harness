// Regression (issue #84, found live on real ChatGPT 2026-10-24): the conversation adapter wrote
// session KV keys such as `CONVERSATION_ATTEMPT:<id>`, which the session store rejects
// (`invalid key`), so the very first typing step of every real send failed. Offline fakes never
// validated keys. This guard checks every literal kv.set(...) key in src against the store rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const KEY_RULE = /^[A-Za-z0-9._-]{1,128}$/;
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = path.join(d, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.mjs') ? [p] : [];
});

test('every literal kv.set key in src satisfies the session store key rule', () => {
  const offenders = [];
  let checked = 0;
  for (const file of walk(src)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/kv\??\.set\??\.?\(\s*([`'"])((?:(?!\1).)*)\1/g)) {
      const sample = m[2].replace(/\$\{[^}]*\}/g, 'a1b2c3d4-0000-4000-8000-000000000000');
      checked++;
      if (!KEY_RULE.test(sample)) offenders.push(`${path.relative(src, file)}: ${m[2]}`);
    }
  }
  assert.ok(checked >= 5, `expected to inspect several kv.set keys, saw ${checked}`);
  assert.deepEqual(offenders, []);
});
