
import { $, esc, state, tr } from './core.js';
import { pendingAsks } from './asks.js';
import { openDrawer } from './drawer.js';
import { overlayLayer, selectProject } from './sidebar.js';

let termQuestions = []; // [{id, key, project, title}] — the board's terminals with a question open on the screen

/** The board's terminals that ask a question now (task.live, GET /api/live). */
export function setTerminalQuestions(list) {
  termQuestions = Array.isArray(list) ? list : [];
  paintAttention();
}

const ORDER = { ask: 0, question: 1, waiting: 2, limit: 3, idle: 4 };
const WAITS = new Set(['waiting', 'idle', 'limit']);

/** The tasks that wait for the person now: [{id, key, project, title, why, since, resets, background}], `why` — ask,
    question, waiting, idle or limit. One row a task: the most pressing reason wins. */
export function waitingNow() {
  const live = state.live || {};
  const titleOf = (id) => live[id]?.title ?? termQuestions.find((q) => String(q.id) === String(id))?.title
    ?? state.tasks.find((t) => String(t.id) === String(id))?.title ?? '';
  const out = new Map();
  const put = (item) => {
    const k = String(item.id);
    if (!out.has(k) || ORDER[item.why] < ORDER[out.get(k).why]) out.set(k, item);
  };
  for (const a of pendingAsks()) put({ id: a.task_id, key: a.key, project: a.project, title: titleOf(a.task_id), why: 'ask', since: Date.parse(a.created_at) || null });
  for (const q of termQuestions) put({ id: q.id, key: q.key, project: q.project, title: q.title || titleOf(q.id), why: 'question', since: null });
  for (const [id, l] of Object.entries(live)) {
    if (!WAITS.has(l.claude) || !l.key) continue;
    if (l.broke === 'retrying') continue;
    put({ id: Number(id), key: l.key, project: l.project, title: l.title || '', why: l.claude, since: l.since ?? null, resets: l.resets ?? null, background: Boolean(l.background), broke: l.broke === 'stuck' });
  }
  return [...out.values()].sort((a, b) => (ORDER[a.why] - ORDER[b.why]) || ((a.since || 0) - (b.since || 0)) || (a.id - b.id));
}

function waited(since) {
  if (!since) return '';
  const mins = Math.max(1, Math.round((Date.now() - since) / 60000));
  return mins < 60 ? `${mins} ${tr('min')}` : `${Math.floor(mins / 60)} ${tr('h')}`;
}

/** Why the task waits, in the words of the board. */
export function whyText(item) {
  if (item.why === 'ask') return tr('needs your answer');
  if (item.why === 'question') return tr('asks a question in the terminal');
  if (item.why === 'limit') return `${tr('limit reached')}${item.resets ? ` · ${tr('until')} ${item.resets}` : ''}`;
  const w = waited(item.since);
  if (item.broke) return `${tr('answer broke off')}${w ? ` · ${w}` : ''}`;
  return `${tr('waiting for you')}${w ? ` · ${w}` : ''}${item.background ? ` · ${tr('commands in the background')}` : ''}`;
}

function openTask(item) {
  if (item.project && state.slug !== item.project) selectProject(item.project);
  openDrawer(item.key);
}

/* ── the block on top of the sidebar and its list ─────────────────────────────── */
let listClose = null;

/** Draw the block (hidden when nothing waits) and the open list. */
export function paintAttention() {
  const items = waitingNow();
  const el = $('attn');
  if (el) {
    el.classList.toggle('hidden', !items.length);
    if (items.length) {
      el.innerHTML = `<span class="attn-dot"></span><span class="attn-name">${esc(tr('Claude is waiting for you'))}</span><span class="attn-n">${items.length}</span>`;
      el.title = items.map((i) => `${i.key} · ${whyText(i)}`).join('\n');
    }
  }
  if (listClose) {
    if (!items.length) listClose();
    else renderList(items);
  }
}

function rowHTML(item) {
  const title = (item.title || '').trim();
  return `<button type="button" class="attn-row" data-id="${esc(String(item.id))}">
      <span class="attn-row-head"><span class="attn-key">${esc(item.key)}</span><span class="attn-why attn-${esc(item.why)}">${esc(whyText(item))}</span></span>
      <span class="attn-title">${title ? esc(title) : `<span class="row-untitled">${tr('untitled')}</span>`}</span>
    </button>`;
}

function renderList(items) {
  const box = document.querySelector('#attn-list .attn-rows');
  if (!box) return;
  const focused = box.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  box.innerHTML = items.map(rowHTML).join('');
  box.querySelectorAll('.attn-row').forEach((b) => {
    b.onclick = () => {
      const item = items.find((i) => String(i.id) === b.dataset.id);
      listClose?.();
      if (item) openTask(item);
    };
    if (focused && b.dataset.id === focused) b.focus();
  });
}

/** The list of what waits — from the block on top of the sidebar. */
export function openAttentionList() {
  const items = waitingNow();
  if (!items.length || listClose) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay attn-overlay';
  overlay.id = 'attn-list';
  overlay.innerHTML = `<div class="modal attn-modal" role="dialog" aria-label="${esc(tr('Claude is waiting for you'))}">
      <div class="modal-title">${esc(tr('Claude is waiting for you'))}</div>
      <div class="attn-rows"></div>
    </div>`;
  const r = $('attn').getBoundingClientRect();
  overlay.querySelector('.attn-modal').style.top = `${Math.round(r.bottom + 6)}px`;
  overlay.querySelector('.attn-modal').style.left = `${Math.round(Math.max(8, r.left))}px`;
  document.body.appendChild(overlay);
  listClose = overlayLayer(overlay, { onClose: () => { listClose = null; } });
  renderList(items);
  overlay.querySelector('.attn-row')?.focus();
}
