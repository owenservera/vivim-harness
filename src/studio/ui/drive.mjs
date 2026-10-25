// Live drive page. Same-origin fetches only; the studio cookie authenticates every request.
// Everything that came from a site (reasons, ids, urls) is rendered with textContent and DOM nodes, never as HTML.

const API = '/api/v1/drive';
const POLL_MS = 1500;
const ACTIVE = new Set(['queued', 'running']);

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, props = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of [].concat(kids)) if (kid != null) node.append(kid);
  return node;
}

const S = {
  sites: [], defaultPrompt: '', mode: 'drive', selected: new Set(), rows: new Map(),
  job: null, jobs: [], pollTimer: null, pollSeq: 0, jobRequestSeq: 0, failures: 0, busy: false, progressSig: '', stopRequested: null,
};

/* ---------------- api ---------------- */
let authExpired = false;
function setAuthNote(on) {
  authExpired = on;
  $('#connectionNote').textContent = on ? 'Studio request rejected. Local mode needs no token; if token mode is enabled, reopen the startup URL.' : '';
}
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method, credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('Could not reach the Studio. Check that it is still running.');
    err.status = 0; throw err;
  }
  let data = {};
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { error: 'The Studio sent a reply that was not JSON.' }; } }
  if (res.status === 401 || res.status === 403) setAuthNote(true);
  else if (res.ok && authExpired) setAuthNote(false);
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || 'Request failed');
    err.status = res.status; err.data = data; throw err;
  }
  return data;
}
function describe(e) {
  if (e.status === 401 || e.status === 403) return 'Local Studio refused this request. Check its address and Origin settings; if token mode is enabled, reopen the startup URL.';
  if (e.status === 404) return 'Not found. This Studio build may not include Live drive, or the item no longer exists.';
  return e.message;
}

/* ---------------- labels ---------------- */
// The API values (verified, unverified, ...) are unchanged. "verified" here only ever meant the reply
// matched the expected words; this page never evaluates whether the saved capture was accepted.
const VERDICTS = {
  verified: { label: 'Reply matched', cls: 'v-verified' },
  unverified: { label: 'Reply not confirmed', cls: 'v-unverified' },
  failed: { label: 'Failed', cls: 'v-failed' },
  blocked: { label: 'Blocked', cls: 'v-blocked' },
  'not-run': { label: 'Not run', cls: 'v-notrun' },
};
const JOB_STATES = {
  queued: 'Waiting to start', running: 'Running', done: 'Finished', failed: 'Job failed', cancelled: 'Stopped',
};
function chip(cls, label) {
  return el('span', { class: 'pill ' + cls }, [label]);
}
function verdictChip(v) {
  const m = VERDICTS[v] ?? { label: v ? String(v) : 'Not run', cls: 'v-notrun' };
  return chip(m.cls, m.label);
}

/* ---------------- time ---------------- */
function toMs(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : Date.parse(v));
  return Number.isFinite(n) ? n : null;
}
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + ' s ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
}
function timeNode(v, { absolute = false } = {}) {
  const ms = toMs(v);
  if (ms == null) return document.createTextNode('time not recorded');
  const d = new Date(ms);
  return el('time', { datetime: d.toISOString(), title: d.toLocaleString(), 'data-ms': absolute ? null : ms, text: absolute ? d.toLocaleTimeString() : ago(ms) });
}
setInterval(() => document.querySelectorAll('time[data-ms]').forEach((t) => { t.textContent = ago(Number(t.dataset.ms)); }), 30000);

/* ---------------- links ---------------- */
// index.html has no per-session URL; it opens sessions in-app. "#session=<id>" is read by its startup code.
function sessionLinks(id) {
  if (!id) return null;
  return el('span', {}, [
    el('a', { href: '/#session=' + encodeURIComponent(id), target: '_blank', rel: 'noopener', text: 'Open session' }),
    el('span', { class: 'sr', text: ' (new tab)' }),
    ' · ',
    el('a', { href: '/#session=' + encodeURIComponent(id) + '&view=knowledge', target: '_blank', rel: 'noopener', text: 'Explore derived knowledge (may be incomplete)' }),
    ' · ',
    el('a', { href: '/api/sessions/' + encodeURIComponent(id) + '/transcript', text: 'Transcript' }),
  ]);
}

/* ---------------- sites ---------------- */
function siteStatusNodes(site) {
  const last = site.last;
  if (!last) return [verdictChip('not-run'), el('span', { text: 'Never run from this page.' })];
  const nodes = [verdictChip(last.status)];
  if (last.reason) nodes.push(el('span', { class: 'reason', text: last.reason }));
  const when = toMs(last.at);
  if (when != null) nodes.push(el('span', {}, ['· ', timeNode(last.at)]));
  const links = sessionLinks(last.sessionId);
  if (links) nodes.push(links);
  return nodes;
}
function renderSites() {
  const list = $('#siteList');
  const same = S.rows.size === S.sites.length && S.sites.every((s) => S.rows.has(s.id));
  if (same) {
    for (const s of S.sites) S.rows.get(s.id).status.replaceChildren(...siteStatusNodes(s));
    return;
  }
  S.rows.clear(); list.replaceChildren();
  S.sites.forEach((s, i) => {
    const inputId = 'site-' + i, statusId = 'site-status-' + i;
    const input = el('input', { type: 'checkbox', id: inputId, 'aria-describedby': statusId, onchange: () => onSiteToggle(s.id, input.checked) });
    const status = el('div', { class: 'site-status', id: statusId });
    status.replaceChildren(...siteStatusNodes(s));
    const label = el('label', { for: inputId }, [
      input,
      el('span', { class: 'sname', text: s.id + (s.adapter && s.adapter !== s.id ? ' · ' + s.adapter : '') }),
      s.url ? el('span', { class: 'surl', text: s.url }) : null,
    ]);
    list.append(el('li', { class: 'site' }, [label, status]));
    S.rows.set(s.id, { input, status });
  });
  syncChecks();
}
function syncChecks() {
  for (const [id, row] of S.rows) row.input.checked = S.selected.has(id);
  const n = S.selected.size;
  $('#selCount').textContent = n + (n === 1 ? ' site selected' : ' sites selected');
}
async function loadSites() {
  const state = $('#siteState');
  if (!S.sites.length) { state.className = 'empty'; state.replaceChildren('Loading sites…'); state.hidden = false; }
  try {
    const data = await api('/sites');
    S.sites = Array.isArray(data.sites) ? data.sites : [];
    if (typeof data.defaultPrompt === 'string' && data.defaultPrompt) {
      S.defaultPrompt = data.defaultPrompt;
      $('#prompt').placeholder = data.defaultPrompt;
      $('#promptHelp').textContent = 'Leave empty to send the fixed 12-word calibration sentence shown as the placeholder. A prompt you type is sent as-is to every selected site.';
    }
    S.selected = new Set([...S.selected].filter((id) => S.sites.some((s) => s.id === id)));
    if (!S.sites.length) {
      state.className = 'empty'; state.replaceChildren('The Studio returned no sites.'); state.hidden = false;
      $('#siteList').hidden = true; $('#siteTools').hidden = true;
    } else {
      state.hidden = true; $('#siteList').hidden = false; $('#siteTools').hidden = S.mode !== 'campaign';
      renderSites();
    }
  } catch (e) {
    state.className = 'err pad';
    state.replaceChildren('Could not load sites: ' + describe(e) + ' ', el('button', { type: 'button', text: 'Retry', onclick: loadSites }));
    state.hidden = false;
  }
  updateControls();
}

/* ---------------- selection and mode ---------------- */
function setMode(mode) {
  S.mode = mode;
  if (mode === 'drive') {
    if (S.selected.size > 1) S.selected = new Set([[...S.selected][0]]);
  } else $('#driveUrl').value = '';
  $('#urlField').hidden = mode !== 'drive';
  $('#siteTools').hidden = mode !== 'campaign' || !S.sites.length;
  $('#urlError').textContent = '';
  syncChecks(); touched();
}
function onSiteToggle(id, checked) {
  if (S.mode === 'drive') {
    S.selected = checked ? new Set([id]) : new Set();
    if (checked) { $('#driveUrl').value = ''; $('#urlError').textContent = ''; }
  } else if (checked) S.selected.add(id); else S.selected.delete(id);
  syncChecks(); touched();
}
// Editing the target/prompt keeps the visible execution action straightforward.
function touched() { $('#formError').textContent = ''; updateControls(); }

function currentTargets() {
  if (S.mode === 'drive') {
    const url = $('#driveUrl').value.trim();
    if (url) {
      let ok = false;
      try { ok = new URL(url).protocol === 'https:'; } catch { /* invalid */ }
      return ok ? { sites: [url] } : { sites: [], error: 'Enter a full address starting with https://' };
    }
  }
  return { sites: S.sites.filter((s) => S.selected.has(s.id)).map((s) => s.id) };
}
function activeJobId() {
  if (S.job && ACTIVE.has(S.job.state)) return S.job.id;
  return S.jobs.find((j) => ACTIVE.has(j.state))?.id ?? null;
}
function updateControls() {
  const t = currentTargets(), active = activeJobId();
  $('#urlError').textContent = t.error ?? '';
  const ready = t.sites.length > 0 && !t.error && !S.busy && !active;
  $('#btnDry').disabled = !ready;
  $('#btnLive').disabled = !ready;
  let hint;
  if (active) hint = 'A job is already active, and only one can run at a time. Wait for it to finish, or stop it after the current site.';
  else if (S.busy) hint = 'Starting…';
  else if (t.error) hint = t.error;
  else if (!t.sites.length) hint = S.mode === 'drive' ? 'Choose a site or enter an https address to continue.' : 'Tick at least one site to continue.';
  else hint = 'Click Send to selected sites to send ' + t.sites.length + (t.sites.length === 1 ? ' prompt' : ' prompts, one per site') + ' to: ' + t.sites.join(', ') + '. Dry run is optional.';
  $('#runHint').textContent = hint;
}

/* ---------------- starting a job ---------------- */
// undefined = the field was left empty (omit it); null = the field holds an invalid value.
function numberField(id, min = 0) {
  const raw = $(id).value.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min ? n : null;
}
async function launch(dryRun) {
  const t = currentTargets();
  if (!t.sites.length || t.error || S.busy || activeJobId()) { updateControls(); return; }
  const body = { mode: S.mode, sites: t.sites, dryRun };
  if (!dryRun) body.confirm = true;
  const prompt = $('#prompt').value.trim();
  if (prompt) body.prompt = prompt;
  const timeout = numberField('#timeout', 1), cooldown = numberField('#cooldown', 0);
  if (timeout === null || cooldown === null) {
    $('#formError').textContent = timeout === null
      ? 'The timeout must be a whole number of at least 1 millisecond.'
      : 'The cooldown must be a whole number of 0 milliseconds or more.';
    return;
  }
  if (timeout !== undefined) body.timeout = timeout;
  if (cooldown !== undefined) body.cooldown = cooldown;
  S.busy = true; $('#formError').textContent = '';
  $('#formStatus').textContent = dryRun ? 'Starting dry run…' : 'Starting live run…';
  updateControls();
  try {
    const { job } = await api('/jobs', { method: 'POST', body });
    $('#formStatus').textContent = (dryRun ? 'Dry run' : 'Live run') + ' queued. Progress is on the right.';
    S.jobs = [job, ...S.jobs.filter((j) => j.id !== job.id)];
    showJob(job);
  } catch (e) {
    $('#formStatus').textContent = '';
    if (e.status === 409) {
      const id = e.data?.activeJobId;
      const holder = e.data?.holder;
      const error = $('#formError');
      if (holder?.kind === 'conversation') {
        error.replaceChildren('A Chat conversation holds the browser. No Drive job was started. Inspect or finish the conversation before trying again. ',
          el('a', { href: '/chat', text: 'Open Chat' }));
      } else if (id) {
        error.textContent = 'Another Drive job holds the browser. Nothing was started. Showing that job to inspect its state.';
        await openJob(id);
      } else {
        error.textContent = 'The browser is busy or its owner could not be confirmed. No Drive job was started. Check Chat and active Drive jobs before retrying.';
      }
      // Never automatically queue the rejected live request after a lease conflict.
    } else if (e.status === 400) {
      $('#formError').textContent = 'The Studio rejected this request: ' + e.message;
    } else $('#formError').textContent = 'Could not start the job: ' + describe(e);
  } finally {
    S.busy = false; updateControls();
  }
}

/* ---------------- job panel ---------------- */
function counts(progress) {
  const c = { verified: 0, unverified: 0, failed: 0, blocked: 0, skipped: 0, other: 0 };
  for (const p of progress) {
    if (p.state === 'skipped') c.skipped++;
    else if (p.verdict in c) c[p.verdict]++;
    else if (p.state === 'failed') c.failed++;
    else if (p.state === 'done') c.other++;
  }
  return c;
}
function summaryText(job) {
  const progress = job.progress ?? [], total = progress.length || job.sites?.length || 0;
  const finished = progress.filter((p) => p.state === 'done' || p.state === 'failed' || p.state === 'skipped').length;
  const c = counts(progress);
  const tally = c.verified + ' reply matched · ' + c.unverified + ' reply not confirmed · ' + c.failed + ' failed · ' + c.blocked + ' blocked' + (c.skipped ? ' · ' + c.skipped + ' skipped' : '');
  switch (job.state) {
    case 'queued': return 'Waiting to start.';
    case 'running': {
      const now = progress.find((p) => p.state === 'running');
      return (S.stopRequested === job.id ? 'Stop requested. The current site may finish, and no next site will start. ' : '')
        + 'Running' + (now ? ': ' + now.site + ' (' + Math.min(finished + 1, total) + ' of ' + total + ')' : '.') + (job.dryRun ? ' Dry run, so nothing is sent.' : '');
    }
    case 'done':
      return job.dryRun ? 'Dry run finished. Nothing was sent to any site.'
        : 'The job ended. ' + tally + ' (of ' + total + '). Capture acceptance not checked.';
    case 'failed': return 'The job itself failed' + (job.error ? '.' : ', with no reason given.') + (finished ? ' ' + tally + '.' : '') + (finished && !job.dryRun ? ' Capture acceptance not checked.' : '');
    case 'cancelled': return 'Stopped before finishing. The site that was running may have finished, and no next site was started. This did not stop generation on the website. The rows below show what had run.'
      + (finished && !job.dryRun ? ' ' + tally + '. Capture acceptance not checked.' : '');
    default: return 'State: ' + job.state;
  }
}
function rowChip(p, job) {
  if (p.state === 'pending') return chip('v-pending', 'Waiting');
  // A row can still say 'running' after the job stopped; never present that as live.
  if (p.state === 'running') return job.state === 'running'
    ? chip('v-running', 'Running now')
    : chip('v-neutral', 'Interrupted, outcome unknown');
  if (p.state === 'skipped') return chip('v-skipped', 'Skipped');
  if (p.verdict) return verdictChip(p.verdict);
  if (p.state === 'failed') return chip('v-failed', 'Failed');
  return chip('v-neutral', job.dryRun ? 'Checked (dry run)' : 'Done, no verdict');
}
function segClass(p) {
  if (p.state === 'running') return 'v-running';
  if ((p.state === 'done' || p.state === 'failed') && p.verdict && VERDICTS[p.verdict]) return VERDICTS[p.verdict].cls;
  if (p.state === 'failed') return 'v-failed';
  if (p.state === 'done') return 'v-neutral';
  return p.state === 'skipped' ? 'v-skipped' : 'v-pending';
}
function renderProgress(job) {
  const rows = job.progress?.length ? job.progress : (job.sites ?? []).map((site) => ({ site, state: 'pending', verdict: null }));
  const sig = JSON.stringify([job.id, job.dryRun, rows]);
  $('#track').replaceChildren(...rows.map((p) => el('span', { class: 'seg ' + segClass(p), title: p.site })));
  if (sig === S.progressSig) return;
  S.progressSig = sig;
  const focused = document.activeElement?.dataset?.focus;
  const list = $('#progress');
  list.replaceChildren(...rows.map((p, i) => {
    const details = [];
    if (p.reason) details.push(el('span', { text: p.reason }));
    if (typeof p.replyChars === 'number') details.push(el('span', { text: 'Reply: ' + p.replyChars + ' characters' }));
    const links = sessionLinks(p.sessionId);
    if (links) { links.firstChild.dataset.focus = 'row-' + i; details.push(links); }
    return el('li', { class: 'prow' }, [
      el('span', { class: 'pnum mono', text: String(i + 1) }),
      el('div', {}, [
        el('div', { class: 'phead' }, [el('b', { class: 'pname', text: p.site }), rowChip(p, job)]),
        details.length ? el('div', { class: 'pdetail' }, details) : null,
      ]),
    ]);
  }));
  if (focused) list.querySelector('[data-focus="' + focused + '"]')?.focus();
}
function renderJob(job) {
  $('#jobEmpty').hidden = true; $('#jobBody').hidden = false;
  $('#jobHead').replaceChildren(
    el('span', { class: 'state s-' + job.state }, [el('span', { class: 'dot' }), el('span', { text: JOB_STATES[job.state] ?? String(job.state) })]),
    job.dryRun ? chip('v-neutral', 'Dry run — nothing sent') : chip('v-unverified', 'Live run — prompts are sent'),
    el('span', { class: 'mono muted', text: job.id }),
  );
  const n = job.sites?.length ?? 0;
  const meta = [(job.mode === 'campaign' ? 'Campaign' : 'Drive') + ' · ' + n + (n === 1 ? ' site' : ' sites')];
  const stamp = (label, v) => { if (toMs(v) != null) meta.push(' · ' + label + ' ', timeNode(v, { absolute: true })); };
  stamp('created', job.createdAt); stamp('started', job.startedAt); stamp('finished', job.finishedAt);
  $('#jobMeta').replaceChildren(...meta);
  $('#jobSummary').textContent = summaryText(job);
  $('#jobError').textContent = job.error ? 'Error: ' + (typeof job.error === 'string' ? job.error : JSON.stringify(job.error)) : '';
  renderProgress(job);
  $('#acceptNote').hidden = job.dryRun;
  const active = ACTIVE.has(job.state);
  $('#btnCancel').hidden = !active; $('#cancelNote').hidden = !active;
  if (active) {
    const requested = S.stopRequested === job.id;
    $('#btnCancel').disabled = requested;
    $('#btnCancel').textContent = requested ? 'Stop requested' : 'Stop after current site';
  }
  for (const li of $('#jobList').querySelectorAll('button[data-id]')) {
    if (li.dataset.id === job.id) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
  }
}
function showJob(job) {
  ++S.jobRequestSeq; // Invalidate any older openJob response before changing the selected job.
  stopPolling();
  S.job = job; S.progressSig = '';
  renderJob(job); renderJobs(); updateControls();
  if (ACTIVE.has(job.state)) startPolling(job.id);
}
async function openJob(id) {
  const requestSeq = ++S.jobRequestSeq;
  $('#pollNote').textContent = 'Loading job…';
  try {
    const { job } = await api('/jobs/' + encodeURIComponent(id));
    if (requestSeq !== S.jobRequestSeq) return;
    if (!job || job.id !== id) throw new Error('Studio returned a different job. No job was selected.');
    $('#pollNote').textContent = '';
    showJob(job);
    if (!ACTIVE.has(job.state)) refreshAfterEnd();
  } catch (e) {
    if (requestSeq !== S.jobRequestSeq) return;
    $('#pollNote').textContent = '';
    const note = 'Could not load requested job: ' + describe(e) +
      (S.job?.id && S.job.id !== id ? ' Showing the previously selected job, not the requested job.' : ' Job status is unverified; nothing was started.');
    $('#jobEmpty').hidden = !!S.job; $('#jobBody').hidden = !S.job;
    if (!S.job) $('#jobEmpty').textContent = note;
    else $('#jobError').textContent = note;
  }
}
function stopPolling() { S.pollSeq++; clearTimeout(S.pollTimer); S.failures = 0; $('#pollNote').textContent = ''; }
function startPolling(id) {
  const seq = ++S.pollSeq;
  const tick = async () => {
    if (seq !== S.pollSeq) return;
    try {
      const { job } = await api('/jobs/' + encodeURIComponent(id));
      if (seq !== S.pollSeq) return;
      S.failures = 0; $('#pollNote').textContent = '';
      S.job = job;
      S.jobs = S.jobs.map((j) => (j.id === job.id ? job : j));
      renderJob(job); updateControls();
      if (!ACTIVE.has(job.state)) { stopPolling(); refreshAfterEnd(); return; }
    } catch (e) {
      if (seq !== S.pollSeq) return;
      if (e.status === 404) { stopPolling(); $('#jobError').textContent = 'This job is no longer available on the Studio. The last displayed state is stale; do not assume the job stopped. No new live run was started.'; $('#btnCancel').disabled = true; return; }
      S.failures++;
      $('#pollNote').textContent = 'Lost contact with the Studio (' + describe(e) + '). Retrying… the job may still be running.';
    }
    S.pollTimer = setTimeout(tick, S.failures >= 5 ? 5000 : POLL_MS);
  };
  S.pollTimer = setTimeout(tick, POLL_MS);
}
function refreshAfterEnd() { loadSites(); loadJobs(); }

$('#btnCancel').onclick = async () => {
  const job = S.job; if (!job) return;
  const btn = $('#btnCancel');
  btn.disabled = true; $('#jobError').textContent = ''; $('#pollNote').textContent = 'Asking Studio to stop after the current site…';
  try {
    const { job: next } = await api('/jobs/' + encodeURIComponent(job.id) + '/cancel', { method: 'POST', body: {} });
    $('#pollNote').textContent = '';
    if (S.job?.id !== job.id) return;
    if (ACTIVE.has(next.state)) S.stopRequested = next.id;
    S.job = next; renderJob(next); updateControls();
    if (!ACTIVE.has(next.state)) { stopPolling(); refreshAfterEnd(); }
  } catch (e) {
    $('#pollNote').textContent = '';
    $('#jobError').textContent = 'Could not stop the job: ' + describe(e);
    btn.disabled = false;
  }
};

/* ---------------- recent jobs ---------------- */
function renderJobs() {
  const list = $('#jobList'), state = $('#jobsState');
  if (!S.jobs.length) { list.hidden = true; return; }
  state.hidden = true; list.hidden = false;
  list.replaceChildren(...S.jobs.slice(0, 20).map((j) => {
    const n = j.sites?.length ?? 0;
    const btn = el('button', { type: 'button', 'data-id': j.id, onclick: () => openJob(j.id) }, [
      timeNode(j.createdAt),
      el('span', { text: (j.mode === 'campaign' ? 'Campaign' : 'Drive') + ' · ' + n + (n === 1 ? ' site' : ' sites') }),
      el('span', { text: j.dryRun ? 'dry run' : 'live' }),
      el('span', { class: 'muted', text: JOB_STATES[j.state] ?? String(j.state) }),
    ]);
    if (S.job?.id === j.id) btn.setAttribute('aria-current', 'true');
    return el('li', {}, [btn]);
  }));
}
async function loadJobs() {
  const state = $('#jobsState');
  if (!S.jobs.length) { state.className = 'empty'; state.textContent = 'Loading jobs…'; state.hidden = false; }
  try {
    const data = await api('/jobs');
    S.jobs = Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : [];
    if (S.job) { const fresh = S.jobs.find((j) => j.id === S.job.id); if (fresh && !ACTIVE.has(S.job.state)) S.job = fresh; }
    if (!S.jobs.length) { state.className = 'empty'; state.textContent = 'No jobs yet.'; state.hidden = false; $('#jobList').hidden = true; }
    else renderJobs();
  } catch (e) {
    state.className = 'err pad'; state.textContent = 'Could not load jobs: ' + describe(e); state.hidden = false;
  }
  updateControls();
}

/* ---------------- wiring ---------------- */
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => { if (r.checked) setMode(r.value); }));
$('#btnAll').onclick = () => { S.selected = new Set(S.sites.map((s) => s.id)); syncChecks(); touched(); };
$('#btnNone').onclick = () => { S.selected = new Set(); syncChecks(); touched(); };
$('#driveUrl').addEventListener('input', () => {
  if ($('#driveUrl').value.trim() && S.selected.size) { S.selected = new Set(); syncChecks(); }
  touched();
});
$('#driveForm').addEventListener('submit', (e) => { e.preventDefault(); launch(true); });
$('#btnLive').addEventListener('click', () => launch(false));
$('#btnJobs').onclick = loadJobs;
window.addEventListener('pagehide', stopPolling);

setMode(document.querySelector('input[name=mode]:checked')?.value ?? 'drive');
(async () => {
  await Promise.allSettled([loadSites(), loadJobs()]);
  const running = S.jobs.find((j) => ACTIVE.has(j.state));
  if (running) { $('#formStatus').textContent = 'A job is already running. Showing it here.'; openJob(running.id); }
})();
