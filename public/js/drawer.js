
import { WORKING, buildSelect, canMoveTo, clearSelection, labelChip, moveBlocked, scheduleDrawLinks, scrollToNewCardId, selVal, selectedIds, taskIsNoclaude } from './board.js';
import { $, ALL, ALL_STATUSES, DASH, LABEL_COLORS, LABEL_SELECTABLE, PRI_LEVELS, SETTINGS, TITLE_LABEL_WORDS, api, apiBlob, esc, ghSyncOn, ic, seg, state, tr } from './core.js';
import { getSetting } from './settings.js';
import { currentProject, overlayLayer, popLayer, pushLayer, selectProject, styledAlert, styledConfirm } from './sidebar.js';
import { autoGrow, copyText, refresh, relTime, renderTimeline } from './sse.js';

/* ── Drawer ── */
let drawerLabels = [];
let drawerLocked = false;
let drawerStatus = null;
let drawerPinned = 0;
let createInFlight = false;

export function applyTitleLabelShortcut() {
  const el = $('d-title');
  const m = el.value.match(/^(\S+)[ \t]/);
  if (!m) return;
  const label = TITLE_LABEL_WORDS[m[1].toLowerCase()];
  if (!label) return;
  el.value = el.value.slice(m[0].length);
  autoGrow(el);
  if (!drawerLabels.includes(label)) {
    drawerLabels = [...drawerLabels, label];
    renderDrawerLabels();
    if (label === 'noclaude' && state.drawerKey) {
      buildStatusSelect(drawerStatus, false, true);
      setDrawerLock(false);
    }
  }
}
function renderDrawerLabels() {
  const box = $('d-labels');
  const askOn = drawerLabels.includes('ask');
  box.innerHTML = drawerLabels.filter((l) => l !== 'ask').map(labelChip).join('')
    + (drawerLocked
      ? (askOn ? labelChip('ask') : '')
      : `<span class="link-chip link-add" id="lbl-add">${tr('+ label')}</span>`
        + `<span class="link-chip link-add lbl-ask${askOn ? ' on' : ''}" id="lbl-ask" title="${esc(tr('Claude will ask clarifying questions first and wait for your answer'))}">ask?</span>`);
  if (drawerLocked) return;
  $('lbl-add').onclick = openLabelPicker;
  $('lbl-ask').onclick = () => {
    drawerLabels = askOn ? drawerLabels.filter((l) => l !== 'ask') : [...drawerLabels, 'ask'];
    renderDrawerLabels();
    doAutosave();
  };
}

const PRI_OPTIONS = [...PRI_LEVELS].reverse().map(([v, label]) => ({ value: String(v), label }));
export function statusOptionList(current, isNew, allowDirect) {
  return ALL_STATUSES.map(([v, label]) => ({
    value: v, label, dot: v,
    disabled: Boolean(moveBlocked(current, v, { manual: allowDirect, isNew })),
  }));
}
function onDrawerStatusChange(v) {
  $('d-return').classList.toggle('hidden', v !== 'review');
  $('d-return-icon').classList.toggle('hidden', !['review', 'done'].includes(v));
  $('d-accept-btn').classList.toggle('hidden', v !== 'review');
  drawerStatus = v;
  doAutosave();
}
function buildStatusSelect(current, isNew, allowDirect) {
  buildSelect($('d-status'), { value: current, options: statusOptionList(current, isNew, allowDirect), onChange: onDrawerStatusChange });
}
function buildPrioritySelect(current) {
  buildSelect($('d-priority'), { value: String(current), options: PRI_OPTIONS, onChange: doAutosave });
}

const LOCKABLE = ['d-title', 'd-desc'];
function setDrawerLock(locked) {
  drawerLocked = locked;
  for (const id of LOCKABLE) $(id).disabled = locked;
  ['d-status', 'd-priority', 'd-project'].forEach((id) => $(id).classList.toggle('kbsel-locked', locked));
  $('d-lock-note').classList.toggle('hidden', !locked);
  $('drawer-menu').classList.toggle('hidden', locked || !state.drawerKey);
}

function openLabelPicker(e) {
  closeLabelPicker();
  pushLayer('lbl-picker', closeLabelPicker);
  const picker = document.createElement('div');
  picker.className = 'lbl-picker';
  picker.id = 'lbl-picker';
  for (const name of LABEL_SELECTABLE) {
    const opt = document.createElement('div');
    opt.className = 'lbl-opt';
    opt.innerHTML = `<input type="checkbox" ${drawerLabels.includes(name) ? 'checked' : ''}>
      <span class="lbl-dot" style="width:9px;height:9px;border-radius:50%;background:${LABEL_COLORS[name]}"></span> ${esc(name)}`;
    opt.onclick = () => {
      drawerLabels = drawerLabels.includes(name) ? drawerLabels.filter((l) => l !== name) : [...drawerLabels, name];
      renderDrawerLabels();
      if (name === 'noclaude' && state.drawerKey) {
        buildStatusSelect(drawerStatus, false, drawerLabels.includes('noclaude'));
        setDrawerLock(WORKING.has(drawerStatus) && !drawerLabels.includes('noclaude'));
      }
      opt.querySelector('input').checked = drawerLabels.includes(name);
      doAutosave();
    };
    picker.appendChild(opt);
  }
  const r = e?.target?.getBoundingClientRect?.() || $('d-labels').getBoundingClientRect();
  picker.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
  picker.style.top = r.bottom + 6 + 'px';
  document.body.appendChild(picker);
  setTimeout(() => document.addEventListener('click', pickerOutside), 0);
}
function pickerOutside(e) {
  const p = $('lbl-picker');
  if (p && !p.contains(e.target) && e.target.id !== 'lbl-add') closeLabelPicker();
}
function closeLabelPicker() {
  popLayer('lbl-picker');
  $('lbl-picker')?.remove();
  document.removeEventListener('click', pickerOutside);
}

const REL_MARK = { child: '↳ ', parent: '↑ ' };
const REL_TITLE = { child: tr('subtask'), parent: tr('parent task'), related: tr('related') };
function renderDrawerLinks(links) {
  const box = $('d-links');
  box.innerHTML = (links || []).map((l) =>
    `<span class="link-chip rel-${l.rel || 'related'}" title="${REL_TITLE[l.rel] || tr('related')}: ${esc(l.title)}"><span class="dot s-${l.status}"></span>${REL_MARK[l.rel] || ''}${esc(l.key)}`
    + (drawerLocked ? '' : `<span class="link-x" data-other="${l.id}" title="${esc(tr('remove link'))}">×</span>`) + '</span>',
  ).join('') + (drawerLocked ? '' : `<span class="link-chip link-add" id="link-add">${tr('+ link')}</span>`);
  box.classList.remove('hidden');
  if (drawerLocked) return;
  $('link-add').onclick = () => openLinkPicker('related', state.drawerKey);
  box.querySelectorAll('.link-x').forEach((x) => { x.onclick = (e) => { e.stopPropagation(); deleteLink(x.dataset.other); }; });
}

export function renderIssueRow(t) {
  const row = $('d-issue-row');
  if (!t.gh_issue_number) { row.innerHTML = ghSyncOn ? `<span class="muted">${tr('creating issue…')}</span>` : ''; return; }
  if (!t.gh_issue_url) { row.innerHTML = `<span class="muted">issue #${t.gh_issue_number}</span>`; return; }
  let html = `<a class="issue-link" href="${esc(t.gh_issue_url)}" target="_blank" rel="noopener noreferrer">issue #${esc(t.gh_issue_number)} ↗</a>`;
  if (t.commit_url) html += `<a class="issue-link commit-link" href="${esc(t.commit_url)}" target="_blank" rel="noopener noreferrer" title="${tr('the fix commit')}">commit ↗</a>`;
  row.innerHTML = html;
}

async function deleteLink(otherId) {
  if (!state.drawerKey) return;
  const links = await api('DELETE', `/api/tasks/${seg(state.drawerKey)}/links/${seg(otherId)}`);
  renderDrawerLinks(links);
  await refresh();
}

const COMMENT_AUTHORS = { claude: () => `${ic('bot', 12)} claude`, git: () => `${ic('git', 12)} git`, me: () => `${ic('person', 12)} ${tr('me')}` };

export async function renderComments(key) {
  const cs = await api('GET', `/api/tasks/${seg(key)}/comments`);
  $('comments').innerHTML = cs.map((c) => `
    <div class="comment" data-id="${c.id}">
      <div class="comment-meta"><span>${(COMMENT_AUTHORS[c.author] || COMMENT_AUTHORS.me)()} · ${relTime(c.created_at)}</span>
        <span class="comment-del" data-del="${c.id}" title="${tr('Delete the comment')}">×</span></div>
      ${c.body ? `<div class="comment-body">${esc(c.body)}</div>` : ''}
      ${c.image_url ? `<img class="comment-img" src="${c.image_url}" data-url="${c.image_url}" alt="${tr('screenshot')}" loading="lazy">` : ''}
    </div>`).join('');
  $('comments').querySelectorAll('.comment-img').forEach((img) => { img.onclick = () => openLightbox(img.dataset.url); });
  $('comments').querySelectorAll('.comment-del').forEach((x) => { x.onclick = () => deleteComment(x.dataset.del); });
}

async function deleteComment(id) {
  if (!state.drawerKey) return;
  if (!await styledConfirm(tr('Delete the comment?'), { okLabel: tr('Delete'), danger: true })) return;
  await api('DELETE', `/api/tasks/${seg(state.drawerKey)}/comments/${seg(id)}`);
  renderComments(state.drawerKey);
  await refresh();
}

function renderAttachments(list) {
  const box = $('d-attachments');
  if (!list || !list.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.innerHTML = list.map((a) =>
    `<div class="attach"><img src="${a.url}" data-url="${a.url}" alt="${tr('attachment')}" loading="lazy">`
    + `<span class="attach-x" data-id="${a.id}" title="${tr('delete')}">×</span></div>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.attach img').forEach((img) => { img.onclick = () => openLightbox(img.dataset.url); });
  box.querySelectorAll('.attach-x').forEach((x) => { x.onclick = () => deleteAttachment(x.dataset.id); });
}

let drawerChecklist = [];
const clSaveTimers = {};
function renderChecklist(list) {
  drawerChecklist = list || [];
  const box = $('d-checklist');
  if (!drawerChecklist.length) { box.innerHTML = ''; box.classList.add('hidden'); }
  else {
    box.classList.remove('hidden');
    const trashSvg = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M5 4l.5 9a1 1 0 0 0 1 .95h3a1 1 0 0 0 1-.95L12 4M6.7 6.5v5M9.3 6.5v5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    box.innerHTML = drawerChecklist.map((c) =>
      `<div class="cl-item${c.done ? ' done' : ''}" data-id="${c.id}">`
      + `<button class="cl-check" title="${esc(c.done ? tr('clear the mark') : tr('mark as done'))}">${c.done ? '✓' : ''}</button>`
      + `<textarea class="cl-text" rows="1" placeholder="${esc(tr('item'))}"${(drawerLocked || c.done) ? ' readonly' : ''}>${esc(c.text)}</textarea>`
      + (drawerLocked ? '' : `<button class="cl-del" title="${esc(tr('delete item'))}">${trashSvg}</button>`)
      + '</div>').join('');
    box.querySelectorAll('.cl-item').forEach((el) => {
      const id = el.dataset.id;
      const done = el.classList.contains('done');
      const ta = el.querySelector('.cl-text');
      autoGrow(ta);
      if (!drawerLocked) el.querySelector('.cl-check').onclick = () => toggleChecklist(id);
      if (!drawerLocked) {
        if (!done) {
          ta.addEventListener('input', () => { autoGrow(ta); scheduleChecklistSave(id, ta.value); });
          ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addChecklistItem(); }
            else if (e.key === 'Backspace' && ta.value === '') { e.preventDefault(); deleteChecklistItem(id); }
          });
        }
        el.querySelector('.cl-del').onclick = () => deleteChecklistItem(id);
      }
    });
  }
  $('d-checklist-add').classList.toggle('hidden', !state.drawerKey || drawerLocked);
}
async function toggleChecklist(id) {
  if (!state.drawerKey || drawerLocked) return;
  const item = drawerChecklist.find((c) => String(c.id) === String(id));
  if (!item) return;
  item.done = !item.done;
  renderChecklist(drawerChecklist);
  try { await api('PATCH', `/api/tasks/${seg(state.drawerKey)}/checklist/${seg(id)}`, { done: item.done }); } catch {  }
}
function scheduleChecklistSave(id, text) {
  const item = drawerChecklist.find((c) => String(c.id) === String(id));
  if (item) item.text = text;
  clearTimeout(clSaveTimers[id]);
  clSaveTimers[id] = setTimeout(async () => {
    if (!state.drawerKey) return;
    try { await api('PATCH', `/api/tasks/${seg(state.drawerKey)}/checklist/${seg(id)}`, { text }); } catch {  }
  }, 450);
}
export async function addChecklistItem() {
  if (!state.drawerKey || drawerLocked) return;
  const created = await api('POST', `/api/tasks/${seg(state.drawerKey)}/checklist`, { text: '' });
  drawerChecklist.push({ id: created.id, text: '', done: false, position: created.position });
  renderChecklist(drawerChecklist);
  $('d-checklist').querySelector(`.cl-item[data-id="${created.id}"] .cl-text`)?.focus();
}
async function deleteChecklistItem(id) {
  if (!state.drawerKey) return;
  clearTimeout(clSaveTimers[id]);
  drawerChecklist = drawerChecklist.filter((c) => String(c.id) !== String(id));
  renderChecklist(drawerChecklist);
  try { await api('DELETE', `/api/tasks/${seg(state.drawerKey)}/checklist/${seg(id)}`); } catch {  }
}

export function openLightbox(url) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.innerHTML = `<img src="${esc(url)}" alt="">`;
  const close = overlayLayer(overlay, { backdrop: false });
  overlay.onclick = close;
  document.body.appendChild(overlay);
}

async function deleteAttachment(attId) {
  if (!state.drawerKey) return;
  await api('DELETE', `/api/tasks/${seg(state.drawerKey)}/attachments/${seg(attId)}`);
  const t = await api('GET', `/api/tasks/${seg(state.drawerKey)}`);
  renderAttachments(t.attachments);
}

export async function uploadAttachment(blob, key = state.drawerKey) {
  if (!key) return;
  try {
    await apiBlob(`/api/tasks/${seg(key)}/attachments`, blob);
  } catch (e) { styledAlert(e.message || tr('could not attach')); return; }
  if (key !== state.drawerKey) return;
  const t = await api('GET', `/api/tasks/${seg(state.drawerKey)}`);
  renderAttachments(t.attachments);
}

export let pendingAttachments = [];
function clearPending() {
  for (const p of pendingAttachments) URL.revokeObjectURL(p.url);
  pendingAttachments = [];
}
function renderPendingAttachments() {
  const box = $('d-attachments');
  if (!pendingAttachments.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.innerHTML = pendingAttachments.map((p, i) =>
    `<div class="attach"><img src="${p.url}" alt="${tr('attachment')}"><span class="attach-x" data-i="${i}" title="${tr('delete')}">×</span></div>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.attach img').forEach((img) => { img.onclick = () => openLightbox(img.getAttribute('src')); });
  box.querySelectorAll('.attach-x').forEach((x) => { x.onclick = () => {
    const i = Number(x.dataset.i);
    URL.revokeObjectURL(pendingAttachments[i].url);
    pendingAttachments.splice(i, 1);
    renderPendingAttachments();
  }; });
}

export function onDrawerPaste(e) {
  const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  const intoComment = e.target.id === 'c-input' && state.drawerKey;
  for (const it of imgs) {
    const blob = it.getAsFile();
    if (!blob) continue;
    if (intoComment) uploadCommentImage(blob);
    else if (state.drawerKey) uploadAttachment(blob);
    else {
      pendingAttachments.push({ blob, url: URL.createObjectURL(blob) });
      renderPendingAttachments();
      scheduleAutosave();
    }
  }
}

async function uploadCommentImage(blob) {
  if (!state.drawerKey) return;
  try {
    await apiBlob(`/api/tasks/${seg(state.drawerKey)}/comments`, blob);
  } catch (e) { styledAlert(e.message || tr('could not attach the screenshot')); return; }
  renderComments(state.drawerKey);
}

function markSelectedCard() {
  document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  if (!state.drawerKey) return;
  const t = state.tasks.find((x) => x.key === state.drawerKey);
  if (t) $('board').querySelector(`.card[data-id="${t.id}"]`)?.classList.add('selected');
}

function kbColumns() {
  return [...document.querySelectorAll('#board .col')]
    .map((col) => ({ status: col.querySelector('.col-body')?.dataset.status, cards: [...col.querySelectorAll('.col-body .card')] }))
    .filter((c) => c.status);
}
function kbFindCursor(cols) {
  if (state.kbCursor == null) return null;
  for (let ci = 0; ci < cols.length; ci++) {
    const ri = cols[ci].cards.findIndex((c) => Number(c.dataset.id) === state.kbCursor);
    if (ri >= 0) return { ci, ri };
  }
  return null;
}
export function markKbCursor() {
  document.querySelectorAll('.card.kb-cursor').forEach((c) => c.classList.remove('kb-cursor'));
  if (state.kbCursor == null) return;
  $('board').querySelector(`.card[data-id="${state.kbCursor}"]`)?.classList.add('kb-cursor');
}
export function setKbCursor(id, scroll = true) {
  state.kbCursor = id;
  markKbCursor();
  if (id != null && scroll) $('board').querySelector(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
export function kbMoveCursor(dr, dc) {
  const cols = kbColumns();
  if (!cols.length) return;
  const pos = kbFindCursor(cols);
  if (!pos) {
    const ci = cols.findIndex((c) => c.cards.length);
    if (ci >= 0) setKbCursor(Number(cols[ci].cards[0].dataset.id));
    return;
  }
  let { ci, ri } = pos;
  if (dr) {
    ri = Math.max(0, Math.min(cols[ci].cards.length - 1, ri + dr));
  } else if (dc) {
    let nci = ci + dc;
    while (nci >= 0 && nci < cols.length && !cols[nci].cards.length) nci += dc;
    if (nci < 0 || nci >= cols.length || !cols[nci].cards.length) return;
    ci = nci;
    ri = Math.min(ri, cols[ci].cards.length - 1);
  }
  setKbCursor(Number(cols[ci].cards[ri].dataset.id));
  syncDrawerToCursor();
}
let cursorDrawerTimer = null;
function syncDrawerToCursor() {
  if (!state.drawerKey || state.kbCursor == null) return;
  clearTimeout(cursorDrawerTimer);
  cursorDrawerTimer = setTimeout(() => {
    if (!state.drawerKey || state.kbCursor == null) return;
    const t = state.tasks.find((x) => x.id === state.kbCursor);
    if (t && t.key !== state.drawerKey) openDrawer(t.key);
  }, 150);
}
const kbBoardSort = (a, b) => b.priority - a.priority || a.position - b.position || a.id - b.id;
export async function kbMoveCard(dr, dc) {
  const t = state.tasks.find((x) => x.id === state.kbCursor);
  if (!t) return;
  if (dr) {
    const sorted = state.tasks.filter((x) => x.status === t.status).sort(kbBoardSort);
    const ri = sorted.findIndex((x) => x.id === t.id);
    const ti = Math.max(0, Math.min(sorted.length - 1, ri + dr));
    if (ti === ri) return;
    const others = sorted.filter((x) => x.id !== t.id);
    const prev = others[ti - 1]?.position ?? 0;
    const next = others[ti]?.position ?? prev + 2;
    await api('PATCH', `/api/tasks/${seg(t.id)}`, { position: (prev + next) / 2 });
  } else if (dc) {
    const cols = kbColumns();
    const ci = cols.findIndex((c) => c.status === t.status);
    if (ci < 0) return;
    let nci = ci + dc;
    while (nci >= 0 && nci < cols.length && WORKING.has(cols[nci].status)) nci += dc;
    if (nci < 0 || nci >= cols.length) return;
    const target = cols[nci].status;
    if (!canMoveTo(t.status, target, t)) return;
    await api('PATCH', `/api/tasks/${seg(t.id)}`, { status: target });
  } else return;
  await refresh();
  setKbCursor(t.id);
}

export const commentDrafts = new Map();
export function applyCommentDraft(key) {
  const box = $('c-input');
  box.value = (key && commentDrafts.get(key)) || '';
  autoGrow(box);
}

function setDrawerId(key, slug) {
  const el = $('drawer-id');
  const proj = state.projects.find((x) => x.slug === slug);
  el.innerHTML = `${esc(key)} · <span class="drawer-proj" title="${esc(tr('Go to project'))}">${esc(proj?.name || slug)}</span>`;
  el.querySelector('.drawer-proj').onclick = () => selectProject(slug);
}

export function openDrawer(key) {
  if (selectedIds.size) clearSelection();
  if (autosaveTimer && state.drawerKey && state.drawerKey !== key) { clearTimeout(autosaveTimer); autosaveTimer = null; doAutosave(); }
  api('GET', `/api/tasks/${seg(key)}`).then((t) => {
    state.drawerKey = t.key;
    $('drawer').classList.remove('is-empty');
    $('d-project').classList.add('hidden');
    setDrawerLock(WORKING.has(t.status) && !taskIsNoclaude(t));
    setDrawerId(t.key, t.project);
    $('d-title').value = t.title;
    $('d-desc').value = t.description || '';
    drawerStatus = t.status;
    buildStatusSelect(t.status, false, taskIsNoclaude(t));
    buildPrioritySelect(t.priority);
    drawerLabels = t.labels;
    drawerPinned = t.pinned || 0;
    renderDrawerLabels();
    renderDrawerLinks(t.links);
    renderIssueRow(t);
    $('d-return').classList.toggle('hidden', t.status !== 'review');
    $('d-accept-btn').classList.toggle('hidden', t.status !== 'review');
    $('d-return-icon').classList.toggle('hidden', !['review', 'done'].includes(t.status));
    closeReturnPop();
    $('comments-block').classList.remove('hidden');
    renderComments(t.key);
    renderAttachments(t.attachments);
    renderChecklist(t.checklist);
    $('drawer').classList.remove('hidden');
    applyCommentDraft(t.key);
    renderTimeline(t);
    autoGrow($('d-title'));
    markSelectedCard();
    scheduleDrawLinks();
    const card = $('board').querySelector(`.card[data-id="${t.id}"]`);
    if (card) requestAnimationFrame(() => card.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
  });
}

export function openDrawerNew(status = 'backlog') {
  if (selectedIds.size) clearSelection();
  state.drawerKey = null;
  markSelectedCard();
  state.drawerProject = state.slug === ALL ? null : state.slug;
  $('drawer').classList.remove('is-empty');
  setDrawerLock(false);
  if (state.slug === ALL) {
    buildSelect($('d-project'), { value: state.projects[0]?.slug, options: state.projects.map((p) => ({ value: p.slug, label: p.slug })) });
    $('d-project').classList.remove('hidden');
  } else {
    $('d-project').classList.add('hidden');
  }
  $('drawer-id').textContent = `${tr('new')} · ${state.slug === ALL ? tr('pick a project') : (currentProject()?.name || state.slug)}`;
  $('d-title').value = '';
  $('d-desc').value = '';
  drawerStatus = status;
  buildStatusSelect(status, true);
  buildPrioritySelect(0);
  drawerLabels = [];
  renderDrawerLabels();
  $('d-links').classList.add('hidden');
  $('d-issue-row').innerHTML = '';
  $('d-return').classList.add('hidden');
  $('d-accept-btn').classList.add('hidden');
  $('d-return-icon').classList.add('hidden');
  $('drawer-menu').classList.add('hidden');
  $('d-timeline').classList.add('hidden');
  clearPending();
  renderPendingAttachments();
  renderChecklist([]);
  $('comments').innerHTML = '';
  $('comments-block').classList.add('hidden');
  $('drawer').classList.remove('hidden');
  applyCommentDraft(null);
  scheduleDrawLinks();
  autoGrow($('d-title'));
  $('d-title').focus();
}

export function closeDrawer() {
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; if (state.drawerKey) doAutosave(); }
  closeDrawerMenu();
  closeReturnPop();
  state.drawerKey = null;
  drawerStatus = null;
  closeLabelPicker();
  clearPending();
  markSelectedCard();
  if (getSetting('keepDrawer')) { $('drawer').classList.remove('hidden'); $('drawer').classList.add('is-empty'); $('drawer-id').textContent = ''; }
  else $('drawer').classList.add('hidden');
  scheduleDrawLinks();
}

export function applyKeepDrawer() {
  if (state.drawerKey) return;
  if (getSetting('keepDrawer')) { $('drawer').classList.remove('hidden'); $('drawer').classList.add('is-empty'); $('drawer-id').textContent = ''; }
  else { $('drawer').classList.add('hidden'); $('drawer').classList.remove('is-empty'); }
  scheduleDrawLinks();
}

function closeDrawerMenu() {
  popLayer('drawer-menu-pop');
  $('drawer-menu-pop')?.remove();
  document.removeEventListener('click', drawerMenuOutside);
}
function drawerMenuOutside(e) {
  if (!e.target.closest('#drawer-menu-pop') && e.target.id !== 'drawer-menu') closeDrawerMenu();
}
export function openDrawerMenu() {
  if ($('drawer-menu-pop')) { closeDrawerMenu(); return; }
  if (!state.drawerKey) return;
  const pinned = state.tasks.find((x) => x.key === state.drawerKey)?.pinned ?? drawerPinned;
  pushLayer('drawer-menu-pop', closeDrawerMenu);
  const menu = document.createElement('div');
  menu.className = 'drawer-menu-pop';
  menu.id = 'drawer-menu-pop';
  menu.innerHTML = `<div class="dm-item" data-act="subtask">${tr('Add subtask')}</div>`
    + `<div class="dm-item" data-act="parent">${tr('Link parent task')}</div>`
    + `<div class="dm-item" data-act="pin">${pinned ? tr('Unpin') : tr('Pin')}</div>`
    + '<div class="dm-sep"></div>'
    + `<div class="dm-item" data-act="cancel">${tr('Cancel task')}</div>`
    + `<div class="dm-item dm-danger" data-act="delete">${tr('Delete')}</div>`;
  document.body.appendChild(menu);
  const r = $('drawer-menu').getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  requestAnimationFrame(() => menu.classList.add('open'));
  menu.querySelector('[data-act="subtask"]').onclick = () => { closeDrawerMenu(); openLinkPicker('child', state.drawerKey); };
  menu.querySelector('[data-act="parent"]').onclick = () => { closeDrawerMenu(); openLinkPicker('parent', state.drawerKey); };
  menu.querySelector('[data-act="pin"]').onclick = () => togglePinTask(state.drawerKey);
  menu.querySelector('[data-act="cancel"]').onclick = () => cancelTask(state.drawerKey);
  menu.querySelector('[data-act="delete"]').onclick = () => deleteTask(state.drawerKey);
  setTimeout(() => document.addEventListener('click', drawerMenuOutside), 0);
}

async function togglePinTask(key) {
  closeDrawerMenu(); closeCardMenu();
  if (!key) return;
  const cur = (key === state.drawerKey) ? { pinned: drawerPinned } : state.tasks.find((x) => x.key === key);
  const next = cur?.pinned ? 0 : 1;
  await api('PATCH', `/api/tasks/${seg(key)}`, { pinned: next });
  if (key === state.drawerKey) drawerPinned = next;
  await refresh();
}

function openLinkPicker(rel, key) {
  if (!key) return;
  const cur = state.tasks.find((x) => x.key === key);
  const project = cur?.project || (![ALL, DASH, SETTINGS].includes(state.slug) ? state.slug : null);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal lp-modal">
    <div class="modal-title">${rel === 'parent' ? tr('Link a parent task') : rel === 'related' ? tr('Link a task') : tr('Add a subtask')}</div>
    <input class="modal-input" id="lp-input" placeholder="${tr('Search, or the title of a new task…')}" autocomplete="off">
    <div class="lp-results" id="lp-results"></div>
    <div class="modal-err hidden" id="lp-err"></div>
  </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#lp-input');
  const results = overlay.querySelector('#lp-results');
  const errEl = overlay.querySelector('#lp-err');
  const close = overlayLayer(overlay);
  const fail = (m) => { errEl.textContent = m; errEl.classList.remove('hidden'); };
  async function link(otherKey) {
    try { const links = await api('POST', `/api/tasks/${seg(key)}/links`, { key: otherKey, rel }); if (key === state.drawerKey) renderDrawerLinks(links); }
    catch (e) { fail(e.message); return; }
    close(); await refresh();
  }
  async function create(title) {
    if (!project) { fail(tr('pick a project first')); return; }
    let created;
    try { created = await api('POST', '/api/tasks', { project, title, status: 'backlog' }); }
    catch (e) { fail(e.message); return; }
    await link(created.key);
    openDrawer(created.key);
  }
  let activeIdx = -1;
  const opts = () => [...results.querySelectorAll('.lp-opt')];
  function highlight() {
    const its = opts();
    its.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0 && its[activeIdx]) its[activeIdx].scrollIntoView({ block: 'nearest' });
  }
  function render() {
    const q = input.value.trim();
    const ql = q.toLowerCase();
    const matches = state.tasks
      .filter((t) => t.key !== key && (!ql || t.title.toLowerCase().includes(ql) || t.key.toLowerCase().includes(ql)))
      .slice(0, 8);
    let html = matches.map((t) =>
      `<div class="lp-opt" data-key="${t.key}"><span class="dot s-${t.status}"></span><span class="lp-key">${t.key}</span><span class="lp-title">${esc(t.title)}</span></div>`).join('');
    if (q) html += `<div class="lp-opt lp-create" data-create="1">+ ${tr('Create')} "${esc(q)}"</div>`;
    if (!html) html = `<div class="lp-empty">${tr('nothing found')}</div>`;
    results.innerHTML = html;
    results.querySelectorAll('.lp-opt[data-key]').forEach((o) => { o.onclick = () => link(o.dataset.key); });
    const cr = results.querySelector('[data-create]');
    if (cr) cr.onclick = () => create(input.value.trim());
    activeIdx = opts().length ? 0 : -1;
    highlight();
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    const its = opts();
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(its.length - 1, activeIdx + 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); highlight(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && its[activeIdx]) its[activeIdx].click();
      else { const q = input.value.trim(); if (q) create(q); }
    }
  });
  render();
  input.focus();
}
export async function cancelTask(key) {
  closeDrawerMenu(); closeCardMenu();
  if (key && await styledConfirm(tr('Cancel the task? The issue will be closed as not planned.'), { okLabel: tr('Cancel the task') })) {
    await api('PATCH', `/api/tasks/${seg(key)}`, { status: 'cancelled' });
    if (key === state.drawerKey) closeDrawer();
    await refresh();
  }
}
async function duplicateTask(key) {
  closeDrawerMenu(); closeCardMenu();
  if (!key) return;
  try {
    const t = await api('POST', `/api/tasks/${seg(key)}/duplicate`);
    await refresh();
    if (t?.key) openDrawer(t.key);
  } catch (e) { styledAlert(`${tr('Could not duplicate')}: ${e.message}`); }
}
export async function deleteTask(key) {
  closeDrawerMenu(); closeCardMenu();
  if (key && await styledConfirm(tr('Delete the task permanently (comments included)?'), { okLabel: tr('Delete'), danger: true })) {
    await api('DELETE', `/api/tasks/${seg(key)}`);
    if (key === state.drawerKey) closeDrawer();
    await refresh();
  }
}

function closeCardMenu() {
  popLayer('card-menu');
  $('card-menu')?.remove();
  document.removeEventListener('click', cardMenuOutside);
  document.removeEventListener('keydown', cardMenuKey);
}
function cardMenuOutside(e) { if (!e.target.closest('#card-menu')) closeCardMenu(); }
function cardMenuKey(e) { if (e.key === 'Escape') closeCardMenu(); }
export function openCardMenu(e, t) {
  e.preventDefault();
  closeCardMenu(); closeDrawerMenu();
  pushLayer('card-menu', closeCardMenu);
  const menu = document.createElement('div');
  menu.className = 'drawer-menu-pop card-menu';
  menu.id = 'card-menu';
  document.body.appendChild(menu);
  const cx = e.clientX; const cy = e.clientY;
  const clamp = () => {
    let left = cx; let top = cy;
    if (left + menu.offsetWidth > window.innerWidth - 8) left = window.innerWidth - menu.offsetWidth - 8;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = window.innerHeight - menu.offsetHeight - 8;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  };
  const setField = async (body) => { await api('PATCH', `/api/tasks/${seg(t.key)}`, body); await refresh(); };
  const backRow = `<div class="dm-item dm-back" data-back="1">${tr('‹ Back')}</div><div class="dm-sep"></div>`;

  function renderMain() {
    menu.innerHTML = `<div class="dm-item" data-act="status">${tr('Status')}<span class="dm-chev">›</span></div>`
      + `<div class="dm-item" data-act="priority">${tr('Priority')}<span class="dm-chev">›</span></div>`
      + `<div class="dm-item" data-act="labels">${tr('Labels')}<span class="dm-chev">›</span></div>`
      + '<div class="dm-sep"></div>'
      + `<div class="dm-item" data-act="subtask">${tr('Add subtask')}</div>`
      + `<div class="dm-item" data-act="parent">${tr('Link parent task')}</div>`
      + `<div class="dm-item" data-act="pin">${t.pinned ? tr('Unpin') : tr('Pin')}</div>`
      + `<div class="dm-item" data-act="duplicate">${tr('Duplicate')}</div>`
      + '<div class="dm-sep"></div>'
      + `<div class="dm-item" data-act="copy">${tr('Copy link')}</div>`
      + '<div class="dm-sep"></div>'
      + `<div class="dm-item" data-act="cancel">${tr('Cancel task')}</div>`
      + `<div class="dm-item dm-danger" data-act="delete">${tr('Delete')}</div>`;
    const it = (a) => menu.querySelector(`[data-act="${a}"]`);
    it('status').onclick = (ev) => { ev.stopPropagation(); renderSub('status'); };
    it('priority').onclick = (ev) => { ev.stopPropagation(); renderSub('priority'); };
    it('labels').onclick = (ev) => { ev.stopPropagation(); renderSub('labels'); };
    it('subtask').onclick = () => { closeCardMenu(); openLinkPicker('child', t.key); };
    it('parent').onclick = () => { closeCardMenu(); openLinkPicker('parent', t.key); };
    it('pin').onclick = () => togglePinTask(t.key);
    it('duplicate').onclick = () => { closeCardMenu(); duplicateTask(t.key); };
    it('copy').onclick = () => { closeCardMenu(); copyTaskLink(t); };
    it('cancel').onclick = () => cancelTask(t.key);
    it('delete').onclick = () => deleteTask(t.key);
    clamp();
  }
  function wireBack() { menu.querySelector('[data-back]').onclick = (ev) => { ev.stopPropagation(); renderMain(); }; }
  function renderSub(kind) {
    if (kind === 'status') {
      menu.innerHTML = backRow + ALL_STATUSES.map(([v, lab]) => {
        const dis = Boolean(moveBlocked(t.status, v, { manual: taskIsNoclaude(t) }));
        return `<div class="cm-opt${v === t.status ? ' active' : ''}${dis ? ' disabled' : ''}" data-v="${v}"><span class="dot s-${v}"></span>${lab}</div>`;
      }).join('');
      menu.querySelectorAll('.cm-opt:not(.disabled)').forEach((o) => { o.onclick = async (ev) => { ev.stopPropagation(); const v = o.dataset.v; closeCardMenu(); if (v !== t.status) await setField({ status: v }); }; });
      wireBack(); clamp();
    } else if (kind === 'priority') {
      menu.innerHTML = backRow + PRI_LEVELS.map(([v, lab]) => `<div class="cm-opt${v === t.priority ? ' active' : ''}" data-v="${v}">${lab}</div>`).join('');
      menu.querySelectorAll('.cm-opt').forEach((o) => { o.onclick = async (ev) => { ev.stopPropagation(); const v = Number(o.dataset.v); closeCardMenu(); if (v !== t.priority) await setField({ priority: v }); }; });
      wireBack(); clamp();
    } else {
      let cur = [...(t.labels || [])];
      const drawLabels = () => {
        menu.innerHTML = backRow + LABEL_SELECTABLE.map((name) =>
          `<div class="cm-opt lbl-row${cur.includes(name) ? ' on' : ''}" data-name="${name}"><span class="lbl-dot" style="width:9px;height:9px;border-radius:50%;background:${LABEL_COLORS[name]}"></span>${esc(name)}${cur.includes(name) ? '<span class="dm-chev">✓</span>' : ''}</div>`).join('');
        menu.querySelectorAll('.lbl-row').forEach((o) => { o.onclick = async (ev) => { ev.stopPropagation(); const n = o.dataset.name; cur = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]; t.labels = cur; drawLabels(); await setField({ labels: cur }); }; });
        wireBack(); clamp();
      };
      drawLabels();
    }
  }
  renderMain();
  requestAnimationFrame(() => menu.classList.add('open'));
  setTimeout(() => { document.addEventListener('click', cardMenuOutside); document.addEventListener('keydown', cardMenuKey); }, 0);
}

async function copyTaskLink(t) {
  await copyText(t.gh_issue_url || t.key);
}

function closeReturnPop() {
  popLayer('return-pop');
  $('return-pop')?.remove();
  document.removeEventListener('click', returnPopOutside);
}
function returnPopOutside(e) {
  if (!e.target.closest('#return-pop') && e.target.id !== 'd-return-icon') closeReturnPop();
}
export function openReturnPop() {
  if ($('return-pop')) { closeReturnPop(); return; }
  if (!state.drawerKey) return;
  pushLayer('return-pop', closeReturnPop);
  const pop = document.createElement('div');
  pop.className = 'return-pop';
  pop.id = 'return-pop';
  pop.innerHTML = `<input class="return-pop-input" placeholder="${tr('What is wrong? (goes into the task)')}">`
    + `<button class="return-pop-btn btn-ghost">${tr('↩ Send back to work')}</button>`;
  document.body.appendChild(pop);
  const r = $('d-return-icon').getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  requestAnimationFrame(() => pop.classList.add('open'));
  const input = pop.querySelector('.return-pop-input');
  pop.querySelector('.return-pop-btn').onclick = () => doReturn(input.value.trim());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doReturn(input.value.trim()); });
  setTimeout(() => { document.addEventListener('click', returnPopOutside); input.focus(); }, 0);
}
async function doReturn(reason) {
  if (!state.drawerKey) return;
  const key = state.drawerKey;
  if (reason) await api('POST', `/api/tasks/${seg(key)}/comments`, { body: `${tr('Send back')}: ${reason}`, author: 'me' });
  await api('PATCH', `/api/tasks/${seg(key)}`, { status: 'todo' });
  closeReturnPop();
  await refresh();
  openDrawer(key);
}

export async function syncOpenDrawerStatus() {
  if (!state.drawerKey) return;
  let t = state.tasks.find((x) => x.key === state.drawerKey);
  if (!t) { try { t = await api('GET', `/api/tasks/${seg(state.drawerKey)}`); } catch { return; } }
  if (!t) return;
  if (!DrawerSync.shouldSyncDrawerStatus(drawerStatus, selVal('d-status'), t.status)) return;
  drawerStatus = t.status;
  buildStatusSelect(t.status, false, drawerLabels.includes('noclaude'));
  $('d-return').classList.toggle('hidden', t.status !== 'review');
  $('d-return-icon').classList.toggle('hidden', !['review', 'done'].includes(t.status));
  $('d-accept-btn').classList.toggle('hidden', t.status !== 'review');
  const willLock = (t.status === 'doing' || t.status === 'deploy') && !taskIsNoclaude(t);
  if (willLock && autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; await doAutosave(); }
  setDrawerLock(willLock);
}

let autosaveTimer = null;
function newTaskHasContent() {
  return $('d-title').value.trim() || $('d-desc').value.trim() || pendingAttachments.length;
}
export function scheduleAutosave() {
  if (!state.drawerKey && !createInFlight && newTaskHasContent()) { doAutosave(); return; }
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(doAutosave, 450);
}
export async function doAutosave() {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  if (drawerLocked || $('drawer').classList.contains('hidden')) return;
  const title = $('d-title').value.trim();
  const description = $('d-desc').value;
  const common = {
    description,
    priority: Number(selVal('d-priority')),
    labels: drawerLabels,
    status: selVal('d-status'),
  };
  if (state.drawerKey) {
    await api('PATCH', `/api/tasks/${seg(state.drawerKey)}`, title ? { ...common, title } : common);
    return;
  }
  if (!title && !description.trim() && !pendingAttachments.length) return;
  if (createInFlight) return;
  const project = state.drawerProject || selVal('d-project');
  if (!project) return;
  const wasOpenOnNew = !$('drawer').classList.contains('hidden') && !state.drawerKey;
  const pend = [...pendingAttachments];
  let created;
  createInFlight = true;
  try {
    created = await api('POST', '/api/tasks', { project, title, ...common });
  } finally {
    createInFlight = false;
  }
  if (wasOpenOnNew && !state.drawerKey) {
    state.drawerKey = created.key;
    drawerStatus = created.status;
    setDrawerId(created.key, created.project);
    $('d-project').classList.add('hidden');
    $('comments-block').classList.remove('hidden');
    renderComments(created.key);
    $('drawer-menu').classList.remove('hidden');
    renderChecklist([]);
  }
  for (const p of pend) await uploadAttachment(p.blob, created.key);
  clearPending();
  if (wasOpenOnNew) { scrollToNewCardId = created.id; setTimeout(() => { scrollToNewCardId = null; }, 900); }
  await refresh();
}
