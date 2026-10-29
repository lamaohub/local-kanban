
import { $, ALL, ALL_STATUSES, api, DONE_LIMIT, esc, ic, LABEL_COLORS, LABEL_SELECTABLE, noteUnsaved, popoverPlacement, PRI_ICON, PRI_LEVELS, seg, state, tr } from './core.js';
import { markKbCursor, openCardMenu, openDrawer, openDrawerNew, openMovePicker, setKbCursor, statusOptionList } from './drawer.js';
import { columnComparator, DEFAULT_SORT, dropPatch, orderColumn, slotBefore, sortMode } from './order.js';
import { inSearch } from './live-rules.js';
import { forClaude, isManual } from './launch-rules.js';
import { hasAsk } from './asks.js';
import { getSetting, plural } from './settings.js';
import { NARROW, popLayer, pushLayer, styledAlert, styledConfirm } from './sidebar.js';
import { copyBacklogPrompt, copyTodoPrompt, launchInClaude, refresh, todoPromptText } from './sse.js';
import { columnCheck, reviewGroups } from './review-rules.js';
import { heldWhy, startCheckIn } from './review.js';
import { autoSlot } from './automations.js';
import { paintAttention } from './attention.js';
import { refusalLine } from './unsaved.js';
import { localStore } from './store.js';

function matchesSearch(t) {
  return inSearch(t, { search: state.search, applied: state.searchApplied, hits: state.searchHits });
}

let prevCardIds = new Set();
let prevRenderSlug = null;
const CARD_EXIT_MAX = 10;
export let scrollToNewCardId = null;
export function setScrollToNewCardId(id) { scrollToNewCardId = id; }
function ensureCardFxLayer() {
  let l = document.getElementById('card-fx');
  if (!l) { l = document.createElement('div'); l.id = 'card-fx'; document.body.appendChild(l); }
  return l;
}

function drawListNote(board) {
  const note = state.listNote;
  if (!note) return;
  const el = document.createElement('div');
  el.className = 'board-note';
  el.innerHTML = `<span>${esc(tr(note.text))}</span><button type="button" class="btn-ghost board-note-retry">${esc(tr('Try now'))}</button>`;
  el.querySelector('button').onclick = () => note.retry();
  board.querySelector('.col-body')?.prepend(el);
}

function reviewCheckButton(shown) {
  const g = columnCheck(shown, state.tasks, state.slug, ALL, state.projects, state.live);
  checkSig = g ? JSON.stringify([g.project, g.running?.key, g.working, g.batch]) : '';
  if (!g) return null;
  const btn = document.createElement('button');
  btn.className = 'btn-icon col-check';
  if (g.running) {
    btn.innerHTML = ic('eye', 13);
    // a check takes the tasks in Review when it starts: one that came later is not in it, so the words are of the project
    btn.title = `${tr('This project already has an open check')} ${g.running.key}`;
    btn.onclick = (e) => { e.stopPropagation(); openDrawer(g.running.key); };
  } else if (g.working.length) {
    btn.innerHTML = ic('play', 13);
    btn.setAttribute('aria-disabled', 'true');
    btn.title = heldWhy(g.working);
    btn.onclick = (e) => { e.stopPropagation(); pressCheck(g.project, btn); };
  } else {
    btn.innerHTML = ic('play', 13);
    btn.title = tr('Check these tasks in Claude: tests, simulated failures, then Done');
    btn.onclick = (e) => { e.stopPropagation(); pressCheck(g.project, btn); };
  }
  return btn;
}

async function pressCheck(project, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  let list;
  try { list = await api('GET', `/api/tasks?project=${seg(project)}`, undefined, { quiet: true }); }
  catch (e) { btn.disabled = false; styledAlert(refusalLine('Could not create the check', e, tr)); return; }
  const p = state.projects.find((x) => x.slug === project) || { slug: project };
  const g = reviewGroups(list, [p], state.live)[0];
  if (!g?.running && !g?.working.length && g?.batch.length) { await startCheckIn(g.project, g.batch, btn, refresh); return; }
  btn.disabled = false;
  if (g?.running) openDrawer(g.running.key);
  else if (g?.working.length) styledAlert(heldWhy(g.working));
  refresh(); // the board's picture was off: draw it from the server
}

let checkHead = null;
let checkShown = [];
let checkSig = '';
export function repaintCheckButton() {
  if (!checkHead?.isConnected) return;
  const old = checkHead.querySelector('.col-check');
  if (old?.disabled) return;
  const was = checkSig;
  const btn = reviewCheckButton(checkShown);
  if (checkSig === was) return;
  old?.remove();
  if (btn) checkHead.appendChild(btn);
}

function columnHead(key, tasks, mode, labels) {
  const head = document.createElement('div');
  head.className = 'col-head';
  head.innerHTML = `<span class="dot s-${key}"></span>${labels[key]} <span class="n">${tasks.length}</span>`;
  if (tasks.length > 1 || mode !== DEFAULT_SORT) {
    const sort = document.createElement('button');
    sort.className = `btn-icon col-sort${mode !== DEFAULT_SORT ? ' on' : ''}`;
    sort.innerHTML = ic('sort', 13);
    sort.title = mode === DEFAULT_SORT ? tr('Sort the column') : tr(SORT_LABELS[mode]);
    sort.onclick = (e) => { e.stopPropagation(); openColSortMenu(sort, key); };
    head.appendChild(sort);
  }
  if (CREATABLE.has(key)) {
    const add = document.createElement('button');
    add.className = 'btn-icon col-add';
    add.textContent = '+';
    add.title = `${tr('New task in')} «${labels[key]}»`;
    add.onclick = () => openDrawerNew(key);
    head.appendChild(add);
  }
  const mine = key === 'todo' ? forClaude(tasks, state.tasks) : [];
  if (key === 'todo' && mine.length) {
    const copy = document.createElement('button');
    copy.className = 'btn-icon col-copy';
    copy.innerHTML = ic('copy', 13);
    copy.title = tr('Copy the tasks as a job for Claude');
    copy.onclick = (e) => { e.stopPropagation(); copyTodoPrompt(mine, copy); };
    head.appendChild(copy);
    const launch = document.createElement('button');
    launch.className = 'btn-icon col-launch';
    launch.innerHTML = ic('play', 13);
    launch.title = tr('Start these tasks in Claude');
    const projects = [...new Set(mine.map((t) => t.project))];
    const project = state.slug !== ALL ? state.slug : (projects.length === 1 ? projects[0] : null);
    launch.onclick = (e) => { e.stopPropagation(); launchInClaude({ text: todoPromptText(mine), project, keys: mine.map((t) => t.key), btn: launch }); };
    head.appendChild(launch);
  }
  if (key === 'review' && tasks.length) {
    checkHead = head; checkShown = tasks;
    const btn = reviewCheckButton(tasks);
    if (btn) head.appendChild(btn);
  }
  if (key === 'review' && state.slug !== ALL && state.slug) head.appendChild(autoSlot(state.slug));
  if (key === 'backlog' && tasks.length) {
    const copy = document.createElement('button');
    copy.className = 'btn-icon col-copy';
    copy.innerHTML = ic('copy', 13);
    copy.title = tr('Copy the backlog as a grooming job for Claude');
    copy.onclick = (e) => { e.stopPropagation(); copyBacklogPrompt(tasks, copy); };
    head.appendChild(copy);
  }
  return head;
}
function columnBody(key) {
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
    const after = colSort(key) === DEFAULT_SORT ? dragAfterCard(body, e.clientY, dragId) : sortedSlotCard(body, key, dt);
    if (dropPh.parentNode !== body || dropPh.nextSibling !== after) body.insertBefore(dropPh, after);
  };
  body.ondragleave = (e) => { if (!body.contains(e.relatedTarget)) body.classList.remove('dragover'); };
  body.ondrop = (e) => onDrop(e, key, body);
  return body;
}
function columnGhost(key, labels) {
  const ghost = document.createElement('div');
  ghost.className = 'col-add-ghost';
  ghost.textContent = tr('+ add task');
  ghost.title = `${tr('New task in')} «${labels[key]}»`;
  ghost.onclick = () => openDrawerNew(key);
  return ghost;
}

let renderHeld = false;
let dropSends = false;

export function renderBoard() {
  if (dragId != null) { renderHeld = true; return; }
  renderHeld = false;
  const board = $('board');
  const sameBoard = prevRenderSlug === state.slug;
  const animate = prevCardIds.size > 0 && sameBoard;
  const labels = Object.fromEntries(ALL_STATUSES);
  const columns = ALL_STATUSES.map(([k]) => k)
    .filter((k) => k !== 'cancelled' || state.tasks.some((t) => t.status === 'cancelled'));
  const plan = columns.map((key) => {
    const mode = colSort(key);
    return { key, mode, tasks: orderColumn(state.tasks.filter((t) => t.status === key && matchesSearch(t)), mode, colOrderOpts(key)) };
  });
  const newIds = new Set(plan.flatMap((c) => c.tasks.map((t) => t.id)));
  const oldNodes = new Map();
  if (sameBoard) board.querySelectorAll('.card').forEach((c) => oldNodes.set(Number(c.dataset.id), c));
  const leaving = animate ? [...oldNodes.keys()].filter((id) => !newIds.has(id)) : [];
  const exits = leaving.length <= CARD_EXIT_MAX ? leaving.map((id) => ({ node: oldNodes.get(id), rect: oldNodes.get(id).getBoundingClientRect() })) : [];
  if (!sameBoard) board.innerHTML = '';
  board.querySelector('.board-note')?.remove();
  const oldCols = new Map();
  for (const col of board.querySelectorAll(':scope > .col')) oldCols.set(col.querySelector('.col-body')?.dataset.status, col);
  checkHead = null;
  let at = board.firstChild;
  for (const { key, mode, tasks } of plan) {
    let col = oldCols.get(key);
    oldCols.delete(key);
    let body;
    if (col) body = col.querySelector('.col-body');
    else {
      col = document.createElement('div');
      col.className = 'col';
      body = columnBody(key);
      col.appendChild(body);
    }
    const head = columnHead(key, tasks, mode, labels);
    const oldHead = col.querySelector(':scope > .col-head');
    if (oldHead) col.replaceChild(head, oldHead); else col.insertBefore(head, body);
    // the cards, in order: the same drawing keeps its node
    const want = tasks.map((t) => {
      const parts = cardParts(t);
      const node = oldNodes.get(t.id);
      return node && node._kbSig === parts.sig ? node : cardEl(t, parts);
    });
    if (CREATABLE.has(key)) want.push(body.querySelector(':scope > .col-add-ghost') || columnGhost(key, labels));
    let ref = body.firstChild;
    for (const node of want) {
      if (node === ref) { ref = ref.nextSibling; continue; }
      body.insertBefore(node, ref);
    }
    while (ref) { const next = ref.nextSibling; ref.remove(); ref = next; }
    if (col !== at) board.insertBefore(col, at); else at = at.nextSibling;
  }
  for (const col of oldCols.values()) col.remove();
  if (!board.querySelector(':scope > .board-spacer')) board.insertAdjacentHTML('beforeend', '<div class="board-spacer"></div>');
  drawListNote(board);

  if (animate) {
    board.querySelectorAll('.card').forEach((c) => {
      if (prevCardIds.has(Number(c.dataset.id))) return;
      c.classList.add('card-enter');
      // a node kept by later renders must not play its entry again when it moves
      c.addEventListener('animationend', () => c.classList.remove('card-enter'), { once: true });
    });
    for (const info of exits) {
      const clone = info.node.cloneNode(true);
      clone.className = 'card card-exit';
      Object.assign(clone.style, { position: 'fixed', left: `${info.rect.left}px`, top: `${info.rect.top}px`, width: `${info.rect.width}px`, margin: '0' });
      ensureCardFxLayer().appendChild(clone);
      setTimeout(() => clone.remove(), 260);
    }
  }
  oldNodes.clear();
  oldCols.clear();
  exits.length = 0;
  prevCardIds = newIds;
  prevRenderSlug = state.slug;

  scheduleDrawLinks();
  markKbCursor();
  markSelection();
  if (scrollToNewCardId != null) revealCard($('board').querySelector(`.card[data-id="${scrollToNewCardId}"]`));
}

export function revealCard(card) {
  if (!card) return;
  if (!globalThis.matchMedia?.(NARROW).matches) { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return; }
  const near = (from, to, start, end) => (from < start ? from - start : to > end ? Math.min(to - end, from - start) : 0);
  const col = card.closest('.col-body');
  if (col) {
    const c = card.getBoundingClientRect(), b = col.getBoundingClientRect();
    col.scrollTop += near(c.top, c.bottom, b.top, b.bottom);
  }
  const row = $('board');
  const c = card.getBoundingClientRect(), b = row.getBoundingClientRect();
  row.scrollLeft += near(c.left, c.right, b.left, b.right);
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
  const br = $('board').getBoundingClientRect();
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const cx = clamp(marqueeLast.x, br.left, br.right);
  const cy = clamp(marqueeLast.y, br.top, br.bottom);
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
  const vx = Math.max(x, br.left); const vy = Math.max(y, br.top);
  Object.assign(marqueeEl.style, {
    left: `${vx}px`, top: `${vy}px`,
    width: `${Math.max(0, Math.min(x + w, br.right) - vx)}px`, height: `${Math.max(0, Math.min(y + h, br.bottom) - vy)}px`,
  });
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
  const box = `${br.left - mr.left} ${br.top - mr.top} ${br.width} ${br.height}`;
  if (svg.dataset.box !== box) {
    svg.dataset.box = box;
    svg.style.left = `${br.left - mr.left}px`;
    svg.style.top = `${br.top - mr.top}px`;
    svg.style.width = `${br.width}px`;
    svg.style.height = `${br.height}px`;
    svg.setAttribute('viewBox', `0 0 ${br.width} ${br.height}`);
  }

  const seen = new Set();
  const offScreen = {};
  const linesOn = getSetting('linkLines') !== false;
  const cardEls = new Map();
  for (const el of board.querySelectorAll('.card')) cardEls.set(Number(el.dataset.id), el);
  let html = '';
  for (const t of state.tasks) {
    for (const other of (t.linked_ids || [])) {
      const pair = t.id < other ? `${t.id}.${other}` : `${other}.${t.id}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const elA = cardEls.get(t.id);
      const elB = cardEls.get(other);
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
  const body = board.querySelector('.col-body');
  const top = body ? Math.max(0, body.getBoundingClientRect().top - br.top) : 0;
  const lines = html && `<clipPath id="link-clip"><rect x="0" y="${top}" width="${br.width}" height="${Math.max(0, br.height - top)}"/></clipPath>`
    + `<g clip-path="url(#link-clip)">${html}</g>`;
  if (svg._kbLines !== lines) { svg._kbLines = lines; svg.innerHTML = lines; }

  // projects» each frame (590 changes of the page per frame) made the scroll of a phone stutter
  for (const el of board.querySelectorAll('.card-link')) {
    const card = el.closest('.card');
    const n = card ? (offScreen[Number(card.dataset.id)] || 0) : 0;
    const want = String(n);
    if (el.dataset.n === want) continue;
    el.dataset.n = want;
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

export function taskIsNoclaude(t) { return isManual(t); }
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
export function selectTasks(ids) {
  for (const id of ids) selectedIds.add(id);
  markSelection();
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
    + tile('move', ic('open', 15), tr('Move'))
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
  if (act === 'move') { openMovePicker(tasks.map((t) => t.key)); return; }
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

const SORT_KEY = 'kb.ui.colSort';
const SORT_LABELS = {
  manual: 'By priority, then by hand',
  'num-desc': 'By number, newest first',
  'num-asc': 'By number, oldest first',
};
function readColSorts() {
  try {
    const v = JSON.parse(localStore.getItem(SORT_KEY));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
export function colSort(status) { return sortMode(readColSorts()[`${state.slug}:${status}`]); }
function setColSort(status, mode) {
  const all = readColSorts();
  const k = `${state.slug}:${status}`;
  if (sortMode(mode) === DEFAULT_SORT) delete all[k]; else all[k] = mode;
  try { localStore.setItem(SORT_KEY, JSON.stringify(all)); } catch {  }
  renderBoard();
}
function colOrderOpts(status) {
  return { mixed: state.slug === ALL, closed: status === 'done' || status === 'cancelled', limit: DONE_LIMIT };
}
function sortedSlotCard(body, status, t) {
  const id = slotBefore(state.tasks.filter((x) => x.status === status && matchesSearch(x)), t, colSort(status), colOrderOpts(status));
  return id == null ? null : body.querySelector(`.card[data-id="${id}"]`);
}

function closeColSortMenu() {
  popLayer('col-sort-menu');
  $('col-sort-menu')?.remove();
  document.removeEventListener('click', colSortOutside);
}
function colSortOutside(e) { if (!e.target.closest('#col-sort-menu')) closeColSortMenu(); }
function openColSortMenu(anchor, status) {
  const was = $('col-sort-menu')?.dataset.status;
  closeColSortMenu();
  if (was === status) return;
  pushLayer('col-sort-menu', closeColSortMenu);
  const menu = document.createElement('div');
  menu.className = 'drawer-menu-pop col-sort-menu';
  menu.id = 'col-sort-menu';
  menu.dataset.status = status;
  const cur = colSort(status);
  menu.innerHTML = Object.entries(SORT_LABELS).map(([v, label]) =>
    `<div class="dm-item${v === cur ? ' on' : ''}" data-v="${v}">${esc(tr(label))}${v === cur ? '<span class="dm-chev">✓</span>' : ''}</div>`).join('')
    + `<div class="dm-sep"></div><div class="dm-hint">${esc(tr('Sorted by number, cards cannot be reordered by hand'))}</div>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  let left = r.left;
  if (left + menu.offsetWidth > window.innerWidth - 8) left = window.innerWidth - menu.offsetWidth - 8;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.querySelectorAll('.dm-item').forEach((el) => {
    el.onclick = () => { closeColSortMenu(); if (el.dataset.v !== cur) setColSort(status, el.dataset.v); };
  });
  requestAnimationFrame(() => menu.classList.add('open'));
  document.addEventListener('click', colSortOutside);
}

function dragAfterCard(body, y, draggedId) {
  const cards = [...body.querySelectorAll('.card')].filter((c) => Number(c.dataset.id) !== draggedId);
  return cards.find((c) => y < c.getBoundingClientRect().top + c.offsetHeight / 2) || null;
}

export function fmtWork(sec) {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}${tr('h')} ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}${tr('m')}`;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

const WORK_SEGMENT_MAX_S = 2 * 3600;
function workShown(base, started, cut) {
  const seg = started ? Math.max(0, (Date.now() - started) / 1000) : 0;
  const capped = cut || seg >= WORK_SEGMENT_MAX_S;
  const title = capped ? `${tr('time spent')} — ${tr('capped: the task sat in a working column too long')}` : tr('time spent');
  return { title, html: `${ic('timer', 12)} ${capped ? '≈' : ''}${esc(fmtWork(base + Math.min(seg, WORK_SEGMENT_MAX_S)))}` };
}
function workTimer(t) {
  const running = !!t.work_started_at && WORKING.has(t.status);
  if (!t.work_seconds && !running) return '';
  const started = running ? new Date(t.work_started_at + 'Z').getTime() : 0;
  const cut = t.work_truncated > 0;
  const w = workShown(t.work_seconds, started, cut);
  return `<span class="timer${running ? ' running' : ''}" data-base="${t.work_seconds}" data-started="${started}"${cut ? ' data-cut="1"' : ''} title="${esc(w.title)}">${w.html}</span>`;
}

const STALE_MS = 2 * 3600 * 1000;
function staleHours(t) {
  if (!WORKING.has(t.status)) return 0;
  const idle = Date.now() - new Date(t.updated_at + 'Z').getTime();
  return idle > STALE_MS ? Math.floor(idle / 3600000) : 0;
}

const ORDERING = ['status', 'priority', 'position', 'pinned'];
export function patchCard(before, after) {
  const el = $('board')?.querySelector(`.card[data-id="${after.id}"]`);
  if (!el || !el.parentNode) return false;
  if (ORDERING.some((k) => before[k] !== after[k])) return false;
  if (dragId != null) { renderHeld = true; return true; }
  el.replaceWith(cardEl(after));
  markKbCursor();
  markSelection();
  scheduleDrawLinks();
  return true;
}

const LIVE_BADGE = {
  busy: ['busy', 'working', 'Claude is working on it'],
  waiting: ['wait', 'waiting for you', 'Claude is waiting for you — open the card to answer'],
  idle: ['wait', 'waiting for you', 'Claude stopped and is waiting for you — open the card'],
  gone: ['gone', 'session closed', 'The Claude session that worked on it has closed — nobody is working on it now'],
  interrupted: ['gone', 'session interrupted', 'Claude was stopped from outside — open the card to continue the session'],
  starting: ['start', 'starting', 'Claude has been started on it and has not taken it yet'],
  unsent: ['wait', 'waiting to start in the app', 'The prompt is in the Claude app — press Enter there to start Claude'],
  background: ['busy', 'working in the background', 'Claude goes on with commands running in the background — see its terminal'],
  limit: ['limit', 'limit reached', 'Claude hit the usage limit and stopped — it goes on once the limit resets'],
  brokeRetrying: ['busy', 'connection lost · going on', "The connection to the API broke off in the middle of Claude's answer — the board tells it to go on by itself"],
  brokeStuck: ['wait', 'answer broke off', "The connection to the API broke off in the middle of Claude's answer, and it did not go on — open the card"],
};
function liveBadge(t) {
  if (hasAsk(t.id)) return `<span class="card-live live-wait live-ask" title="${esc(tr('Claude is waiting for your answer — open the card'))}"><span class="live-dot"></span>${tr('needs your answer')}</span>`;
  const l = state.live[t.id];
  const b = l && WORKING.has(t.status) && LIVE_BADGE[l.claude === 'gone' && l.interrupted ? 'interrupted'
    : l.claude === 'idle' && l.broke ? (l.broke === 'retrying' ? 'brokeRetrying' : 'brokeStuck') : l.claude];
  if (!b) return '';
  const until = l.claude === 'limit' && l.resets ? ` · ${tr('until')} ${esc(l.resets)}` : '';
  const title = l.claude === 'idle' && l.background && !l.broke ? 'Claude finished its turn and waits for you — commands it started still run in the background' : b[2];
  return `<span class="card-live live-${b[0]}" title="${esc(tr(title))}"><span class="live-dot"></span>${tr(b[1])}${until}</span>`;
}

export function applyLive(tasks) {
  const next = {};
  const changes = [];
  for (const x of tasks || []) {
    next[x.id] = { claude: x.claude, since: x.since, project: x.project, resets: x.resets ?? null, key: x.key, title: x.title, background: Boolean(x.background), interrupted: Boolean(x.interrupted), broke: x.broke ?? null };
    const was = state.live[x.id]?.claude ?? null;
    const wasBroke = state.live[x.id]?.broke ?? null;
    if (was !== x.claude || wasBroke !== (x.broke ?? null)) changes.push({ ...x, from: was, fromBroke: wasBroke });
  }
  state.live = next;
  repaintLiveBadges();
  repaintCheckButton();
  return changes;
}

export function repaintLiveBadges() {
  const byId = new Map(state.tasks.map((t) => [String(t.id), t]));
  for (const el of $('board').querySelectorAll('.card[data-id]')) {
    const t = byId.get(el.dataset.id);
    const foot = t && el.querySelector('.card-foot');
    if (!foot) continue;
    foot.querySelector('.card-live')?.remove();
    const html = liveBadge(t);
    if (html) foot.insertAdjacentHTML('afterbegin', html);
    el.classList.toggle('limited', atLimit(t));
  }
  paintAttention();
}
function atLimit(t) { return WORKING.has(t.status) && state.live[t.id]?.claude === 'limit'; }

function cardParts(t) {
  const stale = staleHours(t);
  const className = 'card' + (WORKING.has(t.status) ? (stale ? ' stale' : ' working') : '')
    + ((state.openingKey ?? state.drawerKey) === t.key ? ' selected' : '')
    + (atLimit(t) ? ' limited' : '');
  const draggable = taskIsNoclaude(t) || !DRAG_LOCKED.has(t.status);
  const pri = PRI_ICON[t.priority];
  const linkedKeys = (t.linked_ids || []).map((id) => state.tasks.find((x) => x.id === id)?.key).filter(Boolean);
  const html = `
    ${t.pinned ? `<span class="card-pin" title="${esc(tr('needs attention'))}">${ic('pin', 12)}</span>` : ''}
    <div class="card-key">${t.key}${state.slug === ALL ? ` <span class="card-proj">· ${esc(t.project)}</span>` : ''}</div>
    ${t.title
      ? `<div class="card-title">${esc(t.title)}</div>`
      : (t.preview ? '' : `<div class="card-title card-title-empty">${tr('untitled')}</div>`)}
    ${t.preview ? `<div class="card-preview">${esc(t.preview)}</div>` : ''}
    <div class="card-foot">
      ${liveBadge(t)}
      ${workTimer(t)}
      ${stale ? `<span class="chip-stale" title="${tr('no movement — the chat is probably closed')}">${tr('stuck')} ${stale}${tr('h')}</span>` : ''}
      ${pri ? `<span class="pri ${pri[1]}" title="${esc(tr('priority:'))} ${pri[2]}">${pri[0]}</span>` : ''}
      ${t.labels.map(labelChip).join('')}
      ${linkedKeys.length ? `<span class="card-link hidden" title="${esc(tr('linked to:'))} ${esc(linkedKeys.join(', '))}">${ic('link', 12)}</span>` : ''}
      ${t.attachments_n ? `<span class="card-attach" title="${esc(tr('attachments:'))} ${t.attachments_n}">${ic('attach', 12)} ${t.attachments_n}</span>` : ''}
      ${t.comments_n ? `<span class="card-comments">${ic('comment', 12)} ${t.comments_n}</span>` : ''}
    </div>`;
  return { className, draggable, html, sig: `${className}|${draggable ? 1 : 0}|${html}` };
}

function cardEl(t, parts = cardParts(t)) {
  const el = document.createElement('div');
  el.className = parts.className;
  el.draggable = parts.draggable;
  el.dataset.id = t.id;
  el.innerHTML = parts.html;
  el._kbSig = parts.sig;
  const id = t.id;
  const now = () => state.tasks.find((x) => x.id === id) || t;
  el.onclick = () => { setKbCursor(id, false); openDrawer(now().key); };
  el.oncontextmenu = (e) => openCardMenu(e, now());
  if (el.draggable) {
    el.ondragstart = (e) => {
      if (!selectedIds.has(id)) clearSelection();
      dragGroupIds = (selectedIds.has(id) && selectedIds.size > 1) ? [...selectedIds] : null;
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      dragId = id;
      dropSends = false;
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
        if (dragGroupIds) dragGroupIds.forEach((gid) => $('board').querySelector(`.card[data-id="${gid}"]`)?.classList.add('dragging'));
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
      if (renderHeld && !dropSends) renderBoard();
      dropSends = false;
    };
  }
  return el;
}

setInterval(() => {
  for (const el of document.querySelectorAll('.timer.running')) {
    const w = workShown(Number(el.dataset.base), Number(el.dataset.started), el.dataset.cut === '1');
    if (el.innerHTML !== w.html) el.innerHTML = w.html;
    if (el.title !== w.title) el.title = w.title;
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

  const fixedOrder = colSort(status) !== DEFAULT_SORT;
  if (fixedOrder && t.status === status) { dropPh.remove(); return; }
  let position;
  if (!fixedOrder) {
    const cards = [...body.querySelectorAll('.card')].filter((c) => Number(c.dataset.id) !== id);
    const y = e.clientY;
    let idx = cards.findIndex((c) => y < c.getBoundingClientRect().top + c.offsetHeight / 2);
    if (idx === -1) idx = cards.length;
    const colTasks = state.tasks.filter((x) => x.status === status && x.id !== id).sort(columnComparator(DEFAULT_SORT));
    const prev = colTasks[idx - 1]?.position ?? 0;
    const next = colTasks[idx]?.position ?? prev + 2;
    position = (prev + next) / 2;
  }
  const patch = dropPatch(t.status, status, position);
  dropSends = true;

  const card = $('board').querySelector(`.card[data-id="${id}"]`);
  if (card) {
    body.insertBefore(card, dropPh);
    card.classList.remove('dragging');
    card.classList.add('just-dropped');
    card.addEventListener('animationend', () => card.classList.remove('just-dropped'), { once: true });
  }
  dropPh.remove();
  try {
    await api('PATCH', `/api/tasks/${seg(id)}`, patch);
  } catch (e) {
    renderBoard();
    if (e?.offline) noteUnsaved(() => api('PATCH', `/api/tasks/${seg(id)}`, patch).then(refresh));
    return;
  }
  await refresh();
}

async function onDropGroup(e, status, body) {
  const ids = dragGroupIds;
  const movable = ids
    .map((id) => state.tasks.find((x) => x.id === id))
    .filter(Boolean)
    .filter((t) => !DRAG_LOCKED.has(t.status))
    .filter((t) => !moveBlocked(t.status, status, { manual: taskIsNoclaude(t) }));
  const refused = ids.map((id) => state.tasks.find((x) => x.id === id)).filter(Boolean)
    .filter((t) => !movable.includes(t));
  if (refused.length) {
    const why = refused.map((t) => moveBlocked(t.status, status, { manual: taskIsNoclaude(t) }))
      .find(Boolean) || tr('Claude moves these columns itself');
    styledAlert(`${refused.length} ${plural(refused.length, 'task', 'tasks')}: ${why}`);
  }
  if (!movable.length) { dropPh.remove(); return; }

  const draggedSet = new Set(movable.map((t) => t.id));
  const cards = [...body.querySelectorAll('.card')].filter((c) => !draggedSet.has(Number(c.dataset.id)));
  const y = e.clientY;
  let idx = cards.findIndex((c) => y < c.getBoundingClientRect().top + c.offsetHeight / 2);
  if (idx === -1) idx = cards.length;
  const colTasks = state.tasks.filter((x) => x.status === status && !draggedSet.has(x.id)).sort(columnComparator(DEFAULT_SORT));
  const prev = colTasks[idx - 1]?.position ?? 0;
  const next = colTasks[idx]?.position ?? prev + movable.length + 1;
  const step = (next - prev) / (movable.length + 1);
  const fixedOrder = colSort(status) !== DEFAULT_SORT;

  dropPh.remove();
  dropSends = true;
  for (let i = 0; i < movable.length; i++) {
    if (fixedOrder && movable[i].status === status) continue;
    await api('PATCH', `/api/tasks/${seg(movable[i].id)}`, fixedOrder ? { status } : { status, position: prev + step * (i + 1) });
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
  const close = () => { host.classList.remove('open'); list.querySelector('.kbsel-opt.hl')?.classList.remove('hl'); document.removeEventListener('click', outside); };
  function outside(e) { if (!host.contains(e.target)) close(); }
  host.querySelector('.kbsel-btn').onclick = (e) => {
    e.stopPropagation();
    if (host.classList.contains('open')) { close(); return; }
    document.querySelectorAll('.kbsel.open').forEach((el) => { if (el !== host) el.classList.remove('open'); });
    host.classList.add('open');
    const place = popoverPlacement(host.querySelector('.kbsel-btn'));
    list.classList.toggle('up', place.openUp);
    list.style.maxHeight = `${place.maxHeight}px`;
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
      const inList = list.contains(document.activeElement);
      host.dataset.value = o.dataset.v;
      list.querySelectorAll('.kbsel-opt').forEach((x) => x.classList.toggle('active', x === o));
      renderBtn(); close();
      if (inList) host.querySelector('.kbsel-btn').focus({ preventScroll: true });
      opts.onChange?.(o.dataset.v);
    };
  });
  const hl = (o) => {
    list.querySelectorAll('.kbsel-opt.hl').forEach((x) => x.classList.remove('hl'));
    if (o) { o.classList.add('hl'); o.scrollIntoView?.({ block: 'nearest' }); }
  };
  if (host._kbselKeys) host.removeEventListener('keydown', host._kbselKeys);
  host._kbselKeys = (e) => {
    const isOpen = host.classList.contains('open');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...list.querySelectorAll('.kbsel-opt:not(.disabled):not(.hidden)')];
      if (!isOpen) { host.querySelector('.kbsel-btn').click(); hl(list.querySelector('.kbsel-opt.active:not(.disabled)') || all[0]); return; }
      if (!all.length) return;
      const at = all.indexOf(list.querySelector('.kbsel-opt.hl') || list.querySelector('.kbsel-opt.active'));
      const d = e.key === 'ArrowDown' ? 1 : -1;
      hl(all[at < 0 ? (d > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, at + d))]);
    } else if (isOpen && (e.key === 'Enter' || (e.key === ' ' && !e.target.classList.contains('kbsel-search-input')))) {
      const o = list.querySelector('.kbsel-opt.hl:not(.hidden)');
      if (!o) return;
      e.preventDefault();
      o.click();
    } else if (isOpen && e.key === 'Tab') close();
  };
  host.addEventListener('keydown', host._kbselKeys);
}
export function selVal(host) { return (typeof host === 'string' ? $(host) : host).dataset.value; }
export function closeOpenSelect() { document.querySelectorAll('.kbsel.open').forEach((el) => el.classList.remove('open')); }
