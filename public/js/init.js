
import { clearSelection, closeOpenSelect, initMarquee, multiAction, renderBoard, scheduleDrawLinks, selectedIds } from './board.js';
import { chaosPending } from './chaos.js';
import { $, ALL, CHAOS, DASH, SETTINGS, api, loadLabelPalette, seg, state } from './core.js';
import { addChecklistItem, applyCommentDraft, applyKeepDrawer, applyTitleLabelShortcut, closeDrawer, commentDrafts, deleteTask, doAutosave, kbMoveCard, kbMoveCursor, onDrawerPaste, openDrawer, openDrawerMenu, openDrawerNew, openReturnPop, pendingAttachments, renderComments, scheduleAutosave, setKbCursor } from './drawer.js';
import { openProjectPanel } from './project.js';
import { applyCompact, applyTheme, getSetting, matchKey, syncLangToServer } from './settings.js';
import { closeTopLayer, maybeOnboarding, switchProject } from './sidebar.js';
import { autoGrow, connectSSE, ensureAudio, refresh, refreshSync } from './sse.js';

/* ── init ── */
$('new-task').onclick = () => openDrawerNew('backlog');
$('drawer-close').onclick = closeDrawer;
$('drawer-menu').onclick = openDrawerMenu;
$('d-return-icon').onclick = openReturnPop;
$('d-accept-btn').onclick = async () => {
  if (!state.drawerKey) return;
  await api('PATCH', `/api/tasks/${seg(state.drawerKey)}`, { status: 'done' });
  closeDrawer();
  await refresh();
};
$('d-desc').addEventListener('input', scheduleAutosave);
$('d-checklist-add').onclick = addChecklistItem;
$('d-title').addEventListener('input', (e) => { autoGrow(e.target); applyTitleLabelShortcut(); scheduleAutosave(); });
$('d-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); doAutosave(); }
});
$('project-menu').onclick = () => openProjectPanel();
$('c-send').onclick = async () => {
  const body = $('c-input').value.trim();
  if (!body || !state.drawerKey) return;
  await api('POST', `/api/tasks/${seg(state.drawerKey)}/comments`, { body, author: 'me' });
  commentDrafts.delete(state.drawerKey);
  $('c-input').value = '';
  autoGrow($('c-input'));
  renderComments(state.drawerKey);
};
$('c-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('c-send').click(); }
});
$('c-input').addEventListener('input', (e) => {
  autoGrow(e.target);
  if (state.drawerKey) {
    if (e.target.value) commentDrafts.set(state.drawerKey, e.target.value);
    else commentDrafts.delete(state.drawerKey);
  }
});
$('drawer').addEventListener('paste', onDrawerPaste);

$('search').addEventListener('input', (e) => { state.search = e.target.value.trim(); renderBoard(); });

window.addEventListener('resize', scheduleDrawLinks);
$('board').addEventListener('scroll', scheduleDrawLinks, true);

const POPUP_SELECTOR = '.modal-overlay, #card-menu, #drawer-menu-pop, #return-pop, .lbl-picker, #status-picker, #proj-panel, .lightbox, .kbsel.open';

function escClosePopup() {
  if (document.querySelector('.kbsel.open')) { closeOpenSelect(); return true; }
  if (closeTopLayer()) return true;
  if (selectedIds.size) { clearSelection(); return true; }
  return false;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (escClosePopup()) { e.stopImmediatePropagation(); return; }
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && $('drawer').contains(ae)) {
      ae.blur(); e.stopImmediatePropagation(); return;
    }
    if (!$('drawer').classList.contains('hidden') && !$('drawer').classList.contains('is-empty')) closeDrawer();
    else if (state.kbCursor != null) setKbCursor(null);
    return;
  }
  if (e.key === 'Enter' && e.metaKey && !$('drawer').classList.contains('hidden')) { doAutosave(); return; }

  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  const drawerClosed = $('drawer').classList.contains('hidden') || $('drawer').classList.contains('is-empty');

  if (drawerClosed && !inField && (matchKey(e, 'prevProject') || matchKey(e, 'nextProject'))) {
    e.preventDefault();
    switchProject(matchKey(e, 'nextProject') ? 1 : -1);
    return;
  }

  const delDefault = !(getSetting('keymap') || {}).deleteCard;
  if ((matchKey(e, 'deleteCard') || (delDefault && e.key === 'Backspace' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey)) && !inField) {
    if (selectedIds.size) { e.preventDefault(); multiAction('del'); return; }
    if (!drawerClosed && state.drawerKey) { e.preventDefault(); deleteTask(state.drawerKey); return; }
    if (drawerClosed && !$('board').classList.contains('hidden') && state.kbCursor != null) {
      const t = state.tasks.find((x) => x.id === state.kbCursor);
      if (t) { e.preventDefault(); deleteTask(t.key); }
      return;
    }
  }

  const boardVisible = !$('board').classList.contains('hidden') && !inField;
  if (!boardVisible) return;

  if (drawerClosed && matchKey(e, 'newTask')) {
    e.preventDefault();
    openDrawerNew('backlog');
    return;
  }
  if (document.querySelector(POPUP_SELECTOR)) return;

  const ARROW = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (ARROW[e.key] && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const [dr, dc] = ARROW[e.key];
    if (e.shiftKey) kbMoveCard(dr, dc); else kbMoveCursor(dr, dc);
    return;
  }
  if (matchKey(e, 'openCard') && state.kbCursor != null) {
    const t = state.tasks.find((x) => x.id === state.kbCursor);
    if (t) { e.preventDefault(); openDrawer(t.key); }
  }
});

applyTheme();
applyCompact();
applyCommentDraft(null);
state.dashRange = getSetting('dashRange');
const sessionSlug = sessionStorage.getItem('kb.session.slug');
if (sessionSlug) {
  state.slug = sessionSlug;
} else if (getSetting('startScreen') === 'chaos') {
  state.slug = CHAOS;
} else if (getSetting('startScreen') === 'last') {
  const last = localStorage.getItem('kb.ui.project');
  if (last && last !== SETTINGS) state.slug = last;
}

const launchParams = new URLSearchParams(location.search);
const launchAction = launchParams.get('action');
if (launchParams.get('view') === 'dash') state.slug = DASH;
if (launchAction === 'new') {
  const last = localStorage.getItem('kb.ui.project');
  state.slug = (last && last !== SETTINGS && last !== DASH) ? last : ALL;
}
if (location.search) history.replaceState(null, '', location.pathname);

let appVer = null;
export let pendingReload = false;
function safeToReload() {
  const d = $('drawer');
  const drawerBusy = !d.classList.contains('hidden') && !d.classList.contains('is-empty');
  return !drawerBusy && !selectedIds.size && !document.querySelector(POPUP_SELECTOR) && !hasUnsavedInput();
}
function hasUnsavedInput() {
  const chaos = $('chaos-input');
  if (chaos && chaos.value.trim()) return true;
  if (chaosPending.length || pendingAttachments.length) return true;
  if (commentDrafts.size) return true;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && ae.value.trim()) return true;
  return false;
}
export async function checkVersion() {
  try {
    const res = await fetch('/api/ui-version', { cache: 'no-store' });
    const v = String((await res.json()).mtime || '');
    if (appVer === null) { appVer = v; return; }
    if (v && v !== appVer) pendingReload = true;
  } catch {  }
  if (pendingReload && safeToReload()) location.reload();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function bootDone() {
  const html = document.documentElement;
  if (!html.classList.contains('booting')) return;
  html.classList.remove('booting');
  html.classList.add('booted');
  setTimeout(() => html.classList.remove('booted'), 400);
}
setTimeout(bootDone, 8000);

loadLabelPalette().catch(() => {}).then(() => refresh()).catch(() => {}).then(() => {
  bootDone();
  refreshSync(); applyKeepDrawer();
  if (launchAction === 'new') openDrawerNew('backlog');
  maybeOnboarding();
});
syncLangToServer();
initMarquee();
connectSSE();
ensureAudio();
checkVersion();
setInterval(refreshSync, 30000);
setInterval(checkVersion, 30000);
window.addEventListener('focus', checkVersion);
setInterval(renderBoard, 60000);
