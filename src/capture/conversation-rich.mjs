// Bounded semantic DOM reader for ChatGPT's EXISTING read-only conversation observation.
// The returned source runs inside the already-attached CDP page. It never fetches, clicks, scrolls,
// focuses, changes draft text or drives a second browser. All shapes are page-visible candidates.
export const RICH_PART_KINDS = Object.freeze([
  'list-item', 'code', 'table', 'blockquote', 'link', 'citation-candidate', 'image', 'math',
]);
export const RICH_PARTS_MAX = 32;
export const RICH_PARTS_MAX_CHARS = 8192;

export function richPartReaderSource() {
  return String.raw`
    const readRichParts = (root) => {
      if (typeof root.querySelectorAll !== 'function') return { parts: [], omitted: 0 };
      const nodes = Array.from(root.querySelectorAll('li,pre,table,blockquote,a[href],img,math,[data-math],[data-testid*="citation" i]'));
      const clip = (s,n=512) => String(s ?? '').slice(0,n);
      const safeLink = (href) => {
        if (!href) return null;
        try {
          const u = new URL(href, location.href || location.origin);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
          // Do not reveal credentials, query tokens or fragments in the transcript tool.
          u.username=''; u.password=''; u.search=''; u.hash='';
          return u.toString();
        } catch { return null; }
      };
      const parts = []; let pageBudget = 8192, skipped = Math.max(0,nodes.length-32);
      for (const el of nodes.slice(0,32)) {
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width < 1 || rect.height < 1) { skipped++; continue; }
        const tag = String(el.tagName ?? '').toLowerCase();
        const label = clip(el.innerText ?? el.textContent);
        let part = null;
        if (tag === 'li') {
          let depth=0,parent=el.parentElement;
          while (parent && parent!==root) {
            if (['ol','ul'].includes(String(parent.tagName).toLowerCase())) depth++;
            parent=parent.parentElement;
          }
          part={type:'list-item',ordered:String(el.parentElement?.tagName??'').toLowerCase()==='ol',
            depth:Math.min(depth,20),text:label};
        } else if (tag === 'pre') {
          const code=el.querySelector?.('code')??el;
          const language=String(code.className??'').split(' ').find(x=>x.startsWith('language-'))?.slice(9,49)??null;
          part={type:'code',language,text:clip(code.innerText??code.textContent,4096)};
        } else if (tag === 'table') {
          const rows=Array.from(el.querySelectorAll('tr'));
          part={type:'table',rows:rows.slice(0,12).map(row=>Array.from(row.querySelectorAll('th,td')).slice(0,8)
            .map(cell=>({header:String(cell.tagName).toLowerCase()==='th',
              text:clip(cell.innerText??cell.textContent,128)}))),rowsTruncated:rows.length>12};
        } else if (tag === 'blockquote') part={type:'blockquote',text:clip(label,2048)};
        else if (tag === 'a') {
          const href=safeLink(el.getAttribute?.('href'));
          if (href) part={type:/citation/i.test(String(el.getAttribute?.('data-testid')??''))?'citation-candidate':'link',
            text:label,href,hrefSanitized:true};
        } else if (tag === 'img') part={type:'image',alt:clip(el.getAttribute?.('alt')),
          sourcePresent:!!el.getAttribute?.('src')};
        else if (tag === 'math' || el.hasAttribute?.('data-math')) {
          const latex=el.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent
            ??el.getAttribute?.('data-math')??null;
          part={type:'math',latex:latex===null?null:clip(latex,2048),text:label};
        } else if (/citation/i.test(String(el.getAttribute?.('data-testid')??'')))
          part={type:'citation-candidate',text:label,href:null};
        if (part) {
          const candidate={index:parts.length,...part};
          const size=JSON.stringify(candidate).length;
          if (size<=pageBudget) {parts.push(candidate);pageBudget-=size;} else skipped++;
        }
      }
      return {parts,omitted:skipped};
    };
  `;
}

export function boundRichParts(rawParts, { chars = 0, completeText = false, maxChars = 16000 } = {}) {
  if (!Array.isArray(rawParts)) return null;
  const permitted = new Set(RICH_PART_KINDS);
  const parts = [];
  let budget = Math.min(RICH_PARTS_MAX_CHARS, Number.isSafeInteger(maxChars) && maxChars >= 0 ? maxChars : 0);
  if (completeText) for (const part of rawParts.slice(0,RICH_PARTS_MAX)) {
    if (!part || typeof part !== 'object' || !permitted.has(part.type)) continue;
    let serialized;
    try { serialized = JSON.stringify(part); } catch { continue; }
    if (!serialized || serialized.length > 16384 || serialized.length > budget) continue;
    budget -= serialized.length;
    // JSON clone is a data-only boundary: page prototypes are never returned to the caller.
    parts.push(JSON.parse(serialized));
  }
  return { parts, excludedForTruncatedText: !completeText,
    omitted: rawParts.length - parts.length, source: 'page-visible-dom', complete: false };
}
