// VIVIM first visible UI slice. Pure status helper + markup contracts; no live browser effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { welcomeView } from '../../src/studio/ui/chat.mjs';

const html = readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../src/studio/ui/chat.mjs', import.meta.url), 'utf8');

test('first-use state does not infer a provider login or automatically perform any effect', () => {
  assert.deepEqual(welcomeView(null), {
    visible: true, busy: false,
    status: 'Choose a provider and connection mode below. Connecting does not send a message.',
  });
  assert.equal(welcomeView(null, true).busy, true);
  assert.equal(welcomeView({ state: 'disconnected' }).visible, true);
  assert.equal(welcomeView({ state: 'closed' }).visible, true);
  for (const state of ['ready', 'blocked', 'needs-reconciliation', 'busy']) {
    assert.equal(welcomeView({ state }).visible, false, state);
  }
  assert.equal(welcomeView({ state: 'ready' }, true).busy, false);
});

test('VIVIM identity and accessible first-use steps are inside the ONE existing chat app', () => {
  assert.match(html, /<body class="vivim-app">/);
  assert.match(html, /<h1>VIVIM<\/h1>/);
  assert.match(html, /id="vivimWelcome" aria-labelledby="vivimWelcomeTitle"/);
  assert.match(html, /id="vivimWelcomeStatus" role="status"/);
  assert.match(html, /id="vivimBegin"/);
  assert.match(html, /id="vivimLibrary" disabled/);
  assert.match(html, /<ol class="vivim-welcome-steps"/);
  assert.match(html, /<nav class="modes" id="shellModes"/);
  assert.match(html, /id="worldShell" class="wrap world" hidden/);
  for (const id of ['chatApp','connectBox','connectSummary','btnConnect','viewConversations','composer','btnSend']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /@media \(max-width: 600px\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1, 'single existing application script');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'no inline scripts');
  assert.doesNotMatch(html, /\son(?:click|change|submit|input)=/i, 'no inline handlers');
});

test('first-use buttons only focus/connect through existing controls and open saved view', () => {
  assert.match(script, /\$\('#vivimBegin'\)\.addEventListener\('click'/);
  assert.match(script, /\$\('#connectBox'\)\.open = true/);
  assert.match(script, /\$\('#connectSummary'\)\.focus\(\)/);
  assert.match(script, /\$\('#vivimLibrary'\)\.addEventListener\('click'/);
  assert.match(script, /const view = \$\('#viewConversations'\)/);
  assert.match(script, /renderWelcome\(snap\)/);
  assert.match(script, /if \(world\) \$\('#vivimLibrary'\)\.disabled = false/);
  assert.match(script, /import\('\.\/world-view\.mjs'\)/);
  assert.match(script, /\$\('#btnSend'\)\.addEventListener\('click', sendMessage\)/);
  assert.doesNotMatch(html, /<iframe/i);
});


test('World library cards use accessible source-preserving styles', () => {
  assert.match(html, /\/\* VIVIM World library and detail surface \*\//);
  assert.match(html, /#worldItems \.rowbtn\[aria-current="true"\]/);
  assert.match(html, /#worldList, \.vivim-app #worldDetail/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(script, /import\('\.\/world-view\.mjs'\)/);
});

test('first-use provider choices are sourced only from existing supported-sites and never trigger effects', () => {
  assert.match(html, /id="vivimProviders" class="vivim-provider-choices" role="group"/);
  assert.match(html, /Supported sites are not verified accounts/);
  assert.match(script, /const sites = Array\.isArray\(S\.targets\?\.sites\)/);
  assert.match(script, /S\.mode = 'new'; S\.site = site\.id/);
  assert.match(script, /renderConnect\(\); renderWelcome\(S\.snap\)/);
  assert.match(script, /renderChrome\(\); renderWelcome\(S\.snap\)/);
  assert.doesNotMatch(html, /data-logged-in="true"|data-verified-account="true"/);
});
