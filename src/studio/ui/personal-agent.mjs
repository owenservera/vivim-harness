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
      note.append(element('strong', entry.key), element('p', entry.text));
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
$('memoryForm').addEventListener('submit', saveMemory);
void refresh().then(readMemory);
