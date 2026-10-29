
import { clearSelection, closeOpenSelect, initMarquee, multiAction, renderBoard, scheduleDrawLinks, selectedIds } from './board.js';
import { chaosPending } from './chaos.js';
import { $, ALL, AUTO, HEALTH, CALENDAR, CHAOS, DASH, DONE, HORIZON, NOW, REVIEW, SETTINGS, api, hasUnsaved, ic, liftCurtain, loadLabelPalette, seg, state, tr } from './core.js';
import { addChecklistItem, applyCommentDraft, applyKeepDrawer, applyTitleLabelShortcut, closeDrawer, commentDrafts, deleteTask, doAutosave, initTerminal, kbMoveCard, kbMoveCursor, launchOpenTask, onDrawerPaste, openDrawer, uploadCommentImage, wirePicturePick, wireTaskPicture, openDrawerMenu, openDrawerNew, openOpenTaskSession, openReturnPop, showOwnComment, pendingAttachments, pullDrawerFresh, queueComment, commentArrived, sayRefused, scheduleAutosave, setKbCursor, wireCardBack, descTyped, descConflictPending } from './drawer.js';
import { closeProjectSettings, fileEditorHasChanges, openProjectSettings, projectSettingsDirty } from './project.js';
import { applyCompact, applyTheme, customBinding, getSetting, listenForInstall, matchKey, skillDirty, syncLangToServer } from './settings.js';
import { closeTopLayer, loadTasks, switchProject } from './sidebar.js';
import { maybeOnboarding, wizardResumes } from './onboarding.js';
import { autoGrow, connectSSE, ensureAudio, ensureSSE, refresh, refreshSync, streamOpened } from './sse.js';
import { loadUntilDone, searchInput } from './live-rules.js';
import { renderLimits } from './limits.js';
import { blockZoom } from './no-zoom.js';
import { watchTyping } from './lost-field.js';
import { initGlyphs } from './glyphs.js';
import { openAttentionList } from './attention.js';
import { openSearch } from './search.js';
import { columnsDirty } from './now-terms.js';
import { chatDirty } from './chat.js';
import { localStore, sessionStore } from './store.js';

/* ── init ── */
$('new-task').onclick = () => openDrawerNew('backlog');
$('drawer-close').onclick = closeDrawer;
$('drawer-menu').onclick = openDrawerMenu;
$('d-return-icon').onclick = openReturnPop;
$('d-launch').innerHTML = ic('play', 14);
$('d-launch').title = tr('Start this task in Claude');
$('d-launch').onclick = launchOpenTask;
$('d-session').innerHTML = ic('open', 14);
$('d-session').title = tr('Open its Claude session');
$('d-session').onclick = openOpenTaskSession;
initTerminal();
wireCardBack();
$('attn').onclick = openAttentionList;
$('d-accept-btn').onclick = async () => {
  const key = state.drawerKey;
  if (!key) return;
  try { await api('PATCH', `/api/tasks/${seg(key)}`, { status: 'done' }); } catch (e) { sayRefused(e, key); return; }
  if (key === state.drawerKey) closeDrawer();
  await refresh();
};
$('d-desc').addEventListener('input', descTyped);
$('d-desc').addEventListener('input', scheduleAutosave);
$('d-checklist-add').onclick = addChecklistItem;
$('d-title').addEventListener('input', (e) => { autoGrow(e.target); applyTitleLabelShortcut(); scheduleAutosave(); });
$('d-title').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const desc = $('d-desc');
  if (desc.disabled) e.target.blur();
  else { desc.focus(); desc.setSelectionRange(desc.value.length, desc.value.length); }
  doAutosave();
});
$('d-title').addEventListener('blur', pullDrawerFresh);
$('d-desc').addEventListener('blur', pullDrawerFresh);
$('project-menu').onclick = () => openProjectSettings();
// same comment again — the field is emptied only by the answer. One send per task at a time; the rest are ignored,
// but not for longer than COMMENT_HOLD_MS — a request that never answers must not lock the field of the task for good
const commentSending = new Map();
const COMMENT_HOLD_MS = 15000;
$('c-send').onclick = async () => {
  const body = $('c-input').value.trim();
  const key = state.drawerKey;
  if (!body || !key || Date.now() - (commentSending.get(key) ?? -Infinity) < COMMENT_HOLD_MS) return;
  const at = Date.now();
  commentSending.set(key, at);
  let sent = null;
  try { sent = await api('POST', `/api/tasks/${seg(key)}/comments`, { body, author: 'me' }); }
  catch (e) {
    if (!e?.offline) { sayRefused(e, key); return; }
    queueComment(key, body);
  } finally { if (commentSending.get(key) === at) commentSending.delete(key); }
  // typed on while it went: what is left after the sent text is a comment of its own — it stays, the sent text goes
  const rest = (text) => { const t = text.trimStart(); return t.startsWith(body) ? t.slice(body.length).trimStart() : text; };
  const draft = rest(commentDrafts.get(key) || '');
  if (draft.trim()) commentDrafts.set(key, draft); else commentDrafts.delete(key);
  if (sent) { commentArrived(key, sent); showOwnComment(key, sent.id); }
  if (state.drawerKey !== key) return;
  $('c-input').value = rest($('c-input').value);
  autoGrow($('c-input'));
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
wirePicturePick($('c-input').closest('.comment-form'), uploadCommentImage, { at: () => state.drawerKey });
wireTaskPicture();

const typedSearch = searchInput({ render: (q) => { state.search = q; renderBoard(); }, load: loadTasks });
$('search').addEventListener('input', (e) => typedSearch(e.target.value.trim()));

window.addEventListener('resize', scheduleDrawLinks);
blockZoom(document);
const typingLost = watchTyping(document);
$('board').addEventListener('scroll', scheduleDrawLinks, true);

const POPUP_SELECTOR = '.modal-overlay, #card-menu, #col-sort-menu, #drawer-menu-pop, #return-pop, .lbl-picker, #status-picker, .lightbox, .kbsel.open, .pp-select.open';

function escClosePopup() {
  if (document.querySelector('.kbsel.open')) { closeOpenSelect(); return true; }
  if (closeTopLayer()) return true;
  if (selectedIds.size) { clearSelection(); return true; }
  return false;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (escClosePopup()) { e.stopImmediatePropagation(); return; }
    if (state.projSettings) {
      const inp = document.activeElement;
      if (inp && /^(INPUT|TEXTAREA)$/.test(inp.tagName) && $('projset').contains(inp)) inp.blur();
      else closeProjectSettings();
      e.stopImmediatePropagation();
      return;
    }
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && $('drawer').contains(ae)) {
      ae.blur(); e.stopImmediatePropagation(); return;
    }
    if (!$('drawer').classList.contains('hidden') && !$('drawer').classList.contains('is-empty')) closeDrawer();
    else if (state.kbCursor != null) setKbCursor(null);
    return;
  }
  if (e.key === 'Enter' && e.metaKey) {
    const d = $('drawer');
    if (!d.classList.contains('hidden') && !d.classList.contains('is-empty') && d.contains(document.activeElement)) { doAutosave(); return; }
  }
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (document.querySelector(POPUP_SELECTOR)) { if (e.key === 'Backspace' && !inField) e.preventDefault(); return; }

  // window check on purpose: with the search (or any window) open, a second ⌘F goes to the browser's own find.
  if (matchKey(e, 'search') && (!inField || e.metaKey || e.ctrlKey)) { e.preventDefault(); openSearch(); return; }

  if (!inField && typingLost()) { if (e.key === 'Backspace') e.preventDefault(); return; }

  const drawerClosed = $('drawer').classList.contains('hidden') || $('drawer').classList.contains('is-empty');

  if (drawerClosed && !inField && (matchKey(e, 'prevProject') || matchKey(e, 'nextProject'))) {
    e.preventDefault();
    switchProject(matchKey(e, 'nextProject') ? 1 : -1);
    return;
  }

  const delDefault = !customBinding('deleteCard');
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
listenForInstall();
initGlyphs({ enabled: () => getSetting('glyphs') !== false });
applyCompact();
applyCommentDraft(null);
state.dashRange = getSetting('dashRange');
const sessionSlug = sessionStore.getItem('kb.session.slug');
if (sessionSlug) {
  state.slug = sessionSlug;
} else if (getSetting('startScreen') === 'chaos') {
  state.slug = CHAOS;
} else if (getSetting('startScreen') === 'last') {
  const last = localStore.getItem('kb.ui.project');
  if (last && last !== SETTINGS) state.slug = last;
}

const launchParams = new URLSearchParams(location.search);
const launchAction = launchParams.get('action');
if (launchParams.get('view') === 'dash') state.slug = DASH;
if (launchAction === 'new') {
  const last = localStore.getItem('kb.ui.project');
  state.slug = (last && last !== SETTINGS && last !== DASH) ? last : ALL;
}
if (location.search) history.replaceState(null, '', location.pathname);
document.documentElement.classList.toggle('boot-view', [DASH, NOW, REVIEW, DONE, AUTO, HEALTH, CHAOS, SETTINGS, HORIZON, CALENDAR].includes(state.slug));

let appVer = null;
export let pendingReload = false;
function safeToReload() {
  const d = $('drawer');
  const drawerBusy = !d.classList.contains('hidden') && !d.classList.contains('is-empty');
  return !drawerBusy && !selectedIds.size && !document.querySelector(POPUP_SELECTOR) && !hasUnsavedInput();
}
export function hasUnsavedInput() {
  const chaos = $('chaos-input');
  if (chaos && chaos.value.trim()) return true;
  if (chaosPending.length || pendingAttachments.length) return true;
  if (commentDrafts.size) return true;
  if (hasUnsaved()) return true;
  if (projectSettingsDirty() || fileEditorHasChanges() || skillDirty()) return true;
  if (columnsDirty()) return true;
  if (chatDirty()) return true;
  if (descConflictPending()) return true;
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
  try { sessionStore.removeItem('kb.session.bootReload'); } catch {  }
  if (!wizardResumes()) liftCurtain();
  if (!html.classList.contains('booting')) return;
  html.classList.remove('booting');
  html.classList.add('booted');
  setTimeout(() => html.classList.remove('booted'), 400);
}
setTimeout(bootDone, 8000);

const streamOrLate = Promise.race([streamOpened, new Promise((resolve) => { setTimeout(resolve, 1500); })]);
Promise.all([loadLabelPalette().catch(() => {}), streamOrLate]).then(() => loadUntilDone(refresh)).catch(() => {}).then(() => {
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
let syncSeenAt = Date.now();
const syncTick = () => { if (document.hidden) return; syncSeenAt = Date.now(); refreshSync(); };
setInterval(syncTick, 30000);
document.addEventListener('visibilitychange', () => { if (Date.now() - syncSeenAt >= 30000) syncTick(); });
setInterval(checkVersion, 30000);
window.addEventListener('focus', checkVersion);
setInterval(() => { if (!document.hidden && !$('board').classList.contains('hidden')) renderBoard(); }, 60000);
setInterval(ensureSSE, 20000);
setInterval(renderLimits, 60000);
