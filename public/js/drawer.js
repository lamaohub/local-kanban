
import { WORKING, buildSelect, canMoveTo, clearSelection, closeOpenSelect, colSort, labelChip, moveBlocked, revealCard, scheduleDrawLinks, selVal, selectTasks, selectedIds, setScrollToNewCardId, taskIsNoclaude } from './board.js';
import { $, ALL, ALL_STATUSES, LABEL_COLORS, LABEL_SELECTABLE, PRI_LEVELS, TITLE_LABEL_WORDS, api, apiBlob, dropUnsaved, esc, ghSyncOn, ic, noteUnsaved, seg, state, tr } from './core.js';
import { columnComparator, DEFAULT_SORT } from './order.js';
import { mountChat } from './chat.js';
import { getSetting, openSettingsModal, plural, setClaudeView } from './settings.js';
import { NARROW, closeTopLayer, currentProject, layersOpen, overlayLayer, popLayer, pushLayer, selectProject, styledAlert, styledConfirm, watchLayers } from './sidebar.js';
import { SHORT_MONTHS, askUsageNow, autoGrow, claudeInfoHTML, copyText, onClaudeInfo, launchInClaude, openSessionInClaude, refresh, relTime, renderTimeline, resumeOnBoard, taskPromptText } from './sse.js';
import { canRetry, changedFields, createTurns, createUnsentComments, createUnsentEdits, imageTooLarge, pullExternal, refusalLine, refusalText, resendDelay } from './unsaved.js';
import { renderAsks } from './asks.js';
import { stillOpen } from './review-rules.js';
import { wireTermCopy } from './term-copy.js';
import { termSuggestion, withPath } from './term-input-rules.js';
import { holdUntil, reprinted } from './term-reprint.js';
import { localStore } from './store.js';

/* ── Drawer ── */
let drawerLabels = [];
let drawerLinks = [];
let drawerLocked = false;
let drawerStatus = null;
let drawerPinned = 0;
let creatingForm = null;
let newFormId = 0;
let formCreated = { form: 0, key: null };
const drawerShown = () => !$('drawer').classList.contains('hidden') && !$('drawer').classList.contains('is-empty');
let drawerSnapshot = null;
let drawerFresh = null;
const fieldsSnapshot = (t) => ({
  title: t.title || '', description: t.description || '', priority: t.priority, labels: [...(t.labels || [])], status: t.status,
});
const drawerForm = () => ({
  title: $('d-title').value.trim(), description: $('d-desc').value,
  priority: Number(selVal('d-priority')), labels: drawerLabels, status: selVal('d-status'),
});

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
      launchFollowsLabels();
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
    if (drawerLocked) return; // a locked card saves nothing: the toggle would only pretend
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
  if (drawerTask) renderLaunchButtons({ ...drawerTask, status: v, labels: drawerLabels });
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
// The label, link and checklist controls are drawn for one lock state, so a flip redraws them;
// `redraw: false` is for a caller that draws them itself right after.
function setDrawerLock(locked, { redraw = true } = {}) {
  const changed = locked !== drawerLocked;
  drawerLocked = locked;
  for (const id of LOCKABLE) $(id).disabled = locked;
  ['d-status', 'd-priority', 'd-project'].forEach((id) => $(id).classList.toggle('kbsel-locked', locked));
  $('d-lock-note').classList.toggle('hidden', !locked);
  $('drawer-menu').classList.toggle('hidden', !state.drawerKey);
  if (locked) closeLabelPicker(); // its chip is gone, and a locked card would not save the choice
  // a link was made, Pin went through, on a card that had just locked
  if (locked) { closeDrawerMenu(); closeLinkPickerOf(state.drawerKey); }
  else if (changed) fillDrawerMenu();
  if (redraw && changed && state.drawerKey) {
    renderDrawerLabels();
    renderDrawerLinks(drawerLinks);
    renderChecklist(drawerChecklist);
  }
}

function openLabelPicker(e) {
  closeLabelPicker();
  if (drawerLocked) return;
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
      if (drawerLocked) return;
      drawerLabels = drawerLabels.includes(name) ? drawerLabels.filter((l) => l !== name) : [...drawerLabels, name];
      renderDrawerLabels();
      opt.querySelector('input').checked = drawerLabels.includes(name);
      doAutosave();
      if (name === 'noclaude' && state.drawerKey) {
        buildStatusSelect(drawerStatus, false, drawerLabels.includes('noclaude'));
        setDrawerLock(DrawerSync.cardLocked(drawerStatus, drawerLabels));
        launchFollowsLabels();
      }
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
  drawerLinks = links || [];
  const box = $('d-links');
  box.innerHTML = drawerLinks.map((l) =>
    `<span class="link-chip rel-${l.rel || 'related'}" title="${REL_TITLE[l.rel] || tr('related')}: ${esc(l.title)}"><span class="dot s-${l.status}"></span>${REL_MARK[l.rel] || ''}${esc(l.key)}`
    + (drawerLocked ? '' : `<span class="link-x" data-other="${l.id}" title="${esc(tr('remove link'))}">×</span>`) + '</span>',
  ).join('') + (drawerLocked ? '' : `<span class="link-chip link-add" id="link-add">${tr('+ link')}</span>`);
  box.classList.remove('hidden');
  if (drawerLocked) return;
  $('link-add').onclick = () => { if (!drawerLocked) openLinkPicker('related', state.drawerKey); };
  box.querySelectorAll('.link-x').forEach((x) => { x.onclick = (e) => { e.stopPropagation(); if (!drawerLocked) deleteLink(x.dataset.other); }; });
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
  const key = state.drawerKey;
  if (!key) return;
  let links;
  try { links = await api('DELETE', `/api/tasks/${seg(key)}/links/${seg(otherId)}`); } catch (e) {
    sayRefused(e, key);
    if (e?.status === 404 && !refusalText(e).gone) redrawLinks(key);
    return;
  }
  if (key === state.drawerKey) renderDrawerLinks(links);
  await refresh();
}
async function redrawLinks(key) {
  let t;
  try { t = await api('GET', `/api/tasks/${seg(key)}`, undefined, { quiet: true }); } catch { return; }
  if (key === state.drawerKey && !drawerLocked) renderDrawerLinks(t.links);
}

const COMMENT_AUTHORS = { claude: () => `${ic('bot', 12)} claude`, git: () => `${ic('git', 12)} git`, me: () => `${ic('person', 12)} ${tr('me')}`, board: () => `${ic('lock', 12)} ${tr('answer to Claude')}` };

let commentsShown = { of: null, whole: false, ids: new Set(), max: 0 }; // what the list on screen holds
let commentsRead = null; // the read on its way: { key, again, done }
let commentsRetry = { timer: null, n: 0, key: null };
let commentsBlank = null;
const COMMENTS_BLANK_MS = 200; // a slow read of another task's comments: its list does not stand under this one

export function renderComments(key) {
  if (state.drawerKey !== key) return Promise.resolve(); // the «Try now» of a card left behind must not stop the open one's read
  if (commentsRead?.key === key) { commentsRead.again = true; return commentsRead.done; }
  clearTimeout(commentsRetry.timer);
  commentsRetry.timer = null;
  if (commentsShown.of !== key) {
    clearTimeout(commentsBlank);
    commentsBlank = setTimeout(() => { if (commentsShown.of !== key && state.drawerKey === key) drawComments(key, null); }, COMMENTS_BLANK_MS);
  }
  const read = { key, again: true, done: null };
  commentsRead = read;
  read.done = (async () => {
    try {
      while (read.again && commentsRead === read && state.drawerKey === key) { read.again = false; await readComments(read); }
    } finally { if (commentsRead === read) commentsRead = null; }
  })();
  return read.done;
}
async function readComments(read) {
  const { key } = read;
  let cs;
  try { cs = await api('GET', `/api/tasks/${seg(key)}/comments`, undefined, { quiet: true }); } catch (e) {
    if (commentsRead !== read || state.drawerKey !== key) return;
    if (commentsShown.of !== key) drawComments(key, null);
    commentsShown.whole = false;
    commentsFailed(key, e);
    return;
  }
  if (commentsRead !== read || state.drawerKey !== key) return;
  commentsRetry.n = 0;
  drawComments(key, cs);
}
// null — no list: the comments of `key` are not known yet
function drawComments(key, cs) {
  clearTimeout(commentsBlank);
  const box = $('comments');
  box.innerHTML = (cs || []).map(commentHTML).join('');
  commentsShown = { of: cs ? key : null, whole: Boolean(cs), ids: new Set((cs || []).map((c) => c.id)), max: Math.max(0, ...(cs || []).map((c) => c.id)) };
  wireComments(box);
  paintUnsent(key);
}
function commentHTML(c) {
  return `
    <div class="comment" data-id="${c.id}">
      <div class="comment-meta"><span>${(COMMENT_AUTHORS[c.author] || COMMENT_AUTHORS.me)()} · <span class="comment-time" data-at="${esc(c.created_at)}">${relTime(c.created_at)}</span></span>
        <span class="comment-del" data-del="${c.id}" title="${tr('Delete the comment')}">×</span></div>
      ${c.body ? `<div class="comment-body">${esc(c.body)}</div>` : ''}
      ${c.image_url ? `<img class="comment-img" src="${c.image_url}" data-url="${c.image_url}" alt="${tr('screenshot')}" loading="lazy">` : ''}
    </div>`;
}
function wireComments(box) {
  box.querySelectorAll('.comment-img').forEach((img) => { img.onclick = () => openLightbox(img.dataset.url); });
  box.querySelectorAll('.comment-del[data-del]').forEach((x) => { x.onclick = () => deleteComment(x.dataset.del); }); // not the × of an unsent one
}
function commentsFailed(key, e) {
  const box = $('comments');
  box.querySelector('.comments-note')?.remove();
  box.insertAdjacentHTML('afterbegin', `<div class="board-note comments-note"><span>${esc(refusalLine('The comments did not load', e, tr))}</span><button type="button" class="btn-ghost board-note-retry">${esc(tr('Try now'))}</button></div>`);
  const btn = box.querySelector('.comments-note button');
  if (btn) btn.onclick = () => renderComments(key);
  if (!canRetry(e)) return; // a refusal (the task is gone) is not cured by asking again
  clearTimeout(commentsRetry.timer);
  if (commentsRetry.key !== key) commentsRetry = { timer: null, n: 0, key }; // another card starts from the shortest wait
  commentsRetry.timer = setTimeout(() => { commentsRetry.timer = null; if (state.drawerKey === key) renderComments(key); }, resendDelay(commentsRetry.n++));
}
/** A comment of task `key` is known to be on the server — its event came, or the answer to the person's own.
    `c` — the comment, when it is known (a deleted one is not); `n` — how many the task holds now, when known. */
export function commentArrived(key, c, n) {
  if (key !== state.drawerKey) return;
  const s = commentsShown;
  if (c && s.of === key && s.whole && !commentsRead) {
    if (s.ids.has(c.id)) return; // the list shows it already
    // newer than all it shows, and nothing missed between (a dropped event would leave a gap the count shows)
    if (c.id > s.max && (n === undefined || n === s.ids.size + 1)) {
      const box = $('comments');
      const before = box.querySelector('.comment.unsent');
      if (before) before.insertAdjacentHTML('beforebegin', commentHTML(c)); else box.insertAdjacentHTML('beforeend', commentHTML(c));
      s.ids.add(c.id);
      s.max = c.id;
      wireComments(box);
      return;
    }
  }
  renderComments(key);
}
export function showOwnComment(key, id) {
  if (key !== state.drawerKey) return;
  const form = $('c-input')?.closest('.comment-form');
  if (!form?.offsetParent) return; // the comments are not on screen (the card shows Claude's chat)
  const go = () => {
    if (state.drawerKey !== key) return;
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    form.scrollIntoView({ block: 'end', behavior: still ? 'auto' : 'smooth' });
  };
  go();
  const img = $('comments').querySelector(`.comment[data-id="${CSS.escape(String(id))}"] .comment-img`);
  if (img && !img.complete) img.addEventListener('load', go, { once: true });
}
/** The comment box was emptied for a form without a task (the form «+»). */
function clearComments() {
  clearTimeout(commentsBlank);
  $('comments').innerHTML = '';
  commentsShown = { of: null, whole: false, ids: new Set(), max: 0 };
}

function refreshCommentTimes() {
  if (document.hidden || !state.drawerKey) return;
  document.querySelectorAll('#comments .comment-time[data-at]').forEach((el) => {
    const t = relTime(el.dataset.at);
    if (el.textContent !== t) el.textContent = t;
  });
}
setInterval(refreshCommentTimes, 30000);
document.addEventListener('visibilitychange', refreshCommentTimes);

const unsentComments = createUnsentComments();
export function queueComment(key, body) {
  const c = unsentComments.add(key, body);
  noteUnsaved(c.again ? null : () => resendComment(key, c.id), `comment:${key}:${c.id}`);
  paintUnsent(key);
}
async function resendComment(key, id) {
  const c = unsentComments.get(key, id);
  if (!c) return; // the person took it back
  let sent;
  try {
    sent = await api('POST', `/api/tasks/${seg(key)}/comments`, { body: c.body, author: 'me' });
  } catch (e) {
    // refused (the task is gone): it will never go — the retry queue drops it too
    if (!canRetry(e)) { unsentComments.done(key, id); paintUnsent(key); }
    throw e;
  }
  unsentComments.done(key, id);
  paintUnsent(key);
  commentArrived(key, sent);
}
function paintUnsent(key) {
  if (key !== state.drawerKey) return;
  const box = $('comments');
  box.querySelectorAll('.comment.unsent').forEach((el) => el.remove());
  box.insertAdjacentHTML('beforeend', unsentComments.list(key).map((c) => `
    <div class="comment unsent" data-unsent="${c.id}">
      <div class="comment-meta"><span>${COMMENT_AUTHORS.me()} · <span class="comment-wait">${esc(tr('not sent — goes out once the connection is back'))}</span></span>
        <span class="comment-del" data-drop="${c.id}" title="${esc(tr('Do not send'))}">×</span></div>
      <div class="comment-body">${esc(c.body)}</div>
    </div>`).join(''));
  box.querySelectorAll('.comment.unsent [data-drop]').forEach((x) => { x.onclick = () => dropUnsentComment(key, Number(x.dataset.drop)); });
}
function dropUnsentComment(key, id) {
  unsentComments.done(key, id);
  dropUnsaved(`comment:${key}:${id}`);
  paintUnsent(key);
}

export function sayRefused(e, key) {
  const r = refusalText(e);
  styledAlert(tr(r.text));
  if (r.gone && key === state.drawerKey) closeDrawer();
  if (r.refresh) refresh();
}

let drawerTask = null;
function renderLaunchButtons(t) {
  if (t.sessions) drawerTask = { key: t.key, project: t.project, sessions: t.sessions };
  else if (drawerTask?.key !== t.key) drawerTask = { key: t.key, project: t.project, sessions: [] };
  drawerTask.status = t.status;
  drawerTask.labels = t.labels || [];
  const running = termKey === t.key && termInfo && !termInfo.dead;
  const startable = ['backlog', 'todo'].includes(t.status) && !drawerTask.labels.includes('noclaude') && !running;
  $('d-launch').classList.toggle('hidden', !startable);
  $('d-session').classList.toggle('hidden', !drawerTask.sessions.length);
  if (termKey === t.key) hintCardTerm();
}
function launchFollowsLabels() {
  if (drawerTask && drawerTask.key === state.drawerKey) renderLaunchButtons({ ...drawerTask, labels: drawerLabels });
}
export function launchOpenTask() {
  if (drawerTask) launchInClaude({ text: taskPromptText(drawerTask.key), project: drawerTask.project, keys: [drawerTask.key], btn: $('d-launch') });
}
export function openOpenTaskSession() {
  if (termInfo && termKey === drawerTask?.key) { saveTab('terminal'); showWorkTab('terminal'); return; }
  const ss = drawerTask?.sessions || [];
  if (!ss.length) return;
  const s = ss.reduce((a, b) => (String(b.last_seen) > String(a.last_seen) ? b : a));
  openSessionInClaude({ session: s.session_id, host: s.host_session, project: drawerTask.project, btn: $('d-session') });
}

const TAB_KEY = 'kb.ui.drawerTab';
let workKey = null;       // the task whose chat is on screen
let cardChat = null;      // the chat mounted into #work (chat.js), made on the first use

const savedTab = () => { try { const v = localStore.getItem(TAB_KEY); return v === 'work' || v === 'chat' ? 'chat' : v === 'terminal' ? v : 'comments'; } catch { return 'comments'; } };
const saveTab = (tab) => { try { localStore.setItem(TAB_KEY, tab); } catch {  } };

function showWorkTab(tab) {
  const tabs = $('d-tabs');
  const has = (x) => !tabs.classList.contains('hidden') && Boolean(tabs.querySelector(`[data-tab="${x}"]`));
  const cur = has(tab) ? tab : tab === 'terminal' && has('chat') ? 'chat' : tab === 'chat' && has('terminal') ? 'terminal' : 'comments';
  tabs.querySelectorAll('.dr-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === cur));
  $('comments-block').classList.toggle('hidden', cur !== 'comments');
  $('work-block').classList.toggle('hidden', cur !== 'chat');
  cardChat?.show(cur === 'chat');
  $('term-block').classList.toggle('hidden', cur !== 'terminal');
  if (cur === 'terminal') startTermPoll(); else stopTermPoll();
}

export function hideWorkTabs() {
  workKey = null;
  termKey = null;
  termInfo = null;
  termSeen = null;
  stopTermPoll();
  cardChat?.show(false);
  $('d-tabs').classList.add('hidden');
  $('work-block').classList.add('hidden');
  $('term-block').classList.add('hidden');
}

export const claudeView = () => (getSetting('chatView') === 'chat' ? 'chat' : 'terminal');
let chatTab = false; // the open card has the Chat tab
let tabsTask = null; // {key, sessions, status, terminal} the tabs were drawn for — to draw them again on the switch
function renderWorkTabs(t) {
  const term = t.terminal || null;
  const asTerm = Boolean(term) && claudeView() === 'terminal';
  chatTab = !asTerm && ((t.sessions || []).length > 0 || Boolean(term));
  tabsTask = { key: t.key, sessions: t.sessions, status: t.status, terminal: term };
  if (!asTerm && !chatTab) { hideWorkTabs(); $('comments-block').classList.remove('hidden'); return; }
  if (termKey !== t.key) { termScreen = null; termFollow = true; }
  workKey = t.key;
  termKey = term ? t.key : null;
  termInfo = term;
  const live = term && !term.dead ? '<span class="term-dot" aria-hidden="true"></span>' : '';
  $('d-tabs').innerHTML = '<div class="dash-range" role="tablist">'
    + `<button type="button" class="dr-btn" data-tab="comments" role="tab"><span class="d-tab-l">${tr('Comments')}</span></button>`
    + (chatTab ? `<button type="button" class="dr-btn" data-tab="chat" role="tab"><span class="d-tab-l">${tr('Chat')}</span>${live}</button>` : '')
    + (asTerm ? `<button type="button" class="dr-btn" data-tab="terminal" role="tab"><span class="d-tab-l">${tr('Terminal')}</span>${live}</button>` : '')
    + '</div>';
  $('d-tabs').querySelectorAll('.dr-btn').forEach((b) => { b.onclick = () => { saveTab(b.dataset.tab); showWorkTab(b.dataset.tab); }; });
  $('d-tabs').classList.remove('hidden');
  const claude = asTerm ? 'terminal' : 'chat';
  const want = term && (termOpenNext === t.key || (WORKING.has(t.status) && (!term.dead || term.interrupted))) ? claude : savedTab();
  termOpenNext = null;
  if (asTerm) {
    renderTerminal({ session: term.session, dead: term.dead, exit: term.exit, interrupted: term.interrupted, screen: termScreen ?? '' });
    termSeen = null;
  }
  showWorkTab(want);
  refreshWork(t.key);
}

const TERM_POLL_MS = 1000;
export const TERM_KEYS = [
  { key: 'Enter', label: '↵', title: 'Enter' },
  { key: 'Escape', label: 'Esc', title: 'Esc — interrupt Claude' },
  { key: 'Up', label: '↑', title: 'Up' },
  { key: 'Down', label: '↓', title: 'Down' },
  { text: '1', label: '1', title: 'Choose option 1' },
  { text: '2', label: '2', title: 'Choose option 2' },
  { text: '3', label: '3', title: 'Choose option 3' },
  { key: 'BTab', label: '⇧Tab', title: 'Shift+Tab — switch the permission mode' },
];
let termKey = null;
let termActivity = null;
function hintCardTerm() {
  setTermHint($('term-input'), { key: termKey, status: drawerTask?.key === termKey ? drawerTask.status : null, activity: termActivity });
}
let termInfo = null;
/** The session whose terminal the card shows, once it has looked at it — «Claude now» leaves its window to the card. */
export function cardTermSession() { return termInfo?.session || null; }
let termScreen = null;
let termScreenOf = null;
let termLayout = { wraps: [], cols: 0 };
let termFollow = true;
let termWin = null;
let termWinOf = null; // …and whose window it is: the first look at a terminal learns its width before laying it out
let termHold = 0;
// makes itself (keeping the screen at the bottom, following a rolled window) leaves it at `termOwnTop` and shows nothing
let termOwnTop = -1;
let termBarTimer = null;
const TERM_BAR_MS = 900;
let termTimer = null;
let termChain = 0;
let termSeen = null;
let termReq = 0;
let termOpenNext = null;
const termUntrusted = new Set();
const LOGIN_NEEDED = /Please run \/login|Not logged in|OAuth access token is invalid|Invalid API key|authentication rejected \(401\)/i;
const LOGIN_DONE = /Login successful|Logged in as/i;
const AUTO_OFFER = /^\s*[❯>]?\s*(\d)\.\s+Yes, and switch to auto mode/;
function autoOffer(screen) {
  const lines = screen.split('\n').filter((l) => l.trim());
  if (!/Esc to cancel/.test(lines[lines.length - 1] || '')) return null;
  for (const line of lines.slice(-12)) { const m = line.match(AUTO_OFFER); if (m) return m[1]; }
  return null;
}
function needsLogin(screen) {
  let need = -1;
  let done = -1;
  screen.split('\n').forEach((line, i) => { if (LOGIN_NEEDED.test(line)) need = i; if (LOGIN_DONE.test(line)) done = i; });
  return need > done;
}
const BARE_MODE = /Bare mode does(?:n't| not) use the sign-in/i;
const bareMode = (screen) => BARE_MODE.test(screen || '');
const shortUrl = (u) => {
  let s = u;
  try { const x = new URL(u); s = `${x.host}${x.pathname === '/' ? '' : x.pathname}`; } catch {  }
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
};

export function openTerminalOf(key, { session, trusted } = {}) {
  if (!key) return;
  if (session && trusted === false) termUntrusted.add(session);
  termOpenNext = key;
  openDrawer(key);
}

function termSchedule(ms, chain) { termTimer = setTimeout(() => termTick(chain), ms); }
async function termTick(chain) {
  await pollTerminal();
  if (chain === termChain) termSchedule(TERM_POLL_MS, chain);
}
function startTermPoll() {
  if (termTimer) return;
  termSchedule(0, ++termChain);
}
function stopTermPoll() {
  clearTimeout(termTimer);
  termTimer = null;
  termChain++;
}
/** Look again soon (after typing), and go on from there — not as a second poll beside the chain. */
function termSoon(ms) {
  if (!termTimer) return;
  clearTimeout(termTimer);
  termSchedule(ms, ++termChain);
}

let termFit = { width: 0, cols: null };
function termCols() {
  const pre = $('term-screen');
  const width = pre.clientWidth;
  if (!width) return null;
  if (width === termFit.width) return termFit.cols;
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(100);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  pre.appendChild(probe);
  const ch = probe.getBoundingClientRect().width / 100;
  probe.remove();
  const cs = getComputedStyle(pre);
  const room = width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  termFit = { width, cols: ch > 0 ? Math.max(20, Math.floor(room / ch)) : null };
  return termFit.cols;
}

async function pollTerminal() {
  const key = termKey;
  if (!key || key !== state.drawerKey) { stopTermPoll(); return; }
  if (document.hidden) return;
  const n = ++termReq;
  const cols = termWinOf && termWinOf === termInfo?.session ? termCols() : null;
  const q = new URLSearchParams();
  if (cols) q.set('cols', cols);
  if (termSeen) q.set('seen', termSeen);
  const qs = q.toString();
  let r;
  try { r = await api('GET', `/api/tasks/${seg(key)}/terminal${qs ? `?${qs}` : ''}`, undefined, { quiet: true }); } catch { return; }
  if (n !== termReq || key !== termKey || key !== state.drawerKey) return;
  r = heldScreen(r);
  if (r.same) return;
  termSeen = r.v || null;
  renderTerminal(r);
}

function heldScreen(r) {
  if (r.same) return r;
  const known = Boolean(r.session) && r.session === termWinOf && !r.dead;
  termHold = known ? holdUntil(termHold, termWin, r.cols || null) : 0;
  termWin = r.cols || null;
  termWinOf = r.session || null;
  if (!termHold) return r;
  if (Date.now() < termHold && !reprinted(r.screen || '', r.cols)) return { ...r, screen: termScreen ?? r.screen, v: null };
  termHold = 0;
  if ((r.screen || '') !== termScreen) termFollow = true; // printed anew: what was in sight is elsewhere, the end is where it was
  return r;
}

/** A selection of the person's that lies inside `el`: redrawing the screen under it would wipe it before
    they copy it, and a busy Claude redraws every second. */
let termPressed = false;
function selectingIn(el) {
  const sel = globalThis.document?.getSelection?.();
  return Boolean(sel && !sel.isCollapsed && (el.contains(sel.anchorNode) || el.contains(sel.focusNode)));
}

export const TERM_ACTIVITY = {
  busy: 'Working',
  background: 'Waits for you · commands in the background',
  own: 'Working · its command in the background',
  question: 'Waits for your answer',
  limit: 'Hit the usage limit',
  idle: 'Waits for you',
};

export function endedWords(r, full = false) {
  const code = r.exit !== null && r.exit !== undefined && (full || !r.interrupted) ? ` · ${tr('code')} ${r.exit}` : '';
  return `${tr(r.interrupted ? 'Session interrupted' : 'Finished')}${code}`;
}
function renderTerminal(r) {
  const gone = !r.session;
  const wasRunning = Boolean(termInfo && !termInfo.dead);
  termInfo = gone ? null : { session: r.session, dead: r.dead, exit: r.exit };
  if (drawerTask?.key === termKey && wasRunning !== Boolean(termInfo && !termInfo.dead)) renderLaunchButtons(drawerTask);
  $('term-state').textContent = gone ? tr('Not running') : r.dead ? endedWords(r) : tr(TERM_ACTIVITY[r.activity] || 'Running');
  $('term-resume').classList.toggle('hidden', !(r.dead && r.session));
  $('term-state').title = r.dead && !gone ? endedWords(r, true) : $('term-state').textContent;
  $('term-state').classList.toggle('live', !gone && !r.dead);
  $('term-state').classList.toggle('calm', !gone && !r.dead && r.activity !== undefined && !['busy', 'background', 'own'].includes(r.activity));
  $('term-stop').classList.toggle('hidden', gone);
  $('term-stop').textContent = r.dead ? tr('Close') : tr('Stop');
  const live = !gone && !r.dead;
  markTermTab(live);
  const bare = live && bareMode(r.screen);
  const login = live && !bare && needsLogin(r.screen || '');
  const offer = live && !login && getSetting('permission') === 'auto' ? autoOffer(r.screen || '') : null;
  const trust = live && !login && !offer && termUntrusted.has(r.session);
  const noteEl = $('term-note');
  const kind = bare ? 'bare' : login ? 'login' : (offer ? `auto${offer}` : (trust ? 'trust' : ''));
  noteEl.classList.toggle('hidden', !kind);
  if (noteEl.dataset.kind !== kind) {
    noteEl.dataset.kind = kind;
    if (bare) {
      noteEl.innerHTML = `${esc(tr('Claude runs in the bare mode (CLAUDE_CODE_SIMPLE): it reads no sign-in to your subscription, nor the board\'s skill and hooks — signing in does not help.'))}`
        + ` <button type="button" class="btn-primary term-login">${esc(tr('Open Settings'))}</button>`
        + `<span class="term-note-sub">${esc(tr('The board starts Claude without it, so Claude Code took it from its own settings — "env" of a settings.json, yours or the project\'s (.claude/ in its folder). Remove it there, stop this Claude and press ▶ again.'))}</span>`;
      noteEl.querySelector('.term-login').onclick = () => openSettingsModal('claude');
    } else if (login) {
      noteEl.innerHTML = `${esc(tr('Claude in the background is not signed in: the claude command has its own sign-in, apart from the Claude app.'))}`
        + ` <button type="button" class="btn-primary term-login">${esc(tr('Sign in'))}</button>`
        + `<span class="term-note-sub">${esc(tr('Then answer with the buttons below — usually 1, a Claude account; a browser opens. Once signed in, press ↑ and ↵ — Claude repeats the task.'))}</span>`;
      noteEl.querySelector('.term-login').onclick = () => termSend({ text: '/login', key: 'Enter' });
    } else if (offer) {
      noteEl.innerHTML = `${esc(tr('Claude works in the manual mode and asks about every command, while the board is set to auto.'))}`
        + ` <button type="button" class="btn-primary term-login">${esc(tr('Yes, and switch to auto'))}</button>`
        + `<span class="term-note-sub">${esc(tr('In auto mode Claude decides by itself what is safe and asks only about risky steps.'))}</span>`;
      noteEl.querySelector('.term-login').onclick = () => termSend({ text: offer });
    } else if (trust) noteEl.textContent = tr('Claude has not worked in this folder before: first it asks whether to trust it — answer 1 or ↵.');
  }
  const links = (r.links || []).filter((u) => /^https?:\/\//.test(u));
  const linksEl = $('term-links');
  if (linksEl.dataset.k !== links.join('\n')) {
    linksEl.dataset.k = links.join('\n');
    linksEl.innerHTML = links.map((u) => `<a class="term-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${ic('open', 12)}<span>${esc(shortUrl(u))}</span></a>`).join('');
  }
  linksEl.classList.toggle('hidden', !links.length);
  const off = gone || r.dead;
  $('term-input').disabled = off;
  termActivity = off ? null : r.activity;
  hintCardTerm();
  $('term-send').disabled = off;
  $('term-attach').disabled = off;
  $('term-keys').querySelectorAll('button').forEach((b) => { b.disabled = off; });
  const pre = $('term-screen');
  const text = r.screen || '';
  // another task's Claude in every card opened after it: the owner opened VT-683 and read VT-682's terminal there
  const same = Boolean(r.session) && r.session === termScreenOf;
  termScreenOf = r.session || null;
  if (!same) {
    termPressed = false;
    if (selectingIn(pre)) globalThis.document.getSelection().removeAllRanges();
  }
  if (text !== termScreen && (termPressed || selectingIn(pre))) {
    termSeen = null;
  } else if (text !== termScreen) {
    const rolled = termFollow || !same ? 0 : rolledBy(termScreen, text);
    termScreen = text;
    termLayout = { wraps: r.wraps || [], cols: r.cols || 0 };
    pre.textContent = text;
    if (termFollow) pre.scrollTop = pre.scrollHeight;
    // drops the oldest — the text under someone reading above slid up a line a print and fell off the top. The
    // scroll goes up by as many lines as the window rolled.
    else if (rolled) pre.scrollTop = Math.max(0, pre.scrollTop - rolled * (pre.scrollHeight / text.split('\n').length));
    termOwnTop = pre.scrollTop;
  }
}

export function rolledBy(was, now) {
  const a = String(was ?? '').split('\n');
  const b = now.split('\n');
  const n = Math.min(20, b.length);
  if (!n || a.length < n) return 0;
  let best = 0;
  let run = n - 1; // a roll needs more than this many lines matching
  for (let d = 0; d + n <= a.length && a.length - d > run; d++) { // a later shift cannot match longer than what is left
    const most = Math.min(a.length - d, b.length);
    let i = 0;
    while (i < most && a[d + i] === b[i]) i++;
    if (i > run) { best = d; run = i; }
  }
  return best;
}

function markTermTab(live) {
  const tab = $('d-tabs').querySelector('[data-tab="terminal"]') || $('d-tabs').querySelector('[data-tab="chat"]');
  if (!tab) return;
  const dot = tab.querySelector('.term-dot');
  if (live && !dot) tab.insertAdjacentHTML('beforeend', '<span class="term-dot" aria-hidden="true"></span>');
  else if (!live && dot) dot.remove();
}

/** The task of the open card changed outside (its event, a change of Claude's state) while its Terminal tab is
    not on screen: one look at the terminal, so the tab's dot does not stay lit for a Claude that has exited.
    One look at a time; the tab on screen is polled anyway. */
let termPeek = null;
const TERM_PEEK_MS = 5000;
export function peekTerminal() {
  if (termPeek || termTimer || !termKey || termKey !== state.drawerKey || !termInfo || termInfo.dead) return;
  termPeek = pollTerminal().finally(() => { termPeek = null; });
}

async function termSend(body) {
  const key = termKey;
  if (!key || !termInfo || termInfo.dead) return false;
  termPressed = false;
  if (selectingIn($('term-screen'))) globalThis.document.getSelection().removeAllRanges();
  try {
    await api('POST', `/api/tasks/${seg(key)}/terminal`, body, { quiet: true });
  } catch (e) {
    const r = refusalText(e);
    if (r.gone) sayRefused(e, key);
    else if (r.claudeGone) { styledAlert(tr(CLAUDE_NOT_READY.gone)); termSoon(0); } // the screen says how it ended
    else styledAlert(refusalLine('Could not type into the terminal', e, tr));
    return false;
  }
  termUntrusted.delete(termInfo.session);
  termFollow = true;
  termSeen = null;
  termSoon(250);
  return true;
}

async function termStop() {
  const key = termKey;
  if (!key || !termInfo) return;
  if (!termInfo.dead && !await styledConfirm(tr('Stop Claude? What it is doing now stops at once.'), { okLabel: tr('Stop'), danger: true })) return;
  try { await api('DELETE', `/api/tasks/${seg(key)}/terminal`, undefined, { quiet: true }); } catch (e) { if (e?.status !== 404) { styledAlert(refusalLine('Could not stop Claude', e, tr)); return; } }
  if (key !== state.drawerKey) return;
  termInfo = null;
  termKey = null;
  stopTermPoll();
  $('d-tabs').querySelector('[data-tab="terminal"]')?.remove();
  showWorkTab(savedTab() === 'terminal' ? 'chat' : savedTab());
  if (drawerTask?.key === key) renderLaunchButtons(drawerTask);
}

const CLAUDE_NOT_READY = {
  gone: 'Claude of the board no longer runs on this task — nothing was sent.',
};

const TERM_H_KEY = 'kb.ui.termHeight';
export const TERM_H_MIN = 90;
const TERM_H_STEP = 24;
/** The height of the screen the grip asks for, within reach: not lower than TERM_H_MIN, not over 85% of the window. */
export function termHeightFor(h, viewport) {
  return Math.round(Math.min(Math.max(h, TERM_H_MIN), Math.max(TERM_H_MIN, viewport * 0.85)));
}
function setTermHeight(h, save) {
  const pre = $('term-screen');
  const follow = termFollow;
  if (h == null) { pre.style.height = ''; pre.style.minHeight = ''; pre.style.maxHeight = ''; }
  else { pre.style.height = `${h}px`; pre.style.minHeight = '0'; pre.style.maxHeight = 'none'; }
  if (follow) { pre.scrollTop = pre.scrollHeight; termOwnTop = pre.scrollTop; }
  if (save) {
    try { if (h == null) localStore.removeItem(TERM_H_KEY); else localStore.setItem(TERM_H_KEY, String(h)); } catch { /* the height lives until reload */ }
  }
}
function initTermGrip() {
  const grip = $('term-grip');
  const pre = $('term-screen');
  const viewport = () => globalThis.innerHeight || 800;
  grip.title = tr('Drag to shrink or grow the terminal · double-click — the usual height');
  grip.setAttribute('aria-label', tr('Terminal height'));
  let saved = null;
  try { saved = Number(localStore.getItem(TERM_H_KEY)) || null; } catch { /* no storage — the usual height */ }
  if (saved) setTermHeight(termHeightFor(saved, viewport()), false);
  let drag = null;
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { y: e.clientY, h: pre.getBoundingClientRect().height, id: e.pointerId };
    grip.setPointerCapture?.(e.pointerId);
    grip.classList.add('dragging');
  };
  grip.onpointermove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    setTermHeight(termHeightFor(drag.h + (e.clientY - drag.y), viewport()), false);
  };
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    grip.classList.remove('dragging');
    setTermHeight(Math.round(pre.getBoundingClientRect().height), true);
  };
  grip.onpointerup = end;
  grip.onpointercancel = end;
  grip.ondblclick = () => setTermHeight(null, true);
  grip.onkeydown = (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const h = pre.getBoundingClientRect().height + (e.key === 'ArrowUp' ? -TERM_H_STEP : TERM_H_STEP);
    setTermHeight(termHeightFor(h, viewport()), true);
  };
}

export function wireTermImages(input, keyOf) {
  const ready = () => Boolean(keyOf()) && !input.disabled;
  wirePicturePick(input.closest('.comment-form'), (f, key) => termImage(input, keyOf, f, key), { ready, at: keyOf });
  input.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (!imgs.length || !ready()) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of imgs) termImage(input, keyOf, f);
  });
  input.addEventListener('dragover', (e) => { if (ready() && [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
  input.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length || !ready()) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of files.filter((x) => x.type.startsWith('image/'))) termImage(input, keyOf, f);
  });
}
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
export function wirePicturePick(form, take, { ready = () => true, at = () => null } = {}) {
  const btn = form?.querySelector('.form-attach');
  const file = form?.querySelector('input[type=file]');
  if (!btn || !file) return;
  btn.innerHTML = ic('attach', 15);
  btn.title = tr('Attach a picture');
  btn.setAttribute('aria-label', btn.title);
  let clicked = null;
  btn.onclick = () => { if (!ready()) return; clicked = at(); file.click(); };
  file.onchange = () => {
    const all = [...(file.files || [])];
    file.value = ''; // the same picture picked again is a change too
    const ok = all.filter((f) => IMAGE_ACCEPT.split(',').includes(f.type));
    if (ok.length < all.length) styledAlert(refusalLine('Could not attach', { status: 400, message: 'images only' }, tr));
    for (const f of ok) take(f, clicked);
  };
}
async function termImage(input, keyOf, blob, key = keyOf()) {
  const r = await uploadAttachment(blob, key);
  if (!r?.path || !input.isConnected || input.disabled || keyOf() !== key) return;
  const at = withPath(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, r.path);
  input.value = at.value;
  input.focus();
  input.setSelectionRange(at.caret, at.caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setTermHint(input, task) {
  const hint = termSuggestion(task, tr) || '';
  const base = tr('Answer Claude…');
  const shown = hint ? `${hint} — Tab` : base;
  if (input.dataset.hint === hint && input.placeholder === shown) return;
  input.dataset.hint = hint;
  input.placeholder = shown;
  growTermInput(input);
}
export function growTermInput(input) {
  autoGrow(input);
  if (input.value || !input.dataset.hint || !input.offsetParent) return;
  const h = hintHeight(input);
  if (h > input.offsetHeight) input.style.height = `${h}px`;
}
function hintHeight(input) {
  const probe = input.cloneNode(false);
  probe.removeAttribute('id');
  probe.value = input.placeholder;
  probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;height:auto;width:${input.offsetWidth}px`;
  input.after(probe);
  const h = probe.scrollHeight + probe.offsetHeight - probe.clientHeight;
  probe.remove();
  return h;
}
export function takeTermHint(e, input) {
  if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || input.value || !input.dataset.hint) return false;
  e.preventDefault();
  input.value = input.dataset.hint;
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

export function initTerminal() {
  $('term-keys').innerHTML = TERM_KEYS.map((k, i) => `<button type="button" class="btn-ghost term-key" data-i="${i}" title="${esc(tr(k.title))}">${esc(k.label)}</button>`).join('');
  $('term-keys').querySelectorAll('.term-key').forEach((b) => {
    const k = TERM_KEYS[Number(b.dataset.i)];
    b.onclick = () => termSend(k.key ? { key: k.key } : { text: k.text });
  });
  const input = $('term-input');
  input.placeholder = tr('Answer Claude…');
  input.title = tr('Answer Claude… (↵ sends, ⇧↵ — new line)');
  const send = async () => {
    const text = input.value;
    if (await termSend(text ? { text, key: 'Enter' } : { key: 'Enter' })) { input.value = ''; growTermInput(input); }
  };
  input.onkeydown = (e) => {
    if (takeTermHint(e, input)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  };
  input.oninput = () => growTermInput(input);
  wireTermImages(input, () => termKey);
  $('term-send').onclick = send;
  $('term-to-chat').innerHTML = ic('chat', 15);
  $('term-to-chat').title = tr('Show the chat');
  $('term-to-chat').setAttribute('aria-label', tr('Show the chat'));
  $('term-to-chat').onclick = () => setClaudeView('chat');
  $('term-stop').onclick = termStop;
  $('term-resume').textContent = tr('Continue');
  $('term-resume').title = tr('Start Claude again in this terminal with its conversation — it waits for your word');
  $('term-resume').onclick = async () => {
    if (await resumeOnBoard({ key: termKey, session: termInfo?.session, btn: $('term-resume') })) { termSeen = null; termSoon(0); }
  };
  const pre = $('term-screen');
  pre.onscroll = () => {
    termFollow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    if (pre.scrollTop === termOwnTop) return;
    termOwnTop = -1;
    pre.classList.add('scrolling');
    clearTimeout(termBarTimer);
    termBarTimer = setTimeout(() => pre.classList.remove('scrolling'), TERM_BAR_MS);
  };
  pre.onpointerdown = (e) => { termPressed = e.button === 0; };
  const letGo = () => { termPressed = false; };
  globalThis.addEventListener?.('pointerup', letGo);
  globalThis.addEventListener?.('pointercancel', letGo);
  pre.oncontextmenu = letGo;
  wireTermCopy(pre, () => termLayout);
  initTermGrip();
  setInterval(peekTerminal, TERM_PEEK_MS);
}

const workShown = () => !$('work-block').classList.contains('hidden') && !document.hidden;
function workFlight(key) {
  if (key !== state.drawerKey || key !== workKey) return;
  if (!cardChat) cardChat = mountChat($('work'), { key: null, scroller: $('drawer') }); // the card scrolls, the field stays at its edge
  cardChat.show(workShown());
  if (cardChat.key !== key) cardChat.setKey(key); else cardChat.refresh();
}

/** Read the chat of the open task again — on opening the card and on `task.work`. */
export function refreshWork(key) {
  return key && key === state.drawerKey && key === workKey && chatTab ? workFlight(key) : undefined;
}
export function repaintWorkTabs() {
  if (!tabsTask || tabsTask.key !== state.drawerKey) return;
  renderWorkTabs({ ...tabsTask, terminal: termKey === tabsTask.key ? termInfo : null });
}

async function deleteComment(id) {
  const key = state.drawerKey;
  if (!key) return;
  if (!await styledConfirm(tr('Delete the comment?'), { okLabel: tr('Delete'), danger: true })) return;
  try { await api('DELETE', `/api/tasks/${seg(key)}/comments/${seg(id)}`); } catch (e) {
    if (e?.status !== 404 || refusalText(e).gone) { sayRefused(e, key); return; }
  }
  if (key === state.drawerKey) renderComments(key).catch(() => {});
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
const clSending = new Set();
const CL_TRASH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M5 4l.5 9a1 1 0 0 0 1 .95h3a1 1 0 0 0 1-.95L12 4M6.7 6.5v5M9.3 6.5v5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

export function growChecklist() {
  const box = $('d-checklist');
  if (!box || !box.offsetParent) return;
  const tas = [...box.querySelectorAll('.cl-text')];
  for (const ta of tas) ta.style.height = 'auto';
  const heights = tas.map((ta) => ta.scrollHeight + ta.offsetHeight - ta.clientHeight);
  tas.forEach((ta, i) => { ta.style.height = `${heights[i]}px`; });
}
let clWidth = 0;
if (typeof ResizeObserver === 'function') {
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0]?.contentRect.width || 0);
    if (w && w !== clWidth) { clWidth = w; growChecklist(); }
  }).observe($('d-checklist'));
}

const clItemHTML = (c) => `<div class="cl-item${c.done ? ' done' : ''}" data-id="${c.id}">`
  + `<button class="cl-check" title="${esc(c.done ? tr('clear the mark') : tr('mark as done'))}">${c.done ? '✓' : ''}</button>`
  + `<textarea class="cl-text" rows="1" placeholder="${esc(tr('item'))}"${(drawerLocked || c.done) ? ' readonly' : ''}>${esc(c.text)}</textarea>`
  + (drawerLocked ? '' : `<button class="cl-del" title="${esc(tr('delete item'))}">${CL_TRASH}</button>`)
  + '</div>';
function wireChecklistItem(el) {
  const id = el.dataset.id;
  const ta = el.querySelector('.cl-text');
  if (drawerLocked) return;
  el.querySelector('.cl-check').onclick = () => toggleChecklist(id);
  ta.addEventListener('input', () => { if (ta.readOnly) return; autoGrow(ta); scheduleChecklistSave(id, ta.value); });
  ta.addEventListener('keydown', (e) => {
    if (ta.readOnly) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addChecklistItem(); }
    else if (e.key === 'Backspace' && ta.value === '') { e.preventDefault(); deleteChecklistItem(id); }
  });
  el.querySelector('.cl-del').onclick = () => deleteChecklistItem(id);
}
function renderChecklist(list) {
  drawerChecklist = list || [];
  const box = $('d-checklist');
  const ae = document.activeElement;
  const typing = ae?.classList?.contains('cl-text') && box.contains(ae)
    ? { id: ae.closest('.cl-item')?.dataset.id, from: ae.selectionStart, to: ae.selectionEnd }
    : null;
  if (!drawerChecklist.length) { box.innerHTML = ''; box.classList.add('hidden'); }
  else {
    box.classList.remove('hidden');
    box.innerHTML = drawerChecklist.map(clItemHTML).join('');
    box.querySelectorAll('.cl-item').forEach(wireChecklistItem);
    growChecklist();
    const ta = typing && box.querySelector(`.cl-item[data-id="${CSS.escape(String(typing.id))}"] .cl-text`);
    if (ta) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(typing.from, typing.to); } catch { /* not a text field */ } }
  }
  $('d-checklist-add').classList.toggle('hidden', !state.drawerKey || drawerLocked);
  $('d-attach').classList.toggle('hidden', drawerLocked);
}
function paintChecklistItem(item) {
  const el = $('d-checklist').querySelector(`.cl-item[data-id="${CSS.escape(String(item.id))}"]`);
  if (!el) { renderChecklist(drawerChecklist); return; }
  el.classList.toggle('done', Boolean(item.done));
  const b = el.querySelector('.cl-check');
  b.textContent = item.done ? '✓' : '';
  b.title = item.done ? tr('clear the mark') : tr('mark as done');
  const ta = el.querySelector('.cl-text');
  ta.readOnly = drawerLocked || Boolean(item.done);
  if (item.done && document.activeElement === ta) ta.blur();
}

export function applyChecklist(key, list) {
  if (!Array.isArray(list) || key !== state.drawerKey) return;
  const mine = new Set([...Object.keys(clSaveTimers), ...clSending].map(String));
  const focused = document.activeElement?.closest?.('#d-checklist .cl-item')?.dataset.id;
  if (focused) mine.add(String(focused));
  const local = new Map(drawerChecklist.map((c) => [String(c.id), c]));
  const next = list.map((c) => {
    const own = local.get(String(c.id));
    return { ...c, done: Boolean(c.done), text: own && mine.has(String(c.id)) ? own.text : c.text };
  });
  const same = next.length === drawerChecklist.length && next.every((c, i) => {
    const o = drawerChecklist[i];
    return String(o.id) === String(c.id) && o.text === c.text && Boolean(o.done) === c.done;
  });
  if (!same) renderChecklist(next);
}

const clUnsent = new Map(); // `cl:<key>:<id>` → { key, id, body } — what waits to be sent for one item
let clNoteShown = false;
const clQueueKey = (key, id) => `cl:${key}:${id}`;
function clNote(text) {
  showSaveNote(text);
  clNoteShown = Boolean(text);
}
function clSaved(key, id, body) {
  const k = clQueueKey(key, id);
  const job = clUnsent.get(k);
  if (job) {
    for (const f of Object.keys(body)) if (job.body[f] === body[f]) delete job.body[f];
    if (!Object.keys(job.body).length) { clUnsent.delete(k); dropUnsaved(k); }
  }
  if (clNoteShown && key === state.drawerKey && !clUnsent.size) clNote(null);
}
function clRefused(e, key, id, body) {
  if (e?.aborted) return;
  if (refusalText(e).gone) { sayRefused(e, key); return; }
  const k = clQueueKey(key, id);
  if (e?.status === 404) { // the item is gone: deleted in another tab or by Claude
    clUnsent.delete(k); dropUnsaved(k);
    if (key !== state.drawerKey) return;
    if (drawerChecklist.some((c) => String(c.id) === String(id))) renderChecklist(drawerChecklist.filter((c) => String(c.id) !== String(id)));
    clNote(tr('This item of the checklist was deleted elsewhere — your change to it is not saved.'));
    return;
  }
  if (canRetry(e)) {
    const prev = clUnsent.get(k);
    clUnsent.set(k, { key, id, body: { ...prev?.body, ...body } });
    noteUnsaved(() => resendChecklistItem(k), k);
  } else if (key === state.drawerKey && body.done !== undefined) { // a tick the server refused goes back
    const item = drawerChecklist.find((c) => String(c.id) === String(id));
    if (item && Boolean(item.done) === Boolean(body.done)) { item.done = !body.done; paintChecklistItem(item); }
  }
  if (key === state.drawerKey) clNote(editRefusedText(e));
}
async function resendChecklistItem(k) {
  const job = clUnsent.get(k);
  if (!job) return;
  clUnsent.delete(k);
  try {
    if (job.body.deleted) await api('DELETE', `/api/tasks/${seg(job.key)}/checklist/${seg(job.id)}`, undefined, { quiet: true });
    else await api('PATCH', `/api/tasks/${seg(job.key)}/checklist/${seg(job.id)}`, job.body, { quiet: true });
  } catch (e) {
    if (job.body.deleted && e?.status === 404) return; // deleted already
    if (canRetry(e)) { const newer = clUnsent.get(k); clUnsent.set(k, { ...job, body: { ...job.body, ...newer?.body } }); throw e; }
    clRefused(e, job.key, job.id, {});
    return;
  }
  if (clNoteShown && job.key === state.drawerKey && !clUnsent.size) clNote(null);
}
async function patchChecklistItem(key, id, body) {
  try { await api('PATCH', `/api/tasks/${seg(key)}/checklist/${seg(id)}`, body); } catch (e) { clRefused(e, key, id, body); return; }
  clSaved(key, id, body);
}

async function toggleChecklist(id) {
  if (!state.drawerKey || drawerLocked) return;
  const item = drawerChecklist.find((c) => String(c.id) === String(id));
  if (!item) return;
  item.done = !item.done;
  paintChecklistItem(item);
  await patchChecklistItem(state.drawerKey, id, { done: item.done });
}
function scheduleChecklistSave(id, text) {
  const item = drawerChecklist.find((c) => String(c.id) === String(id));
  if (item) item.text = text;
  const key = state.drawerKey;
  if (!key) return;
  clearTimeout(clSaveTimers[id]?.timer);
  const send = async () => {
    delete clSaveTimers[id];
    clSending.add(String(id));
    try { await patchChecklistItem(key, id, { text }); } finally { clSending.delete(String(id)); }
  };
  clSaveTimers[id] = { timer: setTimeout(send, 450), send };
}
function flushChecklistSaves() {
  for (const p of Object.values(clSaveTimers)) { clearTimeout(p.timer); p.send(); }
}
export async function addChecklistItem() {
  const key = state.drawerKey;
  if (!key || drawerLocked) return;
  let created;
  try { created = await api('POST', `/api/tasks/${seg(key)}/checklist`, { text: '' }); } catch (e) { sayRefused(e, key); return; }
  if (key !== state.drawerKey) return;
  if (!drawerChecklist.some((c) => String(c.id) === String(created.id))) drawerChecklist.push({ id: created.id, text: '', done: false, position: created.position });
  renderChecklist(drawerChecklist);
  $('d-checklist').querySelector(`.cl-item[data-id="${created.id}"] .cl-text`)?.focus();
}
async function deleteChecklistItem(id) {
  if (!state.drawerKey) return;
  clearTimeout(clSaveTimers[id]?.timer); delete clSaveTimers[id];
  drawerChecklist = drawerChecklist.filter((c) => String(c.id) !== String(id));
  renderChecklist(drawerChecklist);
  const key = state.drawerKey;
  const k = clQueueKey(key, id);
  clUnsent.delete(k); dropUnsaved(k); // a change waiting for the item goes with it
  try { await api('DELETE', `/api/tasks/${seg(key)}/checklist/${seg(id)}`); } catch (e) {
    if (refusalText(e).gone) { sayRefused(e, key); return; }
    if (e?.status === 404) return;
    if (canRetry(e)) { clUnsent.set(k, { key, id, body: { deleted: true } }); noteUnsaved(() => resendChecklistItem(k), k); }
    if (key === state.drawerKey) clNote(editRefusedText(e));
  }
}

const BOX_MS = 200;
export function openLightbox(url) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.innerHTML = `<img src="${esc(url)}" alt="">`;
  const img = overlay.querySelector('img');
  img.onerror = () => { img.replaceWith(Object.assign(document.createElement('div'), { className: 'lightbox-none', textContent: tr('The picture could not be opened') })); };
  const still = () => !overlay.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const ease = { duration: BOX_MS, easing: 'cubic-bezier(.2, .7, .2, 1)' };
  const leave = async () => {
    if (still()) return true;
    const pic = overlay.firstElementChild;
    pic?.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { ...ease, fill: 'forwards' });
    await overlay.animate([{ opacity: 1 }, { opacity: 0 }], { ...ease, fill: 'forwards' }).finished.catch(() => {});
    return true;
  };
  const close = overlayLayer(overlay, { backdrop: false, confirmClose: leave });
  overlay.onclick = close;
  document.body.appendChild(overlay);
  if (!still()) {
    overlay.animate([{ opacity: 0 }, { opacity: 1 }], ease);
    img.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], ease);
  }
}

async function deleteAttachment(attId) {
  const key = state.drawerKey;
  if (!key) return;
  try { await api('DELETE', `/api/tasks/${seg(key)}/attachments/${seg(attId)}`); } catch (e) {
    if (refusalText(e).gone) { sayRefused(e, key); return; }
    // 404 here — it is already deleted (another tab): what was asked; the card draws what is left
    if (e?.status !== 404) { styledAlert(refusalLine('Could not delete the attachment', e, tr)); return; }
  }
  await redrawAttachments(key);
}
async function redrawAttachments(key) {
  if (key !== state.drawerKey) return;
  let t;
  try { t = await api('GET', `/api/tasks/${seg(key)}`, undefined, { quiet: true }); } catch { return; } // the next look at the card draws them
  if (key === state.drawerKey) renderAttachments(t.attachments);
}

export async function uploadAttachment(blob, key = state.drawerKey) {
  if (!key) return null;
  const big = imageTooLarge(blob);
  if (big) { styledAlert(refusalLine('Could not attach', big, tr)); return null; }
  let r;
  try {
    r = await apiBlob(`/api/tasks/${seg(key)}/attachments`, blob);
  } catch (e) {
    if (refusalText(e).gone) sayRefused(e, key);
    else styledAlert(refusalLine('Could not attach', e, tr));
    return null;
  }
  await redrawAttachments(key);
  return r;
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
    else addPendingPicture(blob);
  }
}
function addPendingPicture(blob) {
  const big = imageTooLarge(blob);
  if (big) { styledAlert(refusalLine('Could not attach', big, tr)); return; }
  pendingAttachments.push({ blob, url: URL.createObjectURL(blob) });
  renderPendingAttachments();
  scheduleAutosave();
}
export function wireTaskPicture() {
  const btn = $('d-attach');
  wirePicturePick(btn.parentElement, (blob, at) => {
    if (at.key) { uploadAttachment(blob, at.key); return; }
    if (at.form !== newFormId) return; // the form was left for another one
    if (!state.drawerKey) { if (drawerShown()) addPendingPicture(blob); return; }
    if (formCreated.form === at.form) uploadAttachment(blob, formCreated.key);
  }, { at: () => ({ key: state.drawerKey, form: newFormId }) });
  btn.innerHTML = `${ic('attach', 13)}${esc(tr('picture'))}`;
}

export async function uploadCommentImage(blob, key = state.drawerKey) {
  if (!key) return;
  const big = imageTooLarge(blob);
  if (big) { styledAlert(refusalLine('Could not attach', big, tr)); return; }
  let sent;
  try {
    sent = await apiBlob(`/api/tasks/${seg(key)}/comments`, blob);
  } catch (e) {
    if (refusalText(e).gone) sayRefused(e, key);
    else styledAlert(refusalLine('Could not attach', e, tr));
    return;
  }
  commentArrived(key, sent);
  showOwnComment(key, sent?.id);
}

function markSelectedCard(key = state.openingKey ?? state.drawerKey) {
  document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  if (!key) return;
  const t = state.tasks.find((x) => x.key === key);
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
  if (id != null && scroll) revealCard($('board').querySelector(`.card[data-id="${id}"]`));
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
export async function kbMoveCard(dr, dc) {
  const t = state.tasks.find((x) => x.id === state.kbCursor);
  if (!t) return;
  if (dr) {
    if (colSort(t.status) !== DEFAULT_SORT) return;
    const sorted = state.tasks.filter((x) => x.status === t.status).sort(columnComparator(DEFAULT_SORT));
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

let openSeq = 0;
export function openDrawer(key, { quiet = false } = {}) {
  endLeave({ keepPlace: true });
  if (fullNext !== key) fullNext = null;
  if (selectedIds.size) clearSelection();
  const my = ++openSeq;
  state.openingKey = key;
  markSelectedCard(key);
  if (autosaveTimer && state.drawerKey && state.drawerKey !== key) { clearTimeout(autosaveTimer); autosaveTimer = null; doAutosave(); }
  if (state.drawerKey !== key) flushChecklistSaves();
  api('GET', `/api/tasks/${seg(key)}`, undefined, { quiet: true }).then((t) => {
    if (my !== openSeq) return;
    state.openingKey = null;
    state.drawerKey = t.key;
    state.drawerProject = null;
    $('drawer').classList.remove('is-empty');
    $('d-project').classList.add('hidden');
    setDrawerLock(DrawerSync.cardLocked(t.status, t.labels), { redraw: false });
    setDrawerId(t.key, t.project);
    $('d-title').value = t.title;
    $('d-desc').value = t.description || '';
    drawerStatus = t.status;
    buildStatusSelect(t.status, false, taskIsNoclaude(t));
    buildPrioritySelect(t.priority);
    drawerLabels = t.labels;
    drawerSnapshot = fieldsSnapshot(t);
    drawerFresh = null;
    descOutside = false;
    reopenDescConflict(t);
    showSaveNote(null);
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
    endLeave();
    growChecklist();
    holdBack();
    applyCommentDraft(t.key);
    drawTimeline(t);
    renderWorkTabs(t);
    renderLaunchButtons(t);
    renderAsks();
    autoGrow($('d-title'));
    markSelectedCard();
    scheduleDrawLinks();
    const card = $('board').querySelector(`.card[data-id="${t.id}"]`);
    if (card) requestAnimationFrame(() => revealCard(card));
    if (fullNext === key) { fullNext = null; setDrawerFull(true); }
  }, (e) => {
    if (my !== openSeq) return;
    state.openingKey = null;
    fullNext = null;
    if (e?.status !== 404) { markSelectedCard(); if (!(quiet && e?.offline)) styledAlert(tr('The board is not responding — try again in a moment.')); return; }
    markSelectedCard();
    styledAlert(tr('This task no longer exists — it was deleted.'));
    if (state.drawerKey === key) closeDrawer();
    refresh();
  });
}

export function openDrawerNew(status = 'backlog') {
  endLeave();
  if (selectedIds.size) clearSelection();
  openSeq++; state.openingKey = null;
  state.drawerKey = null;
  markSelectedCard();
  state.drawerProject = state.slug === ALL ? null : state.slug;
  newFormId++;
  $('drawer').classList.remove('is-empty');
  setDrawerLock(false);
  renderAsks();
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
  drawerSnapshot = null;
  drawerFresh = null;
  showSaveNote(null);
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
  clearComments();
  $('comments-block').classList.add('hidden');
  hideWorkTabs();
  drawerTask = null;
  $('d-launch').classList.add('hidden');
  $('d-session').classList.add('hidden');
  $('drawer').classList.remove('hidden');
  holdBack();
  applyCommentDraft(null);
  scheduleDrawLinks();
  autoGrow($('d-title'));
  $('d-title').focus();
}

const FULL_MS = 260;
let drawerFull = false;
let fullNext = null;
export const drawerIsFull = () => drawerFull;
export function openDrawerFull(key) {
  if (state.drawerKey === key && !$('drawer').classList.contains('hidden')) { setDrawerFull(true); return; }
  fullNext = key;
  openDrawer(key);
}
export function setDrawerFull(on, { quiet = false } = {}) {
  const d = $('drawer');
  if (!d || on === drawerFull) return;
  if (on && (d.classList.contains('hidden') || d.classList.contains('is-empty'))) return;
  d.getAnimations?.().forEach((a) => { if (a.id === 'full') a.cancel(); });
  d.classList.remove('drawer-leaving'); // a way back cut short by this click: the card stands as its state says
  d.classList.toggle('drawer-full', drawerFull);
  const from = d.getBoundingClientRect();
  const padFrom = getComputedStyle(d).paddingLeft;
  drawerFull = on;
  if (on) pushLayer('drawer-full', () => setDrawerFull(false)); else popLayer('drawer-full');
  d.classList.toggle('drawer-full', on);
  settleEntry(d);
  const to = d.getBoundingClientRect();
  const padTo = getComputedStyle(d).paddingLeft; // the column of the full screen widens with the card, not at once
  const still = quiet || !d.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!on && !still) d.classList.add('drawer-full', 'drawer-leaving'); // shrinks as a fixed card, to where it will stand
  if (!still) {
    const box = (r, pad) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: 'auto', bottom: 'auto', paddingLeft: pad, paddingRight: pad });
    const a = d.animate([box(from, padFrom), box(to, padTo)], { duration: FULL_MS, easing: 'cubic-bezier(.2, .7, .2, 1)', id: 'full' });
    const done = () => { if (!drawerFull) { d.classList.remove('drawer-full', 'drawer-leaving'); settleEntry(d); } scheduleDrawLinks(); };
    a.finished.then(done, () => {});
  } else scheduleDrawLinks();
  document.dispatchEvent(new CustomEvent('kb:drawer-full', { detail: on }));
}

function settleEntry(d) {
  d.getAnimations?.().forEach((a) => { if (a.animationName === 'v3-drawer-in') a.finish(); });
}

const LEAVE_MS = 220;
let leaving = null; // {ghost, place} of the card going now
function endLeave({ keepPlace = false } = {}) {
  if (!leaving) return;
  const l = leaving;
  l.ghost.remove();
  // a card asked for meanwhile comes once the board answers: its place stands still till then — taken away at once, the
  // board widened for a moment and came back (40–85ms of no card)
  if (keepPlace && l.place && !l.kept) {
    l.kept = true;
    l.place.getAnimations?.().forEach((a) => a.pause());
    setTimeout(() => { if (leaving === l) endLeave(); }, 1000); // the card did not come (refused, gone)
    return;
  }
  const d = $('drawer');
  const gap = l.kept && l.place && d && !d.classList.contains('hidden') ? l.width - l.place.getBoundingClientRect().width : 0;
  l.place?.remove();
  leaving = null;
  if (gap > 1 && d.animate) d.animate([{ marginLeft: `${-gap}px` }, { marginLeft: '0px' }], { duration: Math.round(LEAVE_MS * gap / l.width), easing: 'cubic-bezier(.4, 0, .2, 1)' });
}
function leaveSmoothly() {
  endLeave();
  const d = $('drawer');
  if (!d?.animate || d.classList.contains('hidden') || d.classList.contains('is-empty')
    || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const r = d.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const ghost = d.cloneNode(true);
  ghost.classList.add('drawer-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.append(ghost);
  ghost.scrollTop = d.scrollTop;
  const timing = { duration: LEAVE_MS, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' };
  /* the card goes from the row: an empty place of its width narrows to nothing and the board widens with it, while the
     copy slides out by the same width — the board's edge follows the card's edge (widened at once, the board was laid
     out anew under the copy still fading). A card that stays open empty («the sidebar always open») just fades. */
  const full = drawerFull; // a card on the full screen is out of the row: no place to narrow, it fades
  const away = getSetting('keepDrawer') || full ? 18 : r.width;
  // sliding out of the window it may keep some light to its end; fading in place it goes to none
  const a = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: away === r.width ? 0.2 : 0, transform: `translateX(${away}px)` }], timing);
  let place = null;
  if (!getSetting('keepDrawer') && !full) {
    place = document.createElement('div');
    place.className = 'drawer-place';
    place.style.width = `${r.width}px`;
    d.after(place);
    place.animate([{ width: `${r.width}px` }, { width: '0px' }], timing);
  }
  const mine = { ghost, place, width: r.width };
  leaving = mine;
  const drop = () => { ghost.remove(); if (mine.kept) return; place?.remove(); if (leaving === mine) leaving = null; scheduleDrawLinks(); };
  a.finished.then(drop, drop);
}

const CARD_STEP = 'kbCard';
let backing = false;
function holdBack() {
  if (history.state?.[CARD_STEP] || !globalThis.matchMedia?.(NARROW).matches) return;
  history.pushState({ [CARD_STEP]: true }, '');
}
function dropBack() {
  if (backing || !history.state?.[CARD_STEP]) return;
  backing = true;
  history.back();
}
const somethingOpen = () => drawerShown() || layersOpen();
export function wireCardBack() {
  if (history.state?.[CARD_STEP]) history.replaceState(null, '');
  window.addEventListener('popstate', () => {
    if (backing) { backing = false; if (somethingOpen()) holdBack(); return; }
    if (history.state?.[CARD_STEP] || !somethingOpen()) return;
    // (escClosePopup in init.js), and back does the same instead of closing the whole card
    if (document.querySelector('.kbsel.open')) { closeOpenSelect(); holdBack(); return; }
    if (closeTopLayer()) { if (somethingOpen()) holdBack(); return; }
    closeDrawer();
  });
  watchLayers((n) => { if (n) holdBack(); else if (!drawerShown()) dropBack(); });
  globalThis.matchMedia?.(NARROW).addEventListener?.('change', (e) => { if (e.matches && somethingOpen()) holdBack(); });
}

export function closeDrawer() {
  leaveSmoothly();
  dropBack();
  setDrawerFull(false, { quiet: true });
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; if (state.drawerKey) doAutosave(); }
  flushChecklistSaves();
  closeDrawerMenu();
  closeReturnPop();
  state.drawerKey = null;
  renderAsks();
  drawerStatus = null;
  timelineStatus = null;
  drawerSnapshot = null;
  drawerFresh = null;
  descOutside = false;
  paintDescConflict();
  closeLabelPicker();
  clearPending();
  $('d-title').value = '';
  $('d-desc').value = '';
  $('c-input').value = '';
  if ($('drawer').contains(document.activeElement)) document.activeElement.blur();
  drawerLabels = [];
  drawerLinks = [];
  state.drawerProject = null;
  drawerTask = null;
  $('d-project').classList.add('hidden');
  stopTermPoll();
  cardChat?.show(false);
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
  const pinned = drawerPinned;
  pushLayer('drawer-menu-pop', closeDrawerMenu);
  const menu = document.createElement('div');
  menu.className = 'drawer-menu-pop';
  menu.id = 'drawer-menu-pop';
  document.body.appendChild(menu);
  fillDrawerMenu(pinned);
  const r = $('drawer-menu').getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  requestAnimationFrame(() => menu.classList.add('open'));
  setTimeout(() => document.addEventListener('click', drawerMenuOutside), 0);
  askUsageNow();
}
function fillDrawerMenu(pinned = drawerPinned) {
  const menu = $('drawer-menu-pop');
  if (!menu) return;
  const info = claudeInfoHTML();
  const head = info || drawerLocked ? `<div class="dm-claude">${info || `<div class="dm-info">${tr('Claude is working on this task — actions come back once it hands it in')}</div>`}</div>` : '';
  menu.innerHTML = head + (drawerLocked ? '' : (head ? '<div class="dm-sep"></div>' : '')
    + `<div class="dm-item" data-act="subtask">${tr('Add subtask')}</div>`
    + `<div class="dm-item" data-act="parent">${tr('Link parent task')}</div>`
    + `<div class="dm-item" data-act="pin">${pinned ? tr('Unpin') : tr('Pin')}</div>`
    + `<div class="dm-item" data-act="move">${tr('Move to project…')}</div>`
    + '<div class="dm-sep"></div>'
    + `<div class="dm-item" data-act="cancel">${tr('Cancel task')}</div>`
    + `<div class="dm-item dm-danger" data-act="delete">${tr('Delete')}</div>`);
  const act = (name, fn) => { const el = menu.querySelector(`[data-act="${name}"]`); if (el) el.onclick = fn; };
  act('subtask', () => { closeDrawerMenu(); openLinkPicker('child', state.drawerKey); });
  act('parent', () => { closeDrawerMenu(); openLinkPicker('parent', state.drawerKey); });
  act('pin', () => togglePinTask(state.drawerKey));
  act('move', () => { closeDrawerMenu(); openMovePicker(state.drawerKey); });
  act('cancel', () => cancelTask(state.drawerKey));
  act('delete', () => deleteTask(state.drawerKey));
}
onClaudeInfo(() => fillDrawerMenu());

async function togglePinTask(key) {
  closeDrawerMenu(); closeCardMenu();
  if (!key) return;
  const cur = (key === state.drawerKey) ? { pinned: drawerPinned } : state.tasks.find((x) => x.key === key);
  const next = cur?.pinned ? 0 : 1;
  try { await api('PATCH', `/api/tasks/${seg(key)}`, { pinned: next }); } catch (e) {
    if (e?.offline) queueTaskEdit(key, { pinned: next });
    else sayRefused(e, key);
    return;
  }
  if (key === state.drawerKey) drawerPinned = next;
  await refresh();
}

function linkRefused(e, key, otherKey, picker) {
  const r = refusalText(e);
  if (r.gone) { picker.close(); sayRefused(e, key); return; }
  picker.fail(tr(r.text));
  if (otherKey && e?.status === 404) picker.drop(otherKey);
  if (r.refresh) refresh();
}

// The link picker on screen and the task it links: a card that locks closes the picker of its own task.
let linkPicker = null;
function closeLinkPickerOf(key) {
  if (key && linkPicker && linkPicker.key === key) linkPicker.close();
}

function openLinkPicker(rel, key) {
  if (!key) return;
  const cur = state.tasks.find((x) => x.key === key);
  const project = cur?.project || (key === drawerTask?.key ? drawerTask.project : null)
    || (state.slug && state.slug !== ALL && !state.slug.startsWith('#') ? state.slug : null);
  let pool = state.tasks;
  if (project && !pool.some((t) => t.project === project)) {
    api('GET', `/api/tasks?project=${encodeURIComponent(project)}&all=1`, undefined, { quiet: true })
      .then((list) => { pool = list; if (overlay.isConnected) render(); }).catch(() => {  });
  }
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
  const close = overlayLayer(overlay, { onClose: () => { if (linkPicker?.close === close) linkPicker = null; } });
  linkPicker = { key, close };
  const fail = (m) => { errEl.textContent = m; errEl.classList.remove('hidden'); };
  const picker = { close, fail, drop: (k) => { pool = pool.filter((t) => t.key !== k); render(); } };
  async function link(otherKey) {
    try { const links = await api('POST', `/api/tasks/${seg(key)}/links`, { key: otherKey, rel }); if (key === state.drawerKey) renderDrawerLinks(links); }
    catch (e) { linkRefused(e, key, otherKey, picker); return; }
    close(); await refresh();
  }
  async function create(title) {
    if (!project) { fail(tr('pick a project first')); return; }
    let created;
    try { created = await api('POST', '/api/tasks', { project, title, status: 'backlog' }); }
    catch (e) { linkRefused(e, key, null, picker); return; }
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
    const matches = pool
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
export function openMovePicker(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (list.length > 1) { openGroupMove(list); return; }
  const key = list[0];
  if (!key) return;
  const from = state.tasks.find((x) => x.key === key)?.project || (key === drawerTask?.key ? drawerTask.project : null);
  const pool = state.projects.filter((p) => p.slug !== from);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal lp-modal">
    <div class="modal-title">${tr('Move to another project')} · ${esc(key)}</div>
    <input class="modal-input" id="mp-input" placeholder="${tr('Project name or key…')}" autocomplete="off">
    <div class="lp-results" id="mp-results"></div>
    <div class="modal-err hidden" id="mp-err"></div>
  </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#mp-input');
  const results = overlay.querySelector('#mp-results');
  const errEl = overlay.querySelector('#mp-err');
  const close = overlayLayer(overlay);
  const fail = (m) => { errEl.textContent = m; errEl.classList.remove('hidden'); };
  let busy = false;
  async function move(slug) {
    if (busy) return;
    busy = true;
    let moved;
    try { moved = await api('POST', `/api/tasks/${seg(key)}/move`, { project: slug }, { quiet: true }); }
    catch (e) {
      busy = false;
      if (e?.status === 409 && e.body?.reason === 'in-work') { fail(tr('Claude is working on this task — it can be moved once it is handed in.')); return; }
      if (e?.status === 409 && e.body?.reason === 'check-open') { fail(`${tr('That project already has an open check:')} ${e.body.key}`); return; }
      if (refusalText(e).gone) { close(); sayRefused(e, key); return; }
      fail(refusalLine('Not moved', e, tr));
      return;
    }
    close();
    if (key === state.drawerKey) openDrawer(moved.key, { quiet: true });
    await refresh();
  }
  let activeIdx = -1;
  const opts = () => [...results.querySelectorAll('.lp-opt')];
  function highlight() {
    const its = opts();
    its.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0 && its[activeIdx]) its[activeIdx].scrollIntoView({ block: 'nearest' });
  }
  function render() {
    const ql = input.value.trim().toLowerCase();
    const matches = pool.filter((p) => !ql || [p.name, p.prefix, p.slug].some((s) => String(s || '').toLowerCase().includes(ql)));
    results.innerHTML = matches.map((p) =>
      `<div class="lp-opt" data-slug="${esc(p.slug)}"><span class="lp-key">${esc(p.prefix)}</span><span class="lp-title">${esc(p.name || p.slug)}</span></div>`).join('')
      || `<div class="lp-empty">${tr(pool.length ? 'nothing found' : 'no other projects')}</div>`;
    results.querySelectorAll('.lp-opt').forEach((o) => { o.onclick = () => move(o.dataset.slug); });
    activeIdx = opts().length ? 0 : -1;
    highlight();
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    const its = opts();
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(its.length - 1, activeIdx + 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0 && its[activeIdx]) its[activeIdx].click(); }
  });
  render();
  input.focus();
}
export async function moveEach(keys, slug, { post, projectOf, openKey, why }) {
  const moved = [];
  const refused = [];
  let reopen = null;
  for (const k of keys) {
    if (projectOf(k) === slug) continue; // there already
    let m;
    try { m = await post(k); } catch (e) { refused.push([k, why(e)]); continue; }
    moved.push(k);
    if (k === openKey()) reopen = m.key;
  }
  return { moved, refused, reopen };
}
function openGroupMove(keys) {
  const projectOf = (k) => state.tasks.find((x) => x.key === k)?.project ?? null;
  const froms = new Set(keys.map(projectOf));
  const from = froms.size === 1 ? [...froms][0] : null; // the tasks of one board: its project is not offered
  const pool = state.projects.filter((p) => p.slug !== from);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal lp-modal">
    <div class="modal-title">${tr('Move to another project')} · ${keys.length} ${esc(plural(keys.length, 'task', 'tasks'))}</div>
    <input class="modal-input" id="mp-input" placeholder="${tr('Project name or key…')}" autocomplete="off">
    <div class="lp-results" id="mp-results"></div>
    <div class="modal-err mp-err hidden" id="mp-err"></div>
  </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#mp-input');
  const results = overlay.querySelector('#mp-results');
  const errEl = overlay.querySelector('#mp-err');
  const close = overlayLayer(overlay);
  let busy = false;
  const why = (e) => (e?.status === 409 && e.body?.reason === 'in-work' ? tr('Claude is working on this task — it can be moved once it is handed in.')
    : e?.status === 409 && e.body?.reason === 'check-open' ? `${tr('That project already has an open check:')} ${e.body.key}`
      : tr(refusalText(e).reason)); // the head «Not moved» stands over the list already
  async function move(slug) {
    if (busy) return;
    busy = true;
    const post = (k) => api('POST', `/api/tasks/${seg(k)}/move`, { project: slug }, { quiet: true });
    const { moved: went, refused, reopen } = await moveEach(keys, slug, { post, projectOf, openKey: () => state.drawerKey, why });
    const moved = went.length;
    for (const k of went) {
      const id = state.tasks.find((x) => x.key === k)?.id;
      if (id !== undefined) selectedIds.delete(id);
    }
    busy = false;
    if (reopen) openDrawer(reopen, { quiet: true });
    // of what moved; the board is read again once it answers
    try { await refresh(); } catch { /* the stream catches up when the board is back */ }
    if (!refused.length) { close(); clearSelection(); return; }
    keys = refused.map(([k]) => k);
    // the refused stay selected (an open card moved with them took the selection away)
    const ids = keys.map((k) => state.tasks.find((x) => x.key === k)?.id).filter((id) => id !== undefined);
    if (ids.some((id) => !selectedIds.has(id))) selectTasks(ids);
    overlay.querySelector('.modal-title').textContent = `${tr('Move to another project')} · ${keys.length} ${plural(keys.length, 'task', 'tasks')}`;
    errEl.innerHTML = `<div>${esc(tr('Moved'))}: ${moved}. ${esc(tr('Not moved'))}:</div>`
      + refused.map(([k, w]) => `<div><b>${esc(k)}</b> — ${esc(w)}</div>`).join('');
    errEl.classList.remove('hidden');
  }
  let activeIdx = -1;
  const opts = () => [...results.querySelectorAll('.lp-opt')];
  function highlight() {
    const its = opts();
    its.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0 && its[activeIdx]) its[activeIdx].scrollIntoView({ block: 'nearest' });
  }
  function render() {
    const ql = input.value.trim().toLowerCase();
    const matches = pool.filter((p) => !ql || [p.name, p.prefix, p.slug].some((x) => String(x || '').toLowerCase().includes(ql)));
    results.innerHTML = matches.map((p) =>
      `<div class="lp-opt" data-slug="${esc(p.slug)}"><span class="lp-key">${esc(p.prefix)}</span><span class="lp-title">${esc(p.name || p.slug)}</span></div>`).join('')
      || `<div class="lp-empty">${tr(pool.length ? 'nothing found' : 'no other projects')}</div>`;
    results.querySelectorAll('.lp-opt').forEach((o) => { o.onclick = () => move(o.dataset.slug); });
    activeIdx = opts().length ? 0 : -1;
    highlight();
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    const its = opts();
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(its.length - 1, activeIdx + 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0 && its[activeIdx]) its[activeIdx].click(); }
  });
  render();
  input.focus();
}
export async function cancelTask(key) {
  closeDrawerMenu(); closeCardMenu();
  if (key && await styledConfirm(tr('Cancel the task? The issue will be closed as not planned.'), { okLabel: tr('Cancel the task') })) {
    try { await api('PATCH', `/api/tasks/${seg(key)}`, { status: 'cancelled' }); } catch (e) {
      if (e?.offline) queueTaskEdit(key, { status: 'cancelled' });
      else sayRefused(e, key);
      return;
    }
    if (key === state.drawerKey) closeDrawer();
    await refresh();
  }
}
async function duplicateTask(key) {
  closeDrawerMenu(); closeCardMenu();
  if (!key) return;
  try {
    const t = await api('POST', `/api/tasks/${seg(key)}/duplicate`, undefined, { quiet: true });
    await refresh();
    if (t?.key) openDrawer(t.key);
  } catch (e) {
    if (e?.status === 409 && e.body?.reason === 'check-open' && e.body.key) {
      if (String(e.body.key).toUpperCase() === String(key).toUpperCase()) {
        styledAlert(tr(stillOpen((drawerTask?.key === e.body.key ? drawerTask : state.tasks.find((x) => x.key === e.body.key))?.status)));
        return;
      }
      openDrawer(e.body.key);
      return;
    }
    if (e?.offline) styledAlert(tr('The board is not responding — try again in a moment.'));
    else sayRefused(e, key);
  }
}
export async function deleteTask(key) {
  closeDrawerMenu(); closeCardMenu();
  if (key && await styledConfirm(tr('Delete the task permanently (comments included)?'), { okLabel: tr('Delete'), danger: true })) {
    // the person is told it did not happen (or that the task is already gone)
    try { await api('DELETE', `/api/tasks/${seg(key)}`); } catch (e) { sayRefused(e, key); return; }
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
  const setField = async (body) => {
    try { await api('PATCH', `/api/tasks/${seg(t.key)}`, body); }
    catch (e) {
      if (e?.offline) { queueTaskEdit(t.key, body); return 'queued'; }
      sayRefused(e, t.key);
      return 'rejected';
    }
    await refresh();
    return 'saved';
  };
  const backRow = `<div class="dm-item dm-back" data-back="1">${tr('‹ Back')}</div><div class="dm-sep"></div>`;
  const group = selectedIds.has(t.id) ? [...selectedIds].map((id) => state.tasks.find((x) => x.id === id)?.key).filter(Boolean) : [];

  function renderMain() {
    menu.innerHTML = `<div class="dm-item" data-act="status">${tr('Status')}<span class="dm-chev">›</span></div>`
      + `<div class="dm-item" data-act="priority">${tr('Priority')}<span class="dm-chev">›</span></div>`
      + `<div class="dm-item" data-act="labels">${tr('Labels')}<span class="dm-chev">›</span></div>`
      + '<div class="dm-sep"></div>'
      + `<div class="dm-item" data-act="subtask">${tr('Add subtask')}</div>`
      + `<div class="dm-item" data-act="parent">${tr('Link parent task')}</div>`
      + `<div class="dm-item" data-act="pin">${t.pinned ? tr('Unpin') : tr('Pin')}</div>`
      + `<div class="dm-item" data-act="duplicate">${tr('Duplicate')}</div>`
      + (group.length > 1 ? `<div class="dm-item" data-act="move">${tr('Move to project…')} (${group.length})</div>`
        : WORKING.has(t.status) && !taskIsNoclaude(t) ? '' : `<div class="dm-item" data-act="move">${tr('Move to project…')}</div>`)
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
    if (it('move')) it('move').onclick = () => { closeCardMenu(); openMovePicker(group.length > 1 ? group : t.key); };
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
        menu.querySelectorAll('.lbl-row').forEach((o) => { o.onclick = async (ev) => {
          ev.stopPropagation();
          const n = o.dataset.name;
          cur = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n];
          drawLabels();
          const sent = cur;
          const res = await setField({ labels: sent });
          if (res === 'saved') t.labels = sent;
          else if (res === 'rejected' && menu.isConnected) { cur = [...(t.labels || [])]; drawLabels(); }
        }; });
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
  if (!e.target.closest('#return-pop, .modal-overlay') && e.target.id !== 'd-return-icon') closeReturnPop();
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
  try {
    if (reason) {
      await api('POST', `/api/tasks/${seg(key)}/comments`, { body: `${tr('Send back')}: ${reason}`, author: 'me' });
      const input = $('return-pop')?.querySelector('.return-pop-input');
      if (input) input.value = '';
    }
    await api('PATCH', `/api/tasks/${seg(key)}`, { status: 'todo' });
  } catch (e) {
    if (refusalText(e).gone) closeReturnPop();
    sayRefused(e, key);
    return;
  }
  closeReturnPop();
  await refresh();
  openDrawer(key);
}

const descConflicts = new Map(); // task key → { mine, theirs, showing: 'mine' | 'theirs' }
let descOutside = false; // the description changed outside while the cursor stands in the unchanged field
export function descConflictPending() {
  // review: a pick on a task never opened again (or deleted since) must not hold the reload of the tab for good
  for (const [k, c] of descConflicts) if (Date.now() - c.at > DESC_PICK_HOLD_MS) descConflicts.delete(k);
  return descConflicts.size > 0;
}
const DESC_PICK_HOLD_MS = 24 * 3600_000;
/* The description a save of `key` starts from: the one an earlier save of this card is still taking to the server, or
   the snapshot. `descSending` — what the last save sent while it is on its way; `queuedBase` — the base of a save that
   did not get there (the resend sends it). */
const descSending = new Map();
const queuedBase = new Map();
function descBaseOf(key) {
  return descSending.has(key) ? descSending.get(key) : (drawerSnapshot?.description ?? '');
}
function descSent(key, text) {
  if (descSending.get(key) === text) descSending.delete(key); // no newer save behind it
}
function descConflict(key, mine, theirs) {
  const here = key === state.drawerKey && drawerSnapshot;
  if (here) drawerSnapshot.description = theirs ?? '';
  descConflicts.set(key, { mine: here ? $('d-desc').value : mine, theirs: theirs ?? '', showing: 'mine', at: Date.now() });
  descOutside = false;
  paintDescConflict();
}
// the card of a task with a pick left open: the field shows the server's description, the banner offers the person's
function reopenDescConflict(t) {
  const c = descConflicts.get(t.key);
  if (!c) { paintDescConflict(); return; }
  if (c.mine === (t.description || '')) { descConflicts.delete(t.key); paintDescConflict(); return; }
  Object.assign(c, { theirs: t.description || '', showing: 'theirs' });
  paintDescConflict();
}
// the external description arrived (applyDrawerFresh): a pick that waits shows the newest one; an unchanged field under
// the cursor is offered it
function descFollows(form) {
  const fresh = drawerFresh?.description;
  if (fresh === undefined || !drawerSnapshot) return;
  const c = descConflicts.get(state.drawerKey);
  if (c) {
    c.theirs = fresh;
    drawerSnapshot.description = fresh;
    if (c.showing === 'theirs' && document.activeElement !== $('d-desc')) { $('d-desc').value = fresh; autoGrow($('d-desc')); }
  } else {
    descOutside = document.activeElement === $('d-desc') && form.description === drawerSnapshot.description && fresh !== form.description;
  }
  paintDescConflict();
}
function paintDescConflict() {
  const el = $('d-desc-conflict');
  if (!el) return;
  const key = state.drawerKey;
  const c = key ? descConflicts.get(key) : null;
  if (!c && !(key && descOutside)) { el.classList.add('hidden'); el.innerHTML = ''; el.dataset.sig = ''; return; }
  const theirs = c?.showing === 'theirs';
  const text = !c ? 'The description was changed outside — by Claude or another tab — while the cursor is in it.'
    : theirs ? 'This is the description as it is now. Your edit is not saved.'
      : 'Claude or another tab changed the description while you were editing it. Your edit is not saved yet.';
  const acts = !c ? [['dc-pull', 'btn-primary', 'Show the new version']]
    : [['dc-show', 'btn-ghost', theirs ? 'Back to mine' : 'Show their version'], ['dc-keep', 'btn-primary', theirs ? 'Keep this one' : 'Keep mine']];
  const html = `<span class="dc-text">${esc(tr(text))}</span><span class="dc-acts">${acts.map(([k, cls, t]) => `<button type="button" class="${cls} ${k}">${esc(tr(t))}</button>`).join('')}</span>`;
  el.classList.remove('hidden');
  // drawn again only when it says something else: a click on its button blurs the field first, the blur repaints, and
  // a button drawn anew under the pointer never got the click
  if (el.dataset.sig === `${key}\n${html}`) return;
  el.dataset.sig = `${key}\n${html}`;
  el.innerHTML = html;
  const desc = $('d-desc');
  const put = (v) => { desc.value = v; autoGrow(desc); };
  el.querySelector('.dc-pull')?.addEventListener('click', () => { descOutside = false; desc.blur(); pullDrawerFresh(); paintDescConflict(); });
  el.querySelector('.dc-show')?.addEventListener('click', () => {
    if (c.showing === 'mine') { c.mine = desc.value; put(c.theirs); c.showing = 'theirs'; } else { put(c.mine); c.showing = 'mine'; }
    paintDescConflict();
  });
  el.querySelector('.dc-keep')?.addEventListener('click', () => {
    descConflicts.delete(key);
    if (c.showing === 'theirs') { put(c.theirs); if (drawerSnapshot) drawerSnapshot.description = c.theirs; } else scheduleAutosave(); // the person's text goes over theirs, as picked
    paintDescConflict();
  });
}
export function descTyped() {
  const c = state.drawerKey ? descConflicts.get(state.drawerKey) : null;
  if (c?.showing === 'theirs') { descConflicts.delete(state.drawerKey); if (drawerSnapshot) drawerSnapshot.description = c.theirs; paintDescConflict(); }
  else if (c) c.mine = $('d-desc').value; // review: typed after the note came — the card may close before the pick
  if (descOutside) { descOutside = false; paintDescConflict(); }
}

async function refreshDrawerFields(t) {
  if (autosaveTimer || drawerLocked || !drawerSnapshot) return;
  const key = state.drawerKey;
  const desc = $('d-desc');
  if (!('description' in t) && desc.value === drawerSnapshot.description && (t.preview || '') !== desc.value.slice(0, 180)) {
    try { t = await api('GET', `/api/tasks/${seg(t.key)}`, undefined, { quiet: true }); } catch { return; }
    if (autosaveTimer || drawerLocked || !drawerSnapshot || state.drawerKey !== key) return;
  }
  drawerFresh = {
    title: t.title || '', priority: t.priority, labels: [...(t.labels || [])],
    ...('description' in t ? { description: t.description || '' } : {}),
  };
  applyDrawerFresh();
}
function applyDrawerFresh() {
  if (!drawerFresh || !drawerSnapshot) return;
  const ae = document.activeElement;
  const skip = [ae === $('d-title') && 'title', ae === $('d-desc') && 'description'].filter(Boolean);
  const { write, snap } = pullExternal(drawerSnapshot, drawerForm(), drawerFresh, skip);
  drawerSnapshot = snap;
  if ('title' in write) { $('d-title').value = write.title; autoGrow($('d-title')); }
  if ('description' in write) { $('d-desc').value = write.description; autoGrow($('d-desc')); }
  if ('priority' in write) buildPrioritySelect(write.priority);
  if ('labels' in write) { drawerLabels = write.labels; renderDrawerLabels(); launchFollowsLabels(); }
  descFollows(drawerForm());
}
export function pullDrawerFresh() {
  if (!autosaveTimer && !drawerLocked) applyDrawerFresh();
}

let timelineStatus = null;
function drawTimeline(t) {
  renderTimeline(t);
  timelineStatus = t.status;
}
async function followTimeline(key, t, moved = false) {
  if (!timelineStatus || (t.status === timelineStatus && !moved)) return;
  const was = timelineStatus;
  timelineStatus = t.status; // the events that follow while the log is read ask nothing more
  let full = 'events' in t ? t : null;
  if (!full) {
    try { full = await api('GET', `/api/tasks/${seg(key)}`, undefined, { quiet: true }); } catch { timelineStatus = was; return; } // the next event tries again
  }
  if (state.drawerKey === key) drawTimeline(full);
}

export async function syncOpenDrawerStatus({ moved = false } = {}) {
  if (!state.drawerKey) return;
  const key = state.drawerKey;
  let t = DrawerSync.listCopyForDrawer(state.tasks, key, !$('board').classList.contains('hidden'));
  if (!t) {
    try {
      t = await api('GET', `/api/tasks/${seg(state.drawerKey)}`, undefined, { quiet: true });
    } catch (e) {
      if (e?.status === 404 && state.drawerKey === key) { styledAlert(tr('This task no longer exists — it was deleted.')); closeDrawer(); }
      return;
    }
  }
  if (!t || state.drawerKey !== key) return;
  if (t.key && t.key !== key) { await followMovedTask(key, t.key); return; }
  followTimeline(key, t, moved);
  drawerPinned = t.pinned ? 1 : 0;
  if ('description' in t) renderIssueRow(t);
  await refreshDrawerFields(t);
  if (drawerSnapshot && selVal('d-status') === t.status) drawerSnapshot.status = t.status;
  if (!DrawerSync.shouldSyncDrawerStatus(drawerStatus, selVal('d-status'), t.status)) return;
  drawerStatus = t.status;
  buildStatusSelect(t.status, false, drawerLabels.includes('noclaude'));
  if (drawerSnapshot) drawerSnapshot.status = t.status;
  $('d-return').classList.toggle('hidden', t.status !== 'review');
  $('d-return-icon').classList.toggle('hidden', !['review', 'done'].includes(t.status));
  renderLaunchButtons(t);
  $('d-accept-btn').classList.toggle('hidden', t.status !== 'review');
  const willLock = DrawerSync.cardLocked(t.status, t.labels);
  if (willLock && autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; await doAutosave(); }
  const unlocked = drawerLocked && !willLock;
  setDrawerLock(willLock);
  if (unlocked && state.drawerKey === key) await refreshDrawerFields(t);
}

export async function followMovedTask(from, to) {
  if (state.openingKey === to) return;
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; await doAutosave(); }
  if (state.drawerKey !== from) return; // another card was opened meanwhile
  if (commentDrafts.has(from)) { commentDrafts.set(to, commentDrafts.get(from)); commentDrafts.delete(from); }
  openDrawer(to, { quiet: true });
}

let autosaveTimer = null;
function newTaskHasContent() {
  return $('d-title').value.trim() || $('d-desc').value.trim() || pendingAttachments.length;
}
let createFailedForm = null;
export function scheduleAutosave() {
  if (!state.drawerKey && creatingForm !== newFormId && createFailedForm !== newFormId && newTaskHasContent()) { doAutosave(); return; }
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(doAutosave, 450);
}

export async function doAutosave() {
  try {
    return await doAutosaveOnce();
  } catch (e) {
    if (e?.offline) return undefined;
    if (e?.saidInCard) return undefined;
    if (e?.taskKey && refusalText(e).gone) {
      if (e.taskKey === state.drawerKey) sayRefused(e, e.taskKey);
      else refresh();
      return undefined;
    }
    throw e;
  }
}

const unsentEdits = createUnsentEdits();
const editInTurn = createTurns();
function queueTaskEdit(key, fields) {
  unsentEdits.fail(key, fields);
  noteUnsaved(() => resendTaskEdit(key), `task:${key}`);
}
async function resendTaskEdit(key) {
  const queued = unsentEdits.get(key);
  if (!queued) return;
  const fields = { ...queued };
  const here = key === state.drawerKey && drawerShown() && drawerSnapshot && !drawerLocked;
  if (here) { clearTimeout(autosaveTimer); autosaveTimer = null; }
  const dirty = here ? changedFields(formToSave(), drawerSnapshot) : {};
  if (descConflicts.has(key)) { delete dirty.description; delete fields.description; }
  const sent = { ...fields, ...dirty };
  // base the last word won, and a `kb desc` made while offline was erased when the connection came back
  const base = queuedBase.has(key) ? queuedBase.get(key) : (here ? descBaseOf(key) : undefined);
  if ('description' in sent && typeof base === 'string') sent.description_base = base;
  let saved;
  try {
    saved = await editInTurn(key, () => api('PATCH', `/api/tasks/${seg(key)}`, sent));
  } catch (e) {
    if (!e?.offline && !(e?.status >= 500)) { unsentEdits.drop(key); queuedBase.delete(key); }
    else unsentEdits.fail(key, dirty);
    throw e;
  }
  if ('description' in sent) queuedBase.delete(key);
  if (saved?.description_conflict) {
    unsentEdits.settle(key, fields); unsentEdits.settle(key, dirty);
    const rest = { ...dirty };
    delete rest.description;
    if (here && state.drawerKey === key && drawerSnapshot) Object.assign(drawerSnapshot, rest);
    descConflict(key, sent.description, saved.description);
    return;
  }
  unsentEdits.settle(key, fields);
  unsentEdits.settle(key, dirty);
  if (here && state.drawerKey === key && drawerSnapshot) Object.assign(drawerSnapshot, dirty);
  if (here && state.drawerKey === key) showSaveNote(null);
}
const unsentCreates = new Map();
function editRefusedText(e) {
  if (e?.status >= 500) return tr('The change is not saved yet: the board answered with an error — the details are in Settings → Errors. Your next change tries again, or click “not saved” at the top.');
  return refusalLine('The change is not saved', e, tr);
}
function createRefusedText(e) {
  if (e?.offline) return tr('The task is not created yet: there is no connection to the board. It is created by itself once the connection is back.');
  if (e?.status >= 500) return tr('The task is not created yet: the board answered with an error — the details are in Settings → Errors. Your next change tries again, or click “not saved” at the top.');
  return refusalLine('The task is not created', e, tr);
}
function showSaveNote(text) {
  const el = $('d-save-note');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}
function queueCreate(formId, body, pend) {
  unsentCreates.set(formId, { body, pend });
  noteUnsaved(() => resendCreate(formId), `new:${formId}`);
}
async function resendCreate(formId) {
  const job = unsentCreates.get(formId);
  if (!job) return;
  if (formId === newFormId && !state.drawerKey && drawerShown()) { unsentCreates.delete(formId); return doAutosaveOnce(); }
  if (creatingForm === formId) return;
  return createTask(formId, job.body, job.pend);
}

function formToSave() {
  const title = $('d-title').value.trim();
  const common = {
    description: $('d-desc').value,
    priority: Number(selVal('d-priority')),
    labels: drawerLabels,
    status: selVal('d-status'),
  };
  return title ? { ...common, title } : common;
}

async function doAutosaveOnce() {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  if (drawerLocked || !drawerShown()) return;
  const full = formToSave();
  const { title = '', description, ...common } = full;
  if (state.drawerKey) {
    const patch = drawerSnapshot ? changedFields(full, drawerSnapshot) : full;
    const key = state.drawerKey;
    if (descConflicts.has(key)) delete patch.description;
    if (!Object.keys(patch).length) return;
    const body = 'description' in patch && drawerSnapshot ? { ...patch, description_base: descBaseOf(key) } : patch;
    if ('description' in body) descSending.set(key, patch.description);
    let saved;
    try { saved = await editInTurn(key, () => api('PATCH', `/api/tasks/${seg(key)}`, body)); }
    catch (e) {
      if (canRetry(e) && 'description' in body && !queuedBase.has(key)) queuedBase.set(key, body.description_base);
      if (canRetry(e)) queueTaskEdit(key, patch);
      // says it); the card moved on to another task while the request went: a refusal is said with the task's key
      const r = refusalText(e);
      if (!e?.offline && !r.gone) {
        // a refused move of the status: the picker goes back to the status the card knows — left on the refused one, it
        // went out with every later edit, and the board refused each whole; the reading below brings the real status
        if (!canRetry(e) && 'status' in patch && key === state.drawerKey) {
          buildStatusSelect(drawerStatus, false, drawerLabels.includes('noclaude'));
          if (drawerSnapshot) drawerSnapshot.status = drawerStatus;
        }
        if (key === state.drawerKey) showSaveNote(editRefusedText(e));
        else if (!canRetry(e)) styledAlert(`${key}: ${refusalLine('The change is not saved', e, tr)}`);
        if (r.refresh) refresh(); // the card showed an old column: the board and the card are read again
        Object.assign(e, { saidInCard: true });
      }
      throw Object.assign(e, { taskKey: key });
    } finally {
      if ('description' in body) descSent(key, patch.description, body.description_base);
    }
    if (key === state.drawerKey) showSaveNote(null);
    if (unsentEdits.supersede(key, Object.keys(patch))) dropUnsaved(`task:${key}`);
    const { description: mine, ...rest } = patch;
    if (drawerSnapshot && state.drawerKey === key) Object.assign(drawerSnapshot, saved?.description_conflict ? rest : patch);
    // back into the field by the next sync (the edit of Claude, read a moment before, over the person's pick)
    if (saved && state.drawerKey === key && 'description' in saved) {
      drawerFresh = { title: saved.title || '', priority: saved.priority, labels: [...(saved.labels || [])], description: saved.description || '' };
    }
    if (saved?.description_conflict) descConflict(key, mine, saved.description);
    return;
  }
  if (!title && !description.trim() && !pendingAttachments.length) return;
  const formId = newFormId;
  if (creatingForm === formId) return;
  const project = state.drawerProject || selVal('d-project');
  if (!project) return;
  return createTask(formId, { project, title, description, ...common }, [...pendingAttachments]);
}

async function createTask(formId, body, pend) {
  let created;
  creatingForm = formId;
  try {
    created = await api('POST', '/api/tasks', body);
  } catch (e) {
    if (canRetry(e)) queueCreate(formId, body, pend);
    if (formId === newFormId) { // the form is still the one typed into: it says why, and waits for a pause
      createFailedForm = formId;
      showSaveNote(createRefusedText(e));
    }
    throw Object.assign(e, { saidInCard: true });
  } finally {
    if (creatingForm === formId) creatingForm = null;
  }
  unsentCreates.delete(formId);
  dropUnsaved(`new:${formId}`);
  if (formId === newFormId) showSaveNote(null);
  const here = formId === newFormId && !state.drawerKey && drawerShown();
  if (here) {
    state.drawerKey = created.key;
    formCreated = { form: formId, key: created.key };
    drawerStatus = created.status;
    drawerSnapshot = fieldsSnapshot(created);
    setDrawerId(created.key, created.project);
    $('d-project').classList.add('hidden');
    $('comments-block').classList.remove('hidden');
    renderComments(created.key);
    $('drawer-menu').classList.remove('hidden');
    renderChecklist([]);
    drawerPinned = created.pinned ? 1 : 0;
    buildStatusSelect(selVal('d-status'), false, drawerLabels.includes('noclaude'));
    renderDrawerLinks([]);
    renderIssueRow(created);
    drawTimeline(created);
    renderLaunchButtons({ ...created, status: selVal('d-status'), labels: drawerLabels });
  }
  const shots = here ? [...pendingAttachments] : pend;
  for (const p of shots) await uploadAttachment(p.blob, created.key);
  if (here) {
    clearPending();
    setScrollToNewCardId(created.id); setTimeout(() => setScrollToNewCardId(null), 900);
  }
  await refresh();
}
