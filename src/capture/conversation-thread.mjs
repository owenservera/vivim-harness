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

export function parseThread(siteId, url) {
  if (siteId !== 'chatgpt') return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)) return null;
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
    const visible = el => { const r=el.getBoundingClientRect(); return r.width>1 && r.height>1; };
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
    const emptyDraft=!!composer&&String(composer.value??composer.innerText??composer.textContent??'').replace(/\\s+/g,'').length===0;
    const idle=sendBtn||(emptyDraft&&!stop);
    const enabled=!!composer && composer.disabled!==true && composer.getAttribute('aria-disabled')!=='true';
    return {origin:String(location.origin),pathname:String(location.pathname),messages,draft:{text,chars:text===null?null:text.replace(/\\s+/g,' ').trim().length},
      controls:{observed:!!composer&&idle,state:stop?'busy':idle&&enabled?'idle':'unknown',idleControlPresent:idle,stopPresent:stop,composerEnabled:enabled}};
  })()`;
}

// In-page reader. Pure observation: it never focuses, scrolls, clicks, types, navigates or writes a
// property. Draft handling reports presence and length only, never the draft text.
export function transcriptExpression({ userSelectors = TRANSCRIPT_SELECTORS.user, assistantSelectors = TRANSCRIPT_SELECTORS.assistant,
  composerSelectors = [], perMessageCap = TRANSCRIPT_LIMITS.perMessageCap, scanLimit = TRANSCRIPT_LIMITS.scanLimit } = {}) {
  return `(() => {
    const USER = ${JSON.stringify(userSelectors)}, ASSISTANT = ${JSON.stringify(assistantSelectors)}, COMPOSER = ${JSON.stringify(composerSelectors)};
    const CAP = ${Math.trunc(perMessageCap)}, SCAN = ${Math.trunc(scanLimit)};
    const all = (sels) => { const out = []; for (const sel of sels) { let list = []; try { list = Array.from(document.querySelectorAll(sel)); } catch (e) { list = []; } for (const el of list) if (!out.includes(el)) out.push(el); } return out; };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
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
    const messages = slice.map((x) => { const text = String(x.el.innerText ?? x.el.textContent ?? '').replace(/\\r\\n/g, '\\n'); const native = x.el.closest?.('[data-message-id]')?.getAttribute?.('data-message-id') || null; return { role: x.role, text: text.length > CAP ? text.slice(0, CAP) : text, chars: text.length, ...(native ? { id: native, idSource: 'data-message-id' } : {}) }; });
    let scroll = { found: false, topReached: null, bottomReached: null };
    if (slice.length) {
      for (let node = slice[0].el.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
          scroll = { found: true, topReached: node.scrollTop <= 1, bottomReached: node.scrollTop + node.clientHeight >= node.scrollHeight - 1 }; break;
        }
      }
    }
    let draft = { present: null, chars: null };
    for (const sel of COMPOSER) {
      let el = null; try { el = document.querySelector(sel); } catch (e) { el = null; }
      if (!el) continue;
      const value = typeof el.value === 'string' ? el.value : String(el.innerText ?? el.textContent ?? '');
      const chars = value.replace(/\\s+/g, ' ').trim().length; draft = { present: chars > 0, chars }; break;
    }
    return { pathname: String(location.pathname), origin: String(location.origin), renderedTotal: total, messages, hiddenSkipped, nestedDropped, ambiguousSkipped, scroll, draft };
  })()`;
}

const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

// Applies the caller's bounds to the page result and reports coverage without claiming completeness.
export function boundTranscript(rawResult, { maxMessages = TRANSCRIPT_LIMITS.maxMessages.default, maxChars = TRANSCRIPT_LIMITS.maxChars.default,
  perMessageCap = TRANSCRIPT_LIMITS.perMessageCap } = {}) {
  const source = Array.isArray(rawResult?.messages) ? rawResult.messages : [];
  const renderedTotal = Number.isSafeInteger(rawResult?.renderedTotal) && rawResult.renderedTotal >= source.length ? rawResult.renderedTotal : source.length;
  const offset = renderedTotal - source.length;
  const valid = []; let invalid = 0;
  source.forEach((m, i) => {
    const ok = m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && Number.isSafeInteger(m.chars) && m.chars >= m.text.length;
    if (ok) valid.push({ index: offset + i, role: m.role, text: m.text, chars: m.chars,
      id: m.idSource === 'data-message-id' && typeof m.id === 'string' && m.id.trim() && m.id.length <= 256 ? m.id : null }); else invalid++;
  });
  const kept = []; let budget = maxChars, tails = 0;
  for (let i = valid.length - 1; i >= 0 && kept.length < maxMessages && budget > 0; i--) {
    const m = valid[i], cap = Math.min(perMessageCap, budget), text = m.text.length > cap ? m.text.slice(0, cap) : m.text;
    kept.push({ index: m.index, role: m.role, text, chars: m.chars, truncated: text.length < m.chars,
      ...(m.id ? { id: m.id, idSource: 'data-message-id' } : {}) });
    budget -= text.length; tails += m.chars - text.length;
  }
  kept.reverse();
  const keptIndexes = new Set(kept.map((m) => m.index));
  const omittedChars = valid.filter((m) => !keptIndexes.has(m.index)).reduce((n, m) => n + m.chars, 0) + tails;
  const scroll = rawResult?.scroll;
  const draft = rawResult?.draft && typeof rawResult.draft.present === 'boolean' && Number.isSafeInteger(rawResult.draft.chars) && rawResult.draft.chars >= 0
    ? { present: rawResult.draft.present, chars: rawResult.draft.chars } : { present: null, chars: null };
  return {
    source: 'page-visible-dom',
    messages: kept,
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
