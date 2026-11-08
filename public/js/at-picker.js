import { api, esc, seg, state, tr } from './core.js';
import { pushLayer, popLayer } from './sidebar.js';
import { DEFAULT_TEMPLATES, atQuery, fileMention, insertAt, matchTemplates } from './at-rules.js';

const WAIT_MS = 120;
let open = null; // {field, box, items, pick, start, caret}

function close() {
  if (!open) return;
  open.box.remove();
  open = null;
  popLayer('at-picker');
}
function place(field, box) {
  const r = field.getBoundingClientRect();
  const w = Math.max(240, Math.min(r.width, 420));
  const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
  box.style.width = `${w}px`;
  box.style.left = `${left}px`;
  const below = innerHeight - r.bottom;
  if (below >= 180 || below >= r.top) { box.style.top = `${r.bottom + 4}px`; box.style.bottom = ''; } else { box.style.bottom = `${innerHeight - r.top + 4}px`; box.style.top = ''; }
}
function paint() {
  const o = open;
  o.box.innerHTML = o.items.map((it, i) => `<div class="at-item${i === o.pick ? ' on' : ''}" data-i="${i}" role="option" aria-selected="${i === o.pick}">`
    + `<span class="at-label">${esc(it.label)}</span>${it.hint ? `<span class="at-hint">${esc(it.hint)}</span>` : ''}</div>`).join('')
    || `<div class="at-none">${esc(tr('Nothing by these letters'))}</div>`;
  o.box.querySelector('.at-item.on')?.scrollIntoView({ block: 'nearest' });
}
function choose(i) {
  const o = open;
  const it = o?.items[i];
  if (!it) return;
  const { field, start, caret } = o;
  close();
  const r = insertAt(field.value, start, caret, it.insert);
  field.value = r.value;
  field.focus();
  field.setSelectionRange(r.caret, r.caret);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** «@» on `field`: `items(query)` → [{label, hint?, insert}] (may be async). Returns `detach`. */
export function attachAtPicker(field, items) {
  let timer = null;
  let seq = 0;
  const look = () => {
    clearTimeout(timer);
    const caret = field.selectionStart;
    const at = field.selectionEnd === caret ? atQuery(field.value, caret) : null;
    if (!at) { if (open?.field === field) close(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      let list = [];
      try { list = await items(at.query); } catch { list = []; }
      if (my !== seq || document.activeElement !== field) return; // typed on, or left the field
      if (!open || open.field !== field) {
        close();
        const box = document.createElement('div');
        box.className = 'at-picker';
        box.setAttribute('role', 'listbox');
        box.addEventListener('mousedown', (e) => e.preventDefault()); // the field keeps the caret
        box.addEventListener('click', (e) => { const el = e.target.closest('.at-item'); if (el) choose(Number(el.dataset.i)); });
        document.body.append(box);
        open = { field, box, items: [], pick: 0 };
        pushLayer('at-picker', close);
      }
      Object.assign(open, { items: list, pick: 0, start: at.start, caret });
      place(field, open.box);
      paint();
    }, WAIT_MS);
  };
  const keys = (e) => {
    if (!open || open.field !== field || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open.items.length) return;
      open.pick = (open.pick + (e.key === 'ArrowDown' ? 1 : -1) + open.items.length) % open.items.length;
      paint();
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      if (!open.items.length) { close(); return; }
      choose(open.pick);
    } else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const blur = () => setTimeout(() => { if (open?.field === field && document.activeElement !== field) close(); }, 150);
  field.addEventListener('input', look);
  field.addEventListener('keydown', keys, true);
  field.addEventListener('click', look);
  field.addEventListener('blur', blur);
  return () => {
    field.removeEventListener('input', look); field.removeEventListener('keydown', keys, true);
    field.removeEventListener('click', look); field.removeEventListener('blur', blur);
    if (open?.field === field) close();
  };
}

const TPL_FRESH_MS = 30_000;
let tpl = { at: 0, list: null };
export const forgetTemplates = () => { tpl = { at: 0, list: null }; };
export async function templateList() {
  if (Date.now() - tpl.at > TPL_FRESH_MS) {
    try { tpl = { at: Date.now(), list: (await api('GET', '/api/templates', undefined, { quiet: true })).templates }; } catch { tpl.at = Date.now(); }
  }
  // the dictionary key of a name is «@name»: a bare «bug» would translate any other «bug» of the page
  return tpl.list || DEFAULT_TEMPLATES.map((t) => ({ name: tr(`@${t.name}`).slice(1), text: tr(t.text) }));
}
const firstLine = (s) => String(s).split('\n').find((l) => l.trim()) || '';
/** What «@» offers in a description: templates. */
export async function templateItems(q) {
  return matchTemplates(await templateList(), q).map((t) => ({ label: `@${t.name}`, hint: firstLine(t.text), insert: t.text }));
}
export async function chatItems(key, q) {
  const tpls = await templateItems(q);
  const p = state.projects.find((x) => x.prefix && String(key).toUpperCase().startsWith(`${x.prefix.toUpperCase()}-`));
  if (!p) return tpls;
  let files = [];
  try { files = (await api('GET', `/api/projects/${seg(p.slug)}/files?q=${encodeURIComponent(q)}`, undefined, { quiet: true })).files || []; } catch { files = []; }
  const name = (f) => f.slice(f.lastIndexOf('/') + 1);
  return [...tpls, ...files.map((f) => ({ label: name(f), hint: f, insert: fileMention(f) }))];
}
