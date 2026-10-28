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

test('provider chip selection tracks the original site dropdown and mode changes', () => {
  assert.match(script, /S\.site = \$\('#site'\)\.value; renderConnect\(\); renderWelcome\(S\.snap\)/);
  assert.match(script, /S\.mode = r\.value; \$\('#connectError'\)\.textContent = ''; renderConnect\(\); renderWelcome\(S\.snap\)/);
  assert.match(script, /provider === S\.site && S\.mode === 'new'/);
  assert.match(script, /typeof choices\.querySelectorAll === 'function'/);
});


test('empty provider states invalidate the chooser cache after discovery failures', () => {
  // Loading -> error -> loaded-empty must update the displayed status, not retain stale "Looking for ..." text.
  assert.match(script, /const signature = sites\.map\(\(site\) => site\.id\)\.join\('\|'\) \+ \(!sites\.length \? ':' \+ S\.targetsState : ''\)/);
  assert.match(script, /No supported websites reported by this Studio yet\./);
  assert.match(script, /Looking for supported AI websites…/);
});

test('World navigation keeps the visible breadcrumb synchronized', () => {
  assert.match(html, /id="vivimViewBreadcrumb" aria-live="polite"/);
  const worldSource = readFileSync(new URL('../../src/studio/ui/world-view.mjs', import.meta.url), 'utf8');
  assert.match(worldSource, /doc\.getElementById\?\.\('vivimViewBreadcrumb'\)/);
  assert.match(worldSource, /conversations: 'Saved conversations'/);
  assert.match(worldSource, /relations: 'Relations', workspace: 'Workspace'/);
  assert.match(worldSource, /breadcrumb\.textContent = 'Your AI World \/ ' \+/);
});

test('projects render source-bound cards with decorative, non-invented covers', () => {
  const worldSource = readFileSync(new URL('../../src/studio/ui/world-view.mjs', import.meta.url), 'utf8');
  assert.match(worldSource, /vivim-record-list-projects/); // constructed from current real state.view
  assert.match(worldSource, /vivim-card-art-'/);
  assert.match(worldSource, /Local project · saved grouping/);
  assert.match(worldSource, /openItem\(state\.view, item\.id\)/);
  assert.match(html, /Project gallery inspired by the VIVIM project-board reference/);
  assert.doesNotMatch(worldSource, /https:\/\/images\.unsplash\.com|randomuser\.me/);
});

test('native Home and Settings views reuse World and do not impersonate account login', () => {
  const worldSource = readFileSync(new URL('../../src/studio/ui/world-view.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="viewHome" data-view="home"/);
  assert.match(html, /id="viewSettings" data-view="settings"/);
  assert.match(worldSource, /function renderHome\(\)/);
  assert.match(worldSource, /function renderSettings\(\)/);
  assert.match(worldSource, /function loadSettingsSites\(\)/);
  assert.match(worldSource, /Supported websites are not verified logins or connected accounts/);
  assert.match(worldSource, /A user-selected storage folder picker is not available in this build/);
  assert.match(worldSource, /No account connection or workspace folder is inferred/);
  assert.match(worldSource, /choose\('transfer'\)/);
});

test('Relations graph is a bounded rendering of real map responses, not a fabricated hub', () => {
  const worldSource = readFileSync(new URL('../../src/studio/ui/world-view.mjs', import.meta.url), 'utf8');
  assert.match(worldSource, /export function graphProjection\(map, focusId, maxNodes = 12\)/);
  assert.match(worldSource, /Only links returned by the local map are drawn/);
  assert.match(worldSource, /const projected = graphProjection\(rel\.map, rel\.id, 12\)/);
  assert.match(worldSource, /if \(!workspace\) results\.append\(renderRelationGraph\(rel\)\)/);
  assert.match(html, /vivim-graph-panel/);
});

test('World layout changes by the active native view, without replacing its detail pane', () => {
  const worldSource = readFileSync(new URL('../../src/studio/ui/world-view.mjs', import.meta.url), 'utf8');
  assert.match(worldSource, /root\.setAttribute\('data-active-view', state\.view\)/);
  assert.match(html, /#worldShell\[data-active-view="projects"\] #worldGrid/);
  assert.match(html, /#worldShell\[data-active-view="settings"\] #worldGrid/);
  assert.match(html, /#worldShell\[data-active-view="relations"\] #worldGrid/);
});

test('chat provider rail reflects real site choices and cannot switch an active native conversation', () => {
  assert.match(html, /id="vivimChatProviders" role="group"/);
  assert.match(script, /const strip = \$\('#vivimChatProviders'\)/);
  assert.match(script, /strip\.hidden = view\.visible/);
  assert.match(script, /if \(S\.snap && S\.snap\.state !== 'closed'\) return/);
  assert.match(script, /button\.disabled = active \|\| S\.targetsState !== 'ok'/);
  assert.match(script, /Choose ' \+ siteName\(site\.id\) \+ ' for a new conversation \(does not connect\)'/);
});
