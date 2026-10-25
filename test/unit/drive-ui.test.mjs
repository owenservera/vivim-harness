// Static checks for the calibration (/drive) page copy. No browser, no Chrome/CDP, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../../src/studio/ui/drive.html');
const source = read('../../src/studio/ui/drive.mjs');
const textOnly = (s) => s.replace(/<style[\s\S]*?<\/style>/g, '');

test('drive.mjs parses and every element it uses exists in drive.html', () => {
  assert.doesNotThrow(() => new Script(source));
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = [...source.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length > 30);
  for (const id of new Set(used)) assert.ok(ids.has(id), 'missing #' + id);
  assert.match(html, /<script type="module" src="\/ui\/drive\.mjs"><\/script>/);
  assert.equal((html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? []).length, 0);
});

test('a matching reply is never called verified or accepted; labels are text, not success glyphs', () => {
  assert.match(source, /verified: \{ label: 'Reply matched'/);
  assert.match(source, /unverified: \{ label: 'Reply not confirmed'/);
  // Old API status values are still the keys, so the contract is untouched.
  for (const key of ["verified:", "unverified:", "failed:", "blocked:", "'not-run':"]) assert.ok(source.includes(key), key);
  assert.doesNotMatch(source, /label: '(Verified|Unverified)'/);
  const visible = textOnly(html) + source;
  assert.doesNotMatch(visible, /[✓✔✕✗⊘●]/u, 'no success/status glyphs');
  assert.doesNotMatch(source, /glyph/);
  assert.doesNotMatch(visible, /[“"]Verified[”"]/);
  assert.doesNotMatch(visible, /\bverified\b[^'\n]*means the reply was confirmed/i);
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ''), /\baccepted\b/i, 'this page never claims capture acceptance');
  assert.doesNotMatch(textOnly(html), /\baccepted\b/i);
});

test('capture acceptance is stated as not checked wherever results are shown', () => {
  assert.match(html, /Capture acceptance not checked: this page doesn’t say whether the saved recording is complete or intact/);
  assert.match(html, /id="acceptNote"[^>]*hidden>Capture acceptance not checked\./);
  assert.match(source, /Capture acceptance not checked\./);
  assert.match(source, /\$\('#acceptNote'\)\.hidden = job\.dryRun/);
  const done = source.slice(source.indexOf("case 'done':"), source.indexOf("case 'failed':"));
  assert.match(done, /Capture acceptance not checked\./);
  assert.match(done, /Dry run finished\. Nothing was sent to any site\./, 'dry run text is unchanged');
});

test('stopping is "after current site", not an immediate abort, in every place it is described', () => {
  assert.match(html, /id="btnCancel"[^>]*>Stop after current site<\/button>/);
  assert.match(html, /The current site may finish\. No next site starts; this does not stop generation on the website\./);
  assert.doesNotMatch(textOnly(html), /Cancel job|can’t be recalled/);
  assert.match(source, /'Stop after current site'/);
  assert.match(source, /'Stop requested'/);
  assert.match(source, /Stop requested\. The current site may finish, and no next site will start\./);
  assert.match(source, /Stopped before finishing\. The site that was running may have finished, and no next site was started\. This did not stop generation on the website\./);
  assert.match(source, /cancelled: 'Stopped'/);
  assert.doesNotMatch(source, /Cancelling…|Could not cancel|Cancelled before finishing/);
  assert.match(source, /stop it after the current site/);
  // The request itself is unchanged: same endpoint, same body, same job states.
  assert.match(source, /'\/jobs\/' \+ encodeURIComponent\(job\.id\) \+ '\/cancel', \{ method: 'POST', body: \{\} \}/);
  assert.match(source, /const ACTIVE = new Set\(\['queued', 'running'\]\)/);
  // A stop request keeps polling: the job is still running until the server finishes cleanup.
  assert.match(source, /if \(ACTIVE\.has\(next\.state\)\) S\.stopRequested = next\.id;/);
});

test('summary tallies use the new labels and still count by API verdict', () => {
  assert.match(source, /' reply matched · '/);
  assert.match(source, /' reply not confirmed · '/);
  assert.match(source, /if \(p\.verdict in c\) c\[p\.verdict\]\+\+;/);
  assert.match(html, /“Reply matched” only means the reply matched the expected words/);
});

test('default prompt comes from /sites only; nothing is hardcoded', () => {
  assert.match(source, /typeof data\.defaultPrompt === 'string' && data\.defaultPrompt/);
  assert.match(source, /\$\('#prompt'\)\.placeholder = data\.defaultPrompt/);
  assert.doesNotMatch(source + html, /alpha bravo|foxtrot|Reply with exactly these/i);
  assert.match(html, /placeholder="Fixed 12-word calibration sentence \(used when this is empty\)"/);
  assert.match(html, /Leave empty to send the fixed 12-word calibration sentence\. A prompt/);
});

test('API /sites returns defaultPrompt so the placeholder can show the real sentence', () => {
  const api = read('../../src/studio/drive-api.mjs');
  const fn = api.slice(api.indexOf('async function sites()'), api.indexOf('async function validate('));
  assert.match(fn, /\bdefaultPrompt\s*[,:]/);
});
