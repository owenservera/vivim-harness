// Studio Personal Agent inspector. No browser/provider operations; user actions are explicit.
// (The saved-reply section only reads already-stored replies; it never sends.)
const API = '/api/v1/personal-agent';
const $ = id => document.getElementById(id);
let snapshot = null;
const stageLabels = {
  'identity-and-sitrep': 'Identity and environment',
  'shared-intelligence': 'Shared intelligence source inventory',
  'personal-memory': 'Three-tier personal memory',
  'skills-and-capabilities': 'Skills and capabilities',
};
async function request(endpoint, options = {}) {
  const response = await fetch(API + endpoint, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' }, ...options,
  }).catch(() => { throw new Error('Studio is unavailable right now. Keep this page open and try Refresh shortly.'); });
  const data = await response.json();
  if (!response.ok) {
    const friendly = response.status === 409
      ? 'Your saved information changed. Refresh, review it, and try again.'
      : response.status === 401 || response.status === 403
        ? 'Open Personal Agent from your paired Studio to continue.'
        : response.status >= 500 ? 'Studio could not complete this. Your draft is still here; try again shortly.'
          : 'This could not be saved. Check the details you entered and try again.';
    const error = new Error(friendly);
    error.code = data.code || String(response.status);
    throw error;
  }
  return data;
}
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (cls) node.className = cls;
  return node;
}
function message(text, error = false) {
  $('notice').textContent = text;
  $('notice').setAttribute('role', error ? 'alert' : 'status');
}
function showStatus(status) {
  snapshot = status;
  $('state').textContent = status.initialized
    ? status.nextStage ? 'Ready for local Work · setup can be continued' : 'Ready · local setup complete'
    : 'Set up your Personal Agent to begin';
  $('scope').textContent = status.initialized
    ? 'Saved on this computer. Nothing is sent to an AI unless you choose to send it.'
    : 'Local-only identity; no agent memory has been created';
  $('bootstrap').disabled = false;
  $('saveMemory').disabled = !status.initialized;
  $('workCreate').disabled = !status.initialized;
  $('replyLoad').disabled = !status.initialized;
  const w = status.work;
  $('workSummary').textContent = w ? `${w.total} saved · ${w.byStatus.queued} to do · ${w.byStatus.active} in progress · ${w.byStatus.blocked} waiting · ${w.byStatus.completed} done` : 'Set up your Personal Agent to use Work.';
  $('bootstrap').textContent = status.initialized ? 'Resume / Verify bootstrap' : 'Initialize and bootstrap';
  $('memoryCounts').replaceChildren();
  for (const [tier, count] of Object.entries(status.memoryCounts ?? {})) {
    $('memoryCounts').append(element('p', `${tier}: ${count} saved entries`));
  }
  const stages = $('stages');
  stages.replaceChildren();
  for (const [key, label] of Object.entries(stageLabels)) {
    const value = status.stages?.[key];
    const item = element('li');
    item.append(element('strong', label), element('span', ` · ${value?.status ?? 'pending'}`, 'chip'));
    if (value?.blocker) item.append(element('p', `Blocked: ${value.blocker}`, 'subtle'));
    if (value?.evidence?.length) item.append(element('p', `${value.evidence.length} local evidence reference(s)`, 'subtle'));
    stages.append(item);
  }
}
async function refresh() {
  try { showStatus(await request('/status')); }
  catch (e) { message(`Could not refresh. ${e.message}`, true); }
}
async function bootstrap() {
  $('bootstrap').disabled = true;
  message('Running local-only discovery…');
  try {
    const before = await request('/status');
    const result = await request('/bootstrap', {
      method: 'POST', body: JSON.stringify({ expectedVersion: before.initialized ? before.version : null }),
    });
    showStatus(result);
    await readMemory(); await loadWork();
    message(result.nextStage ? 'Bootstrap paused: review the first incomplete stage.' : 'Local bootstrap complete. No provider action was executed.');
  } catch (e) { message(`Could not finish setup. ${e.message}`, true); await refresh(); }
}
async function discover() {
  $('discover').disabled = true;
  $('discovery').replaceChildren(element('p', 'Scanning configured local sources…'));
  try {
    const data = await request('/capabilities');
    const area = $('discovery');
    area.replaceChildren(element('p', `${data.skills.items.length} skill files; ${data.tools.length} Studio tools registered; coverage ${data.skills.coverage.complete ? 'complete' : 'partial'}.`));
    area.append(element('p', data.limitations, 'subtle'));
    const details = element('details'), summary = element('summary', 'Inspect discovered skills and registered tools');
    const pre = element('pre', JSON.stringify({
      skills: data.skills.items.map(x => ({ path: x.path, trust: x.trust, availability: x.availability })),
      tools: data.tools,
      coverage: { complete: data.skills.coverage.complete, reasons: data.skills.coverage.reasons },
    }, null, 2));
    details.append(summary, pre);
    area.append(details);
  } catch (e) { $('discovery').replaceChildren(element('p', `Could not load capabilities. ${e.message}`)); }
  finally { $('discover').disabled = false; }
}
async function readMemory() {
  const tier = $('tier').value;
  const area = $('entries');
  try {
    if (!snapshot?.initialized) { area.replaceChildren(element('p', 'Bootstrap the agent first.')); return; }
    const data = await request('/memory/' + encodeURIComponent(tier));
    area.replaceChildren();
    if (!data.entries.length) area.append(element('p', 'No entries in this tier yet.'));
    for (const entry of data.entries) {
      const note = element('article');
      const remove = element('button', 'Remove entry', 'secondary');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Remove "${entry.key}" from current ${tier} memory? Previous local versions remain in the history.`)) return;
        remove.disabled = true;
        try {
          const current = await request('/status');
          await request('/memory/' + encodeURIComponent(tier) + '/' + encodeURIComponent(entry.key) + '/remove', {
            method: 'POST', body: JSON.stringify({ expectedVersion: current.version }),
          });
          message('Entry removed from current local memory.');
          $('memorySearchResults').replaceChildren(element('p', 'Memory changed. Search again to see current results.'));
          await refresh(); await readMemory();
        } catch (e) { message(`Could not remove the note. ${e.message}`, true); remove.disabled = false; }
      });
      note.append(element('strong', entry.key), element('p', entry.text), remove);
      area.append(note);
    }
  } catch (e) { area.replaceChildren(element('p', `Could not load notes. ${e.message}`)); }
}
async function saveMemory(event) {
  event.preventDefault();
  if (!snapshot?.initialized) return;
  const tier = $('tier').value, key = $('memoryKey').value.trim(), text = $('memoryText').value.trim();
  $('saveMemory').disabled = true;
  try {
    const current = await request('/status');
    await request('/memory/' + encodeURIComponent(tier) + '/' + encodeURIComponent(key), {
      method: 'PUT', body: JSON.stringify({ text, expectedVersion: current.version }),
    });
    $('memoryText').value = '';
    $('memorySearchResults').replaceChildren(element('p', 'Memory changed. Search again to see current results.'));
    message('Saved in locally versioned Personal Agent memory.');
    await refresh(); await readMemory();
  } catch (e) { message(`Could not save your note. ${e.message}`, true); await refresh(); }
  finally { $('saveMemory').disabled = !snapshot?.initialized; }
}
$('refresh').addEventListener('click', async () => { await refresh(); await loadWork(); await restoreReplyPreview(); });
$('bootstrap').addEventListener('click', bootstrap);
$('discover').addEventListener('click', discover);
$('tier').addEventListener('change', readMemory);

/* Local Work is a durable planning record; no tool/provider dispatch is performed here. */
const workTransitions = {
  queued: ['active', 'blocked', 'cancelled'],
  active: ['blocked', 'completed', 'cancelled'],
  blocked: ['active', 'cancelled'],
  completed: [], cancelled: [],
};
let pendingWorkKey = null;
let pendingWorkSignature = null;
const workStatusLabels = { queued: 'To do', active: 'In progress', blocked: 'Waiting for you', completed: 'Done', cancelled: 'Cancelled' };
const workActionDrafts = new Map();
// Tab-local continuity stores retry identity, never approval or an instruction to apply.
function readContinuity(key, fallback = null) {
  try { return JSON.parse(sessionStorage.getItem('vivim-agent-' + key)) ?? fallback; }
  catch { return fallback; }
}
function writeContinuity(key, value) {
  try {
    if (value === null) sessionStorage.removeItem('vivim-agent-' + key);
    else sessionStorage.setItem('vivim-agent-' + key, JSON.stringify(value));
  } catch { /* Storage may be unavailable; in-page retry identity is still retained. */ }
}
const savedUpdates = readContinuity('work-updates', {});
const workUpdates = new Map(Object.entries(savedUpdates && typeof savedUpdates === 'object' ? savedUpdates : {}));
const workBusy = new Set();
let workLoadToken = 0;
function rememberUpdate(id, update) {
  if (update) workUpdates.set(id, update);
  else workUpdates.delete(id);
  writeContinuity('work-updates', Object.fromEntries(workUpdates));
}
async function loadWork() {
  const area = $('workList');
  const token = ++workLoadToken;
  if (!snapshot?.initialized) { area.replaceChildren(element('p', 'No local agent yet.')); return; }
  try {
    const data = await request('/work');
    if (token !== workLoadToken) return;
    area.replaceChildren();
    const filter = $('workFilter').value;
    const visible = data.items.filter(item => filter === 'all' ||
      (filter === 'open' ? ['queued', 'active', 'blocked'].includes(item.status)
        : item.status === filter));
    $('workCoverage').textContent = 'Showing ' + visible.length + ' of ' + data.items.length +
      ' saved Work items. Your progress stays here when you close Studio.';
    if (!visible.length) area.append(element('p', data.items.length
      ? 'No Work matches this status filter.' : 'No Work items yet.', 'subtle'));
    for (const item of visible.slice().reverse()) {
      const pending = workUpdates.get(item.id);
      if (pending && item.events?.some(event => event.idempotencyKey === pending.key)) {
        rememberUpdate(item.id, null); // A lost response must not turn into another update.
      }
      const card = element('article');
      card.style.borderTop = '1px solid var(--border)';
      card.style.padding = '12px 0';
      card.append(element('strong', item.title), element('p', item.objective),
        element('p', `${workStatusLabels[item.status] ?? item.status} · Updated ${new Date(item.updatedAt).toLocaleString()}`, 'subtle'));
      if (item.nextAction) card.append(element('p', 'Next: ' + item.nextAction, 'subtle'));
      else if (item.status === 'active') card.append(element('p', 'Ready to continue. Add your next step below; nothing runs automatically.', 'subtle'));
      const history = element('details');
      history.append(element('summary', 'Details and progress'));
      history.append(element('p', `Saved ${new Date(item.createdAt).toLocaleString()} · ${item.source === 'user-authored' ? 'Created by you' : 'AI suggestion'}`));
      for (const event of item.events ?? []) {
        const description = event.type === 'created' ? 'Added to Work'
          : event.type === 'transition' ? `${workStatusLabels[event.from]} → ${workStatusLabels[event.to]}`
            : event.nextAction ? 'Next step: ' + event.nextAction : 'Next step cleared';
        history.append(element('p', `${new Date(event.at).toLocaleString()} · ${description}${event.note ? ': ' + event.note : ''}`));
        if (event.evidence?.length) history.append(element('p', 'Completion references: ' + event.evidence.map(entry => entry.ref).join(', '), 'subtle'));
      }
      card.append(history);
      const context = element('button', 'Find saved context', 'secondary');
      context.type = 'button';
      context.addEventListener('click', () => {
        $('memorySearchQuery').value = item.title.slice(0, 120);
        $('memorySearchQuery').focus();
        $('memorySearchForm').requestSubmit();
      });
      card.append(context);
      if (['queued', 'active', 'blocked'].includes(item.status)) {
        const next = element('textarea');
        next.maxLength = 1000;
        next.rows = 2;
        next.value = workActionDrafts.has(item.id) ? workActionDrafts.get(item.id) : (item.nextAction ?? '');
        next.setAttribute('aria-label', 'Next action for ' + item.title);
        next.placeholder = 'User-authored next local action; not automatic execution';
        next.addEventListener('input', () => { workActionDrafts.set(item.id, next.value); });
        const save = element('button', 'Save next action', 'secondary');
        save.type = 'button';
        save.addEventListener('click', async () => {
          if (workBusy.has(item.id)) return;
          const planned = next.value.trim();
          if (!planned && item.status === 'blocked') {
            message('Add the next step or explain what you are waiting for before saving.', true); return;
          }
          workBusy.add(item.id);
          save.disabled = true;
          try {
            const status = await request('/status');
            await request('/work/' + encodeURIComponent(item.id) + '/next-action', {
              method: 'POST', body: JSON.stringify({ expectedVersion: status.version, nextAction: planned || null }),
            });
            workActionDrafts.delete(item.id);
            message('Next action saved in local Work history. Nothing was executed.');
            await refresh(); await loadWork();
          } catch (error) {
            message('Could not save your next step. ' + error.message, true);
            save.disabled = false; // keep the user's unsaved draft
          } finally { workBusy.delete(item.id); }
        });
        const plan = element('div');
        plan.style.display = 'grid'; plan.style.gap = '8px';
        plan.append(next, save);
        card.append(plan);
      }
      const transitions = workTransitions[item.status] ?? [];
      if (transitions.length) {
        const select = element('select');
        select.setAttribute('aria-label', `Next status for ${item.title}`);
        for (const status of transitions) {
          const option = element('option', workStatusLabels[status]);
          option.value = status;
          select.append(option);
        }
        const note = element('input');
        note.maxLength = 2000;
        note.placeholder = 'What changed? (required when waiting)';
        note.setAttribute('aria-label', `Reason for ${item.title}`);
        const evidence = element('input');
        evidence.maxLength = 1200;
        evidence.placeholder = 'Completion references, separated by commas (required for Done)';
        evidence.setAttribute('aria-label', `Evidence for ${item.title}`);
        const button = element('button', item.status === 'blocked' ? 'Resume Work' : 'Update Work', 'secondary');
        button.type = 'button';
        const savedUpdate = workUpdates.get(item.id);
        if (savedUpdate?.payload && transitions.includes(savedUpdate.payload.to)) {
          select.value = savedUpdate.payload.to;
          note.value = savedUpdate.payload.note ?? '';
          evidence.value = (savedUpdate.payload.evidence ?? []).join(', ');
        }
        const updateLabel = () => { button.textContent = item.status === 'blocked' && select.value === 'active' ? 'Resume Work' : 'Update Work'; };
        select.addEventListener('change', updateLabel);
        updateLabel();
        button.addEventListener('click', async () => {
          if (workBusy.has(item.id)) return;
          if (workActionDrafts.has(item.id) && workActionDrafts.get(item.id).trim() !== (item.nextAction ?? '')) {
            message('Save your edited next action first, then update the task status. Nothing has changed yet.', true);
            return;
          }
          const refs = evidence.value.split(',').map(ref => ref.trim()).filter(Boolean);
          const payload = { to: select.value, note: note.value.trim(), evidence: refs };
          if (payload.to === 'blocked' && !payload.note) {
            message('Explain what you are waiting for so you can pick this task up later.', true); return;
          }
          if (payload.to === 'completed' && !refs.length) {
            message('Add a completion reference before marking this task Done.', true); return;
          }
          workBusy.add(item.id);
          button.disabled = true;
          try {
            const current = await request('/status');
            const signature = JSON.stringify(payload);
            let pendingUpdate = workUpdates.get(item.id);
            if (pendingUpdate?.signature !== signature) pendingUpdate = { signature, payload, key: crypto.randomUUID() };
            rememberUpdate(item.id, pendingUpdate);
            await request('/work/' + encodeURIComponent(item.id) + '/transition', {
              method: 'POST', body: JSON.stringify({
                expectedVersion: current.version, ...payload, idempotencyKey: pendingUpdate.key,
              }),
            });
            rememberUpdate(item.id, null);
            message(payload.to === 'active' ? 'Work is ready to continue. Your saved next step is still here; nothing started automatically.' : 'Progress saved in Work history. Nothing started automatically.');
            await refresh(); await loadWork();
          } catch (error) {
            message(`Could not update Work. ${error.message}`, true);
            button.disabled = false;
          } finally { workBusy.delete(item.id); }
        });
        const controls = element('div');
        controls.style.display = 'grid';
        controls.style.gap = '8px';
        controls.append(select, note, evidence, button);
        card.append(controls);
      }
      area.append(card);
    }
  } catch (e) { if (token === workLoadToken) area.replaceChildren(element('p', `Could not load Work. ${e.message}`)); }
}
async function createWork(event) {
  event.preventDefault();
  if (!snapshot?.initialized) return;
  const signature = JSON.stringify({ title: $('workTitle').value, objective: $('workObjective').value });
  if (!pendingWorkKey || signature !== pendingWorkSignature) {
    pendingWorkKey = crypto.randomUUID();
    pendingWorkSignature = signature;
  }
  $('workCreate').disabled = true;
  try {
    const latest = await request('/status');
    await request('/work', { method: 'POST', body: JSON.stringify({
      expectedVersion: latest.version, title: $('workTitle').value,
      objective: $('workObjective').value, idempotencyKey: pendingWorkKey,
    }) });
    pendingWorkKey = null;
    pendingWorkSignature = null;
    $('workForm').reset();
    message('Saved to your Work list. Nothing was sent or started automatically.');
    await refresh(); await loadWork();
  } catch (e) { message(`Could not add Work. ${e.message}`, true); }
  finally { $('workCreate').disabled = !snapshot?.initialized; }
}
/* Opt-in: propose Work from an ALREADY-STORED settled reply. Read-only list (never a send); the
   item is AI-proposed/unverified and is saved only by the explicit Save click below. */
const CONVERSATIONS_API = '/api/v1/conversations';
let replyPreviewToken = 0;
let replyApplying = false;
async function restoreReplyPreview() {
  const choice = readContinuity('reply-choice');
  if (snapshot?.initialized && typeof choice?.conversation === 'string' && typeof choice?.turnId === 'string') {
    await previewReply({ ...choice, site: typeof choice.site === 'string' ? choice.site : 'AI' });
  }
}
async function loadReplyChoices() {
  const area = $('replyChoices'), button = $('replyLoad');
  button.disabled = true;
  ++replyPreviewToken;
  $('replyPreview').replaceChildren();
  area.replaceChildren(element('p', 'Reading saved replies…'));
  try {
    const response = await fetch(CONVERSATIONS_API, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (response.status !== 200 || !Array.isArray(data?.conversations)) {
      throw Object.assign(new Error('Stored conversations are unavailable'), { code: data?.code || String(response.status) });
    }
    const items = [];
    for (const conversation of data.conversations) {
      for (const turn of Array.isArray(conversation?.turns) ? conversation.turns : []) {
        if (turn?.reply?.state === 'ready' && typeof conversation.id === 'string' && typeof turn.id === 'string') {
          items.push({ conversation: conversation.id, turnId: turn.id,
            site: typeof conversation.site === 'string' ? conversation.site : 'provider',
            chars: Number.isSafeInteger(turn.reply.chars) ? turn.reply.chars : null });
        }
      }
    }
    area.replaceChildren();
    if (!items.length) area.append(element('p', 'No finished replies are saved yet.', 'subtle'));
    for (const choice of items.slice(0, 12)) {
      const row = element('div');
      const pick = element('button', `Review ${choice.site} reply · ${choice.conversation} / ${choice.turnId}${choice.chars === null ? '' : ' (' + choice.chars + ' characters)'}`, 'secondary');
      pick.type = 'button';
      pick.setAttribute('aria-label', `Preview Work from ${choice.site} reply ${choice.turnId}`);
      pick.addEventListener('click', () => previewReply(choice));
      row.append(pick);
      area.append(row);
    }
  } catch (e) { area.replaceChildren(element('p', `Could not load saved replies. ${e.message}`)); }
  finally { button.disabled = !snapshot?.initialized; }
}
async function previewReply(choice) {
  const area = $('replyPreview'), token = ++replyPreviewToken;
  area.replaceChildren(element('p', 'Checking the saved reply (read-only)…'));
  try {
    const data = await request('/work/preview-provider-reply', {
      method: 'POST', body: JSON.stringify({ conversation: choice.conversation, turnId: choice.turnId }),
    });
    if (token !== replyPreviewToken) return;
    const from = data.provenance;
    if (data.source !== 'provider-reply' || from?.source !== 'provider-reply' || from.humanAuthored !== false ||
        from.providerCalled !== false || from.conversationId !== choice.conversation || from.turnId !== choice.turnId ||
        data.effects !== 'none' || data.approvalRequired !== true) {
      area.replaceChildren(element('p', 'The preview did not carry the expected provenance. Nothing was saved.')); return;
    }
    writeContinuity('reply-choice', { conversation: choice.conversation, turnId: choice.turnId, site: choice.site });
    const card = element('article');
    card.style.borderTop = '1px solid var(--border)';
    card.style.padding = '12px 0';
    card.append(element('span', 'AI-proposed · unverified · not human-authored', 'chip'),
      element('strong', data.proposal.title), element('pre', data.proposal.objective),
      element('p', `Source: stored ${choice.site} reply · digest ${from.replyDigest.slice(0, 16)} · tags ${data.proposal.tags.join(', ')}`, 'subtle'),
      element('p', data.note, 'subtle'));
    if (data.alreadySaved) card.append(element('p', `Already saved in Work · ${workStatusLabels[data.alreadySaved.status] ?? data.alreadySaved.status}. No duplicate will be added.`, 'subtle'));
    const save = element('button', data.alreadySaved ? 'Already saved in Work' : 'Save as Work item (I approve)');
    save.type = 'button';
    save.disabled = data.canApply !== true || Boolean(data.alreadySaved);
    save.addEventListener('click', async () => {
      if (replyApplying || token !== replyPreviewToken || data.alreadySaved || data.canApply !== true) return;
      if (!window.confirm('Save this AI-proposed, unverified text as a local queued Work item? Nothing will be sent or executed.')) return;
      replyApplying = true;
      save.disabled = true;
      try {
        const latest = await request('/status');
        await request('/work/apply-provider-reply', { method: 'POST', body: JSON.stringify({
          conversation: choice.conversation, turnId: choice.turnId, replyDigest: from.replyDigest,
          expectedVersion: latest.version, approval: 'user-confirmed',
        }) });
        if (token === replyPreviewToken) area.replaceChildren(element('p', 'Saved in Work. This reply will not be added twice.'));
        message('AI-proposed Work saved locally (unverified). No provider request was made and nothing was executed.');
        await refresh(); await loadWork();
      } catch (e) {
        message(`Could not save this suggestion. ${e.message}`, true);
        save.disabled = false;
      } finally {
        replyApplying = false;
        // Re-read saved state even after a lost response; never repeat the apply automatically.
        if (token === replyPreviewToken) await previewReply(choice);
      }
    });
    card.append(save);
    area.replaceChildren(card);
   } catch (e) { if (token === replyPreviewToken) area.replaceChildren(element('p', `Could not review this reply. ${e.message}`)); }
}
async function showKnowledge() {
  const area = $('selfKnowledge');
  area.replaceChildren(element('p', 'Reading grounded local projections…'));
  try {
    const data = await request('/self-knowledge?topic=' + encodeURIComponent($('knowledgeTopic').value));
    area.replaceChildren();
    for (const result of Object.values(data.answers)) {
      const card = element('article');
      card.style.borderTop = '1px solid var(--border)';
      card.style.padding = '12px 0';
      card.append(element('strong', result.topic),
        element('pre', JSON.stringify(result.value, null, 2)),
        element('p', `Basis: ${result.basis} · Observed: ${result.observedAt}`, 'subtle'),
        element('p', result.qualification, 'subtle'));
      area.append(card);
    }
  } catch (e) { area.replaceChildren(element('p', `Could not load agent details. ${e.message}`)); }
}


async function showSitrep() {
  const output = $('sitrepOutput');
  output.textContent = 'Loading private local continuity…';
  try {
    const packet = await request('/sitrep');
    output.textContent = JSON.stringify(packet, null, 2);
      message('Your saved progress is ready. Nothing was sent to an AI.');
  } catch (e) { output.textContent = `Could not load saved progress. ${e.message}`; }
}
async function exportAgent() {
  const button = $('exportAgent');
  button.disabled = true;
  try {
    const query = new URLSearchParams({
      includeMemory: String($('exportMemory').checked),
      includeWorkDetails: String($('exportWork').checked),
    });
    const bundle = await request('/export?' + query);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const uri = URL.createObjectURL(blob);
    try {
      const link = element('a');
      link.href = uri;
      link.download = 'vivim-personal-agent-' + new Date().toISOString().slice(0, 10) + '.json';
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    } finally { URL.revokeObjectURL(uri); }
    message('Local snapshot exported. Keep the JSON private: it is not encrypted.');
  } catch (e) { message(`Could not export your data. ${e.message}`, true); }
  finally { button.disabled = false; }
}

$('sitrepRefresh').addEventListener('click', showSitrep);
$('exportAgent').addEventListener('click', exportAgent);
$('workForm').addEventListener('submit', createWork);
$('workFilter').addEventListener('change', loadWork);
$('replyLoad').addEventListener('click', loadReplyChoices);
$('knowledgeRefresh').addEventListener('click', showKnowledge);
async function searchPrivateMemory(event) {
  event.preventDefault();
  const area = $('memorySearchResults'), button = $('memorySearchButton');
  const query = $('memorySearchQuery').value.trim(), tier = $('memorySearchTier').value || 'all';
  if (query.length < 2) {
    area.replaceChildren(element('p', 'Enter at least two characters.'));
    return;
  }
  button.disabled = true;
  area.replaceChildren(element('p', 'Searching user-authored local memory…'));
  try {
    const data = await request('/search-memory', {
      method: 'POST',
      body: JSON.stringify({ query, tier, limit: 20 }),
    });
    area.replaceChildren(element('p', 'Showing ' + data.shown + ' of ' + data.total +
      ' local matches' + (data.truncated ? ' (more exist)' : '') + '.'));
    if (!data.items.length) area.append(element('p', 'No matching local memory entries.'));
    for (const hit of data.items) {
      const card = element('article');
      card.append(element('strong', hit.tier + ' / ' + hit.key),
        element('p', hit.preview), element('p', 'Local source: ' + hit.source + ' · matched ' + hit.match, 'subtle'));
      area.append(card);
    }
  } catch (error) {
    area.replaceChildren(element('p', 'Could not search saved notes. ' + error.message));
  } finally { button.disabled = false; }
}

$('memoryForm').addEventListener('submit', saveMemory);
$('memorySearchForm').addEventListener('submit', searchPrivateMemory);
void refresh().then(async () => { await readMemory(); await loadWork(); await restoreReplyPreview(); await showKnowledge(); });
