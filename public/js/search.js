
import { api, esc, ic, state, tr } from './core.js';
import { openDrawer } from './drawer.js';
import { STATUS_LABELS } from './sse.js';
import { overlayLayer, selectProject } from './sidebar.js';

const DELAY_MS = 200;     // a pause in typing before the server is asked
const PROJECTS_MAX = 6;
const TASKS_MAX = 40;
const SEARCH_LIMIT = 200;
const CLOSED = new Set(['done', 'cancelled']);
// server is asked from two
export const MIN_TASK_QUERY = 2;

/** The projects whose name, key (prefix) or slug hold the words — the ones starting with them first. */
export function findProjects(projects, q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const hay = (p) => [p.name, p.prefix, p.slug].filter(Boolean).map((x) => String(x).toLowerCase());
  return projects.filter((p) => !p.archived && hay(p).some((h) => h.includes(s)))
    .sort((a, b) => (hay(b).some((h) => h.startsWith(s)) - hay(a).some((h) => h.startsWith(s))) || String(a.name || a.slug).localeCompare(String(b.name || b.slug)))
    .slice(0, PROJECTS_MAX);
}

/** The tasks found, open ones first, then the most recently changed; at most TASKS_MAX. */
export function orderTasks(tasks) {
  return [...tasks].sort((a, b) => (CLOSED.has(a.status) - CLOSED.has(b.status)) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || (b.id - a.id))
    .slice(0, TASKS_MAX);
}

let open = null; // the open window: {close, input, list, seq, items, at}

export function openSearch() {
  if (open) { open.input.focus(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay search-overlay';
  overlay.innerHTML = `<div class="modal search-modal" role="dialog" aria-label="${esc(tr('Search projects and tasks'))}">
      <div class="search-field">${ic('search', 15)}<input type="text" class="search-input" autocomplete="off" spellcheck="false" placeholder="${esc(tr('Search projects and tasks…'))}"></div>
      <div class="search-results"><div class="search-hint">${esc(tr('Type a word: a project by its name, a task by its key, title, description or label — in every project.'))}</div></div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('.search-input');
  const list = overlay.querySelector('.search-results');
  // pick (Esc, a click past it); a pick opens a task or a board, and the caret belongs there
  const back = document.activeElement;
  const typing = back && back !== document.body && (/^(INPUT|TEXTAREA)$/.test(back.tagName) || back.isContentEditable) ? back : null;
  open = { input, list, seq: 0, items: [], at: -1, timer: null, back: typing };
  open.close = overlayLayer(overlay, {
    onClose: () => {
      const to = open?.back;
      clearTimeout(open?.timer); open?.req?.abort(); open = null;
      if (to?.isConnected && to.getClientRects().length) to.focus({ preventScroll: true });
    },
  });
  input.addEventListener('input', () => {
    clearTimeout(open.timer);
    const q = input.value;
    const short = q.trim().length < MIN_TASK_QUERY;
    open.seq++; // an answer to an earlier word is not drawn any more
    open.req?.abort(); // nor asked for any longer
    paint(q, findProjects(state.projects || [], q), short ? 'short' : null); // projects at once; tasks once the typing pauses
    if (!short) open.timer = setTimeout(() => ask(q), DELAY_MS);
  });
  input.addEventListener('keydown', onKey);
  input.focus();
}

async function ask(q) {
  if (!open) return;
  const seq = ++open.seq;
  // one word typed), and the board kept answering words nobody looked at any more
  open.req?.abort();
  const req = new AbortController();
  open.req = req;
  let tasks;
  try {
    tasks = await api('GET', `/api/tasks?all=1&limit=${SEARCH_LIMIT}&q=${encodeURIComponent(q.trim())}`, undefined, { quiet: true, signal: req.signal });
  } catch (e) {
    if (e?.aborted) return;
    if (open && seq === open.seq && open.input.value === q) paint(q, findProjects(state.projects || [], q), 'error');
    return;
  }
  if (!open || seq !== open.seq || open.input.value !== q) return; // a newer word is on its way
  paint(q, findProjects(state.projects || [], q), orderTasks(Array.isArray(tasks) ? tasks : []));
}

function projectName(slug) {
  const p = (state.projects || []).find((x) => x.slug === slug);
  return p ? (p.name || p.slug) : slug;
}

/** Draw what is found. `tasks` — null while the server is asked, 'error' when it did not answer, 'short' — one letter. */
function paint(q, projects, tasks) {
  if (!open) return;
  const { list } = open;
  if (!q.trim()) {
    list.innerHTML = `<div class="search-hint">${esc(tr('Type a word: a project by its name, a task by its key, title, description or label — in every project.'))}</div>`;
    open.items = []; open.at = -1;
    return;
  }
  const items = [];
  let html = '';
  if (projects.length) {
    html += `<div class="search-h">${esc(tr('Projects'))}</div>`;
    for (const p of projects) {
      items.push({ kind: 'project', slug: p.slug });
      html += `<button type="button" class="search-row" data-i="${items.length - 1}">${ic('grid', 13)}<span class="search-title">${esc(p.name || p.slug)}</span><span class="search-meta">${esc(p.prefix || '')}</span></button>`;
    }
  }
  html += `<div class="search-h">${esc(tr('Tasks'))}</div>`;
  if (tasks === null) html += `<div class="search-hint">${esc(tr('searching…'))}</div>`;
  else if (tasks === 'short') html += `<div class="search-hint">${esc(tr('Tasks are searched from two letters'))}</div>`;
  else if (tasks === 'error') html += `<div class="search-hint">${esc(tr('The board did not answer — try again'))}</div>`;
  else if (!tasks.length) html += `<div class="search-hint">${esc(tr('No tasks found'))}</div>`;
  else {
    for (const t of tasks) {
      items.push({ kind: 'task', key: t.key, slug: t.project });
      const title = (t.title || '').trim() || (t.preview || '').trim().split('\n')[0];
      html += `<button type="button" class="search-row${CLOSED.has(t.status) ? ' closed' : ''}" data-i="${items.length - 1}" title="${esc(STATUS_LABELS[t.status] || t.status)}">`
        + `<span class="dot s-${esc(t.status)}"></span><span class="search-key">${esc(t.key)}</span>`
        + `<span class="search-title">${title ? esc(title) : `<span class="row-untitled">${tr('untitled')}</span>`}</span>`
        + `<span class="search-meta">${esc(projectName(t.project))}</span></button>`;
    }
  }
  list.innerHTML = html;
  open.items = items;
  open.at = items.length ? 0 : -1;
  list.querySelectorAll('.search-row').forEach((b) => {
    b.onclick = () => choose(Number(b.dataset.i));
    b.onmousemove = () => mark(Number(b.dataset.i));
  });
  mark(open.at);
}

function mark(i) {
  if (!open) return;
  open.at = i;
  open.list.querySelectorAll('.search-row').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i));
}

function onKey(e) {
  if (!open) return;
  const n = open.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!n) return;
    mark((open.at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    open.list.querySelector('.search-row.on')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open.at >= 0) choose(open.at);
  }
}

function choose(i) {
  const item = open?.items[i];
  if (!item) return;
  open.back = null;
  open.close();
  if (item.kind === 'project') { selectProject(item.slug); return; }
  if (item.slug && state.slug !== item.slug) selectProject(item.slug);
  openDrawer(item.key);
}
