// Frontend-only, deterministic Chat UI checks. No browser, no Chrome/CDP, no live data.
// One test starts the Studio server on loopback with an injected fake runtime to prove /chat is really served.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CRLF-safe: working copies may use \r\n; every slice and regex below assumes \n only.
const read = (name) => readFileSync(new URL('../../src/studio/ui/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const lf = (s) => s.replace(/\r\n/g, '\n');
const html = read('chat.html');
const source = read('chat.mjs');
const ui = await import('../../src/studio/ui/chat.mjs'); // importing must not touch document or fetch

const READY = { ready: true, draft: { present: false, chars: 0 }, reason: null };
const ready = (extra = {}) => ({
  id: 'c1', revision: 3, state: 'ready', site: 'chatgpt', binding: { targetId: 't1', origin: 'https://chatgpt.com', ownedByStudio: false },
  sessionId: 's1', turn: null, readiness: READY, diagnostic: { finishPhase: 'idle', finishError: null, uncertainty: null },
  reply: { state: 'unknown', source: 'page', text: '', chars: 0, completion: 'unknown' },
  capture: { state: 'recording', integrity: null }, limitations: [], ...extra,
});
const blockedTurn = (reason = 'DRAFT_PRESENT') => ({ id: 'a1', phase: 'blocked', reason, send: { state: 'not-attempted', observationSource: null } });
const draftBlocked = (extra = {}) => ready({
  state: 'blocked', readiness: { ready: false, draft: { present: true, chars: 9 }, reason: 'DRAFT_PRESENT' }, turn: blockedTurn(), ...extra,
});

test('chat.mjs imports cleanly outside a browser and exposes pure helpers', () => {
  for (const name of ['canSend', 'pickSnapshot', 'captureChip', 'sourceLabel', 'replyBlocks', 'isAmbiguous', 'pollDelay', 'readinessPanel', 'pendingRegistered', 'explainError'])
    assert.equal(typeof ui[name], 'function', name);
});

test('Studio really serves /chat and /ui/chat.mjs (loopback, injected fake runtime, no browser)', async (t) => {
  const { startStudio } = await import('../../src/studio/server.mjs');
  const { dataPaths, ensureDataDirs } = await import('../../src/config.mjs');
  const { ProfileStore } = await import('../../src/profiles/profiles.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'chat-ui-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const runtime = { isSessionActive: () => false, close: async () => {}, targets: async () => ({ sites: [], targets: [] }), list: async () => [] };
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, token: 'fixture-token', accessMode: 'token', conversationRuntime: runtime });
  t.after(async () => { await studio.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${studio.port}`, auth = { 'x-studio-token': 'fixture-token' };

  assert.equal((await fetch(base + '/chat')).status, 401, 'needs the studio token');
  const page = await fetch(base + '/chat', { headers: auth });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(lf(await page.text()), html);
  const script = await fetch(base + '/ui/chat.mjs', { headers: auth });
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal(lf(await script.text()), source);
  assert.equal((await fetch(base + '/chat', { method: 'POST', headers: auth })).status, 405);
  assert.equal((await fetch(base + '/drive', { headers: auth })).status, 200, '/drive is retained');
  assert.equal((await (await fetch(base + '/api/v1/conversation-targets', { headers: auth })).json()).sites.length, 0);
});

test('page is a module-only, CSP-safe document with every referenced element present', () => {
  assert.match(html, /<script type="module" src="\/ui\/chat\.mjs"><\/script>/);
  assert.equal((html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? []).length, 0, 'no inline script');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = [...source.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length > 30);
  for (const id of new Set(used)) assert.ok(ids.has(id), 'missing #' + id);
  assert.doesNotMatch(source, /\.innerHTML\s*=/, 'site text is never injected as HTML');
  for (const gone of ['btnSame', 'draftPanel', 'btnDraft']) assert.ok(!html.includes(gone), gone + ' was replaced');
});

test('controls are labelled, placeholder is the plain composer text, and hit areas are 44px', () => {
  assert.match(html, /<label for="prompt"[^>]*>Message<\/label>/);
  assert.match(html, /placeholder="Write a message to this website"/);
  assert.match(html, /maxlength="250000"/);
  assert.match(html, /<label for="site"[^>]*>Site<\/label>/);
  assert.match(html, /role="radiogroup" aria-labelledby="tabsLabel"/);
  assert.match(html, /button, select, input\[type=text\], textarea, summary, a\.hit \{ min-height: 44px; \}/);
  assert.match(html, /\.pick \{[^}]*min-height: 44px/);
  assert.match(html, /:focus-visible/);
  for (const label of ['Open a new tab', 'Use a tab I already have open', 'Connect and start recording', 'Finish capture', 'Also close the tab Studio opened', 'Check again (read-only)', 'Send again', 'Copy my message', 'Resolve draft in Chrome', 'Calibrate sites'])
    assert.ok(html.includes(label), label);
  // One inline Send. The old confirmation dialog, the re-post recovery and the Switch-to-Chrome button are gone.
  assert.match(html, /<button type="button" class="primary" id="btnSend" disabled>Send<\/button>/);
  for (const gone of ['Send message…', 'Send now', 'Don’t send', 'confirmPanel', 'confirmBox', 'Recover request status', 'Check status', 'Discard this request', 'btnSwitch'])
    assert.ok(!html.includes(gone), gone + ' was removed');
  assert.match(html, /We can’t confirm your message was sent\. Studio will not send it again\./);
  assert.match(html, /@media \(min-width: 1100px\)[\s\S]*340px/);
  // Progressive disclosure: Details is collapsed on narrow screens and only forced open on wide ones by script.
  assert.match(html, /<details class="panel" id="detailsBox">/);
  assert.match(source, /wide\?\.matches\) \$\('#detailsBox'\)\.open = true/);
  // No fixed minimum width that could push a 390px screen sideways; the pinned composer releases on short screens.
  assert.doesNotMatch(html.slice(html.indexOf('<style>'), html.indexOf('</style>')), /(?<![-(])min-width:\s*(?!0\b)\d{3,}px/);
  assert.match(html, /@media \(max-height: 640px\) \{ \.composer \{ position: static;/);
  assert.ok(!html.includes('Send the same request again'), 'ambiguous resend label removed');
  assert.ok(!html.includes('same request ID'), 'no same-ID re-post wording remains');
});

test('keyboard contract: Enter is a newline and no keyboard shortcut sends', () => {
  assert.doesNotMatch(source, /addEventListener\('keydown'/, 'no key handler at all: Enter stays a plain newline');
  assert.doesNotMatch(source, /ctrlKey|metaKey/, 'no Ctrl/Cmd+Enter send shortcut');
  assert.doesNotMatch(source, /confirmOpen|openConfirm|closeConfirm|confirmBox/, 'confirmation step removed');
  assert.match(source, /\$\('#btnSend'\)\.addEventListener\('click', sendMessage\)/);
});

test('existing pages stay: default view is Capture, /drive remains, Chat is linked additively', () => {
  const index = read('index.html'), live = read('live.html'), drive = read('drive.html');
  assert.match(index, /<button data-view="capture" aria-current="page">Capture<\/button>/);
  assert.match(index, /<section class="view on" id="v-capture">/);
  assert.match(index, /href="\/chat">Chat<\/a>/);
  assert.match(index, /href="\/drive">Live drive<\/a>/);
  assert.match(live, /href="\/chat">Chat<\/a>/);
  assert.match(live, /href="\/drive">Live drive<\/a>/);
  assert.match(drive, /href="\/chat">Chat<\/a>/);
  assert.match(html, /href="\/drive">Calibrate sites<\/a>/);
});

test('capture is never shown as accepted unless the evaluator says accepted', () => {
  assert.equal(ui.captureChip('accepted')[0], 'Capture accepted');
  for (const state of ['recording', 'finalizing', 'incomplete', 'rejected', 'verified', 'ok', 'complete', '', undefined, null]) {
    assert.notEqual(ui.captureChip(state)[0], 'Capture accepted', String(state));
    assert.notEqual(ui.captureChip(state)[1], 't-ok', String(state));
  }
  assert.equal(ui.gateChip('passed')[0], 'Passed');
  assert.equal(ui.gateChip(undefined)[0], 'Unknown');
  assert.equal(ui.gateChip('bogus')[0], 'Unknown');
  assert.equal(ui.gateValue({ id: 'G3' }), 'unknown');
  assert.equal(ui.gateValue({ ok: true }), 'passed');
  assert.equal(ui.integrityText({ integrity: null }), 'Not checked');
});

test('reply source and completion are truthful; unknown stays visible', () => {
  assert.match(ui.sourceLabel('network'), /network stream$/);
  assert.match(ui.sourceLabel('page'), /page text.*network stream not matched/);
  assert.match(ui.sourceLabel('differ'), /differ/);
  assert.match(ui.sourceLabel('candidate'), /unverified candidate/);
  assert.equal(ui.sourceLabel(undefined), 'Source: unknown');
  for (const c of [undefined, null, '', 'unknown']) assert.match(ui.completionLabel(c), /^Completion unknown/);
  assert.equal(ui.completionLabel('end-marker-seen'), 'Completion: end marker seen');
});

test('streaming revisions replace text instead of appending snapshots', () => {
  const a = ui.replyBlocks({ state: 'streaming', text: 'Hel', source: 'network' });
  const b = ui.replyBlocks({ state: 'streaming', text: 'Hello', source: 'network' });
  assert.equal(a[0].text, 'Hel'); assert.equal(b[0].text, 'Hello');
  const blocks = ui.replyBlocks({ blocks: [{ kind: 'reasoning', text: 'think' }, { kind: 'answer', text: 'A' }, { kind: 'citations', text: 'c' }], text: 'ignored' });
  assert.deepEqual(blocks.map((x) => x.kind), ['answer', 'reasoning', 'citations']);
  assert.equal(blocks[1].label, 'Reasoning shown by the site');
  assert.equal(ui.replyBlocks(null).length, 0);
  assert.equal(ui.replyBlocks({ state: 'waiting', text: '' }).length, 0);
  assert.equal(ui.shownChars(ui.replyBlocks({ text: 'abcd' })), 4);
});

test('stale snapshots never replace newer ones; other conversations switch', () => {
  const cur = ready({ revision: 5 });
  assert.equal(ui.pickSnapshot(cur, ready({ revision: 4 })), cur);
  const same = ready({ revision: 5 });
  assert.equal(ui.pickSnapshot(cur, same), same);
  const next = ready({ revision: 6 });
  assert.equal(ui.pickSnapshot(cur, next), next);
  const other = ready({ id: 'c2', revision: 1 });
  assert.equal(ui.pickSnapshot(cur, other), other);
  assert.equal(ui.pickSnapshot(cur, { revision: 9 }), cur);
  assert.equal(ui.unwrapConversation({ conversation: cur }), cur);
  assert.equal(ui.unwrapConversation({ error: 'x' }), null);
});

test('send gating: one turn at a time, drafts and uncertain sends block, readiness must be reported ready', () => {
  assert.equal(ui.canSend(ready(), { prompt: 'hi' }).ok, true);
  assert.equal(ui.canSend(ready(), { prompt: '   ' }).ok, false);
  assert.equal(ui.canSend(null, { prompt: 'hi' }).ok, false);
  assert.equal(ui.canSend(ready(), { prompt: 'hi', busy: true }).ok, false);
  const sent = ready({ turn: { id: 't', phase: 'observed', send: { state: 'observed' } } });
  assert.equal(ui.canSend(sent, { prompt: 'hi' }).ok, false);
  assert.match(ui.canSend(sent, { prompt: 'hi' }).reason, /one turn at a time/, 'a started, unfinished turn blocks the next one');
  assert.equal(ui.canSend(ready({ state: 'needs-reconciliation' }), { prompt: 'hi' }).ok, false);
  assert.equal(ui.canSend(ready({ state: 'closed' }), { prompt: 'hi' }).ok, false);
  assert.equal(ui.canSend(ready({ state: 'martian' }), { prompt: 'hi' }).ok, false);
  assert.equal(ui.canSend(ready({ capture: { state: 'finalizing' } }), { prompt: 'hi' }).ok, false);
  assert.equal(ui.canSend(ready({ capture: null }), { prompt: 'hi' }).ok, false);
  // Readiness is never assumed: missing, unchecked or not-ready all block.
  assert.equal(ui.canSend(ready({ readiness: undefined }), { prompt: 'hi' }).ok, false);
  assert.equal(ui.canSend(ready({ readiness: { ready: false, draft: { present: null, chars: null }, reason: 'NOT_CHECKED' } }), { prompt: 'hi' }).ok, false);
  assert.equal(ui.canSend(ready({ readiness: { ready: false, draft: { present: true, chars: 4 }, reason: 'DRAFT_PRESENT' } }), { prompt: 'hi' }).ok, false);
  assert.deepEqual(ui.draftInfo(draftBlocked()), { present: true, unknown: false, chars: 9 });
  assert.equal(ui.draftInfo(ready()).present, false);
  assert.equal(ui.draftInfo({ readiness: { draft: { present: null, chars: null } } }).unknown, true);
});

test('a turn blocked before typing allows a NEW confirmed key only after readiness is proven ready', () => {
  // Still blocked: cannot send, even though no message was ever sent.
  assert.equal(ui.isBlockedTurn(draftBlocked()), true);
  assert.equal(ui.messageStarted(draftBlocked()), false);
  assert.equal(ui.canSend(draftBlocked(), { prompt: 'hi' }).ok, false);
  // Core refreshed readiness after the draft was resolved: state ready, readiness ready, old blocked turn still there.
  const resolved = ready({ turn: blockedTurn(), readiness: READY });
  assert.equal(ui.canSend(resolved, { prompt: 'hi' }).ok, true);
  // Same shape but state still blocked, or readiness not ready: not allowed.
  assert.equal(ui.canSend({ ...resolved, state: 'blocked' }, { prompt: 'hi' }).ok, false);
  assert.equal(ui.canSend({ ...resolved, readiness: { ...READY, ready: false } }, { prompt: 'hi' }).ok, false);
  // Any turn that typed, sent or is uncertain stays one-shot.
  for (const turn of [
    { id: 'x', phase: 'needs-reconciliation', send: { state: 'not-attempted' } },
    { id: 'x', phase: 'preparing', send: { state: 'not-attempted' } },
    { id: 'x', phase: 'dispatching', send: { state: 'submitting' } },
    { id: 'x', phase: 'uncertain', send: { state: 'uncertain' } },
    { id: 'x', phase: 'observed', send: { state: 'observed' } },
  ]) assert.equal(ui.canSend(ready({ turn }), { prompt: 'hi' }).ok, false, turn.phase);
  assert.equal(ui.isBlockedTurn(ready({ turn: { id: 'x', phase: 'blocked', send: { state: 'uncertain' } } })), false);
  // The new submission never reuses the blocked attempt's key: keys come from newKey() per explicit confirm.
  assert.match(source, /key: newKey\(\), prompt, expectedRevision: Number\(snap\.revision\), priorTurnId/);
  assert.equal((source.match(/key: newKey\(\)/g) ?? []).length, 1, 'the only key generator call is the explicit new submission');
  // The new turn is "registered" only when it differs from the blocked one we already knew.
  const pending = { convId: 'c1', key: 'k2', prompt: 'hi', priorTurnId: 'a1' };
  assert.equal(ui.pendingRegistered(pending, resolved), false);
  assert.equal(ui.pendingRegistered(pending, ready({ turn: { id: 'a2', phase: 'preparing', send: { state: 'not-attempted' } } })), true);
  assert.equal(ui.pendingRegistered({ ...pending, priorTurnId: null }, ready({ turn: blockedTurn() })), true);
  assert.equal(ui.pendingRegistered({ ...pending, convId: 'other' }, resolved), false);
});

test('Check again (read-only) is offered for blocked readiness with or without a turn, and explains why', () => {
  const none = ready({ state: 'blocked', readiness: { ready: false, draft: { present: false, chars: 0 }, reason: 'BINDING_CHANGED' } });
  const panelNone = ui.readinessPanel(none);
  assert.equal(panelNone.show, true);
  assert.equal(panelNone.heading, 'Studio can’t send yet');
  assert.match(panelNone.lines.join(' '), /no longer the tab you connected/);
  const panelDraft = ui.readinessPanel(draftBlocked({ diagnostic: { finishPhase: 'idle', finishError: null, uncertainty: null } }));
  assert.equal(panelDraft.show, true); assert.equal(panelDraft.draft, true); assert.equal(panelDraft.chars, 9);
  assert.equal(panelDraft.heading, 'Resolve draft in Chrome');
  assert.equal(ui.readinessPanel(draftBlocked({ turn: blockedTurn('PREFLIGHT_FAILED'), readiness: { ready: false, draft: { present: null, chars: null }, reason: 'PREFLIGHT_FAILED' } })).lines.length >= 1, true);
  assert.equal(ui.readinessPanel(ready()).show, false, 'nothing to explain when ready');
  assert.equal(ui.readinessPanel(ready({ readiness: undefined })).show, true, 'missing readiness is shown as unknown, not as ready');
  for (const state of ['busy', 'attaching', 'finalizing', 'closed', 'needs-reconciliation'])
    assert.equal(ui.readinessPanel(ready({ state, readiness: { ready: false, draft: { present: true, chars: 1 }, reason: 'DRAFT_PRESENT' } })).show, false, state);
  assert.equal(ui.readinessPanel(ready({ state: 'blocked', turn: { id: 's', phase: 'observed', send: { state: 'observed' } }, readiness: { ready: false, draft: { present: true, chars: 1 }, reason: 'DRAFT_PRESENT' } })).show, false);
  // The button reconciles with the current revision; it never posts a turn.
  assert.match(source, /\$\('#btnCheck'\)\.addEventListener\('click', \(\) => reconcile\('#readyError'\)\)/);
  assert.match(source, /\/reconcile', \{ method: 'POST', body: \{ expectedRevision: Number\(S\.snap\.revision\) \} \}/);
  // Honest wording for each state.
  assert.equal(ui.readinessChip(ready())[0], 'Chat box empty');
  assert.equal(ui.readinessChip(draftBlocked())[0], 'Draft in chat box');
  assert.equal(ui.readinessChip(ready({ readiness: undefined }))[0], 'Chat box not checked');
  assert.equal(ui.readinessChip(ready({ readiness: { ready: false, draft: { present: null, chars: null }, reason: 'NOT_CHECKED' } }))[0], 'Chat box not checked');
  assert.equal(ui.readinessChip(ready({ turn: { id: 's', phase: 'observed', send: { state: 'observed' } } })), null);
  assert.equal(ui.readinessText(ready({ readiness: undefined })), 'Not reported');
  assert.equal(ui.readinessText(draftBlocked()), 'Not ready: draft in chat box (9 characters)');
});

test('service reason codes become plain sentences and unknown codes stay visible', () => {
  assert.match(ui.reasonText('DRAFT_PRESENT'), /text in the chat box/);
  assert.match(ui.reasonText('SUBMISSION_STOPPED'), /stopped/);
  assert.match(ui.reasonText('SOMETHING_NEW'), /something new/);
  assert.equal(ui.reasonText(null), '');
  assert.match(ui.uncertaintyText('partial-draft-possible'), /Nothing is known to have been sent/);
  assert.match(ui.finishErrorText('CAPTURE_STOP_FAILED'), /recording stopped/);
  assert.match(ui.explainError({ status: 409, code: 'STALE_REVISION', message: 'STALE_REVISION' }), /nothing was sent/);
  assert.equal(ui.explainError({ status: 409, message: 'DRIVE_LEASE_BUSY' }), 'A Chat conversation or a drive job holds the browser. Finish it in Chat or in Live drive.');
  assert.match(ui.explainError({ status: 409, message: 'ONE_TURN_LIMIT' }), /one message per conversation/);
  assert.match(ui.explainError({ status: 500, message: 'WEIRD_THING' }), /weird thing/);
  assert.equal(ui.explainError({ status: 400, message: 'Message was too long' }), 'Message was too long');
  assert.match(ui.explainError({ status: 401, message: 'unauthorized' }), /Local Studio refused this request\. Check its address and Origin settings/);
  assert.match(ui.explainError({ status: 404, message: 'not found' }), /Not found/);
});

test('uncertain send is distinct from a slow reply; other needs-checking states use their own headline', () => {
  const slow = ready({ state: 'busy', turn: { id: 't', phase: 'observed', send: { state: 'observed' } }, reply: { state: 'waiting' } });
  assert.equal(ui.isUncertain(slow), false);
  assert.equal(ui.isUncertain(ready({ turn: { id: 't', phase: 'uncertain', send: { state: 'uncertain' } } })), true);
  assert.equal(ui.isUncertain(ready({ state: 'needs-reconciliation' })), true);
  assert.equal(ui.sendChip('uncertain')[0], 'Send not confirmed');
  const lost = ready({ state: 'needs-reconciliation', turn: { id: 't', phase: 'uncertain', send: { state: 'uncertain' } }, diagnostic: { uncertainty: 'send-acknowledgement-lost' } });
  assert.match(ui.uncertainView(lost).headline, /^We can’t confirm your message was sent\. Studio will not send it again\.$/);
  const typing = ready({ state: 'needs-reconciliation', turn: { id: 't', phase: 'needs-reconciliation', send: { state: 'not-attempted' } }, diagnostic: { uncertainty: 'partial-draft-possible' } });
  assert.doesNotMatch(ui.uncertainView(typing).headline, /was sent/);
  assert.match(ui.uncertainView(typing).lines.join(' '), /partial text/);
  assert.equal(ui.canCloseTab(ready({ binding: { targetId: 't', origin: 'https://x', ownedByStudio: true } })), true);
  assert.equal(ui.canCloseTab(ready({ binding: { ownedByStudio: true }, turn: { id: 't', phase: 'uncertain', send: { state: 'uncertain' } } })), false);
  assert.equal(ui.canCloseTab(ready({ binding: { ownedByStudio: true }, state: 'needs-reconciliation' })), false);
  assert.equal(ui.canCloseTab(ready({ binding: { ownedByStudio: true }, diagnostic: { uncertainty: 'runtime-restarted' } })), false);
  assert.equal(ui.canCloseTab(ready({ binding: { ownedByStudio: false } })), false);
  assert.equal(ui.canCloseTab(ready({ binding: {} })), false, 'owner tabs and unknown ownership are never offered a close');
});

test('blocked and preparing turns are not shown as sent; the composer keeps the user’s text', () => {
  assert.equal(ui.messageStarted(ready({ turn: { id: 'a', phase: 'preparing', send: { state: 'not-attempted' } } })), false);
  assert.equal(ui.messageStarted(ready({ turn: { id: 'a', phase: 'dispatching', send: { state: 'submitting' } } })), true);
  assert.equal(ui.isActive(ready({ turn: { id: 'a', phase: 'preparing', send: { state: 'not-attempted' } } })), true);
  assert.equal(ui.isActive(draftBlocked()), false);
  // The composer is only emptied when a send was actually started (guarded), never for a blocked turn.
  // ...and only once per started turn, so a message typed for the NEXT turn survives refreshes of an already-sent one.
  assert.match(source, /if \(messageStarted\(snap\) && S\.clearedTurn !== snap\.turn\.id\) \{ prompt\.value = ''; S\.clearedTurn = snap\.turn\.id; \}/);
  assert.doesNotMatch(source, /if \(snap\?\.turn\) prompt\.value = ''/);
  assert.match(source, /chat\.draft\./, 'unsent text survives a reload in this tab');
  assert.match(source, /prompt\.disabled = !!snap && \(snap\.state === 'closed' \|\| turnInFlight\(snap\)\)/);
});

test('HTTP ambiguity: network loss, 5xx and unreadable replies keep the key; 4xx does not', () => {
  assert.equal(ui.isAmbiguous({ status: 0 }), true);
  assert.equal(ui.isAmbiguous({ status: 502 }), true);
  assert.equal(ui.isAmbiguous({ status: 200, malformed: true }), true);
  for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(ui.isAmbiguous({ status }), false, String(status));
  assert.notEqual(ui.newKey(), ui.newKey());
  assert.equal(ui.isAmbiguous({ status: 408 }), true, 'request timeout is ambiguous');
  // No automatic retry: exactly one POST site for turns, and no timer ever reaches it.
  assert.equal((source.match(/'\/turns'/g) ?? []).length, 1);
  assert.doesNotMatch(source, /setTimeout\([^)]*(sendMessage|sendAgain)/);
});

test('polling: about 1s while active, slower when idle, stops when closed', () => {
  assert.equal(ui.pollDelay(ready({ state: 'busy' })), 1000);
  assert.equal(ui.pollDelay(ready({ turn: { id: 't', phase: 'dispatching', send: { state: 'submitting' } } })), 1000);
  assert.equal(ui.pollDelay(ready({ turn: { id: 't', phase: 'observed', send: { state: 'observed' } }, reply: { state: 'streaming' } })), 1000);
  assert.equal(ui.pollDelay(ready()), 5000);
  assert.equal(ui.pollDelay(ready({ state: 'busy' }), { hidden: true }), 3000);
  assert.equal(ui.pollDelay(ready({ state: 'busy' }), { failures: 6 }), 5000);
  assert.equal(ui.pollDelay(ready({ state: 'closed' })), null);
  assert.equal(ui.pollDelay(ready({ state: 'closed', capture: { state: 'finalizing' } })), 1000);
  assert.equal(ui.pollDelay(null), null);
});

test('recording limits warn at 80% and when time is nearly gone', () => {
  const now = 1_000_000;
  assert.equal(ui.limitStatus({ maxBytes: 100, bytesWritten: 50 }, now).warn, false);
  assert.equal(ui.limitStatus({ maxBytes: 100, bytesWritten: 80 }, now).warn, true);
  assert.equal(ui.limitStatus({ endsAt: now + 2 * 60000 }, now).warn, true);
  assert.equal(ui.limitStatus({ endsAt: now + 10 * 60000 }, now).warn, false);
  assert.equal(ui.limitStatus({ limitReason: 'max-bytes' }, now).stopped, 'max bytes');
  assert.equal(ui.limitStatus(null).stopped, null);
});

test('conversation labels, target hints and phase words are plain and honest', () => {
  assert.equal(ui.conversationChip('needs-reconciliation')[0], 'Needs checking');
  assert.equal(ui.replyChip('ready')[0], 'Reply ready');
  assert.equal(ui.replyChip('ready')[1], 't-info', 'reply ready is never styled as success');
  assert.match(ui.conversationChip('weird-state')[0], /weird state/);
  assert.equal(ui.siteName({ id: 'claude' }), 'claude');
  assert.equal(ui.shortUrl('https://x.test/a/b?token=secret'), 'x.test/a/b?…');
  assert.match(ui.targetHint({ site: 'claude', recorderOwner: { sessionId: 's', kind: 'conversation' } }), /Studio conversation/);
  assert.match(ui.targetHint({ site: 'claude', recorderOwner: { sessionId: 's', kind: 'unknown' } }), /already being recorded/i);
  assert.match(ui.targetHint({ site: null }), /doesn’t support/);
  assert.equal(ui.targetHint({ site: 'claude', visibility: 'unknown', recorderOwner: null, ownedByStudio: false }), '');
});


/* ---------------- Chat UI hardening: unknown outcomes, honest status, rendering, contrast ---------------- */
const fnBody = (name) => { const i = source.indexOf(name); assert.ok(i >= 0, name); return source.slice(i, source.indexOf('\n  }\n', i)); };
const unknownSnap = (extra = {}) => ready({ ...extra });
const pend = (extra = {}) => ({ convId: 'c1', key: 'k1', prompt: 'hello', expectedRevision: 3, priorTurnId: null, ...extra });

test('no code path posts to /turns except the one explicit send; the same-key re-post is gone', () => {
  assert.equal((source.match(/\/turns/g) ?? []).length, 1, 'one reference to the turns route');
  const send = fnBody('async function sendMessage()');
  assert.match(send, /'\/turns', \{ method: 'POST', body \}/);
  assert.match(send, /key: newKey\(\)/);
  assert.match(send, /if \(!snap \|\| S\.submitting \|\| S\.pending\) return;/, 'never while a request is pending or unknown');
  // sendMessage is reached only from the Send button and the user-clicked Send again.
  assert.equal((source.match(/\bsendMessage\(/g) ?? []).length, 2, 'definition plus sendAgain');
  assert.equal((source.match(/addEventListener\('click', sendMessage\)/g) ?? []).length, 1);
  assert.match(source, /\$\('#btnSendAgain'\)\.addEventListener\('click', sendAgain\)/);
  // Full-line comments are documentation, not code: strip them before the forbidden-pattern check (code lines still checked).
  const codeOnly = source.split('\n').filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*')); }).join('\n');
  assert.doesNotMatch(codeOnly, /\bretry\b(?! by itself)|btnRecover|btnDiscard|btnStatus|Recover request status/);
  assert.ok(!html.includes('Recover request status'));
  // Reconcile is its own read-only route and never the turns route.
  const rec = fnBody('async function reconcile(');
  assert.doesNotMatch(rec, /turns/);
  assert.match(rec, /\/reconcile', \{ method: 'POST', body: \{ expectedRevision: Number\(S\.snap\.revision\) \} \}/);
});

test('unknown send outcome keeps the composer locked; only a read-only check that finds nothing, or Send again, releases it', () => {
  const snap = unknownSnap();
  // Network loss / 5xx / timeout / unreadable reply => unknown, not "Not sent".
  for (const err of [{ status: 0 }, { status: 502 }, { status: 408 }, { status: 200, malformed: true }]) assert.equal(ui.isAmbiguous(err), true);
  assert.equal(ui.pendingUnknown(pend(), snap), true);
  assert.equal(ui.pendingUnknown(pend(), snap, true), false, 'a request still in flight is not "unknown"');
  assert.equal(ui.pendingUnknown(pend({ convId: 'other' }), snap), false);
  // The catch branch for an unknown outcome keeps the pending request (and so the lock) and never prints "Not sent".
  const send = fnBody('async function sendMessage()');
  const ambiguous = send.slice(send.indexOf('if (isAmbiguous(e))'), send.indexOf('} else {', send.indexOf('if (isAmbiguous(e))')));
  // savePending() runs before the one POST (it persists the attempt the lock depends on); the ambiguous branch must not clear or print "Not sent".
  const savedAt = send.indexOf('savePending()'), postAt = send.indexOf("'/turns'");
  assert.ok(savedAt >= 0 && postAt > savedAt, 'savePending() is called before the /turns POST');
  assert.doesNotMatch(ambiguous, /clearPending|Not sent/);
  // Composer is locked while pending is unknown.
  assert.match(source, /prompt\.readOnly = locked \|\| S\.submitting/);
  assert.match(source, /const check = canSend\(snap, \{ prompt: prompt\.value, busy: S\.submitting \|\| locked \}\)/);
  // A check releases only when no turn was registered and the service itself is not uncertain.
  assert.equal(ui.checkFoundNoMessage(pend(), snap), true);
  assert.equal(ui.checkFoundNoMessage(pend(), ready({ turn: { id: 't9', phase: 'observed', send: { state: 'observed' } } })), false, 'a registered turn is never released');
  assert.equal(ui.checkFoundNoMessage(pend(), ready({ state: 'needs-reconciliation' })), false);
  assert.equal(ui.checkFoundNoMessage(pend(), ready({ turn: { id: 'u', phase: 'uncertain', send: { state: 'uncertain' } } })), false);
  assert.equal(ui.checkFoundNoMessage(pend({ priorTurnId: 'a1' }), ready({ turn: blockedTurn() })), true, 'an older blocked, never-sent turn does not hold the lock');
  assert.equal(ui.checkFoundNoMessage(null, snap), false);
  // Banner copy and guidance.
  const v = ui.uncertainView(snap, { pending: true, detail: 'Could not reach the Studio.' });
  assert.match(v.headline, /^We can’t confirm your message was sent\. Studio will not send it again\.$/);
  assert.match(v.lines.join(' '), /No confirmation came back.*Could not reach the Studio/);
  assert.match(v.lines.join(' '), /can appear twice/);
  assert.equal(ui.chromeGuidance(snap, true), 'Open the tab in Chrome to see whether it was sent.');
  assert.match(ui.chromeGuidance(ready({ binding: { title: 'ChatGPT' } }), true), /^Open the tab in Chrome to see whether it was sent\. It’s the tab “ChatGPT”/);
  // Send again: one click, new key through the same single send path, hidden for a service-side uncertain turn.
  const again = fnBody('function sendAgain()');
  assert.match(again, /clearPending\(\)/);
  assert.match(again, /isUncertain\(S\.snap\)\) return/);
  assert.match(again, /sendMessage\(\)/);
  assert.match(source, /\$\('#btnSendAgain'\)\.hidden = !\(pend && !server\)/);
  assert.match(html, /id="btnSendAgain" hidden>Send again<\/button>/);
  // The tab guidance is plain text, not a control.
  assert.match(html, /<p id="chromeGuide">Open the tab in Chrome to see whether it was sent\.<\/p>/);
  assert.doesNotMatch(html, /<button[^>]*>\s*Switch to Chrome/);
});

test('rejections: 409 advice is per code; Not sent is printed only when the service said not-attempted', () => {
  const rej = (status, code, data = {}) => ui.sendRejection(Object.assign(new Error(code), { status, data: { code, ...data } }));
  const stale = rej(409, 'STALE_REVISION');
  assert.match(stale.text, /Your message is still in the box\./);
  assert.match(stale.text, /Press Send if you still want to send it\./);
  for (const code of ['ONE_TURN_LIMIT', 'CONVERSATION_FINISHED', 'CONVERSATION_NOT_WRITABLE', 'DRIVE_LEASE_BUSY']) {
    const r = rej(409, code);
    assert.doesNotMatch(r.text, /still in the box|Press Send|confirm again|Confirm again|send again/i, code);
    assert.match(r.text, /^Studio rejected this request\. /, code);
  }
  assert.match(rej(409, 'ONE_TURN_LIMIT').text, /one message per conversation/);
  assert.match(rej(409, 'CONVERSATION_FINISHED').text, /has been finished/);
  assert.match(rej(409, 'CONVERSATION_NOT_WRITABLE').text, /can’t send/);
  const busy = rej(409, 'DRIVE_LEASE_BUSY');
  assert.match(busy.text, /A Chat conversation or a drive job holds the browser\. Finish it in Chat or in Live drive\./);
  assert.deepEqual(busy.link, { href: '/drive', text: 'Open Live drive' });
  assert.equal(stale.link, null);
  assert.doesNotMatch(stale.text, /^Not sent/);
  assert.match(rej(409, 'STALE_REVISION', { send: { state: 'not-attempted' } }).text, /^Not sent\. /);
  assert.doesNotMatch(source, /'Not sent: '/, 'the old unconditional prefix is gone');
  // The link is added as a DOM node, not markup.
  assert.match(source, /n\.append\(' ', el\('a', \{ href: link\.href, text: link\.text \}\)\)/);
});

test('Finish is one click; early finish is relabelled; the result shows chip, reasons and the saved session', () => {
  const live = ready({ turn: { id: 't', phase: 'observed', send: { state: 'observed' } }, reply: { state: 'streaming', text: 'Hi' } });
  assert.deepEqual(ui.finishControl(live), { label: 'Finish anyway (capture will be incomplete)', early: true, disabled: false });
  assert.equal(ui.finishControl(ready({ turn: live.turn, reply: { state: 'ready' } })).label, 'Finish capture');
  assert.equal(ui.finishControl(ready()).early, false);
  assert.equal(ui.finishControl(ready({ state: 'closed' })).disabled, true);
  assert.equal(ui.finishControl(live, { working: true }).disabled, true);
  assert.match(source, /\$\('#btnFinish'\)\.addEventListener\('click', finish\)/, 'no arming step');
  assert.doesNotMatch(source, /Armed|armed|aria-pressed/);
  assert.equal(ui.finishOutcome(live), null, 'no outcome while recording');
  const done = ready({
    state: 'closed', capture: { state: 'incomplete' },
    evidence: { gates: [{ id: 'G3', state: 'unknown' }, { id: 'G4', state: 'passed' }, { id: 'G7', state: 'failed', reason: 'DRAFT_PRESENT' }, { id: 'G6' }] },
  });
  const out = ui.finishOutcome(done);
  assert.deepEqual(out.chip, ['Capture incomplete', 't-warn']);
  assert.equal(out.accepted, false);
  assert.deepEqual(out.reasons, ['Reply finished: unknown', 'Page text and network data agree: failed (There’s text in the chat box)', 'Data extracted: unknown']);
  assert.match(ui.finishOutcome(ready({ state: 'closed', capture: { state: 'rejected' } })).reasons[0], /didn’t report which check/);
  const ok = ui.finishOutcome(ready({ state: 'closed', capture: { state: 'accepted' }, evidence: { gates: [{ id: 'G3', state: 'passed' }] } }));
  assert.equal(ok.accepted, true); assert.deepEqual(ok.reasons, []);
  // Finish bar itself: heading takes focus once, saved-session link opens a new tab and says so.
  assert.match(html, /<h3 id="finishHeading" tabindex="-1"/);
  assert.match(html, /id="finishLinks"/);
  assert.match(source, /if \(out && S\.finishFocus\) \{ S\.finishFocus = false; \$\('#finishHeading'\)\.focus\(\); \}/);
  assert.match(source, /newTabLink\('\/#session=' \+ encodeURIComponent\(sid\), 'Open saved session'\)/);
  assert.match(source, /newTabLink\('\/#session=' \+ encodeURIComponent\(sid\), 'Open session'\)/);
  assert.match(source, /el\('span', \{ class: 'sr', text: ' \(new tab\)' \}\)/);
});

test('status is honest: completion-unknown chip, stage headline, partial-text note, ready announcement', () => {
  assert.deepEqual(ui.completionChip('unknown'), ['Network completion: unknown', 't-warn']);
  assert.deepEqual(ui.completionChip(undefined), ['Network completion: unknown', 't-warn']);
  assert.deepEqual(ui.completionChip('end-marker-seen'), ['Network completion: end marker seen', 't-info']);
  assert.notEqual(ui.completionChip('end-marker-seen')[1], 't-ok', 'never styled as success');
  assert.equal(ui.sourceChip('network')[0], 'Source: network stream');
  assert.equal(ui.sourceChip('differ')[1], 't-warn');
  assert.equal(ui.sourceChip(undefined)[0], 'Source: unknown');
  // Chips sit beside each other in the reply and in the top chip row for a ready reply.
  assert.match(source, /syncChips\(\$\('#replyChips'\), \[sourceChip\(reply\.source\), completionChip\(reply\.completion\)\]\)/);
  assert.match(source, /snap\.reply\.state === 'ready' && !completionKnown\(snap\.reply\.completion\)\) out\.push\(completionChip/);
  assert.match(html, /id="replyChips"/);
  assert.doesNotMatch(html, /id="replyMeta"/, 'the muted note line is gone');
  const sent = { id: 't', phase: 'observed', send: { state: 'observed' } };
  assert.equal(ui.stageInfo(ready({ turn: sent, reply: { state: 'streaming' } })).text, 'Step 4 of 5: Reply streaming');
  assert.equal(ui.stageInfo(null).text, 'Step 1 of 5: Connect to a site');
  assert.equal(ui.stageInfo(ready()).text, 'Step 3 of 5: Write your message');
  assert.equal(ui.stageInfo(draftBlocked()).text, 'Step 2 of 5: Chat box not ready');
  assert.equal(ui.stageInfo(ready({ turn: sent, reply: { state: 'ready' } })).text, 'Step 5 of 5: Reply ready. Still recording');
  assert.equal(ui.stageInfo(ready(), { pending: true }).text, 'Step 3 of 5: Send not confirmed');
  assert.equal(ui.stageInfo(ready(), { submitting: true }).text, 'Step 3 of 5: Sending your message');
  assert.equal(ui.stageInfo(ready({ state: 'closed' })).text, 'Step 5 of 5: Capture finished');
  assert.equal(ui.replyMayBePartial({ state: 'interrupted' }), true);
  assert.equal(ui.replyMayBePartial({ state: 'unknown' }), true);
  assert.equal(ui.replyMayBePartial({ state: 'streaming' }), false);
  assert.equal(ui.PARTIAL_TEXT, 'Text may be partial. Finish capture to keep what was recorded.');
  // Ready announcement: source and completion, once, in the single polite region. Streaming text is never announced.
  const rd = ready({ turn: sent, reply: { state: 'ready', source: 'network', completion: 'unknown' } });
  assert.equal(ui.replyReadyText(rd), 'Reply ready. Source: network stream. Network completion: unknown');
  assert.equal(ui.replyReadyText(ready({ turn: sent, reply: { state: 'streaming', text: 'abc' } })), '');
  assert.match(html, /id="announce" role="status" aria-live="polite"/);
  assert.equal((html.match(/aria-live="polite"/g) ?? []).length, 1, 'one polite live region');
  assert.match(source, /parts\.push\(ready \|\| replyChip/);
});

test('reply text updates in place; count and age are shown; nothing is rendered as HTML', () => {
  assert.equal(ui.replyCountText(1204, 3000), '1204 chars, updated 3s ago');
  assert.equal(ui.replyCountText(1, 0), '1 char, updated just now');
  assert.equal(ui.replyCountText(10), '10 chars');
  assert.equal(ui.ago(75000), '1 min ago');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  const set = fnBody('function setNodeText(');
  assert.match(set, /appendData\(next\.slice\(prev\.length\)\)/, 'streamed growth appends to the same text node');
  assert.match(set, /textNode\.data = next/);
  assert.match(source, /const setText = \(node, text\) => \{ if \(node\.textContent !== text\) node\.textContent = text; \}/);
  assert.match(source, /if \(have\.length !== want\.length \|\| want\.some\(\(n, i\) => n !== have\[i\]\)\) holder\.replaceChildren\(\.\.\.want\)/, 'blocks are only re-parented when their order changes');
  assert.doesNotMatch(fnBody('function renderTranscript('), /replyBlocks'\)\.replaceChildren|holder\.replaceChildren\(\.\.\.\(blocks/);
});

test('structure: composer steps aside only while a turn is in flight, banner focus once, links and copy button', () => {
  assert.match(source, /\$\('#composer'\)\.hidden = messageStarted\(snap\) && !composerOpen\(snap\)/);
  // The banner is focused once per transition: keyed, and not also a role=alert (no double announcement).
  assert.match(html, /<div class="banner" id="uncertain" tabindex="-1" aria-labelledby="uncertainHead" hidden>/);
  assert.equal((source.match(/banner\.focus\(\)/g) ?? []).length, 1);
  assert.match(source, /if \(unc && S\.bannerFocus !== focusKey\) \{ S\.bannerFocus = focusKey; banner\.focus\(\); \}/);
  // Tab list empty state links to Studio; DRIVE_LEASE_BUSY links to /drive.
  assert.match(source, /el\('a', \{ class: 'hit', href: '\/', text: 'Open Studio' \}\)/);
  assert.deepEqual(ui.errorLink('DRIVE_LEASE_BUSY'), { href: '/drive', text: 'Open Live drive' });
  assert.equal(ui.errorLink('STALE_REVISION'), null);
  // Copy my message: from in-memory state only, no network and no storage read at click time.
  const copy = fnBody('async function copyMine()');
  assert.match(copy, /S\.pending\?\.prompt \|\| S\.sentPrompt/);
  assert.doesNotMatch(copy, /fetch|api\(|store\.get|\$\('#prompt'\)/);
  assert.match(source, /\$\('#btnCopy'\)\.addEventListener\('click', copyMine\)/);
  assert.match(html, /id="btnCopy" hidden>Copy my message<\/button>/);
});

test('chip tones use text-safe tokens that reach 4.5:1 in light and dark, without touching the global palette', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const hexOf = (m) => [1, 3, 5].map((i) => parseInt(m.slice(i, i + 2), 16));
  const lum = (m) => { const [r, g, b] = hexOf(m).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b, p) => '#' + hexOf(a).map((v, i) => Math.round(v * p + hexOf(b)[i] * (1 - p)).toString(16).padStart(2, '0')).join('');
  const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('@media (prefers-color-scheme: dark)'));
  const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('* { box-sizing'));
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--chip-(ok|info|warn|bad|mute):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
  const get = (block, name) => block.match(new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{6})'))[1];
  for (const [label, block] of [['light', rootBlock], ['dark', darkBlock]]) {
    const t = tokens(block); assert.deepEqual(Object.keys(t).sort(), ['bad', 'info', 'mute', 'ok', 'warn'], label);
    const paper = get(block, 'paper'), panel = get(block, 'panel'), hover = get(block, 'hover');
    const backgrounds = [paper, panel, hover, mix(get(block, 'l1'), panel, 0.08), mix(get(block, 'act'), panel, 0.07), mix(get(block, 'gap'), panel, 0.06)];
    for (const [name, color] of Object.entries(t)) for (const bg of backgrounds) assert.ok(ratio(color, bg) >= 4.5, `${label} ${name} ${color} on ${bg}: ${ratio(color, bg).toFixed(2)}`);
  }
  // Chip classes use the new tokens only; the shared palette values are unchanged.
  assert.match(css, /\.t-ok \{ color: var\(--chip-ok\); \} \.t-info \{ color: var\(--chip-info\); \} \.t-warn \{ color: var\(--chip-warn\); \} \.t-bad \{ color: var\(--chip-bad\); \} \.t-mute \{ color: var\(--chip-mute\); \}/);
  assert.match(css, /--act: #C2721B;/); assert.match(css, /--ok: #2E8C6E;/); assert.match(css, /--l1: #2F6FB3;/);
});


/* ---------------- Page wiring against a minimal DOM fake (no browser, no DOM library) ---------------- */
test('every element chat.mjs looks up exists in chat.html: required via $, optional via opt*, and error-slot selectors', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const required = [...source.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  const optional = [...source.matchAll(/\bopt(?:Text|Hidden)?\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]);
  const literal = [...source.matchAll(/'#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]); // includes selectors passed to setError/reconcile
  assert.ok(required.length > 30);
  assert.ok(optional.length >= 1, 'the optional-element helper is in use');
  for (const id of new Set([...required, ...optional, ...literal])) assert.ok(ids.has(id), 'missing #' + id);
  for (const gone of ['btnDont', 'confirmBox', 'btnSendNow', 'btnSwitch', 'switchNote', 'btnStatus', 'pendingError', 'btnRecover', 'btnDiscard'])
    assert.ok(!source.includes(gone) && !html.includes(gone), gone + ' stays gone');
  // Optional helpers are only for informational notes; every control that is clicked or typed into is required.
  for (const id of optional) assert.doesNotMatch(id, /^btn|^prompt$|^composer$|^site$/, id + ' is a control and must be required');
});

class FakeEl {
  constructor(tag = 'div', id = '') {
    Object.assign(this, { tag, id, children: [], dataset: {}, listeners: {}, attrs: {}, hidden: false, disabled: false, readOnly: false, value: '', textContent: '', open: false, checked: false, className: '' });
  }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {}
  async dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, ...event }); }
}
const textNode = () => ({ data: '', appendData(s) { this.data += s; } });

// Serves one ready conversation. The first POST to /turns fails like a lost connection; later ones are accepted.
function fakeStudio({ failFirstTurn = true, initial, afterTurn } = {}) {
  const posts = [];
  let turnCalls = 0;
  const snapshot = initial ?? ready();
  const sent = afterTurn ?? ready({ revision: 4, turn: { id: 't1', phase: 'observed', send: { state: 'observed' } }, reply: { state: 'waiting', text: '', source: 'page', completion: 'unknown' } });
  const answer = (status, body) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body) });
  const fetchStub = async (url, init = {}) => {
    const method = init.method ?? 'GET', p = String(url).replace(/^\/api\/v1/, '');
    if (method === 'POST') posts.push({ path: p, body: init.body ? JSON.parse(init.body) : null });
    if (p === '/conversation-targets') return answer(200, { sites: [{ id: 'chatgpt' }], targets: [] });
    if (p === '/conversations' && method === 'GET') return answer(200, { conversations: [{ id: 'c1', state: 'ready', site: 'chatgpt', revision: 3 }] });
    if (p === '/conversations/c1' && method === 'GET') return answer(200, { conversation: snapshot });
    if (p === '/conversations/c1/reconcile') return answer(200, { conversation: snapshot });
    if (p === '/conversations/c1/turns') {
      turnCalls++;
      if (failFirstTurn && turnCalls === 1) throw new TypeError('network down');
      return answer(200, { conversation: sent });
    }
    return answer(404, { error: 'not found' });
  };
  return { posts, fetchStub, turnPosts: () => posts.filter((x) => x.path.endsWith('/turns')), otherPosts: () => posts.filter((x) => !x.path.endsWith('/turns')) };
}
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };

let bootCount = 0;
// Installs the globals the page needs, evaluates a fresh copy of chat.mjs (which boots itself), and always restores them.
async function withPage({ omit = [], failFirstTurn = true, initial, afterTurn } = {}, body) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).filter((id) => !omit.includes(id));
  const byId = new Map(ids.map((id) => [id, new FakeEl('div', id)]));
  const windowListeners = {}, warnings = [], unhandled = [];
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const studio = fakeStudio({ failFirstTurn, initial, afterTurn });
  const fakeDocument = {
    hidden: false,
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (sel) => (sel.startsWith('#') ? byId.get(sel.slice(1)) ?? null : null),
    querySelectorAll: (sel) => (sel === 'input[name=mode]' ? ['modeNew', 'modeExisting'].map((id) => byId.get(id)) : []),
    createElement: (tag) => new FakeEl(tag),
    createTextNode: () => textNode(),
    addEventListener() {},
  };
  const saved = Object.fromEntries(['document', 'window', 'fetch', 'sessionStorage', 'localStorage'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const realWarn = console.warn, onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  Object.assign(globalThis, {
    document: fakeDocument, fetch: studio.fetchStub, sessionStorage: store(), localStorage: store(),
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener: (t, f) => { windowListeners[t] = f; } },
  });
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const href = new URL('../../src/studio/ui/chat.mjs?fake=' + (++bootCount), import.meta.url).href;
    await import(href);
    await settle();
    return await body({ byId, studio, warnings, unhandled, el: (id) => byId.get(id) });
  } finally {
    windowListeners.pagehide?.(); // stops the poll timer
    console.warn = realWarn;
    process.off('unhandledRejection', onUnhandled);
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
}

test('initialising the page against a DOM fake wires every control and does not throw', async () => {
  await withPage({}, async ({ el, studio, warnings, unhandled }) => {
    for (const id of ['btnConnect', 'btnTabs', 'btnSend', 'btnSendAgain', 'btnCopy', 'btnReconcile', 'btnCheck', 'btnFinish', 'btnNew'])
      assert.equal(el(id).listeners.click?.length, 1, id + ' has exactly one click handler');
    assert.ok(el('prompt').listeners.input?.length >= 1);
    assert.equal(el('prompt').listeners.keydown, undefined, 'no keyboard shortcut sends');
    // The whole flow ran: sites loaded, the open conversation was fetched and rendered.
    assert.equal(el('site').children.length, 1);
    assert.match(el('stageLine').textContent, /^Step 3 of 5: Write your message$/);
    assert.equal(el('btnSend').disabled, true, 'empty message: Send is off');
    assert.equal(el('uncertain').hidden, true);
    assert.equal(el('btnSendAgain').hidden, true);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(warnings, [], 'nothing optional is missing');
    assert.deepEqual(studio.posts, [], 'booting never posts anything');
  });
});

test('one Send click posts one turn; an unknown outcome shows the banner; Check again posts only /reconcile; nothing re-posts by itself', async () => {
  await withPage({}, async ({ el, studio }) => {
    el('prompt').value = 'hello';
    await el('prompt').dispatch('input');
    assert.equal(el('btnSend').disabled, false);
    await el('btnSend').dispatch('click');
    await settle();
    assert.equal(studio.turnPosts().length, 1, 'exactly one POST /turns for one click');
    assert.equal(studio.turnPosts()[0].body.prompt, 'hello');
    assert.equal(studio.turnPosts()[0].body.confirm, true);
    // Unknown outcome: banner, plain Chrome hint, Check again and a deliberate Send again; composer locked.
    assert.equal(el('uncertain').hidden, false);
    assert.equal(el('uncertainHead').textContent, 'We can’t confirm your message was sent. Studio will not send it again.');
    assert.match(el('chromeGuide').textContent, /Chrome/);
    assert.equal(el('btnSendAgain').hidden, false);
    assert.equal(el('prompt').readOnly, true);
    assert.equal(el('btnSend').disabled, true);
    await settle(); await settle();
    assert.equal(studio.turnPosts().length, 1, 'no automatic re-post while the outcome is unknown');
    // Check again is read-only: it reaches /reconcile and never /turns.
    const before = studio.posts.length;
    await el('btnReconcile').dispatch('click');
    await settle();
    assert.deepEqual(studio.posts.slice(before).map((x) => x.path), ['/conversations/c1/reconcile']);
    assert.equal(studio.turnPosts().length, 1);
    assert.equal(studio.posts.slice(before)[0].body.confirm, undefined);
    assert.equal(studio.posts.slice(before)[0].body.prompt, undefined);
  });
});

test('Send again posts a NEW idempotency key and keeps the same text; the first key is never reused', async () => {
  await withPage({}, async ({ el, studio }) => {
    el('prompt').value = 'hello';
    await el('btnSend').dispatch('click');
    await settle();
    assert.equal(studio.turnPosts().length, 1);
    const first = studio.turnPosts()[0].body.key;
    assert.ok(first && typeof first === 'string');
    await el('btnSendAgain').dispatch('click');
    await settle();
    const turns = studio.turnPosts();
    assert.equal(turns.length, 2, 'one deliberate extra post');
    assert.notEqual(turns[1].body.key, first, 'a new key');
    assert.equal(turns[1].body.prompt, 'hello');
    assert.equal(turns.filter((t) => t.body.key === first).length, 1, 'the first key was posted exactly once');
    assert.equal(el('uncertain').hidden, true, 'the second send was accepted');
  });
});

test('a missing optional note is skipped and logged once; a missing required control fails loudly', async () => {
  await withPage({ omit: ['turnNote'] }, async ({ warnings, unhandled, el }) => {
    assert.match(el('stageLine').textContent, /Step 3 of 5/, 'the page still finished wiring');
    assert.deepEqual(unhandled, []);
    assert.equal(warnings.filter((w) => w.includes('#turnNote')).length, 1, 'logged exactly once');
  });
  await assert.rejects(withPage({ omit: ['btnSendAgain'] }, async () => {}), TypeError, 'a required control throws at boot, which this test catches');
});

test('chat.mjs never renders HTML strings: no innerHTML, insertAdjacentHTML, outerHTML or document.write', () => {
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(source, /textContent/);
});

/* ---------------- Round C: successive turns in one conversation (issue #84) ---------------- */
const settledTurn = (n, extra = {}) => ({ id: 't' + n, key: 'k' + n, phase: 'delivered', sessionId: 's' + n, send: { state: 'observed' },
  reply: { state: 'ready', text: 'answer ' + n }, readiness: { state: 'ready' }, completion: { state: 'unknown' }, ...extra });
const afterTurnOne = (extra = {}) => ready({ revision: 9, turn: settledTurn(1), turns: [settledTurn(1)], capture: { state: 'idle', integrity: null },
  reply: { state: 'ready', text: 'answer 1', source: 'page', completion: 'unknown' }, ...extra });

test('multi-turn gating: a completed turn re-opens the composer; anything unfinished, uncertain or unrecorded does not', () => {
  const done = afterTurnOne();
  assert.equal(ui.turnSettled(done.turn), true);
  assert.equal(ui.canSend(done, { prompt: 'next' }).ok, true, 'turn 1 complete, capture finished, chat box ready');
  assert.equal(ui.composerOpen(done), true);
  assert.match(ui.stageInfo(done).text, /Turn 1 complete\. Write your next message/);
  const block = (extra, why) => { const r = ui.canSend({ ...done, ...extra }, { prompt: 'next' }); assert.equal(r.ok, false, why); return r; };
  // reply still coming / readiness not proven / send unconfirmed
  const streaming = { ...settledTurn(1), reply: { state: 'streaming' }, readiness: { state: 'unknown' } };
  assert.match(block({ turn: streaming, turns: [streaming] }, 'streaming').reason, /one turn at a time/);
  assert.equal(ui.composerOpen({ ...done, turn: streaming, turns: [streaming] }), false);
  const unproven = { ...settledTurn(1), readiness: { state: 'unknown' } };
  block({ turn: unproven, turns: [unproven] }, 'reply ready but readiness unproven');
  const uncertain = { ...settledTurn(1), send: { state: 'uncertain' }, phase: 'uncertain' };
  assert.match(block({ turn: uncertain, turns: [uncertain] }, 'uncertain send').reason, /checked/);
  // an EARLIER uncertain turn keeps the lock even when the latest turn looks fine
  const t2 = settledTurn(2);
  assert.match(block({ turn: t2, turns: [uncertain, t2] }, 'earlier uncertain turn').reason, /checked/);
  assert.equal(ui.hasUncertainTurn({ turns: [uncertain, t2] }), true);
  // capture: previous recording must be finished (idle); running, incomplete, rejected or unreported all block
  for (const state of ['recording', 'incomplete', 'finalizing', 'rejected', 'accepted', undefined]) block({ capture: { state } }, 'capture ' + state);
  block({ capture: undefined }, 'capture unreported');
  // binding changed / unready / unverified / needs checking
  block({ state: 'blocked', readiness: { ready: false, draft: { present: null, chars: null }, reason: 'BINDING_CHANGED' } }, 'binding changed');
  block({ readiness: { ready: false, draft: { present: true, chars: 3 }, reason: 'DRAFT_PRESENT' } }, 'draft');
  block({ identity: { state: 'unverified', reason: 'UNSUPPORTED_PATH' } }, 'identity');
  block({ state: 'needs-reconciliation' }, 'needs checking');
  block({ state: 'closed' }, 'closed');
  // a turn blocked before typing never counts against the next one
  const blocked = { id: 't2', phase: 'blocked', reason: 'THREAD_CHANGED_BETWEEN_TURNS', send: { state: 'not-attempted' } };
  assert.equal(ui.canSend({ ...done, turn: blocked, turns: [settledTurn(1), blocked] }, { prompt: 'next' }).ok, true);
  assert.equal(ui.turnCount({ turns: [settledTurn(1), blocked] }), 1);
});

test('multi-turn: Check again releases a pending unknown only when the service shows no new turn and none is in flight', () => {
  const pending = { convId: 'c1', key: 'k', prompt: 'p', priorTurnId: 't1' };
  assert.equal(ui.checkFoundNoMessage(pending, afterTurnOne()), true, 'the service never registered a turn 2');
  const registered = ready({ turn: settledTurn(2), turns: [settledTurn(1), settledTurn(2)], capture: { state: 'idle' } });
  assert.equal(ui.pendingRegistered(pending, registered), true);
  assert.equal(ui.checkFoundNoMessage(pending, afterTurnOne({ state: 'needs-reconciliation' })), false);
});

test('turn list: every turn keeps its own number, state, session, message and reply (no flattening)', () => {
  const t2 = settledTurn(2, { reply: { state: 'streaming', text: 'partial' }, readiness: { state: 'unknown' } });
  const snap = ready({ turn: t2, turns: [settledTurn(1), t2, { id: 't3', phase: 'blocked', reason: 'BINDING_CHANGED', send: { state: 'not-attempted' } }] });
  const rows = ui.turnRows(snap, { t1: 'first question', t2: 'second question' });
  assert.deepEqual(rows.map((r) => r.n), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.current), [false, true, false], 'the latest started turn is the detailed one');
  assert.equal(rows[0].prompt, 'first question'); assert.equal(rows[0].reply, 'answer 1'); assert.equal(rows[0].sessionId, 's1'); assert.equal(rows[1].sessionId, 's2');
  assert.deepEqual(rows[0].chips.map((c) => c[0]), ['Send observed', 'Reply ready']);
  assert.deepEqual(rows[1].chips.map((c) => c[0]), ['Send observed', 'Reply streaming']);
  assert.equal(rows[2].blocked, true); assert.equal(rows[2].reason, 'BINDING_CHANGED'); assert.deepEqual(rows[2].chips.map((c) => c[0]), ['Not sent yet']);
  assert.deepEqual(ui.turnRows(null), []);
});

test('page: after a complete turn 1 the composer is back, Send posts a NEW key for turn 2 and never touches turn 1', async () => {
  const afterTurn = ready({ revision: 10, turn: settledTurn(2, { reply: { state: 'waiting', text: '' }, readiness: { state: 'unknown' } }),
    turns: [settledTurn(1), settledTurn(2, { reply: { state: 'waiting', text: '' }, readiness: { state: 'unknown' } })], capture: { state: 'recording' },
    reply: { state: 'waiting', text: '', source: 'page', completion: 'unknown' } });
  await withPage({ failFirstTurn: false, initial: afterTurnOne(), afterTurn }, async ({ el, studio, warnings, unhandled }) => {
    assert.equal(el('composer').hidden, false, 'composer is available again after a safe completion');
    assert.equal(el('prompt').disabled, false);
    assert.match(el('stageLine').textContent, /Turn 1 complete/);
    assert.equal(el('turnList').hidden, true, 'one turn: no list yet');
    el('prompt').value = 'follow-up question';
    await el('prompt').dispatch('input');
    assert.equal(el('btnSend').disabled, false);
    assert.match(el('sendHint').textContent, /becomes turn 2 in the same chat/);
    await el('btnSend').dispatch('click');
    await settle();
    const posts = studio.turnPosts();
    assert.equal(posts.length, 1); assert.equal(posts[0].body.prompt, 'follow-up question'); assert.equal(posts[0].body.confirm, true);
    assert.notEqual(posts[0].body.key, 'k1', 'a new idempotency key, never turn 1’s');
    // Turn 2 is now in flight: composer steps aside, list shows both turns, Send is off.
    assert.equal(el('composer').hidden, true);
    assert.equal(el('turnList').hidden, false); assert.equal(el('turnList').children.length, 2);
    assert.equal(el('btnSend').disabled, true);
    assert.equal(el('youHead').textContent, 'Turn 2: You');
    assert.equal(el('youText').textContent, 'follow-up question');
    assert.equal(el('replyHead').textContent, 'Turn 2: Reply from chatgpt');
    assert.deepEqual(unhandled, []); assert.deepEqual(warnings, []);
    assert.deepEqual(studio.otherPosts(), [], 'nothing but the one explicit turn post');
  });
});

test('page: a message typed for the next turn survives a refresh of the already-sent turn', async () => {
  await withPage({ failFirstTurn: false, initial: afterTurnOne() }, async ({ el }) => {
    el('prompt').value = 'draft for turn two';
    await el('prompt').dispatch('input');
    await el('btnReconcile').dispatch('click'); // any refresh path re-renders
    await settle();
    assert.equal(el('prompt').value, 'draft for turn two');
  });
});

test('page: a started turn still being answered keeps the composer closed; the one-message wording is gone', async () => {
  const inFlight = ready({ revision: 5, turn: settledTurn(1, { reply: { state: 'streaming', text: 'par' }, readiness: { state: 'unknown' } }),
    capture: { state: 'recording' }, reply: { state: 'streaming', text: 'par', source: 'page', completion: 'unknown' } });
  await withPage({ failFirstTurn: false, initial: inFlight }, async ({ el }) => {
    assert.equal(el('composer').hidden, true); assert.equal(el('btnSend').disabled, true);
  });
  assert.doesNotMatch(html, /One message per conversation/);
  assert.match(html, /id="turnList"/);
});
