import { api, esc, seg, state, tr } from './core.js';
import { pushLayer, popLayer } from './sidebar.js';
import { DEFAULT_TEMPLATES, atQuery, fileMention, insertAt, matchTemplates } from './at-rules.js';

const WAIT_MS = 120;
let open = null; // {field, box, items, pick, query, start, moved}

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
/** The «@word» the caret of `field` stands after now, or null (a selection is not a caret). */
const atOf = (field) => (field.selectionEnd === field.selectionStart ? atQuery(field.value, field.selectionStart) : null);
function choose(i) {
  const o = open;
  const it = o?.items[i];
  if (!it) return;
  const { field } = o;
  close();
  const at = atOf(field);
  if (!at) return;
  const r = insertAt(field.value, at.start, field.selectionStart, it.insert);
  field.value = r.value;
  field.focus();
  field.setSelectionRange(r.caret, r.caret);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** «@» on `field`: `items(query)` → [{label, hint?, insert}] (may be async). Returns `detach`. */
export function attachAtPicker(field, items) {
  let timer = null;
  let seq = 0;
  let picking = false;
  // the list of `query`, or null when a later search took over meanwhile
  const search = async (query) => {
    const my = ++seq;
    let list = [];
    try { list = await items(query); } catch { list = []; }
    return my === seq ? list : null;
  };
  const show = (at, list, keep = null) => {
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
    const kept = keep ? list.findIndex((it) => it.label === keep) : -1;
    Object.assign(open, { items: list, pick: Math.max(0, kept), query: at.query, start: at.start, moved: kept >= 0 });
    place(field, open.box);
    paint();
  };
  const look = () => {
    clearTimeout(timer);
    timer = null;
    const at = atOf(field);
    if (!at) { if (open?.field === field) close(); return; }
    timer = setTimeout(async () => {
      timer = null;
      const list = await search(at.query);
      if (!list || document.activeElement !== field) return; // typed on, or left the field
      show(at, list);
    }, WAIT_MS);
  };
  // the open list was made for the letters the field has now
  const fresh = (at) => Boolean(open && open.field === field && timer === null && open.query === at.query && open.start === at.start);
  const pickFresh = async () => {
    picking = true;
    try {
      for (let n = 0; n < 5; n += 1) {
        const at = atOf(field);
        if (!open || open.field !== field) return;
        if (!at) { close(); return; }
        if (fresh(at)) { if (open.items.length) choose(open.pick); else close(); return; }
        clearTimeout(timer);
        timer = null;
        const keep = open.moved ? open.items[open.pick]?.label : null;
        const list = await search(at.query);
        if (list && open?.field === field) show(at, list, keep);
      }
    } finally { picking = false; }
  };
  const keys = (e) => {
    if (!open || open.field !== field || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open.items.length) return;
      open.pick = (open.pick + (e.key === 'ArrowDown' ? 1 : -1) + open.items.length) % open.items.length;
      open.moved = true;
      paint();
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      const at = atOf(field);
      if (!at) { close(); return; }
      if (!picking && fresh(at) && !open.items.length) { close(); return; } // nothing by these letters: the key is the field's
      if (!picking) pickFresh();
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
    clearTimeout(timer);
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
