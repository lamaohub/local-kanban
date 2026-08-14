
import { $, ALL, ALL_STATUSES, DONE_LIMIT, LABEL_COLORS, LABEL_SELECTABLE, PRI_ICON, PRI_LEVELS, api, esc, ic, seg, state, tr } from './core.js';
import { markKbCursor, openCardMenu, openDrawer, openDrawerNew, setKbCursor, statusOptionList } from './drawer.js';
import { getSetting, plural } from './settings.js';
import { styledConfirm } from './sidebar.js';
import { copyBacklogPrompt, copyTodoPrompt, refresh } from './sse.js';

function matchesSearch(t) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q)
    || (t.preview || '').toLowerCase().includes(q) || t.labels.some((l) => l.includes(q));
}

let prevCardIds = new Set();
let prevRenderSlug = null;
export let scrollToNewCardId = null;
export function setScrollToNewCardId(id) { scrollToNewCardId = id; }
function ensureCardFxLayer() {
  let l = document.getElementById('card-fx');
  if (!l) { l = document.createElement('div'); l.id = 'card-fx'; document.body.appendChild(l); }
  return l;
}

export function renderBoard() {
  const board = $('board');
  const animate = prevCardIds.size > 0 && prevRenderSlug === state.slug;
  const oldCards = new Map();
  if (animate) board.querySelectorAll('.card').forEach((c) => oldCards.set(Number(c.dataset.id), { rect: c.getBoundingClientRect(), node: c }));
  const sameBoard = prevRenderSlug === state.slug;
  const scrollByStatus = new Map();
  board.querySelectorAll('.col-body').forEach((b) => { if (b.dataset.status) scrollByStatus.set(b.dataset.status, b.scrollTop); });
  const boardScrollLeft = board.scrollLeft;
  board.innerHTML = '';
  const labels = Object.fromEntries(ALL_STATUSES);
  const columns = ALL_STATUSES.map(([k]) => k)
    .filter((k) => k !== 'cancelled' || state.tasks.some((t) => t.status === 'cancelled'));
  for (const key of columns) {
    let tasks = state.tasks
      .filter((t) => t.status === key && matchesSearch(t))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.priority - a.priority || a.position - b.position || a.id - b.id);
    if (key === 'done' || key === 'cancelled') {
      tasks = tasks.sort((a, b) => b.id - a.id).slice(0, DONE_LIMIT)
        .sort((a, b) => b.priority - a.priority || b.id - a.id);
    }

    const col = document.createElement('div');
    col.className = 'col';
    const head = document.createElement('div');
    head.className = 'col-head';
    head.innerHTML = `<span class="dot s-${key}"></span>${labels[key]} <span class="n">${tasks.length}</span>`;
    if (CREATABLE.has(key)) {
      const add = document.createElement('button');
      add.className = 'btn-icon col-add';
      add.textContent = '+';
      add.title = `${tr('New task in')} «${labels[key]}»`;
      add.onclick = () => openDrawerNew(key);
      head.appendChild(add);
    }
    if (key === 'todo' && tasks.length) {
      const copy = document.createElement('button');
      copy.className = 'btn-icon col-copy';
      copy.innerHTML = ic('copy', 13);
      copy.title = tr('Copy the tasks as a job for Claude');
      copy.onclick = (e) => { e.stopPropagation(); copyTodoPrompt(tasks, copy); };
      head.appendChild(copy);
    }
    if (key === 'backlog' && tasks.length) {
      const copy = document.createElement('button');
      copy.className = 'btn-icon col-copy';
      copy.innerHTML = ic('copy', 13);
      copy.title = tr('Copy the backlog as a grooming job for Claude');
      copy.onclick = (e) => { e.stopPropagation(); copyBacklogPrompt(tasks, copy); };
      head.appendChild(copy);
    }
    col.appendChild(head);

    const body = document.createElement('div');
    body.className = 'col-body';
    body.dataset.status = key;
    body.ondragover = (e) => {
      const dt = dragId != null ? state.tasks.find((x) => x.id === dragId) : null;
      if (WORKING.has(key) && (!dt || !taskIsNoclaude(dt))) return;
      const group = dragGroupIds && dragGroupIds.length > 1;
      if (!group && dt && moveBlocked(dt.status, key, { manual: taskIsNoclaude(dt) })) return;
      e.preventDefault();
      body.classList.add('dragover');
      if (dragId == null) return;
      const after = dragAfterCard(body, e.clientY, dragId);
      if (dropPh.parentNode !== body || dropPh.nextSibling !== after) body.insertBefore(dropPh, after);
    };
    body.ondragleave = (e) => { if (!body.contains(e.relatedTarget)) body.classList.remove('dragover'); };
    body.ondrop = (e) => onDrop(e, key, body);
    for (const t of tasks) body.appendChild(cardEl(t));
    if (CREATABLE.has(key)) {
      const ghost = document.createElement('div');
      ghost.className = 'col-add-ghost';
      ghost.textContent = tr('+ add task');
      ghost.title = `${tr('New task in')} «${labels[key]}»`;
      ghost.onclick = () => openDrawerNew(key);
      body.appendChild(ghost);
    }
    col.appendChild(body);
    board.appendChild(col);
  }
  board.insertAdjacentHTML('beforeend', '<div class="board-spacer"></div>');

  const newIds = new Set([...board.querySelectorAll('.card')].map((c) => Number(c.dataset.id)));
  if (animate) {
    board.querySelectorAll('.card').forEach((c) => { if (!prevCardIds.has(Number(c.dataset.id))) c.classList.add('card-enter'); });
    oldCards.forEach((info, id) => {
      if (newIds.has(id)) return;
      const clone = info.node.cloneNode(true);
      clone.className = 'card card-exit';
      Object.assign(clone.style, { position: 'fixed', left: `${info.rect.left}px`, top: `${info.rect.top}px`, width: `${info.rect.width}px`, margin: '0' });
      ensureCardFxLayer().appendChild(clone);
      setTimeout(() => clone.remove(), 260);
    });
  }
  prevCardIds = newIds;
  prevRenderSlug = state.slug;

  if (sameBoard) {
    board.scrollLeft = boardScrollLeft;
    board.querySelectorAll('.col-body').forEach((b) => {
      const s = scrollByStatus.get(b.dataset.status);
      if (s) b.scrollTop = s;
    });
  }

  scheduleDrawLinks();
  markKbCursor();
  markSelection();
  if (scrollToNewCardId != null) {
    $('board').querySelector(`.card[data-id="${scrollToNewCardId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

let marqueeEl = null;
let marqueeStart = null;
let marqueeLast = null;
let marqueeTimer = null;
let marqueeScrollPos = null;
function marqueeTrackScroll(el) {
  if (!marqueeScrollPos || !marqueeStart) return;
  const rec = marqueeScrollPos.get(el);
  if (!rec) { marqueeScrollPos.set(el, { top: el.scrollTop, left: el.scrollLeft }); return; }
  marqueeStart.y -= el.scrollTop - rec.top;
  marqueeStart.x -= el.scrollLeft - rec.left;
  rec.top = el.scrollTop;
  rec.left = el.scrollLeft;
  marqueeApply();
}
function marqueeApply() {
  if (!marqueeStart || !marqueeLast) return;
  const cx = marqueeLast.x;
  const cy = marqueeLast.y;
  const dx = cx - marqueeStart.x;
  const dy = cy - marqueeStart.y;
  if (!marqueeEl) {
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee';
    document.body.appendChild(marqueeEl);
  }
  const x = Math.min(cx, marqueeStart.x);
  const y = Math.min(cy, marqueeStart.y);
  const w = Math.abs(dx);
  const h = Math.abs(dy);
  Object.assign(marqueeEl.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  selectedIds.clear();
  document.querySelectorAll('#board .card').forEach((c) => {
    const r = c.getBoundingClientRect();
    const hit = !(r.right < x || r.left > x + w || r.bottom < y || r.top > y + h);
    c.classList.toggle('multi-selected', hit);
    if (hit) selectedIds.add(Number(c.dataset.id));
  });
}
function marqueeMove(e) {
  if (!marqueeStart) return;
  marqueeLast = { x: e.clientX, y: e.clientY };
  marqueeApply();
}
function marqueeAutoScroll() {
  if (!marqueeEl || !marqueeLast) return;
  const EDGE = 48;
  const MAX = 28;
  const speed = (over) => Math.min(MAX, over / 2 + 3);
  const { x, y } = marqueeLast;
  const colBody = [...document.querySelectorAll('#board .col-body')]
    .find((b) => { const r = b.getBoundingClientRect(); return x >= r.left && x <= r.right; });
  if (colBody) {
    const r = colBody.getBoundingClientRect();
    const dy = y > r.bottom - EDGE ? speed(y - (r.bottom - EDGE))
      : y < r.top + EDGE ? -speed((r.top + EDGE) - y) : 0;
    if (dy) { colBody.scrollTop += dy; marqueeTrackScroll(colBody); }
  }
  const board = $('board');
  const br = board.getBoundingClientRect();
  const dxs = x > br.right - EDGE ? speed(x - (br.right - EDGE))
    : x < br.left + EDGE ? -speed((br.left + EDGE) - x) : 0;
  if (dxs) { board.scrollLeft += dxs; marqueeTrackScroll(board); }
}
function marqueeOnScroll(e) {
  const el = e.target;
  if (!(el instanceof Element)) return;
  if (el.id === 'board' || el.classList.contains('col-body')) marqueeTrackScroll(el);
}
function marqueeUp() {
  if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
  marqueeStart = null;
  marqueeLast = null;
  marqueeScrollPos = null;
  clearInterval(marqueeTimer);
  marqueeTimer = null;
  document.removeEventListener('mousemove', marqueeMove);
  document.removeEventListener('mouseup', marqueeUp);
  document.removeEventListener('scroll', marqueeOnScroll, true);
  updateMultiPanel();
}
export function initMarquee() {
  $('board').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.card, button, a, input, textarea, .kbsel')) return;
    clearSelection();
    marqueeStart = { x: e.clientX, y: e.clientY };
    marqueeLast = { x: e.clientX, y: e.clientY };
    const board = $('board');
    marqueeScrollPos = new Map([[board, { top: board.scrollTop, left: board.scrollLeft }]]);
    board.querySelectorAll('.col-body').forEach((b) => marqueeScrollPos.set(b, { top: b.scrollTop, left: b.scrollLeft }));
    if (!marqueeTimer) marqueeTimer = setInterval(marqueeAutoScroll, 30);
    document.addEventListener('mousemove', marqueeMove);
    document.addEventListener('mouseup', marqueeUp);
    document.addEventListener('scroll', marqueeOnScroll, true);
  });
}

let linkRaf = null;
export function scheduleDrawLinks() {
  if (linkRaf) return;
  linkRaf = requestAnimationFrame(() => { linkRaf = null; drawLinks(); });
}

export function drawLinks() {
  const svg = $('link-lines');
  const board = $('board');
  if (!svg || !board) return;
  const br = board.getBoundingClientRect();
  const mr = board.parentElement.getBoundingClientRect();
  svg.style.left = `${br.left - mr.left}px`;
  svg.style.top = `${br.top - mr.top}px`;
  svg.style.width = `${br.width}px`;
  svg.style.height = `${br.height}px`;
  svg.setAttribute('viewBox', `0 0 ${br.width} ${br.height}`);

  const seen = new Set();
  const offScreen = {};
  const linesOn = getSetting('linkLines') !== false;
  let html = '';
  for (const t of state.tasks) {
    for (const other of (t.linked_ids || [])) {
      const pair = t.id < other ? `${t.id}.${other}` : `${other}.${t.id}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const elA = board.querySelector(`.card[data-id="${t.id}"]`);
      const elB = board.querySelector(`.card[data-id="${other}"]`);
      if (!linesOn || !elA || !elB) {
        if (elA) offScreen[t.id] = (offScreen[t.id] || 0) + 1;
        if (elB) offScreen[other] = (offScreen[other] || 0) + 1;
        continue;
      }
      const ra = elA.getBoundingClientRect();
      const rb = elB.getBoundingClientRect();
      const acx = (ra.left + ra.right) / 2 - br.left;
      const bcx = (rb.left + rb.right) / 2 - br.left;
      let ax, ay, bx, by, c1x, c1y, c2x, c2y;
      if (Math.abs(acx - bcx) < 70) {
        const aUp = ra.top < rb.top, up = aUp ? ra : rb, lo = aUp ? rb : ra;
        const edge = Math.min(up.left, lo.left) - br.left;
        ax = edge; ay = (up.top + up.bottom) / 2 - br.top;
        bx = edge; by = (lo.top + lo.bottom) / 2 - br.top;
        const bow = Math.max(12, Math.min(34, (by - ay) * 0.09));
        const mx = Math.max(2, edge - bow);
        c1x = mx; c1y = ay + (by - ay) * 0.25;
        c2x = mx; c2y = by - (by - ay) * 0.25;
      } else {
        ax = acx; ay = ra.bottom - br.top;
        bx = bcx; by = rb.bottom - br.top;
        const k = Math.max(22, Math.min(70, Math.abs(bx - ax) * 0.3));
        c1x = ax; c1y = ay + k; c2x = bx; c2y = by + k;
      }
      const d = `M ${ax} ${ay} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${bx} ${by}`;
      html += `<path class="link-line" d="${d}"/>`;
    }
  }
  svg.innerHTML = html;

  for (const el of board.querySelectorAll('.card-link')) {
    const card = el.closest('.card');
    const n = card ? (offScreen[Number(card.dataset.id)] || 0) : 0;
    if (n > 0) { el.classList.remove('hidden'); el.innerHTML = `${ic('link', 12)}${n > 1 ? ' ' + n : ''}`; }
    else el.classList.add('hidden');
  }
}

export function labelChip(name) {
  const color = LABEL_COLORS[name] || '#9CA3AF';
  return `<span class="lbl"><span class="lbl-dot" style="background:${color}"></span>${esc(name)}</span>`;
}

const DRAG_LOCKED = new Set(['prep', 'doing', 'deploy', 'done']);
export const WORKING = new Set(['prep', 'doing', 'deploy']);

export function taskIsNoclaude(t) { return Array.isArray(t?.labels) && t.labels.includes('noclaude'); }
const CREATABLE = new Set(['backlog', 'todo']);
const NO_DIRECT_FROM = new Set(['backlog', 'todo']);
const NO_DIRECT_TO = new Set(['review', 'done']);

export function moveBlocked(from, to, { manual = false, isNew = false } = {}) {
  if (isNew) return CREATABLE.has(to) ? null : tr('new tasks go to “Backlog” or “To do” only');
  if (WORKING.has(to) && to !== from && !manual) return tr('working columns are moved by Claude only');
  if (!manual && NO_DIRECT_FROM.has(from) && NO_DIRECT_TO.has(to)) return tr('it has to go through work first');
  return null;
}
export function canMoveTo(from, to, task) { return !moveBlocked(from, to, { manual: taskIsNoclaude(task) }); }

let dragId = null;
const dropPh = document.createElement('div');
dropPh.className = 'drop-ph';

export const selectedIds = new Set();
let dragGroupIds = null;
export function clearSelection() {
  selectedIds.clear();
  document.querySelectorAll('.card.multi-selected').forEach((c) => c.classList.remove('multi-selected'));
  updateMultiPanel();
}
function markSelection() {
  document.querySelectorAll('#board .card').forEach((c) =>
    c.classList.toggle('multi-selected', selectedIds.has(Number(c.dataset.id))));
  updateMultiPanel();
}

function selectedTaskList() {
  return [...selectedIds].map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean);
}
function multiActive() {
  return selectedIds.size >= 1;
}
function restoreDrawerId() {
  if (state.drawerKey) {
    const t = state.tasks.find((x) => x.key === state.drawerKey);
    const proj = state.projects.find((x) => x.slug === t?.project);
    $('drawer-id').textContent = t ? `${t.key} · ${proj?.name || t.project}` : state.drawerKey;
  } else $('drawer-id').textContent = '';
}
function updateMultiPanel() {
  const on = multiActive();
  const drawer = $('drawer');
  const was = drawer.classList.contains('is-multi');
  if (on) {
    drawer.classList.remove('hidden', 'is-empty');
    drawer.classList.add('is-multi');
    renderMultiPanel();
    if (!was) scheduleDrawLinks();
    return;
  }
  if (!was) return;
  drawer.classList.remove('is-multi');
  if (state.drawerKey) restoreDrawerId();
  else if (getSetting('keepDrawer')) { drawer.classList.add('is-empty'); $('drawer-id').textContent = ''; }
  else drawer.classList.add('hidden');
  scheduleDrawLinks();
}
function renderMultiPanel() {
  const tasks = selectedTaskList();
  const n = tasks.length;
  const word = plural(n, 'task', 'tasks');
  $('drawer-id').textContent = '';
  const box = $('drawer-multi');
  const tile = (act, glyph, label, extra = '') => `<button class="multi-tile${extra}" data-act="${act}"><span class="mt-ico">${glyph}</span><span class="mt-lab">${label}</span></button>`;
  box.innerHTML = `<div class="multi-head">${tr('Selected')}: <b>${n}</b> ${word}</div>`
    + '<div class="multi-grid">'
    + tile('status', ic('status', 15), tr('Status'))
    + tile('priority', ic('flag', 15), tr('Priority'))
    + tile('label', ic('tag', 15), tr('Label'))
    + tile('pin', ic('pin', 15), tr('Pin'))
    + (n >= 2 ? tile('link', ic('link', 15), tr('Link')) : '')
    + tile('dup', ic('duplicate', 15), tr('Duplicate'))
    + tile('del', ic('trash', 15), tr('Delete'), ' danger')
    + '</div>'
    + `<button class="multi-clear" data-act="clear">${tr('Clear selection')}</button>`;
  box.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => multiAction(b.dataset.act, b); });
}
async function multiPatchEach(bodyFor) {
  const tasks = selectedTaskList();
  for (const t of tasks) { try { await api('PATCH', `/api/tasks/${seg(t.key)}`, bodyFor(t), { quiet: true }); } catch {  } }
  await refresh();
}
function renderMultiSub(title, optsHTML, onPick) {
  const box = $('drawer-multi');
  box.innerHTML = `<div class="multi-head"><button class="multi-back" data-back="1">${tr('‹ Back')}</button>${esc(title)}</div><div class="multi-sub">${optsHTML}</div>`;
  box.querySelector('[data-back]').onclick = () => renderMultiPanel();
  box.querySelectorAll('.cm-opt').forEach((o) => { o.onclick = () => onPick(o); });
}
export async function multiAction(act, btn) {
  const tasks = selectedTaskList();
  if (!tasks.length) return;
  if (act === 'clear') { clearSelection(); return; }
  if (act === 'status') {
    const opts = ALL_STATUSES.map(([v, lab]) => {
      const dis = tasks.every((t) => moveBlocked(t.status, v, { manual: taskIsNoclaude(t) }));
      return `<div class="cm-opt${dis ? ' disabled' : ''}" data-v="${v}"><span class="dot s-${v}"></span>${lab}</div>`;
    }).join('');
    renderMultiSub(tr('Move to status'), opts, async (o) => {
      if (o.classList.contains('disabled')) return;
      await multiPatchEach(() => ({ status: o.dataset.v }));
      renderMultiPanel();
    });
    return;
  }
  if (act === 'priority') {
    const opts = PRI_LEVELS.map(([v, lab]) => `<div class="cm-opt" data-v="${v}">${lab}</div>`).join('');
    renderMultiSub(tr('Priority'), opts, async (o) => { await multiPatchEach(() => ({ priority: Number(o.dataset.v) })); renderMultiPanel(); });
    return;
  }
  if (act === 'label') {
    const opts = LABEL_SELECTABLE.map((name) =>
      `<div class="cm-opt lbl-row" data-name="${name}"><span class="lbl-dot" style="width:9px;height:9px;border-radius:50%;background:${LABEL_COLORS[name]}"></span>${esc(name)}</div>`).join('');
    renderMultiSub(tr('Add a label to all'), opts, async (o) => {
      const name = o.dataset.name;
      await multiPatchEach((t) => ({ labels: [...new Set([...(t.labels || []), name])] }));
      renderMultiPanel();
    });
    return;
  }
  if (act === 'pin') {
    const allPinned = tasks.every((t) => t.pinned);
    await multiPatchEach(() => ({ pinned: allPinned ? 0 : 1 }));
    renderMultiPanel();
    return;
  }
  if (act === 'link') {
    if (tasks.length < 2) return;
    const [head, ...rest] = tasks;
    for (const t of rest) { try { await api('POST', `/api/tasks/${seg(head.key)}/links`, { key: t.key, rel: 'related' }, { quiet: true }); } catch {  } }
    await refresh();
    renderMultiPanel();
    return;
  }
  if (act === 'dup') {
    for (const t of tasks) { try { await api('POST', `/api/tasks/${seg(t.key)}/duplicate`, undefined, { quiet: true }); } catch {  } }
    clearSelection();
    await refresh();
    return;
  }
  if (act === 'del') {
    if (!await styledConfirm(`${tr('Delete')} ${tasks.length} ${plural(tasks.length, 'task to delete', 'tasks')} ${tr('permanently?')}`, { okLabel: tr('Delete'), danger: true })) return;
    for (const t of tasks) { try { await api('DELETE', `/api/tasks/${seg(t.key)}`); } catch {  } }
    clearSelection();
    await refresh();
  }
}

function dragAfterCard(body, y, draggedId) {
  const cards = [...body.querySelectorAll('.card')].filter((c) => Number(c.dataset.id) !== draggedId);
  return cards.find((c) => y < c.getBoundingClientRect().top + c.offsetHeight / 2) || null;
}

export function fmtWork(sec) {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}${tr('h')} ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}${tr('m')}`;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function workTimer(t) {
  const running = !!t.work_started_at && WORKING.has(t.status);
  if (!t.work_seconds && !running) return '';
  const started = running ? new Date(t.work_started_at + 'Z').getTime() : 0;
  return `<span class="timer${running ? ' running' : ''}" data-base="${t.work_seconds}" data-started="${started}" title="${esc(tr('time spent'))}">${ic('timer', 12)} ${fmtWork(t.work_seconds + (running ? (Date.now() - started) / 1000 : 0))}</span>`;
}

const STALE_MS = 2 * 3600 * 1000;
function staleHours(t) {
  if (!WORKING.has(t.status)) return 0;
  const idle = Date.now() - new Date(t.updated_at + 'Z').getTime();
  return idle > STALE_MS ? Math.floor(idle / 3600000) : 0;
}

function cardEl(t) {
  const stale = staleHours(t);
  const el = document.createElement('div');
  el.className = 'card' + (WORKING.has(t.status) ? (stale ? ' stale' : ' working') : '')
    + (state.drawerKey === t.key ? ' selected' : '');
  el.draggable = taskIsNoclaude(t) || !DRAG_LOCKED.has(t.status);
  el.dataset.id = t.id;
  const pri = PRI_ICON[t.priority];
  const linkedKeys = (t.linked_ids || []).map((id) => state.tasks.find((x) => x.id === id)?.key).filter(Boolean);
  el.innerHTML = `
    ${t.pinned ? `<span class="card-pin" title="${esc(tr('needs attention'))}">${ic('pin', 12)}</span>` : ''}
    <div class="card-key">${t.key}${state.slug === ALL ? ` <span class="card-proj">· ${esc(t.project)}</span>` : ''}</div>
    ${t.title
      ? `<div class="card-title">${esc(t.title)}</div>`
      : (t.preview ? '' : `<div class="card-title card-title-empty">${tr('untitled')}</div>`)}
    ${t.preview ? `<div class="card-preview">${esc(t.preview)}</div>` : ''}
    <div class="card-foot">
      ${workTimer(t)}
      ${stale ? `<span class="chip-stale" title="${tr('no movement — the chat is probably closed')}">${tr('stuck')} ${stale}${tr('h')}</span>` : ''}
      ${pri ? `<span class="pri ${pri[1]}" title="${esc(tr('priority:'))} ${pri[2]}">${pri[0]}</span>` : ''}
      ${t.labels.map(labelChip).join('')}
      ${linkedKeys.length ? `<span class="card-link hidden" title="${esc(tr('linked to:'))} ${esc(linkedKeys.join(', '))}">${ic('link', 12)}</span>` : ''}
      ${t.attachments_n ? `<span class="card-attach" title="${esc(tr('attachments:'))} ${t.attachments_n}">${ic('attach', 12)} ${t.attachments_n}</span>` : ''}
      ${t.comments_n ? `<span class="card-comments">${ic('comment', 12)} ${t.comments_n}</span>` : ''}
    </div>`;
  el.onclick = () => { setKbCursor(t.id, false); openDrawer(t.key); };
  el.oncontextmenu = (e) => openCardMenu(e, t);
  if (el.draggable) {
    el.ondragstart = (e) => {
      if (!selectedIds.has(t.id)) clearSelection();
      dragGroupIds = (selectedIds.has(t.id) && selectedIds.size > 1) ? [...selectedIds] : null;
      e.dataTransfer.setData('text/plain', t.id);
      e.dataTransfer.effectAllowed = 'move';
      dragId = t.id;
      document.body.classList.add('dragging-board');
      dropPh.style.height = `${el.offsetHeight}px`;
      const r = el.getBoundingClientRect();
      const ghost = el.cloneNode(true);
      ghost.classList.remove('selected', 'just-dropped', 'multi-selected');
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${el.offsetWidth}px`;
      if (dragGroupIds) ghost.insertAdjacentHTML('beforeend', `<span class="drag-count">${dragGroupIds.length}</span>`);
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, e.clientX - r.left, e.clientY - r.top);
      setTimeout(() => ghost.remove(), 0);
      setTimeout(() => {
        if (dragGroupIds) dragGroupIds.forEach((id) => $('board').querySelector(`.card[data-id="${id}"]`)?.classList.add('dragging'));
        else el.classList.add('dragging');
      }, 0);
    };
    el.ondragend = () => {
      document.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
      dropPh.remove();
      document.querySelectorAll('.col-body.dragover').forEach((b) => b.classList.remove('dragover'));
      document.body.classList.remove('dragging-board');
      dragId = null;
      dragGroupIds = null;
    };
  }
  return el;
}

setInterval(() => {
  for (const el of document.querySelectorAll('.timer.running')) {
    const base = Number(el.dataset.base);
    const started = Number(el.dataset.started);
    el.innerHTML = `${ic('timer', 12)} ${esc(fmtWork(base + (Date.now() - started) / 1000))}`;
  }
}, 1000);

async function onDrop(e, status, body) {
  e.preventDefault();
  body.classList.remove('dragover');
  const id = Number(e.dataTransfer.getData('text/plain'));
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (dragGroupIds && dragGroupIds.length > 1) return onDropGroup(e, status, body);
  if (moveBlocked(t.status, status, { manual: taskIsNoclaude(t) })) return;

  const cards = [...body.querySelectorAll('.card')].filter((c) => Number(c.dataset.id) !== id);
  const y = e.clientY;
  let idx = cards.findIndex((c) => y < c.getBoundingClientRect().top + c.offsetHeight / 2);
  if (idx === -1) idx = cards.length;
  const colTasks = state.tasks
    .filter((x) => x.status === status && x.id !== id)
    .sort((a, b) => b.priority - a.priority || a.position - b.position || a.id - b.id);
  const prev = colTasks[idx - 1]?.position ?? 0;
  const next = colTasks[idx]?.position ?? prev + 2;
  const position = (prev + next) / 2;

  const card = $('board').querySelector(`.card[data-id="${id}"]`);
  if (card) {
    body.insertBefore(card, dropPh);
    card.classList.remove('dragging');
    card.classList.add('just-dropped');
    card.addEventListener('animationend', () => card.classList.remove('just-dropped'), { once: true });
  }
  dropPh.remove();
  await api('PATCH', `/api/tasks/${seg(id)}`, { status, position });
  await refresh();
}

async function onDropGroup(e, status, body) {
  const ids = dragGroupIds;
  const movable = ids
    .map((id) => state.tasks.find((x) => x.id === id))
    .filter(Boolean)
    .filter((t) => !DRAG_LOCKED.has(t.status))
    .filter((t) => !moveBlocked(t.status, status, { manual: taskIsNoclaude(t) }));
  if (!movable.length) { dropPh.remove(); return; }

  const draggedSet = new Set(movable.map((t) => t.id));
  const cards = [...body.querySelectorAll('.card')].filter((c) => !draggedSet.has(Number(c.dataset.id)));
  const y = e.clientY;
  let idx = cards.findIndex((c) => y < c.getBoundingClientRect().top + c.offsetHeight / 2);
  if (idx === -1) idx = cards.length;
  const colTasks = state.tasks
    .filter((x) => x.status === status && !draggedSet.has(x.id))
    .sort((a, b) => b.priority - a.priority || a.position - b.position || a.id - b.id);
  const prev = colTasks[idx - 1]?.position ?? 0;
  const next = colTasks[idx]?.position ?? prev + movable.length + 1;
  const step = (next - prev) / (movable.length + 1);

  dropPh.remove();
  for (let i = 0; i < movable.length; i++) {
    await api('PATCH', `/api/tasks/${seg(movable[i].id)}`, { status, position: prev + step * (i + 1) });
  }
  clearSelection();
  await refresh();
}

export function buildSelect(host, opts) {
  host.classList.add('kbsel');
  host.dataset.value = opts.value == null ? '' : String(opts.value);
  const cur = () => opts.options.find((o) => String(o.value) === host.dataset.value);
  const optHTML = (o) => `${o.dot ? `<span class="dot s-${o.dot}"></span>` : ''}${esc(o.label)}`;
  const searchHTML = opts.search ? `<div class="kbsel-search"><input type="text" class="kbsel-search-input" placeholder="${tr('search boards…')}"></div>` : '';
  host.innerHTML = `<button type="button" class="kbsel-btn"><span class="kbsel-val"></span><span class="kbsel-chev">▾</span></button>`
    + `<div class="kbsel-list">${searchHTML}${opts.options.map((o) =>
        `<div class="kbsel-opt${o.rightHTML ? ' has-r' : ''}${host.dataset.value === String(o.value) ? ' active' : ''}${o.disabled ? ' disabled' : ''}" data-v="${esc(String(o.value))}">${optHTML(o)}${o.rightHTML ? `<span class="kbsel-opt-r">${o.rightHTML}</span>` : ''}</div>`).join('')}</div>`;
  const valBox = host.querySelector('.kbsel-val');
  const renderBtn = () => { const c = cur(); valBox.innerHTML = c ? optHTML(c) : esc(opts.placeholder || ''); };
  renderBtn();
  const list = host.querySelector('.kbsel-list');
  function filterOpts(q) {
    const qq = q.trim().toLowerCase();
    list.querySelectorAll('.kbsel-opt').forEach((o) => o.classList.toggle('hidden', !!qq && !o.textContent.toLowerCase().includes(qq)));
  }
  const close = () => { host.classList.remove('open'); document.removeEventListener('click', outside); };
  function outside(e) { if (!host.contains(e.target)) close(); }
  host.querySelector('.kbsel-btn').onclick = (e) => {
    e.stopPropagation();
    if (host.classList.contains('open')) { close(); return; }
    document.querySelectorAll('.kbsel.open').forEach((el) => { if (el !== host) el.classList.remove('open'); });
    host.classList.add('open');
    if (opts.search) { const si = host.querySelector('.kbsel-search-input'); si.value = ''; filterOpts(''); setTimeout(() => si.focus(), 0); }
    setTimeout(() => document.addEventListener('click', outside), 0);
  };
  if (opts.search) {
    const si = host.querySelector('.kbsel-search-input');
    si.oninput = () => filterOpts(si.value);
    si.onclick = (e) => e.stopPropagation();
  }
  list.querySelectorAll('.kbsel-opt:not(.disabled)').forEach((o) => {
    o.onclick = (e) => {
      e.stopPropagation();
      host.dataset.value = o.dataset.v;
      list.querySelectorAll('.kbsel-opt').forEach((x) => x.classList.toggle('active', x === o));
      renderBtn(); close();
      opts.onChange?.(o.dataset.v);
    };
  });
}
export function selVal(host) { return (typeof host === 'string' ? $(host) : host).dataset.value; }
export function closeOpenSelect() { document.querySelectorAll('.kbsel.open').forEach((el) => el.classList.remove('open')); }
