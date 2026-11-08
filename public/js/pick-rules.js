
export const PICK_PREFIX = '#pick=';
const CAP = { url: 2000, title: 200, selector: 600, text: 400, html: 1500, source: 400, comp: 80, comps: 10 };

/* Runs inside the person's page, from the bookmark: self-contained (it is turned into text), no comments inside. */
export function picker(board, words) {
  if (window.__kbPick) { window.__kbPick(); return; }
  const d = document;
  const box = d.createElement('div');
  const bar = d.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #e8704e;background:rgba(232,112,78,.12);border-radius:3px;display:none;box-sizing:border-box';
  bar.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:10px;left:50%;transform:translateX(-50%);background:#262624;color:#f5f4ef;font:13px/1.4 -apple-system,system-ui,sans-serif;padding:7px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:90vw';
  bar.textContent = words.hint;
  d.documentElement.append(box, bar);
  const under = (e) => { const el = d.elementFromPoint(e.clientX, e.clientY); return el && el !== box && el !== bar ? el : null; };
  const move = (e) => {
    const el = under(e);
    if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const cssId = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const selector = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 7; e = e.parentElement) {
      if (e.id && d.querySelectorAll(`#${cssId(e.id)}`).length === 1) { parts.unshift(`#${cssId(e.id)}`); break; }
      const t = e.getAttribute('data-testid');
      if (t) { parts.unshift(`[data-testid="${t.replace(/"/g, '\\"')}"]`); break; }
      let s = e.localName;
      const p = e.parentElement;
      if (p) { const same = [...p.children].filter((c) => c.localName === e.localName); if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`; }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const info = (el) => {
    const comps = [];
    let source = null;
    const add = (n) => { if (n && typeof n === 'string' && comps[comps.length - 1] !== n && comps.length < 10) comps.push(n); };
    for (let e = el; e && e.nodeType === 1 && !source; e = e.parentElement) {
      const a = e.getAttribute('data-inspector-relative-path') || e.getAttribute('data-source-file');
      if (a) source = a + (e.getAttribute('data-inspector-line') ? `:${e.getAttribute('data-inspector-line')}` : '');
      const v = e.getAttribute('data-v-inspector') || e.getAttribute('data-source');
      if (!source && v) source = v;
    }
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    for (let f = fk ? el[fk] : null, i = 0; f && i < 200; f = f.return, i++) {
      const t = f.type;
      if (typeof t === 'function') add(t.displayName || t.name);
      else if (t && typeof t === 'object') add(t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)));
      if (!source && f._debugSource && f._debugSource.fileName) source = `${f._debugSource.fileName}:${f._debugSource.lineNumber || ''}`.replace(/:$/, '');
    }
    let vue = null;
    for (let e = el; e && !vue; e = e.parentElement) vue = e.__vueParentComponent || null;
    for (let c = vue, i = 0; c && i < 50; c = c.parent, i++) {
      const t = c.type || {};
      add(t.name || t.__name || (t.__file ? t.__file.split('/').pop().replace(/\.vue$/, '') : null));
      if (!source && t.__file) source = t.__file;
    }
    for (let e = el; e && !source; e = e.parentElement) {
      const m = e.__svelte_meta;
      if (m && m.loc && m.loc.file) source = `${m.loc.file}:${m.loc.line + 1}`;
    }
    const r = el.getBoundingClientRect();
    return {
      v: 1, url: location.href, title: d.title, selector: selector(el), components: comps, source,
      text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      html: String(el.outerHTML || '').slice(0, 1500), size: [Math.round(r.width), Math.round(r.height)], viewport: [innerWidth, innerHeight],
    };
  };
  const block = (e) => { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); };
  const stop = () => {
    removeEventListener('mousemove', move, true);
    ['pointerdown', 'mousedown', 'mouseup', 'pointerup'].forEach((t) => removeEventListener(t, block, true));
    removeEventListener('click', click, true);
    removeEventListener('keydown', key, true);
    box.remove(); bar.remove();
    delete window.__kbPick;
  };
  const key = (e) => { if (e.key === 'Escape') { block(e); stop(); } };
  const click = (e) => {
    block(e);
    const el = under(e);
    stop();
    if (el) window.open(`${board}/#pick=${encodeURIComponent(JSON.stringify(info(el)))}`, 'local-kanban');
  };
  addEventListener('mousemove', move, true);
  ['pointerdown', 'mousedown', 'mouseup', 'pointerup'].forEach((t) => addEventListener(t, block, true));
  addEventListener('click', click, true);
  addEventListener('keydown', key, true);
  window.__kbPick = stop;
}

/** The bookmark: `javascript:` with the picker, the board's address and the hint in the person's language. */
export function bookmarklet(board, hint) {
  return `javascript:${encodeURIComponent(`(${picker.toString()})(${JSON.stringify(String(board))},${JSON.stringify({ hint: String(hint) })})`)};void 0`;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The element in the board's hash, read and cut to size — or null. Anything may be there: any site can open the board. */
export function readPick(hash) {
  const h = String(hash || '');
  if (!h.startsWith(PICK_PREFIX)) return null;
  let raw;
  try { raw = JSON.parse(decodeURIComponent(h.slice(PICK_PREFIX.length))); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const url = str(raw.url, CAP.url);
  let page = null;
  try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) page = u.href; } catch { /* not an address */ }
  const selector = str(raw.selector, CAP.selector);
  if (!page || !selector) return null;
  const nums = (a) => (Array.isArray(a) && a.length === 2 && a.every((n) => Number.isFinite(n) && n >= 0 && n < 1e6) ? a.map(Math.round) : null);
  return {
    url: page, title: str(raw.title, CAP.title), selector,
    components: (Array.isArray(raw.components) ? raw.components : []).filter((c) => typeof c === 'string' && c).slice(0, CAP.comps).map((c) => c.slice(0, CAP.comp)),
    source: str(raw.source, CAP.source) || null, text: str(raw.text, CAP.text), html: str(raw.html, CAP.html),
    size: nums(raw.size), viewport: nums(raw.viewport),
  };
}

const oneLine = (s, max) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

/** The words for the task's Claude: where the element is, what it is, and what the person said about it. */
export function pickMessage(key, pick, words, tr) {
  const lines = [tr('{key}: an element on the page {url}').replace('{key}', key).replace('{url}', pick.url)];
  lines.push(`- ${tr('selector')}: ${code(pick.selector)}`);
  if (pick.components.length) lines.push(`- ${tr('components')}: ${pick.components.join(' ← ')}`);
  if (pick.source) lines.push(`- ${tr('source')}: ${pick.source}`);
  if (pick.text) lines.push(`- ${tr('text')}: «${oneLine(pick.text, 200)}»`);
  if (pick.html) lines.push(`- HTML: ${code(oneLine(pick.html, 300))}`);
  if (pick.viewport) lines.push(`- ${tr('window')}: ${pick.viewport.join('×')}${pick.size ? `, ${tr('element')} ${pick.size.join('×')}` : ''}`);
  const w = String(words || '').trim();
  lines.push('', w || tr('Look at this element and tell me what you would change.'));
  return lines.join('\n');
}
