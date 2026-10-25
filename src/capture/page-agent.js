// Runs inside an ISOLATED world of the observed page (separate JS globals, shared DOM).
// Strictly observational: MutationObserver + passive capture-phase listeners. It never writes to
// the DOM, never patches page globals, and never reads input values (only their length).
// Results leave through a CDP binding that exists only in this isolated world.
(function aionCaptureAgent(BINDING, CONFIG) {
  if (globalThis.__aionCapture && globalThis.__aionCapture.version) return 'already';
  const cfg = Object.assign({ flushMs: 100, maxBlockTextBytes: 262144, ignoreTags: ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'] }, CONFIG || {});
  const ignore = new Set(cfg.ignoreTags);
  const ids = new WeakMap();
  const nodes = new Map();
  let nextId = 1;
  const idOf = (el) => { let i = ids.get(el); if (!i) { i = nextId++; ids.set(el, i); nodes.set(i, new WeakRef(el)); } return i; };
  const send = (msg) => { try { globalThis[BINDING](JSON.stringify(msg)); } catch (e) { /* binding gone: detached */ } };

  const BLOCK = new Set(['P', 'LI', 'PRE', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'ARTICLE', 'SECTION', 'TR', 'TABLE', 'UL', 'OL', 'FIGURE', 'DD', 'DT', 'BUTTON', 'A', 'CODE', 'DIV', 'SPAN', 'IMG', 'FORM', 'MAIN']);
  const sigOf = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter((c) => c && !/\d{3,}/.test(c)).slice(0, 2).join('.');
    const role = el.getAttribute('role');
    const attrs = [...el.attributes].filter((a) => a.name.startsWith('data-') && a.value.length < 40 && !/\d{4,}|[0-9a-f]{8}-/.test(a.value)).slice(0, 2).map((a) => `${a.name}=${a.value}`);
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (role ? `[role=${role}]` : '') + attrs.map((a) => `[${a}]`).join('');
  };
  const pathOf = (el, depth = 6) => { const out = []; for (let n = el; n && n.nodeType === 1 && out.length < depth; n = n.parentElement) out.unshift(sigOf(n)); return out.join(' > '); };
  const blockOf = (node) => {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el && !BLOCK.has(el.tagName)) el = el.parentElement;
    return el;
  };
  const textOf = (el) => {
    const t = el.textContent || '';
    if (t.length > cfg.maxBlockTextBytes) return { text: t.slice(0, cfg.maxBlockTextBytes), truncated: t.length };
    return { text: t };
  };

  // ---- mutations -------------------------------------------------------------------------
  let dirty = new Map();
  let removed = [];
  const mark = (node) => {
    const b = blockOf(node);
    if (!b || ignore.has(b.tagName)) return;
    dirty.set(b, true);
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') mark(r.target);
      else if (r.type === 'childList') {
        if (r.target.nodeType === 1 && ignore.has(r.target.tagName)) continue;
        mark(r.target);
        for (const n of r.removedNodes) if (n.nodeType === 1 && ids.has(n)) removed.push(ids.get(n));
      } else if (r.type === 'attributes') mark(r.target);
    }
  });
  const flush = () => {
    if (!dirty.size && !removed.length) return;
    const items = [];
    // Report the outermost dirty blocks only, to avoid nested duplicates.
    const els = [...dirty.keys()].filter((el) => el.isConnected);
    const set = new Set(els);
    for (const el of els) {
      let p = el.parentElement, nested = false;
      while (p) { if (set.has(p)) { nested = true; break; } p = p.parentElement; }
      if (nested) continue;
      const t = textOf(el);
      items.push({ op: 'changed', id: idOf(el), tag: el.tagName, sig: sigOf(el), path: pathOf(el), text: t.text, truncated: t.truncated, children: el.childElementCount, busy: el.closest('[aria-busy="true"]') ? true : undefined });
    }
    for (const id of removed) items.push({ op: 'removed', id });
    dirty = new Map(); removed = [];
    if (items.length) send({ type: 'dom.batch', url: location.href, items });
  };
  setInterval(flush, cfg.flushMs);

  // ---- user actions (learn by watching) -------------------------------------------------
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return {};
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim()).slice(0, 80);
    return { id: idOf(el), tag: el.tagName, sig: sigOf(el), path: pathOf(el, 4), label, role: el.getAttribute('role') || undefined };
  };
  const act = (kind, el, extra) => send(Object.assign({ type: 'action', kind, url: location.href, target: describe(el) }, extra || {}));
  const opts = { capture: true, passive: true };
  addEventListener('click', (e) => act('click', e.target.closest('a,button,[role=button],[role=tab],[role=menuitem],summary,label,input') || e.target), opts);
  addEventListener('submit', (e) => act('submit', e.target), opts);
  addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) act('enter', e.target, { shift: e.shiftKey || undefined }); }, opts);
  let inputTimer = null;
  addEventListener('input', (e) => { clearTimeout(inputTimer); const el = e.target; inputTimer = setTimeout(() => act('input', el, { length: (el.value ?? el.textContent ?? '').length }), 400); }, opts);
  let scrollTimer = null;
  addEventListener('scroll', (e) => {
    clearTimeout(scrollTimer);
    const el = e.target === document ? document.scrollingElement : e.target;
    scrollTimer = setTimeout(() => act('scroll', el, { top: Math.round(el.scrollTop || 0), height: Math.round(el.scrollHeight || 0) }), 250);
  }, opts);
  addEventListener('toggle', (e) => act('toggle', e.target, { open: !!e.target.open }), opts);
  document.addEventListener('visibilitychange', () => act('visibility', document.documentElement, { state: document.visibilityState }), opts);

  // ---- shape inspection (on demand) -------------------------------------------------------
  const visibleText = (el) => (el.innerText || el.textContent || '').trim();
  function inspect() {
    const proposals = [];
    const root = document.querySelector('main') || document.body;
    // Repeated sibling structures -> collections of records.
    const all = root.querySelectorAll('*');
    const seen = new Set();
    for (const parent of [root, ...all]) {
      if (parent.childElementCount < 3 || ignore.has(parent.tagName)) continue;
      const groups = new Map();
      for (const c of parent.children) { const s = sigOf(c); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(c); }
      for (const [s, items] of groups) {
        if (items.length < 3 || items.length < parent.childElementCount * 0.5) continue;
        const key = idOf(parent) + '|' + s;
        if (seen.has(key)) continue; seen.add(key);
        const sample = items.slice(0, 5);
        const fieldCounts = new Map();
        for (const it of sample) {
          const leafs = it.querySelectorAll('*');
          const local = new Set();
          for (const l of [it, ...leafs]) {
            if (l.childElementCount === 0 && visibleText(l)) local.add('text:' + sigOf(l));
            if (l.tagName === 'A' && l.href) local.add('link:' + sigOf(l));
            if (l.tagName === 'IMG') local.add('image:' + sigOf(l));
            if (l.tagName === 'TIME' || l.hasAttribute('datetime')) local.add('time:' + sigOf(l));
          }
          for (const f of local) fieldCounts.set(f, (fieldCounts.get(f) || 0) + 1);
        }
        const fields = [...fieldCounts].filter(([, n]) => n >= Math.ceil(sample.length * 0.6)).map(([f, n]) => ({ kind: f.split(':')[0], sig: f.slice(f.indexOf(':') + 1), presence: n / sample.length }));
        if (!fields.length) continue;
        proposals.push({ kind: 'collection', parentId: idOf(parent), itemSig: s, count: items.length, path: pathOf(parent), fields: fields.slice(0, 12), sampleIds: sample.map(idOf), sampleText: visibleText(items[0]).slice(0, 160) });
      }
    }
    for (const t of root.querySelectorAll('table')) {
      const headers = [...t.querySelectorAll('thead th, tr:first-child th')].map((h) => visibleText(h).slice(0, 60));
      proposals.push({ kind: 'table', id: idOf(t), rows: t.querySelectorAll('tbody tr, tr').length - (headers.length ? 1 : 0), columns: headers.length || (t.querySelector('tr')?.children.length ?? 0), headers, path: pathOf(t) });
    }
    const pres = root.querySelectorAll('pre');
    if (pres.length) proposals.push({ kind: 'code_blocks', count: pres.length, ids: [...pres].slice(0, 20).map(idOf), languages: [...new Set([...pres].map((p) => (p.querySelector('code')?.className.match(/language-([\w-]+)/) || [])[1]).filter(Boolean))] });
    const heads = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
    if (heads.length) proposals.push({ kind: 'headings', count: heads.length, outline: [...heads].slice(0, 40).map((h) => ({ id: idOf(h), level: Number(h.tagName[1]), text: visibleText(h).slice(0, 100) })) });
    const links = [...root.querySelectorAll('a[href]')].filter((a) => /^https?:/.test(a.href));
    if (links.length) proposals.push({ kind: 'links', count: links.length, external: links.filter((a) => a.host !== location.host).length, sample: links.slice(0, 15).map((a) => ({ id: idOf(a), text: visibleText(a).slice(0, 80), href: a.href })) });
    const media = [...root.querySelectorAll('img, video, audio, a[download]')].concat([...root.querySelectorAll('a[href]')].filter((a) => FILE_EXT.test(a.getAttribute('href') || '')));
    if (media.length) proposals.push({ kind: 'media', count: media.length, items: media.slice(0, 20).map((m) => ({ id: idOf(m), tag: m.tagName, src: m.currentSrc || m.src || m.href, alt: m.alt || undefined, label: (m.getAttribute('download') || m.textContent || '').trim().slice(0, 60) || undefined })) });
    const forms = root.querySelectorAll('form, textarea, input:not([type=hidden]), select, [contenteditable="true"]');
    if (forms.length) proposals.push({ kind: 'inputs', count: forms.length, items: [...forms].slice(0, 10).map(describe) });
    const busy = document.querySelectorAll('[aria-busy="true"], [aria-live]');
    if (busy.length) proposals.push({ kind: 'live_regions', count: busy.length, items: [...busy].slice(0, 10).map(describe) });
    const tt = turns();
    if (tt.length) proposals.push({ kind: 'turns', count: tt.length, roles: [...new Set(tt.map((t) => t.role))], roleAttribute: tt[0].roleAttribute, ids: tt.slice(0, 20).map((t) => t.domId) });
    return { url: location.href, title: document.title, at: Date.now(), textLength: (document.body?.innerText || '').length, proposals };
  }

  // ---- structured content blocks ----------------------------------------------------------
  const FILE_EXT = /\.(pdf|zip|csv|xlsx?|docx?|pptx?|txt|json|md|png|jpe?g|gif|mp3|mp4|wav|tar|gz)(\?|#|$)/i;
  function inlines(el) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { if (c.nodeValue) out.push({ t: 'text', text: c.nodeValue }); continue; }
        if (c.nodeType !== 1 || ignore.has(c.tagName)) continue;
        const tag = c.tagName;
        if (tag === 'A') out.push({ t: (c.closest('sup') || /citation|cite|source/i.test(c.className + ' ' + (c.getAttribute('data-testid') || ''))) ? 'citation' : 'link', text: (c.innerText || c.textContent || '').trim(), href: c.href });
        else if (tag === 'CODE') out.push({ t: 'code', text: c.textContent });
        else if (tag === 'STRONG' || tag === 'B') out.push({ t: 'strong', text: c.textContent });
        else if (tag === 'EM' || tag === 'I') out.push({ t: 'em', text: c.textContent });
        else if (tag === 'BR') out.push({ t: 'text', text: '\n' });
        else if (c.matches('.katex, math, mjx-container')) out.push({ t: 'equation', tex: texOf(c) });
        else walk(c);
      }
    };
    walk(el);
    return out;
  }
  const texOf = (el) => (el.querySelector('annotation[encoding="application/x-tex"]')?.textContent || el.getAttribute('data-tex') || el.textContent || '').trim();
  const cellText = (c) => (c.innerText || c.textContent || '').trim();
  function blocks(root, depth = 0) {
    const out = [];
    if (!root || depth > 12) return out;
    let para = null;
    const flushPara = () => { if (para && para.text.trim()) out.push(para); para = null; };
    for (const n of root.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) { para = para || { type: 'paragraph', text: '', inline: [] }; para.text += n.nodeValue; para.inline.push({ t: 'text', text: n.nodeValue }); } continue; }
      if (n.nodeType !== 1 || ignore.has(n.tagName)) continue;
      const tag = n.tagName;
      const id = idOf(n);
      if (/^(SPAN|STRONG|B|EM|I|CODE|A|SUP|SUB|MARK|SMALL|BR)$/.test(tag) && !n.matches('.katex-display') && !(tag === 'A' && (n.hasAttribute('download') || FILE_EXT.test(n.getAttribute('href') || '')))) {
        para = para || { type: 'paragraph', text: '', inline: [] };
        para.text += n.textContent; para.inline.push(...inlines({ childNodes: [n] }));
        continue;
      }
      flushPara();
      if (/^H[1-6]$/.test(tag)) out.push({ type: 'heading', id, level: Number(tag[1]), text: cellText(n), inline: inlines(n) });
      else if (tag === 'P') out.push({ type: 'paragraph', id, text: n.textContent, inline: inlines(n) });
      else if (tag === 'UL' || tag === 'OL') out.push({ type: 'list', id, ordered: tag === 'OL', start: tag === 'OL' ? Number(n.getAttribute('start') || 1) : undefined, items: [...n.children].filter((li) => li.tagName === 'LI').map((li) => ({ id: idOf(li), blocks: blocks(li, depth + 1) })) });
      else if (tag === 'TABLE') {
        const head = [...n.querySelectorAll('thead th')].map(cellText);
        const rows = [...n.querySelectorAll('tbody tr, tr')].filter((r) => !r.closest('thead')).map((r) => [...r.children].map(cellText));
        const headers = head.length ? head : (rows.length && n.querySelector('tr th') ? rows.shift() : []);
        out.push({ type: 'table', id, headers, rows });
      }
      else if (tag === 'PRE') { const code = n.querySelector('code'); out.push({ type: 'code', id, language: ((code?.className || '').match(/language-([\w+#-]+)/) || [])[1] || n.getAttribute('data-language') || undefined, text: (code || n).textContent }); }
      else if (tag === 'BLOCKQUOTE') out.push({ type: 'quote', id, blocks: blocks(n, depth + 1) });
      else if (tag === 'IMG') out.push({ type: 'image', id, src: n.currentSrc || n.src, alt: n.alt || undefined, width: n.naturalWidth || undefined, height: n.naturalHeight || undefined });
      else if (tag === 'VIDEO' || tag === 'AUDIO') out.push({ type: 'media', id, kind: tag.toLowerCase(), src: n.currentSrc || n.src || n.querySelector('source')?.src });
      else if (tag === 'HR') out.push({ type: 'rule', id });
      else if (n.matches('.katex-display, mjx-container[display="true"], math[display="block"]')) out.push({ type: 'equation', id, display: true, tex: texOf(n) });
      else if (tag === 'A' && (n.hasAttribute('download') || FILE_EXT.test(n.getAttribute('href') || ''))) out.push({ type: 'file', id, name: (n.getAttribute('download') || n.textContent || '').trim(), href: n.href });
      else if (tag === 'FIGURE') out.push({ type: 'figure', id, blocks: blocks(n, depth + 1), caption: n.querySelector('figcaption') ? cellText(n.querySelector('figcaption')) : undefined });
      else if (tag === 'DETAILS') out.push({ type: 'details', id, summary: n.querySelector('summary') ? cellText(n.querySelector('summary')) : undefined, open: n.open, blocks: blocks(n, depth + 1) });
      else if (tag === 'svg' || tag === 'SVG' || tag === 'CANVAS') out.push({ type: 'graphic', id, kind: tag.toLowerCase(), label: n.getAttribute('aria-label') || undefined });
      else if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') { /* controls are not content */ }
      else out.push(...blocks(n, depth + 1));
    }
    flushPara();
    // Ordinal among emitted siblings (document order). Nested blocks get their own 0-based run
    // because each nested blocks() call renumbers its own output.
    out.forEach((b, i) => { b.ord = i; });
    return out;
  }

  // ---- conversation-like turns (generic: any attribute whose value is a role word) -------
  const ROLE_WORDS = new Set(['user', 'assistant', 'human', 'ai', 'model', 'bot', 'system', 'tool']);
  const SKIP_ATTR = new Set(['class', 'id', 'style', 'href', 'src', 'type', 'name', 'value', 'placeholder', 'aria-label', 'title', 'alt']);
  function turns() {
    const cands = [];
    for (const el of document.querySelectorAll('body *')) {
      if (ignore.has(el.tagName)) continue;
      for (const a of el.attributes) {
        if (SKIP_ATTR.has(a.name)) continue;
        const v = a.value.trim().toLowerCase();
        if (ROLE_WORDS.has(v)) { cands.push({ el, attr: a.name, role: v }); break; }
        // Role-suffixed keys, e.g. data-content-search-unit-key="fallback-turn-0:2:assistant".
        if (a.name.startsWith('data-')) { const m = v.match(/[:_]([a-z]+)$/); if (m && ROLE_WORDS.has(m[1])) { cands.push({ el, attr: a.name, role: m[1], match: 'suffix' }); break; } }
      }
    }
    // Keep the outermost element per attribute name.
    const set = new Set(cands.map((c) => c.el));
    const outer = cands.filter((c) => { for (let p = c.el.parentElement; p; p = p.parentElement) if (set.has(p) && cands.find((x) => x.el === p && x.attr === c.attr)) return false; return true; });
    // Group choice is text-aware: candidate count alone let a group of identical hidden labels outrank real messages.
    const byAttr = new Map();
    for (const c of outer) { if (!byAttr.has(c.attr)) byAttr.set(c.attr, []); byAttr.get(c.attr).push(c); }
    const eligible = [...byAttr.entries()].filter(([, g]) => new Set(g.map((c) => c.role)).size >= 2 || g.length >= 2);
    // Scoring text: innerText; textContent only for an empty, non-hidden element (never for hidden ones).
    const scoreText = (el) => {
      const inner = (el.innerText || '').trim();
      if (inner) return inner;
      const hidden = el.hidden === true || el.getAttribute('aria-hidden') === 'true';
      return hidden ? '' : (el.textContent || '').trim();
    };
    const st = new Map(outer.map((c) => [c, scoreText(c.el)]));
    const isSubstantive = (s) => s.length >= 20 || s.split(/\s+/).filter(Boolean).length >= 4;
    const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const scored = eligible.map(([attr, g]) => {
      const lens = g.map((c) => st.get(c).length).sort((a, b) => a - b);
      return {
        attr, g,
        roles: new Set(g.map((c) => c.role)).size,
        count: g.length,
        substantive: g.filter((c) => isSubstantive(st.get(c))).length,
        median: lens[Math.floor((lens.length - 1) / 2)],
        unique: new Set(g.map((c) => norm(st.get(c)))).size / g.length,
      };
    }).filter((s) => s.substantive >= 1);
    let best;
    if (scored.length) {
      // Lexicographic: >=2 roles, more substantive, more unique text, longer median, more candidates, name.
      scored.sort((a, b) => ((b.roles >= 2) - (a.roles >= 2)) || (b.substantive - a.substantive) || (b.unique - a.unique) || (b.median - a.median) || (b.count - a.count) || (a.attr < b.attr ? -1 : a.attr > b.attr ? 1 : 0));
      const g = scored[0].g;
      // Hidden decoration: text under 3 chars repeated by a candidate with a different role. Dropped only if a substantive candidate remains.
      const keep = g.filter((c) => !(st.get(c).length < 3 && g.some((o) => o !== c && o.role !== c.role && norm(st.get(o)) === norm(st.get(c)))));
      best = keep.some((c) => isSubstantive(st.get(c))) ? keep : g;
    } else {
      // No substantive candidate anywhere: previous behaviour (most candidates, first in document order).
      best = eligible.map(([, g]) => g).sort((a, b) => b.length - a.length)[0] || [];
    }
    return best.slice(0, 500).map((c, i) => {
      const idAttr = [...c.el.attributes].find((a) => /(^|-)(message|turn|item)?-?id$/.test(a.name) && a.name !== 'id');
      const text = (c.el.innerText || c.el.textContent || '').trim();
      return { index: i, id: idAttr ? idAttr.value : idOf(c.el), domId: idOf(c.el), role: c.role, roleAttribute: c.attr, roleMatch: c.match === 'suffix' ? 'suffix' : 'exact', text: text.length > cfg.maxBlockTextBytes ? text.slice(0, cfg.maxBlockTextBytes) : text, truncated: text.length > cfg.maxBlockTextBytes ? text.length : undefined, blocks: blocks(c.el) };
    });
  }

  function snapshot() {
    return { url: location.href, title: document.title, html: document.documentElement.outerHTML, textLength: (document.body?.innerText || '').length };
  }

  globalThis.__aionCapture = { version: 1, inspect, snapshot, turns, blocks: (id) => blocks(nodes.get(id)?.deref()), node: (id) => nodes.get(id)?.deref() || null, stop: () => mo.disconnect() };
  mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'aria-expanded', 'data-state', 'hidden', 'open'] });
  send({ type: 'agent.ready', url: location.href, title: document.title });
  return 'started';
});
