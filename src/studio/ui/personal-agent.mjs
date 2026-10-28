// Studio Personal Agent inspector. No browser/provider operations; user actions are explicit.
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
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || data.message || 'Local Studio request failed');
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
    ? status.nextStage ? 'Bootstrap in progress' : 'Bootstrap complete (local discovery)'
    : 'Not initialized';
  $('scope').textContent = status.initialized
    ? `Local-only identity · state version ${status.version} · remote account unverified`
    : 'Local-only identity; no agent memory has been created';
  $('bootstrap').disabled = false;
  $('saveMemory').disabled = !status.initialized;
  $('workCreate').disabled = !status.initialized;
  const w = status.work;
  $('workSummary').textContent = w ? `Total ${w.total} · Active ${w.byStatus.active} · Blocked ${w.byStatus.blocked} · Completed (user-attested) ${w.byStatus.completed}` : 'Initialize the Personal Agent to use Work.';
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
  catch (e) { message(`Status: ${e.code} — ${e.message}`, true); }
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
    message(result.nextStage ? 'Bootstrap paused: review the first incomplete stage.' : 'Local bootstrap complete. No provider action was executed.');
  } catch (e) { message(`Bootstrap: ${e.code} — ${e.message}`, true); await refresh(); }
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
  } catch (e) { $('discovery').replaceChildren(element('p', `Discovery: ${e.code} — ${e.message}`)); }
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
          await refresh(); await readMemory();
        } catch (e) { message(`Remove: ${e.code} — ${e.message}`, true); remove.disabled = false; }
      });
      note.append(element('strong', entry.key), element('p', entry.text), remove);
      area.append(note);
    }
  } catch (e) { area.replaceChildren(element('p', `Memory: ${e.code} — ${e.message}`)); }
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
    message('Saved in locally versioned Personal Agent memory.');
    await refresh(); await readMemory();
  } catch (e) { message(`Memory: ${e.code} — ${e.message}`, true); await refresh(); }
  finally { $('saveMemory').disabled = !snapshot?.initialized; }
}
$('refresh').addEventListener('click', refresh);
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
async function loadWork() {
  const area = $('workList');
  if (!snapshot?.initialized) { area.replaceChildren(element('p', 'No local agent yet.')); return; }
  try {
    const data = await request('/work');
    area.replaceChildren();
    if (!data.items.length) area.append(element('p', 'No Work items yet.', 'subtle'));
    for (const item of data.items.slice().reverse()) {
      const card = element('article');
      card.style.borderTop = '1px solid var(--border)';
      card.style.padding = '12px 0';
      card.append(element('strong', item.title), element('p', item.objective),
        element('p', `State: ${item.status} · Last updated ${item.updatedAt}`, 'subtle'));
      if (item.nextAction) card.append(element('p', 'Next: ' + item.nextAction, 'subtle'));
      const transitions = workTransitions[item.status] ?? [];
      if (transitions.length) {
        const select = element('select');
        select.setAttribute('aria-label', `Next status for ${item.title}`);
        for (const status of transitions) {
          const option = element('option', status);
          option.value = status;
          select.append(option);
        }
        const note = element('input');
        note.maxLength = 2000;
        note.placeholder = 'Reason (required if blocked)';
        note.setAttribute('aria-label', `Reason for ${item.title}`);
        const evidence = element('input');
        evidence.maxLength = 1200;
        evidence.placeholder = 'Evidence refs separated by commas (required if completed)';
        evidence.setAttribute('aria-label', `Evidence for ${item.title}`);
        const button = element('button', 'Update Work', 'secondary');
        button.type = 'button';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const current = await request('/status');
            const refs = evidence.value.split(',').map(ref => ref.trim()).filter(Boolean);
            await request('/work/' + encodeURIComponent(item.id) + '/transition', {
              method: 'POST', body: JSON.stringify({
                expectedVersion: current.version, to: select.value,
                note: note.value, evidence: refs,
              }),
            });
            message('Work updated in local version history; no external action executed.');
            await refresh(); await loadWork();
          } catch (error) {
            message(`Work: ${error.code} — ${error.message}`, true);
            button.disabled = false;
          }
        });
        const controls = element('div');
        controls.style.display = 'grid';
        controls.style.gap = '8px';
        controls.append(select, note, evidence, button);
        card.append(controls);
      }
      area.append(card);
    }
  } catch (e) { area.replaceChildren(element('p', `Work: ${e.code} — ${e.message}`)); }
}
async function createWork(event) {
  event.preventDefault();
  if (!snapshot?.initialized) return;
  pendingWorkKey ??= crypto.randomUUID();
  $('workCreate').disabled = true;
  try {
    const latest = await request('/status');
    await request('/work', { method: 'POST', body: JSON.stringify({
      expectedVersion: latest.version, title: $('workTitle').value,
      objective: $('workObjective').value, idempotencyKey: pendingWorkKey,
    }) });
    pendingWorkKey = null;
    $('workForm').reset();
    message('Work queued locally. No provider operation was dispatched.');
    await refresh(); await loadWork();
  } catch (e) { message(`Create Work: ${e.code} — ${e.message}`, true); }
  finally { $('workCreate').disabled = !snapshot?.initialized; }
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
  } catch (e) { area.replaceChildren(element('p', `Self-knowledge: ${e.code} — ${e.message}`)); }
}


async function showSitrep() {
  const output = $('sitrepOutput');
  output.textContent = 'Loading private local continuity…';
  try {
    const packet = await request('/sitrep');
    output.textContent = JSON.stringify(packet, null, 2);
    message('Private SITREP loaded. No provider request was made.');
  } catch (e) { output.textContent = `SITREP: ${e.code} — ${e.message}`; }
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
  } catch (e) { message(`Export: ${e.code} — ${e.message}`, true); }
  finally { button.disabled = false; }
}

$('sitrepRefresh').addEventListener('click', showSitrep);
$('exportAgent').addEventListener('click', exportAgent);
$('workForm').addEventListener('submit', createWork);
$('knowledgeRefresh').addEventListener('click', showKnowledge);
$('memoryForm').addEventListener('submit', saveMemory);
void refresh().then(async () => { await readMemory(); await loadWork(); await showKnowledge(); });
