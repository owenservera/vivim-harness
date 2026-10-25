/** AION U1 universal chat projection: client only. No network, browser or effect authority. */
export const U1_SCHEMA = 'aion.ui.universal-chat/1';
const STATES = new Set(['supported','unavailable','unverified']);
const KNOWN = new Set(['text','markdown','code','table','citation','citations','artifact','progress','tool-activity-observed','image','file','reference','visible-thinking-summary','error']);
const asArray = x => Array.isArray(x) ? x : [];
const val = x => typeof x === 'string' ? x : '';
const obj = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const id = x => typeof x === 'string' && x.length > 0 ? x : null;
const safeUrl = x => { try { const u = new URL(x); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
const textValue = x => String(x ?? '');

/** Keep browser attachment distinct from verified conversation identity, and tabs distinct from account index. */
export function projectWorkspace(snapshot = {}, { openTabs = [], accountChats = [] } = {}) {
  const snap = obj(snapshot), binding = obj(snap.binding), ident = obj(snap.identity);
  const state = ['bound','unbound','unverified'].includes(ident.state) ? ident.state : 'unverified';
  const nativeThread = id(ident.threadKey) || id(binding.thread?.key) || id(binding.threadKey) || null;
  const bindingThread = id(binding.thread?.key) || id(binding.threadKey);
  const exact = state === 'bound' && !!nativeThread && !!id(snap.id) && (!bindingThread || bindingThread === nativeThread);
  const provider = id(snap.site?.id) || id(snap.site) || id(snap.provider) || 'unknown';
  const accountState = ['signed-in','signed-out','unknown'].includes(snap.account?.state) ? snap.account.state : 'unknown';
  return {
    schema: U1_SCHEMA, provider, conversationId: id(snap.id), identity: { state, exact, threadRef: exact ? nativeThread : null },
    attachment: { tabRef: id(binding.targetId) || id(binding.tabId), title: val(binding.title), status: val(snap.state) || 'unknown' },
    accountState, openTabs: asArray(openTabs).map(t => ({ tabRef: id(t.id), title: val(t.title), site: val(t.site), kind: 'browser-tab' })),
    accountChats: asArray(accountChats).map(t => ({ threadRef: id(t.threadRef), title: val(t.title), coverage: val(t.coverage) || 'partial', kind: 'account-index' })),
  };
}

/** Data-driven provider rail and task index; presented availability is not effect permission. */
export function projectRail(providers = [], tasks = []) {
  return {
    providers: asArray(providers).map(p=>({ id:id(p.id) || 'unknown', label:val(p.label)||id(p.id)||'unknown provider',
      accountState:['signed-in','signed-out'].includes(p.accountState)?p.accountState:'unknown',
      readState:STATES.has(p.readState)?p.readState:'unverified',
      sendState:STATES.has(p.sendState)?p.sendState:'unverified' })),
    tasks: asArray(tasks).map(t=>({ id:id(t.id), title:val(t.title)||'Unnamed task', conversationId:id(t.conversationId),
      status:val(t.status)||'unknown', provider:id(t.provider)||'unknown' }))
  };
}

/**
 * Render the existing /chat zero-send page read as an explicitly limited observation.
 * A page transcript has positional rows, NOT verified native message IDs, grounded
 * capture SID/seq, or a trustworthy account index. Never convert it into U1 native
 * stream events or mark it as an accepted recording.
 */
export function projectObservedPageRead(snapshot = {}, pageRead = null) {
  const snap = obj(snapshot), read = obj(pageRead), view = obj(read.view);
  const unavailable = reason => ({ state: 'unavailable', reason, messages: [], coverage: [], grounded: false, nativeIds: false, accepted: false });
  if (!pageRead) return unavailable('not-read');
  if (!id(snap.id) || read.convId !== snap.id) return unavailable('conversation-mismatch');
  const thread = binding => {
    const b = obj(binding), t = b.thread;
    return typeof t === 'string' && t ? t : id(t?.ref) || id(t?.key) || id(b.threadKey) || null;
  };
  // The read is tied to the thread observed when the response arrived, even if
  // a later snapshot keeps the same local conversation ID but changes binding.
  if (!Object.hasOwn(read, 'threadRef') || read.threadRef !== thread(snap.binding)) return unavailable('thread-mismatch');
  if (!Number.isSafeInteger(read.seq) || read.seq < 1 || view.ok !== true || !Array.isArray(view.messages)) return unavailable('invalid-read');
  const messages = [];
  let chars = 0;
  for (const m of view.messages.slice(0, 200)) {
    if (!['user','assistant'].includes(m?.role) || typeof m.text !== 'string') continue;
    const text = m.text.slice(0, Math.max(0, 200000 - chars));
    chars += text.length;
    messages.push({ role: m.role, text, cut: m.cut === true || text.length < m.text.length, position: Number.isSafeInteger(m.n) && m.n > 0 ? m.n : null });
    if (chars >= 200000) break;
  }
  return {
    state: 'observed', reason: null, messages, grounded: false, nativeIds: false, accepted: false,
    identity: snap.identity?.state === 'bound' ? 'bound' : 'unverified',
    coverage: Array.isArray(view.lines) ? view.lines.filter(x => typeof x === 'string').slice(0, 12) : [],
    completePageRead: view.chips?.some?.(x => x?.[0] === 'Not a complete copy') === false,
    readAt: typeof view.readAt === 'string' ? view.readAt : null,
  };
}

/** Capability is a multi-dimension read model, never one misleading 'supported' boolean. */
export function projectCapability(x = {}) {
  const c = obj(x); const state = v => STATES.has(v) ? v : 'unverified';
  return { seedConfigured: c.seedConfigured === true, pageObserved: state(c.pageObserved), gateEligible: state(c.gateEligible), effectVerified: state(c.effectVerified), evidence: evidenceRef(c.evidence), observedAt: id(c.observedAt) };
}

export function evidenceRef(x) {
  const e = obj(x);
  const sid = id(e.sid) || id(e.sessionId) || id(e.captureRef);
  const seq = Number.isSafeInteger(e.sequence) && e.sequence >= 0 ? e.sequence : Number.isSafeInteger(e.seq) && e.seq >= 0 ? e.seq : null;
  const verified = e.grounded === true && !!sid && seq !== null;
  return { sid: verified ? sid : null, sequence: verified ? seq : null, grounded: verified, source: id(e.source) || id(e.carrier) || 'unknown', attribution: val(e.attribution) || 'unverified', coverage: val(e.coverage) || 'unknown' };
}

/** Strictly separate page/network status from accepted capture and achieved user goal. */
export function projectOutcome(x = {}) {
  const a = obj(x);
  return { send: val(a.send) || 'unknown', reply: val(a.reply) || 'unknown', networkEnded: a.networkEnded === true, pageStable: a.pageStable === true,
    freshReply: a.freshReply === true, captureFinalized: a.captureFinalized === true, captureAccepted: a.captureAccepted === true, goalFulfilled: a.goalFulfilled === true,
    evidence: evidenceRef(a.evidence) };
}

/** UI must only offer inspection for unknown effects, never a resend or implied authorization. */
export function recoveryView(x = {}) {
  const r = obj(x);
  const unknown = ['uncertain','in_flight','needs-reconciliation'].includes(r.effectState) || r.sendState === 'uncertain' || r.uncertainty === true;
  return { blocked: unknown, title: unknown ? 'Delivery is uncertain — do not send again' : 'Delivery status',
    detail: unknown ? 'Inspect the original conversation and its effect journal without submitting another message. A matching reply alone does not prove delivery.' : 'No unknown effect reported.',
    actions: unknown ? ['inspect-read-only'] : [], retryAuthorized: false, automaticResend: false };
}

/** Evidence display is NOT an adapter authorization or learned adapter promotion. */
export function projectAdapter(x = {}) {
  const a = obj(x), version = id(a.version), baseline = id(a.seedVersion), training = asArray(a.trainingSessionIds), heldout = asArray(a.heldoutSessionIds);
  const independent = heldout.length > 0 && training.length > 0 && heldout.every(s => !training.includes(s)) && a.trainingComplete === true;
  const source = a.source === 'learned' ? 'learned' : a.source === 'seed' ? 'seed' : 'unknown';
  const stage = ['discovered','shadow','read-only-active','rejected','rolled-back','unverified'].includes(a.stage) ? a.stage : 'unverified';
  const effectEligible = false; // This read model is never an effect grant, including when a server reports a seed or learned adapter.
  return { site: id(a.site) || 'unknown', surface: id(a.surface) || 'unknown', source, version, baseline, precedence: val(a.precedence) || 'unverified', stage,
    candidate: a.candidate === true, coverage: Number.isFinite(a.coverage) ? Math.max(0,Math.min(1,a.coverage)) : null,
    confidence: Number.isFinite(a.confidence) ? Math.max(0,Math.min(1,a.confidence)) : null,
    trainingCount: training.length, heldoutCount: heldout.length, heldoutIndependent: independent,
    drift: val(a.drift) || 'unknown', rollbackVersion: id(a.rollbackVersion), shadowResult: val(a.shadowResult) || 'not-tested',
    evidence: evidenceRef(a.evidence), effectEligible };
}

function keyOf(turn, block) { return `${turn}\u0000${block}`; }
/** Stream and revision store. Append is O(1) per chunk; join happens only in a view projection. */
export function createConversationStore({ maxRevisions = 20 } = {}) {
  const turns = new Map(); let changes = 0;
  const asKey = (e) => ({ turn: id(e.turnId), block: id(e.blockId), event: id(e.eventId), sequence: e.sequence });
  function accept(event) {
    const e = obj(event), k = asKey(e);
    if (!k.turn || !k.block || !k.event || !Number.isSafeInteger(k.sequence) || k.sequence < 0) return { applied: false, reason: 'unattributed-event' };
    const kind = id(e.kind) || 'unknown';
    if (!['open','append','replace','patch','close','invalidate'].includes(e.op)) return { applied: false, reason: 'unknown-operation' };
    let t = turns.get(k.turn);
    if (!t) { t = { id: k.turn, blocks: new Map(), seen: new Set() }; turns.set(k.turn,t); }
    if (t.seen.has(k.event)) return { applied: false, reason: 'duplicate' };
    let b = t.blocks.get(k.block);
    if (b && k.sequence <= b.sequence) return { applied: false, reason: 'stale-sequence' };
    if (!b && !['open','replace'].includes(e.op)) return { applied: false, reason: 'no-baseline' };
    if (b && e.revision != null && (!Number.isSafeInteger(e.revision) || e.revision < b.revision)) return { applied: false, reason: 'stale-revision' };
    if (!b) b = { id: k.block, kind, nativeType: val(e.nativeType)||kind, sequence:-1, revision:0, chunks:[], payload:{}, revisions:[], status:'streaming', evidence:evidenceRef(e.evidence) };
    if (['replace','patch'].includes(e.op)) {
      // Patch without an explicit complete replacement has ambiguous native semantics: preserve old display and flag it.
      if (typeof e.text !== 'string' && e.payload == null) return { applied:false, reason:'patch-missing-replacement' };
      b.revisions.push({ revision:b.revision, text:b.chunks.join(''), evidence:b.evidence });
      if (b.revisions.length > maxRevisions) b.revisions.shift();
      b.chunks = typeof e.text === 'string' ? [e.text] : [];
      b.payload = e.payload == null ? {} : structuredClone(e.payload);
      b.revision = Number.isSafeInteger(e.revision) ? e.revision : b.revision + 1;
    } else if (e.op === 'open') {
      if (t.blocks.has(k.block)) return {applied:false,reason:'already-open'};
      b.chunks = typeof e.text === 'string' ? [e.text] : [];
      b.payload = e.payload == null ? {} : structuredClone(e.payload);
      b.revision = Number.isSafeInteger(e.revision) ? e.revision : 0;
    } else if (e.op === 'append') {
      if (b.status !== 'streaming') return {applied:false,reason:'not-streaming'};
      if (typeof e.text !== 'string') return {applied:false,reason:'append-requires-text'};
      b.chunks.push(e.text);
    } else if (e.op === 'close') b.status = 'complete';
    else if (e.op === 'invalidate') b.status = 'invalidated';
    b.sequence = k.sequence;
    if (e.evidence) b.evidence = evidenceRef(e.evidence);
    t.blocks.set(k.block,b); t.seen.add(k.event); changes++;
    return {applied:true, reason:'applied', key:keyOf(k.turn,k.block), changes};
  }
  function getTurn(turnId) {
    const t=turns.get(turnId);
    return t ? { id:t.id, blocks:[...t.blocks.values()].map(b=>({id:b.id,kind:b.kind,nativeType:b.nativeType,text:b.chunks.join(''),payload:structuredClone(b.payload),revision:b.revision,status:b.status,sequence:b.sequence,evidence:b.evidence,revisions:structuredClone(b.revisions)})) } : null;
  }
  return { accept, getTurn, listTurnIds:()=>[...turns.keys()], get changes(){return changes;} };
}

const appendText = (document, parent, tag, content, className) => { const el=document.createElement(tag); if(className) el.className=className; el.textContent=textValue(content); parent.appendChild(el); return el; };
const renderLink = (document,parent, ref) => {
  const u=safeUrl(ref?.url), el=document.createElement(u?'a':'span');
  if(u){el.href=u;el.rel='noopener noreferrer';el.target='_blank';}
  el.textContent=val(ref?.label)||val(ref?.title)||'Reference (unverified URL)';parent.appendChild(el);return el;
};
/** Render provider-native block types without HTML injection. Unknown blocks retain payload and type. */
export function renderNativeBlock(document, parent, block) {
  const b=obj(block), p=obj(b.payload), kind=val(b.kind);
  const wrap=document.createElement('section'); wrap.className='aion-u1-block'; wrap.dataset.kind=kind||'unknown';
  appendText(document,wrap,'small',`${kind || 'unknown'} · rev ${b.revision ?? '?'} · ${b.status || 'unknown'}`,'aion-u1-block-meta');
  const source=evidenceRef(b.evidence);
  if(source.grounded) appendText(document,wrap,'small',`Evidence SID ${source.sid} / seq ${source.sequence}`,'aion-u1-provenance');
  else appendText(document,wrap,'small',`Provenance: ${source.attribution} / ${source.coverage} (no grounded SID/sequence)`,'aion-u1-provenance');
  if(kind==='code') {appendText(document,wrap,'span',val(p.language)||'code');appendText(document,wrap,'pre',val(b.text)||val(p.code),'aion-u1-code');}
  else if(kind==='table') {
    const table=document.createElement('table'), thead=document.createElement('thead'), tr=document.createElement('tr');
    asArray(p.columns).forEach(c=>appendText(document,tr,'th',c));thead.appendChild(tr);table.appendChild(thead);
    const tbody=document.createElement('tbody');asArray(p.rows).forEach(row=>{const r=document.createElement('tr');asArray(row).forEach(c=>appendText(document,r,'td',c));tbody.appendChild(r);});table.appendChild(tbody);wrap.appendChild(table);
  } else if(kind==='citation'||kind==='citations'||kind==='reference') {
    asArray(p.refs).length ? asArray(p.refs).forEach(r=>renderLink(document,wrap,r)) : renderLink(document,wrap,p);
  } else if(kind==='artifact') {
    appendText(document,wrap,'strong',val(p.title)||'Artifact');
    appendText(document,wrap,'p',`Version ${p.version ?? '?'} · ${val(p.status)||'status unknown'} · ${val(p.mediaType)||'unknown type'}`);
    if(b.text) appendText(document,wrap,'pre',b.text);
    asArray(p.versions).forEach(v=>appendText(document,wrap,'small',`Version ${v.version??'?'}: ${val(v.status)||'unknown'}`));
  } else if(kind==='progress') {
    appendText(document,wrap,'p',`${val(p.label)||'Progress'}: ${Number.isFinite(p.percent)?p.percent+'%':'not quantified'}`);
  } else if(kind==='tool-activity-observed') {
    appendText(document,wrap,'p',`${val(p.tool)||'Tool reported by page'} · ${val(p.state)||'state unknown'} (observation, not AION action)`);
  } else if(KNOWN.has(kind)) appendText(document,wrap,'pre',b.text || val(p.summary) || 'No text projection — inspect original source');
  else {
    appendText(document,wrap,'strong',`Unrecognized provider block: ${val(b.nativeType)||kind||'unknown'}`);
    appendText(document,wrap,'pre',b.text||val(p.preview)||'No safe text preview');
    appendText(document,wrap,'small','Native payload retained in the projection; verify original capture for full semantics.');
  }
  parent.appendChild(wrap);return wrap;
}

/** Mounts one additive panel inside existing /chat. No fetch, no router, no sender. */
export function mountUniversalChat({ document, root, onInspect = () => {}, onEvidence = () => {}, onReviewAdapter = () => {} }) {
  if(!document || !root) throw new TypeError('Existing /chat root and document required');
  let store=createConversationStore(), shown=false, lastScope=null;
  const ui=document.createElement('section');ui.className='aion-u1';ui.setAttribute('aria-label','Universal webapp intelligence');
  root.appendChild(ui);
  const cache=new Map();
  function show({ snapshot={},openTabs=[],accountChats=[],providers=[],tasks=[],adapters=[],capabilities=[],events=[],turnIds=[],outcome={},pageRead=null }={}) {
    const scope=JSON.stringify([id(snapshot?.id), id(snapshot?.binding?.targetId)||id(snapshot?.binding?.tabId), id(snapshot?.binding?.thread?.ref)||id(snapshot?.binding?.thread?.key)||id(snapshot?.binding?.threadKey)]);
    // Native event IDs are meaningful only within their originating conversation/attachment.
    // A new scope must never reuse the prior conversation's blocks or cached DOM nodes.
    if(shown && scope !== lastScope){store=createConversationStore();cache.clear();}
    shown=true;lastScope=scope;
    for(const event of asArray(events)) store.accept(event);
    ui.replaceChildren();
    const ws=projectWorkspace(snapshot,{openTabs,accountChats});
    appendText(document,ui,'h3','Universal conversation & adapter intelligence');
    appendText(document,ui,'p',`Provider: ${ws.provider} · account: ${ws.accountState} · conversation: ${ws.identity.state}${ws.identity.exact?' (exact-bound)':' (not exact-bound)'}`);
    appendText(document,ui,'p',`Browser tabs: ${ws.openTabs.length} (NOT account chats) · account index: ${ws.accountChats.length} (coverage may be partial)`);
    appendText(document,ui,'p',`Attached tab: ${ws.attachment.tabRef||'none'} · chat ref: ${ws.identity.threadRef||'unverified'}`);
    const observedRead = projectObservedPageRead(snapshot, pageRead);
    if (observedRead.state === 'observed') {
      const panel=document.createElement('section');panel.setAttribute('aria-label','Observed page transcript (not native evidence)');
      appendText(document,panel,'h4','Observed page text — read-only, not verified native output');
      appendText(document,panel,'p','These are page-visible text rows, not native message IDs or accepted capture evidence. Account history and unloaded messages may be missing.');
      if(observedRead.identity !== 'bound') appendText(document,panel,'p','Thread identity is unverified; do not associate this read with an account chat.');
      for(const line of observedRead.coverage) appendText(document,panel,'small',line);
      for(const m of observedRead.messages) {
        const item=document.createElement('article');
        appendText(document,item,'strong',m.role + (m.position === null ? '' : ' · page position ' + m.position));
        appendText(document,item,'pre',m.text,'aion-u1-page-text');
        if(m.cut) appendText(document,item,'small','Partial text — truncated');
        panel.appendChild(item);
      }
      ui.appendChild(panel);
    } else if (pageRead) appendText(document,ui,'p','Previous page read withheld: ' + observedRead.reason + '. No cross-conversation text displayed.');
    const rail=projectRail(providers,tasks);
    if(rail.providers.length){const region=document.createElement('nav');region.setAttribute('aria-label','Providers');
      for(const p of rail.providers) appendText(document,region,'p',`${p.label} · ${p.accountState} · read ${p.readState} · send ${p.sendState}`);
      ui.appendChild(region);}
    if(ws.accountChats.length){const list=document.createElement('ul');list.setAttribute('aria-label','Account conversation index (partial)');
      for(const c of ws.accountChats) appendText(document,list,'li',`${c.title||'Untitled'} · thread ${c.threadRef||'unverified'} · ${c.coverage} coverage`);
      ui.appendChild(list);}
    if(ws.openTabs.length){const list=document.createElement('ul');list.setAttribute('aria-label','Open browser tabs, not account chats');
      for(const t of ws.openTabs) appendText(document,list,'li',`${t.title||'Untitled'} · tab ${t.tabRef||'unknown'}`);
      ui.appendChild(list);}
    if(rail.tasks.length){const list=document.createElement('ul');list.setAttribute('aria-label','Tasks');
      for(const task of rail.tasks) appendText(document,list,'li',`${task.title} · ${task.status} · ${task.provider} · conversation ${task.conversationId||'unknown'}`);
      ui.appendChild(list);}

    for(const a of asArray(adapters)) {
      const v=projectAdapter(a);const box=document.createElement('details');
      appendText(document,box,'summary',`${v.site}/${v.surface} · ${v.source} ${v.version||'?'} · ${v.stage}`);
      appendText(document,box,'p',`Candidate: ${v.candidate} · shadow: ${v.shadowResult} · training: ${v.trainingCount} · held-out: ${v.heldoutCount} · independent: ${v.heldoutIndependent}`);
      appendText(document,box,'p',`Coverage: ${v.coverage??'unknown'} · confidence: ${v.confidence??'unknown'} · drift: ${v.drift} · rollback: ${v.rollbackVersion||'none'} · seed baseline: ${v.baseline||'none'} · precedence: ${v.precedence}`);
      appendText(document,box,'p','Read-only adapter view. Candidate is never permission to act.');
      if(v.drift!=='unknown'||v.rollbackVersion){const button=document.createElement('button');button.type='button';button.textContent='Review drift / rollback (read-only)';
        button.addEventListener('click',()=>onReviewAdapter({site:v.site,surface:v.surface,version:v.version,rollbackVersion:v.rollbackVersion}));box.appendChild(button);}
      ui.appendChild(box);
    }
    for(const item of asArray(capabilities)) { const c=projectCapability(item);appendText(document,ui,'p',`Capability ${val(item.name)||'unknown'}: seed=${c.seedConfigured} observed=${c.pageObserved} gate=${c.gateEligible} effect=${c.effectVerified}`); }
    const rec=recoveryView({effectState:snapshot?.effectState,sendState:snapshot?.turn?.send?.state,uncertainty:snapshot?.diagnostic?.uncertainty != null});
    if(rec.blocked){const alert=document.createElement('div');alert.setAttribute('role','alert');appendText(document,alert,'strong',rec.title);appendText(document,alert,'p',rec.detail);
      const inspect=document.createElement('button');inspect.type='button';inspect.textContent='Inspect original (read-only)';inspect.addEventListener('click',()=>onInspect({conversationId:ws.conversationId}));alert.appendChild(inspect);ui.appendChild(alert);}
    const o=projectOutcome(outcome);appendText(document,ui,'p',`Send ${o.send}; reply ${o.reply}; network ended ${o.networkEnded}; page stable ${o.pageStable}; fresh reply ${o.freshReply}; capture final ${o.captureFinalized}; accepted ${o.captureAccepted}; goal fulfilled ${o.goalFulfilled}`);
    for(const tid of asArray(turnIds)) {
      const t=store.getTurn(tid);if(!t)continue;
      const article=document.createElement('article');article.dataset.turnId=tid;appendText(document,article,'h4',`Turn ${tid}`);
      for(const b of t.blocks){const ck=keyOf(tid,b.id), signature=`${b.sequence}:${b.revision}:${b.status}`;let element=cache.get(ck);
        if(!element||element.signature!==signature){ const frag=document.createElement('div'); renderNativeBlock(document,frag,b);element={signature,node:frag.firstChild??frag.children[0]}; cache.set(ck,element); }
        // A node is reused when unchanged; ownership remains in this same /chat panel.
        article.appendChild(element.node);
        if(b.evidence.grounded){const btn=document.createElement('button');btn.type='button';btn.textContent=`Inspect SID ${b.evidence.sid} / seq ${b.evidence.sequence}`;btn.addEventListener('click',()=>onEvidence({sid:b.evidence.sid,sequence:b.evidence.sequence,turnId:tid,blockId:b.id}));article.appendChild(btn);}
      } ui.appendChild(article);
    }
    return {workspace:ws,visibleTurns:asArray(turnIds).length,acceptedEvents:store.changes,pageReadState:observedRead.state};
  }
  return { show, accept:event=>store.accept(event), getTurn:store.getTurn, dispose:()=>ui.remove(), element:ui };
}
