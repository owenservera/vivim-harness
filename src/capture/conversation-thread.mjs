import { richPartReaderSource, boundRichParts } from './conversation-rich.mjs';
// Thread identity and bounded, read-only transcript shaping for the conversation lifecycle.
// No browser access here: the adapter evaluates `transcriptExpression` and passes the raw result to
// `boundTranscript`. Only the observed ChatGPT `/c/<uuid>` form is a thread; any other path (home,
// project or custom-GPT forms, which are not observed in saved sessions or source) is unverified.
// A tab title is never an input.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHATGPT_C = new RegExp(`^/c/(${UUID})/?$`, 'i');
const UUID_ONLY = new RegExp(`^${UUID}$`);

export const THREAD_SITES = Object.freeze(['chatgpt']);
export const threadSupported = (siteId) => THREAD_SITES.includes(siteId);

// @serves 003,009,013,100
export function parseThread(siteId, url) {
  if (siteId !== 'chatgpt') return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.port) return null;
  const match = CHATGPT_C.exec(parsed.pathname);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return { kind: 'chatgpt-c', id, ref: `chatgpt-c:${id}` };
}

export const sameThread = (a, b) => (a?.ref ?? null) === (b?.ref ?? null);

export function validThread(thread) {
  if (thread === null || thread === undefined) return true;
  return typeof thread === 'object' && thread.kind === 'chatgpt-c' && typeof thread.id === 'string' && UUID_ONLY.test(thread.id) && thread.ref === `chatgpt-c:${thread.id}`;
}

export const IDENTITY_STATES = Object.freeze(['bound', 'unbound', 'unverified']);
export function validIdentity(identity, thread) {
  if (!identity || typeof identity !== 'object' || !IDENTITY_STATES.includes(identity.state)) return false;
  if (identity.reason !== null && identity.reason !== undefined && !/^[A-Z][A-Z0-9_]{0,59}$/.test(identity.reason)) return false;
  return (identity.state === 'bound') === !!thread;
}

export const TRANSCRIPT_LIMITS = Object.freeze({ maxMessages: { min: 1, max: 200, default: 40 }, maxChars: { min: 1, max: 200000, default: 60000 }, perMessageCap: 20000, scanLimit: 400 });

// Specific, role-labelled message nodes only. Generic containers are deliberately not used because
// one container can hold both roles.
export const TRANSCRIPT_SELECTORS = Object.freeze({
  user: ['[data-message-author-role="user"]', '[data-content-search-unit-key$="user"]', '[data-chatgpt-search-unit-key$="user"]', '[data-testid="user-message"]'],
  assistant: ['[data-message-author-role="assistant"]', '[data-content-search-unit-key$="assistant"]', '[data-chatgpt-search-unit-key$="assistant"]'],
});

// Internal, untruncated turn attribution probe. IDs come ONLY from observed data-message-id;
// positional turn indexes, text, timestamps and generated IDs are never identity substitutes.
export function turnObservationExpression(adapter = {}) {
  return `(() => {
    // Only genuinely visible controls/messages may authorize an effect-time preflight.
    // A rendered child can carry dimensions while an ancestor is ARIA-hidden or inert.
    const visible = (el) => {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        for (let node = el; node; node = node.parentElement) {
          if (node.hidden === true || node.inert === true || node.getAttribute?.('aria-hidden') === 'true') return false;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
            || style.contentVisibility === 'hidden') return false;
        }
        return true;
      } catch { return false; }
    };
    const all = sels => { const out=[]; for(const sel of sels) { try { for(const el of document.querySelectorAll(sel)) if(visible(el)&&!out.includes(el)) out.push(el); } catch {} } return out; };
    const users=all(${JSON.stringify(TRANSCRIPT_SELECTORS.user)}), assistants=all(${JSON.stringify(TRANSCRIPT_SELECTORS.assistant)});
    const nodes=[...new Set([...users,...assistants])].filter(el=>!users.includes(el)||!assistants.includes(el));
    const kept=nodes.filter(el=>!nodes.some(other=>other!==el&&other.contains(el)));
    kept.sort((a,b)=>a===b?0:(a.compareDocumentPosition(b)&4)?-1:1);
    const idOf=el=>{ const owner=el.closest('[data-message-id]'); if(owner) return owner.getAttribute('data-message-id')||null;
      const unit=el.getAttribute('data-chatgpt-search-message-ids'); if(unit&&unit.trim()) return unit.trim().split(/\\s+/)[0];
      const inner=el.querySelector('[data-chatgpt-selection-message-id],[data-dil-source-message-id]');
      return inner?(inner.getAttribute('data-chatgpt-selection-message-id')||inner.getAttribute('data-dil-source-message-id')||null):null; };
    const messages=kept.map(el=>{ return {role:users.includes(el)?'user':'assistant',id:idOf(el),text:String(el.innerText??el.textContent??'').replace(/\\r\\n/g,'\\n')}; });
    const composer=all(${JSON.stringify(adapter.composer?.selectors ?? [])})[0];
    const text=composer?String(composer.value??composer.innerText??composer.textContent??'').replace(/\\r\\n/g,'\\n'):null;
    const stop=all(${JSON.stringify(adapter.assistant?.streamingSelectors ?? [])}).length>0;
    const sendBtn=all(${JSON.stringify(adapter.send?.buttonSelectors ?? [])}).length>0;
    // A missing Stop control and empty draft do NOT prove the UI is idle. Use positive
    // send-control evidence only; otherwise leave readiness unknown and preserve the fence.
    const idle=sendBtn;
    const enabled=!!composer && composer.disabled!==true && composer.getAttribute('aria-disabled')!=='true';
    return {origin:String(location.origin),pathname:String(location.pathname),messages,draft:{text,chars:text===null?null:text.replace(/\\s+/g,' ').trim().length},
      controls:{observed:!!composer&&idle,state:stop?'busy':idle&&enabled?'idle':'unknown',idleControlPresent:idle,stopPresent:stop,composerEnabled:enabled}};
  })()`;
}

// In-page reader. Pure observation: it never focuses, scrolls, clicks, types, navigates or writes a
// property. Draft handling reports presence and length only, never the draft text. `controls` is the
// same positive-idle proof the turn reader uses, so an observed-prefix read can refuse a spinner
// instead of inferring completion from a missing one.
// @serves 007,042
export function transcriptExpression({ userSelectors = TRANSCRIPT_SELECTORS.user, assistantSelectors = TRANSCRIPT_SELECTORS.assistant,
  composerSelectors = [], streamingSelectors = [], sendSelectors = [], perMessageCap = TRANSCRIPT_LIMITS.perMessageCap, scanLimit = TRANSCRIPT_LIMITS.scanLimit } = {}) {
  return `(() => {
    const USER = ${JSON.stringify(userSelectors)}, ASSISTANT = ${JSON.stringify(assistantSelectors)}, COMPOSER = ${JSON.stringify(composerSelectors)};
    const STREAMING = ${JSON.stringify(streamingSelectors)}, SEND = ${JSON.stringify(sendSelectors)};
    const CAP = ${Math.trunc(perMessageCap)}, SCAN = ${Math.trunc(scanLimit)};
    const all = (sels) => { const out = []; for (const sel of sels) { let list = []; try { list = Array.from(document.querySelectorAll(sel)); } catch (e) { list = []; } for (const el of list) if (!out.includes(el)) out.push(el); } return out; };
    ${richPartReaderSource()}
    const visible = (el) => {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        for (let node = el; node; node = node.parentElement) {
          if (node.hidden === true || node.inert === true || node.getAttribute?.('aria-hidden') === 'true') return false;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
            || style.contentVisibility === 'hidden') return false;
        }
        return true;
      } catch { return false; }
    };
    const users = all(USER), assistants = all(ASSISTANT);
    let hiddenSkipped = 0, nestedDropped = 0, ambiguousSkipped = 0;
    const tagged = [];
    for (const el of users.concat(assistants.filter((a) => !users.includes(a)))) {
      if (users.includes(el) && assistants.includes(el)) { ambiguousSkipped++; continue; }
      if (!visible(el)) { hiddenSkipped++; continue; }
      tagged.push({ el, role: users.includes(el) ? 'user' : 'assistant' });
    }
    const kept = tagged.filter((x) => { const nested = tagged.some((o) => o.el !== x.el && o.el.contains(x.el)); if (nested) nestedDropped++; return !nested; });
    kept.sort((a, b) => (a.el === b.el ? 0 : (a.el.compareDocumentPosition(b.el) & 4) ? -1 : 1));
    const total = kept.length, slice = kept.slice(-SCAN);
    const messages = slice.map((x) => { const text = String(x.el.innerText ?? x.el.textContent ?? '').replace(/\\r\\n/g, '\\n'); const native = x.el.closest?.('[data-message-id]')?.getAttribute?.('data-message-id') || null; return { role: x.role, text: text.length > CAP ? text.slice(0, CAP) : text, chars: text.length, ...(native ? { id: native, idSource: 'data-message-id' } : {}), ...(() => { const rich=readRichParts(x.el); return {parts:rich.parts,partsOmitted:rich.omitted}; })() }; });
    let scroll = { found: false, topReached: null, bottomReached: null };
    if (slice.length) {
      for (let node = slice[0].el.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
          scroll = { found: true, topReached: node.scrollTop <= 1, bottomReached: node.scrollTop + node.clientHeight >= node.scrollHeight - 1 }; break;
        }
      }
    }
    let draft = { present: null, chars: null }, composerEl = null;
    for (const sel of COMPOSER) {
      let el = null; try { el = document.querySelector(sel); } catch (e) { el = null; }
      if (!el) continue;
      const value = typeof el.value === 'string' ? el.value : String(el.innerText ?? el.textContent ?? '');
      const chars = value.replace(/\\s+/g, ' ').trim().length; draft = { present: chars > 0, chars }; composerEl = el; break;
    }
    const stop = all(STREAMING).some(visible);
    const sendBtn = all(SEND).some(visible);
    // A visible idle control is positive evidence; absence of a stop button alone is not.
    const idle = sendBtn;
    const enabled = !!composerEl && composerEl.disabled !== true && composerEl.getAttribute('aria-disabled') !== 'true';
    const controls = { observed: !!composerEl && idle, state: stop ? 'busy' : (idle && enabled ? 'idle' : 'unknown'),
      idleControlPresent: idle, stopPresent: stop, composerEnabled: enabled };
    return { pathname: String(location.pathname), origin: String(location.origin), renderedTotal: total, messages, hiddenSkipped, nestedDropped, ambiguousSkipped, scroll, draft, controls };
  })()`;
}

const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

// Applies the caller's bounds to the page result and reports coverage without claiming completeness.
// @serves 041
export function boundTranscript(rawResult, { maxMessages = TRANSCRIPT_LIMITS.maxMessages.default, maxChars = TRANSCRIPT_LIMITS.maxChars.default,
  perMessageCap = TRANSCRIPT_LIMITS.perMessageCap } = {}) {
  const source = Array.isArray(rawResult?.messages) ? rawResult.messages : [];
  const renderedTotal = Number.isSafeInteger(rawResult?.renderedTotal) && rawResult.renderedTotal >= source.length ? rawResult.renderedTotal : source.length;
  const offset = renderedTotal - source.length;
  const valid = []; let invalid = 0;
  source.forEach((m, i) => {
    const ok = m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && Number.isSafeInteger(m.chars) && m.chars >= m.text.length;
    if (ok) valid.push({ index: offset + i, role: m.role, text: m.text, chars: m.chars,
      id: m.idSource === 'data-message-id' && typeof m.id === 'string' && m.id.trim() && m.id.length <= 256 ? m.id : null, parts:m.parts, partsOmitted:m.partsOmitted }); else invalid++;
  });
  const kept = []; let budget = maxChars, tails = 0, richBudget = Math.min(16000, maxChars);
  for (let i = valid.length - 1; i >= 0 && kept.length < maxMessages && budget > 0; i--) {
    const m = valid[i], cap = Math.min(perMessageCap, budget), text = m.text.length > cap ? m.text.slice(0, cap) : m.text;
    const rich = boundRichParts(m.parts, {completeText:text.length===m.chars,maxChars:richBudget});
    if(rich) richBudget -= JSON.stringify(rich.parts).length;
    kept.push({ index: m.index, role: m.role, text, chars: m.chars, truncated: text.length < m.chars,
      ...(m.id ? { id: m.id, idSource: 'data-message-id' } : {}),
      ...(rich ? {parts:rich.parts,partsCoverage:{source:rich.source,complete:rich.complete,
        omitted:rich.omitted+(Number.isSafeInteger(m.partsOmitted)&&m.partsOmitted>=0?m.partsOmitted:0),
        excludedForTruncatedText:rich.excludedForTruncatedText}} : {}) });
    budget -= text.length; tails += m.chars - text.length;
  }
  kept.reverse();
  const keptIndexes = new Set(kept.map((m) => m.index));
  const omittedChars = valid.filter((m) => !keptIndexes.has(m.index)).reduce((n, m) => n + m.chars, 0) + tails;
  const scroll = rawResult?.scroll;
  const draft = rawResult?.draft && typeof rawResult.draft.present === 'boolean' && Number.isSafeInteger(rawResult.draft.chars) && rawResult.draft.chars >= 0
    ? { present: rawResult.draft.present, chars: rawResult.draft.chars } : { present: null, chars: null };
  // Only observed UI affordances establish streaming/idle; an untrusted page's
  // self-reported state cannot promote an absent control to a verified state.
  const indicators = rawResult?.controls;
  const stopPresent = indicators?.stopPresent === true;
  const idleControlPresent = indicators?.idleControlPresent === true;
  const composerEnabled = indicators?.composerEnabled === true;
  const idleProven = idleControlPresent && composerEnabled;
  const controls = {
    state: stopPresent ? 'busy' : idleProven ? 'idle' : 'unknown',
    observed: stopPresent || idleProven,
    stopPresent, idleControlPresent, composerEnabled,
  };
  return {
    source: 'page-visible-dom',
    messages: kept,
    controls,
    coverage: {
      scope: 'currently-rendered-messages', complete: false,
      renderedMessages: renderedTotal, returnedMessages: kept.length, omittedMessages: renderedTotal - kept.length, omittedChars,
      unscannedRenderedMessages: offset, omittedCharsUnknown: offset > 0,
      truncatedMessages: kept.filter((m) => m.truncated).length, invalidMessages: invalid,
      hiddenSkipped: count(rawResult?.hiddenSkipped), nestedDropped: count(rawResult?.nestedDropped), ambiguousSkipped: count(rawResult?.ambiguousSkipped),
      olderHistory: scroll?.found !== true ? 'unknown' : scroll.topReached ? 'top-reached' : 'older-unrendered-likely',
      newerHistory: scroll?.found !== true ? 'unknown' : scroll.bottomReached ? 'bottom-reached' : 'newer-unrendered-likely',
      preAttachHistory: 'not-captured-by-this-read',
    },
    draft,
    limits: { maxMessages, maxChars, perMessageCap },
  };
}
